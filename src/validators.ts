import type { Env, FaceSwapRequest } from './types';

export const validateEnv = (env: Env, mode: 'rapidapi' | 'vertex' = 'rapidapi'): string | null => {
  if (mode !== 'vertex') {
  if (!env.RAPIDAPI_KEY) return 'RAPIDAPI_KEY not set';
  if (!env.RAPIDAPI_HOST) return 'RAPIDAPI_HOST not set';
  if (!env.RAPIDAPI_ENDPOINT) return 'RAPIDAPI_ENDPOINT not set';
  }

  // Vertex AI mode uses GOOGLE_VERTEX_API_KEY and GOOGLE_VERTEX_PROJECT_ID
  // No separate Nano Banana API required - uses Vertex AI endpoint directly

  // Vision API key (for SafeSearch)
  if (!env.GOOGLE_VISION_API_KEY) return 'GOOGLE_VISION_API_KEY not set';
  if (!env.GOOGLE_VISION_ENDPOINT) return 'GOOGLE_VISION_ENDPOINT not set';
  
  // Vertex AI credentials (for prompt generation)
  if (!env.GOOGLE_VERTEX_API_KEY) return 'GOOGLE_VERTEX_API_KEY not set';
  if (!env.GOOGLE_VERTEX_PROJECT_ID) return 'GOOGLE_VERTEX_PROJECT_ID not set';

  return null;
};

export const validateRequest = (body: any, mode: 'rapidapi' | 'vertex' = 'rapidapi'): string | null => {
  if (!body?.target_url || !body?.source_url) {
    return 'Missing required fields: target_url and source_url';
  }
  if (mode === 'vertex' && !body?.preset_image_id) {
    return 'Missing preset_image_id for Vertex AI mode';
  }
  return null;
};

