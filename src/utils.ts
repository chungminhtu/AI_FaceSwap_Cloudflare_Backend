// Safety violation status codes (1000+)
export const SAFETY_STATUS_CODES = {
  ADULT: 1001,
  VIOLENCE: 1002,
  RACY: 1003,
  MEDICAL: 1004,
  SPOOF: 1005,
} as const;

// Severity levels (higher = worse)
const SEVERITY_LEVELS: Record<string, number> = {
  VERY_UNLIKELY:-1,
  UNLIKELY: 0,
  POSSIBLE: 1,
  LIKELY: 2,
  VERY_LIKELY: 3,
};

// Get severity number for a level
function getSeverity(level: string): number {
  return SEVERITY_LEVELS[level] || 0;
}

// Default: Only block VERY_LIKELY (lenient mode)
// Strict mode: Block both LIKELY and VERY_LIKELY
export const getUnsafeLevels = (strictness: 'strict' | 'lenient' = 'lenient'): string[] => {
  if (strictness === 'strict') {
    return ['LIKELY', 'VERY_LIKELY'];
  }
  // lenient (default): only block VERY_LIKELY
  return ['VERY_LIKELY'];
};

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Preset-Name, X-Preset-Name-Encoded, X-Enable-Gemini-Prompt, Authorization',
  'Access-Control-Allow-Credentials': 'true',
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

// Find the worst violation and return status code
// Returns { code: number, category: string, level: string } or null if safe
export const getWorstViolation = (annotation: {
  adult: string;
  violence: string;
  racy: string;
  medical?: string;
  spoof?: string;
}): { code: number; category: string; level: string } | null => {
  const violations: Array<{ category: string; level: string; severity: number; code: number }> = [];
  const concerningLevels = ['POSSIBLE', 'LIKELY', 'VERY_LIKELY'];

  // Define category mappings
  const categories = [
    { key: 'adult', code: SAFETY_STATUS_CODES.ADULT },
    { key: 'violence', code: SAFETY_STATUS_CODES.VIOLENCE },
    { key: 'racy', code: SAFETY_STATUS_CODES.RACY },
    { key: 'medical', code: SAFETY_STATUS_CODES.MEDICAL },
    { key: 'spoof', code: SAFETY_STATUS_CODES.SPOOF },
  ];

  // Check each category
  for (const { key, code } of categories) {
    const level = annotation[key as keyof typeof annotation];
    if (level && concerningLevels.includes(level)) {
      violations.push({
        category: key,
        level,
        severity: getSeverity(level),
        code,
      });
    }
  }

  if (violations.length === 0) {
    return null; // No violations
  }

  // Find the worst violation (highest severity)
  const worst = violations.reduce((prev, current) =>
    current.severity > prev.severity ? current : prev
  );

  return {
    code: worst.code,
    category: worst.category,
    level: worst.level,
  };
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

// Generate JWT token for Google service account authentication
export async function generateJWT(
  serviceAccountEmail: string,
  privateKey: string,
  scope: string = 'https://www.googleapis.com/auth/cloud-platform'
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, // 1 hour
    iat: now,
    scope: scope,
  };

  // Encode header and payload
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  // Import private key and sign
  // Clean up the private key (remove newlines and headers)
  const privateKeyPEM = privateKey.replace(/\\n/g, '\n').trim();
  
  // Extract the base64 key data
  const keyData = privateKeyPEM
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  
  // Decode base64 to binary
  const binaryString = atob(keyData);
  const keyBuffer = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    keyBuffer[i] = binaryString.charCodeAt(i);
  }
  
  // Import the key in PKCS8 format
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      keyBuffer,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );
  } catch (error) {
    throw new Error(`Failed to import private key: ${error instanceof Error ? error.message : String(error)}. Make sure the private key is in PKCS8 format.`);
  }

  // Sign the signature input
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signatureInput)
  );

  // Encode signature to base64url
  const signatureArray = new Uint8Array(signature);
  const signatureBase64 = btoa(String.fromCharCode(...signatureArray));
  const encodedSignature = signatureBase64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${signatureInput}.${encodedSignature}`;
}

// Exchange JWT for OAuth access token
export async function getAccessToken(
  serviceAccountEmail: string,
  privateKey: string,
  scope: string = 'https://www.googleapis.com/auth/cloud-platform'
): Promise<string> {
  const jwt = await generateJWT(serviceAccountEmail, privateKey, scope);
  
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}
