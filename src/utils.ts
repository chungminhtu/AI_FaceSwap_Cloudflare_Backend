// Safety levels from Google Vision API
export const SAFETY_LEVELS = {
  VERY_UNLIKELY: 'VERY_UNLIKELY',
  UNLIKELY: 'UNLIKELY',
  POSSIBLE: 'POSSIBLE',
  LIKELY: 'LIKELY',
  VERY_LIKELY: 'VERY_LIKELY',
} as const;

// Default: Only block VERY_LIKELY (lenient mode)
// Strict mode: Block both LIKELY and VERY_LIKELY
export const getUnsafeLevels = (strictness: 'strict' | 'lenient' = 'lenient'): string[] => {
  if (strictness === 'strict') {
    return [SAFETY_LEVELS.LIKELY, SAFETY_LEVELS.VERY_LIKELY];
  }
  // lenient (default): only block VERY_LIKELY
  return [SAFETY_LEVELS.VERY_LIKELY];
};

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

export const isUnsafe = (
  annotation: { adult: string; violence: string; racy: string },
  strictness: 'strict' | 'lenient' = 'lenient'
): boolean => {
  const unsafeLevels = getUnsafeLevels(strictness);
  return (
    unsafeLevels.includes(annotation.adult) ||
    unsafeLevels.includes(annotation.violence) ||
    unsafeLevels.includes(annotation.racy)
  );
};

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
