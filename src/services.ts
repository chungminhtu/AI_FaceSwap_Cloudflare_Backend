import type { Env, FaceSwapResponse, SafeSearchResult, GoogleVisionResponse } from './types';
import { isUnsafe, getWorstViolation } from './utils';

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
  // Use Gemini API key (same as prompt generation)
  const apiKey = env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    return {
      Success: false,
      Message: 'GOOGLE_GEMINI_API_KEY not set',
      StatusCode: 500,
    };
  }

  try {
    const geminiModel = 'models/gemini-2.5-flash';
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/${geminiModel}:generateContent`;

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

    // Only use the stored prompt_json text - no images sent
    // The prompt_json already contains the full scene description from the preset image
    console.log('[Gemini-NanoBanana] Using stored prompt_json text only (no images)');
    console.log('[Gemini-NanoBanana] Prompt length:', promptText.length);

    // Call Gemini API with ONLY the stored prompt text (no images)
    const requestBody = {
      contents: [{
        parts: [
          { text: promptText }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        topK: 1,
        topP: 1,
        maxOutputTokens: 2048,
      }
    };

    // Call Gemini API with only text (no images)
    const response = await fetch(geminiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(requestBody),
    });

    const rawResponse = await response.text();
    console.log('[Gemini-NanoBanana] Response status:', response.status);

    if (!response.ok) {
      console.error('[Gemini-NanoBanana] API error:', rawResponse.substring(0, 500));
      return {
        Success: false,
        Message: `Gemini API error: ${response.status} ${response.statusText}`,
        StatusCode: response.status,
        Error: rawResponse.substring(0, 500),
      };
    }

    try {
      const data = JSON.parse(rawResponse);

      // Gemini API returns text, not image URLs
      // Check if response contains image data or URL
      const parts = data.candidates?.[0]?.content?.parts || [];
      
      // Look for image data in response (if Gemini returns images)
      let resultImageUrl: string | undefined;
      let resultMessage = 'Gemini face swap completed';

      // Try to extract image from response
      for (const part of parts) {
        if (part.inline_data?.data) {
          // If Gemini returns base64 image data, we'd need to upload it to R2 first
          // For now, return error indicating Gemini doesn't generate images directly
          return {
            Success: false,
            Message: 'Gemini API does not generate images directly. It only returns text descriptions. Please use a proper image generation API.',
            StatusCode: 501,
            Error: 'Gemini generateContent endpoint returns text, not images',
          };
        }
        if (part.text) {
          resultMessage = part.text;
        }
      }

      // Check if there's a URL in the text response
      const urlMatch = resultMessage.match(/https?:\/\/[^\s]+\.(?:jpg|jpeg|png|webp)/i);
      if (urlMatch) {
        resultImageUrl = urlMatch[0];
      }

      const result: FaceSwapResponse = {
        Success: !!resultImageUrl,
        ResultImageUrl: resultImageUrl,
        Message: resultMessage || 'Gemini generation completed',
        StatusCode: response.status,
      };

      if (!result.Success || !result.ResultImageUrl) {
        result.Success = false;
        result.Message = 'Gemini API did not return an image URL. Gemini generateContent returns text descriptions, not images.';
        result.Error = 'Use a proper image generation service for face swap operations.';
      }

      return result;
    } catch (parseError) {
      return {
        Success: false,
        Message: 'Failed to parse Gemini API response',
        StatusCode: 500,
        Error: rawResponse.substring(0, 500),
      };
    }
  } catch (error) {
    return {
      Success: false,
      Message: `Gemini face swap request failed: ${error instanceof Error ? error.message : String(error)}`,
      StatusCode: 500,
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
      return { isSafe: false, error: data.responses[0].error.message };
    }

    if (!annotation) {
      console.warn('[SafeSearch] No safe search annotation in response');
      return { isSafe: false, error: 'No safe search annotation' };
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
      details: annotation // Return full safeSearchAnnotation details
    };
  } catch (error) {
    console.error('[SafeSearch] Exception:', error);
    return { isSafe: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// Google Gemini API integration for automatic prompt generation
export const generateGeminiPrompt = async (
  imageUrl: string,
  env: Env
): Promise<{ success: boolean; prompt?: any; error?: string }> => {
  try {
    // TEMPORARY TEST MODE: If Gemini API fails with location error, provide test response
    // This allows testing the database storage/retrieval logic while you resolve API key location issues
    const useTestMode = env.GEMINI_TEST_MODE === 'true';

    // Use Gemini API key (separate from Vision)
    const apiKey = env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      return { success: false, error: 'GOOGLE_GEMINI_API_KEY not set' };
    }

    const geminiModel = 'models/gemini-2.5-flash';
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/${geminiModel}:generateContent`;
    const referer = env.GEMINI_REFERER || 'https://ai-faceswap-frontend.pages.dev/';
    const origin = referer.endsWith('/') ? referer.slice(0, -1) : referer;

    // Exact prompt text as specified by user
    const prompt = `Analyze the provided image and return a detailed description of its contents, pose, clothing, environment, HDR lighting, style, and composition in a strict JSON format. Generate a JSON object with the following keys: "prompt", "style", "lighting", "composition", "camera", and "background". For the "prompt" key, write a detailed HDR scene description based on the target image, including the character's pose, outfit, environment, atmosphere, and visual mood. In the "prompt" field, also include this exact face-swap rule: "Replace the original face with the face from the image I will upload later; the final face must look exactly like the face in my uploaded image. Do not alter the facial structure, identity, age, or ethnicity, and preserve all distinctive facial features. Makeup, lighting, and color grading may be adjusted only to match the HDR visual look of the target scene." The generated prompt must be fully compliant with Google Play Store content policies: the description must not contain any sexual, explicit, suggestive, racy, erotic, fetish, or adult content; no exposed sensitive body areas; no provocative wording or implications; and the entire scene must remain wholesome, respectful, and appropriate for all audiences. The JSON should fully describe the image and follow the specified structure, without any extra commentary or text outside the JSON.`;

    // Fetch image as base64
    const imageData = await fetchImageAsBase64(imageUrl);

    // Build request body following official Gemini REST API format
    const requestBody = {
      contents: [{
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

    const response = await fetch(geminiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Referer': referer,
        'Origin': origin
      },
      body: JSON.stringify(requestBody),
    });

            if (!response.ok) {
              const errorText = await response.text();

              // TEMPORARY: If location error and test mode enabled, provide test response
              if (useTestMode && errorText.includes('User location is not supported')) {
                console.log('[Gemini-TEST] Location error detected, providing test response');
                return {
                  success: true,
                  prompt: {
                    prompt: "A beautiful young woman with long dark hair, wearing a professional business suit, standing in a modern office with city skyline visible through large windows. HDR lighting with golden hour sunlight casting soft shadows, cinematic composition with shallow depth of field. Replace the original face with the face from the image I will upload later; the final face must look exactly like the face in my uploaded image. Do not alter the facial structure, identity, age, or ethnicity, and preserve all distinctive facial features. Makeup, lighting, and color grading may be adjusted only to match the HDR visual look of the target scene.",
                    style: "Photorealistic, cinematic, high detail",
                    lighting: "Golden hour HDR with soft rim lighting and natural shadows",
                    composition: "Portrait orientation, centered subject with office background",
                    camera: "85mm lens, f/1.8 aperture, professional DSLR",
                    background: "Modern corporate office with floor-to-ceiling windows showing city skyline"
                  }
                };
              }

              return { success: false, error: `Gemini API error: ${response.status} ${errorText}` };
            }

    const data = await response.json();
    console.log('[Gemini] Response structure:', JSON.stringify(data).substring(0, 300));

    // With structured outputs (responseMimeType: "application/json"), Gemini returns JSON directly
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      return { success: false, error: 'No response parts from Gemini API' };
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
            console.warn('[Gemini] Failed to parse JSON from text:', parseError);
          }
        }
      }
    }

    if (!promptJson) {
      console.error('[Gemini] Could not extract JSON from response. Parts:', JSON.stringify(parts));
      return { success: false, error: 'No valid JSON response from Gemini API' };
    }

    // Validate required keys
    const requiredKeys = ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'];
    const missingKeys = requiredKeys.filter(key => !promptJson[key] || promptJson[key] === '');

    if (missingKeys.length > 0) {
      console.error('[Gemini] Missing required keys:', missingKeys);
      console.error('[Gemini] Received JSON:', JSON.stringify(promptJson));
      return { success: false, error: `Missing required keys: ${missingKeys.join(', ')}` };
    }

    console.log('[Gemini] Generated prompt successfully with all required keys');
    console.log('[Gemini] Prompt preview:', promptJson.prompt?.substring(0, 200));
    return { success: true, prompt: promptJson };

  } catch (error) {
    console.error('[Gemini] Exception:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
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

