import type { Env } from './types';

export const UNSAFE_LEVELS = ['LIKELY', 'VERY_LIKELY'];

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const DEFAULT_RAPIDAPI_HOST = 'faceswap-image-transformation-api.p.rapidapi.com';
export const DEFAULT_RAPIDAPI_ENDPOINT = 'https://faceswap-image-transformation-api.p.rapidapi.com/faceswap';
export const DEFAULT_GOOGLE_VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

export const getConfig = (env: Env) => ({
  rapidApi: {
    host: env.RAPIDAPI_HOST || DEFAULT_RAPIDAPI_HOST,
    endpoint: env.RAPIDAPI_ENDPOINT || DEFAULT_RAPIDAPI_ENDPOINT,
    key: env.RAPIDAPI_KEY,
  },
  googleVision: {
    endpoint: env.GOOGLE_VISION_ENDPOINT || DEFAULT_GOOGLE_VISION_ENDPOINT,
    projectId: env.GOOGLE_CLOUD_PROJECT_ID,
    key: env.GOOGLE_CLOUD_API_KEY,
  },
});

