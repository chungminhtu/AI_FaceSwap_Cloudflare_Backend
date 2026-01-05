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
  if (!body || typeof body !== 'object') {
    return 'Invalid request body: must be a JSON object';
  }
  
  const hasPresetId = body.preset_image_id && typeof body.preset_image_id === 'string' && body.preset_image_id.trim() !== '';
  const hasPresetUrl = body.preset_image_url && typeof body.preset_image_url === 'string' && body.preset_image_url.trim() !== '';
  if (!hasPresetId && !hasPresetUrl) {
    return 'Missing required field: preset_image_id or preset_image_url';
  }
  if (hasPresetId && hasPresetUrl) {
    return 'Cannot provide both preset_image_id and preset_image_url. Please provide only one.';
  }
  const hasSelfieIds = Array.isArray(body.selfie_ids) && body.selfie_ids.length > 0;
  const hasSelfieUrls = Array.isArray(body.selfie_image_urls) && body.selfie_image_urls.length > 0;
  if (!hasSelfieIds && !hasSelfieUrls) {
    return 'Missing required field: selfie_ids or selfie_image_urls (must be a non-empty array)';
  }
  if (!body.profile_id || typeof body.profile_id !== 'string' || body.profile_id.trim() === '') {
    return 'Missing required field: profile_id (must be a non-empty string)';
  }
  return null;
};

