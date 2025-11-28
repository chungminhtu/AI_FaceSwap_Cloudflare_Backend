import type { Env, FaceSwapResponse, SafeSearchResult, GoogleVisionResponse } from './types';
import { isUnsafe, getWorstViolation, getAccessToken } from './utils';

export const callFaceSwap = async (
  targetUrl: string,
  sourceUrl: string,
  env: Env
): Promise<FaceSwapResponse> => {
  // Create form-data for multipart/form-data request
  const formData = new FormData();
  formData.append('target_url', targetUrl);
  formData.append('source_url', sourceUrl);

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

  if (!response.ok) {
    const errorText = await response.text();
    return {
      Success: false,
      Message: `FaceSwap API error: ${response.status} ${response.statusText}`,
      StatusCode: response.status,
      Error: errorText,
    };
  }

  const responseText = await response.text();
  try {
    const data = JSON.parse(responseText);
    console.log('FaceSwap API response:', JSON.stringify(data).substring(0, 200));
    
    // Transform API response to match FaceSwapResponse format
    // API returns: { message, file_url, processing_time }
    // We need: { Success, ResultImageUrl, Message, StatusCode }
    const transformedResponse: FaceSwapResponse = {
      Success: data.message === 'Processing successful' || !!data.file_url,
      ResultImageUrl: data.file_url || data.ResultImageUrl,
      Message: data.message || 'Face swap completed',
      StatusCode: response.status,
      ProcessingTime: data.processing_time?.toString() || data.ProcessingTime,
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
    return {
      Success: false,
      Message: `Failed to parse FaceSwap API response: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: responseText.substring(0, 200),
    };
  }
};

export const callNanoBanana = async (
  prompt: unknown,
  targetUrl: string,
  sourceUrl: string,
  env: Env
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

  try {
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = env.GOOGLE_VERTEX_LOCATION || 'us-central1';
    
    // Use Vertex AI Gemini API with image generation (Nano Banana)
    // Using stable production model: gemini-2.5-flash
    const geminiModel = 'gemini-2.5-flash';
    const geminiEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${geminiModel}:generateContent`;

    // Build the prompt text from the stored prompt JSON (this describes the preset scene)
    let promptText = '';
    if (prompt && typeof prompt === 'object') {
      const promptObj = prompt as any;
      promptText = promptObj.prompt || JSON.stringify(promptObj);
    } else if (typeof prompt === 'string') {
      promptText = prompt;
    } else {
      promptText = JSON.stringify(prompt);
    }

    // Add face swap instruction to the prompt
    const faceSwapPrompt = `${promptText}\n\nPlease swap the face from the second image (selfie) onto the first image (preset), maintaining the style, lighting, and composition of the preset image.`;

    console.log('[Vertex-NanoBanana] Using Vertex AI Gemini API for image generation (Nano Banana)');
    console.log('[Vertex-NanoBanana] Preset URL:', targetUrl);
    console.log('[Vertex-NanoBanana] Selfie URL:', sourceUrl);
    console.log('[Vertex-NanoBanana] Prompt:', faceSwapPrompt.substring(0, 200));

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
      console.log('[Vertex-NanoBanana] Generating OAuth access token for Vertex AI...');
      accessToken = await getAccessToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      );
      console.log('[Vertex-NanoBanana] ✅ OAuth token obtained successfully');
    } catch (tokenError) {
      console.error('[Vertex-NanoBanana] ❌ Failed to get OAuth token:', tokenError);
      return {
        Success: false,
        Message: `Failed to authenticate with Vertex AI: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
        StatusCode: 500,
      };
    }

    // Fetch both preset and selfie images as base64
    console.log('[Vertex-NanoBanana] Fetching preset image from:', targetUrl);
    const presetImageData = await fetchImageAsBase64(targetUrl);
    console.log('[Vertex-NanoBanana] ✅ Preset image fetched, base64 length:', presetImageData.length);
    
    console.log('[Vertex-NanoBanana] Fetching selfie image from:', sourceUrl);
    const selfieImageData = await fetchImageAsBase64(sourceUrl);
    console.log('[Vertex-NanoBanana] ✅ Selfie image fetched, base64 length:', selfieImageData.length);

    // Vertex AI Gemini API request format with image generation
    // Based on official documentation format
    // IMPORTANT: contents must be an OBJECT, not an array (as per documentation)
    const requestBody = {
      contents: {
        role: "USER",  // Uppercase as per documentation
        parts: [
          {
            inline_data: {
              mimeType: "image/jpeg",  // camelCase as per documentation
              data: presetImageData
            }
          },
          {
            inline_data: {
              mimeType: "image/jpeg",
              data: selfieImageData
            }
          },
          { text: faceSwapPrompt }  // This is the prompt_json text
        ]
      },
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],  // Request both text and image output
        imageConfig: {
          aspectRatio: "1:1",  // Square aspect ratio for face swap
        },
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
      safetySettings: [{
        method: "PROBABILITY",
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      }]
    };

    // Call Vertex AI Gemini API
    const response = await fetch(geminiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(requestBody),
    });

    const rawResponse = await response.text();
    console.log('[Vertex-NanoBanana] Response status:', response.status);

    if (!response.ok) {
      console.error('[Vertex-NanoBanana] API error:', rawResponse.substring(0, 500));
      return {
        Success: false,
        Message: `Vertex AI Gemini API error: ${response.status} ${response.statusText}`,
        StatusCode: response.status,
        Error: rawResponse.substring(0, 500),
      };
    }

    try {
      const data = JSON.parse(rawResponse);
      console.log('[Vertex-NanoBanana] Response structure:', JSON.stringify(data).substring(0, 500));
      
      // Vertex AI Gemini API returns images in candidates[0].content.parts[] with inline_data
      const candidates = data.candidates || [];
      if (candidates.length === 0) {
          return {
            Success: false,
          Message: 'Vertex AI Gemini API did not return any candidates',
          StatusCode: 500,
          Error: 'No candidates found in response',
        };
      }

      const parts = candidates[0].content?.parts || [];
      let base64Image: string | null = null;
      let mimeType = 'image/png';

      // Extract image from parts array - look for inline_data
      for (const part of parts) {
        if (part.inline_data) {
          base64Image = part.inline_data.data;
          mimeType = part.inline_data.mime_type || 'image/png';
          console.log('[Vertex-NanoBanana] ✅ Found image in inline_data, mimeType:', mimeType);
          break;
        }
      }

      if (!base64Image) {
        console.error('[Vertex-NanoBanana] No image data found in response parts');
        console.log('[Vertex-NanoBanana] Available parts:', JSON.stringify(parts).substring(0, 500));
        return {
          Success: false,
          Message: 'Vertex AI Gemini API did not return an image in the response',
          StatusCode: 500,
          Error: 'No inline_data found in response parts',
        };
      }
      
      console.log('[Vertex-NanoBanana] ✅ Received base64 image from Vertex AI, length:', base64Image.length);

      // Convert base64 to Uint8Array and upload to R2
      const binaryString = atob(base64Image);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const resultKey = `results/vertex_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.${mimeType.split('/')[1] || 'png'}`;
      
      await env.FACESWAP_IMAGES.put(resultKey, bytes, {
        httpMetadata: {
          contentType: mimeType,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
      
      // Get public URL (will be converted by caller)
      const resultImageUrl = `r2://${resultKey}`;
      console.log('[Vertex-NanoBanana] ✅ Image uploaded to R2:', resultKey);

      return {
        Success: true,
        ResultImageUrl: resultImageUrl,
        Message: 'Vertex AI image generation completed',
        StatusCode: response.status,
      };
    } catch (parseError) {
      return {
        Success: false,
        Message: 'Failed to parse Vertex AI Gemini API response',
        StatusCode: 500,
        Error: rawResponse.substring(0, 500),
      };
    }
  } catch (error) {
    console.error('[Vertex-NanoBanana] Unexpected error:', error);
    return {
      Success: false,
      Message: `Vertex AI face swap request failed: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: error instanceof Error ? error.stack : String(error),
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

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    console.log('[SafeSearch] API Response status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SafeSearch] API error response:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText.substring(0, 500)
      });
      
      // Provide helpful error message for billing errors
      let errorMessage = `API error: ${response.status} - ${errorText.substring(0, 200)}`;
      if (response.status === 403 && errorText.includes('billing')) {
        errorMessage = `Billing not enabled. Google Vision API requires billing to be enabled. Please enable billing at: https://console.developers.google.com/billing?project=521788129450`;
      }
      
      return { isSafe: false, error: errorMessage };
    }

    const data = await response.json() as GoogleVisionResponse;
    console.log('[SafeSearch] API Response data:', JSON.stringify(data, null, 2));

    const annotation = data.responses?.[0]?.safeSearchAnnotation;

    if (data.responses?.[0]?.error) {
      console.error('[SafeSearch] API returned error:', data.responses[0].error);
      return { 
        isSafe: false, 
        error: data.responses[0].error.message,
        rawResponse: data // Include full raw response even on error
      };
    }

    if (!annotation) {
      console.warn('[SafeSearch] No safe search annotation in response');
      return { 
        isSafe: false, 
        error: 'No safe search annotation',
        rawResponse: data // Include full raw response
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
      rawResponse: data // Include full raw Vision API response
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
  console.log('[Vertex] ========== STARTING VERTEX AI PROMPT GENERATION ==========');
  console.log('[Vertex] Image URL:', imageUrl);
  console.log('[Vertex] Function called at:', new Date().toISOString());
  
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
    console.log('[Vertex] ✅ Vertex AI credentials found');

    // Note: Model name should NOT include "models/" prefix for publishers endpoint
    const geminiModel = 'gemini-2.5-flash';
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = env.GOOGLE_VERTEX_LOCATION || 'us-central1';

    // Vertex AI endpoint format
    // Format: https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent
    const vertexEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${geminiModel}:generateContent`;

    debugInfo.endpoint = vertexEndpoint;
    debugInfo.model = geminiModel;
    console.log('[Vertex] Using Vertex AI endpoint:', vertexEndpoint);
    console.log('[Vertex] Using model:', geminiModel);

    // Exact prompt text as specified by user
    const prompt = `Analyze the provided image and return a detailed description of its contents, pose, clothing, environment, HDR lighting, style, and composition in a strict JSON format. Generate a JSON object with the following keys: "prompt", "style", "lighting", "composition", "camera", and "background". For the "prompt" key, write a detailed HDR scene description based on the target image, including the character's pose, outfit, environment, atmosphere, and visual mood. In the "prompt" field, also include this exact face-swap rule: "Replace the original face with the face from the image I will upload later; the final face must look exactly like the face in my uploaded image. Do not alter the facial structure, identity, age, or ethnicity, and preserve all distinctive facial features. Makeup, lighting, and color grading may be adjusted only to match the HDR visual look of the target scene." The generated prompt must be fully compliant with Google Play Store content policies: the description must not contain any sexual, explicit, suggestive, racy, erotic, fetish, or adult content; no exposed sensitive body areas; no provocative wording or implications; and the entire scene must remain wholesome, respectful, and appropriate for all audiences. The JSON should fully describe the image and follow the specified structure, without any extra commentary or text outside the JSON.`;

    // Fetch image as base64
    console.log('[Vertex] Fetching image as base64 from:', imageUrl);
    const imageData = await fetchImageAsBase64(imageUrl);
    console.log('[Vertex] ✅ Image fetched, base64 length:', imageData.length);

    // Build request body following Vertex AI API format
    // Note: contents array items must include a "role" field set to "user" or "model"
    console.log('[Vertex] Building request body with exact prompt text...');
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
    console.log('[Vertex] Request body prepared, sending to Vertex AI API...');
    console.log('[Vertex] Request URL:', vertexEndpoint);
    console.log('[Vertex] Prompt text length:', prompt.length);

    debugInfo.requestSent = true;
    
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
      console.log('[Vertex] Generating OAuth access token for Vertex AI...');
      accessToken = await getAccessToken(
          env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
        );
      console.log('[Vertex] ✅ OAuth token obtained successfully');
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
    
    console.log('[Vertex] ✅ API request sent, received status:', response.status, response.statusText);
    console.log('[Vertex] Response time:', responseTime, 'ms');

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

    console.log('[Vertex] ✅ Generated prompt successfully with all required keys');
    console.log('[Vertex] Prompt preview:', promptJson.prompt?.substring(0, 200));
    console.log('[Vertex] ========== VERTEX AI PROMPT GENERATION SUCCESS ==========');
    debugInfo.responseTimeMs = Date.now() - startTime;
    return { success: true, prompt: promptJson, debug: debugInfo };

  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('[Vertex] ========== VERTEX AI PROMPT GENERATION FAILED ==========');
    console.error('[Vertex] Exception:', error);
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

