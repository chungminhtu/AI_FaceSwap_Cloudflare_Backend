import type { Env, FaceSwapResponse, SafeSearchResult, GoogleVisionResponse } from './types';
import { isUnsafe, getWorstViolation, getAccessToken } from './utils';

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
  const response = await fetch(env.RAPIDAPI_ENDPOINT, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'x-rapidapi-host': env.RAPIDAPI_HOST,
      'x-rapidapi-key': env.RAPIDAPI_KEY,
      // Don't set Content-Type - browser/worker will set it with boundary for FormData
    },
    body: formData,
  });

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
    console.log('FaceSwap API response:', JSON.stringify(data).substring(0, 200));
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
    console.error('JSON parse error:', error, 'Response:', responseText.substring(0, 200));
    debugInfo.rawResponse = responseText.substring(0, 2000);
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
  sourceUrl: string,
  env: Env,
  aspectRatio: string = "1:1"
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
    const location = env.GOOGLE_VERTEX_LOCATION || 'us-central1';
    
    // Use Vertex AI Gemini API with image generation (Nano Banana)
    // IMPORTANT: Must use gemini-2.5-flash-image (not gemini-2.5-flash) for image generation
    // Only gemini-2.5-flash-image supports image + text output (responseModalities: ["TEXT", "IMAGE"])
    // gemini-2.5-flash only outputs text, so multimodal (image) output isn't supported
    // Cost: $30 per million output tokens for images (~$0.039 per image) vs $2.50 for text-only
    const geminiModel = 'gemini-2.5-flash-image';
    const geminiEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${geminiModel}:generateContent`;

    // Convert prompt_json to text string for Vertex AI
    // The prompt_json from DB is already the complete text to send - no modifications needed
    let promptText = '';
    if (prompt && typeof prompt === 'object') {
      // Convert the entire prompt_json object to a formatted text string
      promptText = JSON.stringify(prompt, null, 2);
    } else if (typeof prompt === 'string') {
      promptText = prompt;
    } else {
      promptText = JSON.stringify(prompt);
    }

    // Use prompt_json as-is - it's already the complete instruction text
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
          env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
        );
      } catch (tokenError) {
      console.error('[Vertex-NanoBanana] Failed to get OAuth token:', tokenError);
        return {
          Success: false,
          Message: `Failed to authenticate with Vertex AI: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
          StatusCode: 500,
        };
      }

    // Fetch only the selfie image as base64
    // For Nano Banana (Vertex AI), we only send the selfie image and text prompt
    // The preset image style is described in the prompt_json text
    // IMPORTANT: Declare variable first, then fetch to avoid TDZ (Temporal Dead Zone) issues
    let selfieImageData: string;
    
    selfieImageData = await fetchImageAsBase64(sourceUrl);

    // Validate and normalize aspect ratio
    // Supported values: "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
    const supportedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
    const normalizedAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : "1:1";

    // Vertex AI Gemini API request format with image generation
    // Based on official documentation format
    // IMPORTANT: For Nano Banana, we only send the selfie image + text prompt (not preset image)
    // The preset image style is described in the prompt_json text
    // contents must be an OBJECT, not an array (as per documentation)
    const requestBody = {
      contents: {
        role: "USER",  // Uppercase as per documentation
        parts: [
          {
            inline_data: {
              mimeType: "image/jpeg",  // camelCase as per documentation
              data: selfieImageData
            }
          },
          { text: faceSwapPrompt }  // This contains the prompt_json text describing the preset style
        ]
      },
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],  // Request both text and image output
        temperature: 0.7,
        maxOutputTokens: 2048,
        imageConfig: {
          aspectRatio: normalizedAspectRatio,  // Aspect ratio in format like "16:9", "4:3", etc.
        },
      },
      safetySettings: [{
        method: "PROBABILITY",
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      }]
    };

    // Generate curl command for testing (with sanitized base64)
    const sanitizedRequestBody = JSON.parse(JSON.stringify(requestBody, (key, value) => {
      if (key === 'data' && typeof value === 'string' && value.length > 100) {
        return '...'; // Replace base64 with placeholder
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
      inputImageBytes: selfieImageData.length,
      promptLength: faceSwapPrompt.length,
      targetUrl,
      sourceUrl,
      aspectRatio: aspectRatio, // Log the aspect ratio being sent
      normalizedAspectRatio: normalizedAspectRatio, // Log the normalized value
    };
    
    console.log('[Vertex-NanoBanana] Requesting image generation with aspect ratio:', normalizedAspectRatio, 'in generationConfig.imageConfig');

    // Call Vertex AI Gemini API
    const startTime = Date.now();
    const response = await fetch(geminiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody),
    });

    const rawResponse = await response.text();
    const durationMs = Date.now() - startTime;
    if (debugInfo) {
      debugInfo.status = response.status;
      debugInfo.statusText = response.statusText;
      debugInfo.durationMs = durationMs;
    }

    if (!response.ok) {
      console.error('[Vertex-NanoBanana] API error:', response.status, rawResponse.substring(0, 500));
      if (debugInfo) {
        try {
          debugInfo.rawResponse = JSON.parse(rawResponse);
        } catch {
          debugInfo.rawResponse = rawResponse.substring(0, 2000);
        }
      }
      
      return {
        Success: false,
        Message: `Vertex AI Gemini API error: ${response.status} ${response.statusText}`,
        StatusCode: response.status,
        Error: rawResponse, // Include full response text, not truncated
        FullResponse: rawResponse, // Also include in separate field for UI display
        CurlCommand: curlCommand, // Include curl command for testing
        Debug: debugInfo,
      };
    }

    try {
      const data = JSON.parse(rawResponse);
      if (debugInfo) {
        debugInfo.rawResponse = JSON.parse(JSON.stringify(data, (key, value) => {
          if (key === 'data' && typeof value === 'string' && value.length > 100) {
            return '...';
          }
          return value;
        }));
      }
      
      // Vertex AI Gemini API returns images in candidates[0].content.parts[] with inline_data
      const candidates = data.candidates || [];
      if (candidates.length === 0) {
          return {
            Success: false,
          Message: 'Vertex AI Gemini API did not return any candidates',
          StatusCode: 500,
          Error: 'No candidates found in response',
          Debug: debugInfo,
        };
      }

      const parts = candidates[0].content?.parts || [];
      let base64Image: string | null = null;
      let mimeType = 'image/png';

      // Extract image from parts array - look for inline_data (snake_case) or inlineData (camelCase)
      // Vertex AI API may return either format
      for (const part of parts) {
        // Check for camelCase format (inlineData) - this is what the API actually returns
        if (part.inlineData) {
          base64Image = part.inlineData.data;
          mimeType = part.inlineData.mimeType || part.inlineData.mime_type || 'image/png';
          break;
        }
        // Check for snake_case format (inline_data) - fallback
        if (part.inline_data) {
          base64Image = part.inline_data.data;
          mimeType = part.inline_data.mime_type || part.inline_data.mimeType || 'image/png';
          break;
        }
      }

      if (!base64Image) {
        console.error('[Vertex-NanoBanana] No image data found in response');
        return {
          Success: false,
          Message: 'Vertex AI Gemini API did not return an image in the response',
          StatusCode: 500,
          Error: 'No inline_data found in response parts',
          FullResponse: JSON.stringify(data, null, 2), // Include full response for debugging
          Debug: debugInfo,
        };
      }
      

      // Convert base64 to Uint8Array and upload to R2
      const binaryString = atob(base64Image);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const resultKey = `results/vertex_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.${mimeType.split('/')[1] || 'png'}`;
      
      const R2_BUCKET = getR2Bucket(env);
      await R2_BUCKET.put(resultKey, bytes, {
        httpMetadata: {
          contentType: mimeType,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
      if (debugInfo) {
        debugInfo.r2Key = resultKey;
        debugInfo.mimeType = mimeType;
      }
      
      // Get public URL (will be converted by caller)
      const resultImageUrl = `r2://${resultKey}`;

      // Sanitize response data for UI - replace base64 with "..."
      const sanitizedData = JSON.parse(JSON.stringify(data, (key, value) => {
        if (key === 'data' && typeof value === 'string' && value.length > 100) {
          // Likely base64 image data - replace with placeholder
          return '...';
        }
        return value;
      }));

      // Generate curl command for testing (with sanitized base64)
      const sanitizedRequestBody = JSON.parse(JSON.stringify(requestBody, (key, value) => {
        if (key === 'data' && typeof value === 'string' && value.length > 100) {
          return '...'; // Replace base64 with placeholder
        }
        return value;
      }));

      const curlCommand = `curl -X POST \\
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  ${geminiEndpoint} \\
  -d '${JSON.stringify(sanitizedRequestBody, null, 2).replace(/'/g, "'\\''")}'`;
      if (debugInfo) {
        debugInfo.requestPayload = sanitizedRequestBody;
        debugInfo.curlCommand = curlCommand;
        debugInfo.response = sanitizedData;
      }

      return {
        Success: true,
        ResultImageUrl: resultImageUrl,
        Message: 'Vertex AI image generation completed',
        StatusCode: response.status,
        VertexResponse: sanitizedData, // Include sanitized Vertex AI response JSON (base64 replaced with "...")
        Prompt: prompt, // Include the prompt that was used
        CurlCommand: curlCommand, // Include curl command for testing
        Debug: debugInfo,
      };
    } catch (parseError) {
      console.error('[Vertex-NanoBanana] JSON parse error:', parseError);
      console.error('[Vertex-NanoBanana] Full raw response that failed to parse:', rawResponse);
      if (debugInfo) {
        debugInfo.rawResponse = rawResponse.substring(0, 2000);
        debugInfo.parseError = parseError instanceof Error ? parseError.message : String(parseError);
      }
      return {
        Success: false,
        Message: `Failed to parse Vertex AI Gemini API response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        StatusCode: 500,
        Error: rawResponse, // Include full response text
        FullResponse: rawResponse, // Also include in separate field for UI display
        Debug: debugInfo,
      };
    }
  } catch (error) {
    console.error('[Vertex-NanoBanana] Unexpected error:', error);
    const debugPayload = debugInfo;
    if (debugPayload) {
      debugPayload.error = error instanceof Error ? error.message : String(error);
    }
    return {
      Success: false,
      Message: `Vertex AI face swap request failed: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: error instanceof Error ? error.stack : String(error),
      Debug: debugPayload,
    };
  }
};

// JWT and OAuth2 functions removed - now using API key authentication instead

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
    console.log('[SafeSearch] Calling Google Vision API:', {
      endpoint: env.GOOGLE_VISION_ENDPOINT,
      imageUrl: imageUrl.substring(0, 100) + '...',
      hasApiKey: !!apiKey
    });

    const requestBody = {
      requests: [{
        image: { source: { imageUri: imageUrl } },
        features: [{ type: 'SAFE_SEARCH_DETECTION', maxResults: 1 }],
      }],
    };

    const startTime = Date.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    console.log('[SafeSearch] API Response status:', response.status, response.statusText);
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
      console.error('[SafeSearch] API error response:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText.substring(0, 500)
      });
      debugInfo.rawResponse = errorText.substring(0, 2000);
      
      // Provide helpful error message for billing errors
      let errorMessage = `API error: ${response.status} - ${errorText.substring(0, 200)}`;
      if (response.status === 403 && errorText.includes('billing')) {
        errorMessage = `Billing not enabled. Google Vision API requires billing to be enabled. Please enable billing at: https://console.developers.google.com/billing?project=521788129450`;
      }
      
      return { isSafe: false, error: errorMessage, debug: debugInfo };
    }

    const data = await response.json() as GoogleVisionResponse;
    console.log('[SafeSearch] API Response data:', JSON.stringify(data, null, 2));
    debugInfo.response = data;

    const annotation = data.responses?.[0]?.safeSearchAnnotation;

    if (data.responses?.[0]?.error) {
      console.error('[SafeSearch] API returned error:', data.responses[0].error);
      return { 
        isSafe: false, 
        error: data.responses[0].error.message,
        rawResponse: data, // Include full raw response even on error
        debug: debugInfo,
      };
    }

    if (!annotation) {
      console.warn('[SafeSearch] No safe search annotation in response');
      return { 
        isSafe: false, 
        error: 'No safe search annotation',
        rawResponse: data, // Include full raw response
        debug: debugInfo,
      };
    }

    // Get strictness from env (default: 'lenient' - only blocks VERY_LIKELY)
    const strictness = (env.SAFETY_STRICTNESS === 'strict' ? 'strict' : 'lenient') as 'strict' | 'lenient';
    const isUnsafeResult = isUnsafe(annotation, strictness);
    
    // Find worst violation (highest severity)
    const worstViolation = getWorstViolation(annotation);
    
    console.log('[SafeSearch] Safety check result:', {
      ...annotation,
      isSafe: !isUnsafeResult,
      isUnsafe: isUnsafeResult,
      strictness: strictness,
      worstViolation: worstViolation
    });

    return {
      isSafe: !isUnsafeResult,
      statusCode: worstViolation?.code,
      violationCategory: worstViolation?.category,
      violationLevel: worstViolation?.level,
      details: annotation, // Return full safeSearchAnnotation details
      rawResponse: data, // Include full raw Vision API response
      debug: debugInfo,
    };
  } catch (error) {
    console.error('[SafeSearch] Exception:', error);
    return { isSafe: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// Vertex AI API integration for automatic prompt generation
export const generateVertexPrompt = async (
  imageUrl: string,
  env: Env
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
  
  const debugInfo: any = {};
  
  try {
    // Use Vertex AI credentials (OAuth token from service account, not API key)
    if (!env.GOOGLE_VERTEX_PROJECT_ID) {
      console.error('[Vertex] ❌ ERROR: GOOGLE_VERTEX_PROJECT_ID is required');
      return { 
        success: false, 
        error: 'GOOGLE_VERTEX_PROJECT_ID is required',
        debug: { errorDetails: 'Vertex AI project ID is missing from environment variables' }
      };
    }

    // Note: Model name should NOT include "models/" prefix for publishers endpoint
    // Using gemini-2.5-flash (text-only) for prompt generation - cheaper at $2.50 per million output tokens
    // vs gemini-2.5-flash-image at $30 per million output tokens for images
    // We only need text output (JSON prompt), so text-only model is more cost-effective
    const geminiModel = 'gemini-2.5-flash';
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = env.GOOGLE_VERTEX_LOCATION || 'us-central1';

    // Vertex AI endpoint format
    // Format: https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent
    const vertexEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${geminiModel}:generateContent`;

    debugInfo.endpoint = vertexEndpoint;
    debugInfo.model = geminiModel;

    // Exact prompt text as specified by user
    const prompt = `Analyze the provided image and return a detailed description of its contents, pose, clothing, environment, HDR lighting, style, and composition in a strict JSON format. Generate a JSON object with the following keys: "prompt", "style", "lighting", "composition", "camera", and "background". For the "prompt" key, write a detailed HDR scene description based on the target image, including the character's pose, outfit, environment, atmosphere, and visual mood. In the "prompt" field, also include this exact face-swap rule: "Replace the original face with the face from the image I will upload later; the final face must look exactly like the face in my uploaded image. Do not alter the facial structure, identity, age, or ethnicity, and preserve all distinctive facial features. Makeup, lighting, and color grading may be adjusted only to match the HDR visual look of the target scene." The generated prompt must be fully compliant with Google Play Store content policies: the description must not contain any sexual, explicit, suggestive, racy, erotic, fetish, or adult content; no exposed sensitive body areas; no provocative wording or implications; and the entire scene must remain wholesome, respectful, and appropriate for all audiences. The JSON should fully describe the image and follow the specified structure, without any extra commentary or text outside the JSON.`;

    // Fetch image as base64
    const imageData = await fetchImageAsBase64(imageUrl);

    // Build request body following Vertex AI API format
    // Note: contents array items must include a "role" field set to "user" or "model"
    const requestBody = {
      contents: [{
        role: "user",  // Required: must be "user" or "model"
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: imageData
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        topK: 1,
        topP: 1,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Detailed HDR scene description including character pose, outfit, environment, atmosphere, visual mood, and face-swap rule"
            },
            style: {
              type: "string",
              description: "Visual style description"
            },
            lighting: {
              type: "string",
              description: "HDR lighting description"
            },
            composition: {
              type: "string",
              description: "Composition details"
            },
            camera: {
              type: "string",
              description: "Camera settings and lens information"
            },
            background: {
              type: "string",
              description: "Background environment description"
            }
          },
          required: ["prompt", "style", "lighting", "composition", "camera", "background"]
        }
      }
    };

    debugInfo.requestSent = true;
    debugInfo.requestPayload = {
      promptLength: prompt.length,
      imageBytes: imageData.length,
      imageUrl,
    };
    
    // Vertex AI requires OAuth token
      if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      console.error('[Vertex] ❌ Vertex AI requires service account credentials');
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
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      );
      } catch (tokenError) {
      console.error('[Vertex] ❌ Failed to get OAuth token:', tokenError);
        return {
          success: false,
          error: `Failed to authenticate with Vertex AI: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
          debug: { errorDetails: String(tokenError) }
        };
    }
    
    const response = await fetch(vertexEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody),
    });
    
    const responseTime = Date.now() - startTime;
    debugInfo.httpStatus = response.status;
    debugInfo.httpStatusText = response.statusText;
    debugInfo.responseTimeMs = responseTime;
    

    if (!response.ok) {
      const errorText = await response.text();
      const errorPreview = errorText.substring(0, 1000);
      debugInfo.errorDetails = errorPreview;
      debugInfo.rawError = errorText;
      console.error('[Vertex] API error:', {
        status: response.status,
        statusText: response.statusText,
        error: errorPreview
      });
      return { 
        success: false, 
        error: `Vertex AI API error: ${response.status} ${response.statusText}`,
        debug: debugInfo
      };
    }

    const data = await response.json() as any;
    const responseStructure = JSON.stringify(data).substring(0, 500);
    debugInfo.responseStructure = responseStructure;
    console.log('[Vertex] Response structure:', responseStructure);

    // With structured outputs (responseMimeType: "application/json"), Vertex AI returns JSON directly
    const parts = data.candidates?.[0]?.content?.parts;
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
      // Structured output returns text containing JSON
      if (part.text) {
        try {
          promptJson = JSON.parse(part.text);
          break;
        } catch (e) {
          // If parse fails, try extracting from markdown code blocks
          let jsonText = part.text;
          if (jsonText.includes('```json')) {
            const jsonMatch = jsonText.match(/```json\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch) {
              jsonText = jsonMatch[1];
            }
          } else if (jsonText.includes('```')) {
            const jsonMatch = jsonText.match(/```\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch) {
              jsonText = jsonMatch[1];
            }
          }
          try {
            promptJson = JSON.parse(jsonText);
            break;
          } catch (parseError) {
            console.warn('[Vertex] Failed to parse JSON from text:', parseError);
          }
        }
      }
    }

    if (!promptJson) {
      const partsDebug = JSON.stringify(parts).substring(0, 500);
      console.error('[Vertex] Could not extract JSON from response. Parts:', partsDebug);
      debugInfo.errorDetails = 'Could not extract valid JSON from response parts';
      debugInfo.responseStructure = partsDebug;
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
      console.error('[Vertex] Missing required keys:', missingKeys);
      console.error('[Vertex] Received JSON:', JSON.stringify(promptJson));
      return { success: false, error: `Missing required keys: ${missingKeys.join(', ')}` };
    }

    debugInfo.responseTimeMs = Date.now() - startTime;
    return { success: true, prompt: promptJson, debug: debugInfo };

  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('[Vertex] Prompt generation failed:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    debugInfo.errorDetails = errorMessage;
    debugInfo.rawError = errorStack || String(error);
    debugInfo.responseTimeMs = responseTime;
    return { 
      success: false, 
      error: errorMessage,
      debug: debugInfo
    };
  }
};

// Helper function to fetch image and convert to base64
const fetchImageAsBase64 = async (imageUrl: string): Promise<string> => {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  let binary = '';
  uint8Array.forEach(byte => binary += String.fromCharCode(byte));
  return btoa(binary);
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
    const apiEndpoint = 'https://api.wavespeed.ai/api/v3/wavespeed-ai/ultimate-image-upscaler';
    
    debugInfo = {
      endpoint: apiEndpoint,
      model: 'wavespeed-ai/ultimate-image-upscaler',
      imageUrl,
    };

    const requestBody = {
      image: imageUrl
    };

    const startTime = Date.now();
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
    });

    const rawResponse = await response.text();
    const durationMs = Date.now() - startTime;
    if (debugInfo) {
      debugInfo.status = response.status;
      debugInfo.statusText = response.statusText;
      debugInfo.durationMs = durationMs;
    }

    if (!response.ok) {
      console.error('[Upscaler4K] WaveSpeed API error:', response.status, rawResponse.substring(0, 500));
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
        debugInfo.rawResponse = JSON.parse(JSON.stringify(data, (key, value) => {
          if (key === 'data' && typeof value === 'string' && value.length > 100) {
            return '...';
          }
          return value;
        }));
      }
      
      console.log('[Upscaler4K] Full response structure:', JSON.stringify(data, null, 2).substring(0, 1000));
      
      let resultImageUrl: string | null = null;
      
      // WaveSpeed API returns image in data.outputs array
      if (data.data?.outputs && Array.isArray(data.data.outputs) && data.data.outputs.length > 0) {
        const output = data.data.outputs[0];
        if (typeof output === 'string') {
          resultImageUrl = output;
        } else if (output?.url) {
          resultImageUrl = output.url;
        }
      } else if (data.outputs && Array.isArray(data.outputs) && data.outputs.length > 0) {
        const output = data.outputs[0];
        if (typeof output === 'string') {
          resultImageUrl = output;
        } else if (output?.url) {
          resultImageUrl = output.url;
        }
      } else if (data.data?.output_url) {
        resultImageUrl = data.data.output_url;
      } else if (data.output_url) {
        resultImageUrl = data.output_url;
      } else if (data.output) {
        resultImageUrl = typeof data.output === 'string' ? data.output : data.output.url || data.output.image_url;
      } else if (data.image_url) {
        resultImageUrl = data.image_url;
      } else if (data.url) {
        resultImageUrl = data.url;
      } else if (data.result?.url) {
        resultImageUrl = data.result.url;
      } else if (data.result?.output_url) {
        resultImageUrl = data.result.output_url;
      } else if (data.result?.image_url) {
        resultImageUrl = data.result.image_url;
      } else if (data.data?.url) {
        resultImageUrl = data.data.url;
      } else if (data.data?.image_url) {
        resultImageUrl = data.data.image_url;
      } else if (data.image) {
        resultImageUrl = typeof data.image === 'string' ? data.image : data.image.url || data.image.output_url;
      } else if (data.upscaled_image) {
        resultImageUrl = typeof data.upscaled_image === 'string' ? data.upscaled_image : data.upscaled_image.url;
      } else if (data.upscaled) {
        resultImageUrl = typeof data.upscaled === 'string' ? data.upscaled : data.upscaled.url;
      }
      
      // Check if status is "processing" and we need to poll the result URL
      if (!resultImageUrl && data.data?.status === 'processing' && data.data?.urls?.get) {
        const getUrl = data.data.urls.get;
        console.log('[Upscaler4K] Task is processing, polling result URL:', getUrl);
        
        // Poll the result URL (max 10 attempts, 2 seconds apart)
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          const resultResponse = await fetch(getUrl, {
            headers: {
              'Authorization': `Bearer ${apiKey}`
            }
          });
          
          if (resultResponse.ok) {
            const resultData = await resultResponse.json();
            console.log('[Upscaler4K] Poll result:', JSON.stringify(resultData, null, 2).substring(0, 500));
            
            if (resultData.data?.outputs && Array.isArray(resultData.data.outputs) && resultData.data.outputs.length > 0) {
              const output = resultData.data.outputs[0];
              if (typeof output === 'string') {
                resultImageUrl = output;
                break;
              } else if (output?.url) {
                resultImageUrl = output.url;
                break;
              }
            } else if (resultData.data?.status === 'completed' && resultData.data?.output_url) {
              resultImageUrl = resultData.data.output_url;
              break;
            } else if (resultData.data?.status === 'failed') {
              throw new Error(`Upscaling failed: ${resultData.data.error || 'Unknown error'}`);
            }
          }
        }
      }

      let imageBytes: Uint8Array;
      let contentType = 'image/png';
      
      if (!resultImageUrl) {
        // Check for base64 in outputs array
        let base64Data: string | null = null;
        
        if (data.data?.outputs && Array.isArray(data.data.outputs) && data.data.outputs.length > 0) {
          const output = data.data.outputs[0];
          if (typeof output === 'string' && (output.startsWith('data:') || output.length > 100)) {
            base64Data = output;
          }
        } else if (data.outputs && Array.isArray(data.outputs) && data.outputs.length > 0) {
          const output = data.outputs[0];
          if (typeof output === 'string' && (output.startsWith('data:') || output.length > 100)) {
            base64Data = output;
          }
        } else if (data.base64 || data.data?.base64 || data.image_base64) {
          base64Data = data.base64 || data.data?.base64 || data.image_base64;
        }
        
        if (base64Data) {
          if (typeof base64Data === 'string' && base64Data.startsWith('data:')) {
            const base64Match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              contentType = base64Match[1] || 'image/png';
              const base64String = base64Match[2];
              const binaryString = atob(base64String);
              imageBytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) {
                imageBytes[i] = binaryString.charCodeAt(i);
              }
            } else {
              console.error('[Upscaler4K] Invalid base64 data URL format');
              return {
                Success: false,
                Message: 'WaveSpeed API returned invalid base64 image data',
                StatusCode: 500,
                Error: 'Invalid base64 format',
                FullResponse: JSON.stringify(data, null, 2),
                Debug: debugInfo,
              };
            }
          } else if (typeof base64Data === 'string') {
            const binaryString = atob(base64Data);
            imageBytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              imageBytes[i] = binaryString.charCodeAt(i);
            }
          } else {
            console.error('[Upscaler4K] No image URL or base64 data found in response. Full response:', JSON.stringify(data, null, 2));
            return {
              Success: false,
              Message: 'WaveSpeed API did not return an image URL or base64 data in the response',
              StatusCode: 500,
              Error: 'No image URL or base64 data found in response',
              FullResponse: JSON.stringify(data, null, 2),
              Debug: debugInfo,
            };
          }
        } else {
          console.error('[Upscaler4K] No image URL or base64 data found in response. Full response:', JSON.stringify(data, null, 2));
          return {
            Success: false,
            Message: 'WaveSpeed API did not return an image URL or base64 data in the response',
            StatusCode: 500,
            Error: 'No image URL or base64 data found in response',
            FullResponse: JSON.stringify(data, null, 2),
            Debug: debugInfo,
          };
        }
      } else {
        // Check if resultImageUrl is a base64 data URL
        if (resultImageUrl.startsWith('data:')) {
          const base64Match = resultImageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (base64Match) {
            contentType = base64Match[1] || 'image/png';
            const base64String = base64Match[2];
            const binaryString = atob(base64String);
            imageBytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              imageBytes[i] = binaryString.charCodeAt(i);
            }
          } else {
            throw new Error('Invalid base64 data URL format');
          }
        } else {
          const imageResponse = await fetch(resultImageUrl);
          if (!imageResponse.ok) {
            throw new Error(`Failed to fetch upscaled image: ${imageResponse.status}`);
          }

          const imageData = await imageResponse.arrayBuffer();
          imageBytes = new Uint8Array(imageData);
          contentType = imageResponse.headers.get('content-type') || 'image/png';
        }
      }
      
      const resultKey = `results/upscaler4k_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.${contentType.split('/')[1] || 'png'}`;
      
      const R2_BUCKET = getR2Bucket(env);
      await R2_BUCKET.put(resultKey, imageBytes, {
        httpMetadata: {
          contentType,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
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
      console.error('[Upscaler4K] JSON parse error:', parseError);
      console.error('[Upscaler4K] Full raw response that failed to parse:', rawResponse);
      if (debugInfo) {
        debugInfo.rawResponse = rawResponse.substring(0, 2000);
        debugInfo.parseError = parseError instanceof Error ? parseError.message : String(parseError);
      }
      return {
        Success: false,
        Message: `Failed to parse WaveSpeed API response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        StatusCode: 500,
        Error: rawResponse,
        FullResponse: rawResponse,
        Debug: debugInfo,
      };
    }
  } catch (error) {
    console.error('[Upscaler4K] Unexpected error:', error);
    const debugPayload = debugInfo;
    if (debugPayload) {
      debugPayload.error = error instanceof Error ? error.message : String(error);
    }
    return {
      Success: false,
      Message: `Upscaler4K request failed: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: error instanceof Error ? error.stack : String(error),
      Debug: debugPayload,
    };
  }
};

