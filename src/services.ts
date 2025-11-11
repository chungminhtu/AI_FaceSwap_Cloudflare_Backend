import type { FaceSwapResponse, SafeSearchResult, GoogleVisionResponse } from './types';
import { getConfig } from './config';
import { isUnsafe } from './utils';

type Config = ReturnType<typeof getConfig>;
type RapidApiConfig = Config['rapidApi'];
type GoogleVisionConfig = Config['googleVision'];

export const callFaceSwap = async (
  targetUrl: string,
  sourceUrl: string,
  config: RapidApiConfig
): Promise<FaceSwapResponse> => {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': config.host,
      'x-rapidapi-key': config.key,
    },
    body: JSON.stringify({ TargetImageUrl: targetUrl, SourceImageUrl: sourceUrl }),
  });

  if (!response.ok) {
    return {
      Success: false,
      Message: `FaceSwap API error: ${response.status} ${response.statusText}`,
      StatusCode: response.status,
      Error: await response.text(),
    };
  }

  return await response.json();
};

export const checkSafeSearch = async (
  imageUrl: string,
  config: GoogleVisionConfig
): Promise<SafeSearchResult> => {
  try {
    const endpoint = config.projectId
      ? `https://vision.googleapis.com/v1/projects/${config.projectId}/locations/global/images:annotate`
      : config.endpoint;

    const response = await fetch(`${endpoint}?key=${config.key}`, {
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

