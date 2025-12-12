// Safety violation status codes (1000+) Loại nhạy cảm
export const SAFETY_STATUS_CODES = {
  ADULT: 1001, // Ảnh người lớn, nude, gợi dục, porn, ...
  VIOLENCE: 1002, // Ảnh bạo lực, chiến tranh, tử vong, ...
  RACY: 1003, // Ảnh nhạy cảm sexy, gợi dục, khiêu gợi, ...
  MEDICAL: 1004, // Ảnh máu me, phẫu thuật, y tế, nạn nhân, ...
  SPOOF: 1005, // Lừa bịp, ảnh copy của người khác, ...
} as const;

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
    'Access-Control-Allow-Headers': 'Content-Type, X-Preset-Name, X-Preset-Name-Encoded, X-Enable-Vertex-Prompt, X-Enable-Gemini-Prompt, X-Enable-Vision-Scan, X-Gender, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
};

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Preset-Name, X-Preset-Name-Encoded, X-Enable-Vertex-Prompt, X-Enable-Gemini-Prompt, X-Enable-Vision-Scan, X-Gender, Authorization',
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
  const jsonString = JSON.stringify(data);
  const corsHeaders = (request && env) ? getCorsHeaders(request, env) : CORS_HEADERS;
  
  return new Response(jsonString, {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
};

export const errorResponse = (message: string, status = 500, debug?: Record<string, any>, request?: Request, env?: any): Response =>
  jsonResponse({ 
    data: null,
    status: 'error', 
    message, 
    code: status,
    ...(debug ? { debug } : {})
  }, status, request, env);

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
      } catch {}
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

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
  lastAccessed: number;
}

class LRUCache<K, V extends TokenCacheEntry> {
  private cache: Map<K, V>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccessed = Date.now();
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry;
    }
    return undefined;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey: any = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    value.lastAccessed = Date.now();
    this.cache.set(key, value);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  size(): number {
    return this.cache.size;
  }

  cleanup(now: number): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }
}

const tokenCache = new LRUCache<string, TokenCacheEntry>(50);

// Generate cache key from service account credentials
const getCacheKey = (serviceAccountEmail: string, privateKey: string): string => {
  return `oauth_token:${serviceAccountEmail}`;
};

// Generate OAuth access token for Google Service Account
// This is used for Vertex AI authentication
// Caches tokens for 55 minutes (tokens valid for 1 hour)
export const getAccessToken = async (
  serviceAccountEmail: string,
  privateKey: string
): Promise<string> => {
  const cacheKey = getCacheKey(serviceAccountEmail, privateKey);
  const now = Math.floor(Date.now() / 1000);
  
  // Check cache first
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.token;
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
  
    const expiresAt = now + 3300;
    tokenCache.set(cacheKey, {
      token: accessToken,
      expiresAt: expiresAt,
      lastAccessed: Date.now()
    });
    
    tokenCache.cleanup(now);
    
    return accessToken;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OAuth token request timed out after 60 seconds');
    }
    throw error;
  }
};
