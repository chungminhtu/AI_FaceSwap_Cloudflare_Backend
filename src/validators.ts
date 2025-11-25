import type { Env, FaceSwapRequest } from './types';

export const validateEnv = (env: Env, mode: 'rapidapi' | 'gemini' = 'rapidapi'): string | null => {
  if (mode !== 'gemini') {
  if (!env.RAPIDAPI_KEY) return 'RAPIDAPI_KEY not set';
  if (!env.RAPIDAPI_HOST) return 'RAPIDAPI_HOST not set';
  if (!env.RAPIDAPI_ENDPOINT) return 'RAPIDAPI_ENDPOINT not set';
  }

  // Gemini mode uses GOOGLE_GEMINI_API_KEY (same as prompt generation)
  // No separate Nano Banana API required - uses Gemini endpoint directly

  // Vision API key (for SafeSearch)
  if (!env.GOOGLE_VISION_API_KEY) return 'GOOGLE_VISION_API_KEY not set';
  if (!env.GOOGLE_VISION_ENDPOINT) return 'GOOGLE_VISION_ENDPOINT not set';
  
  // Gemini API key (for prompt generation)
  if (!env.GOOGLE_GEMINI_API_KEY) return 'GOOGLE_GEMINI_API_KEY not set';

  return null;
};

export const validateRequest = (body: any, mode: 'rapidapi' | 'gemini' = 'rapidapi'): string | null => {
  if (!body?.target_url || !body?.source_url) {
    return 'Missing required fields: target_url and source_url';
  }
  if (mode === 'gemini' && !body?.preset_image_id) {
    return 'Missing preset_image_id for Gemini mode';
  }
  return null;
};

