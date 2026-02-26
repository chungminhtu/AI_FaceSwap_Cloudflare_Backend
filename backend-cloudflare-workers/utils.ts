// backend-cloudflare-workers/utils.ts
import type { Env } from './types';
import { ASPECT_RATIO_CONFIG } from './config';
import { PhotonImage } from '@cf-wasm/photon/workerd';

// Safety violation status codes (1000+) Loại nhạy cảm
// Tìm kiếm An toàn: Tập hợp các đặc điểm liên quan đến hình ảnh, được tính toán bằng các phương pháp thị giác máy tính
export const SAFETY_STATUS_CODES = {
  ADULT: 1001, // Thể hiện khả năng nội dung dành cho người lớn của hình ảnh. Nội dung dành cho người lớn có thể bao gồm các yếu tố như khỏa thân, hình ảnh hoặc phim hoạt hình khiêu dâm, hoặc các hoạt động tình dục.
  VIOLENCE: 1002, // Hình ảnh này có khả năng chứa nội dung bạo lực. Nội dung bạo lực có thể bao gồm cái chết, thương tích nghiêm trọng hoặc tổn hại đến cá nhân hoặc nhóm cá nhân.
  RACY: 1003, // Khả năng cao hình ảnh được yêu cầu chứa nội dung khiêu dâm. Nội dung khiêu dâm có thể bao gồm (nhưng không giới hạn) quần áo mỏng manh hoặc xuyên thấu, khỏa thân được che đậy một cách khéo léo, tư thế tục tĩu hoặc khiêu khích, hoặc cận cảnh các vùng nhạy cảm trên cơ thể.
  MEDICAL: 1004, // Rất có thể đây là hình ảnh y tế.
  SPOOF: 1005, // Xác suất chế giễu. Xác suất xảy ra việc chỉnh sửa phiên bản gốc của hình ảnh để làm cho nó trông hài hước hoặc phản cảm.
} as const;

// Vertex AI safety configuration - Using centralized config
// Note: Status codes in utils.ts are maintained for backward compatibility
// but should be migrated to use VERTEX_AI_CONFIG.SAFETY_STATUS_CODES
export const VERTEX_SAFETY_STATUS_CODES = {
  // Vertex AI structured safety filter blocks (safetyRatings with blocked=true)
  HATE_SPEECH: 2001, // Lời lẽ kích động thù hận: Những bình luận tiêu cực hoặc gây hại nhắm vào danh tính và/hoặc các thuộc tính được bảo vệ.
  HARASSMENT: 2002, // Quấy rối: Những lời lẽ đe dọa, hăm dọa, bắt nạt hoặc lăng mạ nhắm vào người khác.
  SEXUALLY_EXPLICIT: 2003, // Nội dung khiêu dâm: Có chứa nội dung liên quan đến hành vi tình dục hoặc các nội dung khiêu dâm khác.
  DANGEROUS_CONTENT: 2004, // Nội dung nguy hiểm: Thúc đẩy hoặc tạo điều kiện tiếp cận các hàng hóa, dịch vụ và hoạt động có hại.
  // Prompt-based content policy refusal (model text-based refusal from our CONTENT_SAFETY_INSTRUCTION)
  PROMPT_CONTENT_POLICY: 3001, // Model refused due to our prompt content policy instruction - NOT from Vertex AI safety filters
  // Unknown errors
  UNKNOWN_ERROR: 3000, // Vertex AI unknown error: Safety violation detected but specific category cannot be determined
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

// Block POSSIBLE, LIKELY, and VERY_LIKELY
const UNSAFE_LEVELS = ['POSSIBLE', 'LIKELY', 'VERY_LIKELY'];

const COMMON_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Preset-Name, X-Preset-Name-Encoded, X-Enable-Vertex-Prompt, X-Enable-Gemini-Prompt, X-Enable-Vision-Scan, X-Gender, Authorization, X-API-Key',
  'Access-Control-Allow-Credentials': 'true',
};

export const getCorsHeaders = (request: Request, env: any): Record<string, string> => {
  const origin = request.headers.get('Origin');
  const userAgent = request.headers.get('User-Agent') || '';
  const isMobileApp = userAgent.includes('okhttp') || userAgent.includes('Android') || userAgent.includes('Dart') || !origin;
  
  // Parse and normalize allowed origins (preserve original for matching, but normalize for comparison)
  const allowedOriginsRaw = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o: any) => o.trim()) : [];
  const allowedOriginsNormalized = allowedOriginsRaw.map((o: string) => o.toLowerCase());
  
  let allowOrigin = '*';
  
  if (isMobileApp) {
    allowOrigin = '*';
  } else if (allowedOriginsRaw.length > 0) {
    // Check if '*' is explicitly allowed
    if (allowedOriginsRaw.includes('*')) {
      allowOrigin = '*';
    } else if (origin) {
      // Normalize origin for comparison
      const normalizedOrigin = origin.trim().toLowerCase();
      
      // Find matching origin (case-insensitive comparison)
      const matchedIndex = allowedOriginsNormalized.findIndex((allowed: string) => allowed === normalizedOrigin);
      
      if (matchedIndex >= 0) {
        // Use the original (non-normalized) allowed origin to preserve exact format
        allowOrigin = allowedOriginsRaw[matchedIndex];
      } else {
        // Check if origin is localhost/127.0.0.1 and any localhost is in allowed list
        const isLocalhost = normalizedOrigin.startsWith('http://localhost') || 
                           normalizedOrigin.startsWith('http://127.0.0.1') ||
                           normalizedOrigin.startsWith('https://localhost') ||
                           normalizedOrigin.startsWith('https://127.0.0.1');
        
        const hasLocalhostInAllowed = allowedOriginsNormalized.some((o: string) => 
          o.includes('localhost') || o.includes('127.0.0.1')
        );
        
        if (isLocalhost && hasLocalhostInAllowed) {
          // Allow any localhost if localhost is in allowed origins
          allowOrigin = origin;
        } else {
          // Origin not in allowed list - this should cause CORS to fail, but for backward compatibility
          // we'll use '*' if no origin match found (this is a fallback, but not ideal)
          // Actually, let's use the origin itself if it's provided, browser will handle CORS check
          allowOrigin = origin;
        }
      }
    } else {
      // No origin header - allow all
      allowOrigin = '*';
    }
  }
  
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    ...COMMON_CORS_HEADERS,
  };
};

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  ...COMMON_CORS_HEADERS,
};

import { VERTEX_AI_CONFIG } from './config';

// Vertex AI Configuration - Using centralized config
export const getVertexAILocation = (env: any): string => {
  const location = env.GOOGLE_VERTEX_LOCATION || VERTEX_AI_CONFIG.LOCATIONS.DEFAULT;
  return location;
};

export const getVertexModelId = (modelParam?: string | number): string => {
  const modelStr = String(modelParam || VERTEX_AI_CONFIG.MODELS.DEFAULT).trim();
  return VERTEX_AI_CONFIG.MODELS.MAPPING[modelStr as keyof typeof VERTEX_AI_CONFIG.MODELS.MAPPING] || VERTEX_AI_CONFIG.MODELS.MAPPING[VERTEX_AI_CONFIG.MODELS.DEFAULT as keyof typeof VERTEX_AI_CONFIG.MODELS.MAPPING];
};

export const getVertexAIEndpoint = (
  projectId: string,
  location: string,
  model: string
): string => {
  // Use centralized endpoint builders
  if (location.toLowerCase() === 'global') {
    return VERTEX_AI_CONFIG.ENDPOINTS.GLOBAL(projectId, model);
  }

  return VERTEX_AI_CONFIG.ENDPOINTS.REGIONAL(location, projectId, model);
};

// Strip file extension from preset ID
// Mobile apps may send preset IDs with extensions like "fs_seoul_trendy_k_travel_style_m1_2.xxx"
// This function removes the extension and returns only the filename as preset ID
export const normalizePresetId = (presetId: string | undefined | null): string | null => {
  if (!presetId || typeof presetId !== 'string') {
    return null;
  }
  
  const trimmed = presetId.trim();
  if (!trimmed) {
    return null;
  }
  
  // Remove file extension (everything after the last dot)
  // But preserve dots that are part of the preset ID (like "fs_seoul_trendy_k_travel_style_m1_2")
  // Only remove if it looks like a file extension (common image extensions)
  const commonExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif', '.json'];
  const lowerTrimmed = trimmed.toLowerCase();
  
  // Check if it ends with a common extension
  for (const ext of commonExtensions) {
    if (lowerTrimmed.endsWith(ext)) {
      return trimmed.slice(0, -ext.length);
    }
  }
  
  // If no common extension found, check if it has a dot near the end (likely an extension)
  // Remove extension if there's a dot followed by 1-5 characters at the end
  const extensionPattern = /\.([a-z0-9]{1,5})$/i;
  const match = trimmed.match(extensionPattern);
  if (match) {
    // Only remove if the part after dot looks like an extension (not part of preset ID)
    // Preset IDs typically don't end with short extensions
    return trimmed.slice(0, -match[0].length);
  }
  
  return trimmed;
};

export const jsonResponse = (data: any, status = 200, request?: Request, env?: any): Response => {
  // Check if debug is enabled
  const debugEnabled = env && env.ENABLE_DEBUG_RESPONSE === 'true';
  
  // For 400 and 500 errors, sanitize message field - detailed info only in debug
  // If debug is enabled and debug object contains error message, use it
  if (data && typeof data === 'object' && data.status === 'error' && data.message) {
    if (status === 400 || status === 500) {
      // If debug is enabled and we have debug info with error message, use it
      if (debugEnabled && data.debug && data.debug.error) {
        data.message = data.debug.error;
      } else if (!debugEnabled) {
        // Only sanitize if debug is disabled
        if (status === 400) {
          data.message = 'Bad Request';
        } else if (status === 500) {
          data.message = 'Internal Server Error';
        }
      }
    }
  }
  
  const jsonString = JSON.stringify(data);
  const corsHeaders = (request && env) ? getCorsHeaders(request, env) : CORS_HEADERS;
  
  return new Response(jsonString, {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
};

// Log error responses for 400/500 status codes
// Always logs actual error details for monitoring, even if not shown to user
const logErrorResponse = (status: number, message: string, debug: Record<string, any> | undefined, request: Request | undefined, env: any): void => {
  if (status !== 400 && status !== 500) return;
  if (!request) return;
  
  try {
    const url = new URL(request.url);
    const endpoint = url.pathname;
    const requestId = request.headers.get('cf-ray') || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    
    // Extract actual error message - prioritize debug.error, then message parameter, then generic
    // If message is already generic ("Bad Request"), try to get more info from debug object
    let actualError: string;
    if (debug?.error) {
      actualError = debug.error;
    } else if (message && message !== 'Bad Request' && message !== 'Internal Server Error') {
      actualError = message;
    } else if (debug && Object.keys(debug).length > 0) {
      // If we have debug context but no error field, construct error from debug data
      const debugStr = JSON.stringify(debug).substring(0, 500);
      actualError = `Error details: ${debugStr}`;
    } else {
      actualError = message || (status === 400 ? 'Bad Request' : 'Internal Server Error');
    }
    
    const logData: any = {
      endpoint,
      statusCode: status,
      errorMessage: actualError, // Always log the actual error, not generic message
      request: {
        method: request.method,
        url: request.url,
        path: endpoint,
        requestId,
        ip,
        userAgent: userAgent.substring(0, 200),
        headers: {
          'content-type': request.headers.get('content-type'),
          'x-api-key': request.headers.get('x-api-key') ? '***present***' : 'missing',
          'authorization': request.headers.get('authorization') ? '***present***' : 'missing'
        }
      }
    };
    
    // Include all debug context for full error details (even if empty, it shows we tried to log)
    if (debug && Object.keys(debug).length > 0) {
      Object.assign(logData, debug);
    } else {
      // If no debug provided, note it in the log
      logData.debugMissing = true;
      logData.note = 'No debug context provided to errorResponse';
    }
    
    console.error(`[ERROR ${status}] ${endpoint}:`, JSON.stringify(logData, null, 2));
  } catch (logError) {
    // Don't fail if logging fails
    console.error(`[ERROR ${status}] Failed to log error response:`, logError);
  }
};

export const errorResponse = (message: string, status = 500, debug?: Record<string, any>, request?: Request, env?: any): Response => {
  // Check if debug is enabled
  const debugEnabled = env && env.ENABLE_DEBUG_RESPONSE === 'true';
  
  // For 400/500 errors, ensure we have error details for logging
  // If debug is not provided or doesn't have error field, create one from message
  let debugWithError = debug;
  if ((status === 400 || status === 500) && (!debug || !debug.error)) {
    // Create debug object with error field if missing
    debugWithError = {
      ...(debug || {}),
      error: message && message !== 'Bad Request' && message !== 'Internal Server Error' 
        ? message 
        : (status === 400 ? 'Bad Request - no error details provided' : 'Internal Server Error - no error details provided')
    };
  }
  
  // For 400 and 500 errors, use detailed messages when debug is enabled
  let finalMessage: string;
  if (status === 400 || status === 500) {
    // If debug is enabled and debug object has error message, use it
    if (debugEnabled && debugWithError && debugWithError.error) {
      finalMessage = debugWithError.error;
    } else if (debugEnabled && message && message !== 'Bad Request' && message !== 'Internal Server Error') {
      // If debug enabled but no debug.error, use the message parameter if provided
      finalMessage = message;
    } else {
      // Generic messages when debug is disabled
      if (status === 400) {
        finalMessage = 'Bad Request';
      } else {
        finalMessage = 'Internal Server Error';
      }
    }
  } else {
    finalMessage = message;
  }
  
  // Always log 400/500 errors with actual error details for critical monitoring
  // This logs even if debug is disabled - important for catching DB errors and other critical issues
  // Use debugWithError which always has an error field for 400/500 errors
  if (status === 400 || status === 500) {
    logErrorResponse(status, finalMessage, debugWithError, request, env);
  }
  
  // Include debug object in response only when debug is enabled
  // But always log it for monitoring purposes (handled above)
  const responseData: any = {
    data: null,
    status: 'error', 
    message: finalMessage, 
    code: status
  };
  
  // Always include debug object when debug is enabled and debug data exists
  // Use debugWithError for 400/500 errors to ensure error field is present
  const debugForResponse = (status === 400 || status === 500) ? debugWithError : debug;
  if (debugEnabled && debugForResponse && Object.keys(debugForResponse).length > 0) {
    responseData.debug = debugForResponse;
  }
  
  return jsonResponse(responseData, status, request, env);
};

export const successResponse = (data: any, status = 200, request?: Request, env?: any): Response => {
  return jsonResponse({ 
    data,
    status: 'success', 
    message: 'Processing successful', 
    code: status
  }, status, request, env);
};

export const isUnsafe = (
  annotation: { adult: string; violence: string; racy: string }
): boolean => {
  return (
    UNSAFE_LEVELS.includes(annotation.adult) ||
    UNSAFE_LEVELS.includes(annotation.violence) ||
    UNSAFE_LEVELS.includes(annotation.racy)
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

// Concurrency-limited promise pool for batch operations
// Prevents overwhelming external APIs (like Vertex AI) with too many parallel requests
export const promisePoolWithConcurrency = async <T, R>(
  items: T[],
  asyncFn: (item: T, index: number) => Promise<R>,
  concurrency: number = 2
): Promise<R[]> => {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    
    // Create promise that stores result at correct index
    const promise = asyncFn(item, i).then(result => {
      results[i] = result;
    });

    const executingPromise = promise.then(() => {
      executing.splice(executing.indexOf(executingPromise), 1);
    });
    executing.push(executingPromise);

    // If concurrency limit reached, wait for one to complete
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  // Wait for remaining promises
  await Promise.all(executing);
  return results;
};

// Extended image info including raw dimensions and EXIF orientation for debugging
export interface ImageDimensionsExtended {
  width: number;          // Display width (after EXIF rotation)
  height: number;         // Display height (after EXIF rotation)
  rawWidth: number;       // Original pixel width from file
  rawHeight: number;      // Original pixel height from file
  orientation: number;    // EXIF orientation (1-8), 1 = normal
  rotated: boolean;       // True if orientation 5-8 (90° rotation applied)
}

// Get image dimensions from URL using @cf-wasm/photon (100% reliable for all image formats)
export const getImageDimensions = async (imageUrl: string, env: any): Promise<{ width: number; height: number } | null> => {
  try {
    const IMAGE_FETCH_TIMEOUT = 60000;
    const response = await fetchWithTimeout(imageUrl, {}, IMAGE_FETCH_TIMEOUT);
    if (!response.ok) {
      return null;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    // Use photon for reliable dimension detection (handles JPEG, PNG, WebP, GIF, etc.)
    const img = PhotonImage.new_from_byteslice(bytes);
    const width = img.get_width();
    const height = img.get_height();
    img.free(); // Important: free WASM memory

    if (width > 0 && height > 0) {
      return { width, height };
    }
    return null;
  } catch (error) {
    return null;
  }
};

// Get extended image dimensions with EXIF info for debugging
export const getImageDimensionsExtended = async (imageUrl: string, env: any): Promise<ImageDimensionsExtended | null> => {
  try {
    const IMAGE_FETCH_TIMEOUT = 60000;
    const response = await fetchWithTimeout(imageUrl, {
      headers: { Range: 'bytes=0-65535' }
    }, IMAGE_FETCH_TIMEOUT);

    let arrayBuffer: ArrayBuffer;
    if (!response.ok && response.status !== 206) {
      const fullResponse = await fetchWithTimeout(imageUrl, {}, IMAGE_FETCH_TIMEOUT);
      if (!fullResponse.ok) return null;
      arrayBuffer = await fullResponse.arrayBuffer();
    } else {
      arrayBuffer = await response.arrayBuffer();
    }

    return parseImageDimensionsExtended(new Uint8Array(arrayBuffer));
  } catch (error) {
    return null;
  }
};

// Parse EXIF orientation from JPEG APP1 segment
// Returns orientation value 1-8, or 1 (normal) if not found
// Orientation values: 1=normal, 2=flip-h, 3=180°, 4=flip-v, 5=90°CW+flip-h, 6=90°CW, 7=90°CCW+flip-h, 8=90°CCW
// For orientations 5,6,7,8 the displayed width/height are swapped from stored pixels
const parseJpegExifOrientation = (data: Uint8Array): number => {
  let i = 2;
  while (i < data.length - 4) {
    if (data[i] !== 0xFF) { i++; continue; }
    const marker = data[i + 1];

    // APP1 marker (0xE1) contains EXIF data
    if (marker === 0xE1) {
      const segmentLength = (data[i + 2] << 8) | data[i + 3];
      if (segmentLength < 8 || i + 2 + segmentLength > data.length) break;

      // Check for "Exif\0\0" identifier at offset i+4
      if (data[i + 4] === 0x45 && data[i + 5] === 0x78 && data[i + 6] === 0x69 &&
          data[i + 7] === 0x66 && data[i + 8] === 0x00 && data[i + 9] === 0x00) {

        const tiffStart = i + 10; // TIFF header starts after "Exif\0\0"
        if (tiffStart + 8 > data.length) break;

        // Check byte order: "II" (0x4949) = little-endian, "MM" (0x4D4D) = big-endian
        const isLittleEndian = data[tiffStart] === 0x49 && data[tiffStart + 1] === 0x49;
        const isBigEndian = data[tiffStart] === 0x4D && data[tiffStart + 1] === 0x4D;
        if (!isLittleEndian && !isBigEndian) break;

        // Read functions based on endianness
        const readU16 = (offset: number): number => {
          if (offset + 1 >= data.length) return 0;
          return isLittleEndian
            ? (data[offset] | (data[offset + 1] << 8))
            : ((data[offset] << 8) | data[offset + 1]);
        };
        const readU32 = (offset: number): number => {
          if (offset + 3 >= data.length) return 0;
          return isLittleEndian
            ? (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24))
            : ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]);
        };

        // Get IFD0 offset (at TIFF header + 4)
        const ifd0Offset = readU32(tiffStart + 4);
        if (ifd0Offset < 8 || tiffStart + ifd0Offset + 2 > data.length) break;

        // Read IFD0 entries
        const numEntries = readU16(tiffStart + ifd0Offset);
        for (let e = 0; e < numEntries && e < 50; e++) {
          const entryOffset = tiffStart + ifd0Offset + 2 + (e * 12);
          if (entryOffset + 12 > data.length) break;

          const tag = readU16(entryOffset);
          // Orientation tag = 0x0112
          if (tag === 0x0112) {
            const orientation = readU16(entryOffset + 8);
            if (orientation >= 1 && orientation <= 8) {
              return orientation;
            }
          }
        }
      }
      break; // Only check first APP1 segment
    }

    // Skip to next segment
    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; } // SOI/EOI have no length
    if (marker === 0x00 || marker === 0xFF) { i++; continue; } // Padding
    if (i + 3 >= data.length) break;
    const segLen = (data[i + 2] << 8) | data[i + 3];
    if (segLen < 2) break;
    i += 2 + segLen;
  }
  return 1; // Default: normal orientation
};

// Parse image dimensions from JPEG, PNG, or WebP headers
// Based on proven image-size npm package algorithm
const parseImageDimensions = (data: Uint8Array): { width: number; height: number } | null => {
  if (data.length < 24) return null;

  // Check for JPEG (starts with FF D8)
  if (data[0] === 0xFF && data[1] === 0xD8) {
    // Algorithm from image-size npm package (proven, widely used)
    // Start after SOI (FFD8) + first marker (FFxx) = skip 4 bytes
    let offset = 4;
    let bestDimensions: { width: number; height: number } | null = null;

    while (offset < data.length) {
      // Read segment length (2 bytes, big-endian)
      if (offset + 1 >= data.length) break;
      const blockLength = (data[offset] << 8) | data[offset + 1];
      if (blockLength < 2) break;

      // Check if we have enough data
      if (offset + blockLength >= data.length) break;

      // Every JPEG block must begin with 0xFF
      if (data[offset + blockLength] !== 0xFF) {
        offset += 1;
        continue;
      }

      // Check for SOF markers at blockLength + 1
      const marker = data[offset + blockLength + 1];
      // 0xC0 = baseline, 0xC1 = extended, 0xC2 = progressive
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        // SOF found! Read dimensions at blockLength + 5
        // Structure: FF Cx LL LL PP HH HH WW WW
        // blockLength points to LL LL of current segment
        // blockLength + 5 points to HH HH of SOF
        if (offset + blockLength + 8 < data.length) {
          const height = (data[offset + blockLength + 5] << 8) | data[offset + blockLength + 6];
          const width = (data[offset + blockLength + 7] << 8) | data[offset + blockLength + 8];
          if (width > 0 && height > 0 && width < 65536 && height < 65536) {
            // Skip thumbnail dimensions (typically < 300px) - keep looking for main image
            // EXIF thumbnails are embedded within APP1 segment but parser may find them
            if (width >= 300 || height >= 300) {
              return { width, height }; // Found main image dimensions
            }
            // Store as fallback in case no larger dimensions found
            if (!bestDimensions || (width * height > bestDimensions.width * bestDimensions.height)) {
              bestDimensions = { width, height };
            }
          }
        }
      }

      // Move to next block: skip marker (2 bytes) + current block
      offset += blockLength + 2;
    }

    // Return best dimensions found (could be thumbnail if main not found)
    return bestDimensions;
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
  
  // Check for WebP (starts with RIFF...WEBP)
  // WebP format: RIFF (4 bytes) + file size (4 bytes) + WEBP (4 bytes) + chunk type (4 bytes)
  if (data.length >= 30 && 
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    // Check for VP8 (lossy) - chunk type at offset 12
    if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x20) {
      // VP8 format: chunk header (4 bytes) + frame tag (3 bytes) + dimensions
      // Width and height are in little-endian format at offsets 26-29
      if (data.length >= 30) {
        const width = ((data[26] | (data[27] << 8)) & 0x3FFF) + 1;
        const height = ((data[28] | (data[29] << 8)) & 0x3FFF) + 1;
        if (width > 0 && height > 0 && width < 65536 && height < 65536) {
          return { width, height };
        }
      }
    }
    // Check for VP8L (lossless) - chunk type at offset 12
    else if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x4C) {
      // VP8L format: chunk header (4 bytes) + signature (1 byte) + dimensions (4 bytes)
      // Dimensions are packed: 14-bit width + 1 + 14-bit height + 1
      if (data.length >= 25) {
        const bits = (data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24));
        const width = (bits & 0x3FFF) + 1;
        const height = ((bits >> 14) & 0x3FFF) + 1;
        if (width > 0 && height > 0 && width < 65536 && height < 65536) {
          return { width, height };
        }
      }
    }
    // Check for VP8X (extended) - chunk type at offset 12
    else if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x58) {
      // VP8X format: chunk header (4 bytes) + flags (1 byte) + reserved (3 bytes) + dimensions (6 bytes)
      // Width and height are 24-bit little-endian at offsets 24-29
      if (data.length >= 30) {
        const width = data[24] | (data[25] << 8) | (data[26] << 16);
        const height = data[27] | (data[28] << 8) | (data[29] << 16);
        if (width > 0 && height > 0 && width < 16777216 && height < 16777216) {
          return { width: width + 1, height: height + 1 };
        }
      }
    }
  }
  
  return null;
};

// Parse image dimensions with extended info (for debugging)
// Returns both raw and display dimensions plus EXIF orientation
const parseImageDimensionsExtended = (data: Uint8Array): ImageDimensionsExtended | null => {
  if (data.length < 24) return null;

  // Check for JPEG (starts with FF D8)
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
            const rawHeight = (data[i + 5] << 8) | data[i + 6];
            const rawWidth = (data[i + 7] << 8) | data[i + 8];
            if (rawWidth > 0 && rawHeight > 0 && rawWidth < 65536 && rawHeight < 65536) {
              return {
                width: rotated ? rawHeight : rawWidth,
                height: rotated ? rawWidth : rawHeight,
                rawWidth,
                rawHeight,
                orientation,
                rotated,
              };
            }
          }
        }
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

  // PNG - no EXIF rotation
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47 &&
      data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A) {
    if (data.length >= 24) {
      const width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
      const height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
      if (width > 0 && height > 0 && width < 2147483647 && height < 2147483647) {
        return { width, height, rawWidth: width, rawHeight: height, orientation: 1, rotated: false };
      }
    }
  }

  // WebP - no EXIF rotation in standard parsing
  if (data.length >= 30 &&
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x20) {
      if (data.length >= 30) {
        const width = ((data[26] | (data[27] << 8)) & 0x3FFF) + 1;
        const height = ((data[28] | (data[29] << 8)) & 0x3FFF) + 1;
        if (width > 0 && height > 0 && width < 65536 && height < 65536) {
          return { width, height, rawWidth: width, rawHeight: height, orientation: 1, rotated: false };
        }
      }
    } else if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x4C) {
      if (data.length >= 25) {
        const bits = (data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24));
        const width = (bits & 0x3FFF) + 1;
        const height = ((bits >> 14) & 0x3FFF) + 1;
        if (width > 0 && height > 0 && width < 65536 && height < 65536) {
          return { width, height, rawWidth: width, rawHeight: height, orientation: 1, rotated: false };
        }
      }
    } else if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x58) {
      if (data.length >= 30) {
        const width = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1;
        const height = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1;
        if (width > 0 && height > 0 && width < 16777216 && height < 16777216) {
          return { width, height, rawWidth: width, rawHeight: height, orientation: 1, rotated: false };
        }
      }
    }
  }

  return null;
};

// Calculate aspect ratio from dimensions and find closest supported Vertex ratio
// Vertex AI only accepts: 1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
export const getClosestAspectRatio = (width: number, height: number, supportedRatios: string[]): string => {
  if (width <= 0 || height <= 0 || !Array.isArray(supportedRatios) || supportedRatios.length === 0) {
    return '3:4';
  }
  
  // Filter out "original" if present - only use valid ratio strings
  const validRatios = supportedRatios.filter(r => r !== 'original' && typeof r === 'string' && /^\d+:\d+$/.test(r));
  if (validRatios.length === 0) {
    return '3:4';
  }
  
  const actualRatio = width / height;
  const isPortrait = height > width;
  const isLandscape = width > height;
  const isSquare = Math.abs(width - height) < 10; // Allow small tolerance for square images
  
  // Filter ratios by orientation to prevent cropping
  // For portrait images, prefer portrait ratios (height > width)
  // For landscape images, prefer landscape ratios (width > height)
  // For square images, prefer square or closest match
  let orientationFilteredRatios = validRatios;
  if (isPortrait) {
    // Prefer portrait ratios (2:3, 3:4, 4:5, 9:16) - height > width
    orientationFilteredRatios = validRatios.filter(r => {
      const [w, h] = r.split(':').map(Number);
      return h > w;
    });
    // If no portrait ratios found, fall back to all ratios
    if (orientationFilteredRatios.length === 0) {
      orientationFilteredRatios = validRatios;
    }
  } else if (isLandscape) {
    // Prefer landscape ratios (3:2, 4:3, 5:4, 16:9, 21:9) - width > height
    orientationFilteredRatios = validRatios.filter(r => {
      const [w, h] = r.split(':').map(Number);
      return w > h;
    });
    // If no landscape ratios found, fall back to all ratios
    if (orientationFilteredRatios.length === 0) {
      orientationFilteredRatios = validRatios;
    }
  }
  // For square images, prefer 1:1 but allow all ratios
  
  let closestRatio = orientationFilteredRatios[0];
  let minDiff = Infinity;
  
  for (const ratioStr of orientationFilteredRatios) {
    const [w, h] = ratioStr.split(':').map(Number);
    if (w <= 0 || h <= 0) continue;
    
    const ratioValue = w / h;
    const diff = Math.abs(actualRatio - ratioValue);
    
    if (diff < minDiff) {
      minDiff = diff;
      closestRatio = ratioStr;
    }
  }
  
  // Final validation - must be in validRatios list
  if (!validRatios.includes(closestRatio)) {
    return validRatios[0] || '3:4';
  }
  
  return closestRatio;
};

// Unified function to resolve aspect ratio for all APIs
// Supports both faceswap (no "original") and non-faceswap (with "original") endpoints
export const resolveAspectRatio = async (
  aspectRatio: string | undefined | null,
  imageUrl: string | undefined | null,
  env: any,
  options: {
    allowOriginal?: boolean; // If true, "original" will calculate from image. If false, "original" is treated as invalid.
    defaultRatio?: string; // Default ratio if calculation fails
    supportedRatios?: string[]; // Optional: override supported ratios
  } = {}
): Promise<string> => {
  const { allowOriginal = false, defaultRatio, supportedRatios: customSupportedRatios } = options;
  const supportedRatios = customSupportedRatios || ASPECT_RATIO_CONFIG.SUPPORTED;
  const fallbackDefault = defaultRatio || ASPECT_RATIO_CONFIG.DEFAULT;
  
  // If aspect_ratio is "original" or undefined/null and original is allowed, calculate from image
  if (allowOriginal && (!aspectRatio || aspectRatio === 'original' || aspectRatio === '')) {
    if (!imageUrl) {
      return fallbackDefault;
    }
    
    const dimensions = await getImageDimensions(imageUrl, env);
    if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
      // Calculate closest supported ratio from actual image dimensions
      const closestRatio = getClosestAspectRatio(dimensions.width, dimensions.height, supportedRatios);
      // Final validation - must be a valid supported ratio (never "original")
      if (closestRatio && closestRatio !== 'original' && supportedRatios.includes(closestRatio)) {
        return closestRatio;
      }
      return fallbackDefault;
    } else {
      return fallbackDefault;
    }
  }
  
  // If "original" is not allowed but was provided, treat as invalid
  if (aspectRatio === 'original' && !allowOriginal) {
    return fallbackDefault;
  }
  
  // Validate and return supported ratio, or default
  const validRatio = supportedRatios.includes(aspectRatio || '') ? (aspectRatio || fallbackDefault) : fallbackDefault;
  return validRatio;
};

export const getWorstViolation = (
  annotation: {
    adult: string;
    violence: string;
    racy: string;
    medical?: string;
    spoof?: string;
  }
): { code: number; category: string; level: string } | null => {
  // Only check levels that should be blocked
  const unsafeLevels = UNSAFE_LEVELS;
  const violations: Array<{ category: string; level: string; severity: number; code: number }> = [];

  // Define category mappings
  const categories = [
    { key: 'adult', code: SAFETY_STATUS_CODES.ADULT },
    { key: 'violence', code: SAFETY_STATUS_CODES.VIOLENCE },
    { key: 'racy', code: SAFETY_STATUS_CODES.RACY },
    { key: 'medical', code: SAFETY_STATUS_CODES.MEDICAL },
    { key: 'spoof', code: SAFETY_STATUS_CODES.SPOOF },
  ];

  // Check each category - only include violations that should be blocked
  for (const { key, code } of categories) {
    const level = annotation[key as keyof typeof annotation];
    if (level && unsafeLevels.includes(level)) {
      violations.push({
        category: key,
        level,
        severity: getSeverity(level),
        code,
      });
    }
  }

  if (violations.length === 0) {
    return null; // No blocking violations
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
    // Check blockedReason (any block reason indicates safety violation)
    if (promptFeedback.blockedReason) {
      const blockedReason = promptFeedback.blockedReason;
      // Map blocked reason to category (if it's a harm category)
      const category = blockedReason.replace('BLOCKED_REASON_', '').replace('SAFETY_', '');
      const code = VERTEX_HARM_CATEGORY_MAP[`HARM_CATEGORY_${category}`];
      // Only return if we found a specific category code (2001-2004)
      if (code && (code >= 2001 && code <= 2004)) {
        return {
          code,
          category: category.toLowerCase().replace(/_/g, ' ') || 'safety violation',
          reason: `Input blocked: ${blockedReason}`,
        };
      }
      // If no specific category found, return unknown error
      return {
        code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        category: 'vertex unknown error',
        reason: `Input blocked: ${blockedReason} - Unable to determine specific violation category`,
      };
    }

    // Check blockReason (alternative field name)
    if (promptFeedback.blockReason) {
      const blockedReason = promptFeedback.blockReason;
      const category = blockedReason.replace('BLOCKED_REASON_', '').replace('SAFETY_', '');
      const code = VERTEX_HARM_CATEGORY_MAP[`HARM_CATEGORY_${category}`];
      // Only return if we found a specific category code (2001-2004)
      if (code && (code >= 2001 && code <= 2004)) {
        return {
          code,
          category: category.toLowerCase().replace(/_/g, ' ') || 'safety violation',
          reason: `Input blocked: ${blockedReason}`,
        };
      }
      // If no specific category found, return unknown error
      return {
        code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        category: 'vertex unknown error',
        reason: `Input blocked: ${blockedReason} - Unable to determine specific violation category`,
      };
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
        // Only return if we found a specific category code (2001-2004)
        if (code && (code >= 2001 && code <= 2004)) {
          return {
            code,
            category: (category || 'HARM_CATEGORY_UNKNOWN').replace('HARM_CATEGORY_', '').toLowerCase().replace(/_/g, ' '),
            reason: `Input blocked: ${category || 'safety'} (${probability || 'blocked'})`,
          };
        }
      }
    }
  }

  // Check for candidate finish reason (output blocked)
  const candidates = responseData.candidates || [];
  for (const candidate of candidates) {
    const finishReason = candidate.finishReason;
    const parts = candidate.content?.parts || [];
    
    // Check if image is present
    const hasImage = parts.some((part: any) => part.inlineData || part.inline_data);
    
    // Extract text from parts
    const textParts = parts.filter((part: any) => part.text).map((part: any) => part.text);
    const refusalText = textParts.join(' ');
    
    // Check for safety blocks: explicit safety reasons OR STOP with no image
    const isSafetyBlock = finishReason === 'SAFETY' || 
                          finishReason === 'IMAGE_SAFETY' ||
                          finishReason === 'RECITATION' || 
                          finishReason === 'BLOCKED' ||
                          finishReason === 'PROHIBITED_CONTENT' ||
                          finishReason === 'BLOCKLIST' ||
                          finishReason === 'SPII' ||
                          (finishReason === 'STOP' && !hasImage);
    
    if (isSafetyBlock) {
      const safetyRatings = candidate.safetyRatings || [];
      const finishMessage = candidate.finishMessage || refusalText || '';
      
      // Check safety ratings first
      for (const rating of safetyRatings) {
        const category = rating.category;
        const probability = rating.probability || rating.harmProbability;
        const blocked = rating.blocked;
        
        if (blocked === true || probability === 'HIGH' || probability === 'MEDIUM') {
          const code = VERTEX_HARM_CATEGORY_MAP[category];
          if (code && (code >= 2001 && code <= 2004)) {
            return {
              code,
              category: (category || 'HARM_CATEGORY_UNKNOWN').replace('HARM_CATEGORY_', '').toLowerCase().replace(/_/g, ' '),
              reason: finishMessage || `Output blocked: ${category || 'safety'} (${probability || 'blocked'})`,
            };
          }
        }
      }
      
      // If safety ratings found but no specific category blocked, try to detect from text
      // Combine finishMessage and refusalText for keyword analysis
      const analysisText = (finishMessage + ' ' + refusalText).toLowerCase();

      // Detect specific harm categories from text keywords (Vertex AI internal blocks)
      // SEXUALLY_EXPLICIT (2003): sexual, nude, explicit, adult, pornographic, nsfw
      if (/sexual|nude|naked|explicit|adult|pornograph|nsfw|genital|breast|buttock/i.test(analysisText)) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.SEXUALLY_EXPLICIT,
          category: 'sexually explicit',
          reason: finishMessage || refusalText || `Output blocked: ${finishReason} - sexually explicit content detected`,
        };
      }

      // DANGEROUS_CONTENT (2004): weapon, violence, harm, kill, dangerous, drug, bomb
      if (/weapon|gun|violen|harm|kill|danger|drug|bomb|explos|attack|murder|shoot|stab/i.test(analysisText)) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.DANGEROUS_CONTENT,
          category: 'dangerous content',
          reason: finishMessage || refusalText || `Output blocked: ${finishReason} - dangerous content detected`,
        };
      }

      // HATE_SPEECH (2001): hate, racist, discrimination, slur, bigot
      if (/hate|racist|discriminat|slur|bigot|ethnic|antisemit|homophob|xenophob/i.test(analysisText)) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.HATE_SPEECH,
          category: 'hate speech',
          reason: finishMessage || refusalText || `Output blocked: ${finishReason} - hate speech detected`,
        };
      }

      // HARASSMENT (2002): harass, bully, threaten, intimidate, abuse
      if (/harass|bully|threaten|intimidat|abus|stalk|torment/i.test(analysisText)) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.HARASSMENT,
          category: 'harassment',
          reason: finishMessage || refusalText || `Output blocked: ${finishReason} - harassment detected`,
        };
      }

      // Check if refusal is from our CONTENT_SAFETY_INSTRUCTION (prompt-based policy - 3001)
      // Keywords specific to our instruction: "content policy", "exposed sensitive body", "wholesome", "modest"
      const isPromptPolicyRefusal = /content policy|exposed sensitive|provocative|wholesome|modest|non-revealing|appropriate for all audiences/i.test(analysisText);
      if (isPromptPolicyRefusal) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.PROMPT_CONTENT_POLICY,
          category: 'prompt content policy',
          reason: refusalText || finishMessage,
        };
      }

      // If safetyRatings exist but no specific match, return unknown
      if (safetyRatings.length > 0) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          category: 'vertex unknown error',
          reason: finishMessage || 'Output blocked - Unable to determine specific violation category',
        };
      }

      // Generic model refusal with no specific category detected
      if (refusalText && /i cannot|beyond my|unable to|not able to|can't help|cannot help/i.test(refusalText.toLowerCase())) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          category: 'vertex unknown error',
          reason: refusalText,
        };
      }

      // Default: return unknown error
      return {
        code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
        category: 'vertex unknown error',
        reason: finishMessage || `Output blocked: ${finishReason} - Unable to determine specific violation category`,
      };
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
  env: Env,
  scope: string = 'https://www.googleapis.com/auth/cloud-platform'
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
    scope,
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

/**
 * Purge CDN cache for specific URLs using Cloudflare API
 * Requires CLOUDFLARE_ZONE_ID and CLOUDFLARE_CDN_PURGE_TOKEN environment variables
 * @param urls - Array of full URLs to purge from cache
 * @param env - Environment variables
 * @returns Promise<{ success: boolean; purged?: number; error?: string }>
 */
export const purgeCdnCache = async (
  urls: string[],
  env: Env
): Promise<{ success: boolean; purged?: number; error?: string; skipped?: boolean }> => {
  // Check if CDN purge is enabled
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  const apiToken = env.CLOUDFLARE_CDN_PURGE_TOKEN;

  if (!zoneId || !apiToken) {
    // CDN purge not configured - skip silently
    return { success: true, skipped: true };
  }

  if (!urls || urls.length === 0) {
    return { success: true, purged: 0, skipped: true };
  }

  try {
    // Cloudflare API: POST /zones/{zone_id}/purge_cache
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          files: urls,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error('[CDN Purge] Failed:', {
        status: response.status,
        error: errorText.substring(0, 200),
        urls: urls.length,
      });
      return {
        success: false,
        error: `CDN purge failed: ${response.status} ${errorText.substring(0, 100)}`,
      };
    }

    const result = await response.json() as any;

    if (result.success === false) {
      console.error('[CDN Purge] API returned success=false:', {
        errors: result.errors,
        urls: urls.length,
      });
      return {
        success: false,
        error: result.errors?.[0]?.message || 'CDN purge API returned success=false',
      };
    }

    console.log('[CDN Purge] Success:', {
      purged: urls.length,
      urls: urls,
    });

    return {
      success: true,
      purged: urls.length,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[CDN Purge] Exception:', {
      error: errorMsg.substring(0, 200),
      urls: urls.length,
    });
    return {
      success: false,
      error: `CDN purge exception: ${errorMsg.substring(0, 100)}`,
    };
  }
};

// Calculate optimal output size scaled to max dimension (default 1536px for best quality)
// Scales proportionally so the larger dimension equals maxDim
export const calculateOptimalSize = (
  width: number,
  height: number,
  maxDim: number = 1536,
  minDim: number = 256
): { width: number; height: number; sizeString: string } => {
  // Scale proportionally so the larger dimension = maxDim
  const scale = maxDim / Math.max(width, height);
  let newWidth = Math.round(width * scale);
  let newHeight = Math.round(height * scale);

  // Clamp to bounds
  newWidth = Math.max(minDim, Math.min(maxDim, newWidth));
  newHeight = Math.max(minDim, Math.min(maxDim, newHeight));

  return {
    width: newWidth,
    height: newHeight,
    sizeString: `${newWidth}x${newHeight}`,
  };
};

// ============================================================
// Payment & Credit System Utilities
// ============================================================

/**
 * Get credit cost for an action, applying tier multiplier.
 * All values come from env vars (CREDIT_COST_*, TIER_MULTIPLIER_*).
 */
export const getCreditCost = (action: string, tier: string, env: Env): number => {
  const costKey = `CREDIT_COST_${action.toUpperCase()}`;
  const baseCost = parseInt(env[costKey] || '1', 10);

  const multiplierKey = `TIER_MULTIPLIER_${tier.toUpperCase()}`;
  const multiplier = parseFloat(env[multiplierKey] || '1.0');

  return Math.max(1, Math.ceil(baseCost * multiplier));
};

/**
 * Write an entry to the audit_log table.
 */
export const auditLog = async (
  db: D1Database,
  profileId: string,
  action: string,
  details: Record<string, any> | null,
  ipAddress: string | null
): Promise<void> => {
  try {
    await db.prepare(
      'INSERT INTO audit_log (profile_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).bind(profileId, action, details ? JSON.stringify(details) : null, ipAddress).run();
  } catch (error) {
    console.error('[AuditLog] Failed to write:', error instanceof Error ? error.message : String(error));
  }
};
