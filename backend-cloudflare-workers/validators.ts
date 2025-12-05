import type { Env, FaceSwapRequest } from './types';

export const validateEnv = (env: Env, mode: 'rapidapi' | 'vertex' = 'rapidapi'): string | null => {
  if (mode !== 'vertex') {
  if (!env.RAPIDAPI_KEY) return 'RAPIDAPI_KEY not set';
  if (!env.RAPIDAPI_HOST) return 'RAPIDAPI_HOST not set';
  if (!env.RAPIDAPI_ENDPOINT) return 'RAPIDAPI_ENDPOINT not set';
  }

  // Vertex AI mode uses OAuth tokens from service account (GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)
  // No separate Nano Banana API required - uses Vertex AI endpoint directly

  // Vision API key (for SafeSearch)
  if (!env.GOOGLE_VISION_API_KEY) return 'GOOGLE_VISION_API_KEY not set';
  if (!env.GOOGLE_VISION_ENDPOINT) return 'GOOGLE_VISION_ENDPOINT not set';
  
  // Vertex AI credentials (for prompt generation and image generation)
  // Uses OAuth tokens from service account, not API keys
  if (!env.GOOGLE_VERTEX_PROJECT_ID) return 'GOOGLE_VERTEX_PROJECT_ID not set';

  return null;
};

export const validateRequest = (body: any): string | null => {
  if (!body?.preset_image_id) {
    return 'Missing required field: preset_image_id';
  }
  if (!body?.selfie_id) {
    return 'Missing required field: selfie_id';
  }
  return null;
};

