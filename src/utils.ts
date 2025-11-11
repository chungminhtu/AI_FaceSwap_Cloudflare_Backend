export const UNSAFE_LEVELS = ['LIKELY', 'VERY_LIKELY'];

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
