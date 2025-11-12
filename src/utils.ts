export const UNSAFE_LEVELS = ['LIKELY', 'VERY_LIKELY'];

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Preset-Name, X-Preset-Name-Encoded',
};

export const jsonResponse = (data: any, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });

export const errorResponse = (message: string, status = 500): Response =>
  jsonResponse({ Success: false, Message: message, StatusCode: status }, status);

export const isUnsafe = (annotation: { adult: string; violence: string; racy: string }): boolean =>
  UNSAFE_LEVELS.includes(annotation.adult) ||
  UNSAFE_LEVELS.includes(annotation.violence) ||
  UNSAFE_LEVELS.includes(annotation.racy);

// Base64 URL encoding (for JWT)
export const base64UrlEncode = (str: string): string => {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
};

// Base64 decode
export const base64Decode = (str: string): string => {
  return atob(str);
};
