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
  modelParam?: string | number,
  options?: { skipFacialPreservation?: boolean; provider?: 'vertex' | 'wavespeed'; size?: string }
): Promise<FaceSwapResponse> => {
  // Check provider parameter first, then fall back to env.IMAGE_PROVIDER
  const effectiveProvider = options?.provider || env.IMAGE_PROVIDER;
  
  if (effectiveProvider === 'wavespeed') {
    // WaveSpeed Edit API: use sourceUrl directly as the images array
    // The caller is responsible for constructing the correct image order:
    // - Filter: [selfie, preset] - apply style from image2 to image1
    // - Faceswap single: [selfie, preset] - put person from image1 into image2
    // - Faceswap couple: [selfie1, selfie2, preset] - put persons from image1,2 into image3
    const imageUrls = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];

    // Extract prompt text: if object with .prompt field, use that; otherwise use string directly
    let promptText: string;
    if (typeof prompt === 'string') {
      promptText = prompt;
    } else if (prompt && typeof prompt === 'object' && (prompt as any).prompt) {
      promptText = (prompt as any).prompt;
    } else {
      promptText = JSON.stringify(prompt);
    }

    return callWaveSpeedEdit(imageUrls, promptText, env, aspectRatio, options?.size);
  }

  // Default: Use Vertex AI Gemini API with image generation support
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
    // Enhance prompt with facial preservation instruction (unless skipped for generic image processing)
    const skipFacial = options?.skipFacialPreservation === true;
    let promptText = '';
    if (prompt && typeof prompt === 'object') {
      // Clone the prompt object to avoid mutating the original
      const enhancedPrompt = { ...prompt } as any;

      if (enhancedPrompt.prompt && typeof enhancedPrompt.prompt === 'string') {
        if (!skipFacial && !enhancedPrompt.prompt.includes('100% identical facial features')) {
          enhancedPrompt.prompt = `${enhancedPrompt.prompt} ${VERTEX_AI_PROMPTS.FACIAL_PRESERVATION_INSTRUCTION}`;
        }
      } else if (!skipFacial) {
        enhancedPrompt.prompt = VERTEX_AI_PROMPTS.FACIAL_PRESERVATION_INSTRUCTION;
      }

      // Convert the enhanced prompt object to a formatted text string
      promptText = JSON.stringify(enhancedPrompt, null, 2);
    } else if (typeof prompt === 'string') {
      if (!skipFacial && !prompt.includes('100% identical facial features')) {
        promptText = `${prompt} ${VERTEX_AI_PROMPTS.FACIAL_PRESERVATION_INSTRUCTION}`;
      } else {
        promptText = prompt;
      }
    } else {
      promptText = JSON.stringify(prompt);
    }

    // Use enhanced prompt with facial preservation instruction + content safety
    const faceSwapPrompt = `${promptText}\n\n${VERTEX_AI_PROMPTS.CONTENT_SAFETY_INSTRUCTION}`;

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

    // Use fileUri for Vertex AI - URLs must be publicly accessible
    // For Nano Banana (Vertex AI), we send the selfie image(s) + text prompt (not preset image)
    // The preset image style is described in the prompt_json text
    // Support multiple selfies for wedding faceswap (e.g., bride and groom)
    const sourceUrls = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];

    // Normalize aspect ratio: resolveAspectRatio should have already calculated closest ratio from "original"
    // This is a safety check - if "original" somehow gets through, treat as invalid and use default
    // If undefined, use default (should never happen as resolveAspectRatio always returns a value)
    let normalizedAspectRatio: string;
    if (!aspectRatio) {
      normalizedAspectRatio = ASPECT_RATIO_CONFIG.DEFAULT;
    } else if (aspectRatio === "original") {
      normalizedAspectRatio = ASPECT_RATIO_CONFIG.DEFAULT;
    } else if (ASPECT_RATIO_CONFIG.SUPPORTED.includes(aspectRatio)) {
      normalizedAspectRatio = aspectRatio;
    } else {
      normalizedAspectRatio = ASPECT_RATIO_CONFIG.DEFAULT;
    }

    // Vertex AI Gemini API request format with image generation
    // Using fileData with fileUri for URL-based image input
    // IMPORTANT: For Nano Banana, we send the selfie image(s) + text prompt (not preset image)
    // The preset image style is described in the prompt_json text
    // contents must be an ARRAY (as per Vertex AI API documentation)
    // For multiple selfies, include all images in the parts array
    const imageParts = sourceUrls.map(url => ({
      fileData: {
        mimeType: "image/jpeg",
        fileUri: url
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

    // Only generate expensive debug info when debug mode is enabled
    const debugEnabled = env.ENABLE_DEBUG_RESPONSE === 'true';
    const curlCommand = debugEnabled ? `curl -X POST "${geminiEndpoint}" -H "Authorization: Bearer ${accessToken}" -H "Content-Type: application/json" -d '${JSON.stringify(requestBody).replace(/'/g, "'\\''")}'` : undefined;

    debugInfo = {
      curl: curlCommand,
      model: geminiModel,
      endpoint: geminiEndpoint,
      aspectRatio: normalizedAspectRatio,
      inputImages: sourceUrls.length,
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

    // Retry logic for Vertex AI 429 rate limit errors (1 retry = 2 total attempts)
    const maxRetries = 1;
    let lastResponse: Response | null = null;
    let lastRawResponse: string = '';
    let totalDurationMs = 0;
    let retryAttempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      totalDurationMs += durationMs;
      lastResponse = response;
      lastRawResponse = rawResponse;

      // If 429, retry with exponential backoff
      if (response.status === 429 && attempt < maxRetries) {
        retryAttempts = attempt + 1;
        const retryAfter = response.headers.get('Retry-After');
        const delayMs = retryAfter 
          ? parseInt(retryAfter, 10) * 1000 
          : Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff: 1s, 2s (max 10s)
        
        console.warn(`[Vertex-NanoBanana] 429 rate limit, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // Not 429 or last attempt, break and process response
      break;
    }

    const response = lastResponse!;
    const rawResponse = lastRawResponse;
    const durationMs = totalDurationMs;
    if (debugInfo) {
      debugInfo.status = response.status;
      debugInfo.statusText = response.statusText;
      debugInfo.durationMs = durationMs;
      if (retryAttempts > 0) {
        debugInfo.retryAttempts = retryAttempts;
        debugInfo.totalAttempts = retryAttempts + 1;
      }
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
          Debug: debugInfo,
        } as any;
      }

      // Extract actual error message from Vertex AI response
      let actualErrorMessage = 'Processing failed';
      if (parsedError) {
        if (parsedError.error?.message) {
          actualErrorMessage = parsedError.error.message;
        } else if (parsedError.message) {
          actualErrorMessage = parsedError.message;
        } else if (typeof parsedError === 'string') {
          actualErrorMessage = parsedError;
        }
      } else if (rawResponse) {
        // Try to extract error from raw response
        try {
          const textResponse = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
          if (textResponse.length < 500) {
            actualErrorMessage = textResponse;
          }
        } catch {
          // Keep default message
        }
      }

      // If no safety violation found but Vertex AI returned error, preserve the HTTP status code
      console.error('[Vertex-NanoBanana] API error (no safety violation):', response.status, response.statusText, actualErrorMessage);
      // Use the actual HTTP status code (e.g., 404) instead of 3000 for HTTP errors
      const statusCode = (response.status >= 200 && response.status < 600) ? response.status : VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR;
      return {
        Success: false,
        Message: actualErrorMessage,
        StatusCode: statusCode,
        Error: actualErrorMessage,
        Debug: debugInfo,
        FullResponse: parsedError || rawResponse,
        HttpStatus: response.status,
        HttpStatusText: response.statusText,
      } as any;
    }

    // Parse JSON once upfront - avoid double parsing in error handler
    let data: any = null;
    try {
      data = JSON.parse(rawResponse);
    } catch (jsonError) {
      const errorMsg = jsonError instanceof Error ? jsonError.message : String(jsonError);
      console.error('[Vertex-NanoBanana] JSON parse error:', errorMsg);
      return {
        Success: false,
        Message: `Failed to parse response: ${errorMsg}`,
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: `Failed to parse response: ${errorMsg}`,
        Debug: {
          ...debugInfo,
          rawResponse: rawResponse ? rawResponse.substring(0, 1000) : undefined,
          parseError: errorMsg,
        },
      } as any;
    }

    try {
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
          Message: 'Processing failed: No image data in response',
          StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          Error: 'Processing failed: No image data in response',
          Debug: debugInfo,
          FullResponse: data,
        } as any;
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
        CurlCommand: debugInfo?.curl,
        Debug: debugInfo,
      } as any;
    } catch (processError) {
      // Data already parsed - check for safety violations
      const safetyViolation = data ? getVertexSafetyViolation(data) : null;
      if (safetyViolation) {
        return {
          Success: false,
          Message: safetyViolation.reason,
          StatusCode: safetyViolation.code,
          Error: safetyViolation.reason,
        };
      }
      const errorMsg = processError instanceof Error ? processError.message : String(processError);
      console.error('[Vertex-NanoBanana] Process error:', errorMsg);
      return {
        Success: false,
        Message: `Processing failed: ${errorMsg}`,
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: `Processing failed: ${errorMsg}`,
        Debug: {
          ...debugInfo,
          processError: errorMsg,
        },
      } as any;
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Vertex-NanoBanana] Unexpected error:', errorMsg);
    return {
      Success: false,
      Message: `Unexpected error: ${errorMsg}`,
      StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
      Error: `Unexpected error: ${errorMsg}`,
      Debug: debugInfo,
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

    // Normalize aspect ratio: resolveAspectRatio should have already calculated closest ratio from "original"
    // This is a safety check - if "original" somehow gets through, treat as invalid and use default
    // If undefined, use default (should never happen as resolveAspectRatio always returns a value)
    let normalizedAspectRatio: string;
    if (!aspectRatio) {
      normalizedAspectRatio = ASPECT_RATIO_CONFIG.DEFAULT;
    } else if (aspectRatio === "original") {
      normalizedAspectRatio = ASPECT_RATIO_CONFIG.DEFAULT;
    } else if (ASPECT_RATIO_CONFIG.SUPPORTED.includes(aspectRatio)) {
      normalizedAspectRatio = aspectRatio;
    } else {
      normalizedAspectRatio = ASPECT_RATIO_CONFIG.DEFAULT;
    }

    // Append content safety instruction to prompt
    const safePrompt = `${prompt}\n\n${VERTEX_AI_PROMPTS.CONTENT_SAFETY_INSTRUCTION}`;

    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          { text: safePrompt }
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

    // Only generate expensive debug info when debug mode is enabled
    const debugEnabled = env.ENABLE_DEBUG_RESPONSE === 'true';
    const curlCommand = debugEnabled ? `curl -X POST "${geminiEndpoint}" -H "Authorization: Bearer ${accessToken}" -H "Content-Type: application/json" -d '${JSON.stringify(requestBody).replace(/'/g, "'\\''")}'` : undefined;

    debugInfo = {
      endpoint: geminiEndpoint,
      model: geminiModel,
      curl: curlCommand,
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

    // Retry logic for Vertex AI 429 rate limit errors (1 retry = 2 total attempts)
    const maxRetries = 1;
    let lastResponse: Response | null = null;
    let lastRawResponse: string = '';
    let totalDurationMs = 0;
    let retryAttempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      totalDurationMs += durationMs;
      lastResponse = response;
      lastRawResponse = rawResponse;

      if (debugInfo) {
        debugInfo.status = response.status;
        debugInfo.statusText = response.statusText;
        debugInfo.durationMs = durationMs;
      }

      // If 429, retry with exponential backoff
      if (response.status === 429 && attempt < maxRetries) {
        retryAttempts = attempt + 1;
        const retryAfter = response.headers.get('Retry-After');
        const delayMs = retryAfter 
          ? parseInt(retryAfter, 10) * 1000 
          : Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff: 1s, 2s (max 10s)
        
        console.warn(`[Vertex-GenerateBackground] 429 rate limit, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // Not 429 or last attempt, break and process response
      if (!response.ok) {
        console.error('[Vertex-GenerateBackground] API error:', response.status, response.statusText);
        break;
      }
      break;
    }

    const response = lastResponse!;
    const rawResponse = lastRawResponse;
    const durationMs = totalDurationMs;
    if (debugInfo && retryAttempts > 0) {
      debugInfo.retryAttempts = retryAttempts;
      debugInfo.totalAttempts = retryAttempts + 1;
    }

    if (!response.ok) {
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

    // Parse JSON once upfront - avoid double parsing in error handler
    let data: any = null;
    try {
      data = JSON.parse(rawResponse);
    } catch (jsonError) {
      console.error('[Vertex-GenerateBackground] JSON parse error:', jsonError instanceof Error ? jsonError.message : String(jsonError));
      return {
        Success: false,
        Message: 'Processing failed',
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: 'Processing failed',
      };
    }

    try {
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

      // Only generate expensive debug info when debug mode is enabled
      const debugEnabledFinal = env.ENABLE_DEBUG_RESPONSE === 'true';
      const sanitizedData = debugEnabledFinal ? sanitizeObject(data) : undefined;
      const curlCommandFinal = debugEnabledFinal ? `curl -X POST "${geminiEndpoint}" -H "Authorization: Bearer ${accessToken}" -H "Content-Type: application/json" -d '${JSON.stringify(requestBody).replace(/'/g, "'\\''")}'` : undefined;

      if (debugInfo && debugEnabledFinal) {
        debugInfo.curl = curlCommandFinal;
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
        Debug: debugInfo,
      };
    } catch (processError) {
      // Data already parsed - check for safety violations
      const safetyViolation = data ? getVertexSafetyViolation(data) : null;
      if (safetyViolation) {
        return {
          Success: false,
          Message: safetyViolation.reason,
          StatusCode: safetyViolation.code,
          Error: safetyViolation.reason,
        };
      }
      console.error('[Vertex-GenerateBackground] Process error:', processError instanceof Error ? processError.message : String(processError));
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

    // Use fileUri for Vertex AI - URLs must be publicly accessible

    // Normalize aspect ratio: resolveAspectRatio should have already calculated closest ratio from "original"
    // This is a safety check - if "original" somehow gets through, treat as invalid and use default
    // If undefined, use default (should never happen as resolveAspectRatio always returns a value)
    let normalizedAspectRatio: string;
    if (!aspectRatio) {
      normalizedAspectRatio = ASPECT_RATIO_CONFIG.DEFAULT;
    } else if (aspectRatio === "original") {
      normalizedAspectRatio = ASPECT_RATIO_CONFIG.DEFAULT;
    } else if (ASPECT_RATIO_CONFIG.SUPPORTED.includes(aspectRatio)) {
      normalizedAspectRatio = aspectRatio;
    } else {
      normalizedAspectRatio = ASPECT_RATIO_CONFIG.DEFAULT;
    }

    // Append content safety instruction to merge prompt
    const safeMergePrompt = `${mergePrompt}\n\n${VERTEX_AI_PROMPTS.CONTENT_SAFETY_INSTRUCTION}`;

    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          {
            fileData: {
              mimeType: DEFAULT_VALUES.IMAGE_MIME_TYPE,
              fileUri: selfieUrl
            }
          },
          {
            fileData: {
              mimeType: DEFAULT_VALUES.IMAGE_MIME_TYPE,
              fileUri: presetUrl
            }
          },
          { text: safeMergePrompt }
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
    // Only generate expensive debug info when debug mode is enabled
    const debugEnabled = env.ENABLE_DEBUG_RESPONSE === 'true';
    const curlCommand = debugEnabled ? `curl -X POST "${geminiEndpoint}" -H "Authorization: Bearer ${accessToken}" -H "Content-Type: application/json" -d '${JSON.stringify(requestBody).replace(/'/g, "'\\''")}'` : undefined;

    debugInfo = {
      curl: curlCommand,
      model: geminiModel,
      selfieUrl,
      presetUrl,
      aspectRatio: normalizedAspectRatio,
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

    // Retry logic for Vertex AI 429 rate limit errors (1 retry = 2 total attempts)
    const maxRetries = 1;
    let lastResponse: Response | null = null;
    let lastRawResponse: string = '';
    let totalDurationMs = 0;
    let retryAttempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      totalDurationMs += durationMs;
      lastResponse = response;
      lastRawResponse = rawResponse;

      if (debugInfo) {
        debugInfo.status = response.status;
        debugInfo.statusText = response.statusText;
        debugInfo.durationMs = durationMs;
      }

      // If 429, retry with exponential backoff
      if (response.status === 429 && attempt < maxRetries) {
        retryAttempts = attempt + 1;
        const retryAfter = response.headers.get('Retry-After');
        const delayMs = retryAfter 
          ? parseInt(retryAfter, 10) * 1000 
          : Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff: 1s, 2s (max 10s)
        
        console.warn(`[Vertex-NanoBananaMerge] 429 rate limit, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // Not 429 or last attempt, break and process response
      if (!response.ok) {
        console.error('[Vertex-NanoBananaMerge] API error:', response.status, response.statusText);
        break;
      }
      break;
    }

    const response = lastResponse!;
    const rawResponse = lastRawResponse;
    const durationMs = totalDurationMs;
    if (debugInfo && retryAttempts > 0) {
      debugInfo.retryAttempts = retryAttempts;
      debugInfo.totalAttempts = retryAttempts + 1;
    }

    if (!response.ok) {
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

      // If no safety violation found but Vertex AI returned error, preserve the HTTP status code
      // Extract actual error message from Vertex AI response
      let actualErrorMessage = 'Processing failed';
      if (parsedError) {
        if (parsedError.error?.message) {
          actualErrorMessage = parsedError.error.message;
        } else if (parsedError.message) {
          actualErrorMessage = parsedError.message;
        } else if (typeof parsedError === 'string') {
          actualErrorMessage = parsedError;
        }
      } else if (rawResponse) {
        // Try to extract error from raw response
        try {
          const textResponse = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
          if (textResponse.length < 500) {
            actualErrorMessage = textResponse;
          }
        } catch {
          // Keep default message
        }
      }
      // Use the actual HTTP status code (e.g., 404) instead of 3000 for HTTP errors
      const statusCode = (response.status >= 200 && response.status < 600) ? response.status : VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR;
      return {
        Success: false,
        Message: actualErrorMessage,
        StatusCode: statusCode,
        Error: actualErrorMessage,
        Debug: debugInfo,
        FullResponse: parsedError || rawResponse,
        HttpStatus: response.status,
        HttpStatusText: response.statusText,
      } as any;
    }

    // Parse JSON once upfront - avoid double parsing in error handler
    let data: any = null;
    try {
      data = JSON.parse(rawResponse);
    } catch (jsonError) {
      console.error('[Vertex-NanoBananaMerge] JSON parse error:', jsonError instanceof Error ? jsonError.message : String(jsonError));
      return {
        Success: false,
        Message: 'Processing failed',
        StatusCode: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        Error: 'Processing failed',
      };
    }

    try {
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

      // Only generate expensive debug info when debug mode is enabled
      const debugEnabledFinal = env.ENABLE_DEBUG_RESPONSE === 'true';
      const sanitizedData = debugEnabledFinal ? sanitizeObject(data) : undefined;
      const curlCommandFinal = debugEnabledFinal ? `curl -X POST "${geminiEndpoint}" -H "Authorization: Bearer ${accessToken}" -H "Content-Type: application/json" -d '${JSON.stringify(requestBody).replace(/'/g, "'\\''")}'` : undefined;

      if (debugInfo && debugEnabledFinal) {
        debugInfo.curl = curlCommandFinal;
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
        Debug: debugInfo,
      };
    } catch (processError) {
      // Data already parsed - check for safety violations
      const safetyViolation = data ? getVertexSafetyViolation(data) : null;
      if (safetyViolation) {
        return {
          Success: false,
          Message: safetyViolation.reason,
          StatusCode: safetyViolation.code,
          Error: safetyViolation.reason,
        };
      }
      console.error('[Vertex-NanoBananaMerge] Process error:', processError instanceof Error ? processError.message : String(processError));
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

    // Generate curl command for Vision API call
    const curlCommand = `curl -X POST \\
  "${env.GOOGLE_VISION_ENDPOINT}?key=${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(requestBody)}'`;

    const debugInfo: Record<string, any> = {
      curl: curlCommand,
      endpoint: env.GOOGLE_VISION_ENDPOINT,
      imageUrl,
      durationMs,
      status: response.status,
    };

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SafeSearch] API error:', response.status, response.statusText);
      debugInfo.error = errorText.substring(0, 200);

      // Provide helpful error message for billing errors
      let errorMessage = `API error: ${response.status} - ${errorText.substring(0, 200)}`;
      if (response.status === 403 && errorText.includes('billing')) {
        errorMessage = `Billing not enabled. Google Vision API requires billing to be enabled. Please enable billing at: https://console.developers.google.com/billing?project=521788129450`;
      }

      return { isSafe: false, error: errorMessage, debug: debugInfo };
    }

    const data = await response.json() as GoogleVisionResponse;

    const annotation = data.responses?.[0]?.safeSearchAnnotation;

    if (data.responses?.[0]?.error) {
      const errorObj: any = data.responses[0].error;
      debugInfo.error = errorObj?.message || JSON.stringify(errorObj).substring(0, 200);
      return {
        isSafe: false,
        error: data.responses[0].error.message,
        debug: debugInfo,
      };
    }

    if (!annotation) {
      debugInfo.error = 'No safe search annotation returned';
      return {
        isSafe: false,
        error: 'No safe search annotation',
        debug: debugInfo,
      };
    }

    // Blocks POSSIBLE, LIKELY, and VERY_LIKELY
    const isUnsafeResult = isUnsafe(annotation);

    // Find worst violation (highest severity)
    const worstViolation = getWorstViolation(annotation);

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
      details: annotation, // SafeSearch levels: adult, spoof, medical, violence, racy
      debug: debugInfo,
    };
  } catch (error) {
    console.error('[SafeSearch] Exception:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
    return { isSafe: false, error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200) };
  }
};

// Gemini 2.5 Flash Lite safety pre-check for filter, beauty, enhance operations
// This check runs BEFORE the main Vertex AI image generation to ensure image is appropriate
export const checkImageSafetyWithFlashLite = async (
  imageUrl: string,
  env: Env
): Promise<{
  safe: boolean;
  reason?: string;
  category?: string;
  error?: string;
  debug?: {
    endpoint?: string;
    model?: string;
    location?: string;
    responseTimeMs?: number;
    httpStatus?: number;
    rawResponse?: any;
    rawError?: string;
    disabled?: boolean;
    mode?: string;
    errorDetails?: string;
  };
}> => {
  const startTime = Date.now();
  const debugInfo: any = {};

  try {
    // Skip safety check if disabled via config or env
    if (!VERTEX_AI_CONFIG.SAFETY_CHECK_ENABLED || env.DISABLE_SAFETY_CHECK === 'true' || env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
      return {
        safe: true,
        debug: { disabled: true, mode: 'safety_check_disabled', responseTimeMs: Date.now() - startTime }
      };
    }

    // Validate required credentials
    if (!env.GOOGLE_VERTEX_PROJECT_ID) {
      console.error('[SafetyCheck] GOOGLE_VERTEX_PROJECT_ID is required');
      return {
        safe: false,
        error: 'GOOGLE_VERTEX_PROJECT_ID is required',
        debug: { errorDetails: 'Vertex AI project ID is missing' }
      };
    }

    if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      console.error('[SafetyCheck] Service account credentials missing');
      return {
        safe: false,
        error: 'Service account credentials required',
        debug: { errorDetails: 'Service account credentials missing' }
      };
    }

    const model = VERTEX_AI_CONFIG.MODELS.SAFETY_CHECK;
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = env.GOOGLE_VERTEX_LOCATION || VERTEX_AI_CONFIG.LOCATIONS.MODEL_LOCATIONS[model as keyof typeof VERTEX_AI_CONFIG.LOCATIONS.MODEL_LOCATIONS] || VERTEX_AI_CONFIG.LOCATIONS.DEFAULT;
    const endpoint = VERTEX_AI_CONFIG.ENDPOINTS.REGIONAL(location, projectId, model);

    debugInfo.endpoint = endpoint;
    debugInfo.model = model;
    debugInfo.location = location;

    // Use fileUri for Vertex AI - URL must be publicly accessible
    // Send image with simple prompt - let Vertex AI's built-in safety filters do the work
    // If the image violates safety policies, it will be blocked automatically
    const requestBody = {
      contents: [{
        role: 'user',
        parts: [
          { text: 'Describe this image briefly.' },
          {
            fileData: {
              mimeType: 'image/jpeg',
              fileUri: imageUrl
            }
          }
        ]
      }],
      generationConfig: VERTEX_AI_CONFIG.SAFETY_CHECK,
      safetySettings: VERTEX_AI_CONFIG.SAFETY_CHECK_SETTINGS,
    };

    // Get OAuth token
    const accessToken = await getAccessToken(
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      env
    );

    console.log('[SafetyCheck] Calling Gemini 2.5 Flash Lite for safety pre-check');

    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    }, TIMEOUT_CONFIG.VERTEX_AI);

    debugInfo.responseTimeMs = Date.now() - startTime;
    debugInfo.httpStatus = response.status;

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SafetyCheck] API error:', response.status, errorText.substring(0, 200));

      // Check if it's a safety block from the API itself
      if (response.status === 400 && errorText.includes('SAFETY')) {
        return {
          safe: false,
          reason: 'Image blocked by safety filters',
          category: 'safety_block',
          debug: debugInfo
        };
      }

      return {
        safe: false,
        error: `API error: ${response.status}`,
        debug: { ...debugInfo, rawError: errorText.substring(0, 500) }
      };
    }

    const data = await response.json() as any;
    debugInfo.rawResponse = data;

    // Check 1: promptFeedback.blockReason - image itself was blocked
    if (data.promptFeedback?.blockReason) {
      console.log('[SafetyCheck] Image blocked by promptFeedback:', data.promptFeedback.blockReason);
      return {
        safe: false,
        reason: `Image blocked: ${data.promptFeedback.blockReason}`,
        category: data.promptFeedback.blockReason.toLowerCase(),
        debug: debugInfo
      };
    }

    // Check 2: finishReason === "SAFETY" - response was blocked due to safety
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') {
      console.log('[SafetyCheck] Response blocked by safety filter (finishReason: SAFETY)');
      // Find which category caused the block
      const blockedRating = candidate.safetyRatings?.find((r: any) => r.blocked === true);
      return {
        safe: false,
        reason: blockedRating ? `Safety blocked: ${blockedRating.category}` : 'Image blocked by safety filter',
        category: blockedRating?.category?.toLowerCase() || 'safety',
        debug: debugInfo
      };
    }

    // Check 3: safetyRatings with blocked === true
    const safetyRatings = candidate?.safetyRatings || [];
    for (const rating of safetyRatings) {
      if (rating.blocked === true) {
        console.log('[SafetyCheck] Safety rating blocked:', rating.category);
        return {
          safe: false,
          reason: `Safety blocked: ${rating.category}`,
          category: rating.category?.toLowerCase(),
          debug: debugInfo
        };
      }
    }

    // If we got here, the image passed the safety check
    console.log('[SafetyCheck] Image passed safety check');
    return {
      safe: true,
      debug: debugInfo
    };

  } catch (error) {
    console.error('[SafetyCheck] Exception:', error instanceof Error ? error.message : String(error));
    return {
      safe: false,
      error: error instanceof Error ? error.message : String(error),
      debug: { ...debugInfo, responseTimeMs: Date.now() - startTime }
    };
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
      console.log('[generateVertexPrompt] Using custom prompt text (length:', prompt.length, ')');
    } else if (isFilterMode) {
      prompt = VERTEX_AI_PROMPTS.PROMPT_GENERATION_FILTER;
      console.log('[generateVertexPrompt] Using filter mode prompt (art style analysis)');
    } else {
      prompt = VERTEX_AI_PROMPTS.PROMPT_GENERATION_DEFAULT;
      console.log('[generateVertexPrompt] Using default prompt (normal face-swap)');
    }
    
    console.log('[generateVertexPrompt] Prompt selection:', {
      isFilterMode,
      hasCustomPrompt: !!(customPromptText && customPromptText.trim()),
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 100) + '...'
    });

    // Use fileUri for Vertex AI - URL must be publicly accessible
    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          {
            fileData: {
              mimeType: DEFAULT_VALUES.IMAGE_MIME_TYPE,
              fileUri: imageUrl
            }
          }
        ]
      }],
      generationConfig: VERTEX_AI_CONFIG.PROMPT_GENERATION,
      safetySettings: VERTEX_AI_CONFIG.SAFETY_SETTINGS,
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

    // Only generate expensive debug info when debug mode is enabled
    const debugEnabled = env.ENABLE_DEBUG_RESPONSE === 'true';
    const curlCommand = debugEnabled ? `curl -X POST "${vertexEndpoint}" -H "Authorization: Bearer ${accessToken}" -H "Content-Type: application/json" -d '${JSON.stringify(requestBody).replace(/'/g, "'\\''")}'` : undefined;

    debugInfo.requestSent = true;
    if (curlCommand) {
      debugInfo.curl = curlCommand;
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

            // Add missing closing braces/brackets - O(1) instead of O(n²) loop
            const missingBraces = Math.max(0, openBraces - closeBraces);
            const missingBrackets = Math.max(0, openBrackets - closeBrackets);
            completedJson += '}'.repeat(missingBraces) + ']'.repeat(missingBrackets);

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

    // Note: Face-swap instruction validation removed - accept prompts even without explicit face-swap text
    // This allows AI-generated prompts that may describe the scene without explicitly mentioning face replacement
    const promptText = String(promptJson.prompt || '').toLowerCase();
    const hasFaceSwapInstruction = promptText.includes('replace the original face') ||
                                   promptText.includes('face from the image') ||
                                   promptText.includes('identical facial features');

    if (!hasFaceSwapInstruction) {
      console.log('[Vertex] Prompt does not contain explicit face-swap instruction, but accepting it anyway');
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

  // O(n) chunked base64 encoding - avoids O(n²) string concatenation
  // Old code: for loop with += was O(n²) and killed CPU with large images
  const CHUNK_SIZE = 0x8000; // 32KB chunks - safe for String.fromCharCode.apply
  const chunks: string[] = [];
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    const chunk = uint8Array.subarray(i, Math.min(i + CHUNK_SIZE, uint8Array.length));
    chunks.push(String.fromCharCode.apply(null, chunk as unknown as number[]));
  }
  return btoa(chunks.join(''));
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
      enable_sync_mode: true,
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
    // Use 120s timeout for sync mode (same as face swap API)
    const response = await fetchWithTimeout(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
    }, 120000);

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

      // Helper to extract URL from various response formats
      const extractResultUrl = (respData: any): string | null => {
        if (respData.output && typeof respData.output === 'string') return respData.output;
        if (respData.output?.url) return respData.output.url;
        if (respData.data?.output && typeof respData.data.output === 'string') return respData.data.output;
        if (respData.data?.output?.url) return respData.data.output.url;
        if (respData.url) return respData.url;
        if (respData.data?.url) return respData.data.url;
        if (respData.image_url) return respData.image_url;
        if (respData.data?.image_url) return respData.data.image_url;
        if (respData.output_url) return respData.output_url;
        if (respData.data?.output_url) return respData.data.output_url;
        if (respData.data?.outputs && Array.isArray(respData.data.outputs) && respData.data.outputs.length > 0) {
          const output = respData.data.outputs[0];
          if (typeof output === 'string') return output;
          if (output?.url) return output.url;
        }
        if (respData.outputs && Array.isArray(respData.outputs) && respData.outputs.length > 0) {
          const output = respData.outputs[0];
          if (typeof output === 'string') return output;
          if (output?.url) return output.url;
        }
        return null;
      };

      // Sync mode: extract result directly from response
      resultImageUrl = extractResultUrl(data);

      if (!resultImageUrl) {
        // Check if there's an error in the response
        const status = data.status || data.data?.status;
        if (status === 'failed' || status === 'error') {
          throw new Error(`Upscaling failed: ${data.error || data.message || data.data?.error || 'Unknown error'}`);
        }
        throw new Error('WaveSpeed API did not return result image URL');
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

// WaveSpeed Face Swap API
// Endpoint: https://api.wavespeed.ai/api/v3/wavespeed-ai/image-face-swap
// Docs: Takes face_image (selfie) and image (target/preset) to swap face
export const callWaveSpeedFaceSwap = async (
  faceImageUrl: string,
  targetImageUrl: string,
  env: Env,
  targetIndex: number = 0
): Promise<FaceSwapResponse> => {
  if (!env.WAVESPEED_API_KEY) {
    return {
      Success: false,
      Message: 'WAVESPEED_API_KEY is required',
      StatusCode: 500,
    };
  }

  const debugEnabled = env.ENABLE_DEBUG_RESPONSE === 'true';
  let debugInfo: Record<string, any> | undefined = debugEnabled ? {
    provider: 'wavespeed_faceswap',
    faceImage: faceImageUrl,
    targetImage: targetImageUrl,
    targetIndex,
  } : undefined;

  try {
    const endpoint = 'https://api.wavespeed.ai/api/v3/wavespeed-ai/image-face-swap';
    const requestBody = {
      enable_base64_output: false,
      enable_sync_mode: true,
      face_image: faceImageUrl,
      image: targetImageUrl,
      output_format: 'jpeg',
      target_index: targetIndex,
    };

    if (debugInfo) {
      debugInfo.curl = `curl -X POST "${endpoint}" -H "Content-Type: application/json" -H "Authorization: Bearer ${env.WAVESPEED_API_KEY}" -d '${JSON.stringify(requestBody)}'`;
    }

    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.WAVESPEED_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    }, 120000);

    const rawResponse = await response.text();
    if (debugInfo) {
      debugInfo.httpStatus = response.status;
      debugInfo.rawResponse = rawResponse.substring(0, 1000);
    }

    if (!response.ok) {
      return {
        Success: false,
        Message: `WaveSpeed Face Swap API error: ${response.status}`,
        StatusCode: response.status,
        Error: rawResponse.substring(0, 500),
        Debug: debugInfo,
      };
    }

    const data = JSON.parse(rawResponse);

    // Sync mode: response contains outputs directly
    if (data.data?.outputs && Array.isArray(data.data.outputs) && data.data.outputs.length > 0) {
      return {
        Success: true,
        ResultImageUrl: data.data.outputs[0],
        Message: 'WaveSpeed Face Swap completed',
        StatusCode: 200,
        Debug: debugInfo,
      };
    }

    // Fallback check for different response structure
    if (data.outputs && Array.isArray(data.outputs) && data.outputs.length > 0) {
      return {
        Success: true,
        ResultImageUrl: data.outputs[0],
        Message: 'WaveSpeed Face Swap completed',
        StatusCode: 200,
        Debug: debugInfo,
      };
    }

    return {
      Success: false,
      Message: 'WaveSpeed Face Swap: No output image in response',
      StatusCode: 500,
      Debug: debugInfo,
    };
  } catch (error) {
    return {
      Success: false,
      Message: `WaveSpeed Face Swap error: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200),
      Debug: debugInfo,
    };
  }
};

// WaveSpeed Flux Edit API
// Endpoint: https://api.wavespeed.ai/api/v3/wavespeed-ai/flux-2-klein-9b/edit
// Docs: Takes images array + prompt for AI-based image editing
export const callWaveSpeedEdit = async (
  imageUrls: string[],
  prompt: string,
  env: Env,
  aspectRatio?: string,
  size?: string
): Promise<FaceSwapResponse> => {
  if (!env.WAVESPEED_API_KEY) {
    return {
      Success: false,
      Message: 'WAVESPEED_API_KEY is required',
      StatusCode: 500,
    };
  }

  // Convert aspect ratio to size dimensions
  // WaveSpeed needs actual dimensions, not aspect ratio string
  // WaveSpeed API supports 256-1536 pixels per dimension
  const aspectRatioToSize = (ratio: string): string | null => {
    // Base dimension (longest side) - using 1536 (max supported by WaveSpeed)
    const baseDimension = 1536;

    const ratioMap: Record<string, [number, number]> = {
      '1:1': [1, 1],
      '3:2': [3, 2],
      '2:3': [2, 3],
      '3:4': [3, 4],
      '4:3': [4, 3],
      '4:5': [4, 5],
      '5:4': [5, 4],
      '9:16': [9, 16],
      '16:9': [16, 9],
      '21:9': [21, 9],
    };

    const parts = ratioMap[ratio];
    if (!parts) return null;

    const [w, h] = parts;
    // Calculate dimensions keeping the larger side at baseDimension
    if (w >= h) {
      const width = baseDimension;
      const height = Math.round((baseDimension * h) / w);
      return `${width}x${height}`;
    } else {
      const height = baseDimension;
      const width = Math.round((baseDimension * w) / h);
      return `${width}x${height}`;
    }
  };

  // Calculate size from aspect_ratio if size not provided
  let effectiveSize = size;
  if (!effectiveSize && aspectRatio) {
    effectiveSize = aspectRatioToSize(aspectRatio) || undefined;
  }

  const debugEnabled = env.ENABLE_DEBUG_RESPONSE === 'true';
  let debugInfo: Record<string, any> | undefined = debugEnabled ? {
    provider: 'wavespeed_edit',
    images: imageUrls,
    prompt: prompt.substring(0, 200),
    size: effectiveSize,
    aspectRatio: aspectRatio,
    calculatedFromAspectRatio: !size && !!aspectRatio,
  } : undefined;

  try {
    const endpoint = 'https://api.wavespeed.ai/api/v3/wavespeed-ai/flux-2-klein-9b/edit';
    const requestBody: Record<string, any> = {
      enable_base64_output: false,
      enable_sync_mode: true,
      images: imageUrls,
      prompt: prompt,
      seed: -1,
    };

    // Pass size parameter (either provided directly or calculated from aspect_ratio)
    if (effectiveSize) {
      requestBody.size = effectiveSize;
    }

    if (debugInfo) {
      debugInfo.curl = `curl -X POST "${endpoint}" -H "Content-Type: application/json" -H "Authorization: Bearer ${env.WAVESPEED_API_KEY}" -d '${JSON.stringify(requestBody)}'`;
    }

    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.WAVESPEED_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    }, 120000);

    const rawResponse = await response.text();
    if (debugInfo) {
      debugInfo.httpStatus = response.status;
      debugInfo.rawResponse = rawResponse.substring(0, 1000);
    }

    if (!response.ok) {
      return {
        Success: false,
        Message: `WaveSpeed Edit API error: ${response.status}`,
        StatusCode: response.status,
        Error: rawResponse.substring(0, 500),
        Debug: debugInfo,
      };
    }

    const data = JSON.parse(rawResponse);

    // Sync mode: response contains outputs directly
    if (data.data?.outputs && Array.isArray(data.data.outputs) && data.data.outputs.length > 0) {
      return {
        Success: true,
        ResultImageUrl: data.data.outputs[0],
        Message: 'WaveSpeed Edit completed',
        StatusCode: 200,
        Debug: debugInfo,
      };
    }

    // Fallback check for different response structure
    if (data.outputs && Array.isArray(data.outputs) && data.outputs.length > 0) {
      return {
        Success: true,
        ResultImageUrl: data.outputs[0],
        Message: 'WaveSpeed Edit completed',
        StatusCode: 200,
        Debug: debugInfo,
      };
    }

    return {
      Success: false,
      Message: 'WaveSpeed Edit: No output image in response',
      StatusCode: 500,
      Debug: debugInfo,
    };
  } catch (error) {
    return {
      Success: false,
      Message: `WaveSpeed Edit error: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200),
      Debug: debugInfo,
    };
  }
};

