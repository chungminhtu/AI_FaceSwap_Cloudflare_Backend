// backend-cloudflare-workers/utils.ts
import type { Env } from './types';

// Safety violation status codes (1000+) Loại nhạy cảm
export const SAFETY_STATUS_CODES = {
  ADULT: 1001, // Ảnh người lớn, nude, gợi dục, porn, ...
  VIOLENCE: 1002, // Ảnh bạo lực, chiến tranh, tử vong, ...
  RACY: 1003, // Ảnh nhạy cảm sexy, gợi dục, khiêu gợi, ...
  MEDICAL: 1004, // Ảnh máu me, phẫu thuật, y tế, nạn nhân, ...
  SPOOF: 1005, // Lừa bịp, ảnh copy của người khác, ...
} as const;

// Vertex AI safety violation status codes (2000+) - Vertex AI Gemini safety filters
export const VERTEX_SAFETY_STATUS_CODES = {
  HATE_SPEECH: 2001, // Negative or harmful comments targeting identity and/or protected attributes
  HARASSMENT: 2002, // Threatening, intimidating, bullying, or abusive comments targeting another individual
  SEXUALLY_EXPLICIT: 2003, // Contains references to sexual acts or other lewd content
  DANGEROUS_CONTENT: 2004, // Promotes or enables access to harmful goods, services, and activities
} as const;

// Map Vertex AI harm categories to our custom error codes
const VERTEX_HARM_CATEGORY_MAP: Record<string, number> = {
  'HARM_CATEGORY_HATE_SPEECH': VERTEX_SAFETY_STATUS_CODES.HATE_SPEECH,
  'HARM_CATEGORY_HARASSMENT': VERTEX_SAFETY_STATUS_CODES.HARASSMENT,
  'HARM_CATEGORY_SEXUALLY_EXPLICIT': VERTEX_SAFETY_STATUS_CODES.SEXUALLY_EXPLICIT,
  'HARM_CATEGORY_DANGEROUS_CONTENT': VERTEX_SAFETY_STATUS_CODES.DANGEROUS_CONTENT,
};

// Severity levels (higher = worse) Độ nghiêm trọng
const SEVERITY_LEVELS: Record<string, number> = {
  VERY_UNLIKELY:-1, // Không có nội dung nhạy cảm, chắc chắn
  UNLIKELY: 0, // Không có nội dung nhạy cảm, nhưng chưa chắc chắn
  POSSIBLE: 1, // Có thể có nội dung nhạy cảm, nhưng chưa chắc chắn
  LIKELY: 2, // Có nội dung nhạy cảm, chắc chắn
  VERY_LIKELY: 3, // Có nội dung nhạy cảm, chắc chắn
};

// Get severity number for a level
function getSeverity(level: string): number {
  return SEVERITY_LEVELS[level] || 0;
}

// Default: Only block VERY_LIKELY (loose mode)
// Strict mode: Block both LIKELY and VERY_LIKELY
export const getUnsafeLevels = (strictness: 'strict' | 'lenient'): string[] => {
  if (strictness === 'strict') {
    return ['LIKELY', 'VERY_LIKELY'];
  }
  return ['VERY_LIKELY'];
};

export const getCorsHeaders = (request: Request, env: any): Record<string, string> => {
  const origin = request.headers.get('Origin');
  const userAgent = request.headers.get('User-Agent') || '';
  const isMobileApp = userAgent.includes('okhttp') || userAgent.includes('Android') || userAgent.includes('Dart') || !origin;
  
  const allowedOrigins = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o: any) => o.trim()) : [];
  
  let allowOrigin = '*';
  
  if (isMobileApp) {
    allowOrigin = '*';
  } else if (allowedOrigins.length > 0) {
    if (origin && allowedOrigins.includes(origin)) {
      allowOrigin = origin;
    } else if (allowedOrigins.length === 1 && allowedOrigins[0] === '*') {
      allowOrigin = '*';
    } else if (origin && allowedOrigins.includes('*')) {
      allowOrigin = '*';
    } else if (allowedOrigins.length > 0) {
      allowOrigin = allowedOrigins[0];
    }
  }
  
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Preset-Name, X-Preset-Name-Encoded, X-Enable-Vertex-Prompt, X-Enable-Gemini-Prompt, X-Enable-Vision-Scan, X-Gender, Authorization, X-API-Key',
    'Access-Control-Allow-Credentials': 'true',
  };
};

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Preset-Name, X-Preset-Name-Encoded, X-Enable-Vertex-Prompt, X-Enable-Gemini-Prompt, X-Enable-Vision-Scan, X-Gender, Authorization, X-API-Key',
  'Access-Control-Allow-Credentials': 'true',
};

// Vertex AI Configuration
// Supported regions: us-central1, us-east1, us-west1, europe-west1, asia-southeast1, etc.
// Use 'global' for global endpoint (higher availability, no region prefix in URL)
export const VERTEX_AI_DEFAULT_LOCATION = 'us-central1';

export const getVertexAILocation = (env: any): string => {
  const location = env.GOOGLE_VERTEX_LOCATION || VERTEX_AI_DEFAULT_LOCATION;
  return location;
};

export const getVertexModelId = (modelParam?: string | number): string => {
  // Map frontend model parameter to Vertex AI model ID
  // "2.5" or 2.5 => "gemini-2.5-flash-image" (default)
  // "3" or 3 => "gemini-3-pro-image-preview"
  const modelStr = String(modelParam || '2.5').trim();
  if (modelStr === '3') {
    return 'gemini-3-pro-image-preview';
  }
  // Default to 2.5
  return 'gemini-2.5-flash-image';
};

export const getVertexAIEndpoint = (
  projectId: string,
  location: string,
  model: string
): string => {
  // Global endpoint uses different URL format (no region prefix in domain)
  if (location.toLowerCase() === 'global') {
    return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model}:generateContent`;
  }
  
  // Regional endpoint format: https://{location}-aiplatform.googleapis.com/...
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
};

export const jsonResponse = (data: any, status = 200, request?: Request, env?: any): Response => {
  // For 400 and 500 errors, sanitize message field - detailed info only in debug
  if (data && typeof data === 'object' && data.status === 'error' && data.message) {
    if (status === 400) {
      data.message = 'Bad Request';
    } else if (status === 500) {
      data.message = 'Internal Server Error';
    }
  }
  
  const jsonString = JSON.stringify(data);
  const corsHeaders = (request && env) ? getCorsHeaders(request, env) : CORS_HEADERS;
  
  return new Response(jsonString, {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
};

export const errorResponse = (message: string, status = 500, debug?: Record<string, any>, request?: Request, env?: any): Response => {
  // For 400 and 500 errors, always use generic messages - detailed info only in debug
  // Message parameter is ignored for 400/500, only used for other status codes
  let sanitizedMessage: string;
  if (status === 400) {
    sanitizedMessage = 'Bad Request';
  } else if (status === 500) {
    sanitizedMessage = 'Internal Server Error';
  } else {
    sanitizedMessage = message;
  }
  
  return jsonResponse({ 
    data: null,
    status: 'error', 
    message: sanitizedMessage, 
    code: status,
    ...(debug ? { debug } : {})
  }, status, request, env);
};

export const isUnsafe = (
  annotation: { adult: string; violence: string; racy: string },
  strictness: 'strict' | 'lenient'
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
export const validateImageUrl = (url: string, env: any): boolean => {
  try {
    const urlObj = new URL(url);
    
    if (urlObj.protocol !== 'https:') {
      return false;
    }
    
    const hostname = urlObj.hostname.toLowerCase();
    
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return false;
    }
    
    const ipRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipRegex);
    if (match) {
      const parts = match.slice(1).map(Number);
      if (parts[0] === 10) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 127) return false;
    }
    
    const allowedDomains: string[] = [];
    if (env.R2_DOMAIN) {
      try {
        const r2DomainUrl = new URL(env.R2_DOMAIN);
        allowedDomains.push(r2DomainUrl.hostname.toLowerCase());
      } catch (error) {
        console.warn(`[URL Validation] Invalid R2_DOMAIN format: ${env.R2_DOMAIN}`, error);
      }
    }
    
    allowedDomains.push('.r2.cloudflarestorage.com');
    allowedDomains.push('.r2.dev');
    
    const isAllowed = allowedDomains.some(domain => 
      hostname === domain || hostname.endsWith(domain)
    );
    
    return isAllowed;
  } catch {
    return false;
  }
};

export const fetchWithTimeout = async (
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 60000
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
};

// Get image dimensions from URL by parsing image headers
export const getImageDimensions = async (imageUrl: string, env: any): Promise<{ width: number; height: number } | null> => {
  try {
    // Fetch only first 32KB to read headers (enough for JPEG/PNG headers)
    const IMAGE_FETCH_TIMEOUT = 60000; // 60 seconds
    const response = await fetchWithTimeout(imageUrl, {
      headers: { Range: 'bytes=0-32767' }
    }, IMAGE_FETCH_TIMEOUT);
    
    if (!response.ok && response.status !== 206) {
      // If Range not supported, fetch full image (but limit to 32KB)
      const fullResponse = await fetchWithTimeout(imageUrl, {}, IMAGE_FETCH_TIMEOUT);
      if (!fullResponse.ok) {
        return null;
      }
      const arrayBuffer = await fullResponse.arrayBuffer();
      return parseImageDimensions(new Uint8Array(arrayBuffer));
    }
    
    const arrayBuffer = await response.arrayBuffer();
    return parseImageDimensions(new Uint8Array(arrayBuffer));
  } catch (error) {
    console.error('[ImageDimensions] Failed to get dimensions:', error);
    return null;
  }
};

// Parse image dimensions from JPEG or PNG headers
const parseImageDimensions = (data: Uint8Array): { width: number; height: number } | null => {
  if (data.length < 24) return null;
  
  // Check for JPEG (starts with FF D8)
  if (data[0] === 0xFF && data[1] === 0xD8) {
    let i = 2;
    while (i < data.length - 8) {
      // Check for SOF markers (Start of Frame): C0, C1, C2, C3, C5, C6, C7, C9, CA, CB, CD, CE, CF
      if (data[i] === 0xFF) {
        const marker = data[i + 1];
        // SOF markers (Start of Frame) contain dimension info
        if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || 
            (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
          if (i + 8 < data.length) {
            const height = (data[i + 5] << 8) | data[i + 6];
            const width = (data[i + 7] << 8) | data[i + 8];
            if (width > 0 && height > 0 && width < 65536 && height < 65536) {
              return { width, height };
            }
          }
        }
        // Skip segment (skip marker byte + length bytes)
        if (marker !== 0xFF && i + 3 < data.length) {
          const segmentLength = (data[i + 2] << 8) | data[i + 3];
          if (segmentLength > 0 && segmentLength < 65536) {
            i += 2 + segmentLength;
            continue;
          }
        }
      }
      i++;
    }
  }
  
  // Check for PNG (starts with 89 50 4E 47 0D 0A 1A 0A)
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47 &&
      data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A) {
    // PNG dimensions are in first IHDR chunk (bytes 16-24)
    if (data.length >= 24) {
      const width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
      const height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
      if (width > 0 && height > 0 && width < 2147483647 && height < 2147483647) {
        return { width, height };
      }
    }
  }
  
  return null;
};

// Calculate aspect ratio from dimensions and find closest supported Vertex ratio
export const getClosestAspectRatio = (width: number, height: number, supportedRatios: string[]): string => {
  const actualRatio = width / height;
  
  // Parse supported ratios and find closest match
  let closestRatio = supportedRatios[0];
  let minDiff = Infinity;
  
  for (const ratioStr of supportedRatios) {
    const [w, h] = ratioStr.split(':').map(Number);
    const ratioValue = w / h;
    const diff = Math.abs(actualRatio - ratioValue);
    
    if (diff < minDiff) {
      minDiff = diff;
      closestRatio = ratioStr;
    }
  }
  
  return closestRatio;
};

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

// Extract Vertex AI safety violation from API response
// Returns { code: number, category: string, reason: string } or null if no violation
export const getVertexSafetyViolation = (responseData: any): { code: number; category: string; reason: string } | null => {
  if (!responseData) return null;

  // Check for prompt feedback blocked reason (input blocked)
  const promptFeedback = responseData.promptFeedback;
  if (promptFeedback) {
    // Check blockedReason
    if (promptFeedback.blockedReason) {
      const blockedReason = promptFeedback.blockedReason;
      // Map blocked reason to category (if it's a harm category)
      const category = blockedReason.replace('BLOCKED_REASON_', '').replace('SAFETY_', '');
      const code = VERTEX_HARM_CATEGORY_MAP[`HARM_CATEGORY_${category}`] || null;
      if (code) {
        return {
          code,
          category: category.toLowerCase().replace(/_/g, ' '),
          reason: `Input blocked: ${blockedReason}`,
        };
      }
    }
    
    // Check safetyRatings in promptFeedback (input safety ratings)
    const promptSafetyRatings = promptFeedback.safetyRatings || [];
    for (const rating of promptSafetyRatings) {
      const category = rating.category;
      const probability = rating.probability || rating.harmProbability;
      const blocked = rating.blocked;
      
      // Check if blocked or high/medium probability
      if (blocked === true || probability === 'HIGH' || probability === 'MEDIUM') {
        const code = VERTEX_HARM_CATEGORY_MAP[category];
        if (code) {
          return {
            code,
            category: category.replace('HARM_CATEGORY_', '').toLowerCase().replace(/_/g, ' '),
            reason: `Input blocked: ${category} (${probability || 'blocked'})`,
          };
        }
      }
    }
  }

  // Check for candidate finish reason (output blocked)
  const candidates = responseData.candidates || [];
  for (const candidate of candidates) {
    if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
      // Check safety ratings to find which category was violated
      const safetyRatings = candidate.safetyRatings || [];
      for (const rating of safetyRatings) {
        const category = rating.category;
        const probability = rating.probability || rating.harmProbability;
        const blocked = rating.blocked;
        
        // Check if blocked or high/medium probability
        if (blocked === true || probability === 'HIGH' || probability === 'MEDIUM') {
          const code = VERTEX_HARM_CATEGORY_MAP[category];
          if (code) {
            return {
              code,
              category: category.replace('HARM_CATEGORY_', '').toLowerCase().replace(/_/g, ' '),
              reason: `Output blocked: ${candidate.finishReason} - ${category} (${probability || 'blocked'})`,
            };
          }
        }
      }
      
      // If no specific category found but finishReason is SAFETY, return generic
      if (candidate.finishReason === 'SAFETY') {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.DANGEROUS_CONTENT, // Default to dangerous content
          category: 'safety violation',
          reason: `Output blocked: SAFETY`,
        };
      }
    }
  }

  // Check error response for support codes in message
  if (responseData.error?.message) {
    const message = responseData.error.message;
    // Extract support codes from message (format: "Support codes: 58061214")
    const supportCodeMatch = message.match(/Support codes?:\s*(\d+)/i);
    if (supportCodeMatch) {
      // Support codes are different from our custom codes, but we can check for safety-related patterns
      // For now, check message content for category keywords
      const lowerMessage = message.toLowerCase();
      if (lowerMessage.includes('hate') || lowerMessage.includes('hate speech')) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.HATE_SPEECH,
          category: 'hate speech',
          reason: message,
        };
      }
      if (lowerMessage.includes('harassment') || lowerMessage.includes('harass')) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.HARASSMENT,
          category: 'harassment',
          reason: message,
        };
      }
      if (lowerMessage.includes('sexual') || lowerMessage.includes('sexually explicit') || lowerMessage.includes('explicit')) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.SEXUALLY_EXPLICIT,
          category: 'sexually explicit',
          reason: message,
        };
      }
      if (lowerMessage.includes('dangerous') || lowerMessage.includes('danger')) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.DANGEROUS_CONTENT,
          category: 'dangerous content',
          reason: message,
        };
      }
    }
  }

  return null;
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

// Get KV namespace for token caching (reuses PROMPT_CACHE_KV)
const getTokenCacheKV = (env: Env): KVNamespace | null => {
  const kvBindingName = env.PROMPT_CACHE_KV_BINDING_NAME;
  if (!kvBindingName) {
    return null;
  }
  return (env as any)[kvBindingName] as KVNamespace || null;
};

// Generate cache key from service account credentials
const getTokenCacheKey = (serviceAccountEmail: string): string => {
  return `oauth_token:${serviceAccountEmail}`;
};

// Generate OAuth access token for Google Service Account
// This is used for Vertex AI authentication
// Caches tokens in KV for 55 minutes (tokens valid for 1 hour)
export const getAccessToken = async (
  serviceAccountEmail: string,
  privateKey: string,
  env: Env
): Promise<string> => {
  const cacheKey = getTokenCacheKey(serviceAccountEmail);
  const now = Math.floor(Date.now() / 1000);
  
  // Check KV cache first
  const tokenCacheKV = getTokenCacheKV(env);
  if (tokenCacheKV) {
    try {
      const cached = await tokenCacheKV.get(cacheKey, 'json') as { token: string; expiresAt: number } | null;
      if (cached && cached.expiresAt > now) {
        return cached.token;
      }
    } catch (error) {
      // KV read failed, continue to generate new token
    }
  }
  
  // Cache miss or expired, generate new token
  const expiry = now + 3600; // Token valid for 1 hour

  // Create JWT header
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  // Create JWT claim set
  const claimSet = {
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: 'https://oauth2.googleapis.com/token',
    exp: expiry,
    iat: now,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  };

  // Encode header and claim set
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));

  // Create the signature input
  const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

  // Import the private key and sign
  // Note: Cloudflare Workers support Web Crypto API
  const keyData = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

  const keyBuffer = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

  // Import RSA private key
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  // Sign the JWT
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signatureInput)
  );

  // Encode signature
  const encodedSignature = base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature))
  );

  // Create final JWT
  const jwt = `${signatureInput}.${encodedSignature}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Failed to get access token: ${tokenResponse.status} ${errorText}`);
    }

    const tokenData = await tokenResponse.json() as { access_token: string };
    const accessToken = tokenData.access_token;
  
    // Store token in KV cache with TTL (55 minutes = 3300 seconds)
    // KV TTL is in seconds, set to 3300 to expire before token expires (3600 seconds)
    const cacheExpiresAt = now + 3300;
    if (tokenCacheKV) {
      try {
        await tokenCacheKV.put(cacheKey, JSON.stringify({
          token: accessToken,
          expiresAt: cacheExpiresAt
        }), { expirationTtl: 3300 });
      } catch (error) {
        // KV write failed, but token is still valid - continue
      }
    }
    
    return accessToken;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OAuth token request timed out after 60 seconds');
    }
    throw error;
  }
};
