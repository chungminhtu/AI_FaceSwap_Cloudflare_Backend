// backend-cloudflare-workers/utils.ts
import type { Env } from './types';
import { ASPECT_RATIO_CONFIG, VERTEX_AI_CONFIG } from './config';
import { PhotonImage } from '@cf-wasm/photon/workerd';

// Safety status codes
export const SAFETY_STATUS_CODES = {
  ADULT: 1001,
  VIOLENCE: 1002,
  RACY: 1003,
  MEDICAL: 1004,
  SPOOF: 1005,
} as const;

export const VERTEX_SAFETY_STATUS_CODES = {
  HATE_SPEECH: 2001,
  HARASSMENT: 2002,
  SEXUALLY_EXPLICIT: 2003,
  DANGEROUS_CONTENT: 2004,
  PROMPT_CONTENT_POLICY: 3001,
  UNKNOWN_ERROR: 3000,
} as const;

const VERTEX_HARM_CATEGORY_MAP: Record<string, number> = {
  'HARM_CATEGORY_HATE_SPEECH': VERTEX_SAFETY_STATUS_CODES.HATE_SPEECH,
  'HARM_CATEGORY_HARASSMENT': VERTEX_SAFETY_STATUS_CODES.HARASSMENT,
  'HARM_CATEGORY_SEXUALLY_EXPLICIT': VERTEX_SAFETY_STATUS_CODES.SEXUALLY_EXPLICIT,
  'HARM_CATEGORY_DANGEROUS_CONTENT': VERTEX_SAFETY_STATUS_CODES.DANGEROUS_CONTENT,
};

const SEVERITY_LEVELS: Record<string, number> = {
  VERY_UNLIKELY: -1,
  UNLIKELY: 0,
  POSSIBLE: 1,
  LIKELY: 2,
  VERY_LIKELY: 3,
};

const UNSAFE_LEVELS = ['POSSIBLE', 'LIKELY', 'VERY_LIKELY'];

const COMMON_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Preset-Name, X-Preset-Name-Encoded, X-Enable-Vertex-Prompt, X-Enable-Gemini-Prompt, X-Enable-Vision-Scan, X-Gender, Authorization, X-API-Key',
  'Access-Control-Allow-Credentials': 'true',
};

export const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', ...COMMON_CORS_HEADERS };

export const getCorsHeaders = (request: Request, env: any): Record<string, string> => {
  const origin = request.headers.get('Origin');
  const userAgent = request.headers.get('User-Agent') || '';
  const isMobileApp = userAgent.includes('okhttp') || userAgent.includes('Android') || userAgent.includes('Dart') || !origin;

  if (isMobileApp) return { 'Access-Control-Allow-Origin': '*', ...COMMON_CORS_HEADERS };

  const allowedOriginsRaw = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o: any) => o.trim()) : [];
  if (allowedOriginsRaw.length === 0 || allowedOriginsRaw.includes('*')) {
    return { 'Access-Control-Allow-Origin': '*', ...COMMON_CORS_HEADERS };
  }

  if (!origin) return { 'Access-Control-Allow-Origin': '*', ...COMMON_CORS_HEADERS };

  const normalizedOrigin = origin.trim().toLowerCase();
  const allowedOriginsNormalized = allowedOriginsRaw.map((o: string) => o.toLowerCase());
  const matchedIndex = allowedOriginsNormalized.findIndex((allowed: string) => allowed === normalizedOrigin);

  if (matchedIndex >= 0) {
    return { 'Access-Control-Allow-Origin': allowedOriginsRaw[matchedIndex], ...COMMON_CORS_HEADERS };
  }

  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(normalizedOrigin);
  const hasLocalhostInAllowed = allowedOriginsNormalized.some((o: string) => o.includes('localhost') || o.includes('127.0.0.1'));

  return { 'Access-Control-Allow-Origin': (isLocalhost && hasLocalhostInAllowed) ? origin : origin, ...COMMON_CORS_HEADERS };
};

export const getVertexAILocation = (env: any): string => env.GOOGLE_VERTEX_LOCATION || VERTEX_AI_CONFIG.LOCATIONS.DEFAULT;

export const getVertexModelId = (modelParam?: string | number): string => {
  const modelStr = String(modelParam || VERTEX_AI_CONFIG.MODELS.DEFAULT).trim();
  return VERTEX_AI_CONFIG.MODELS.MAPPING[modelStr as keyof typeof VERTEX_AI_CONFIG.MODELS.MAPPING] || VERTEX_AI_CONFIG.MODELS.MAPPING[VERTEX_AI_CONFIG.MODELS.DEFAULT as keyof typeof VERTEX_AI_CONFIG.MODELS.MAPPING];
};

export const getVertexAIEndpoint = (projectId: string, location: string, model: string): string => {
  return location.toLowerCase() === 'global'
    ? VERTEX_AI_CONFIG.ENDPOINTS.GLOBAL(projectId, model)
    : VERTEX_AI_CONFIG.ENDPOINTS.REGIONAL(location, projectId, model);
};

export const normalizePresetId = (presetId: string | undefined | null): string | null => {
  if (!presetId || typeof presetId !== 'string') return null;
  const trimmed = presetId.trim();
  if (!trimmed) return null;

  const commonExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif', '.json'];
  const lowerTrimmed = trimmed.toLowerCase();

  for (const ext of commonExtensions) {
    if (lowerTrimmed.endsWith(ext)) return trimmed.slice(0, -ext.length);
  }

  const match = trimmed.match(/\.([a-z0-9]{1,5})$/i);
  return match ? trimmed.slice(0, -match[0].length) : trimmed;
};

export const jsonResponse = (data: any, status = 200, request?: Request, env?: any): Response => {
  const debugEnabled = env?.ENABLE_DEBUG_RESPONSE === 'true';

  if (data?.status === 'error' && data.message && (status === 400 || status === 500)) {
    if (debugEnabled && data.debug?.error) {
      data.message = data.debug.error;
    } else if (!debugEnabled) {
      data.message = status === 400 ? 'Bad Request' : 'Internal Server Error';
    }
  }

  const corsHeaders = (request && env) ? getCorsHeaders(request, env) : CORS_HEADERS;
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
};

export const errorResponse = (message: string, status = 500, debug?: Record<string, any>, request?: Request, env?: any): Response => {
  const debugEnabled = env?.ENABLE_DEBUG_RESPONSE === 'true';

  let debugWithError = debug;
  if ((status === 400 || status === 500) && (!debug?.error)) {
    debugWithError = {
      ...(debug || {}),
      error: (message && message !== 'Bad Request' && message !== 'Internal Server Error') ? message : `${status === 400 ? 'Bad Request' : 'Internal Server Error'} - no error details provided`
    };
  }

  let finalMessage: string;
  if (status === 400 || status === 500) {
    if (debugEnabled && debugWithError?.error) {
      finalMessage = debugWithError.error;
    } else if (debugEnabled && message && message !== 'Bad Request' && message !== 'Internal Server Error') {
      finalMessage = message;
    } else {
      finalMessage = status === 400 ? 'Bad Request' : 'Internal Server Error';
    }
  } else {
    finalMessage = message;
  }

  const responseData: any = { data: null, status: 'error', message: finalMessage, code: status };
  const debugForResponse = (status === 400 || status === 500) ? debugWithError : debug;

  if (debugEnabled && debugForResponse && Object.keys(debugForResponse).length > 0) {
    responseData.debug = debugForResponse;
  }

  return jsonResponse(responseData, status, request, env);
};

export const successResponse = (data: any, status = 200, request?: Request, env?: any): Response => {
  return jsonResponse({ data, status: 'success', message: 'Processing successful', code: status }, status, request, env);
};

export const isUnsafe = (annotation: { adult: string; violence: string; racy: string }): boolean => {
  return UNSAFE_LEVELS.includes(annotation.adult) || UNSAFE_LEVELS.includes(annotation.violence) || UNSAFE_LEVELS.includes(annotation.racy);
};

export const validateImageUrl = (url: string, env: any): boolean => {
  try {
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'https:') return false;

    const hostname = urlObj.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) return false;

    const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    }

    const allowedDomains: string[] = ['.r2.cloudflarestorage.com', '.r2.dev'];
    if (env.R2_DOMAIN) {
      try { allowedDomains.push(new URL(env.R2_DOMAIN).hostname.toLowerCase()); } catch {}
    }

    return allowedDomains.some(domain => hostname === domain || hostname.endsWith(domain));
  } catch {
    return false;
  }
};

export const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeoutMs = 60000): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
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

export const promisePoolWithConcurrency = async <T, R>(items: T[], asyncFn: (item: T, index: number) => Promise<R>, concurrency = 2): Promise<R[]> => {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (let i = 0; i < items.length; i++) {
    const promise = asyncFn(items[i], i).then(result => { results[i] = result; });
    const executingPromise = promise.then(() => { executing.splice(executing.indexOf(executingPromise), 1); });
    executing.push(executingPromise);
    if (executing.length >= concurrency) await Promise.race(executing);
  }

  await Promise.all(executing);
  return results;
};

export interface ImageDimensionsExtended {
  width: number;
  height: number;
  rawWidth: number;
  rawHeight: number;
  orientation: number;
  rotated: boolean;
}

export const getImageDimensions = async (imageUrl: string, env: any): Promise<{ width: number; height: number } | null> => {
  try {
    const response = await fetchWithTimeout(imageUrl, {}, 60000);
    if (!response.ok) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    const img = PhotonImage.new_from_byteslice(bytes);
    const width = img.get_width();
    const height = img.get_height();
    img.free();

    return (width > 0 && height > 0) ? { width, height } : null;
  } catch {
    return null;
  }
};

export const getImageDimensionsExtended = async (imageUrl: string, env: any): Promise<ImageDimensionsExtended | null> => {
  try {
    const response = await fetchWithTimeout(imageUrl, { headers: { Range: 'bytes=0-65535' } }, 60000);
    let arrayBuffer: ArrayBuffer;

    if (!response.ok && response.status !== 206) {
      const fullResponse = await fetchWithTimeout(imageUrl, {}, 60000);
      if (!fullResponse.ok) return null;
      arrayBuffer = await fullResponse.arrayBuffer();
    } else {
      arrayBuffer = await response.arrayBuffer();
    }

    return parseImageDimensionsExtended(new Uint8Array(arrayBuffer));
  } catch {
    return null;
  }
};

// Parse EXIF orientation from JPEG APP1 segment (1-8, 1=normal)
const parseJpegExifOrientation = (data: Uint8Array): number => {
  let i = 2;
  while (i < data.length - 4) {
    if (data[i] !== 0xFF) { i++; continue; }
    const marker = data[i + 1];

    if (marker === 0xE1) {
      const segLen = (data[i + 2] << 8) | data[i + 3];
      if (segLen < 8 || i + 2 + segLen > data.length) break;

      if (data[i + 4] === 0x45 && data[i + 5] === 0x78 && data[i + 6] === 0x69 && data[i + 7] === 0x66 && data[i + 8] === 0x00 && data[i + 9] === 0x00) {
        const tiffStart = i + 10;
        if (tiffStart + 8 > data.length) break;

        const isLE = data[tiffStart] === 0x49 && data[tiffStart + 1] === 0x49;
        const isBE = data[tiffStart] === 0x4D && data[tiffStart + 1] === 0x4D;
        if (!isLE && !isBE) break;

        const readU16 = (off: number) => off + 1 >= data.length ? 0 : isLE ? (data[off] | (data[off + 1] << 8)) : ((data[off] << 8) | data[off + 1]);
        const readU32 = (off: number) => off + 3 >= data.length ? 0 : isLE ? (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) : ((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]);

        const ifd0Offset = readU32(tiffStart + 4);
        if (ifd0Offset < 8 || tiffStart + ifd0Offset + 2 > data.length) break;

        const numEntries = readU16(tiffStart + ifd0Offset);
        for (let e = 0; e < numEntries && e < 50; e++) {
          const entryOff = tiffStart + ifd0Offset + 2 + (e * 12);
          if (entryOff + 12 > data.length) break;
          if (readU16(entryOff) === 0x0112) {
            const orientation = readU16(entryOff + 8);
            if (orientation >= 1 && orientation <= 8) return orientation;
          }
        }
      }
      break;
    }

    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
    if (marker === 0x00 || marker === 0xFF) { i++; continue; }
    if (i + 3 >= data.length) break;
    const segLen = (data[i + 2] << 8) | data[i + 3];
    if (segLen < 2) break;
    i += 2 + segLen;
  }
  return 1;
};

// Parse WebP dimensions (shared helper)
const parseWebPDimensions = (data: Uint8Array): { width: number; height: number } | null => {
  if (data.length < 30 || data[0] !== 0x52 || data[1] !== 0x49 || data[2] !== 0x46 || data[3] !== 0x46 ||
      data[8] !== 0x57 || data[9] !== 0x45 || data[10] !== 0x42 || data[11] !== 0x50) return null;

  // VP8 (lossy)
  if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x20 && data.length >= 30) {
    const w = ((data[26] | (data[27] << 8)) & 0x3FFF) + 1;
    const h = ((data[28] | (data[29] << 8)) & 0x3FFF) + 1;
    if (w > 0 && h > 0 && w < 65536 && h < 65536) return { width: w, height: h };
  }
  // VP8L (lossless)
  if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x4C && data.length >= 25) {
    const bits = (data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24));
    const w = (bits & 0x3FFF) + 1;
    const h = ((bits >> 14) & 0x3FFF) + 1;
    if (w > 0 && h > 0 && w < 65536 && h < 65536) return { width: w, height: h };
  }
  // VP8X (extended)
  if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x58 && data.length >= 30) {
    const w = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1;
    const h = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1;
    if (w > 0 && h > 0 && w < 16777216 && h < 16777216) return { width: w, height: h };
  }
  return null;
};

const parseImageDimensionsExtended = (data: Uint8Array): ImageDimensionsExtended | null => {
  if (data.length < 24) return null;

  // JPEG
  if (data[0] === 0xFF && data[1] === 0xD8) {
    const orientation = parseJpegExifOrientation(data);
    const rotated = orientation >= 5 && orientation <= 8;

    let i = 2;
    while (i < data.length - 8) {
      if (data[i] === 0xFF) {
        const marker = data[i + 1];
        if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
            (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
          if (i + 8 < data.length) {
            const rawH = (data[i + 5] << 8) | data[i + 6];
            const rawW = (data[i + 7] << 8) | data[i + 8];
            if (rawW > 0 && rawH > 0 && rawW < 65536 && rawH < 65536) {
              return { width: rotated ? rawH : rawW, height: rotated ? rawW : rawH, rawWidth: rawW, rawHeight: rawH, orientation, rotated };
            }
          }
        }
        if (marker !== 0xFF && i + 3 < data.length) {
          const segLen = (data[i + 2] << 8) | data[i + 3];
          if (segLen > 0 && segLen < 65536) { i += 2 + segLen; continue; }
        }
      }
      i++;
    }
  }

  // PNG
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47 &&
      data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A && data.length >= 24) {
    const w = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
    const h = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
    if (w > 0 && h > 0 && w < 2147483647 && h < 2147483647) {
      return { width: w, height: h, rawWidth: w, rawHeight: h, orientation: 1, rotated: false };
    }
  }

  // WebP
  const webp = parseWebPDimensions(data);
  if (webp) return { ...webp, rawWidth: webp.width, rawHeight: webp.height, orientation: 1, rotated: false };

  return null;
};

export const getClosestAspectRatio = (width: number, height: number, supportedRatios: string[]): string => {
  if (width <= 0 || height <= 0 || !Array.isArray(supportedRatios) || supportedRatios.length === 0) return '3:4';

  const validRatios = supportedRatios.filter(r => r !== 'original' && /^\d+:\d+$/.test(r));
  if (validRatios.length === 0) return '3:4';

  const actualRatio = width / height;
  const isPortrait = height > width;
  const isLandscape = width > height;

  let filtered = validRatios;
  if (isPortrait) {
    const portrait = validRatios.filter(r => { const [w, h] = r.split(':').map(Number); return h > w; });
    if (portrait.length > 0) filtered = portrait;
  } else if (isLandscape) {
    const landscape = validRatios.filter(r => { const [w, h] = r.split(':').map(Number); return w > h; });
    if (landscape.length > 0) filtered = landscape;
  }

  let closest = filtered[0];
  let minDiff = Infinity;

  for (const ratioStr of filtered) {
    const [w, h] = ratioStr.split(':').map(Number);
    if (w <= 0 || h <= 0) continue;
    const diff = Math.abs(actualRatio - w / h);
    if (diff < minDiff) { minDiff = diff; closest = ratioStr; }
  }

  return validRatios.includes(closest) ? closest : validRatios[0] || '3:4';
};

export const resolveAspectRatio = async (
  aspectRatio: string | undefined | null,
  imageUrl: string | undefined | null,
  env: any,
  options: { allowOriginal?: boolean; defaultRatio?: string; supportedRatios?: string[] } = {}
): Promise<string> => {
  const { allowOriginal = false, defaultRatio, supportedRatios: customRatios } = options;
  const supportedRatios = customRatios || ASPECT_RATIO_CONFIG.SUPPORTED;
  const fallback = defaultRatio || ASPECT_RATIO_CONFIG.DEFAULT;

  if (allowOriginal && (!aspectRatio || aspectRatio === 'original' || aspectRatio === '')) {
    if (!imageUrl) return fallback;
    const dim = await getImageDimensions(imageUrl, env);
    if (dim && dim.width > 0 && dim.height > 0) {
      const closest = getClosestAspectRatio(dim.width, dim.height, supportedRatios);
      if (closest && closest !== 'original' && supportedRatios.includes(closest)) return closest;
    }
    return fallback;
  }

  if (aspectRatio === 'original' && !allowOriginal) return fallback;
  return supportedRatios.includes(aspectRatio || '') ? (aspectRatio || fallback) : fallback;
};

export const getWorstViolation = (annotation: { adult: string; violence: string; racy: string; medical?: string; spoof?: string }): { code: number; category: string; level: string } | null => {
  const categories = [
    { key: 'adult', code: SAFETY_STATUS_CODES.ADULT },
    { key: 'violence', code: SAFETY_STATUS_CODES.VIOLENCE },
    { key: 'racy', code: SAFETY_STATUS_CODES.RACY },
    { key: 'medical', code: SAFETY_STATUS_CODES.MEDICAL },
    { key: 'spoof', code: SAFETY_STATUS_CODES.SPOOF },
  ];

  const violations = categories
    .map(({ key, code }) => ({ key, code, level: annotation[key as keyof typeof annotation] }))
    .filter(({ level }) => level && UNSAFE_LEVELS.includes(level))
    .map(({ key, code, level }) => ({ category: key, level: level!, severity: SEVERITY_LEVELS[level!] || 0, code }));

  if (violations.length === 0) return null;
  const worst = violations.reduce((prev, cur) => cur.severity > prev.severity ? cur : prev);
  return { code: worst.code, category: worst.category, level: worst.level };
};

export const getVertexSafetyViolation = (responseData: any): { code: number; category: string; reason: string } | null => {
  if (!responseData) return null;

  const mapCategoryToCode = (category: string): number | null => {
    const cat = category.replace('BLOCKED_REASON_', '').replace('SAFETY_', '');
    const code = VERTEX_HARM_CATEGORY_MAP[`HARM_CATEGORY_${cat}`];
    return (code && code >= 2001 && code <= 2004) ? code : null;
  };

  const formatCategory = (cat: string): string => (cat || 'HARM_CATEGORY_UNKNOWN').replace('HARM_CATEGORY_', '').toLowerCase().replace(/_/g, ' ');

  const checkSafetyRatings = (ratings: any[], prefix: string): { code: number; category: string; reason: string } | null => {
    for (const r of ratings) {
      const prob = r.probability || r.harmProbability;
      if (r.blocked === true || prob === 'HIGH' || prob === 'MEDIUM') {
        const code = VERTEX_HARM_CATEGORY_MAP[r.category];
        if (code && code >= 2001 && code <= 2004) {
          return { code, category: formatCategory(r.category), reason: `${prefix}: ${r.category || 'safety'} (${prob || 'blocked'})` };
        }
      }
    }
    return null;
  };

  // Check promptFeedback
  const pf = responseData.promptFeedback;
  if (pf) {
    const blocked = pf.blockedReason || pf.blockReason;
    if (blocked) {
      const code = mapCategoryToCode(blocked);
      if (code) return { code, category: formatCategory(blocked), reason: `Input blocked: ${blocked}` };
      return { code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR, category: 'vertex unknown error', reason: `Input blocked: ${blocked} - Unable to determine specific violation category` };
    }
    const pfRating = checkSafetyRatings(pf.safetyRatings || [], 'Input blocked');
    if (pfRating) return pfRating;
  }

  // Check candidates
  for (const c of responseData.candidates || []) {
    const fr = c.finishReason;
    const parts = c.content?.parts || [];
    const hasImage = parts.some((p: any) => p.inlineData || p.inline_data);
    const refusalText = parts.filter((p: any) => p.text).map((p: any) => p.text).join(' ');

    const isSafetyBlock = ['SAFETY', 'IMAGE_SAFETY', 'RECITATION', 'BLOCKED', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(fr) || (fr === 'STOP' && !hasImage);

    if (isSafetyBlock) {
      const finishMsg = c.finishMessage || refusalText || '';
      const candRating = checkSafetyRatings(c.safetyRatings || [], 'Output blocked');
      if (candRating) return { ...candRating, reason: finishMsg || candRating.reason };

      const txt = (finishMsg + ' ' + refusalText).toLowerCase();

      if (/sexual|nude|naked|explicit|adult|pornograph|nsfw|genital|breast|buttock/i.test(txt))
        return { code: VERTEX_SAFETY_STATUS_CODES.SEXUALLY_EXPLICIT, category: 'sexually explicit', reason: finishMsg || refusalText || `Output blocked: ${fr}` };
      if (/weapon|gun|violen|harm|kill|danger|drug|bomb|explos|attack|murder|shoot|stab/i.test(txt))
        return { code: VERTEX_SAFETY_STATUS_CODES.DANGEROUS_CONTENT, category: 'dangerous content', reason: finishMsg || refusalText || `Output blocked: ${fr}` };
      if (/hate|racist|discriminat|slur|bigot|ethnic|antisemit|homophob|xenophob/i.test(txt))
        return { code: VERTEX_SAFETY_STATUS_CODES.HATE_SPEECH, category: 'hate speech', reason: finishMsg || refusalText || `Output blocked: ${fr}` };
      if (/harass|bully|threaten|intimidat|abus|stalk|torment/i.test(txt))
        return { code: VERTEX_SAFETY_STATUS_CODES.HARASSMENT, category: 'harassment', reason: finishMsg || refusalText || `Output blocked: ${fr}` };
      if (/content policy|exposed sensitive|provocative|wholesome|modest|non-revealing|appropriate for all audiences/i.test(txt))
        return { code: VERTEX_SAFETY_STATUS_CODES.PROMPT_CONTENT_POLICY, category: 'prompt content policy', reason: refusalText || finishMsg };
      if ((c.safetyRatings || []).length > 0)
        return { code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR, category: 'vertex unknown error', reason: finishMsg || 'Output blocked - Unable to determine specific violation category' };
      if (refusalText && /i cannot|beyond my|unable to|not able to|can't help|cannot help/i.test(refusalText.toLowerCase()))
        return { code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR, category: 'vertex unknown error', reason: refusalText };

      return { code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR, category: 'vertex unknown error', reason: finishMsg || `Output blocked: ${fr}` };
    }
  }

  return null;
};

export const base64UrlEncode = (str: string): string => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
export const base64Decode = (str: string): string => atob(str);

const getTokenCacheKV = (env: Env): KVNamespace | null => {
  const kvBindingName = env.PROMPT_CACHE_KV_BINDING_NAME;
  return kvBindingName ? (env as any)[kvBindingName] as KVNamespace || null : null;
};

export const getAccessToken = async (serviceAccountEmail: string, privateKey: string, env: Env): Promise<string> => {
  const cacheKey = `oauth_token:${serviceAccountEmail}`;
  const now = Math.floor(Date.now() / 1000);

  const tokenCacheKV = getTokenCacheKV(env);
  if (tokenCacheKV) {
    try {
      const cached = await tokenCacheKV.get(cacheKey, 'json') as { token: string; expiresAt: number } | null;
      if (cached && cached.expiresAt > now) return cached.token;
    } catch {}
  }

  const expiry = now + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: 'https://oauth2.googleapis.com/token',
    exp: expiry,
    iat: now,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
  const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

  const keyData = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const keyBuffer = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey('pkcs8', keyBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signatureInput));
  const encodedSignature = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
  const jwt = `${signatureInput}.${encodedSignature}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get access token: ${response.status} ${errorText}`);
    }

    const { access_token } = await response.json() as { access_token: string };

    if (tokenCacheKV) {
      try { await tokenCacheKV.put(cacheKey, JSON.stringify({ token: access_token, expiresAt: now + 3300 }), { expirationTtl: 3300 }); } catch {}
    }

    return access_token;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') throw new Error('OAuth token request timed out after 60 seconds');
    throw error;
  }
};
