import type { Env, FaceSwapRequest } from './types';

export const validateEnv = (env: Env): string | null => {
  if (!env.RAPIDAPI_KEY) return 'RAPIDAPI_KEY not set';
  if (!env.GOOGLE_CLOUD_API_KEY) return 'GOOGLE_CLOUD_API_KEY not set';
  return null;
};

export const validateRequest = (body: any): string | null => {
  if (!body?.TargetImageUrl || !body?.SourceImageUrl) {
    return 'Missing required fields: TargetImageUrl and SourceImageUrl';
  }
  return null;
};

