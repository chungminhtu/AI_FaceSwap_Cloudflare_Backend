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
  if (!env.NANO_BANANA_API_URL || !env.NANO_BANANA_API_KEY) {
    return {
      Success: false,
      Message: 'Nano Banana provider not configured. Please set NANO_BANANA_API_URL and NANO_BANANA_API_KEY.',
      StatusCode: 500,
    };
  }

  try {
    const response = await fetch(env.NANO_BANANA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.NANO_BANANA_API_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        target_url: targetUrl,
        source_url: sourceUrl,
      }),
    });

    const rawResponse = await response.text();

    if (!response.ok) {
      return {
        Success: false,
        Message: `Nano Banana API error: ${response.status} ${response.statusText}`,
        StatusCode: response.status,
        Error: rawResponse.substring(0, 500),
      };
    }

    try {
      const data = JSON.parse(rawResponse);

      const result: FaceSwapResponse = {
        Success: data.Success === true || data.success === true,
        ResultImageUrl: data.ResultImageUrl || data.result_url || data.file_url,
        Message: data.Message || data.message || 'Nano Banana generation completed',
        StatusCode: response.status,
        ProcessingTime: data.ProcessingTime?.toString() || data.processing_time?.toString(),
      };

      if (!result.Success || !result.ResultImageUrl) {
        result.Success = false;
        result.Message = result.Message || 'Nano Banana API did not return a result image URL';
        result.Error = rawResponse.substring(0, 500);
      }

      return result;
    } catch (parseError) {
      return {
        Success: false,
        Message: 'Failed to parse Nano Banana API response',
        StatusCode: 500,
        Error: rawResponse.substring(0, 500),
      };
    }
  } catch (error) {
    return {
      Success: false,
      Message: `Nano Banana request failed: ${error instanceof Error ? error.message : String(error)}`,
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

    const prompt = `Analyze the provided image and return a detailed description of its contents, pose, clothing, environment, HDR lighting, style, and composition in a strict JSON format. Generate a JSON object with the following keys: "prompt", "style", "lighting", "composition", "camera", and "background". For the "prompt" key, write a detailed HDR scene description based on the target image, including the character’s pose, outfit, environment, atmosphere, and visual mood. In the "prompt" field, also include this exact face-swap rule: “Replace the original face with the face from the image I will upload later; the final face must look exactly like the face in my uploaded image. Do not alter the facial structure, identity, age, or ethnicity, and preserve all distinctive facial features. Makeup, lighting, and color grading may be adjusted only to match the HDR visual look of the target scene.” The generated prompt must be fully compliant with Google Play Store content policies: the description must not contain any sexual, explicit, suggestive, racy, erotic, fetish, or adult content; no exposed sensitive body areas; no provocative wording or implications; and the entire scene must remain wholesome, respectful, and appropriate for all audiences. The JSON should fully describe the image and follow the specified structure, without any extra commentary or text outside the JSON.`;

    const requestBody = {
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: await fetchImageAsBase64(imageUrl)
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        topK: 1,
        topP: 1,
        maxOutputTokens: 2048,
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

    const parts = data.candidates?.[0]?.content?.parts;
    const responseText = parts?.find((part: any) => typeof part.text === 'string')?.text;

    if (!responseText) {
      return { success: false, error: 'No response from Gemini API' };
    }

    // Extract JSON from the response (Gemini might wrap it in markdown fences)
    let jsonText = responseText;
    if (responseText.includes('```json')) {
      const jsonMatch = responseText.match(/```json\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        jsonText = jsonMatch[1];
      }
    } else if (responseText.includes('```')) {
      const jsonMatch = responseText.match(/```\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        jsonText = jsonMatch[1];
      }
    }

    try {
      const promptJson = JSON.parse(jsonText);

      // Validate required keys
      const requiredKeys = ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'];
      const missingKeys = requiredKeys.filter(key => !promptJson[key]);

      if (missingKeys.length > 0) {
        return { success: false, error: `Missing required keys: ${missingKeys.join(', ')}` };
      }

      console.log('[Gemini] Generated prompt successfully');
      return { success: true, prompt: promptJson };

    } catch (parseError) {
      console.error('[Gemini] JSON parse error:', parseError, 'Raw response:', responseText);
      return { success: false, error: 'Failed to parse JSON from Gemini response' };
    }

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

