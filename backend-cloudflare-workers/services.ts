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
    console.error('JSON parse error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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
  sourceUrl: string,
  env: Env,
  aspectRatio?: string
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
    const providedRatio = aspectRatio || "1:1";
    const normalizedAspectRatio = supportedRatios.includes(providedRatio) ? providedRatio : "1:1";

    // Vertex AI Gemini API request format with image generation
    // Based on official documentation format
    // IMPORTANT: For Nano Banana, we only send the selfie image + text prompt (not preset image)
    // The preset image style is described in the prompt_json text
    // contents must be an ARRAY (as per Vertex AI API documentation)
    const requestBody = {
      contents: [{
        role: "user",  // Lowercase as per Vertex AI API documentation
        parts: [
          {
            inline_data: {
              mime_type: "image/jpeg",  // snake_case to match generateVertexPrompt format
              data: selfieImageData
            }
          },
          { text: faceSwapPrompt }  // This contains the prompt_json text describing the preset style
        ]
      }],
      generationConfig: {
        temperature: 1,
        maxOutputTokens: 32768,
        responseModalities: ["TEXT", "IMAGE"],  // Request both text and image output
        topP: 0.95,
        imageConfig: {
          aspectRatio: normalizedAspectRatio,  // Aspect ratio in format like "16:9", "4:3", "9:16", etc.
          imageSize: "1K",
          imageOutputOptions: {
            mimeType: "image/png"
          },
          personGeneration: "ALLOW_ALL"
        },
      },
      safetySettings: [{
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "OFF"
      }, {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "OFF"
      }, {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "OFF"
      }, {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "OFF"
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
      receivedAspectRatio: aspectRatio, // Log the aspect ratio received
      normalizedAspectRatio: normalizedAspectRatio, // Log the normalized value
    };

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
      console.error('[Vertex-NanoBanana] API error:', response.status, response.statusText);
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
      console.error('[Vertex-NanoBanana] JSON parse error:', parseError instanceof Error ? parseError.message.substring(0, 200) : String(parseError).substring(0, 200));
      if (debugInfo) {
        debugInfo.rawResponse = rawResponse.substring(0, 200);
        debugInfo.parseError = parseError instanceof Error ? parseError.message : String(parseError);
      }
      return {
        Success: false,
        Message: `Failed to parse Vertex AI Gemini API response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        StatusCode: 500,
        Error: rawResponse.substring(0, 200),
        Debug: debugInfo,
      };
    }
  } catch (error) {
      console.error('[Vertex-NanoBanana] Unexpected error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
    const debugPayload = debugInfo;
    if (debugPayload) {
      debugPayload.error = error instanceof Error ? error.message : String(error);
    }
    return {
      Success: false,
      Message: `Vertex AI face swap request failed: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200),
      Debug: debugPayload,
    };
  }
};

export const callNanoBananaMerge = async (
  prompt: unknown,
  selfieUrl: string,
  presetUrl: string,
  env: Env,
  aspectRatio?: string
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
    const location = env.GOOGLE_VERTEX_LOCATION || 'us-central1';
    
    const geminiModel = 'gemini-2.5-flash-image';
    const geminiEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${geminiModel}:generateContent`;

    let promptText = '';
    if (prompt && typeof prompt === 'object') {
      promptText = JSON.stringify(prompt, null, 2);
    } else if (typeof prompt === 'string') {
      promptText = prompt;
    } else {
      promptText = JSON.stringify(prompt);
    }

    const mergePrompt = promptText || `You are a professional photo compositor. Your task is to seamlessly blend and composite the person from the first image (which has a transparent background) into the second image (the landscape scene).

CRITICAL REQUIREMENTS:
1. COMPOSITING, NOT PASTING: Do NOT simply paste or glue the person onto the scene. You must blend them together as if the person was actually photographed in that scene.

2. PRESERVE FACIAL FEATURES: Keep the person's face EXACTLY the same - same facial structure, same identity, same age, same ethnicity. Only adjust lighting and color grading on the face to match the scene's lighting conditions.

3. REALISTIC LIGHTING INTEGRATION:
   - Match the direction, intensity, and color temperature of the scene's lighting
   - Add appropriate highlights and shadows on the person based on the scene's light sources
   - Ensure the person's skin tone and clothing colors match the ambient lighting

4. NATURAL POSE ADJUSTMENT:
   - Adjust the person's body pose and position to fit naturally within the scene context
   - Make the pose look realistic for the environment (e.g., standing on ground, sitting on objects, etc.)
   - Ensure proper perspective and scale relative to the scene

5. SEAMLESS BLENDING:
   - Remove any visible edges or artifacts from the transparent background
   - Blend the person's edges naturally into the scene
   - Add realistic shadows cast by the person onto the ground/objects in the scene
   - Match the depth of field and atmospheric effects (fog, haze, etc.) if present

6. SCENE INTEGRATION:
   - If the scene contains other people, position the person naturally among them as if they were all photographed together
   - Make interactions look natural and realistic
   - Ensure proper scale and perspective relative to other people/objects

7. PHOTOREALISTIC RESULT:
   - The final image should look like a single, cohesive photograph
   - No visible seams, artifacts, or signs of compositing
   - The person should appear to belong naturally in the scene

Generate a photorealistic composite image that seamlessly blends the person into the landscape scene.`;

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
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      );
    } catch (tokenError) {
      console.error('[Vertex-NanoBananaMerge] Failed to get OAuth token:', tokenError);
      return {
        Success: false,
        Message: `Failed to authenticate with Vertex AI: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
        StatusCode: 500,
      };
    }

    const selfieImageData = await fetchImageAsBase64(selfieUrl);
    const presetImageData = await fetchImageAsBase64(presetUrl);

    const supportedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
    const providedRatio = aspectRatio || "1:1";
    const normalizedAspectRatio = supportedRatios.includes(providedRatio) ? providedRatio : "1:1";

    const requestBody = {
      contents: [{
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: selfieImageData
            }
          },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: presetImageData
            }
          },
          { text: mergePrompt }
        ]
      }],
      generationConfig: {
        temperature: 1,
        maxOutputTokens: 32768,
        responseModalities: ["TEXT", "IMAGE"],
        topP: 0.95,
        imageConfig: {
          aspectRatio: normalizedAspectRatio,
          imageSize: "1K",
          imageOutputOptions: {
            mimeType: "image/png"
          },
          personGeneration: "ALLOW_ALL"
        },
      },
      safetySettings: [{
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "OFF"
      }, {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "OFF"
      }, {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "OFF"
      }, {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "OFF"
      }]
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
      console.error('[Vertex-NanoBananaMerge] API error:', response.status, response.statusText);
      if (debugInfo) {
        try {
          debugInfo.rawResponse = JSON.parse(rawResponse);
        } catch {
          debugInfo.rawResponse = rawResponse.substring(0, 200);
        }
      }
      
      return {
        Success: false,
        Message: `Vertex AI Gemini API error: ${response.status} ${response.statusText}`,
        StatusCode: response.status,
        Error: rawResponse.substring(0, 200),
        FullResponse: rawResponse.substring(0, 200),
        CurlCommand: curlCommand,
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

      for (const part of parts) {
        if (part.inlineData) {
          base64Image = part.inlineData.data;
          mimeType = part.inlineData.mimeType || part.inlineData.mime_type || 'image/png';
          break;
        }
        if (part.inline_data) {
          base64Image = part.inline_data.data;
          mimeType = part.inline_data.mime_type || part.inline_data.mimeType || 'image/png';
          break;
        }
      }

      if (!base64Image) {
        console.error('[Vertex-NanoBananaMerge] No image data found in response');
        return {
          Success: false,
          Message: 'Vertex AI Gemini API did not return an image in the response',
          StatusCode: 500,
          Error: 'No inline_data found in response parts',
          Debug: debugInfo,
        };
      }

      const binaryString = atob(base64Image);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const resultKey = `results/merge_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.${mimeType.split('/')[1] || 'png'}`;
      
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
      
      const resultImageUrl = `r2://${resultKey}`;

      const sanitizedData = JSON.parse(JSON.stringify(data, (key, value) => {
        if (key === 'data' && typeof value === 'string' && value.length > 100) {
          return '...';
        }
        return value;
      }));

      const sanitizedRequestBodyForCurl = JSON.parse(JSON.stringify(requestBody, (key, value) => {
        if (key === 'data' && typeof value === 'string' && value.length > 100) {
          return '...';
        }
        return value;
      }));

      const curlCommandFinal = `curl -X POST \\
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  ${geminiEndpoint} \\
  -d '${JSON.stringify(sanitizedRequestBodyForCurl, null, 2).replace(/'/g, "'\\''")}'`;
      if (debugInfo) {
        debugInfo.requestPayload = sanitizedRequestBodyForCurl;
        debugInfo.curlCommand = curlCommandFinal;
        debugInfo.response = sanitizedData;
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
      console.error('[Vertex-NanoBananaMerge] JSON parse error:', parseError instanceof Error ? parseError.message.substring(0, 200) : String(parseError).substring(0, 200));
      if (debugInfo) {
        debugInfo.rawResponse = rawResponse.substring(0, 200);
        debugInfo.parseError = parseError instanceof Error ? parseError.message : String(parseError);
      }
      return {
        Success: false,
        Message: `Failed to parse Vertex AI Gemini API response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        StatusCode: 500,
        Error: rawResponse.substring(0, 200),
        Debug: debugInfo,
      };
    }
  } catch (error) {
    console.error('[Vertex-NanoBananaMerge] Unexpected error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
    const debugPayload = debugInfo;
    if (debugPayload) {
      debugPayload.error = error instanceof Error ? error.message : String(error);
    }
    return {
      Success: false,
      Message: `Vertex AI merge request failed: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
      Error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200),
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
      console.error('[SafeSearch] API returned error:', errorMsg);
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
    console.error('[SafeSearch] Exception:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
    return { isSafe: false, error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200) };
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
      console.error('[Vertex] ERROR: GOOGLE_VERTEX_PROJECT_ID is required');
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
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      );
      } catch (tokenError) {
      console.error('[Vertex] Failed to get OAuth token:', tokenError instanceof Error ? tokenError.message.substring(0, 200) : String(tokenError).substring(0, 200));
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
      console.error('[Vertex] API error:', response.status, response.statusText);
      return { 
        success: false, 
        error: `Vertex AI API error: ${response.status} ${response.statusText}`,
        debug: debugInfo
      };
    }

    const data = await response.json() as any;
    debugInfo.responseStructure = JSON.stringify(data).substring(0, 200);

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
            console.warn('[Vertex] Failed to parse JSON from text:', parseError instanceof Error ? parseError.message.substring(0, 200) : String(parseError).substring(0, 200));
          }
        }
      }
    }

    if (!promptJson) {
      console.error('[Vertex] Could not extract JSON from response parts');
      debugInfo.errorDetails = 'Could not extract valid JSON from response parts';
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
      return { success: false, error: `Missing required keys: ${missingKeys.join(', ')}` };
    }

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
    const apiEndpoint = 'https://api.wavespeed.ai/api/v3/wavespeed-ai/image-upscaler';
    
    debugInfo = {
      endpoint: apiEndpoint,
      model: 'wavespeed-ai/image-upscaler',
      imageUrl,
    };

    const requestBody = {
      enable_base64_output: false,
      enable_sync_mode: false,
      image: imageUrl,
      output_format: 'jpeg',
      target_resolution: '4k'
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
        debugInfo.rawResponse = JSON.parse(JSON.stringify(data, (key, value) => {
          if (key === 'data' && typeof value === 'string' && value.length > 100) {
            return '...';
          }
          return value;
        }));
      }
      
      let resultImageUrl: string | null = null;
      let requestId: string | null = null;
      
      requestId = data.id || data.requestId || data.request_id || data.data?.id || data.data?.requestId || data.data?.request_id;
      
      if (!requestId) {
        console.error('[Upscaler4K] No requestId found in response');
        return {
          Success: false,
          Message: 'WaveSpeed API did not return a request ID',
          StatusCode: 500,
          Error: 'No requestId in response',
          Debug: debugInfo,
        };
      }
      
      const resultEndpoint = `https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`;
      
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const resultResponse = await fetch(resultEndpoint, {
          headers: {
            'Authorization': `Bearer ${apiKey}`
          }
        });
        
        if (!resultResponse.ok) {
          console.warn('[Upscaler4K] Poll request failed:', resultResponse.status, resultResponse.statusText);
          if (attempt === 29) {
            throw new Error(`Failed to get result: ${resultResponse.status} ${resultResponse.statusText}`);
          }
          continue;
        }
        
        const resultData: any = await resultResponse.json();
        
        const pollStatus = resultData.status || resultData.data?.status;
        
        if (pollStatus === 'completed' || pollStatus === 'succeeded' || pollStatus === 'success' || pollStatus === 'succeeded') {
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
        throw new Error('Upscaling timed out - no result after 30 polling attempts');
      }


      let imageBytes: Uint8Array;
      let contentType = 'image/png';
      
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
      console.error('[Upscaler4K] JSON parse error:', parseError instanceof Error ? parseError.message.substring(0, 200) : String(parseError).substring(0, 200));
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

