import type { Env, FaceSwapRequest } from './types';

export const validateEnv = (env: Env): string | null => {
  if (!env.RAPIDAPI_KEY) return 'RAPIDAPI_KEY not set';
  if (!env.RAPIDAPI_HOST) return 'RAPIDAPI_HOST not set';
  if (!env.RAPIDAPI_ENDPOINT) return 'RAPIDAPI_ENDPOINT not set';
  if (!env.GOOGLE_CLOUD_API_KEY) return 'GOOGLE_CLOUD_API_KEY not set';
  if (!env.GOOGLE_VISION_ENDPOINT) return 'GOOGLE_VISION_ENDPOINT not set';
  return null;
};

export const validateRequest = (body: any): string | null => {
  if (!body?.target_url || !body?.source_url) {
    return 'Missing required fields: target_url and source_url';
  }
  return null;
};

