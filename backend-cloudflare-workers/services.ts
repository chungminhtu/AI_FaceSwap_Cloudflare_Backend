// backend-cloudflare-workers/services.ts
import { customAlphabet } from 'nanoid';
const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_', 21);
import type { Env, FaceSwapResponse, SafeSearchResult, GoogleVisionResponse } from './types';

// Generate unique mock ID for performance testing mode to avoid database conflicts
const generateMockId = () => `mock-${nanoid(16)}`;
import { isUnsafe, getWorstViolation, getAccessToken, getVertexAILocation, getVertexAIEndpoint, getVertexModelId, validateImageUrl, fetchWithTimeout, getVertexSafetyViolation, VERTEX_SAFETY_STATUS_CODES } from './utils';
import { VERTEX_AI_CONFIG, VERTEX_AI_PROMPTS, ASPECT_RATIO_CONFIG, API_ENDPOINTS, TIMEOUT_CONFIG, DEFAULT_VALUES, CACHE_CONFIG } from './config';

const SENSITIVE_KEYS = ['key', 'token', 'password', 'secret', 'api_key', 'apikey', 'authorization', 'private_key', 'privatekey', 'access_token', 'accesstoken', 'bearer', 'credential', 'credentials'];

const base64ToUint8Array = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  return Uint8Array.from(binaryString, c => c.charCodeAt(0));
};

const getMimeExt = (mimeType: string): string => {
  const idx = mimeType.indexOf('/');
  return idx > 0 ? mimeType.substring(idx + 1) : 'jpg';
};

const sanitizeObject = (obj: any, maxStringLength = 100): any => {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, maxStringLength));
  }

  const sanitized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some(sk => lowerKey.includes(sk));

    if (isSensitive && typeof value === 'string') {
      sanitized[key] = '***REDACTED***';
    } else if (key === 'data' && typeof value === 'string' && value.length > maxStringLength) {
      sanitized[key] = '...';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value, maxStringLength);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
};

const getR2Bucket = (env: Env): R2Bucket => {
  const bindingName = env.R2_BUCKET_BINDING || env.R2_BUCKET_NAME || '';
  const bucket = (env as any)[bindingName] as R2Bucket;
  if (!bucket) {
    throw new Error(`R2 bucket binding '${bindingName}' not found in environment`);
  }
  return bucket;
};

export const callFaceSwap = async (
  targetUrl: string,
  sourceUrl: string,
  env: Env
): Promise<FaceSwapResponse> => {
  // Create form-data for multipart/form-data request
  const formData = new FormData();
  formData.append('target_url', targetUrl);
  formData.append('source_url', sourceUrl);

  const startTime = Date.now();
  const response = await fetchWithTimeout(env.RAPIDAPI_ENDPOINT, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'x-rapidapi-host': env.RAPIDAPI_HOST,
      'x-rapidapi-key': env.RAPIDAPI_KEY,
    },
    body: formData,
  }, 60000);

  const durationMs = Date.now() - startTime;
  const responseText = await response.text();
  const debugInfo: Record<string, any> = {
    endpoint: env.RAPIDAPI_ENDPOINT,
    status: response.status,
    statusText: response.statusText,
    durationMs,
    requestPayload: {
      targetUrl,
      sourceUrl,
    },
  };

  if (!response.ok) {
    debugInfo.rawResponse = responseText.substring(0, 2000);
    return {
      Success: false,
      Message: `FaceSwap API error: ${response.status} ${response.statusText}`,
      StatusCode: response.status,
      Error: responseText,
      Debug: debugInfo,
    };
  }

  try {
    const data = JSON.parse(responseText);
    debugInfo.rawResponse = data;

    // Transform API response to match FaceSwapResponse format
    // API returns: { message, file_url, processing_time }
    // We need: { Success, ResultImageUrl, Message, StatusCode }
    const transformedResponse: FaceSwapResponse = {
      Success: data.message === 'Processing successful' || !!data.file_url,
      ResultImageUrl: data.file_url || data.ResultImageUrl,
      Message: data.message || 'Face swap completed',
      StatusCode: response.status,
      ProcessingTime: data.processing_time?.toString() || data.ProcessingTime,
      Debug: debugInfo,
    };

    // If no file_url and no ResultImageUrl, it's a failure
    if (!transformedResponse.ResultImageUrl) {
      transformedResponse.Success = false;
      transformedResponse.Message = data.message || 'No result image URL received';
      transformedResponse.Error = JSON.stringify(data);
    }

    return transformedResponse;
  } catch (error) {
    debugInfo.rawResponse = responseText.substring(0, 200);
    debugInfo.parseError = error instanceof Error ? error.message : String(error);
    return {
      Success: false,
      Message: `Failed to parse FaceSwap API response: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: responseText.substring(0, 200),
      Debug: debugInfo,
    };
  }
};

export const callNanoBanana = async (
  prompt: unknown,
  targetUrl: string,
  sourceUrl: string | string[],
  env: Env,
  aspectRatio?: string,
  modelParam?: string | number
): Promise<FaceSwapResponse> => {
  // Use Vertex AI Gemini API with image generation support
  // Based on official documentation: responseModalities: ["TEXT", "IMAGE"] is supported
  if (!env.GOOGLE_VERTEX_PROJECT_ID) {
    return {
      Success: false,
      Message: 'GOOGLE_VERTEX_PROJECT_ID is required',
      StatusCode: 500,
    };
  }

  let debugInfo: Record<string, any> | undefined;

  try {
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = getVertexAILocation(env);

    // Use Vertex AI Gemini API with image generation (Nano Banana)
    // IMPORTANT: Must use gemini-2.5-flash-image (not gemini-2.5-flash) for image generation
    // Only gemini-2.5-flash-image supports image + text output (responseModalities: ["TEXT", "IMAGE"])
    // gemini-2.5-flash only outputs text, so multimodal (image) output isn't supported
    // Cost: $30 per million output tokens for images (~$0.039 per image) vs $2.50 for text-only
    const geminiModel = getVertexModelId(modelParam);
    const geminiEndpoint = getVertexAIEndpoint(projectId, location, geminiModel);

    // Convert prompt_json to text string for Vertex AI
    // Enhance prompt with strong facial preservation instruction
    let promptText = '';
    if (prompt && typeof prompt === 'object') {
      // Clone the prompt object to avoid mutating the original
      const enhancedPrompt = { ...prompt } as any;

      if (enhancedPrompt.prompt && typeof enhancedPrompt.prompt === 'string') {
        if (!enhancedPrompt.prompt.includes('100% identical facial features')) {
          enhancedPrompt.prompt = `${enhancedPrompt.prompt} ${VERTEX_AI_PROMPTS.FACIAL_PRESERVATION_INSTRUCTION}`;
        }
      } else {
        enhancedPrompt.prompt = VERTEX_AI_PROMPTS.FACIAL_PRESERVATION_INSTRUCTION;
      }

      // Convert the enhanced prompt object to a formatted text string
      promptText = JSON.stringify(enhancedPrompt, null, 2);
    } else if (typeof prompt === 'string') {
      if (!prompt.includes('100% identical facial features')) {
        promptText = `${prompt} ${VERTEX_AI_PROMPTS.FACIAL_PRESERVATION_INSTRUCTION}`;
      } else {
        promptText = prompt;
      }
    } else {
      promptText = JSON.stringify(prompt);
    }

    // Use enhanced prompt with facial preservation instruction
    const faceSwapPrompt = promptText;

    // Vertex AI requires OAuth token for service account authentication
    if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      console.error('[Vertex-NanoBanana] Missing service account credentials');
      return {
        Success: false,
        Message: 'Google Service Account credentials are required for Vertex AI. Please set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY environment variables.',
        StatusCode: 500,
        Error: 'Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
      };
    }

    let accessToken: string;
    try {
      accessToken = await getAccessToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
        env
      );
    } catch (tokenError) {
      console.error('[Vertex-NanoBanana] Failed to get OAuth token:', tokenError);
      return {
        Success: false,
        Message: `Failed to authenticate with Vertex AI: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
        StatusCode: 500,
      };
    }

    // Fetch selfie image(s) as base64
    // For Nano Banana (Vertex AI), we send the selfie image(s) and text prompt
    // The preset image style is described in the prompt_json text
    // Support multiple selfies for wedding faceswap (e.g., bride and groom)
    const sourceUrls = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];
    const selfieImageDataArray: string[] = await Promise.all(
      sourceUrls.map(url => fetchImageAsBase64(url, env))
    );

    // If aspectRatio is undefined/null, use "original" to let Vertex API use image's original aspect ratio
    const normalizedAspectRatio = !aspectRatio
      ? "original"
      : (ASPECT_RATIO_CONFIG.SUPPORTED.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT);

    // Vertex AI Gemini API request format with image generation
    // Based on official documentation format
    // IMPORTANT: For Nano Banana, we send the selfie image(s) + text prompt (not preset image)
    // The preset image style is described in the prompt_json text
    // contents must be an ARRAY (as per Vertex AI API documentation)
    // For multiple selfies, include all images in the parts array
    const imageParts = selfieImageDataArray.map(imageData => ({
      inline_data: {
        mime_type: "image/jpeg",
        data: imageData
      }
    }));

    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          ...imageParts,
          { text: faceSwapPrompt }
        ]
      }],
      generationConfig: {
        ...VERTEX_AI_CONFIG.IMAGE_GENERATION,
        imageConfig: {
          ...VERTEX_AI_CONFIG.IMAGE_GENERATION.imageConfig,
          aspectRatio: normalizedAspectRatio,
        },
      },
      safetySettings: VERTEX_AI_CONFIG.SAFETY_SETTINGS,
    };

    // Generate curl command for testing (with sanitized base64)
    const sanitizedRequestBody = sanitizeObject(requestBody);

    const curlCommand = `curl -X POST \\
  -H "Authorization: Bearer \$(gcloud auth print-access-token)" \\
  -H "Content-Type: application/json" \\
  ${geminiEndpoint} \\
  -d '${JSON.stringify(sanitizedRequestBody, null, 2).replace(/'/g, "'\\''")}'`;

    debugInfo = {
      endpoint: geminiEndpoint,
      model: geminiModel,
      requestPayload: sanitizedRequestBody,
      curlCommand,
      inputImageBytes: selfieImageDataArray.map(d => d.length),
      inputImageCount: selfieImageDataArray.length,
      promptLength: faceSwapPrompt.length,
      targetUrl,
      sourceUrl: Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl],
      receivedAspectRatio: aspectRatio, // Log the aspect ratio received
      normalizedAspectRatio: normalizedAspectRatio, // Log the normalized value
    };

    // Performance testing mode: skip API call if disabled
    if (env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
      const mockId = generateMockId();
      const ext = 'jpg';
      const resultKey = `results/${mockId}.${ext}`;
      const resultImageUrl = `r2://${resultKey}`;
      return {
        Success: true,
        ResultImageUrl: resultImageUrl,
        Message: 'Vertex AI image generation disabled (performance testing mode)',
        StatusCode: 200,
        Debug: { disabled: true, mode: 'performance_testing', mockId, r2Key: resultKey },
      };
    }

    const startTime = Date.now();
    const response = await fetchWithTimeout(geminiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody),
    }, 60000);

    const rawResponse = await response.text();
    const durationMs = Date.now() - startTime;
    if (debugInfo) {
      debugInfo.status = response.status;
      debugInfo.statusText = response.statusText;
      debugInfo.durationMs = durationMs;
    }

    if (!response.ok) {
      console.error('[Vertex-NanoBanana] API error:', response.status, response.statusText);
      let parsedError: any = null;
      if (debugInfo) {
        try {
          parsedError = JSON.parse(rawResponse);
          debugInfo.rawResponse = parsedError;
        } catch {
          debugInfo.rawResponse = rawResponse; // Include full response, not truncated
        }
      } else {
        try {
          parsedError = JSON.parse(rawResponse);
        } catch {
          // Keep as string
        }
      }

      // Check for Vertex AI safety violations in error response
      const safetyViolation = parsedError ? getVertexSafetyViolation(parsedError) : null;
      
      if (safetyViolation) {
        console.warn('[Vertex-NanoBanana] Content blocked by Vertex AI safety filters:', safetyViolation.category, safetyViolation.reason);
        return {
          Success: false,
          Message: safetyViolation.reason,
          StatusCode: safetyViolation.code,
          Error: safetyViolation.reason,
        } as any;
      }

      // If no safety violation found but Vertex AI returned error, return unknown error (3000)
      return {
        Success: false,
        Message: 'Processing failed',
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: 'Processing failed',
      } as any;
    }

    try {
      const data = JSON.parse(rawResponse);
      if (debugInfo) {
        debugInfo.rawResponse = sanitizeObject(data);
      }

      // Check for Vertex AI safety violations
      const safetyViolation = getVertexSafetyViolation(data);
      if (safetyViolation) {
        console.warn('[Vertex-NanoBanana] Content blocked by Vertex AI safety filters:', safetyViolation.category, safetyViolation.reason);
        return {
          Success: false,
          Message: safetyViolation.reason,
          StatusCode: safetyViolation.code,
          Error: safetyViolation.reason,
        };
      }

      const candidates = data.candidates || [];
      if (candidates.length === 0) {
        // Check for safety violations even when no candidates
        const safetyViolationNoCandidates = getVertexSafetyViolation(data);
        if (safetyViolationNoCandidates) {
          return {
            Success: false,
            Message: safetyViolationNoCandidates.reason,
            StatusCode: safetyViolationNoCandidates.code,
            Error: safetyViolationNoCandidates.reason,
          };
        }
        return {
          Success: false,
          Message: 'Processing failed',
          StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          Error: 'Processing failed',
        };
      }

      const parts = candidates[0].content?.parts || [];
      let base64Image: string | null = null;
      let mimeType = 'image/jpeg';

      // Extract image from parts array - look for inline_data (snake_case) or inlineData (camelCase)
      // Vertex AI API may return either format
      for (const part of parts) {
        // Check for camelCase format (inlineData) - this is what the API actually returns
        if (part.inlineData) {
          base64Image = part.inlineData.data;
          mimeType = part.inlineData.mimeType || part.inlineData.mime_type || 'image/jpeg';
          break;
        }
        // Check for snake_case format (inline_data) - fallback
        if (part.inline_data) {
          base64Image = part.inline_data.data;
          mimeType = part.inline_data.mime_type || part.inline_data.mimeType || 'image/jpeg';
          break;
        }
      }

      if (!base64Image) {
        // Check for safety violations when no image is returned
        const safetyViolationNoImage = getVertexSafetyViolation(data);
        if (safetyViolationNoImage) {
          return {
            Success: false,
            Message: safetyViolationNoImage.reason,
            StatusCode: safetyViolationNoImage.code,
            Error: safetyViolationNoImage.reason,
          };
        }
        return {
          Success: false,
          Message: 'Processing failed',
          StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          Error: 'Processing failed',
        };
      }


      // Convert base64 to Uint8Array and upload to R2
      const bytes = base64ToUint8Array(base64Image);

      const ext = getMimeExt(mimeType);
      const id = nanoid(16);
      const resultKey = `results/${id}.${ext}`;

      const R2_BUCKET = getR2Bucket(env);
      await R2_BUCKET.put(resultKey, bytes, {
        httpMetadata: {
          contentType: mimeType,
          cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
        },
      });
      if (debugInfo) {
        debugInfo.r2Key = resultKey;
        debugInfo.mimeType = mimeType;
      }

      // Get public URL (will be converted by caller)
      const resultImageUrl = `r2://${resultKey}`;

      return {
        Success: true,
        ResultImageUrl: resultImageUrl,
        Message: 'Processing successful',
        StatusCode: 200,
      };
    } catch (parseError) {
      // Try to parse and check for safety violations even on parse error
      try {
        const data = JSON.parse(rawResponse);
        const safetyViolation = getVertexSafetyViolation(data);
        if (safetyViolation) {
          return {
            Success: false,
            Message: safetyViolation.reason,
            StatusCode: safetyViolation.code,
            Error: safetyViolation.reason,
          };
        }
      } catch {
        // If parse fails, continue with unknown error
      }
      return {
        Success: false,
        Message: 'Processing failed',
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: 'Processing failed',
      };
    }
  } catch (error) {
    console.error('[Vertex-NanoBanana] Unexpected error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
    return {
      Success: false,
      Message: 'Processing failed',
      StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
      Error: 'Processing failed',
    };
  }
};

export const generateBackgroundFromPrompt = async (
  prompt: string,
  env: Env,
  aspectRatio?: string,
  modelParam?: string | number
): Promise<FaceSwapResponse> => {
  if (!env.GOOGLE_VERTEX_PROJECT_ID) {
    return {
      Success: false,
      Message: 'GOOGLE_VERTEX_PROJECT_ID is required',
      StatusCode: 500,
    };
  }

  let debugInfo: Record<string, any> | undefined;

  try {
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = getVertexAILocation(env);

    const geminiModel = getVertexModelId(modelParam);
    const geminiEndpoint = getVertexAIEndpoint(projectId, location, geminiModel);

    if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      console.error('[Vertex-GenerateBackground] Missing service account credentials');
      return {
        Success: false,
        Message: 'Google Service Account credentials are required for Vertex AI. Please set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY environment variables.',
        StatusCode: 500,
        Error: 'Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
      };
    }

    let accessToken: string;
    try {
      accessToken = await getAccessToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
        env
      );
    } catch (tokenError) {
      console.error('[Vertex-GenerateBackground] Failed to get OAuth token:', tokenError);
      return {
        Success: false,
        Message: `Failed to authenticate with Vertex AI: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
        StatusCode: 500,
      };
    }

    // If aspectRatio is undefined/null, use "original" to let Vertex API use image's original aspect ratio
    const normalizedAspectRatio = !aspectRatio
      ? "original"
      : (ASPECT_RATIO_CONFIG.SUPPORTED.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT);

    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt }
        ]
      }],
      generationConfig: {
        ...VERTEX_AI_CONFIG.IMAGE_GENERATION,
        imageConfig: {
          ...VERTEX_AI_CONFIG.IMAGE_GENERATION.imageConfig,
          aspectRatio: normalizedAspectRatio,

        },
      }, safetySettings: VERTEX_AI_CONFIG.SAFETY_SETTINGS,
    };

    const sanitizedRequestBody = JSON.parse(JSON.stringify(requestBody, (key, value) => {
      if (key === 'data' && typeof value === 'string' && value.length > 100) {
        return '...';
      }
      return value;
    }));

    const curlCommand = `curl -X POST \\
  -H "Authorization: Bearer \$(gcloud auth print-access-token)" \\
  -H "Content-Type: application/json" \\
  ${geminiEndpoint} \\
  -d '${JSON.stringify(sanitizedRequestBody, null, 2).replace(/'/g, "'\\''")}'`;

    debugInfo = {
      endpoint: geminiEndpoint,
      model: geminiModel,
      requestPayload: sanitizedRequestBody,
      curlCommand,
      promptLength: prompt.length,
      receivedAspectRatio: aspectRatio,
      normalizedAspectRatio: normalizedAspectRatio,
    };

    // Performance testing mode: skip API call if disabled
    if (env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
      const mockId = generateMockId();
      const ext = 'jpg';
      const resultKey = `results/${mockId}.${ext}`;
      const resultImageUrl = `r2://${resultKey}`;
      return {
        Success: true,
        ResultImageUrl: resultImageUrl,
        Message: 'Vertex AI background generation disabled (performance testing mode)',
        StatusCode: 200,
        Debug: { disabled: true, mode: 'performance_testing', mockId, r2Key: resultKey },
      };
    }

    const startTime = Date.now();
    const response = await fetchWithTimeout(geminiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody),
    }, 60000);

    const rawResponse = await response.text();
    const durationMs = Date.now() - startTime;
    if (debugInfo) {
      debugInfo.status = response.status;
      debugInfo.statusText = response.statusText;
      debugInfo.durationMs = durationMs;
    }

    if (!response.ok) {
      console.error('[Vertex-GenerateBackground] API error:', response.status, response.statusText);
      let parsedError: any = null;
      if (debugInfo) {
        try {
          parsedError = JSON.parse(rawResponse);
          debugInfo.rawResponse = parsedError;
        } catch {
          debugInfo.rawResponse = rawResponse;
        }
      } else {
        try {
          parsedError = JSON.parse(rawResponse);
        } catch {
        }
      }

      // Check for Vertex AI safety violations in error response
      const safetyViolation = parsedError ? getVertexSafetyViolation(parsedError) : null;
      
      if (safetyViolation) {
        console.warn('[Vertex-GenerateBackground] Content blocked by Vertex AI safety filters:', safetyViolation.category, safetyViolation.reason);
        return {
          Success: false,
          Message: safetyViolation.reason,
          StatusCode: safetyViolation.code,
          Error: safetyViolation.reason,
        } as any;
      }

      // If no safety violation found but Vertex AI returned error, return unknown error (3000)
      return {
        Success: false,
        Message: 'Processing failed',
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: 'Processing failed',
      } as any;
    }

    try {
      const data = JSON.parse(rawResponse);
      if (debugInfo) {
        debugInfo.rawResponse = sanitizeObject(data);
      }

      const safetyViolation = getVertexSafetyViolation(data);
      if (safetyViolation) {
        console.warn('[Vertex-GenerateBackground] Content blocked by Vertex AI safety filters:', safetyViolation.category, safetyViolation.reason);
        return {
          Success: false,
          Message: safetyViolation.reason,
          StatusCode: safetyViolation.code,
          Error: safetyViolation.reason,
        };
      }

      const candidates = data.candidates || [];
      if (candidates.length === 0) {
        // Check for safety violations even when no candidates
        const safetyViolationNoCandidates = getVertexSafetyViolation(data);
        if (safetyViolationNoCandidates) {
          return {
            Success: false,
            Message: safetyViolationNoCandidates.reason,
            StatusCode: safetyViolationNoCandidates.code,
            Error: safetyViolationNoCandidates.reason,
          };
        }
        return {
          Success: false,
          Message: 'Processing failed',
          StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          Error: 'Processing failed',
        };
      }

      const parts = candidates[0].content?.parts || [];
      let base64Image: string | null = null;
      let mimeType = 'image/jpeg';

      for (const part of parts) {
        if (part.inlineData) {
          base64Image = part.inlineData.data;
          mimeType = part.inlineData.mimeType || part.inlineData.mime_type || 'image/jpeg';
          break;
        }
        if (part.inline_data) {
          base64Image = part.inline_data.data;
          mimeType = part.inline_data.mime_type || part.inline_data.mimeType || 'image/jpeg';
          break;
        }
      }

      if (!base64Image) {
        // Check for safety violations when no image is returned
        const safetyViolationNoImage = getVertexSafetyViolation(data);
        if (safetyViolationNoImage) {
          return {
            Success: false,
            Message: safetyViolationNoImage.reason,
            StatusCode: safetyViolationNoImage.code,
            Error: safetyViolationNoImage.reason,
          };
        }
        return {
          Success: false,
          Message: 'Processing failed',
          StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          Error: 'Processing failed',
        };
      }

      const bytes = base64ToUint8Array(base64Image);

      const ext = getMimeExt(mimeType);
      const id = nanoid(16);
      const resultKey = `results/${id}.${ext}`;

      const R2_BUCKET = getR2Bucket(env);
      await R2_BUCKET.put(resultKey, bytes, {
        httpMetadata: {
          contentType: mimeType,
          cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
        },
      });
      if (debugInfo) {
        debugInfo.r2Key = resultKey;
        debugInfo.mimeType = mimeType;
      }

      const resultImageUrl = `r2://${resultKey}`;

      const sanitizedData = sanitizeObject(data);

      const sanitizedRequestBodyForCurl = sanitizeObject(requestBody);

      const curlCommandFinal = `curl -X POST \\
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  ${geminiEndpoint} \\
  -d '${JSON.stringify(sanitizedRequestBodyForCurl, null, 2).replace(/'/g, "'\\''")}'`;
      if (debugInfo) {
        debugInfo.requestPayload = sanitizedRequestBodyForCurl;
        debugInfo.curlCommand = curlCommandFinal;
        debugInfo.response = sanitizedData;
        if (data.usageMetadata) {
          debugInfo.usageMetadata = data.usageMetadata;
        }
      }

      return {
        Success: true,
        ResultImageUrl: resultImageUrl,
        Message: 'Vertex AI background generation completed',
        StatusCode: response.status,
        VertexResponse: sanitizedData,
        Prompt: prompt,
        CurlCommand: curlCommandFinal,
        Debug: debugInfo,
      };
    } catch (parseError) {
      // Try to parse and check for safety violations even on parse error
      try {
        const data = JSON.parse(rawResponse);
        const safetyViolation = getVertexSafetyViolation(data);
        if (safetyViolation) {
          return {
            Success: false,
            Message: safetyViolation.reason,
            StatusCode: safetyViolation.code,
            Error: safetyViolation.reason,
          };
        }
      } catch {
        // If parse fails, continue with unknown error
      }
      return {
        Success: false,
        Message: 'Processing failed',
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: 'Processing failed',
      };
    }
  } catch (error) {
    console.error('[Vertex-GenerateBackground] Unexpected error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
    return {
      Success: false,
      Message: 'Processing failed',
      StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
      Error: 'Processing failed',
    };
  }
};

export const callNanoBananaMerge = async (
  prompt: unknown,
  selfieUrl: string,
  presetUrl: string,
  env: Env,
  aspectRatio?: string,
  modelParam?: string | number
): Promise<FaceSwapResponse> => {
  if (!env.GOOGLE_VERTEX_PROJECT_ID) {
    return {
      Success: false,
      Message: 'GOOGLE_VERTEX_PROJECT_ID is required',
      StatusCode: 500,
    };
  }

  let debugInfo: Record<string, any> | undefined;

  try {
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = getVertexAILocation(env);

    const geminiModel = getVertexModelId(modelParam);
    const geminiEndpoint = getVertexAIEndpoint(projectId, location, geminiModel);

    let promptText = '';
    if (prompt && typeof prompt === 'object') {
      promptText = JSON.stringify(prompt, null, 2);
    } else if (typeof prompt === 'string') {
      promptText = prompt;
    } else {
      promptText = JSON.stringify(prompt);
    }

    const mergePrompt = promptText || VERTEX_AI_PROMPTS.MERGE_PROMPT_DEFAULT;

    if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      console.error('[Vertex-NanoBananaMerge] Missing service account credentials');
      return {
        Success: false,
        Message: 'Google Service Account credentials are required for Vertex AI. Please set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY environment variables.',
        StatusCode: 500,
        Error: 'Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
      };
    }

    let accessToken: string;
    try {
      accessToken = await getAccessToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
        env
      );
    } catch (tokenError) {
      console.error('[Vertex-NanoBananaMerge] Failed to get OAuth token:', tokenError);
      return {
        Success: false,
        Message: `Failed to authenticate with Vertex AI: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
        StatusCode: 500,
      };
    }

    const [selfieImageData, presetImageData] = await Promise.all([
      fetchImageAsBase64(selfieUrl, env),
      fetchImageAsBase64(presetUrl, env)
    ]);

    // If aspectRatio is undefined/null, use "original" to let Vertex API use image's original aspect ratio
    const normalizedAspectRatio = !aspectRatio
      ? "original"
      : (ASPECT_RATIO_CONFIG.SUPPORTED.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT);

    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: DEFAULT_VALUES.IMAGE_MIME_TYPE,
              data: selfieImageData
            }
          },
          {
            inline_data: {
              mime_type: DEFAULT_VALUES.IMAGE_MIME_TYPE,
              data: presetImageData
            }
          },
          { text: mergePrompt }
        ]
      }],
      generationConfig: {
        ...VERTEX_AI_CONFIG.IMAGE_GENERATION,
        imageConfig: {
          ...VERTEX_AI_CONFIG.IMAGE_GENERATION.imageConfig,
          aspectRatio: normalizedAspectRatio,

        },
      },
      safetySettings: VERTEX_AI_CONFIG.SAFETY_SETTINGS,
    };
    const sanitizedRequestBody = JSON.parse(JSON.stringify(requestBody, (key, value) => {
      if (key === 'data' && typeof value === 'string' && value.length > 100) {
        return '...';
      }
      return value;
    }));

    const curlCommand = `curl -X POST \\
  -H "Authorization: Bearer \$(gcloud auth print-access-token)" \\
  -H "Content-Type: application/json" \\
  ${geminiEndpoint} \\
  -d '${JSON.stringify(sanitizedRequestBody, null, 2).replace(/'/g, "'\\''")}'`;

    debugInfo = {
      endpoint: geminiEndpoint,
      model: geminiModel,
      requestPayload: sanitizedRequestBody,
      curlCommand,
      selfieImageBytes: selfieImageData.length,
      presetImageBytes: presetImageData.length,
      promptLength: mergePrompt.length,
      selfieUrl,
      presetUrl,
      receivedAspectRatio: aspectRatio,
      normalizedAspectRatio: normalizedAspectRatio,
    };

    // Performance testing mode: skip API call if disabled
    if (env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
      const mockId = generateMockId();
      const ext = 'jpg';
      const resultKey = `results/${mockId}.${ext}`;
      const resultImageUrl = `r2://${resultKey}`;
      return {
        Success: true,
        ResultImageUrl: resultImageUrl,
        Message: 'Vertex AI merge disabled (performance testing mode)',
        StatusCode: 200,
        Debug: { disabled: true, mode: 'performance_testing', mockId, r2Key: resultKey },
      };
    }

    const startTime = Date.now();
    const response = await fetchWithTimeout(geminiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody),
    }, 60000);

    const rawResponse = await response.text();
    const durationMs = Date.now() - startTime;
    if (debugInfo) {
      debugInfo.status = response.status;
      debugInfo.statusText = response.statusText;
      debugInfo.durationMs = durationMs;
    }

    if (!response.ok) {
      console.error('[Vertex-NanoBananaMerge] API error:', response.status, response.statusText);
      let parsedError: any = null;
      if (debugInfo) {
        try {
          parsedError = JSON.parse(rawResponse);
          debugInfo.rawResponse = parsedError;
        } catch {
          debugInfo.rawResponse = rawResponse; // Include full response, not truncated
        }
      } else {
        try {
          parsedError = JSON.parse(rawResponse);
        } catch {
          // Keep as string
        }
      }

      // Check for Vertex AI safety violations in error response
      const safetyViolation = parsedError ? getVertexSafetyViolation(parsedError) : null;
      
      if (safetyViolation) {
        console.warn('[Vertex-NanoBananaMerge] Content blocked by Vertex AI safety filters:', safetyViolation.category, safetyViolation.reason);
        return {
          Success: false,
          Message: safetyViolation.reason,
          StatusCode: safetyViolation.code,
          Error: safetyViolation.reason,
        } as any;
      }

      // If no safety violation found but Vertex AI returned error, return unknown error (3000)
      return {
        Success: false,
        Message: 'Processing failed',
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: 'Processing failed',
      } as any;
    }

    try {
      const data = JSON.parse(rawResponse);
      if (debugInfo) {
        debugInfo.rawResponse = sanitizeObject(data);
      }

      // Check for Vertex AI safety violations
      const safetyViolation = getVertexSafetyViolation(data);
      if (safetyViolation) {
        console.warn('[Vertex-NanoBananaMerge] Content blocked by Vertex AI safety filters:', safetyViolation.category, safetyViolation.reason);
        return {
          Success: false,
          Message: safetyViolation.reason,
          StatusCode: safetyViolation.code,
          Error: safetyViolation.reason,
        };
      }

      const candidates = data.candidates || [];
      if (candidates.length === 0) {
        // Check for safety violations even when no candidates
        const safetyViolationNoCandidates = getVertexSafetyViolation(data);
        if (safetyViolationNoCandidates) {
          return {
            Success: false,
            Message: safetyViolationNoCandidates.reason,
            StatusCode: safetyViolationNoCandidates.code,
            Error: safetyViolationNoCandidates.reason,
          };
        }
        return {
          Success: false,
          Message: 'Processing failed',
          StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          Error: 'Processing failed',
        };
      }

      const parts = candidates[0].content?.parts || [];
      let base64Image: string | null = null;
      let mimeType = 'image/jpeg';

      for (const part of parts) {
        if (part.inlineData) {
          base64Image = part.inlineData.data;
          mimeType = part.inlineData.mimeType || part.inlineData.mime_type || 'image/jpeg';
          break;
        }
        if (part.inline_data) {
          base64Image = part.inline_data.data;
          mimeType = part.inline_data.mime_type || part.inline_data.mimeType || 'image/jpeg';
          break;
        }
      }

      if (!base64Image) {
        // Check for safety violations when no image is returned
        const safetyViolationNoImage = getVertexSafetyViolation(data);
        if (safetyViolationNoImage) {
          return {
            Success: false,
            Message: safetyViolationNoImage.reason,
            StatusCode: safetyViolationNoImage.code,
            Error: safetyViolationNoImage.reason,
          };
        }
        return {
          Success: false,
          Message: 'Processing failed',
          StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          Error: 'Processing failed',
        };
      }

      const bytes = base64ToUint8Array(base64Image);

      const ext = getMimeExt(mimeType);
      const id = nanoid(16);
      const resultKey = `results/${id}.${ext}`;

      const R2_BUCKET = getR2Bucket(env);
      await R2_BUCKET.put(resultKey, bytes, {
        httpMetadata: {
          contentType: mimeType,
          cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
        },
      });
      if (debugInfo) {
        debugInfo.r2Key = resultKey;
        debugInfo.mimeType = mimeType;
      }

      const resultImageUrl = `r2://${resultKey}`;

      const sanitizedData = sanitizeObject(data);

      const sanitizedRequestBodyForCurl = sanitizeObject(requestBody);

      const curlCommandFinal = `curl -X POST \\
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  ${geminiEndpoint} \\
  -d '${JSON.stringify(sanitizedRequestBodyForCurl, null, 2).replace(/'/g, "'\\''")}'`;
      if (debugInfo) {
        debugInfo.requestPayload = sanitizedRequestBodyForCurl;
        debugInfo.curlCommand = curlCommandFinal;
        debugInfo.response = sanitizedData;
        if (data.usageMetadata) {
          debugInfo.usageMetadata = data.usageMetadata;
        }
      }

      return {
        Success: true,
        ResultImageUrl: resultImageUrl,
        Message: 'Vertex AI image merge completed',
        StatusCode: response.status,
        VertexResponse: sanitizedData,
        Prompt: prompt,
        CurlCommand: curlCommandFinal,
        Debug: debugInfo,
      };
    } catch (parseError) {
      // Try to parse and check for safety violations even on parse error
      try {
        const data = JSON.parse(rawResponse);
        const safetyViolation = getVertexSafetyViolation(data);
        if (safetyViolation) {
          return {
            Success: false,
            Message: safetyViolation.reason,
            StatusCode: safetyViolation.code,
            Error: safetyViolation.reason,
          };
        }
      } catch {
        // If parse fails, continue with unknown error
      }
      return {
        Success: false,
        Message: 'Processing failed',
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: 'Processing failed',
      };
    }
  } catch (error) {
    console.error('[Vertex-NanoBananaMerge] Unexpected error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
    return {
      Success: false,
      Message: 'Processing failed',
      StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
      Error: 'Processing failed',
    };
  }
};

// JWT and OAuth2 functions removed - now using API key authentication instead

// Tìm kiếm An toàn: Tập hợp các đặc điểm liên quan đến hình ảnh, được tính toán bằng các phương pháp thị giác máy tính trên các lĩnh vực tìm kiếm an toàn (ví dụ: người lớn, giả mạo, y tế, bạo lực)
export const checkSafeSearch = async (
  imageUrl: string,
  env: Env
): Promise<SafeSearchResult> => {
  try {
    // Use Vision API key (separate from Gemini)
    const apiKey = env.GOOGLE_VISION_API_KEY;
    if (!apiKey) {
      console.error('[SafeSearch] GOOGLE_VISION_API_KEY not set');
      return { isSafe: false, error: 'GOOGLE_VISION_API_KEY not set' };
    }

    // Call Vision API with API key
    const endpoint = `${env.GOOGLE_VISION_ENDPOINT}?key=${apiKey}`;

    const requestBody = {
      requests: [{
        image: { source: { imageUri: imageUrl } },
        features: [{ type: 'SAFE_SEARCH_DETECTION', maxResults: 1 }],
      }],
    };

    // Performance testing mode: skip API call if disabled
    if (env.DISABLE_VISION_API === 'true') {
      return {
        isSafe: true,
        debug: { disabled: true, mode: 'performance_testing' },
      };
    }

    const startTime = Date.now();
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    }, 60000);

    const durationMs = Date.now() - startTime;
    const debugInfo: Record<string, any> = {
      endpoint: env.GOOGLE_VISION_ENDPOINT,
      status: response.status,
      statusText: response.statusText,
      durationMs,
      requestPayload: requestBody,
      imageUrl,
    };

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SafeSearch] API error:', response.status, response.statusText);
      debugInfo.rawResponse = errorText.substring(0, 200);

      // Provide helpful error message for billing errors
      let errorMessage = `API error: ${response.status} - ${errorText.substring(0, 200)}`;
      if (response.status === 403 && errorText.includes('billing')) {
        errorMessage = `Billing not enabled. Google Vision API requires billing to be enabled. Please enable billing at: https://console.developers.google.com/billing?project=521788129450`;
      }

      return { isSafe: false, error: errorMessage, debug: debugInfo };
    }

    const data = await response.json() as GoogleVisionResponse;
    debugInfo.response = data;

    const annotation = data.responses?.[0]?.safeSearchAnnotation;

    if (data.responses?.[0]?.error) {
      const errorObj: any = data.responses[0].error;
      const errorMsg = typeof errorObj === 'string' ? errorObj.substring(0, 200) : (errorObj?.message ? String(errorObj.message).substring(0, 200) : JSON.stringify(errorObj).substring(0, 200));
      return {
        isSafe: false,
        error: data.responses[0].error.message,
        rawResponse: data, // Include full raw response even on error
        debug: debugInfo,
      };
    }

    if (!annotation) {
      return {
        isSafe: false,
        error: 'No safe search annotation',
        rawResponse: data, // Include full raw response
        debug: debugInfo,
      };
    }

    // Get strictness from env (default: 'strict' - blocks POSSIBLE, LIKELY, and VERY_LIKELY)
    const strictness = (env.SAFETY_STRICTNESS === 'lenient' ? 'lenient' : 'strict') as 'strict' | 'lenient';
    const isUnsafeResult = isUnsafe(annotation, strictness);

    // Find worst violation (highest severity) - only return violations that match strictness
    const worstViolation = getWorstViolation(annotation, strictness);

    // Only set statusCode if actually unsafe (worstViolation will be null if no blocking violations)
    let statusCode: number | undefined = undefined;
    if (isUnsafeResult) {
      statusCode = worstViolation?.code;
      // If unsafe but no violation found (edge case), default to ADULT
      if (!statusCode) {
        statusCode = 1001;
      }
    }

    return {
      isSafe: !isUnsafeResult,
      statusCode: statusCode,
      violationCategory: worstViolation?.category,
      violationLevel: worstViolation?.level,
      details: annotation, // Return full safeSearchAnnotation details
      rawResponse: data, // Include full raw Vision API response
      debug: debugInfo,
    };
  } catch (error) {
    console.error('[SafeSearch] Exception:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
    return { isSafe: false, error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200) };
  }
};

// Vertex AI API integration for automatic prompt generation
// Note: Prompts are cached in database (prompt_json column), so no in-memory cache needed
// artStyle parameter: filter for specialized art style analysis (auto, photorealistic, figurine, popmart, clay, disney, anime, etc.)
export const generateVertexPrompt = async (
  imageUrl: string,
  env: Env,
  isFilterMode: boolean = false,
  customPromptText: string | null = null
): Promise<{
  success: boolean;
  prompt?: any;
  error?: string;
  debug?: {
    endpoint?: string;
    model?: string;
    requestSent?: boolean;
    httpStatus?: number;
    httpStatusText?: string;
    responseTimeMs?: number;
    responseStructure?: string;
    errorDetails?: string;
    rawError?: string;
  }
}> => {
  const startTime = Date.now();

  // Performance testing mode: skip API call if disabled (before any setup/image fetching/token generation)
  if (env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
    const mockPrompt = {
      prompt: 'A professional portrait with natural lighting',
      style: 'photorealistic',
      lighting: 'natural',
      composition: 'portrait',
      camera: 'professional',
      background: 'neutral'
    };
    return {
      success: true,
      prompt: mockPrompt,
      debug: {
        disabled: true,
        mode: 'performance_testing',
        responseTimeMs: Date.now() - startTime
      } as any
    };
  }

  const debugInfo: any = {};

  try {
    // Use Vertex AI credentials (OAuth token from service account, not API key)
    if (!env.GOOGLE_VERTEX_PROJECT_ID) {
      console.error('[Vertex] ERROR: GOOGLE_VERTEX_PROJECT_ID is required');
      return {
        success: false,
        error: 'GOOGLE_VERTEX_PROJECT_ID is required',
        debug: { errorDetails: 'Vertex AI project ID is missing from environment variables' }
      };
    }

    const geminiModel = VERTEX_AI_CONFIG.MODELS.PROMPT_GENERATION;
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = getVertexAILocation(env);

    // Vertex AI endpoint format
    // Format: https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent
    const vertexEndpoint = getVertexAIEndpoint(projectId, location, geminiModel);

    debugInfo.endpoint = vertexEndpoint;
    debugInfo.model = geminiModel;

    // Choose prompt: custom > filter > default
    let prompt: string;
    if (customPromptText && customPromptText.trim()) {
      prompt = customPromptText.trim();
    } else if (isFilterMode) {
      prompt = VERTEX_AI_PROMPTS.PROMPT_GENERATION_FILTER;
    } else {
      prompt = VERTEX_AI_PROMPTS.PROMPT_GENERATION_DEFAULT;
    }

    // Fetch image as base64
    const imageData = await fetchImageAsBase64(imageUrl, env);

    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: DEFAULT_VALUES.IMAGE_MIME_TYPE,
              data: imageData
            }
          }
        ]
      }],
      generationConfig: VERTEX_AI_CONFIG.PROMPT_GENERATION,
      safetySettings: VERTEX_AI_CONFIG.SAFETY_SETTINGS,
    };

    debugInfo.requestSent = true;
    debugInfo.requestPayload = {
      promptLength: prompt.length,
      imageBytes: imageData.length,
      imageUrl,
    };

    // Vertex AI requires OAuth token
    if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      console.error('[Vertex] Vertex AI requires service account credentials');
      return {
        success: false,
        error: 'GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are required for Vertex AI',
        debug: { errorDetails: 'Service account credentials missing' }
      };
    }

    let accessToken: string;
    try {
      accessToken = await getAccessToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
        env
      );
    } catch (tokenError) {
      console.error('[Vertex] Failed to get OAuth token:', tokenError instanceof Error ? tokenError.message.substring(0, 200) : String(tokenError).substring(0, 200));
      return {
        success: false,
        error: `Failed to authenticate with Vertex AI: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
        debug: { errorDetails: String(tokenError) }
      };
    }

    const response = await fetchWithTimeout(vertexEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody),
    }, TIMEOUT_CONFIG.VERTEX_AI);

    const responseTime = Date.now() - startTime;
    debugInfo.httpStatus = response.status;
    debugInfo.httpStatusText = response.statusText;
    debugInfo.responseTimeMs = responseTime;


    if (!response.ok) {
      const errorText = await response.text();
      const errorPreview = errorText.substring(0, 1000);
      debugInfo.errorDetails = errorPreview;
      debugInfo.rawError = errorText;
      console.error('[Vertex] API error:', response.status, response.statusText);
      return {
        success: false,
        error: `Vertex AI API error: ${response.status} ${response.statusText}`,
        debug: debugInfo
      };
    }

    const data = await response.json() as any;
    debugInfo.responseStructure = JSON.stringify(data).substring(0, 200);
    if (data.usageMetadata) {
      debugInfo.usageMetadata = data.usageMetadata;
    }

    // Store full response for debugging
    const parts = data.candidates?.[0]?.content?.parts;
    if (parts && parts.length > 0 && parts[0].text) {
      debugInfo.fullResponse = parts[0].text;
      debugInfo.responseLength = parts[0].text.length;
    }

    // With structured outputs (responseMimeType: "application/json"), Vertex AI returns JSON directly
    if (!parts || parts.length === 0) {
      debugInfo.errorDetails = 'Response received but no parts found in candidates[0].content.parts';
      debugInfo.responseStructure = JSON.stringify(data);
      return {
        success: false,
        error: 'No response parts from Vertex AI API',
        debug: debugInfo
      };
    }

    let promptJson: any = null;

    // Try to get JSON directly from structured output
    for (const part of parts) {
      if (part.text) {
        let jsonText = part.text.trim();

        // First, try to parse as direct JSON
        try {
          promptJson = JSON.parse(jsonText);
          break;
        } catch (e) {
          // If direct parse fails, try various extraction methods
          console.log('[Vertex] Direct JSON parse failed, trying extraction methods');

          // Method 1: Extract from markdown code blocks
          if (jsonText.includes('```json')) {
            const jsonMatch = jsonText.match(/```json\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch) {
              try {
                promptJson = JSON.parse(jsonMatch[1]);
                break;
              } catch (parseError) {
                console.log('[Vertex] JSON extraction from ```json block failed');
              }
            }
          }

          // Method 2: Extract from any code block
          if (jsonText.includes('```')) {
            const jsonMatch = jsonText.match(/```\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch) {
              try {
                promptJson = JSON.parse(jsonMatch[1]);
                break;
              } catch (parseError) {
                console.log('[Vertex] JSON extraction from ``` block failed');
              }
            }
          }

          // Method 3: Try to find and complete incomplete JSON
          if (jsonText.startsWith('{') && !jsonText.endsWith('}')) {
            console.log('[Vertex] Detected incomplete JSON, attempting to complete');
            // Try to close unclosed objects/arrays
            let completedJson = jsonText;
            const openBraces = (jsonText.match(/\{/g) || []).length;
            const closeBraces = (jsonText.match(/\}/g) || []).length;
            const openBrackets = (jsonText.match(/\[/g) || []).length;
            const closeBrackets = (jsonText.match(/\]/g) || []).length;

            // Add missing closing braces
            for (let i = 0; i < openBraces - closeBraces; i++) {
              completedJson += '}';
            }
            // Add missing closing brackets
            for (let i = 0; i < openBrackets - closeBrackets; i++) {
              completedJson += ']';
            }

            try {
              promptJson = JSON.parse(completedJson);
              console.log('[Vertex] Successfully completed and parsed incomplete JSON');
              break;
          } catch (parseError: any) {
            console.log('[Vertex] Failed to complete JSON:', parseError.message);
            }
          }

          // Method 4: Try to extract JSON-like content and manually construct object
          const promptMatch = jsonText.match(/"prompt"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
          if (promptMatch) {
            console.log('[Vertex] Attempting manual JSON construction from text');
            try {
              // Extract basic fields that we can find
              const prompt = promptMatch[1];
              const styleMatch = jsonText.match(/"style"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
              const lightingMatch = jsonText.match(/"lighting"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
              const compositionMatch = jsonText.match(/"composition"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
              const cameraMatch = jsonText.match(/"camera"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
              const backgroundMatch = jsonText.match(/"background"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);

              promptJson = {
                prompt: prompt || 'A professional portrait',
                style: styleMatch ? styleMatch[1] : 'photorealistic',
                lighting: lightingMatch ? lightingMatch[1] : 'natural',
                composition: compositionMatch ? compositionMatch[1] : 'portrait',
                camera: cameraMatch ? cameraMatch[1] : 'professional',
                background: backgroundMatch ? backgroundMatch[1] : 'neutral'
              };
              console.log('[Vertex] Successfully constructed JSON manually');
              break;
            } catch (manualError) {
              console.log('[Vertex] Manual JSON construction failed');
            }
          }
        }
      }
    }

    if (!promptJson) {
      console.error('[Vertex] Could not extract JSON from response parts');
      debugInfo.errorDetails = 'Could not extract valid JSON from response parts';

      // Include full response for debugging
      if (parts && parts.length > 0 && parts[0].text) {
        debugInfo.fullResponse = parts[0].text;
        debugInfo.responseLength = parts[0].text.length;
      }

      return {
        success: false,
        error: 'No valid JSON response from Vertex AI API',
        debug: debugInfo
      };
    }

    // Validate required keys
    const requiredKeys = ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'];
    const missingKeys = requiredKeys.filter(key => !promptJson[key] || promptJson[key] === '');

    if (missingKeys.length > 0) {
      console.error('[Vertex] Missing required keys:', missingKeys.join(', '));
      // Include full response for debugging
      if (parts && parts.length > 0 && parts[0].text) {
        debugInfo.fullResponse = parts[0].text;
        debugInfo.responseLength = parts[0].text.length;
        debugInfo.parsedJson = promptJson;
      }
      return { success: false, error: `Missing required keys: ${missingKeys.join(', ')}`, debug: debugInfo };
    }

    // Additional validation: Ensure prompt contains face-swap instruction
    const promptText = String(promptJson.prompt || '').toLowerCase();
    const hasFaceSwapInstruction = promptText.includes('replace the original face') ||
                                   promptText.includes('face from the image') ||
                                   promptText.includes('identical facial features');

    if (!hasFaceSwapInstruction) {
      console.error('[Vertex] Prompt missing face-swap instruction, likely incomplete response');
      // Include full response for debugging
      if (parts && parts.length > 0 && parts[0].text) {
        debugInfo.fullResponse = parts[0].text;
        debugInfo.responseLength = parts[0].text.length;
        debugInfo.parsedJson = promptJson;
      }
      return {
        success: false,
        error: 'Incomplete prompt response - missing face-swap instruction',
        debug: debugInfo
      };
    }

    // Validate prompt length (should be substantial)
    if (promptText.length < 50) {
      console.error('[Vertex] Prompt too short, likely truncated response');
      // Include full response for debugging
      if (parts && parts.length > 0 && parts[0].text) {
        debugInfo.fullResponse = parts[0].text;
        debugInfo.responseLength = parts[0].text.length;
        debugInfo.parsedJson = promptJson;
      }
      return {
        success: false,
        error: 'Prompt too short - likely truncated response',
        debug: debugInfo
      };
    }

    // Note: Prompt is stored in database (prompt_json column) by the caller
    // No need for in-memory cache since database serves as the cache

    debugInfo.responseTimeMs = Date.now() - startTime;
    return { success: true, prompt: promptJson, debug: debugInfo };

  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    debugInfo.errorDetails = errorMessage.substring(0, 200);
    debugInfo.responseTimeMs = responseTime;
    return {
      success: false,
      error: errorMessage,
      debug: debugInfo
    };
  }
};

const fetchImageAsBase64 = async (imageUrl: string, env: Env): Promise<string> => {
  if (!validateImageUrl(imageUrl, env)) {
    throw new Error(`Invalid or unsafe image URL: ${imageUrl}`);
  }

  const response = await fetchWithTimeout(imageUrl, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary);
};

export const streamImageToR2 = async (
  imageUrl: string,
  r2Key: string,
  env: Env,
  contentType?: string,
  skipValidation?: boolean
): Promise<void> => {
  if (!skipValidation && !validateImageUrl(imageUrl, env)) {
    throw new Error(`Invalid or unsafe image URL: ${imageUrl}`);
  }

  const response = await fetchWithTimeout(imageUrl, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const detectedContentType = contentType || response.headers.get('content-type') || 'image/jpeg';
  const R2_BUCKET = getR2Bucket(env);

  if (!response.body) {
    throw new Error('Response body is null');
  }

  await R2_BUCKET.put(r2Key, response.body, {
    httpMetadata: {
      contentType: detectedContentType,
      cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
    },
  });
};

// generateVertexPrompt is already defined above

export const callUpscaler4k = async (
  imageUrl: string,
  env: Env
): Promise<FaceSwapResponse> => {
  if (!env.WAVESPEED_API_KEY) {
    return {
      Success: false,
      Message: 'WAVESPEED_API_KEY is required',
      StatusCode: 500,
    };
  }

  let debugInfo: Record<string, any> | undefined;

  try {
    const apiKey = env.WAVESPEED_API_KEY;
    const apiEndpoint = API_ENDPOINTS.WAVESPEED_UPSCALER;

    debugInfo = {
      endpoint: apiEndpoint,
      model: 'wavespeed-ai/image-upscaler',
      imageUrl,
    };

    const requestBody = {
      enable_base64_output: false,
      enable_sync_mode: false,
      image: imageUrl,
      output_format: DEFAULT_VALUES.UPSCALER_OUTPUT_FORMAT,
      target_resolution: DEFAULT_VALUES.UPSCALER_TARGET_RESOLUTION
    };

    // Performance testing mode: skip API call if disabled
    if (env.DISABLE_4K_UPSCALER === 'true') {
      const mockId = generateMockId();
      const ext = DEFAULT_VALUES.UPSCALER_EXT;
      const resultKey = `results/${mockId}.${ext}`;
      const resultImageUrl = `r2://${resultKey}`;
      return {
        Success: true,
        ResultImageUrl: resultImageUrl,
        Message: '4K upscaler disabled (performance testing mode)',
        StatusCode: 200,
        Debug: { disabled: true, mode: 'performance_testing', mockId, r2Key: resultKey },
      };
    }

    const startTime = Date.now();
    const response = await fetchWithTimeout(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
    }, TIMEOUT_CONFIG.DEFAULT_REQUEST);

    const rawResponse = await response.text();
    const durationMs = Date.now() - startTime;
    if (debugInfo) {
      debugInfo.status = response.status;
      debugInfo.statusText = response.statusText;
      debugInfo.durationMs = durationMs;
    }

    if (!response.ok) {
      console.error('[Upscaler4K] WaveSpeed API error:', response.status, response.statusText);
      if (debugInfo) {
        try {
          debugInfo.rawResponse = JSON.parse(rawResponse);
        } catch {
          debugInfo.rawResponse = rawResponse.substring(0, 2000);
        }
      }

      return {
        Success: false,
        Message: `WaveSpeed API error: ${response.status} ${response.statusText}`,
        StatusCode: response.status,
        Error: rawResponse,
        FullResponse: rawResponse,
        Debug: debugInfo,
      };
    }

    try {
      const data = JSON.parse(rawResponse);
      if (debugInfo) {
        debugInfo.rawResponse = sanitizeObject(data);
      }

      let resultImageUrl: string | null = null;
      let requestId: string | null = null;

      requestId = data.id || data.requestId || data.request_id || data.data?.id || data.data?.requestId || data.data?.request_id;

      if (!requestId) {
        return {
          Success: false,
          Message: 'WaveSpeed API did not return a request ID',
          StatusCode: 500,
          Error: 'No requestId in response',
          Debug: debugInfo,
        };
      }

      const resultEndpoint = API_ENDPOINTS.WAVESPEED_RESULT(requestId);

      for (let attempt = 0; attempt < TIMEOUT_CONFIG.POLLING.MAX_ATTEMPTS; attempt++) {
        let delay = 0;
        if (attempt === 0) {
          delay = TIMEOUT_CONFIG.POLLING.FIRST_DELAY;
        } else if (attempt <= 2) {
          delay = TIMEOUT_CONFIG.POLLING.SECOND_THIRD_DELAY;
        } else {
          delay = TIMEOUT_CONFIG.POLLING.SUBSEQUENT_DELAY;
        }

        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const resultResponse = await fetchWithTimeout(resultEndpoint, {
          headers: {
            'Authorization': `Bearer ${apiKey}`
          }
        }, TIMEOUT_CONFIG.DEFAULT_REQUEST);

        if (!resultResponse.ok) {
          if (attempt === TIMEOUT_CONFIG.POLLING.MAX_ATTEMPTS - 1) {
            throw new Error(`Failed to get result: ${resultResponse.status} ${resultResponse.statusText}`);
          }
          continue;
        }

        const resultData: any = await resultResponse.json();

        const pollStatus = resultData.status || resultData.data?.status;

        // Early success detection - check for completed status first
        if (pollStatus === 'completed' || pollStatus === 'succeeded' || pollStatus === 'success') {
          if (resultData.output && typeof resultData.output === 'string') {
            resultImageUrl = resultData.output;
            break;
          } else if (resultData.output?.url) {
            resultImageUrl = resultData.output.url;
            break;
          } else if (resultData.data?.output && typeof resultData.data.output === 'string') {
            resultImageUrl = resultData.data.output;
            break;
          } else if (resultData.data?.output?.url) {
            resultImageUrl = resultData.data.output.url;
            break;
          } else if (resultData.url) {
            resultImageUrl = resultData.url;
            break;
          } else if (resultData.data?.url) {
            resultImageUrl = resultData.data.url;
            break;
          } else if (resultData.image_url) {
            resultImageUrl = resultData.image_url;
            break;
          } else if (resultData.data?.image_url) {
            resultImageUrl = resultData.data.image_url;
            break;
          } else if (resultData.output_url) {
            resultImageUrl = resultData.output_url;
            break;
          } else if (resultData.data?.output_url) {
            resultImageUrl = resultData.data.output_url;
            break;
          } else if (resultData.data?.outputs && Array.isArray(resultData.data.outputs) && resultData.data.outputs.length > 0) {
            const output = resultData.data.outputs[0];
            if (typeof output === 'string') {
              resultImageUrl = output;
              break;
            } else if (output?.url) {
              resultImageUrl = output.url;
              break;
            }
          } else if (resultData.outputs && Array.isArray(resultData.outputs) && resultData.outputs.length > 0) {
            const output = resultData.outputs[0];
            if (typeof output === 'string') {
              resultImageUrl = output;
              break;
            } else if (output?.url) {
              resultImageUrl = output.url;
              break;
            }
          }
        } else if (pollStatus === 'failed' || pollStatus === 'error') {
          throw new Error(`Upscaling failed: ${resultData.error || resultData.message || resultData.data?.error || 'Unknown error'}`);
        } else if (pollStatus === 'processing' || pollStatus === 'pending' || pollStatus === 'starting') {
          continue;
        } else {
          if (resultData.output && typeof resultData.output === 'string') {
            resultImageUrl = resultData.output;
            break;
          } else if (resultData.output?.url) {
            resultImageUrl = resultData.output.url;
            break;
          } else if (resultData.data?.output && typeof resultData.data.output === 'string') {
            resultImageUrl = resultData.data.output;
            break;
          } else if (resultData.data?.output?.url) {
            resultImageUrl = resultData.data.output.url;
            break;
          } else if (resultData.url) {
            resultImageUrl = resultData.url;
            break;
          } else if (resultData.data?.url) {
            resultImageUrl = resultData.data.url;
            break;
          }
        }
      }

      if (!resultImageUrl) {
        throw new Error(`Upscaling timed out - no result after ${TIMEOUT_CONFIG.POLLING.MAX_ATTEMPTS} polling attempts`);
      }

      const ext = DEFAULT_VALUES.UPSCALER_EXT;
      const id = nanoid(16);
      const resultKey = `results/${id}.${ext}`;
      let contentType = DEFAULT_VALUES.UPSCALER_MIME_TYPE;

      if (resultImageUrl.startsWith('data:')) {
        const base64Match = resultImageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (base64Match) {
          contentType = base64Match[1] || DEFAULT_VALUES.UPSCALER_MIME_TYPE;
          const base64String = base64Match[2];
          const imageBytes = base64ToUint8Array(base64String);

          const R2_BUCKET = getR2Bucket(env);
          await R2_BUCKET.put(resultKey, imageBytes, {
            httpMetadata: {
              contentType,
              cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
            },
          });
        } else {
          throw new Error('Invalid base64 data URL format');
        }
      } else {
        await streamImageToR2(resultImageUrl, resultKey, env, DEFAULT_VALUES.UPSCALER_MIME_TYPE, true);
        contentType = DEFAULT_VALUES.UPSCALER_MIME_TYPE;
      }

      if (debugInfo) {
        debugInfo.r2Key = resultKey;
        debugInfo.mimeType = contentType;
      }

      const finalResultUrl = `r2://${resultKey}`;

      return {
        Success: true,
        ResultImageUrl: finalResultUrl,
        Message: 'Upscaler4K image upscaling completed',
        StatusCode: response.status,
        Debug: debugInfo,
      };
    } catch (parseError) {
      if (debugInfo) {
        debugInfo.rawResponse = rawResponse.substring(0, 2000);
        debugInfo.parseError = parseError instanceof Error ? parseError.message : String(parseError);
      }
      return {
        Success: false,
        Message: `Failed to parse WaveSpeed API response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        StatusCode: 500,
        Error: rawResponse.substring(0, 200),
        Debug: debugInfo,
      };
    }
  } catch (error) {
    console.error('[Upscaler4K] Unexpected error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
    const debugPayload = debugInfo;
    if (debugPayload) {
      debugPayload.error = error instanceof Error ? error.message : String(error);
    }
    return {
      Success: false,
      Message: `Upscaler4K request failed: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200),
      Debug: debugPayload,
    };
  }
};

