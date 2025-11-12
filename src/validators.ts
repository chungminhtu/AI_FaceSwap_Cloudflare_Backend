import type { Env, FaceSwapRequest } from './types';
import { base64Decode } from './utils';

export const validateEnv = (env: Env): string | null => {
  if (!env.RAPIDAPI_KEY) return 'RAPIDAPI_KEY not set';
  if (!env.RAPIDAPI_HOST) return 'RAPIDAPI_HOST not set';
  if (!env.RAPIDAPI_ENDPOINT) return 'RAPIDAPI_ENDPOINT not set';
  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY) return 'GOOGLE_SERVICE_ACCOUNT_KEY not set';
  if (!env.GOOGLE_VISION_ENDPOINT) return 'GOOGLE_VISION_ENDPOINT not set';

  // Validate service account key format
  try {
    const decoded = base64Decode(env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const serviceAccount = JSON.parse(decoded);
    
    if (!serviceAccount.client_email) {
      return 'GOOGLE_SERVICE_ACCOUNT_KEY missing client_email field';
    }
    if (!serviceAccount.private_key) {
      return 'GOOGLE_SERVICE_ACCOUNT_KEY missing private_key field';
    }
    if (!serviceAccount.project_id) {
      return 'GOOGLE_SERVICE_ACCOUNT_KEY missing project_id field';
    }
  } catch (error) {
    return `GOOGLE_SERVICE_ACCOUNT_KEY is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }

  return null;
};

export const validateRequest = (body: any): string | null => {
  if (!body?.target_url || !body?.source_url) {
    return 'Missing required fields: target_url and source_url';
  }
  return null;
};

