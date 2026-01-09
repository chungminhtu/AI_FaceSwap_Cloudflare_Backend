// backend-cloudflare-workers/utils.ts
import type { Env } from './types';

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
  HATE_SPEECH: 2001, // Lời lẽ kích động thù hận: Những bình luận tiêu cực hoặc gây hại nhắm vào danh tính và/hoặc các thuộc tính được bảo vệ.
  HARASSMENT: 2002, // Quấy rối: Những lời lẽ đe dọa, hăm dọa, bắt nạt hoặc lăng mạ nhắm vào người khác.
  SEXUALLY_EXPLICIT: 2003, // Nội dung khiêu dâm: Có chứa nội dung liên quan đến hành vi tình dục hoặc các nội dung khiêu dâm khác.
  DANGEROUS_CONTENT: 2004, // Nội dung nguy hiểm: Thúc đẩy hoặc tạo điều kiện tiếp cận các hàng hóa, dịch vụ và hoạt động có hại.
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

// Default: Only block VERY_LIKELY (loose mode)
// Strict mode: Block POSSIBLE, LIKELY, and VERY_LIKELY
export const getUnsafeLevels = (strictness: 'strict' | 'lenient'): string[] => {
  if (strictness === 'strict') {
    return ['POSSIBLE', 'LIKELY', 'VERY_LIKELY'];
  }
  return ['VERY_LIKELY'];
};

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
  if (width <= 0 || height <= 0) {
    console.warn('[getClosestAspectRatio] Invalid dimensions:', { width, height });
    return supportedRatios[0] || '3:4';
  }
  
  const actualRatio = width / height;
  
  // Parse supported ratios and find closest match
  let closestRatio = supportedRatios[0];
  let minDiff = Infinity;
  
  for (const ratioStr of supportedRatios) {
    const [w, h] = ratioStr.split(':').map(Number);
    if (w <= 0 || h <= 0) continue;
    
    const ratioValue = w / h;
    const diff = Math.abs(actualRatio - ratioValue);
    
    if (diff < minDiff) {
      minDiff = diff;
      closestRatio = ratioStr;
    }
  }
  
  console.log('[getClosestAspectRatio]', { width, height, actualRatio: actualRatio.toFixed(3), closestRatio, minDiff: minDiff.toFixed(4) });
  return closestRatio;
};

export const getWorstViolation = (
  annotation: {
    adult: string;
    violence: string;
    racy: string;
    medical?: string;
    spoof?: string;
  },
  strictness: 'strict' | 'lenient' = 'strict'
): { code: number; category: string; level: string } | null => {
  // Only check levels that should be blocked based on strictness
  const unsafeLevels = getUnsafeLevels(strictness);
  const violations: Array<{ category: string; level: string; severity: number; code: number }> = [];

  // Define category mappings
  const categories = [
    { key: 'adult', code: SAFETY_STATUS_CODES.ADULT },
    { key: 'violence', code: SAFETY_STATUS_CODES.VIOLENCE },
    { key: 'racy', code: SAFETY_STATUS_CODES.RACY },
    { key: 'medical', code: SAFETY_STATUS_CODES.MEDICAL },
    { key: 'spoof', code: SAFETY_STATUS_CODES.SPOOF },
  ];

  // Check each category - only include violations that match strictness (should be blocked)
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
      
      // If safety ratings found but no specific category, return unknown error
      if (safetyRatings.length > 0) {
        return {
          code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
          category: 'vertex unknown error',
          reason: finishMessage || 'Output blocked - Unable to determine specific violation category',
        };
      }
      
      // If no safety ratings but has refusal text, treat as capability refusal
      if (refusalText) {
        const lowerText = refusalText.toLowerCase();
        const isRefusal = /i cannot|beyond my|unable to fulfill|not able to/i.test(lowerText);
        if (isRefusal) {
          return {
            code: VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR,
            category: 'vertex unknown error',
            reason: refusalText,
          };
        }
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
