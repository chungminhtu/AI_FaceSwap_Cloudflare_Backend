import type { Env, FaceSwapResponse, SafeSearchResult, GoogleVisionResponse } from './types';
import { isUnsafe } from './utils';

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
    return data as FaceSwapResponse;
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

export const checkSafeSearch = async (
  imageUrl: string,
  env: Env
): Promise<SafeSearchResult> => {
  try {
    const response = await fetch(`${env.GOOGLE_VISION_ENDPOINT}?key=${env.GOOGLE_CLOUD_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { source: { imageUri: imageUrl } },
          features: [{ type: 'SAFE_SEARCH_DETECTION', maxResults: 1 }],
        }],
      }),
    });

    if (!response.ok) {
      return { isSafe: false, error: `API error: ${response.status}` };
    }

    const data = await response.json() as GoogleVisionResponse;
    const annotation = data.responses?.[0]?.safeSearchAnnotation;

    if (data.responses?.[0]?.error) {
      return { isSafe: false, error: data.responses[0].error.message };
    }

    if (!annotation) {
      return { isSafe: false, error: 'No safe search annotation' };
    }

    return { isSafe: !isUnsafe(annotation) };
  } catch (error) {
    return { isSafe: false, error: error instanceof Error ? error.message : String(error) };
  }
};

