/// <reference types="@cloudflare/workers-types" />

import { customAlphabet } from 'nanoid';
const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_', 21);
import JSZip from 'jszip';
import type { Env, FaceSwapRequest, FaceSwapResponse, Profile, BackgroundRequest } from './types';
import { CORS_HEADERS, getCorsHeaders, jsonResponse, errorResponse, successResponse, validateImageUrl, fetchWithTimeout, getImageDimensions, getClosestAspectRatio, resolveAspectRatio, promisePoolWithConcurrency, normalizePresetId } from './utils';
import { callFaceSwap, callNanoBanana, callNanoBananaMerge, checkSafeSearch, checkImageSafetyWithFlashLite, generateVertexPrompt, callUpscaler4k, generateBackgroundFromPrompt } from './services';
import { validateEnv, validateRequest } from './validators';
import { VERTEX_AI_PROMPTS, IMAGE_PROCESSING_PROMPTS, ASPECT_RATIO_CONFIG, CACHE_CONFIG, TIMEOUT_CONFIG } from './config';

// Retry helper for Vertex AI prompt generation - MUST succeed before uploading to R2
const generateVertexPromptWithRetry = async (
  imageUrl: string,
  env: Env,
  isFilterMode: boolean = false,
  customPromptText: string | null = null,
  maxRetries: number = 15,
  initialDelay: number = 2000
): Promise<{ success: boolean; prompt?: any; error?: string; debug?: any }> => {
  let lastError: string | undefined;
  let lastDebug: any;
  
  // Check if error is retryable (transient errors that might succeed on retry)
  const isRetryableError = (error: string, debug?: any): boolean => {
    if (!error) return true; // Unknown errors are retryable
    const errorLower = error.toLowerCase();
    const httpStatus = debug?.httpStatus;

    // Don't retry on permanent errors (4xx except 429)
    if (httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
      return false; // Client errors (except rate limit) are not retryable
    }

    // Always retry on JSON parsing errors (even with 200 OK) - Vertex AI sometimes returns incomplete responses
    if (errorLower.includes('no valid json') || errorLower.includes('could not extract')) {
      return true; // JSON parsing failures are retryable
    }

    // Retry on: network errors, timeouts, rate limits, server errors (5xx)
    return errorLower.includes('timeout') ||
           errorLower.includes('network') ||
           errorLower.includes('429') ||
           errorLower.includes('rate limit') ||
           errorLower.includes('503') ||
           errorLower.includes('502') ||
           errorLower.includes('500') ||
           httpStatus === undefined || // Unknown status, retry
           (httpStatus >= 500 && httpStatus < 600); // Server errors
  };
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await generateVertexPrompt(imageUrl, env, isFilterMode, customPromptText);

      if (result.success && result.prompt) {
        if (attempt > 0) {
          console.log(`[Vertex Prompt Retry] Success on attempt ${attempt + 1}/${maxRetries}`);
        }
        return result;
      }

      // Log retry attempts for debugging
      if (attempt > 0 || (result.error && (result.error.includes('JSON') || result.error.includes('extract')))) {
        console.log(`[Vertex Prompt Retry] Attempt ${attempt + 1}/${maxRetries} failed: ${result.error}`);
      }
      
      // Store error for final return if all retries fail
      lastError = result.error || 'Unknown error';
      lastDebug = result.debug;
      
      // Check if error is retryable
      if (!isRetryableError(lastError, lastDebug)) {
        console.warn(`[Vertex Prompt Retry] Non-retryable error on attempt ${attempt + 1}: ${lastError}`);
        return {
          success: false,
          error: lastError,
          debug: {
            ...lastDebug,
            totalAttempts: attempt + 1,
            finalError: lastError
          }
        };
      }
      
      // If not last attempt, wait before retrying (exponential backoff with jitter)
      if (attempt < maxRetries - 1) {
        const baseDelay = initialDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 0.3 * baseDelay; // Add up to 30% jitter
        const maxDelay = maxRetries <= 3 ? 5000 : 30000; // Cap at 5s for fast retries, 30s for normal
        const delay = Math.min(baseDelay + jitter, maxDelay);
        console.warn(`[Vertex Prompt Retry] Attempt ${attempt + 1}/${maxRetries} failed: ${lastError}. Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      lastDebug = { errorDetails: lastError };
      
      // Check if error is retryable
      if (!isRetryableError(lastError, lastDebug)) {
        console.warn(`[Vertex Prompt Retry] Non-retryable exception on attempt ${attempt + 1}: ${lastError}`);
        return {
          success: false,
          error: lastError,
          debug: lastDebug
        };
      }
      
      // If not last attempt, wait before retrying
      if (attempt < maxRetries - 1) {
        const baseDelay = initialDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 0.3 * baseDelay;
        const maxDelay = maxRetries <= 3 ? 5000 : 30000; // Cap at 5s for fast retries, 30s for normal
        const delay = Math.min(baseDelay + jitter, maxDelay);
        console.warn(`[Vertex Prompt Retry] Attempt ${attempt + 1}/${maxRetries} threw error: ${lastError}. Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // All retries exhausted
  console.error(`[Vertex Prompt Retry] All ${maxRetries} attempts failed. Last error: ${lastError}`);
  return {
    success: false,
    error: lastError || 'All retry attempts failed',
    debug: {
      ...lastDebug,
      totalAttempts: maxRetries,
      retriesExhausted: true,
      finalError: lastError
    }
  };
};

const checkRateLimit = async (env: Env, request: Request, path: string): Promise<boolean> => {
  if (!env.RATE_LIMITER) return true;
  
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';
  const result = await env.RATE_LIMITER.limit({ key: `${ip}:${path}` });
  return result.success;
};

const constantTimeCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

const checkApiKey = (env: Env, request: Request): boolean => {
  const authEnabled = env.ENABLE_MOBILE_API_KEY_AUTH === 'true' || env.ENABLE_MOBILE_API_KEY_AUTH === true;
  if (!authEnabled) {
    return true;
  }

  const apiKey = request.headers.get('X-API-Key') || 
                 request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  
  if (!apiKey || !env.MOBILE_API_KEY) {
    return false;
  }

  return constantTimeCompare(apiKey, env.MOBILE_API_KEY);
};

const PROTECTED_MOBILE_APIS = [
  '/upload-url',
  '/faceswap',
  '/background',
  '/enhance',
  '/beauty',
  '/filter',
  '/restore',
  '/aging',
  '/upscaler4k',
  '/profiles',
];

const checkRequestSize = (request: Request, maxSizeBytes: number): { valid: boolean; error?: string } => {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (isNaN(size) || size > maxSizeBytes) {
      return { valid: false, error: `Request body too large. Maximum size: ${maxSizeBytes / 1024 / 1024}MB` };
    }
  }
  return { valid: true };
};

const DEFAULT_R2_BUCKET_NAME = '';

// Critical error logging helper for mobile APIs
const logCriticalError = (endpoint: string, error: unknown, request: Request, env: Env, context?: Record<string, any>): void => {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  const requestId = request.headers.get('cf-ray') || 'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  
  // Try to get request body if available (for POST requests)
  let requestBody: any = null;
  try {
    // Don't consume the request body here, just log what we know
    const contentType = request.headers.get('content-type') || '';
    requestBody = {
      contentType,
      hasBody: !!request.body,
      bodySize: request.headers.get('content-length') || 'unknown'
    };
  } catch {
    // Ignore errors when trying to inspect body
  }
  
  const logData = {
    endpoint,
    error: errorMsg,
    stack: errorStack ? errorStack.substring(0, 1000) : undefined,
    request: {
      method: request.method,
      url: request.url,
      path: new URL(request.url).pathname,
      requestId,
      ip,
      userAgent: userAgent.substring(0, 200),
      headers: {
        'content-type': request.headers.get('content-type'),
        'x-api-key': request.headers.get('x-api-key') ? '***present***' : 'missing',
        'authorization': request.headers.get('authorization') ? '***present***' : 'missing'
      },
      body: requestBody
    },
    ...(context || {})
  };
  
  console.error(`[CRITICAL ERROR] ${endpoint}:`, JSON.stringify(logData, null, 2));
};

// Deprecated: Use resolveAspectRatio from utils instead
// Kept for backward compatibility, but all new code should use resolveAspectRatio
const resolveAspectRatioForNonFaceswap = async (
  aspectRatio: string | undefined | null,
  selfieImageUrl: string,
  env: Env
): Promise<string> => {
  return resolveAspectRatio(aspectRatio, selfieImageUrl, env, { allowOriginal: true });
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

// Extract ID from path parameter (e.g., /profiles/{id} -> id)
const extractPathId = (path: string, prefix: string): string | null => {
  if (!path.startsWith(prefix)) return null;
  const parts = path.split(prefix);
  if (parts.length < 2) return null;
  const idPart = parts[1].split('/').filter(p => p)[0] || parts[1].split('?')[0];
  return idPart && idPart.trim() ? idPart.trim() : null;
};

const getR2Bucket = (env: Env): R2Bucket => {
  const bindingName = env.R2_BUCKET_BINDING || env.R2_BUCKET_NAME || DEFAULT_R2_BUCKET_NAME;
  const bucket = (env as any)[bindingName] as R2Bucket;
  if (!bucket) {
    const availableBindings = Object.keys(env).filter(key => 
      env[key] && typeof (env[key] as any).get === 'function'
    );
    throw new Error(`R2 bucket binding '${bindingName}' not found. Available bindings: ${availableBindings.join(', ')}`);
  }
  return bucket;
};

const getPromptCacheKV = (env: Env): KVNamespace | null => {
  const kvBindingName = env.PROMPT_CACHE_KV_BINDING_NAME;
  if (!kvBindingName) {
    return null;
  }
  return (env as any)[kvBindingName] as KVNamespace || null;
};

const getD1Database = (env: Env): D1Database => {
  const bindingName = env.D1_DATABASE_BINDING || env.D1_DATABASE_NAME || 'DB';
  const database = (env as any)[bindingName] as D1Database;
  if (!database) {
    const availableBindings = Object.keys(env).filter(key =>
      env[key] && typeof (env[key] as any).prepare === 'function'
    );
    throw new Error(`D1 database binding '${bindingName}' not found. Available bindings: ${availableBindings.join(', ')}`);
  }
  return database;
};

const ensureSystemPreset = async (DB: D1Database): Promise<string> => {
  const systemPresetId = 'system_no_preset';
  const existing = await DB.prepare('SELECT id FROM presets WHERE id = ?').bind(systemPresetId).first();
  if (!existing) {
    await DB.prepare(
      'INSERT OR IGNORE INTO presets (id, ext, created_at) VALUES (?, ?, ?)'
    ).bind(systemPresetId, 'jpg', Math.floor(Date.now() / 1000)).run();
  }
  return systemPresetId;
};

const ensureSystemSelfie = async (DB: D1Database, profileId: string, imageUrl: string, R2_BUCKET: R2Bucket): Promise<string | null> => {
  try {
    let key = extractR2KeyFromUrl(imageUrl) || imageUrl;
    
    // Extract id and ext from key if it's in new format (selfie/{id}.{ext})
    let id: string | null = null;
    let ext: string = 'jpg';
    
    if (key.startsWith('selfie/')) {
      const keyParts = key.replace('selfie/', '').split('.');
      if (keyParts.length >= 2) {
        ext = keyParts[keyParts.length - 1];
        id = keyParts.slice(0, -1).join('.');
      }
    }
    
    // If we extracted an id, check if it exists
    if (id) {
      const selfieResult = await DB.prepare(
        'SELECT id FROM selfies WHERE id = ? AND profile_id = ? LIMIT 1'
      ).bind(id, profileId).first();
      
      if (selfieResult) {
        return (selfieResult as any).id;
      }
    }
    
    // Create new system selfie with nanoid
    const systemSelfieId = nanoid(16);
    ext = key.includes('.') ? key.split('.').pop() || 'jpg' : 'jpg';
    const newKey = reconstructR2Key(systemSelfieId, ext, 'selfie');
    
    const insertResult = await DB.prepare(
      'INSERT OR IGNORE INTO selfies (id, ext, profile_id, action, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(systemSelfieId, ext, profileId, 'default', Math.floor(Date.now() / 1000)).run();
    
    if (insertResult.success) {
      return systemSelfieId;
    }
    return null;
  } catch (error) {
    return null;
  }
};

const saveResultToDatabase = async (
  DB: D1Database,
  resultUrl: string,
  profileId: string,
  env: Env,
  R2_BUCKET: R2Bucket
): Promise<string | null> => {
  try {
    let resultKey = extractR2KeyFromUrl(resultUrl) || resultUrl;
    
    // Ensure result key has results/ prefix if it's a result file
    if (resultKey && !resultKey.startsWith('results/')) {
      // Check if it looks like a result file (starts with result_, vertex_, merge_, upscaler4k_)
      if (resultKey.startsWith('result_') || resultKey.startsWith('vertex_') || resultKey.startsWith('merge_') || resultKey.startsWith('upscaler4k_')) {
        resultKey = `results/${resultKey}`;
      }
    }
    
    // Extract id and ext from resultKey (format: results/{id}.{ext})
    const keyParts = resultKey.replace('results/', '').split('.');
    if (keyParts.length < 2) {
      return null;
    }
    const ext = keyParts[keyParts.length - 1];
    const id = keyParts.slice(0, -1).join('.');
    
    // Check if result already exists
    const existingResult = await DB.prepare(
      'SELECT id FROM results WHERE id = ? AND profile_id = ? LIMIT 1'
    ).bind(id, profileId).first<{ id: string }>();
    
    // If result already exists, return its ID
    if (existingResult) {
      return existingResult.id;
    }
    
    // Get max history limit (default 10)
    let maxHistory = parseInt(env.RESULT_MAX_HISTORY || '10', 10);
    if (isNaN(maxHistory) || maxHistory < 1) {
      maxHistory = 10; // Default to 10 if invalid
    }
    maxHistory = Math.floor(Math.max(1, maxHistory)); // Ensure it's a positive integer
    
    // Check current count of results for this profile
    const countResult = await DB.prepare(
      'SELECT COUNT(*) as count FROM results WHERE profile_id = ?'
    ).bind(profileId).first<{ count: number }>();
    
    const currentCount = countResult?.count || 0;
    
    // If we're at or over the limit, delete oldest results
    if (currentCount >= maxHistory) {
      const excessCount = Math.floor(Math.max(1, currentCount - maxHistory + 1)); // +1 because we're about to add one, ensure positive integer
      
      // Get oldest results to delete
      const oldResults = await DB.prepare(
        'SELECT id, ext FROM results WHERE profile_id = ? ORDER BY created_at ASC LIMIT ?'
      ).bind(profileId, excessCount).all<{ id: string; ext: string }>();
      
      if (oldResults.results && oldResults.results.length > 0) {
        // Batch delete from database
        let idsToDelete = oldResults.results.map(r => r.id);
        if (idsToDelete.length > 0) {
          if (idsToDelete.length > 100) {
            idsToDelete = idsToDelete.slice(0, 100);
          }
          const placeholders = idsToDelete.map(() => '?').join(',');
          await DB.prepare(`DELETE FROM results WHERE id IN (${placeholders})`).bind(...idsToDelete).run();
          
          // Delete from R2 (non-fatal if it fails)
          for (const oldResult of oldResults.results) {
            const r2Key = reconstructR2Key(oldResult.id, oldResult.ext, 'results');
            try {
              await R2_BUCKET.delete(r2Key);
            } catch (r2Error) {
              // Ignore R2 deletion errors
            }
          }
        }
      }
    }
    
    // Insert new result
    const insertResult = await DB.prepare(
      'INSERT INTO results (id, ext, profile_id, created_at) VALUES (?, ?, ?, ?)'
    ).bind(id, ext, profileId, Math.floor(Date.now() / 1000)).run();
    
    if (insertResult.success) {
      return id;
    }
    
    return null;
  } catch (dbError) {
    return null;
  }
};

const resolveBucketName = (env: Env): string => env.R2_BUCKET_NAME || DEFAULT_R2_BUCKET_NAME;

const getR2PublicUrl = (env: Env, key: string, fallbackOrigin?: string): string => {
  if (env.R2_DOMAIN) {
    return `${trimTrailingSlash(env.R2_DOMAIN)}/${key}`;
  }
  if (fallbackOrigin) {
    const bucketName = resolveBucketName(env);
    return `${trimTrailingSlash(fallbackOrigin)}/r2/${bucketName}/${key}`;
  }
  throw new Error('Unable to determine R2 public URL. Configure R2_DOMAIN environment variable.');
};

const extractR2KeyFromUrl = (url: string): string | null => {
  if (!url) return null;
  try {
    // Handle r2:// protocol
    if (url.startsWith('r2://')) {
      return url.replace('r2://', '');
    }
    
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    
    // Handle /r2/bucket/key format
    if (urlObj.pathname.startsWith('/r2/')) {
      if (pathParts.length >= 3 && pathParts[0] === 'r2') {
        return pathParts.slice(2).join('/');
      }
    }
    
    // For custom domain URLs, extract the full path
    if (pathParts.length > 0) {
      const fullPath = pathParts.join('/');
      
      // If path already has a bucket prefix (preset_thumb/, selfie/, results/), return as-is
      if (fullPath.startsWith('preset_thumb/') || fullPath.startsWith('preset/') || fullPath.startsWith('selfie/') || fullPath.startsWith('selfies/') || fullPath.startsWith('presets/') || fullPath.startsWith('results/')) {
        return fullPath;
      }
      
      // Otherwise, infer bucket prefix from filename pattern
      const filename = pathParts[pathParts.length - 1];
      
      // Results: result_, vertex_, merge_, upscaler4k_
      if (filename.startsWith('result_') || filename.startsWith('vertex_') || filename.startsWith('merge_') || filename.startsWith('upscaler4k_')) {
        return `results/${fullPath}`;
      }
      
      // Selfies: selfie_
      if (filename.startsWith('selfie_')) {
        return `selfie/${fullPath}`;
      }
      
      // Presets: preset_
      if (filename.startsWith('preset_')) {
        return `preset_thumb/${fullPath}`;
      }
      
      // Default: return as-is (might be a legacy format)
      return fullPath;
    }
    
    return pathParts.join('/') || null;
  } catch (error) {
    return null;
  }
};

// Removed redundant wrapper functions - use getR2PublicUrl directly

const reconstructR2Key = (id: string, ext: string, prefix: 'selfie' | 'preset' | 'results'): string => {
  return `${prefix}/${id}.${ext}`;
};

const convertLegacyUrl = (url: string, env: Env): string => {
  if (!url) return url;

  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    
    if (urlObj.pathname.startsWith('/r2/')) {
      if (pathParts.length >= 3 && pathParts[0] === 'r2') {
        const bucket = pathParts[1];
        const key = pathParts.slice(2).join('/');
        return getR2PublicUrl(env, key, urlObj.origin);
      }
    }
    
    if (env.R2_DOMAIN && urlObj.hostname === new URL(env.R2_DOMAIN).hostname) {
      const bucketName = resolveBucketName(env);
      if (pathParts.length >= 2 && pathParts[0] === bucketName) {
        const key = pathParts.slice(1).join('/');
        return getR2PublicUrl(env, key, urlObj.origin);
      }
    }
  } catch (error) {
  }

  return url;
};

const compact = <T extends Record<string, any>>(input: T): Record<string, any> => {
  const output: Record<string, any> = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value !== undefined && value !== null) {
      output[key] = value;
    }
  }
  return output;
};

const isDebugEnabled = (env: Env): boolean => {
  // ENABLE_DEBUG_RESPONSE: 'true' enables, 'false' or not set disables
  return env.ENABLE_DEBUG_RESPONSE === 'true';
};

// Build a single flat debug object - no nested provider/vertex structure
const buildFlatDebug = (result: FaceSwapResponse, promptPayload?: any): Record<string, any> | undefined => {
  const debug = (result as any).Debug;
  const extended = result as FaceSwapResponse & {
    VertexResponse?: any;
    Prompt?: any;
    CurlCommand?: string;
  };

  // Get curl from Debug object (preferred) or CurlCommand field
  const curl = debug?.curl || extended.CurlCommand;

  // Get prompt - from promptPayload, Prompt field, or Debug
  const prompt = promptPayload || extended.Prompt || debug?.prompt;

  // Build flat debug object with no duplicates
  const flatDebug = compact({
    curl,
    model: debug?.model,
    prompt: prompt ? (typeof prompt === 'string' ? prompt.substring(0, 500) : prompt) : undefined,
    aspectRatio: debug?.aspectRatio,
    durationMs: debug?.durationMs || debug?.responseTimeMs,
    // Only include on error
    ...(result.StatusCode >= 400 || result.Error ? {
      error: result.Error || debug?.error,
      message: result.Message,
    } : {}),
  });

  return Object.keys(flatDebug).length > 0 ? flatDebug : undefined;
};

// Legacy functions for backwards compatibility - now just call buildFlatDebug
const buildProviderDebug = (result: FaceSwapResponse, finalUrl?: string): Record<string, any> => {
  return buildFlatDebug(result) || {};
};

const buildVertexDebug = (result: FaceSwapResponse): Record<string, any> | undefined => {
  return undefined; // No longer needed - merged into flat debug
};

const mergeVertexDebug = (result: FaceSwapResponse, promptPayload: any): Record<string, any> | undefined => {
  return undefined; // No longer needed - merged into flat debug
};

type SafetyCheckDebug = {
  checked: boolean;
  isSafe: boolean;
  statusCode?: number;
  violationCategory?: string;
  violationLevel?: string;
  details?: {
    adult: string;
    spoof?: string;
    medical?: string;
    violence: string;
    racy: string;
  };
  error?: string;
  rawResponse?: unknown;
  debug?: Record<string, any>;
};

const buildVisionDebug = (vision?: SafetyCheckDebug | null): Record<string, any> | undefined => {
  if (!vision) {
    return undefined;
  }
  // Simplified debug - only meaningful info
  return compact({
    curl: vision.debug?.curl,
    isSafe: vision.isSafe,
    statusCode: vision.statusCode,
    violation: vision.violationCategory ? `${vision.violationCategory}: ${vision.violationLevel}` : undefined,
    details: vision.details, // SafeSearch levels: adult, spoof, medical, violence, racy
    durationMs: vision.debug?.durationMs,
    error: vision.error,
  });
};

const augmentVertexPrompt = (
  promptPayload: any,
  additionalPrompt?: string
) => {
  if (!promptPayload || typeof promptPayload !== 'object') {
    return promptPayload;
  }

  // Efficient shallow clone for prompt augmentation
  const clone = typeof promptPayload === 'object' && promptPayload !== null 
    ? { ...promptPayload } 
    : promptPayload;
  const additions: string[] = [];

  const extra = additionalPrompt?.trim();
  if (extra) {
    additions.push(extra);
  }

  if (!additions.length) {
    return clone;
  }

  const basePrompt = typeof clone.prompt === 'string' ? clone.prompt : '';
  const suffix = additions.join(' + ');
  clone.prompt = basePrompt ? `${basePrompt} + ${suffix}` : suffix;

  return clone;
};

const transformPromptForFilter = (promptPayload: any): any => {
  if (!promptPayload || typeof promptPayload !== 'object') {
    return promptPayload;
  }

  const clone = { ...promptPayload };
  
  if (typeof clone.prompt === 'string') {
    let promptText = clone.prompt;
    
    if (promptText.includes('Replace the original face')) {
      promptText = promptText.replace(/Replace the original face with the face from the image I will upload later\.[^.]*/g, VERTEX_AI_PROMPTS.FILTER_STYLE_APPLICATION_INSTRUCTION);
    } else if (!promptText.includes('Apply this creative style')) {
      promptText = `${promptText} ${VERTEX_AI_PROMPTS.FILTER_STYLE_APPLICATION_INSTRUCTION}`;
    }
    
    clone.prompt = promptText;
  } else {
    clone.prompt = VERTEX_AI_PROMPTS.FILTER_DEFAULT_PROMPT;
  }
  
  return clone;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const DB = getD1Database(env);
    const R2_BUCKET = getR2Bucket(env);
    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;
    const corsHeaders = getCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      if (path.startsWith('/upload-proxy/')) {
        return new Response(null, { 
          status: 204, 
          headers: { 
            ...corsHeaders, 
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Max-Age': '86400' 
          } 
        });
      }
      return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
    }

    if (!(await checkRateLimit(env, request, path))) {
      const debugEnabled = isDebugEnabled(env);
      return jsonResponse({
        data: null,
        status: 'error',
        message: 'Rate limit exceeded',
        code: 429,
        ...(debugEnabled ? { debug: { path, method: request.method } } : {})
      }, 429, request, env);
    }

    const checkProtectedPath = (path: string, method: string): boolean => {
      if (path === '/upload-url') {
        return false;
      }
      if (path === '/profiles') {
        return method === 'POST';
      }
      if (path.startsWith('/profiles/') && path.split('/').length === 3) {
        return method === 'GET';
      }
      return PROTECTED_MOBILE_APIS.includes(path);
    };

    const isProtectedPath = checkProtectedPath(path, request.method);
    if (isProtectedPath && !checkApiKey(env, request)) {
      const debugEnabled = isDebugEnabled(env);
      return jsonResponse({
        data: null,
        status: 'error',
        message: 'Unauthorized',
        code: 401,
        ...(debugEnabled ? { debug: { path, method: request.method } } : {})
      }, 401, request, env);
    }

    if (request.method === 'POST' || request.method === 'PUT') {
      // Skip size check for /process-thumbnail-file and /process-thumbnail-zip (no limit, up to Cloudflare's 100MB max)
      if (path === '/process-thumbnail-file' || path === '/process-thumbnail-zip') {
        // No size limit check - allow up to Cloudflare Workers maximum (100MB)
      } else {
        // Large file upload endpoints: 100MB limit (Cloudflare Workers Pro/Free plan limit)
        // For files >100MB, use presigned URL flow (not currently used by frontend)
        const isLargeUploadEndpoint = path === '/upload-url' || path.startsWith('/r2-upload/');
        const maxSize = isLargeUploadEndpoint ? 100 * 1024 * 1024 : 1024 * 1024;
        const sizeCheck = checkRequestSize(request, maxSize);
        if (!sizeCheck.valid) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse(sizeCheck.error || 'Request too large', 413, debugEnabled ? { path, method: request.method, maxSize } : undefined, request, env);
        }
      }
    }

    // Handle direct file upload endpoint - handles both preset and selfie uploads (supports multiple files)
    if (path === '/upload-url' && request.method === 'POST') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        let files: File[] = [];
        let imageUrls: string[] = [];
        let type: string = '';
        let profileId: string = '';
        let presetName: string = '';
        let enableVertexPrompt: boolean = false;
        let isFilterMode: boolean = false;
        let customPromptText: string | null = null;
        let action: string | null = null;

        // Support both multipart/form-data (file upload) and application/json (URL upload)
        if (contentType.toLowerCase().includes('multipart/form-data')) {
          const formData = await request.formData();
          // Get all files (support multiple)
          const fileEntries = formData.getAll('files');
          for (const entry of fileEntries) {
            if (entry && typeof entry !== 'string') {
              files.push(entry as any as File);
            }
          }
          // Fallback to single 'file' for backward compatibility
          if (files.length === 0) {
            const singleFile = formData.get('file') as any;
            if (singleFile && typeof singleFile !== 'string') {
              files.push(singleFile as File);
            }
          }
          // Get image URLs if provided
          const urlEntries = formData.getAll('image_urls');
          imageUrls = urlEntries.filter((url): url is string => typeof url === 'string' && url.trim() !== '');
          // Fallback to single 'image_url' for backward compatibility
          if (imageUrls.length === 0) {
            const singleUrl = formData.get('image_url') as string | null;
            if (singleUrl) imageUrls = [singleUrl];
          }
          type = formData.get('type') as string;
          profileId = formData.get('profile_id') as string;
          presetName = formData.get('presetName') as string;
          enableVertexPrompt = formData.get('enableVertexPrompt') === 'true';
          
          // Explicitly get and convert is_filter_mode to boolean
          const isFilterModeRaw = formData.get('is_filter_mode');
          isFilterMode = isFilterModeRaw === 'true' || (typeof isFilterModeRaw === 'string' && isFilterModeRaw.toLowerCase() === 'true');
          customPromptText = formData.get('custom_prompt_text') as string | null;
          
          // Log parsed parameters for debugging
          if (type === 'preset') {
            console.log('[Upload-url] Preset upload parameters:', {
              enableVertexPrompt,
              isFilterModeRaw: isFilterModeRaw,
              isFilterModeRawType: typeof isFilterModeRaw,
              isFilterMode: isFilterMode,
              isFilterModeType: typeof isFilterMode,
              hasCustomPrompt: !!customPromptText,
              customPromptLength: customPromptText?.length || 0,
              allFormDataKeys: Array.from(formData.keys())
            });
          }
          // Ensure action is always a string (formData.get can return File if name collision)
          const actionEntry = formData.get('action');
          action = (actionEntry && typeof actionEntry === 'string') ? actionEntry : null;
        } else if (contentType.toLowerCase().includes('application/json')) {
          const body = await request.json() as {
            image_urls?: string[];
            image_url?: string;
            type?: string;
            profile_id?: string;
            presetName?: string;
            enableVertexPrompt?: boolean;
            is_filter_mode?: boolean;
            custom_prompt_text?: string;
            action?: string;
          };
          imageUrls = body.image_urls || (body.image_url ? [body.image_url] : []);
          type = body.type || '';
          profileId = body.profile_id || '';
          presetName = body.presetName || '';
          enableVertexPrompt = body.enableVertexPrompt === true;
          isFilterMode = body.is_filter_mode === true;
          customPromptText = body.custom_prompt_text || null;
          action = body.action || null;
        } else {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { contentType, path } : undefined, request, env);
        }

        if (imageUrls.length > 0) {
          for (const url of imageUrls) {
            if (!validateImageUrl(url, env)) {
              const debugEnabled = isDebugEnabled(env);
              return errorResponse('', 400, debugEnabled ? { url, path } : undefined, request, env);
            }
          }
        }

        // Validate and normalize profileId - ensure it's always a valid string
        if (!profileId || typeof profileId !== 'string' || profileId.trim() === '') {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('profile_id is required and must be a non-empty string', 400, debugEnabled ? { type, profileId, path } : undefined, request, env);
        }
        profileId = profileId.trim(); // Normalize
        
        if (!type || typeof type !== 'string' || type.trim() === '') {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('type is required and must be a non-empty string', 400, debugEnabled ? { type, profileId, path } : undefined, request, env);
        }
        type = type.trim(); // Normalize

        if (type !== 'preset' && type !== 'selfie') {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('type must be either "preset" or "selfie"', 400, debugEnabled ? { type, path } : undefined, request, env);
        }

        // Log parsed parameters for debugging
        console.log('[Upload-url] Parsed parameters:', {
          type,
          profileId,
          action,
          filesCount: files.length,
          imageUrlsCount: imageUrls.length,
          enableVertexPrompt: type === 'preset' ? enableVertexPrompt : undefined,
          isFilterMode: type === 'preset' ? isFilterMode : undefined,
          hasCustomPrompt: type === 'preset' ? !!customPromptText : undefined,
          customPromptLength: type === 'preset' ? (customPromptText?.length || 0) : undefined
        });

        if (type === 'selfie' && !checkApiKey(env, request)) {
          const debugEnabled = isDebugEnabled(env);
          return jsonResponse({
            data: null,
            status: 'error',
            message: 'Unauthorized',
            code: 401,
            ...(debugEnabled ? { debug: { path, method: request.method, type } } : {})
          }, 401, request, env);
        }

        // Validate that profile exists
        const profileResult = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(profileId).first();
        if (!profileResult) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId, path } : undefined, request, env);
        }

        // Prepare all file data (from files and URLs)
        interface FileData {
          fileData: ArrayBuffer;
          filename: string;
          contentType: string;
        }

        const allFileData: FileData[] = [];

        // Process uploaded files
        for (const file of files) {
          const fileData = await file.arrayBuffer();
          if (!fileData || fileData.byteLength === 0) {
            continue; // Skip empty files
          }
          allFileData.push({
            fileData,
            filename: file.name || `upload_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            contentType: file.type || 'image/jpeg'
          });
        }

        for (const imageUrl of imageUrls) {
          try {
            const imageResponse = await fetchWithTimeout(imageUrl, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
            if (!imageResponse.ok) {
              continue;
            }
            const fileData = await imageResponse.arrayBuffer();
            if (!fileData || fileData.byteLength === 0) {
              continue;
            }
            const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
            const urlParts = imageUrl.split('/');
            let filename = urlParts[urlParts.length - 1] || `image_${Date.now()}.${contentType.split('/')[1] || 'jpg'}`;
            filename = filename.split('?')[0];
            allFileData.push({
              fileData,
              filename,
              contentType
            });
          } catch (fetchError) {
            console.error('[Upload] Error fetching image from URL:', fetchError instanceof Error ? fetchError.message.substring(0, 200) : String(fetchError).substring(0, 200));
          }
        }

        if (allFileData.length === 0) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { filesCount: files.length, imageUrlsCount: imageUrls.length, path } : undefined, request, env);
        }

        // Process all files in parallel
        const processFile = async (fileData: FileData, index: number): Promise<any> => {
          const id = nanoid(16);
          // Extract extension from content type, with proper fallback
          let ext = 'jpg'; // Default fallback
          if (fileData.contentType && typeof fileData.contentType === 'string') {
            const parts = fileData.contentType.split('/');
            if (parts.length > 1 && parts[1] && parts[1].trim()) {
              ext = parts[1].trim().toLowerCase();
              // Normalize common extensions
              if (ext === 'jpeg') ext = 'jpg';
            }
          }
          // Fallback: try to extract from filename
          if (ext === 'jpg' && fileData.filename) {
            const filenameExt = fileData.filename.split('.').pop()?.toLowerCase();
            if (filenameExt && ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(filenameExt)) {
              ext = filenameExt === 'jpeg' ? 'jpg' : filenameExt;
            }
          }
          const key = `${type}/${id}.${ext}`;

          // Upload to R2
          try {
            await R2_BUCKET.put(key, fileData.fileData, {
              httpMetadata: {
                contentType: fileData.contentType,
                cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
              },
            });
          } catch (r2Error) {
            return {
              success: false,
              error: `R2 upload failed: ${r2Error instanceof Error ? r2Error.message.substring(0, 200) : String(r2Error).substring(0, 200)}`,
              filename: fileData.filename
            };
          }

          const publicUrl = getR2PublicUrl(env, key, requestUrl.origin);
          const createdAt = Math.floor(Date.now() / 1000);

          // Scan selfie uploads with vision API before saving to database (only for 4k/4K action)
          let visionCheckResult: any = null;
          if (type === 'selfie') {
            const actionValue = action || 'faceswap';
            const needsVisionCheck = actionValue.toLowerCase() === '4k';
            const disableVisionApi = env.DISABLE_VISION_API === 'true';
            
            // Always log for debugging
            console.log('[VisionCheck] Upload-url check:', {
              type,
              action,
              actionValue,
              needsVisionCheck,
              DISABLE_VISION_API: env.DISABLE_VISION_API,
              disableVisionApi,
              shouldCheck: needsVisionCheck && !disableVisionApi,
              publicUrl
            });
            
            if (needsVisionCheck && !disableVisionApi) {
              // Run Vision API safety scan
              console.log('[VisionCheck] Running Vision API scan for:', publicUrl);
              const safeSearchResult = await checkSafeSearch(publicUrl, env);
              console.log('[VisionCheck] Scan result:', {
                isSafe: safeSearchResult.isSafe,
                statusCode: safeSearchResult.statusCode,
                error: safeSearchResult.error
              });
              const debugEnabled = isDebugEnabled(env);
              if (debugEnabled) {
                visionCheckResult = {
                  checked: true,
                  isSafe: safeSearchResult.isSafe,
                  statusCode: safeSearchResult.statusCode,
                  violationCategory: safeSearchResult.violationCategory,
                  violationLevel: safeSearchResult.violationLevel,
                  details: safeSearchResult.details,
                  error: safeSearchResult.error,
                  rawResponse: safeSearchResult.rawResponse,
                  debug: safeSearchResult.debug,
                };
              }
              
              // If vision scan failed with an error, block the upload
              if (safeSearchResult.error) {
                // Delete from R2 if vision scan failed
                try {
                  await R2_BUCKET.delete(key);
                } catch (deleteError) {
                }
                return {
                  success: false,
                  error: 'Vision scan failed',
                  filename: fileData.filename,
                  visionError: true,
                  ...(debugEnabled ? {
                    visionDetails: {
                      error: safeSearchResult.error,
                      debug: safeSearchResult.debug,
                    }
                  } : {})
                };
              }
              
              if (!safeSearchResult.isSafe) {
                // Delete from R2 if unsafe
                try {
                  await R2_BUCKET.delete(key);
                } catch (deleteError) {
                }
                // Return special marker to indicate vision block failure with statusCode
                // Ensure we have a valid statusCode (1001-1005), default to 1001 if somehow missing
                const visionStatusCode = safeSearchResult.statusCode && safeSearchResult.statusCode >= 1001 && safeSearchResult.statusCode <= 1005 
                  ? safeSearchResult.statusCode 
                  : 1001; // Default to ADULT if statusCode is missing/invalid
                return {
                  success: false,
                  error: 'Upload failed',
                  filename: fileData.filename,
                  visionBlocked: true,
                  visionStatusCode: visionStatusCode,
                  ...(debugEnabled ? {
                    visionDetails: {
                      violationCategory: safeSearchResult.violationCategory,
                      violationLevel: safeSearchResult.violationLevel,
                      details: safeSearchResult.details,
                      rawResponse: safeSearchResult.rawResponse,
                      debug: safeSearchResult.debug,
                      fullResult: safeSearchResult, // Complete Vision API result
                    }
                  } : {})
                };
              }
            } else if (needsVisionCheck && disableVisionApi) {
              // Vision API disabled - return mock (always pass)
              const debugEnabled = isDebugEnabled(env);
              if (debugEnabled) {
                visionCheckResult = {
                  checked: false,
                  isSafe: true,
                  skipped: true,
                  reason: 'Vision API disabled (DISABLE_VISION_API=true)',
                };
              }
            }
          }

          if (type === 'preset') {
            // Generate Vertex AI prompt in parallel
            let promptJson: string | null = null;
            let vertexCallInfo: { success: boolean; error?: string; promptKeys?: string[]; debug?: any } = { success: false };

            if (enableVertexPrompt) {
              try {
                // Explicitly convert to boolean (same as ZIP upload flow) and log values
                const filterModeBool = isFilterMode === true;
                console.log(`[Upload-url] Generating Vertex prompt for preset ${id}:`, {
                  isFilterMode: isFilterMode,
                  isFilterModeType: typeof isFilterMode,
                  filterModeBool: filterModeBool,
                  customPromptText: customPromptText ? `provided (${customPromptText.length} chars)` : 'none',
                  publicUrl: publicUrl
                });
                const promptResult = await generateVertexPrompt(publicUrl, env, filterModeBool, customPromptText);
                if (promptResult.success && promptResult.prompt) {
                  promptJson = JSON.stringify(promptResult.prompt);
                  vertexCallInfo = {
                    success: true,
                    promptKeys: Object.keys(promptResult.prompt),
                    debug: promptResult.debug
                  };
                  console.log(`[Upload-url] Successfully generated prompt for preset ${id}, keys: ${Object.keys(promptResult.prompt).join(', ')}`);
                } else {
                  vertexCallInfo = {
                    success: false,
                    error: promptResult.error || 'Unknown error',
                    debug: promptResult.debug
                  };
                  console.error(`[Upload-url] Prompt generation failed for preset ${id}:`, promptResult.error || 'Unknown error');
                }
              } catch (vertexError) {
                const errorMsg = vertexError instanceof Error ? vertexError.message : String(vertexError);
                vertexCallInfo = {
                  success: false,
                  error: errorMsg.substring(0, 200),
                  debug: { errorDetails: errorMsg.substring(0, 200) }
                };
                console.error(`[Upload-url] Prompt generation exception for preset ${id}:`, errorMsg.substring(0, 200));
              }
            } else {
              console.log(`[Upload-url] Prompt generation not requested for preset ${id}`);
            }

            // Store prompt_json in R2 metadata
            if (promptJson) {
              try {
                // Re-upload with metadata (the file was already uploaded at line 1000, but we need to add metadata)
                await R2_BUCKET.put(key, fileData.fileData, {
                  httpMetadata: {
                    contentType: fileData.contentType,
                    cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                  },
                  customMetadata: {
                    prompt_json: promptJson
                  }
                });
                console.log(`[Upload-url] Successfully stored prompt_json metadata for preset ${id} at key ${key}`);
              } catch (metadataError) {
                const errorMsg = metadataError instanceof Error ? metadataError.message : String(metadataError);
                console.error(`[Upload-url] Failed to store prompt_json metadata for preset ${id}:`, errorMsg.substring(0, 200));
                // Don't fail the upload, but log the error
              }
            } else if (enableVertexPrompt) {
              // Prompt generation was requested but failed
              console.warn(`[Upload-url] Prompt generation was requested for preset ${id} but promptJson is null`);
            }

            // Create 4x thumbnail using the preset image itself
            // Since Cloudflare Workers don't have native image processing,
            // we use the preset image as the thumbnail
            const thumbnailR2Key = key; // Use the same preset image as thumbnail
            const thumbnailData = {
              webp_4x: thumbnailR2Key
            };
            const thumbnailR2Json = JSON.stringify(thumbnailData);

            // Save to database (store id, ext, and thumbnail_r2)
            // Use INSERT OR REPLACE to handle case where preset already exists
            const existingPreset = await DB.prepare('SELECT created_at FROM presets WHERE id = ?').bind(id).first();
            const finalCreatedAt = existingPreset && (existingPreset as any).created_at 
              ? (existingPreset as any).created_at 
              : createdAt;
            
            const dbResult = await DB.prepare(
              'INSERT OR REPLACE INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)'
            ).bind(id, ext, finalCreatedAt, thumbnailR2Json).run();

            if (!dbResult.success) {
              return {
                success: false,
                error: 'Database insert failed',
                filename: fileData.filename
              };
            }

            const response: any = {
              success: true,
              url: publicUrl,
              id: id,
              filename: `${id}.${ext}`,
              hasPrompt: !!promptJson,
              prompt_json: promptJson ? JSON.parse(promptJson) : null,
              vertex_info: vertexCallInfo,
              thumbnail_4x: getR2PublicUrl(env, thumbnailR2Key, requestUrl.origin),
              thumbnail_created: true,
              filter_mode_used: isFilterMode,
              prompt_type: isFilterMode ? 'filter' : (customPromptText ? 'custom' : 'default')
            };
            
            // Include vision check result in response only if debug is enabled (if preset also needs vision check in future)
            const debugEnabled = isDebugEnabled(env);
            if (debugEnabled && visionCheckResult) {
              response.visionCheck = visionCheckResult;
            }
            
            return response;
          } else if (type === 'selfie') {
            // Ensure actionValue is always a valid non-empty string
            let actionValue: string = (action && typeof action === 'string' && action.trim()) ? action.trim() : 'faceswap';
            const actionLower = actionValue.toLowerCase();
            
            // Normalize 4k action to lowercase for consistency
            if (actionLower === '4k') {
              actionValue = '4k';
            }
            
            // Ensure actionValue is never empty or null for database insert
            if (!actionValue || actionValue.trim() === '') {
              actionValue = 'faceswap';
            }

            // Optimized: Use LIMIT to fetch only what we need (faster than COUNT on large tables)
            // Get (maxCount) oldest selfies - if we have exactly maxCount, we need to delete 1 before inserting
            let maxCount: number;
            let queryCondition: string;
            let queryBindings: any[];

            if (actionLower === 'faceswap') {
              maxCount = parseInt(env.SELFIE_MAX_FACESWAP || '5', 10);
              queryCondition = 'profile_id = ? AND action = ?';
              queryBindings = [profileId, actionValue];
            } else if (actionLower === 'wedding') {
              maxCount = parseInt(env.SELFIE_MAX_WEDDING || '2', 10);
              queryCondition = 'profile_id = ? AND action = ?';
              queryBindings = [profileId, actionValue];
            } else if (actionLower === '4k') {
              maxCount = parseInt(env.SELFIE_MAX_4K || '1', 10);
              queryCondition = 'profile_id = ? AND (action = ? OR action = ?)';
              queryBindings = [profileId, '4k', '4K'];
            } else {
              maxCount = parseInt(env.SELFIE_MAX_OTHER || '1', 10);
              queryCondition = 'profile_id = ? AND action = ?';
              queryBindings = [profileId, actionValue];
            }

            // Validate maxCount is a valid positive integer (SQLite LIMIT requires INTEGER)
            if (isNaN(maxCount) || maxCount < 1) {
              maxCount = 1; // Default to 1 if invalid
            }
            maxCount = Math.floor(Math.max(1, maxCount)); // Ensure it's a positive integer

            // Fetch existing selfies up to maxCount (avoids full table scan of COUNT(*))
            const existingQuery = `SELECT id, ext FROM selfies WHERE ${queryCondition} ORDER BY created_at ASC LIMIT ?`;
            const existingResult = await DB.prepare(existingQuery).bind(...queryBindings, maxCount).all();
            const currentCount = existingResult.results?.length || 0;

            // Delete oldest if at limit
            if (currentCount >= maxCount) {
              const toDeleteCount = currentCount - maxCount + 1;
              const toDelete = existingResult.results!.slice(0, toDeleteCount);
              const idsToDelete = toDelete.map((s: any) => s.id);
              
              // Delete from DB in batch
              const placeholders = idsToDelete.map(() => '?').join(',');
              await DB.prepare(`DELETE FROM selfies WHERE id IN (${placeholders})`).bind(...idsToDelete).run();
              
              // Delete from R2 - await to ensure cleanup completes (prevent orphaned files)
              const r2Deletions = toDelete.map(async (oldSelfie: any) => {
                const oldKey = reconstructR2Key(oldSelfie.id, oldSelfie.ext, 'selfie');
                try {
                  await R2_BUCKET.delete(oldKey);
                } catch (r2Error) {
                  console.error(`[R2] Failed to delete ${oldKey}:`, r2Error instanceof Error ? r2Error.message.substring(0, 100) : String(r2Error).substring(0, 100));
                }
              });
              
              // Wait for all R2 deletions to complete (parallel within batch)
              await Promise.all(r2Deletions);
            }

            // Insert new selfie - ensure all values are correct types
            // Validate and explicitly convert all values to prevent SQLITE_MISMATCH
            const validId = String(id || '').trim();
            if (!validId) {
              return {
                success: false,
                error: 'Invalid id generated',
                filename: fileData.filename
              };
            }
            
            const validExt = String(ext || 'jpg').trim();
            if (!validExt) {
              return {
                success: false,
                error: 'Invalid file extension',
                filename: fileData.filename
              };
            }
            
            // Use profileId from outer scope (already validated and normalized)
            const validProfileId = String(profileId || '').trim();
            if (!validProfileId) {
              console.error('[Selfie Upload] Invalid profileId:', { profileId, type: typeof profileId, filename: fileData.filename });
              return {
                success: false,
                error: 'Invalid profile_id',
                filename: fileData.filename
              };
            }
            
            // Ensure actionValue is always a valid string (action column is TEXT, nullable is OK but we use default)
            const validAction = String(actionValue || 'faceswap').trim() || 'faceswap';
            
            // Ensure createdAt is a valid integer (created_at is INTEGER NOT NULL)
            let validCreatedAt: number;
            if (typeof createdAt === 'number' && !isNaN(createdAt) && createdAt > 0) {
              validCreatedAt = Math.floor(createdAt);
            } else {
              validCreatedAt = Math.floor(Date.now() / 1000);
            }
            
            // Explicitly bind with correct types - ensure all are primitive types
            // SQLite INTEGER must be a whole number, not a float
            const bindValues: [string, string, string, string, number] = [
              validId,                    // id: TEXT (already string)
              validExt,                   // ext: TEXT NOT NULL (already string)
              validProfileId,             // profile_id: TEXT NOT NULL (already string)
              validAction,                // action: TEXT (already string)
              Math.floor(validCreatedAt)  // created_at: INTEGER NOT NULL (must be integer, not float)
            ];
            
            // Validate all bind values are correct types
            if (typeof bindValues[0] !== 'string' || bindValues[0] === '') {
              throw new Error(`Invalid id type: ${typeof bindValues[0]}, value: ${bindValues[0]}`);
            }
            if (typeof bindValues[1] !== 'string' || bindValues[1] === '') {
              throw new Error(`Invalid ext type: ${typeof bindValues[1]}, value: ${bindValues[1]}`);
            }
            if (typeof bindValues[2] !== 'string' || bindValues[2] === '') {
              throw new Error(`Invalid profile_id type: ${typeof bindValues[2]}, value: ${bindValues[2]}`);
            }
            if (typeof bindValues[3] !== 'string') {
              throw new Error(`Invalid action type: ${typeof bindValues[3]}, value: ${bindValues[3]}`);
            }
            if (typeof bindValues[4] !== 'number' || isNaN(bindValues[4]) || !Number.isInteger(bindValues[4])) {
              throw new Error(`Invalid created_at type: ${typeof bindValues[4]}, value: ${bindValues[4]}, isInteger: ${Number.isInteger(bindValues[4])}`);
            }
            
            try {
              const dbResult = await DB.prepare(
                'INSERT INTO selfies (id, ext, profile_id, action, created_at) VALUES (?, ?, ?, ?, ?)'
              ).bind(...bindValues).run();

              if (!dbResult.success) {
                return {
                  success: false,
                  error: 'Database insert failed',
                  filename: fileData.filename
                };
              }
            } catch (dbError) {
              console.error('[Selfie Upload] Database insert error:', {
                error: dbError instanceof Error ? dbError.message : String(dbError),
                bindValues: {
                  id: bindValues[0],
                  ext: bindValues[1],
                  profile_id: bindValues[2],
                  action: bindValues[3],
                  created_at: bindValues[4],
                  types: bindValues.map(v => typeof v)
                },
                filename: fileData.filename
              });
              return {
                success: false,
                error: `Database insert error: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
                filename: fileData.filename
              };
            }

            const response: any = {
              success: true,
              url: publicUrl,
              id: id,
              filename: `${id}.${ext}`,
              action: actionValue
            };
            
            // Include vision check result in response only if debug is enabled
            const debugEnabled = isDebugEnabled(env);
            if (debugEnabled && visionCheckResult) {
              response.visionCheck = visionCheckResult;
            }
            
            return response;
          }

          return { success: true, url: publicUrl };
        };

        // Process files: presets with controlled parallelism (avoid overwhelming system), selfies sequentially (enforce limits without race conditions)
        let results: any[] = [];
        if (type === 'preset') {
          // Presets can be processed with controlled parallelism - no limit enforcement conflicts
          // Limit to 5 concurrent uploads to prevent system overload with large zip files
          const PRESET_CONCURRENCY_LIMIT = 5;
          results = await promisePoolWithConcurrency(
            allFileData,
            async (fileData, index) => processFile(fileData, index),
            PRESET_CONCURRENCY_LIMIT
          );
        } else {
          // Selfies must be processed sequentially to prevent race conditions on limit enforcement
          // Race condition scenario: 2 parallel uploads both COUNT=4, both INSERT → 6 selfies when limit is 5
          results = [];
          for (let i = 0; i < allFileData.length; i++) {
            const result = await processFile(allFileData[i], i);
            results.push(result);
          }
        }

        // Check if any selfie was blocked by vision API - return specific error code
        const visionBlockedResult = results.find(r => (r as any).visionBlocked === true);
        if (visionBlockedResult) {
          const visionStatusCode = (visionBlockedResult as any).visionStatusCode || 1001;
          const visionDetails = (visionBlockedResult as any).visionDetails || {};
          const debugEnabled = isDebugEnabled(env);
          
          const debugPayload = debugEnabled ? compact({
            vision: {
              checked: true,
              isSafe: false,
              statusCode: visionStatusCode,
              violationCategory: visionDetails.violationCategory,
              violationLevel: visionDetails.violationLevel,
              details: visionDetails.details,
              rawResponse: visionDetails.rawResponse,
              apiDebug: visionDetails.debug,
              fullResult: visionDetails.fullSafeSearchResult,
            },
          }) : undefined;
          
          return jsonResponse({
            data: null,
            status: 'error',
            message: 'Upload failed',
            code: visionStatusCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, 422, request, env); // HTTP status 422, but code field contains 1001-1005
        }

        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        const debugEnabled = isDebugEnabled(env);
        const vertexDebugData = results
          .filter(r => r.success && (r.hasPrompt !== undefined || r.prompt_json || r.vertex_info))
          .map(r => ({
            hasPrompt: r.hasPrompt,
            prompt_json: r.prompt_json,
            vertex_info: r.vertex_info
          }));

        const visionDebugData = results
          .filter(r => r.success && (r as any).visionCheck)
          .map(r => buildVisionDebug((r as any).visionCheck));

        const debugPayload = debugEnabled 
          ? compact({
              ...(vertexDebugData.length > 0 ? { vertex: vertexDebugData } : {}),
              ...(visionDebugData.length > 0 ? { vision: visionDebugData.length === 1 ? visionDebugData[0] : visionDebugData } : {})
            })
          : undefined;

        // Determine response status based on success/failure counts
        const allFailed = successful.length === 0 && failed.length > 0;
        const partialSuccess = successful.length > 0 && failed.length > 0;
        const httpStatus = allFailed ? 422 : 200;
        const responseStatus = allFailed ? 'error' : (partialSuccess ? 'partial' : 'success');
        const responseCode = allFailed ? 422 : 200;
        const responseMessage = allFailed
          ? `Upload failed: ${failed.length} file${failed.length !== 1 ? 's' : ''} failed`
          : (partialSuccess
            ? `Partial success: ${successful.length} of ${results.length} file${results.length !== 1 ? 's' : ''} uploaded`
            : 'Processing successful');

        return jsonResponse({
          data: {
            results: results.map(r => {
              if (r.success) {
                const result: any = {
                  id: r.id,
                  url: r.url,
                  filename: r.filename
                };
                // Include filter mode info if available (for presets)
                if ((r as any).filter_mode_used !== undefined) {
                  result.filter_mode_used = (r as any).filter_mode_used;
                }
                if ((r as any).prompt_type) {
                  result.prompt_type = (r as any).prompt_type;
                }
                return result;
              } else {
                return {
                  success: false,
                  error: r.error,
                  filename: r.filename
                };
              }
            }),
            count: results.length,
            successful: successful.length,
            failed: failed.length
          },
          status: responseStatus,
          message: responseMessage,
          code: responseCode,
          ...(debugPayload ? { debug: debugPayload } : {})
        }, httpStatus, request, env);
      } catch (error) {
        logCriticalError('/upload-url', error, request, env, {
          path,
          errorType: 'upload_error'
        });
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        const debugEnabled = isDebugEnabled(env);
        return errorResponse(
          `Upload failed: ${errorMsg}`, 
          500,
          debugEnabled ? { 
            error: errorMsg,
            path,
            ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {})
          } : undefined,
          request,
          env
        );
      }
    }

    // Parse thumbnail filename to extract preset_id (filename without extension)
    // Example: "preset_123.webp" -> preset_id: "preset_123"
    // Example: "fs_beach-day-selfie_f1_2b.left.png" -> preset_id: "fs_beach-day-selfie_f1_2b"
    // Example: "fs_beach-day-selfie_f1_2b.left.webp" -> preset_id: "fs_beach-day-selfie_f1_2b"
    function parseThumbnailFilename(filename: string): { preset_id: string; format: string } | null {
      if (!filename || !filename.trim()) return null;

      // Remove .left.png, .right.png, .left.webp, or .right.webp suffix first
      let preset_id = filename.replace(/\.(left|right)\.(png|webp)$/i, '');
      
      // If no change, try removing other common extensions
      if (preset_id === filename) {
        preset_id = filename.replace(/\.(webp|json|png)$/i, '');
      }

      // If still no change, return null
      if (preset_id === filename || !preset_id) return null;

      // Determine format based on original filename
      const isJson = filename.toLowerCase().endsWith('.json');
      const format = isJson ? 'lottie' : 'webp';

      return { preset_id, format };
    }

    // Retry wrapper for upload operations
    const retryUploadOperation = async <T>(
      operation: () => Promise<T>,
      maxRetries: number = 10,
      initialDelay: number = 1000
    ): Promise<T> => {
      let lastError: Error | null = null;
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await operation();
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const errorMsg = lastError.message.toLowerCase();
          
          // Check if error is retryable (transient errors)
          const isRetryable = 
            errorMsg.includes('timeout') ||
            errorMsg.includes('network') ||
            errorMsg.includes('connection') ||
            errorMsg.includes('rate limit') ||
            errorMsg.includes('429') ||
            errorMsg.includes('503') ||
            errorMsg.includes('502') ||
            errorMsg.includes('500') ||
            errorMsg.includes('internal server error') ||
            errorMsg.includes('service unavailable');
          
          // Don't retry on permanent errors (4xx except 429)
          if (!isRetryable && attempt === 0) {
            throw lastError;
          }
          
          // If not last attempt, wait before retrying (exponential backoff with jitter)
          if (attempt < maxRetries - 1) {
            const baseDelay = initialDelay * Math.pow(2, attempt);
            const jitter = Math.random() * 0.3 * baseDelay;
            const delay = Math.min(baseDelay + jitter, 30000); // Cap at 30 seconds
            console.warn(`[Upload Retry] Attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}. Retrying in ${Math.round(delay)}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      
      // All retries exhausted
      console.error(`[Upload Retry] All ${maxRetries} attempts failed. Last error: ${lastError?.message}`);
      throw lastError || new Error('Upload operation failed after all retries');
    };

    // ============================================================================
    // MULTIPART UPLOAD API for large files (>100MB, up to 5GB)
    // Cloudflare Workers have 100MB request limit (Pro plan), so use chunked upload
    // ============================================================================

    // Step 1: Create multipart upload session
    // POST /upload-multipart/create
    // Body: { key: string, contentType?: string }
    // Returns: { uploadId: string, key: string }
    if (path === '/upload-multipart/create' && request.method === 'POST') {
      try {
        const body = await request.json() as { key: string; contentType?: string };
        
        if (!body.key) {
          return errorResponse('key is required', 400, undefined, request, env);
        }

        const R2_BUCKET = getR2Bucket(env);
        const key = `temp/multipart_${nanoid(16)}_${body.key.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        
        const multipartUpload = await R2_BUCKET.createMultipartUpload(key, {
          httpMetadata: {
            contentType: body.contentType || 'application/octet-stream',
          },
        });

        return successResponse({
          uploadId: multipartUpload.uploadId,
          key: multipartUpload.key
        }, 200, request, env);
      } catch (error) {
        logCriticalError('/upload-multipart/create', error, request, env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        const debugEnabled = isDebugEnabled(env);
        return errorResponse('Failed to create multipart upload', 500, debugEnabled ? { error: errorMsg.substring(0, 200) } : undefined, request, env);
      }
    }

    // Step 2: Upload a part (max 100MB per part, call multiple times for large files)
    // PUT /upload-multipart/part?key=...&uploadId=...&partNumber=1
    // Body: binary chunk data
    // Returns: { partNumber: number, etag: string }
    if (path === '/upload-multipart/part' && request.method === 'PUT') {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get('key');
        const uploadId = url.searchParams.get('uploadId');
        const partNumber = parseInt(url.searchParams.get('partNumber') || '0', 10);

        if (!key || !uploadId || partNumber < 1) {
          return errorResponse('key, uploadId, and partNumber (>=1) are required', 400, undefined, request, env);
        }

        const R2_BUCKET = getR2Bucket(env);
        const multipartUpload = R2_BUCKET.resumeMultipartUpload(key, uploadId);
        
        const body = request.body;
        if (!body) {
          return errorResponse('No body provided', 400, undefined, request, env);
        }

        const uploadedPart = await multipartUpload.uploadPart(partNumber, body);

        return successResponse({
          partNumber: uploadedPart.partNumber,
          etag: uploadedPart.etag
        }, 200, request, env);
      } catch (error) {
        logCriticalError('/upload-multipart/part', error, request, env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        const debugEnabled = isDebugEnabled(env);
        return errorResponse('Failed to upload part', 500, debugEnabled ? { error: errorMsg.substring(0, 200) } : undefined, request, env);
      }
    }

    // Step 3: Complete multipart upload (assembles all parts)
    // POST /upload-multipart/complete
    // Body: { key: string, uploadId: string, parts: [{ partNumber: number, etag: string }, ...] }
    // Returns: { key: string, completed: true }
    if (path === '/upload-multipart/complete' && request.method === 'POST') {
      try {
        const body = await request.json() as { 
          key: string; 
          uploadId: string; 
          parts: Array<{ partNumber: number; etag: string }> 
        };

        if (!body.key || !body.uploadId || !body.parts?.length) {
          return errorResponse('key, uploadId, and parts array are required', 400, undefined, request, env);
        }

        const R2_BUCKET = getR2Bucket(env);
        const multipartUpload = R2_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
        
        await multipartUpload.complete(body.parts);

        return successResponse({
          key: body.key,
          completed: true
        }, 200, request, env);
      } catch (error) {
        logCriticalError('/upload-multipart/complete', error, request, env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        const debugEnabled = isDebugEnabled(env);
        return errorResponse('Failed to complete multipart upload', 500, debugEnabled ? { error: errorMsg.substring(0, 200) } : undefined, request, env);
      }
    }

    // Cancel/abort multipart upload
    // POST /upload-multipart/abort
    // Body: { key: string, uploadId: string }
    if (path === '/upload-multipart/abort' && request.method === 'POST') {
      try {
        const body = await request.json() as { key: string; uploadId: string };

        if (!body.key || !body.uploadId) {
          return errorResponse('key and uploadId are required', 400, undefined, request, env);
        }

        const R2_BUCKET = getR2Bucket(env);
        const multipartUpload = R2_BUCKET.resumeMultipartUpload(body.key, body.uploadId);
        await multipartUpload.abort();

        return successResponse({ aborted: true }, 200, request, env);
      } catch (error) {
        logCriticalError('/upload-multipart/abort', error, request, env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        const debugEnabled = isDebugEnabled(env);
        return errorResponse('Failed to abort multipart upload', 500, debugEnabled ? { error: errorMsg.substring(0, 200) } : undefined, request, env);
      }
    }

    // Handle direct R2 upload for files <100MB
    // Endpoint: PUT /r2-upload/:key
    if (path.startsWith('/r2-upload/') && request.method === 'PUT') {
      try {
        const uploadKey = decodeURIComponent(path.replace('/r2-upload/', ''));
        const url = new URL(request.url);
        const contentType = url.searchParams.get('contentType') || 'application/octet-stream';
        
        // Allow temp/ and try_results/ prefixes
        if (!uploadKey || (!uploadKey.startsWith('temp/') && !uploadKey.startsWith('try_results/'))) {
          return errorResponse('Invalid upload key', 400, { uploadKey }, request, env);
        }

        const R2_BUCKET = getR2Bucket(env);
        
        const body = request.body;
        if (!body) {
          return errorResponse('No body provided', 400, undefined, request, env);
        }

        await R2_BUCKET.put(uploadKey, body, {
          httpMetadata: {
            contentType,
            cacheControl: 'private, max-age=3600',
          },
        });

        return successResponse({
          key: uploadKey,
          uploaded: true
        }, 200, request, env);
      } catch (error) {
        logCriticalError('/r2-upload', error, request, env, {
          uploadKey: path.replace('/r2-upload/', '')
        });
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        const debugEnabled = isDebugEnabled(env);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg } : undefined, request, env);
      }
    }

    // Handle single thumbnail file processing - for client-side sequential uploads






    if (path === '/process-thumbnail-file' && request.method === 'POST') {
      try {
        return await retryUploadOperation(async () => {
        const contentType = request.headers.get('Content-Type') || '';
        const DB = getD1Database(env);
        const R2_BUCKET = getR2Bucket(env);
        const requestUrl = new URL(request.url);
        
        // Check if this is a preset prompt generation request (R2 key/URL provided)
        if (contentType.toLowerCase().includes('application/json')) {
          const body = await request.json() as {
            r2_key?: string;
            r2_url?: string;
            filename?: string;
            preset_id?: string;
            is_filter_mode?: boolean;
            custom_prompt_text?: string;
          };
          
          // For preset prompt generation: require R2 key or URL
          if (body.r2_key || body.r2_url) {
            const r2Key = body.r2_key || (body.r2_url ? extractR2KeyFromUrl(body.r2_url) : null);
            if (!r2Key) {
              return errorResponse('Invalid R2 key or URL', 400, undefined, request, env);
            }
            
            // Extract preset_id from R2 key or body
            let presetId = body.preset_id;
            if (!presetId) {
              const filename = body.filename || r2Key.split('/').pop() || '';
              const parsed = parseThumbnailFilename(filename);
              if (!parsed) {
                return errorResponse('Could not extract preset_id from filename or R2 key', 400, undefined, request, env);
              }
              presetId = parsed.preset_id;
            }
            
            // Verify file exists in R2
            const existingObject = await R2_BUCKET.head(r2Key);
            if (!existingObject) {
              return errorResponse(`File not found in R2: ${r2Key}`, 404, undefined, request, env);
            }
            
            // Generate Vertex AI prompt
            const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
            const isFilterMode = body.is_filter_mode === true;
            const promptResult = await generateVertexPromptWithRetry(publicUrl, env, isFilterMode, body.custom_prompt_text || null);
            
            if (!promptResult.success || !promptResult.prompt) {
              return errorResponse(
                `Vertex AI prompt generation failed: ${promptResult.error || 'Unknown error'}`,
                500,
                { vertex_info: { success: false, error: promptResult.error, debug: promptResult.debug } },
                request,
                env
              );
            }
            
            // Update R2 metadata with prompt JSON
            const promptJson = JSON.stringify(promptResult.prompt);
            const fileData = await (await R2_BUCKET.get(r2Key))?.arrayBuffer();
            if (!fileData) {
              return errorResponse('Failed to read file from R2', 500, undefined, request, env);
            }
            
            const contentType = existingObject.httpMetadata?.contentType || 'application/octet-stream';
            await R2_BUCKET.put(r2Key, fileData, {
              httpMetadata: {
                contentType,
                cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
              },
              customMetadata: {
                prompt_json: promptJson
              }
            });
            
            // Delete KV cache for this preset (invalidate old cached prompt)
            const promptCacheKV = getPromptCacheKV(env);
            if (promptCacheKV) {
              const cacheKey = `prompt:${presetId}`;
              try {
                await promptCacheKV.delete(cacheKey);
                console.log(`[process-thumbnail-file] Deleted KV cache for ${cacheKey}`);
              } catch (kvError) {
                console.warn(`[process-thumbnail-file] Failed to delete KV cache for ${cacheKey}:`, kvError);
              }
            }

            // Update database (prompt_json is stored in R2 metadata, not in D1)
            const existingPreset = await DB.prepare('SELECT id FROM presets WHERE id = ?').bind(presetId).first();
            if (existingPreset) {
              await DB.prepare('UPDATE presets SET updated_at = datetime(\'now\') WHERE id = ?').bind(presetId).run();
            } else {
              const ext = r2Key.split('.').pop() || 'webp';
              await DB.prepare('INSERT INTO presets (id, ext, created_at, updated_at) VALUES (?, ?, datetime(\'now\'), datetime(\'now\'))').bind(presetId, ext).run();
            }

            return successResponse({
              success: true,
              preset_id: presetId,
              r2_key: r2Key,
              url: publicUrl,
              hasPrompt: true,
              kvCacheDeleted: true,
              vertex_info: { success: true, promptKeys: Object.keys(promptResult.prompt) }
            }, 200, request, env);
          }
          
          return errorResponse('r2_key or r2_url is required for preset prompt generation', 400, undefined, request, env);
        }
        
        // Handle file upload (thumbnail files or zip files)
        const formData = await request.formData();
        const zipFile = formData.get('zip') as File | null;
        // Support both thumbnail_formats (comma-separated) and thumbnail_format (single)
        const thumbnailFormatsRaw = (formData.get('thumbnail_formats') as string | null) || (formData.get('thumbnail_format') as string | null) || 'webp';
        const thumbnailFormats = thumbnailFormatsRaw.split(',').map(f => f.trim()).filter(f => f);
        const isFilterMode = formData.get('is_filter_mode') === 'true';
        const customPromptText = formData.get('custom_prompt_text') as string | null;

        // Check if this is a zip file upload for preset processing
        if (zipFile && zipFile.type === 'application/zip') {

          const zipData = await zipFile.arrayBuffer();
          const zip = await JSZip.loadAsync(zipData);

          const results: any[] = [];
          let successful = 0;
          let failed = 0;
          let presetsProcessed = 0;
          let presetsWithPrompts = 0;

          // Extract PNG files from preset folder in zip, preserving folder structure
          const presetFiles: Array<{ filename: string; relativePath: string; zipEntry: JSZip.JSZipObject }> = [];
          zip.forEach((path: string, entry: JSZip.JSZipObject) => {
            if (!entry.dir && path.toLowerCase().startsWith('preset/') && (path.toLowerCase().endsWith('.webp') || path.toLowerCase().endsWith('.png'))) {
              const filename = path.split('/').pop() || path;
              // Preserve relative path from zip (e.g., "preset/subfolder/file.png")
              const relativePath = path.replace(/\\/g, '/');
              presetFiles.push({ filename, relativePath, zipEntry: entry });
            }
          });

          if (presetFiles.length === 0) {
            return errorResponse('No PNG files found in the preset folder. Zip file must contain PNG files in a "preset/" folder.', 400, undefined, request, env);
          }

          if (presetFiles.length === 0) {
            return errorResponse('No PNG files found in the preset folder', 400, undefined, request, env);
          }


          // Process preset files in parallel with controlled concurrency
          const processPresetFile = async ({ filename, relativePath, zipEntry }: { filename: string; relativePath: string; zipEntry: JSZip.JSZipObject }) => {
            try {
              const parsed = parseThumbnailFilename(filename);
              if (!parsed) {
                return {
                  success: false,
                  filename,
                  error: 'Invalid filename format. Could not extract preset_id from filename.'
                };
              }

              const { preset_id: presetId } = parsed;
              const fileDataUint8 = await zipEntry.async('uint8array');

              if (!fileDataUint8 || fileDataUint8.length === 0) {
                return {
                  success: false,
                  filename,
                  error: 'File is empty'
                };
              }

              // Convert Uint8Array to ArrayBuffer
              const fileData = new ArrayBuffer(fileDataUint8.length);
              new Uint8Array(fileData).set(fileDataUint8);

              // Upload to temp location first for prompt generation
              const tempR2Key = `temp/${presetId}_${Date.now()}.${filename.split('.').pop()}`;
              await R2_BUCKET.put(tempR2Key, fileData, {
                httpMetadata: {
                  contentType: 'image/png',
                  cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                },
              });

              const tempPublicUrl = getR2PublicUrl(env, tempR2Key, requestUrl.origin);

              // Generate Vertex AI prompt with retry
              const promptResult = await generateVertexPromptWithRetry(tempPublicUrl, env, isFilterMode, customPromptText);

              // Clean up temp file
              try {
                await R2_BUCKET.delete(tempR2Key);
              } catch (e) {
                // Ignore cleanup errors
              }

              if (!promptResult.success || !promptResult.prompt) {
                return {
                  success: false,
                  filename,
                  error: `Vertex AI prompt generation failed: ${promptResult.error || 'Unknown error'}`
                };
              }

              // Upload preset to final location with prompt metadata
              // Zip structure is always preset/*.webp, so use only "preset" folder (ignore any nested structure)
              // Filter out any path segments that have file extensions (these are filenames, not folders)
              const pathParts = relativePath.split('/').filter(p => p);
              pathParts.pop(); // Remove original filename
              // Filter out segments with file extensions (misnamed folders/filenames) and keep only valid folder names
              const cleanPathParts = pathParts.filter(part => !/\.(webp|png|json|jpg|jpeg|gif)$/i.test(part));
              // Use "preset" if it exists in path, otherwise use first valid folder or default to "preset"
              const folderPath = cleanPathParts.includes('preset') ? 'preset' : (cleanPathParts.length > 0 ? cleanPathParts[0] : 'preset');
              // Construct R2 key: preset/presetId.webp
              const presetR2Key = `${folderPath}/${presetId}.webp`;
              const promptJson = JSON.stringify(promptResult.prompt);

              
              // Retry R2 upload operation with exponential backoff
              let uploadSuccess = false;
              let lastUploadError: Error | null = null;
              const maxUploadRetries = 10;
              
              for (let uploadAttempt = 0; uploadAttempt < maxUploadRetries; uploadAttempt++) {
                try {
                  await R2_BUCKET.put(presetR2Key, fileData, {
                    httpMetadata: {
                      contentType: 'image/webp',
                      cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                    },
                    customMetadata: {
                      prompt_json: promptJson
                    }
                  });
                  
                  // Verify upload succeeded by checking if file exists
                  const verifyUpload = await R2_BUCKET.head(presetR2Key);
                  if (!verifyUpload) {
                    throw new Error('Upload verification failed: file not found after upload');
                  }
                  
                  uploadSuccess = true;
                  break;
                } catch (uploadError) {
                  lastUploadError = uploadError instanceof Error ? uploadError : new Error(String(uploadError));
                  const errorMsg = lastUploadError.message.toLowerCase();
                  
                  // Check if error is retryable
                  const isRetryable = 
                    errorMsg.includes('unspecified error') ||
                    errorMsg.includes('timeout') ||
                    errorMsg.includes('network') ||
                    errorMsg.includes('connection') ||
                    errorMsg.includes('500') ||
                    errorMsg.includes('503') ||
                    errorMsg.includes('502') ||
                    uploadAttempt < maxUploadRetries - 1;
                  
                  if (!isRetryable || uploadAttempt === maxUploadRetries - 1) {
                    break;
                  }
                  
                  // Exponential backoff with jitter
                  const baseDelay = 1000 * Math.pow(2, uploadAttempt);
                  const jitter = Math.random() * 0.3 * baseDelay;
                  const delay = Math.min(baseDelay + jitter, 10000);
                  console.warn(`[process-thumbnail-file] R2 upload attempt ${uploadAttempt + 1}/${maxUploadRetries} failed for ${presetId}: ${lastUploadError.message}. Retrying in ${Math.round(delay)}ms...`);
                  await new Promise(resolve => setTimeout(resolve, delay));
                }
              }
              
              if (!uploadSuccess) {
                const uploadErrorMsg = lastUploadError?.message || 'Unknown error';
                console.error(`[process-thumbnail-file] Failed to upload preset ${presetId} to R2 after ${maxUploadRetries} attempts:`, uploadErrorMsg);
                return {
                  success: false,
                  filename,
                  error: `Failed to upload preset to R2: ${uploadErrorMsg}`
                };
              }

              const presetPublicUrl = getR2PublicUrl(env, presetR2Key, requestUrl.origin);

              // Create placeholder thumbnail entries for all resolutions and ALL selected formats
              // These will be replaced when actual thumbnail files are uploaded via yyy.zip
              const resolutions = ['1x', '1.5x', '2x', '3x', '4x'];

              let thumbnailData: Record<string, string> = {};
              // Generate paths for each selected format (webp, json/lottie, avif, lottie_avif)
              for (const format of thumbnailFormats) {
                const ext = format === 'json' ? 'json' : 'webp';
                const formatPrefix = format === 'json' ? 'lottie' : 'webp';
                resolutions.forEach(res => {
                  thumbnailData[`${formatPrefix}_${res}`] = `preset_thumb/${formatPrefix}_${res}/${presetId}.${ext}`;
                });
                // Also add avif variants if webp is selected
                if (format === 'webp') {
                  resolutions.forEach(res => {
                    thumbnailData[`webp_avif_${res}`] = `preset_thumb/webp_avif_${res}/${presetId}.avif`;
                  });
                }
                // Also add lottie_avif variants if json/lottie is selected
                if (format === 'json') {
                  resolutions.forEach(res => {
                    thumbnailData[`lottie_avif_${res}`] = `preset_thumb/lottie_avif_${res}/${presetId}.avif`;
                  });
                }
              }

              // Use first format's 4x as primary thumbnail URL
              const primaryFormat = thumbnailFormats[0] || 'webp';
              const primaryPrefix = primaryFormat === 'json' ? 'lottie' : 'webp';
              let thumbnailUrl: string | null = getR2PublicUrl(env, thumbnailData[`${primaryPrefix}_4x`], requestUrl.origin);

              // Update database
              const existingPreset = await DB.prepare('SELECT id, thumbnail_r2, created_at FROM presets WHERE id = ?').bind(presetId).first();
              const createdAt = existingPreset && (existingPreset as any).created_at
                ? (existingPreset as any).created_at
                : Math.floor(Date.now() / 1000);

              // Merge with existing thumbnail data if any
              if (existingPreset && (existingPreset as any).thumbnail_r2) {
                try {
                  const existingThumbnailData = JSON.parse((existingPreset as any).thumbnail_r2 as string);
                  thumbnailData = { ...existingThumbnailData, ...thumbnailData };
                } catch (e) {
                  // If parsing fails, use new data
                }
              }

              // Use INSERT OR REPLACE to avoid UNIQUE constraint violations (prompt_json is stored in R2 metadata, not in D1)
              await DB.prepare(
                'INSERT OR REPLACE INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)'
              ).bind(
                presetId,
                'webp',
                createdAt,
                JSON.stringify(thumbnailData)
              ).run();

              // Delete KV cache for this preset (invalidate old cached prompt)
              const promptCacheKV = getPromptCacheKV(env);
              if (promptCacheKV) {
                const cacheKey = `prompt:${presetId}`;
                try {
                  await promptCacheKV.delete(cacheKey);
                  console.log(`[process-thumbnail-file] Deleted KV cache for ${cacheKey}`);
                } catch (kvError) {
                  console.warn(`[process-thumbnail-file] Failed to delete KV cache for ${cacheKey}:`, kvError);
                }
              }

              return {
                success: true,
                type: 'preset',
                preset_id: presetId,
                url: presetPublicUrl,
                hasPrompt: true,
                kvCacheDeleted: true,
                vertex_info: { success: true, promptKeys: Object.keys(promptResult.prompt) },
                thumbnail_url: thumbnailUrl,
                thumbnail_formats: thumbnailFormats,
                thumbnail_created: true
              };

            } catch (fileError) {
              const errorMsg = fileError instanceof Error ? fileError.message : String(fileError);
              return {
                success: false,
                filename,
                error: errorMsg.substring(0, 200)
              };
            }
          };

          // Process preset files with concurrency limit (5 at a time to prevent timeout)
          const concurrency = 5;
          const startTime = Date.now();
          const MAX_PROCESSING_TIME = 25000; // 25 seconds max
          let processedCount = 0;
          let timeoutReached = false;

          for (let i = 0; i < presetFiles.length; i += concurrency) {
            // Check if we're running out of time
            const elapsed = Date.now() - startTime;
            if (elapsed > MAX_PROCESSING_TIME) {
              console.warn(`[process-thumbnail-file] Timeout approaching, stopping processing. Processed ${processedCount}/${presetFiles.length} files`);
              timeoutReached = true;
              break;
            }

            const batch = presetFiles.slice(i, i + concurrency);

            const batchResults = await Promise.all(batch.map(processPresetFile));
            processedCount += batch.length;

            for (const result of batchResults) {
              if (result.success) {
                successful++;
                results.push(result);
                presetsProcessed++;
                if (result.hasPrompt) {
                  presetsWithPrompts++;
                }
              } else {
                failed++;
                results.push(result);
              }
            }

            // Small delay to prevent overwhelming the system
            if (i + concurrency < presetFiles.length) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }

          const totalTime = Date.now() - startTime;

          return successResponse({
            success: true,
            total: presetFiles.length,
            processed: processedCount,
            successful,
            failed,
            presets_processed: presetsProcessed,
            presets_with_prompts: presetsWithPrompts,
            timeout_reached: timeoutReached,
            processing_time_ms: totalTime,
            thumbnail_formats: thumbnailFormats
          }, 200, request, env);
        }

        // Handle single file upload (thumbnail files)
        const file = formData.get('file') as File | null;
        const filePath = (formData.get('path') as string | null) || '';

        if (!file) {
          return errorResponse('file is required', 400, undefined, request, env);
        }
        
        const filename = file.name;
        const basename = filename.split('/').pop() || filename.split('\\').pop() || filename;
        const parsed = parseThumbnailFilename(basename);
        
        if (!parsed) {
          return errorResponse('Invalid filename format. Could not extract preset_id from filename.', 400, undefined, request, env);
        }
        
        const { preset_id: presetId, format } = parsed;
        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        
        // Determine if this is a preset file or thumbnail
        const pathParts = normalizedPath.split('/').filter(p => p);
        const isFromPresetFolder = 
          normalizedPath.includes('preset/') || 
          normalizedPath.startsWith('preset/') || 
          normalizedPath.includes('/preset/') ||
          normalizedPath === 'preset' ||
          (pathParts.length > 0 && pathParts[0] === 'preset') ||
          (!normalizedPath && (filename.toLowerCase().endsWith('.webp') || filename.toLowerCase().endsWith('.png')));
        
        if (isFromPresetFolder) {
          // Preset file processing
          const fileData = await file.arrayBuffer();
          const contentType = file.type || 'image/png';
          // Support both thumbnail_formats (comma-separated) and thumbnail_format (single)
          const singleFileThumbnailFormatsRaw = (formData.get('thumbnail_formats') as string | null) || (formData.get('thumbnail_format') as string | null) || 'webp';
          const singleFileThumbnailFormats = singleFileThumbnailFormatsRaw.split(',').map(f => f.trim()).filter(f => f);
          
          // Upload to temp location first for prompt generation
          const tempR2Key = `temp/${presetId}_${Date.now()}.${filename.split('.').pop()}`;
          await R2_BUCKET.put(tempR2Key, fileData, {
            httpMetadata: {
              contentType,
              cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
            },
          });
          
          const tempPublicUrl = getR2PublicUrl(env, tempR2Key, requestUrl.origin);
          const isFilterMode = formData.get('is_filter_mode') === 'true';
          const customPromptText = formData.get('custom_prompt_text') as string | null;
          
          // Generate Vertex AI prompt with retry
          const promptResult = await generateVertexPromptWithRetry(tempPublicUrl, env, isFilterMode, customPromptText);
          
          // Clean up temp file
          try {
            await R2_BUCKET.delete(tempR2Key);
          } catch (e) {
            // Ignore cleanup errors
          }
          
          if (!promptResult.success || !promptResult.prompt) {
            return errorResponse(
              `Vertex AI prompt generation failed: ${promptResult.error || 'Unknown error'}`,
              500,
              { vertex_info: { success: false, error: promptResult.error, debug: promptResult.debug } },
              request,
              env
            );
          }
          
          // Upload preset to final location with prompt metadata, preserving exact folder structure
          // Extract folder structure from filePath (e.g., "preset/subfolder/file.png" -> "preset/subfolder")
          let folderPath = 'preset';
          if (filePath) {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const pathParts = normalizedPath.split('/').filter(p => p && p !== basename);
            // Filter out any path segments that match presetId to prevent duplicates
            const cleanPathParts = pathParts.filter(part => {
              const partWithoutExt = part.replace(/\.(webp|png|json)$/i, '');
              return partWithoutExt !== presetId;
            });
            if (cleanPathParts.length > 0) {
              folderPath = cleanPathParts.join('/');
            }
          }
          // Construct R2 key using exact folder structure from zip (preset/*.webp -> preset/presetId.webp)
          const presetR2Key = `${folderPath}/${presetId}.webp`;
          const promptJson = JSON.stringify(promptResult.prompt);
          
          
          // Retry R2 upload operation with exponential backoff
          let uploadSuccess = false;
          let lastUploadError: Error | null = null;
          const maxUploadRetries = 10;
          
          for (let uploadAttempt = 0; uploadAttempt < maxUploadRetries; uploadAttempt++) {
            try {
              await R2_BUCKET.put(presetR2Key, fileData, {
                httpMetadata: {
                  contentType: 'image/webp',
                  cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                },
                customMetadata: {
                  prompt_json: promptJson
                }
              });
              
              // Verify upload succeeded by checking if file exists
              const verifyUpload = await R2_BUCKET.head(presetR2Key);
              if (!verifyUpload) {
                throw new Error('Upload verification failed: file not found after upload');
              }
              
              uploadSuccess = true;
              break;
            } catch (uploadError) {
              lastUploadError = uploadError instanceof Error ? uploadError : new Error(String(uploadError));
              const errorMsg = lastUploadError.message.toLowerCase();
              
              // Check if error is retryable
              const isRetryable = 
                errorMsg.includes('unspecified error') ||
                errorMsg.includes('timeout') ||
                errorMsg.includes('network') ||
                errorMsg.includes('connection') ||
                errorMsg.includes('500') ||
                errorMsg.includes('503') ||
                errorMsg.includes('502') ||
                uploadAttempt < maxUploadRetries - 1;
              
              if (!isRetryable || uploadAttempt === maxUploadRetries - 1) {
                break;
              }
              
              // Exponential backoff with jitter
              const baseDelay = 1000 * Math.pow(2, uploadAttempt);
              const jitter = Math.random() * 0.3 * baseDelay;
              const delay = Math.min(baseDelay + jitter, 10000);
              console.warn(`[process-thumbnail-file] R2 upload attempt ${uploadAttempt + 1}/${maxUploadRetries} failed for ${presetId}: ${lastUploadError.message}. Retrying in ${Math.round(delay)}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
          
          if (!uploadSuccess) {
            const uploadErrorMsg = lastUploadError?.message || 'Unknown error';
            console.error(`[process-thumbnail-file] Failed to upload preset ${presetId} to R2 after ${maxUploadRetries} attempts:`, uploadErrorMsg, { presetR2Key, fileSize: fileData.byteLength });
            return errorResponse(
              `Failed to upload preset to R2: ${uploadErrorMsg}`,
              500,
              { presetId, presetR2Key, error: uploadErrorMsg },
              request,
              env
            );
          }
          
          const presetPublicUrl = getR2PublicUrl(env, presetR2Key, requestUrl.origin);

          // Create placeholder thumbnail entries for all resolutions and ALL selected formats
          // These will be replaced when actual thumbnail files are uploaded via yyy.zip
          const resolutions = ['1x', '1.5x', '2x', '3x', '4x'];

          let thumbnailData: Record<string, string> = {};
          // Generate paths for each selected format (webp, json/lottie, avif, lottie_avif)
          for (const format of singleFileThumbnailFormats) {
            const thumbExt = format === 'json' ? 'json' : 'webp';
            const formatPrefix = format === 'json' ? 'lottie' : 'webp';
            resolutions.forEach(res => {
              thumbnailData[`${formatPrefix}_${res}`] = `preset_thumb/${formatPrefix}_${res}/${presetId}.${thumbExt}`;
            });
            // Also add avif variants if webp is selected
            if (format === 'webp') {
              resolutions.forEach(res => {
                thumbnailData[`webp_avif_${res}`] = `preset_thumb/webp_avif_${res}/${presetId}.avif`;
              });
            }
            // Also add lottie_avif variants if json/lottie is selected
            if (format === 'json') {
              resolutions.forEach(res => {
                thumbnailData[`lottie_avif_${res}`] = `preset_thumb/lottie_avif_${res}/${presetId}.avif`;
              });
            }
          }

          // Use first format's 4x as primary thumbnail URL
          const primaryFormat = singleFileThumbnailFormats[0] || 'webp';
          const primaryPrefix = primaryFormat === 'json' ? 'lottie' : 'webp';
          let thumbnailUrl: string | null = getR2PublicUrl(env, thumbnailData[`${primaryPrefix}_4x`], requestUrl.origin);

          // Update database - use INSERT OR REPLACE to handle concurrent requests
          const existingPreset = await DB.prepare('SELECT id, thumbnail_r2, created_at FROM presets WHERE id = ?').bind(presetId).first();
          const createdAt = existingPreset && (existingPreset as any).created_at 
            ? (existingPreset as any).created_at 
            : Math.floor(Date.now() / 1000);
          const ext = filename.toLowerCase().endsWith('.json') ? 'json' : 'webp'; // Presets are always WebP (or JSON for Lottie)
          
          // Merge with existing thumbnail data if any
          if (existingPreset && (existingPreset as any).thumbnail_r2) {
            try {
              const existingThumbnailData = JSON.parse((existingPreset as any).thumbnail_r2 as string);
              thumbnailData = { ...existingThumbnailData, ...thumbnailData };
            } catch (e) {
              // If parsing fails, use new data
            }
          }
          
          // Use INSERT OR REPLACE to avoid UNIQUE constraint violations (prompt_json is stored in R2 metadata, not in D1)
          await DB.prepare(
            'INSERT OR REPLACE INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)'
          ).bind(
            presetId,
            ext,
            createdAt,
            JSON.stringify(thumbnailData)
          ).run();

          // Delete KV cache for this preset (invalidate old cached prompt)
          const promptCacheKV = getPromptCacheKV(env);
          if (promptCacheKV) {
            const cacheKey = `prompt:${presetId}`;
            try {
              await promptCacheKV.delete(cacheKey);
              console.log(`[process-thumbnail-file] Deleted KV cache for ${cacheKey}`);
            } catch (kvError) {
              console.warn(`[process-thumbnail-file] Failed to delete KV cache for ${cacheKey}:`, kvError);
            }
          }

          return successResponse({
            success: true,
            type: 'preset',
            preset_id: presetId,
            url: presetPublicUrl,
            hasPrompt: true,
            kvCacheDeleted: true,
            vertex_info: { success: true, promptKeys: Object.keys(promptResult.prompt) },
            thumbnail_url: thumbnailUrl,
            thumbnail_formats: singleFileThumbnailFormats,
            thumbnail_created: true
          }, 200, request, env);
        } else {
          // Thumbnail file processing - preserve exact folder structure from filePath
          // Extract folder structure from filePath (e.g., "preset_thumb/webp_3x/file.webp" -> "preset_thumb/webp_3x")
          let folderPath = 'preset_thumb';
          if (filePath) {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const pathParts = normalizedPath.split('/').filter(p => p && p !== basename);
            // Filter out any path segments that match presetId to prevent duplicates
            const cleanPathParts = pathParts.filter(part => {
              const partWithoutExt = part.replace(/\.(webp|png|json)$/i, '');
              return partWithoutExt !== presetId;
            });
            if (cleanPathParts.length > 0) {
              folderPath = cleanPathParts.join('/');
            }
          }
          const ext = filename.split('.').pop() || (format === 'lottie' ? 'json' : 'webp');
          // Construct R2 key using exact folder structure from filePath
          const thumbnailR2Key = `${folderPath}/${presetId}.${ext}`;
          
          // Extract folder type and resolution for metadata (for backward compatibility)
          const folderMatch = normalizedPath.match(/(webp|lottie|lottie_avif)_([\d.]+x)(?:\/|$)/i);
          let folderType = 'webp';
          let resolution = '1x';
          if (folderMatch) {
            folderType = folderMatch[1].toLowerCase();
            resolution = folderMatch[2];
          }
          const thumbnailFolder = `${folderType}_${resolution}`;
          
          const fileData = await file.arrayBuffer();
          const contentType = file.type || 'image/webp';
          
          await R2_BUCKET.put(thumbnailR2Key, fileData, {
            httpMetadata: {
              contentType,
              cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
            },
          });
          
          const thumbnailUrl = getR2PublicUrl(env, thumbnailR2Key, requestUrl.origin);
          
          // Update database - use INSERT OR REPLACE to handle concurrent requests
          const existingPreset = await DB.prepare('SELECT id, thumbnail_r2, created_at FROM presets WHERE id = ?').bind(presetId).first();
          let thumbnailData: Record<string, string> = {};
          
          if (existingPreset && (existingPreset as any).thumbnail_r2) {
            try {
              thumbnailData = JSON.parse((existingPreset as any).thumbnail_r2 as string);
            } catch (e) {
              thumbnailData = {};
            }
          }
          
          thumbnailData[thumbnailFolder] = thumbnailR2Key;
          
          // Preserve created_at from existing record, or use current timestamp
          const createdAt = existingPreset && (existingPreset as any).created_at 
            ? (existingPreset as any).created_at 
            : Math.floor(Date.now() / 1000);
          const extForDb = filename.toLowerCase().endsWith('.json') ? 'json' : 'webp';
          
          // Use INSERT OR REPLACE to avoid UNIQUE constraint violations
          await DB.prepare(
            'INSERT OR REPLACE INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)'
          ).bind(
            presetId, 
            extForDb, 
            createdAt,
            JSON.stringify(thumbnailData)
          ).run();
          
          return successResponse({
            success: true,
            type: 'thumbnail',
            preset_id: presetId,
            url: thumbnailUrl,
            hasPrompt: false,
            metadata: { format: folderType, resolution }
          }, 200, request, env);
        }
      }, 10, 1000);
      } catch (error) {
        logCriticalError('/process-thumbnail-file', error, request, env, {
          errorType: 'unhandled_error'
        });
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        const debugEnabled = isDebugEnabled(env);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path } : undefined, request, env);
      }
    }

    // Handle zip file upload and process all files server-side
    if (path === '/process-thumbnail-zip' && request.method === 'POST') {
      const startTime = Date.now();
      const MAX_PROCESSING_TIME = 25000; // 25 seconds max (leave 5s buffer for response)
      const MAX_FILES = 500; // Limit to 500 files per request to prevent timeout
      
      try {
        const formData = await request.formData();
        const zipFile = formData.get('zip') as File | null;
        const isFilterMode = formData.get('is_filter_mode') === 'true';
        const customPromptText = formData.get('custom_prompt_text') as string | null;

        if (!zipFile) {
          return errorResponse('zip file is required', 400, undefined, request, env);
        }

        console.log('[process-thumbnail-zip] Starting zip processing, file size:', zipFile.size);

        const DB = getD1Database(env);
        const R2_BUCKET = getR2Bucket(env);
        const requestUrl = new URL(request.url);

        // Extract zip file
        console.log('[process-thumbnail-zip] Extracting zip file...');
        const zipData = await zipFile.arrayBuffer();
        const zip = await JSZip.loadAsync(zipData);

        const results: any[] = [];
        let successful = 0;
        let failed = 0;
        let presetsProcessed = 0;
        let thumbnailsProcessed = 0;
        let presetsWithPrompts = 0;

        // Process all files in the zip
        const fileEntries: Array<{ path: string; zipEntry: JSZip.JSZipObject }> = [];
        zip.forEach((relativePath: string, zipEntry: JSZip.JSZipObject) => {
          if (!zipEntry.dir) {
            fileEntries.push({ path: relativePath, zipEntry });
          }
        });

        console.log(`[process-thumbnail-zip] Found ${fileEntries.length} files in zip`);

        // Limit number of files to prevent timeout
        if (fileEntries.length > MAX_FILES) {
          return errorResponse(
            `Too many files in zip. Maximum ${MAX_FILES} files allowed, found ${fileEntries.length}. Please split into smaller zip files.`,
            400,
            { maxFiles: MAX_FILES, found: fileEntries.length },
            request,
            env
          );
        }

        // Process files with controlled concurrency (10 at a time)
        const processFile = async ({ path: relativePath, zipEntry }: { path: string; zipEntry: JSZip.JSZipObject }) => {
          try {
            const filename = zipEntry.name.split('/').pop() || zipEntry.name.split('\\').pop() || zipEntry.name;
            const basename = filename;
            const parsed = parseThumbnailFilename(basename);

            if (!parsed) {
              return {
                success: false,
                filename: relativePath,
                error: 'Invalid filename format'
              };
            }

            const { preset_id: presetId, format } = parsed;
            const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();

            // Determine if this is a preset file or thumbnail
            const pathParts = normalizedPath.split('/').filter(p => p);
            const isFromPresetFolder =
              normalizedPath.includes('preset/') ||
              normalizedPath.startsWith('preset/') ||
              normalizedPath.includes('/preset/') ||
              normalizedPath === 'preset' ||
              (pathParts.length > 0 && pathParts[0] === 'preset') ||
              (!normalizedPath && filename.toLowerCase().endsWith('.png'));

            const fileDataUint8 = await zipEntry.async('uint8array');
            if (!fileDataUint8 || fileDataUint8.length === 0) {
              return {
                success: false,
                filename: relativePath,
                error: 'File is empty'
              };
            }

            // Convert Uint8Array to ArrayBuffer (create new ArrayBuffer to avoid SharedArrayBuffer issues)
            const fileData = new ArrayBuffer(fileDataUint8.length);
            new Uint8Array(fileData).set(fileDataUint8);

            if (isFromPresetFolder) {
              // Preset file processing
              const contentType = filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/webp';

              // Check if we have enough time for prompt generation (need at least 20 seconds)
              const elapsed = Date.now() - startTime;
              const skipPromptGeneration = elapsed > (MAX_PROCESSING_TIME - 20000);

              let promptResult: any = { success: false, error: 'Skipped due to timeout' };
              
              if (!skipPromptGeneration) {
                // Upload to temp location first for prompt generation
                const tempR2Key = `temp/${presetId}_${Date.now()}.${filename.split('.').pop()}`;
                await R2_BUCKET.put(tempR2Key, fileData, {
                  httpMetadata: {
                    contentType,
                    cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                  },
                });

                const tempPublicUrl = getR2PublicUrl(env, tempR2Key, requestUrl.origin);

                // Generate Vertex AI prompt with retry
                promptResult = await generateVertexPromptWithRetry(tempPublicUrl, env, isFilterMode === true, customPromptText);

                // Clean up temp file
                try {
                  await R2_BUCKET.delete(tempR2Key);
                } catch (e) {
                  // Ignore cleanup errors
                }
              }

              if (!skipPromptGeneration && (!promptResult.success || !promptResult.prompt)) {
                return {
                  success: false,
                  filename: relativePath,
                  error: `Vertex AI prompt generation failed: ${promptResult.error || 'Unknown error'}`
                };
              }

              // Upload to final location with prompt metadata (if available)
              // Zip structure is always preset/*.webp, so use only "preset" folder (ignore any nested structure)
              // Filter out any path segments that have file extensions (these are filenames, not folders)
              const pathParts = normalizedPath.split('/').filter(p => p); // Remove empty parts
              pathParts.pop(); // Remove original filename
              // Filter out segments with file extensions (misnamed folders/filenames) and keep only valid folder names
              const cleanPathParts = pathParts.filter(part => !/\.(webp|png|json|jpg|jpeg|gif)$/i.test(part));
              // Use "preset" if it exists in path, otherwise use first valid folder or default to "preset"
              const folderPath = cleanPathParts.includes('preset') ? 'preset' : (cleanPathParts.length > 0 ? cleanPathParts[0] : (isFromPresetFolder ? 'preset' : ''));
              // Construct R2 key: preset/presetId.ext
              const r2Key = folderPath ? `${folderPath}/${presetId}.${filename.split('.').pop()}` : `${presetId}.${filename.split('.').pop()}`;
              const promptJson = skipPromptGeneration ? null : JSON.stringify(promptResult.prompt);

              await R2_BUCKET.put(r2Key, fileData, {
                httpMetadata: {
                  contentType,
                  cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                },
                ...(promptJson ? {
                  customMetadata: {
                    prompt_json: promptJson
                  }
                } : {})
              });

              const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);

              // Update database - use INSERT OR REPLACE
              const existingPreset = await DB.prepare('SELECT id, thumbnail_r2, created_at FROM presets WHERE id = ?').bind(presetId).first();
              const createdAt = existingPreset && (existingPreset as any).created_at
                ? (existingPreset as any).created_at
                : Math.floor(Date.now() / 1000);
              const ext = filename.toLowerCase().endsWith('.json') ? 'json' : 'webp'; // Presets are always WebP (or JSON for Lottie)

              // Use existing thumbnail_r2 if available, otherwise use preset image as default thumbnail
              let thumbnailR2Json: string;
              if (existingPreset && (existingPreset as any).thumbnail_r2) {
                // Preserve existing thumbnail data
                thumbnailR2Json = (existingPreset as any).thumbnail_r2 as string;
              } else {
                // Set preset image as default 4x thumbnail for new presets
                thumbnailR2Json = JSON.stringify({ webp_4x: r2Key });
              }

              await DB.prepare(
                'INSERT OR REPLACE INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)'
              ).bind(presetId, ext, createdAt, thumbnailR2Json).run();

              return {
                success: true,
                type: 'preset',
                preset_id: presetId,
                url: publicUrl,
                hasPrompt: !skipPromptGeneration && promptResult.success && !!promptResult.prompt,
                vertex_info: skipPromptGeneration 
                  ? { success: false, error: 'Skipped due to timeout' }
                  : (promptResult.success && promptResult.prompt 
                    ? { success: true, promptKeys: Object.keys(promptResult.prompt) }
                    : { success: false, error: promptResult.error || 'Unknown error' })
              };
            } else {
              // Thumbnail file processing - preserve exact folder structure from zip
              // Use relativePath directly from zip (e.g., "preset_thumb/webp_3x/file.webp" -> "preset_thumb/webp_3x/presetId.webp")
              const pathParts = normalizedPath.split('/').filter(p => p); // Remove empty parts
              pathParts.pop(); // Remove original filename
              // Filter out any path segments that match presetId to prevent duplicates
              const cleanPathParts = pathParts.filter(part => {
                const partWithoutExt = part.replace(/\.(webp|png|json)$/i, '');
                return partWithoutExt !== presetId;
              });
              const folderPath = cleanPathParts.length > 0 ? cleanPathParts.join('/') : 'preset_thumb';
              const ext = filename.split('.').pop() || (format === 'lottie' ? 'json' : 'webp');
              // Construct R2 key using exact folder structure from zip
              const thumbnailR2Key = `${folderPath}/${presetId}.${ext}`;
              
              // Extract folder type and resolution for metadata (for backward compatibility)
              const folderMatch = normalizedPath.match(/(webp|lottie|lottie_avif)_([\d.]+x)(?:\/|$)/i);
              let folderType = 'webp';
              let resolution = '1x';
              if (folderMatch) {
                folderType = folderMatch[1].toLowerCase();
                resolution = folderMatch[2];
              }
              const thumbnailFolder = `${folderType}_${resolution}`;

              const contentType = filename.toLowerCase().endsWith('.json') ? 'application/json' : 'image/webp';

              await R2_BUCKET.put(thumbnailR2Key, fileData, {
                httpMetadata: {
                  contentType,
                  cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                },
              });

              const thumbnailUrl = getR2PublicUrl(env, thumbnailR2Key, requestUrl.origin);

              // Update database - use INSERT OR REPLACE
              const existingPreset = await DB.prepare('SELECT id, thumbnail_r2, created_at FROM presets WHERE id = ?').bind(presetId).first();
              let thumbnailData: Record<string, string> = {};

              if (existingPreset && (existingPreset as any).thumbnail_r2) {
                try {
                  thumbnailData = JSON.parse((existingPreset as any).thumbnail_r2 as string);
                } catch (e) {
                  thumbnailData = {};
                }
              }

              thumbnailData[thumbnailFolder] = thumbnailR2Key;

              const createdAt = existingPreset && (existingPreset as any).created_at
                ? (existingPreset as any).created_at
                : Math.floor(Date.now() / 1000);
              const extForDb = filename.toLowerCase().endsWith('.json') ? 'json' : 'webp';

              await DB.prepare(
                'INSERT OR REPLACE INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)'
              ).bind(
                presetId,
                extForDb,
                createdAt,
                JSON.stringify(thumbnailData)
              ).run();

              return {
                success: true,
                type: 'thumbnail',
                preset_id: presetId,
                url: thumbnailUrl,
                hasPrompt: false,
                metadata: { format: folderType, resolution }
              };
            }
          } catch (fileError) {
            const errorMsg = fileError instanceof Error ? fileError.message : String(fileError);
            return {
              success: false,
              filename: relativePath,
              error: errorMsg.substring(0, 200)
            };
          }
        };

        // Process files with concurrency limit (5 at a time to prevent timeout)
        const concurrency = 5;
        let processedCount = 0;
        let timeoutReached = false;

        for (let i = 0; i < fileEntries.length; i += concurrency) {
          // Check if we're running out of time
          const elapsed = Date.now() - startTime;
          if (elapsed > MAX_PROCESSING_TIME) {
            console.warn(`[process-thumbnail-zip] Timeout approaching, stopping processing. Processed ${processedCount}/${fileEntries.length} files`);
            timeoutReached = true;
            break;
          }

          const batch = fileEntries.slice(i, i + concurrency);
          console.log(`[process-thumbnail-zip] Processing batch ${Math.floor(i / concurrency) + 1}, files ${i + 1}-${Math.min(i + concurrency, fileEntries.length)}`);
          
          const batchResults = await Promise.all(batch.map(processFile));
          processedCount += batch.length;

          for (const result of batchResults) {
            if (result.success) {
              successful++;
              results.push(result);
              if (result.type === 'preset') {
                presetsProcessed++;
                if (result.hasPrompt) {
                  presetsWithPrompts++;
                }
              } else if (result.type === 'thumbnail') {
                thumbnailsProcessed++;
              }
            } else {
              failed++;
              results.push(result);
            }
          }

          // Small delay to prevent overwhelming the system
          if (i + concurrency < fileEntries.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        const totalTime = Date.now() - startTime;
        console.log(`[process-thumbnail-zip] Processing complete. Time: ${totalTime}ms, Processed: ${processedCount}/${fileEntries.length}, Success: ${successful}, Failed: ${failed}`);

        return successResponse({
          total: fileEntries.length,
          processed: processedCount,
          successful,
          failed,
          presets_processed: presetsProcessed,
          presets_with_prompts: presetsWithPrompts,
          thumbnails_processed: thumbnailsProcessed,
          timeout_reached: timeoutReached,
          processing_time_ms: totalTime,
          results: timeoutReached ? results.slice(0, 100) : results // Limit results if timeout
        }, 200, request, env);

      } catch (error) {
        logCriticalError('/process-thumbnail-zip', error, request, env, {
          errorType: 'unhandled_error'
        });
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        const debugEnabled = isDebugEnabled(env);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path } : undefined, request, env);
      }
    }

    // Handle profile creation
    if (path === '/profiles' && request.method === 'POST') {
      let body: Partial<Profile & { userID?: string; id?: string; device_id?: string; user_id?: string }> | undefined;
      try {
        body = await request.json() as Partial<Profile & { userID?: string; id?: string; device_id?: string; user_id?: string }>;
        const deviceId = body.device_id || request.headers.get('x-device-id') || null;
        const userId = body.userID || body.user_id || null; // External user ID for searching
        const profileId = body.id || nanoid(16); // Profile ID is always auto-generated or provided via id field

        const tableCheck = await DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='profiles'"
        ).first();
        
        if (!tableCheck) {
          console.error('ERROR: profiles table does not exist in database!');
          console.error('Database schema needs to be initialized. Run: wrangler d1 execute faceswap-db --remote --file=schema.sql');
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { path } : undefined, request, env);
        }

        // Check for existing profile by id or user_id
        if (body.id || userId) {
          let existingProfile = null;

          // Check by profile ID
          if (body.id) {
            existingProfile = await DB.prepare(
              'SELECT id FROM profiles WHERE id = ?'
            ).bind(profileId).first();
          }

          // Also check by user_id if provided
          if (!existingProfile && userId) {
            existingProfile = await DB.prepare(
              'SELECT id FROM profiles WHERE user_id = ?'
            ).bind(userId).first();
          }

          if (existingProfile) {
            const debugEnabled = isDebugEnabled(env);
            return errorResponse('Profile already exists', 409, debugEnabled ? { profileId, userId, path } : undefined, request, env);
          }
        }

        const createdAt = Math.floor(Date.now() / 1000);
        const updatedAt = Math.floor(Date.now() / 1000);
        
        // Convert preferences to JSON string if it's an object
        const preferencesString = body.preferences 
          ? (typeof body.preferences === 'string' ? body.preferences : JSON.stringify(body.preferences))
          : null;

        const result = await DB.prepare(
          'INSERT INTO profiles (id, device_id, user_id, name, email, avatar_url, preferences, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          profileId,
          deviceId,
          userId,
          body.name || null,
          body.email || null,
          body.avatar_url || null,
          preferencesString,
          createdAt,
          updatedAt
        ).run();


        if (!result.success) {
          console.error('[DB] Profile insert failed');
          const errorDetails = result.meta?.error || (result as any).error || 'Unknown database error';
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { error: errorDetails, profileId, path } : undefined, request, env);
        }

        if (result.meta?.changes === 0) {
          console.error('[DB] Profile insert returned 0 changes');
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { profileId, path } : undefined, request, env);
        }

        const profile = {
          id: profileId,
          device_id: deviceId || undefined,
          user_id: userId || undefined,
          name: body.name || undefined,
          email: body.email || undefined,
          avatar_url: body.avatar_url || undefined,
          preferences: body.preferences || undefined,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: profile,
          status: 'success',
          message: 'Profile created successfully',
          code: 200,
          ...(debugEnabled ? { debug: { profileId, deviceId, userId } } : {})
        }, 200, request, env);
      } catch (error) {
        logCriticalError('/profiles (POST)', error, request, env, {
          body: {
            device_id: body?.device_id ? '***present***' : 'missing',
            userID: body?.userID || body?.user_id,
            id: body?.id,
            profile_id: body?.id || 'auto-generated'
          }
        });
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {}) } : undefined, request, env);
      }
    }

    // Handle profile retrieval (supports profile ID, device ID, and user_id)
    if (path.startsWith('/profiles/') && request.method === 'GET') {
      try {
        const idParam = extractPathId(path, '/profiles/');
        if (!idParam) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        let foundBy = '';

        // Try to find by profile ID first
        let result = await DB.prepare(
          'SELECT id, device_id, user_id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles WHERE id = ?'
        ).bind(idParam).first();
        if (result) foundBy = 'profile_id';

        // If not found by ID, try by device_id
        if (!result) {
          result = await DB.prepare(
            'SELECT id, device_id, user_id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles WHERE device_id = ?'
          ).bind(idParam).first();
          if (result) foundBy = 'device_id';
        }

        // If not found by device_id, try by user_id
        if (!result) {
          result = await DB.prepare(
            'SELECT id, device_id, user_id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles WHERE user_id = ?'
          ).bind(idParam).first();
          if (result) foundBy = 'user_id';
        }

        if (!result) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { idParam, searchedBy: 'id, device_id, and user_id', path } : undefined, request, env);
        }

        const profile: Profile = {
          id: (result as any).id,
          device_id: (result as any).device_id || undefined,
          user_id: (result as any).user_id || undefined,
          name: (result as any).name || undefined,
          email: (result as any).email || undefined,
          avatar_url: (result as any).avatar_url || undefined,
          preferences: (result as any).preferences || undefined,
          created_at: new Date((result as any).created_at * 1000).toISOString(),
          updated_at: new Date((result as any).updated_at * 1000).toISOString()
        };

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: profile,
          status: 'success',
          message: 'Profile retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { idParam, foundBy } } : {})
        }, 200, request, env);
      } catch (error) {
        logCriticalError('/profiles/{id} (GET)', error, request, env, {
          idParam: extractPathId(path, '/profiles/')
        });
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {}) } : undefined, request, env);
      }
    }

    // Handle profile update
    if (path.startsWith('/profiles/') && request.method === 'PUT') {
      try {
        const profileId = extractPathId(path, '/profiles/');
        if (!profileId) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }
        const body = await request.json() as Partial<Profile>;

        // Convert preferences to JSON string if it's an object
        const preferencesString = body.preferences 
          ? (typeof body.preferences === 'string' ? body.preferences : JSON.stringify(body.preferences))
          : null;

        const result = await DB.prepare(
          'UPDATE profiles SET name = ?, email = ?, avatar_url = ?, preferences = ?, updated_at = ? WHERE id = ?'
        ).bind(
          body.name || null,
          body.email || null,
          body.avatar_url || null,
          preferencesString,
          Math.floor(Date.now() / 1000),
          profileId
        ).run();

        if (!result.success || result.meta?.changes === 0) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found or update failed', 404, debugEnabled ? { profileId, path } : undefined, request, env);
        }

        // Return updated profile
        const updatedResult = await DB.prepare(
          'SELECT id, device_id, user_id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles WHERE id = ?'
        ).bind(profileId).first();

        if (!updatedResult) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found after update', 404, debugEnabled ? { profileId, path } : undefined, request, env);
        }

        const profile: Profile = {
          id: profileId,
          device_id: (updatedResult as any).device_id || undefined,
          user_id: (updatedResult as any).user_id || undefined,
          name: (updatedResult as any).name || undefined,
          email: (updatedResult as any).email || undefined,
          avatar_url: (updatedResult as any).avatar_url || undefined,
          preferences: (updatedResult as any).preferences || undefined,
          created_at: new Date((updatedResult as any).created_at * 1000).toISOString(),
          updated_at: new Date((updatedResult as any).updated_at * 1000).toISOString()
        };

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: profile,
          status: 'success',
          message: 'Profile updated successfully',
          code: 200,
          ...(debugEnabled ? { debug: { profileId } } : {})
        }, 200, request, env);
      } catch (error) {
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Handle profile listing (for admin/debugging)
    if (path === '/profiles' && request.method === 'GET') {
      try {
        const results = await DB.prepare(
          'SELECT id, device_id, user_id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles ORDER BY created_at DESC'
        ).all();

        const profiles: Profile[] = results.results?.map((row: any) => ({
          id: row.id,
          device_id: row.device_id || undefined,
          user_id: row.user_id || undefined,
          name: row.name || undefined,
          email: row.email || undefined,
          avatar_url: row.avatar_url || undefined,
          preferences: row.preferences || undefined,
          created_at: new Date(row.created_at * 1000).toISOString(),
          updated_at: new Date(row.updated_at * 1000).toISOString()
        })) || [];

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { profiles },
          status: 'success',
          message: 'Profiles retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { count: profiles.length } } : {})
        }, 200, request, env);
      } catch (error) {
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Handle preset listing
    // Get single preset by ID
    if (path.startsWith('/presets/') && path.split('/').length === 3 && request.method === 'GET') {
      try {
        const R2_BUCKET = getR2Bucket(env);
        const presetId = extractPathId(path, '/presets/');
        if (!presetId) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const DB = getD1Database(env);
        const result = await DB.prepare(
          'SELECT id, ext, thumbnail_r2, created_at FROM presets WHERE id = ?'
        ).bind(presetId).first();

        if (!result) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Preset not found', 404, debugEnabled ? { presetId, path } : undefined, request, env);
        }

        const storedKey = reconstructR2Key((result as any).id, (result as any).ext, 'preset');
        const presetUrl = getR2PublicUrl(env, storedKey, requestUrl.origin);
        
        // Extract thumbnail information from thumbnail_r2 JSON
        let thumbnailUrl: string | null = null;
        let thumbnailFormat: string | null = null;
        let thumbnailResolution: string | null = null;
        let thumbnailData: any = {};

        if ((result as any).thumbnail_r2) {
          try {
            thumbnailData = JSON.parse((result as any).thumbnail_r2);
            // Use webp_1x as primary thumbnail, fallback to lottie_1x
            const primaryThumbnailKey = thumbnailData['webp_1x'] || thumbnailData['lottie_1x'];
            if (primaryThumbnailKey) {
              thumbnailUrl = getR2PublicUrl(env, primaryThumbnailKey, requestUrl.origin);
              // Extract format and resolution from the key
              const keyParts = primaryThumbnailKey.split('/');
              if (keyParts.length > 0) {
                const prefix = keyParts[0];
                const formatMatch = prefix.match(/^(webp|lottie)/i);
                const resolutionMatch = prefix.match(/([\d.]+x)/i);
                thumbnailFormat = formatMatch ? formatMatch[1].toLowerCase() : null;
                thumbnailResolution = resolutionMatch ? resolutionMatch[1] : null;
              }
            }
          } catch (e) {
            // Fallback: treat as single string for backward compatibility
            thumbnailUrl = getR2PublicUrl(env, (result as any).thumbnail_r2, requestUrl.origin);
            const r2KeyParts = (result as any).thumbnail_r2.split('/');
            if (r2KeyParts.length > 0) {
              const prefix = r2KeyParts[0];
              const formatMatch = prefix.match(/^(webp|lottie)/i);
              const resolutionMatch = prefix.match(/([\d.]+x)/i);
              thumbnailFormat = formatMatch ? formatMatch[1].toLowerCase() : null;
              thumbnailResolution = resolutionMatch ? resolutionMatch[1] : null;
            }
          }
        }
        
        // Read prompt_json from R2 metadata
        let hasPrompt = false;
        let promptJson: any = null;
        try {
          const r2Object = await R2_BUCKET.head(storedKey);
          if (r2Object?.customMetadata?.prompt_json) {
            const promptJsonString = r2Object.customMetadata.prompt_json;
            if (promptJsonString && promptJsonString.trim() !== '') {
              try {
                promptJson = JSON.parse(promptJsonString);
                hasPrompt = true;
              } catch {
                // Invalid JSON, ignore
              }
            }
          }
        } catch {
          // R2 check failed, assume no prompt
        }

        // Build response with all thumbnail URLs from JSON data
        const responseData: any = {
          id: (result as any).id,
          preset_url: presetUrl,
          image_url: presetUrl, // Alias for backward compatibility
          hasPrompt,
          prompt_json: promptJson,
          thumbnail_url: thumbnailUrl, // Primary thumbnail (1x)
          thumbnail_format: thumbnailFormat,
          thumbnail_resolution: thumbnailResolution,
          thumbnail_r2: (result as any).thumbnail_r2, // Full JSON data
          created_at: (result as any).created_at ? new Date((result as any).created_at * 1000).toISOString() : new Date().toISOString()
        };

        // Add individual thumbnail URLs for each resolution/format
        Object.keys(thumbnailData).forEach(key => {
          const url = getR2PublicUrl(env, thumbnailData[key], requestUrl.origin);
          responseData[key] = url;
        });

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: responseData,
          status: 'success',
          message: 'Preset retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { presetId, hasPrompt, thumbnailCount: Object.keys(thumbnailData).length } } : {})
        }, 200, request, env);
      } catch (error) {
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    if (path === '/presets' && request.method === 'GET') {
      try {
        const R2_BUCKET = getR2Bucket(env);
        // Gender filter removed - metadata is in R2 path, not DB
        const url = new URL(request.url);

        const excludeThumbnails = url.searchParams.get('exclude_thumbnails') === 'true';
        
        // By default, include all presets. Use exclude_thumbnails=true to filter out presets with thumbnails
        let query = `
          SELECT
            id,
            ext,
            thumbnail_r2,
            created_at
          FROM presets
          WHERE ${excludeThumbnails ? 'thumbnail_r2 IS NULL' : '1=1'}
        `;

        const params: any[] = [];
        
        const limitParam = url.searchParams.get('limit');
        let limit = 50;
        if (limitParam) {
          const parsedLimit = parseInt(limitParam, 10);
          if (!isNaN(parsedLimit) && parsedLimit > 0 && parsedLimit <= 50) {
            limit = parsedLimit;
          }
        }

        query += ` ORDER BY created_at DESC LIMIT ${limit}`;

        const imagesResult = await DB.prepare(query).bind(...params).all();

        if (!imagesResult || !imagesResult.results) {
          const debugEnabled = isDebugEnabled(env);
          return jsonResponse({
            data: { presets: [] },
            status: 'success',
            message: 'Presets retrieved successfully',
            code: 200,
            ...(debugEnabled ? { debug: { count: 0 } } : {})
          }, 200, request, env);
        }

        // Flatten to match frontend expectations
        const presets = await Promise.all(imagesResult.results.map(async (row: any) => {
          const storedKey = reconstructR2Key(row.id, row.ext, 'preset');
          const fullUrl = getR2PublicUrl(env, storedKey, requestUrl.origin);
          
          // Parse thumbnail_r2 JSON to extract 4x thumbnail
          let thumbnailUrl: string | null = null;
          let thumbnailFormat: string | null = null;
          let thumbnailResolution: string | null = null;
          let thumbnailR2Key: string | null = null;
          
          if (row.thumbnail_r2) {
            try {
              // Parse thumbnail_r2 as JSON (e.g., {"webp_4x": "preset/{id}.{ext}"})
              const thumbnailData = typeof row.thumbnail_r2 === 'string' 
                ? JSON.parse(row.thumbnail_r2) 
                : row.thumbnail_r2;
              
              // Extract webp_4x thumbnail key
              thumbnailR2Key = thumbnailData['webp_4x'] || thumbnailData['lottie_4x'] || thumbnailData['lottie_avif_4x'] || null;
              
              if (thumbnailR2Key) {
                thumbnailUrl = getR2PublicUrl(env, thumbnailR2Key, requestUrl.origin);
                // Extract format and resolution from R2 key (e.g., "preset_thumb/webp_4x/fs_aging_f1_3.webp")
                const r2KeyParts = thumbnailR2Key.split('/');
                if (r2KeyParts.length > 0) {
                  // Check if path contains format/resolution info
                  const keyStr = thumbnailR2Key.toLowerCase();
                  if (keyStr.includes('webp_4x')) {
                    thumbnailFormat = 'webp';
                    thumbnailResolution = '4x';
                  } else if (keyStr.includes('lottie_4x')) {
                    thumbnailFormat = 'lottie';
                    thumbnailResolution = '4x';
                  } else if (keyStr.includes('lottie_avif_4x')) {
                    thumbnailFormat = 'lottie_avif';
                    thumbnailResolution = '4x';
                  }
                }
              }
            } catch (e) {
              // If parsing fails, thumbnail_r2 might be a direct string (legacy format)
              // Try to use it directly
              try {
                if (typeof row.thumbnail_r2 === 'string' && row.thumbnail_r2.trim()) {
                  const legacyKey = row.thumbnail_r2.trim();
                  thumbnailR2Key = legacyKey;
                  thumbnailUrl = getR2PublicUrl(env, legacyKey, requestUrl.origin);
                }
              } catch (err) {
                // Ignore errors
              }
            }
          }
          
          // Check if prompt_json exists in R2 metadata (for hasPrompt)
          let hasPrompt = false;
          try {
            const r2Object = await R2_BUCKET.head(storedKey);
            hasPrompt = !!(r2Object?.customMetadata?.prompt_json);
          } catch {
            // If R2 check fails, assume no prompt
          }
          
          // Use thumbnail URL as image_url if available, otherwise use original preset URL
          const displayUrl = thumbnailUrl || fullUrl;
          
          return {
            id: row.id || '',
            preset_url: fullUrl, // Always include original preset URL
            image_url: displayUrl, // Use thumbnail if available, otherwise original
            hasPrompt,
            prompt_json: null, // Not included in list view for performance (read from R2 metadata in detail view)
            thumbnail_url: thumbnailUrl,
            thumbnail_format: thumbnailFormat,
            thumbnail_resolution: thumbnailResolution,
            created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
          };
        }));

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { presets },
          status: 'success',
          message: 'Presets retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { count: presets.length } } : {})
        }, 200, request, env);
      } catch (error) {
        // Return empty array instead of error to prevent UI breaking
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { presets: [] },
          status: 'success',
          message: 'Presets retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200), count: 0 } } : {})
        }, 200, request, env);
      }
    }

    // Handle preset deletion
    if (path.startsWith('/presets/') && request.method === 'DELETE') {
      try {
        const presetId = extractPathId(path, '/presets/');
        if (!presetId) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }


        // First, check if preset exists
        const checkResult = await DB.prepare(
          'SELECT id, ext FROM presets WHERE id = ?'
        ).bind(presetId).first();

        if (!checkResult) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Preset not found', 404, debugEnabled ? { presetId, path } : undefined, request, env);
        }

        const storedKey = reconstructR2Key((checkResult as any).id, (checkResult as any).ext, 'preset');
        const r2Key = storedKey;

        // Delete preset from database
        // NOTE: Results are NOT deleted when preset is deleted - they belong to profiles and should be preserved
        const deleteResult = await DB.prepare(
          'DELETE FROM presets WHERE id = ?'
        ).bind(presetId).run();

        if (!deleteResult.success || deleteResult.meta?.changes === 0) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Preset not found or already deleted', 404, debugEnabled ? { presetId, path } : undefined, request, env);
        }

        // Try to delete from R2 (non-fatal if it fails)
        let r2Deleted = false;
        let r2Error = null;
        if (r2Key) {
          try {
            await R2_BUCKET.delete(r2Key);
            r2Deleted = true;
          } catch (r2DeleteError) {
            r2Error = r2DeleteError instanceof Error ? r2DeleteError.message : String(r2DeleteError);
            // Continue - database deletion succeeded, R2 deletion is optional
          }
        }

        return jsonResponse({
          data: null,
          status: 'success',
          message: 'Preset deleted successfully',
          code: 200
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: null,
          status: 'error',
          message: '',
          code: 500,
          ...(debugEnabled ? { debug: {
            presetId: path.replace('/presets/', ''),
            error: errorMessage,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
            path,
            ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {})
          } } : {})
        }, 500, request, env);
      }
    }

    // Handle selfies listing
    if (path === '/selfies' && request.method === 'GET') {
      const url = new URL(request.url);
      try {
        // Check for required profile_id query parameter
        const profileId = url.searchParams.get('profile_id');
        if (!profileId) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        // Validate that profile exists
        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(profileId).first();
        if (!profileCheck) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId, path } : undefined, request, env);
        }

        // Get optional action filter parameter
        const actionFilter = url.searchParams.get('action');
        
        // Check if new schema (ext column exists) or old schema (selfie_url exists)
        const schemaCheck = await DB.prepare('PRAGMA table_info(selfies)').all();
        const hasExt = schemaCheck.results?.some((col: any) => col.name === 'ext');
        const hasUrl = schemaCheck.results?.some((col: any) => col.name === 'selfie_url');
        
        let query: string;
        const queryParams: any[] = [profileId];
        
        const limitParam = url.searchParams.get('limit');
        let limit = 50;
        if (limitParam) {
          const parsedLimit = parseInt(limitParam, 10);
          if (!isNaN(parsedLimit) && parsedLimit > 0 && parsedLimit <= 50) {
            limit = parsedLimit;
          }
        }
        
        // Build WHERE clause with optional action filter
        let whereClause = 'WHERE profile_id = ?';
        if (actionFilter && actionFilter.trim()) {
          const normalizedAction = actionFilter.trim().toLowerCase();
          // Support both '4k' and '4K' for backward compatibility
          if (normalizedAction === '4k') {
            whereClause += ' AND (action = ? OR action = ?)';
            queryParams.push('4k', '4K');
          } else {
            whereClause += ' AND action = ?';
            queryParams.push(normalizedAction);
          }
        }
        
        if (hasExt) {
          query = `SELECT id, ext, profile_id, action, created_at FROM selfies ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`;
        } else if (hasUrl) {
          query = `SELECT id, selfie_url, profile_id, action, created_at FROM selfies ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`;
        } else {
          const debugEnabled = isDebugEnabled(env);
          return jsonResponse({
            data: { selfies: [] },
            status: 'success',
            message: 'Selfies retrieved successfully',
            code: 200,
            ...(debugEnabled ? { debug: { count: 0, reason: 'schema_mismatch' } } : {})
          }, 200, request, env);
        }

        const result = await DB.prepare(query).bind(...queryParams).all();

        if (!result || !result.results) {
          const debugEnabled = isDebugEnabled(env);
          return jsonResponse({
            data: { selfies: [] },
            status: 'success',
            message: 'Selfies retrieved successfully',
            code: 200,
            ...(debugEnabled ? { debug: { count: 0 } } : {})
          }, 200, request, env);
        }

        const selfies = result.results.map((row: any) => {
          let fullUrl: string;
          if (hasExt && row.ext) {
            const storedKey = reconstructR2Key(row.id, row.ext, 'selfie');
            fullUrl = getR2PublicUrl(env, storedKey, requestUrl.origin);
          } else if (hasUrl && row.selfie_url) {
            const storedKey = row.selfie_url || '';
            if (storedKey && !storedKey.startsWith('http://') && !storedKey.startsWith('https://')) {
              fullUrl = getR2PublicUrl(env, storedKey, requestUrl.origin);
            } else {
              fullUrl = convertLegacyUrl(storedKey, env);
            }
          } else {
            fullUrl = '';
          }
          return {
            id: row.id || '',
            selfie_url: fullUrl,
            action: row.action || null,
            created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
          };
        });

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { selfies },
          status: 'success',
          message: 'Selfies retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { count: selfies.length, profileId } } : {})
        }, 200, request, env);
      } catch (error) {
        logCriticalError('/selfies (GET)', error, request, env, {
          profileId: url.searchParams.get('profile_id'),
          action: url.searchParams.get('action'),
          limit: url.searchParams.get('limit')
        });
        // Return empty array instead of error to prevent UI breaking
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { selfies: [] },
          status: 'success',
          message: 'Selfies retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { error: error instanceof Error ? error.message : String(error), count: 0 } } : {})
        }, 200, request, env);
      }
    }

    // Handle selfie deletion
    if (path.startsWith('/selfies/') && request.method === 'DELETE') {
      try {
        const selfieId = extractPathId(path, '/selfies/');
        if (!selfieId) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        // First, check if selfie exists
        const checkResult = await DB.prepare(
          'SELECT id, ext FROM selfies WHERE id = ?'
        ).bind(selfieId).first();

        if (!checkResult) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Selfie not found', 404, debugEnabled ? { selfieId, path } : undefined, request, env);
        }

        const r2Key = reconstructR2Key((checkResult as any).id, (checkResult as any).ext, 'selfie');

        // Delete selfie from database
        // NOTE: Results are NOT deleted when selfie is deleted - they belong to profiles and should be preserved
        const deleteResult = await DB.prepare(
          'DELETE FROM selfies WHERE id = ?'
        ).bind(selfieId).run();

        if (!deleteResult.success || deleteResult.meta?.changes === 0) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Selfie not found or already deleted', 404, debugEnabled ? { selfieId, path } : undefined, request, env);
        }

        // Try to delete from R2 (non-fatal if it fails)
        let r2Deleted = false;
        let r2Error = null;
        if (r2Key) {
          try {
            await R2_BUCKET.delete(r2Key);
            r2Deleted = true;
          } catch (r2DeleteError) {
            r2Error = r2DeleteError instanceof Error ? r2DeleteError.message : String(r2DeleteError);
            // Continue - database deletion succeeded, R2 deletion is optional
          }
        }

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: null,
          status: 'success',
          message: 'Selfie deleted successfully',
          code: 200,
          ...(debugEnabled ? { debug: { selfieId, r2Deleted, r2Error } } : {})
        }, 200, request, env);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: null,
          status: 'error',
          message: '',
          code: 500,
          ...(debugEnabled ? { debug: {
            selfieId: path.replace('/selfies/', ''),
            error: errorMessage,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
            path,
            ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {})
          } } : {})
        }, 500, request, env);
      }
    }


    // Handle results listing
    // Get preset_id from thumbnail_id (for mobile app) - thumbnail is in same row as preset
    if (path.startsWith('/thumbnails/') && path.endsWith('/preset') && request.method === 'GET') {
      try {
        const pathWithoutSuffix = path.replace('/preset', '');
        const thumbnailId = extractPathId(pathWithoutSuffix, '/thumbnails/');
        if (!thumbnailId) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const DB = getD1Database(env);
        // Thumbnail is stored in same row as preset, so the ID is the preset ID
        const preset = await DB.prepare(
          'SELECT id FROM presets WHERE id = ? AND thumbnail_r2 IS NOT NULL'
        ).bind(thumbnailId).first();

        if (!preset) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Thumbnail not found', 404, debugEnabled ? { thumbnailId, path } : undefined, request, env);
        }

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { preset_id: (preset as any).id },
          status: 'success',
          message: 'Preset ID retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { thumbnailId, presetId: (preset as any).id } } : {})
        }, 200, request, env);
      } catch (error) {
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Get thumbnails - query presets table where any thumbnail column IS NOT NULL
    if (path === '/thumbnails' && request.method === 'GET') {
      const debugEnabled = isDebugEnabled(env);
      try {
        const DB = getD1Database(env);
        
        let query = `SELECT
          id,
          thumbnail_r2,
          created_at
        FROM presets
        WHERE thumbnail_r2 IS NOT NULL`;
        const bindings: any[] = [];

        query += ' ORDER BY created_at DESC';

        const stmt = DB.prepare(query);
        const result = bindings.length > 0
          ? await stmt.bind(...bindings).all()
          : await stmt.all();

        // Map results to include all thumbnail resolutions from JSON
        const thumbnails = (result.results || []).map((row: any) => {
          let thumbnailData: Record<string, string> = {};
          try {
            thumbnailData = row.thumbnail_r2 ? JSON.parse(row.thumbnail_r2) : {};
          } catch (e) {
            thumbnailData = {};
          }

          // Build full URLs from R2 keys
          const buildThumbnailUrl = (key: string | null | undefined): string | null => {
            if (!key) return null;
            return getR2PublicUrl(env, key, requestUrl.origin);
          };

          // Build response object with only 4x thumbnails
          const response: any = {
            preset_id: row.id, // Include preset_id for frontend selection
          };

          // Primary thumbnail_url_4x: prefer webp, then lottie, then lottie_avif
          const primary4x = thumbnailData['webp_4x'] || thumbnailData['lottie_4x'] || thumbnailData['lottie_avif_4x'];
          response.thumbnail_url_4x = buildThumbnailUrl(primary4x);

          // Add lottie_4x if exists (can coexist with webp_4x)
          if (thumbnailData['lottie_4x']) {
            response.thumbnail_url_4x_lottie = buildThumbnailUrl(thumbnailData['lottie_4x']);
          }

          // Add lottie_avif_4x if exists (can coexist with lottie_4x and webp_4x)
          if (thumbnailData['lottie_avif_4x']) {
            response.thumbnail_url_4x_lottie_avif = buildThumbnailUrl(thumbnailData['lottie_avif_4x']);
          }

          return response;
        });
          
        return jsonResponse({
          data: { thumbnails },
          status: 'success',
          message: 'Thumbnails retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { count: thumbnails.length } } : {})
        }, 200, request, env);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    if (path === '/results' && request.method === 'GET') {
      const url = new URL(request.url);
      try {
        const profileId = url.searchParams.get('profile_id');


        let query = 'SELECT id, ext, profile_id, created_at FROM results';
        const params: any[] = [];
        
        const limitParam = url.searchParams.get('limit');
        let limit = 50;
        if (limitParam) {
          const parsedLimit = parseInt(limitParam, 10);
          if (!isNaN(parsedLimit) && parsedLimit > 0 && parsedLimit <= 50) {
            limit = parsedLimit;
          }
        }

        if (profileId) {
        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(profileId).first();
        if (!profileCheck) {
          return errorResponse('Profile not found', 404, undefined, request, env);
        }
          query += ' WHERE profile_id = ?';
          params.push(profileId);
        }

        query += ` ORDER BY created_at DESC LIMIT ${limit}`;

        const result = await DB.prepare(query).bind(...params).all();

        if (!result || !result.results) {
          const debugEnabled = isDebugEnabled(env);
          return jsonResponse({
            data: { results: [] },
            status: 'success',
            message: 'Results retrieved successfully',
            code: 200,
            ...(debugEnabled ? { debug: { count: 0, profileId: profileId || null } } : {})
          }, 200, request, env);
        }

        const results = result.results.map((row: any) => {
          const storedKey = reconstructR2Key(row.id, row.ext, 'results');
          const fullUrl = getR2PublicUrl(env, storedKey, requestUrl.origin);
          return {
            id: String(row.id || ''),
            result_url: fullUrl,
            image_url: fullUrl,
            profile_id: row.profile_id || '',
            created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
          };
        });

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { results },
          status: 'success',
          message: 'Results retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { count: results.length, profileId: profileId || null } } : {})
        }, 200, request, env);
      } catch (error) {
        logCriticalError('/results (GET)', error, request, env, {
          profileId: url.searchParams.get('profile_id'),
          limit: url.searchParams.get('limit')
        });
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { results: [] },
          status: 'success',
          message: 'Results retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { error: error instanceof Error ? error.message : String(error), count: 0 } } : {})
        }, 200, request, env);
      }
    }

    // Handle results deletion (reuse same pattern as presets/selfies)
    if (path.startsWith('/results/') && request.method === 'DELETE') {
      try {
        const resultId = extractPathId(path, '/results/');
        if (!resultId) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        // First, check if result exists and get the R2 key
        const checkResult = await DB.prepare(
          'SELECT id, ext FROM results WHERE id = ?'
        ).bind(resultId).first();

        if (!checkResult) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Result not found', 404, debugEnabled ? { resultId, path } : undefined, request, env);
        }

        const r2Key = reconstructR2Key((checkResult as any).id, (checkResult as any).ext, 'results');

        // Delete from database
        const deleteResult = await DB.prepare(
          'DELETE FROM results WHERE id = ?'
        ).bind(resultId).run();

        if (!deleteResult.success || deleteResult.meta?.changes === 0) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Result not found or already deleted', 404, debugEnabled ? { resultId, path } : undefined, request, env);
        }

        // Try to delete from R2 (non-fatal if it fails)
        let r2Deleted = false;
        let r2Error = null;
        if (r2Key) {
          try {
            await R2_BUCKET.delete(r2Key);
            r2Deleted = true;
          } catch (r2DeleteError) {
            r2Error = r2DeleteError instanceof Error ? r2DeleteError.message : String(r2DeleteError);
          }
        }

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: null,
          status: 'success',
          message: 'Result deleted successfully',
          code: 200,
          ...(debugEnabled ? { debug: {
            resultId,
            databaseDeleted: deleteResult.meta?.changes || 0,
            r2Deleted,
            r2Key,
            r2Error: r2Error || null
          } } : {})
        }, 200, request, env);
      } catch (error) {
        logCriticalError('/results/{id} (DELETE)', error, request, env, {
          resultId: extractPathId(path, '/results/')
        });
        const errorMessage = error instanceof Error ? error.message : String(error);
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: null,
          status: 'error',
          message: '',
          code: 500,
          ...(debugEnabled ? { debug: {
            resultId: extractPathId(path, '/results/'),
            error: errorMessage,
            path,
            ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {})
          } } : {})
        }, 500, request, env);
      }
    }




    // Handle face swap endpoint
    if (path === '/faceswap' && request.method === 'POST') {
      const debugEnabled = isDebugEnabled(env);
      const requestCache = new Map<string, Promise<any>>();
      const getCachedAsync = async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
        if (!requestCache.has(key)) {
          requestCache.set(key, compute());
        }
        return requestCache.get(key) as Promise<T>;
      };

      let body: FaceSwapRequest | undefined;
      try {
        try {
          const rawBody = await request.text();
          console.log('[Faceswap] Raw request body:', rawBody.substring(0, 500));
          body = JSON.parse(rawBody);
          console.log('[Faceswap] Parsed body:', JSON.stringify({ 
            preset_image_id: body?.preset_image_id, 
            profile_id: body?.profile_id, 
            selfie_ids: body?.selfie_ids,
            has_preset_id: !!body?.preset_image_id,
            has_profile_id: !!body?.profile_id,
            has_selfie_ids: Array.isArray(body?.selfie_ids)
          }));
        } catch (jsonError) {
          const errorMsg = jsonError instanceof Error ? jsonError.message : String(jsonError);
          console.error('[Faceswap] JSON parse error:', errorMsg);
          return errorResponse('', 400, { error: `Invalid JSON in request body: ${errorMsg}`, path }, request, env);
        }

        if (!body) {
          return errorResponse('', 400, { error: 'Request body is required', path }, request, env);
        }

        // Normalize preset_image_id to remove file extensions (mobile apps may send IDs with extensions)
        if (body.preset_image_id) {
          const normalized = normalizePresetId(body.preset_image_id);
          if (normalized) {
            body.preset_image_id = normalized;
          }
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          console.error('[Faceswap] Env validation error:', envError);
          return errorResponse('', 500, { error: envError, path }, request, env);
        }

        const requestError = validateRequest(body);
        if (requestError) {
          console.error('[Faceswap] Request validation error:', requestError, { 
            preset_image_id: body?.preset_image_id, 
            preset_image_id_type: typeof body?.preset_image_id,
            profile_id: body?.profile_id,
            profile_id_type: typeof body?.profile_id,
            selfie_ids: body?.selfie_ids,
            selfie_ids_type: Array.isArray(body?.selfie_ids) ? 'array' : typeof body?.selfie_ids,
            body_keys: body ? Object.keys(body) : 'null',
            body_stringified: JSON.stringify(body).substring(0, 500)
          });
          return errorResponse('', 400, { error: requestError, path, body: { preset_image_id: body?.preset_image_id, profile_id: body?.profile_id, selfie_ids: body?.selfie_ids } }, request, env);
        }

        // Extract validated values (validateRequest already confirmed they exist and are correct types)
        const hasSelfieIds = Array.isArray(body.selfie_ids) && body.selfie_ids.length > 0;
        const hasSelfieUrls = Array.isArray(body.selfie_image_urls) && body.selfie_image_urls.length > 0;
        const hasPresetId = body.preset_image_id && typeof body.preset_image_id === 'string' && body.preset_image_id.trim() !== '';
        const hasPresetUrl = body.preset_image_url && typeof body.preset_image_url === 'string' && body.preset_image_url.trim() !== '';
        
        console.log('[Faceswap] All validations passed, proceeding to database queries', { hasPresetId, hasPresetUrl, hasSelfieIds, hasSelfieUrls });
        
        if (hasSelfieUrls && body.selfie_image_urls) {
          for (const url of body.selfie_image_urls) {
            if (!validateImageUrl(url, env)) {
              return errorResponse('', 400, { error: `Invalid selfie image URL: ${url}`, path, url }, request, env);
            }
          }
        }
        
        if (hasPresetUrl && body.preset_image_url) {
          if (!validateImageUrl(body.preset_image_url, env)) {
            return errorResponse('', 400, { error: `Invalid preset image URL: ${body.preset_image_url}`, path, url: body.preset_image_url }, request, env);
          }
        }

        // Optimize database queries with JOINs to validate ownership in single queries
        const queries: Promise<any>[] = [];

        // Profile validation (needed for all cases)
        queries.push(
          DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first()
        );

        if (hasPresetId) {
          queries.push(
            DB.prepare('SELECT id, ext FROM presets WHERE id = ?').bind(body.preset_image_id).first()
          );
        }

        if (hasSelfieIds && body.selfie_ids) {
          // Use JOIN to validate selfies belong to profile and include action for validation
          for (const selfieId of body.selfie_ids) {
            queries.push(
              DB.prepare(`
                SELECT s.id, s.ext, s.action, p.id as profile_exists
                FROM selfies s
                INNER JOIN profiles p ON s.profile_id = p.id
                WHERE s.id = ? AND p.id = ?
              `).bind(selfieId, body.profile_id).first()
            );
          }
        }

        // Execute all queries in parallel
        let results: any[];
        try {
          results = await Promise.all(queries);
        } catch (dbError) {
          // Database errors could be client errors (invalid ID format) or server errors
          const errorMsg = dbError instanceof Error ? dbError.message : String(dbError);
          const errorLower = errorMsg.toLowerCase();
          
          // Check if it's a client error (invalid input format, type mismatch, etc.)
          const isClientError = errorLower.includes('datatype mismatch') ||
                               errorLower.includes('sqlite_mismatch') ||
                               errorLower.includes('invalid') ||
                               errorLower.includes('syntax error') ||
                               errorLower.includes('no such column');
          
          logCriticalError('/faceswap', dbError, request, env, {
            body: {
              preset_image_id: body?.preset_image_id,
              profile_id: body?.profile_id,
              selfie_ids: body?.selfie_ids
            },
            dbErrorType: isClientError ? 'client_error' : 'server_error',
            errorMessage: errorMsg
          });
          
          const status = isClientError ? 400 : 500;
          return errorResponse('', status, { 
            error: `Database query failed: ${errorMsg}`, 
            path,
            dbErrorType: isClientError ? 'client_error' : 'server_error',
            stack: dbError instanceof Error ? dbError.stack?.substring(0, 1000) : undefined
          }, request, env);
        }

        const profileCheck = results[0];
        if (!profileCheck) {
          return errorResponse('Profile not found', 404, undefined, request, env);
        }

        let targetUrl: string = '';
        let presetName: string = '';
        let presetImageId: string | null = null;
        let presetResult: any = null;

        if (hasPresetId) {
          presetResult = results[1];
          if (!presetResult) {
            return errorResponse('Preset image not found', 404, undefined, request, env);
          }

          // Check if a specific format is requested for thumbnails
          const requestedFormat = body.format ? body.format.trim().toLowerCase() : null;
          let useThumbnailUrl = false;

          if (requestedFormat && (requestedFormat === 'lottie' || requestedFormat === 'avif')) {
            // For Lottie or AVIF formats, try to use the 4x thumbnail if available
            const thumbnailKey = requestedFormat === 'lottie' ? 'thumbnail_url_4x_lottie' : 'thumbnail_url_4x_lottie_avif';

            // Query for thumbnail data
            const thumbnailQuery = await DB.prepare(`
              SELECT thumbnail_data FROM presets WHERE id = ?
            `).bind(body.preset_image_id).first();

            if (thumbnailQuery && thumbnailQuery.thumbnail_data && typeof thumbnailQuery.thumbnail_data === 'string') {
              try {
                const thumbnailData = JSON.parse(thumbnailQuery.thumbnail_data);
                const thumbnailR2Key = thumbnailData[thumbnailKey];
                if (thumbnailR2Key && typeof thumbnailR2Key === 'string') {
                  targetUrl = getR2PublicUrl(env, thumbnailR2Key, requestUrl.origin);
                  useThumbnailUrl = true;
                }
              } catch (parseError) {
                console.warn('[Faceswap] Failed to parse thumbnail data for format selection:', parseError);
              }
            }
          }

          // Fallback to original preset image if thumbnail not found or no format specified
          if (!useThumbnailUrl) {
            const storedKey = reconstructR2Key((presetResult as any).id, (presetResult as any).ext, 'preset');
            targetUrl = getR2PublicUrl(env, storedKey, requestUrl.origin);
          }

          presetName = 'Unnamed Preset';
          presetImageId = body.preset_image_id || null;
        } else if (hasPresetUrl) {
          targetUrl = body.preset_image_url!;
          presetName = 'Result Preset';
          presetImageId = null;
        } else {
          // This should never happen due to earlier validation, but TypeScript needs this
          const errorMsg = 'Invalid request: missing both preset_image_id and preset_image_url';
          return errorResponse('', 400, debugEnabled ? { error: errorMsg, path, hasPresetId, hasPresetUrl } : { error: errorMsg }, request, env);
        }

        // Extract selfie results and validate action match if specified
        const selfieUrls: string[] = [];
        const selfieIds: string[] = [];
        const selfieActions: string[] = [];
        const selfieStartIndex = hasPresetId ? 2 : 1;
        
        // Get requested action for validation (if provided)
        const requestedAction = body.action ? body.action.trim().toLowerCase() : null;

        if (hasSelfieIds && body.selfie_ids) {
          for (let i = 0; i < body.selfie_ids.length; i++) {
            const selfieResult = results[selfieStartIndex + i];
            if (!selfieResult) {
              return errorResponse(`Selfie with ID ${body.selfie_ids[i]} not found or does not belong to profile`, 404, debugEnabled ? { selfieId: body.selfie_ids[i], profileId: body.profile_id, path } : undefined, request, env);
            }
            
            // Validate action match if action is specified in request
            const selfieActionRaw = (selfieResult as any).action ? String((selfieResult as any).action) : null;
            const selfieAction = selfieActionRaw ? selfieActionRaw.toLowerCase() : null;
            if (requestedAction) {
              // Support both '4k' and '4K' for backward compatibility
              if (requestedAction === '4k') {
                if (selfieAction !== '4k') {
                  const errorMsg = `Selfie with ID ${body.selfie_ids[i]} has action "${selfieActionRaw || 'null'}" but request requires action "4k"`;
                  return errorResponse(
                    errorMsg,
                    400,
                    { error: errorMsg, selfieId: body.selfie_ids[i], selfieAction: selfieActionRaw, requestedAction, path },
                    request,
                    env
                  );
                }
              } else if (selfieAction !== requestedAction) {
                const errorMsg = `Selfie with ID ${body.selfie_ids[i]} has action "${selfieActionRaw || 'null'}" but request requires action "${requestedAction}"`;
                return errorResponse(
                  errorMsg,
                  400,
                  { error: errorMsg, selfieId: body.selfie_ids[i], selfieAction: selfieActionRaw, requestedAction, path },
                  request,
                  env
                );
              }
            }
            
            const storedKey = reconstructR2Key((selfieResult as any).id, (selfieResult as any).ext, 'selfie');
            const fullUrl = getR2PublicUrl(env, storedKey, requestUrl.origin);
            selfieUrls.push(fullUrl);
            selfieIds.push(body.selfie_ids[i]);
            selfieActions.push(selfieActionRaw || 'faceswap'); // Use raw value from DB, default to faceswap if null
          }
        } else if (hasSelfieUrls) {
          selfieUrls.push(...body.selfie_image_urls!);
          // For URL-based selfies, action is unknown, use requested action or default
          for (let i = 0; i < body.selfie_image_urls!.length; i++) {
            selfieActions.push(requestedAction || 'faceswap');
          }
        }

        // Support multiple selfies for wedding faceswap (e.g., bride and groom)
        if (selfieUrls.length === 0) {
          const errorMsg = 'No valid selfie images found. Both selfie_ids and selfie_image_urls are empty or invalid.';
          return errorResponse('', 400, debugEnabled ? { error: errorMsg, hasSelfieIds, hasSelfieUrls, selfieIdsCount: body.selfie_ids?.length || 0, selfieUrlsCount: body.selfie_image_urls?.length || 0, path } : { error: errorMsg }, request, env);
        }
        const sourceUrl = selfieUrls.length === 1 ? selfieUrls[0] : selfieUrls;

        const requestDebug = compact({
          targetUrl: targetUrl,
          sourceUrls: selfieUrls,
          presetImageId: presetImageId,
          presetImageUrl: hasPresetUrl ? body.preset_image_url : undefined,
          presetName: presetName,
          selfieIds: selfieIds,
          additionalPrompt: body.additional_prompt,
        });


        let promptResult: any = null;
        let storedPromptPayload: any = null;
        const promptCacheKV = getPromptCacheKV(env);
        
        if (presetImageId) {
          promptResult = presetResult;
          
          if (promptResult && !storedPromptPayload) {
            const cacheKey = `prompt:${presetImageId}`;
            
            if (promptCacheKV) {
              try {
                const cached = await promptCacheKV.get(cacheKey, 'json');
                if (cached) storedPromptPayload = cached;
              } catch (error) {
                // KV cache read failed, fallback to R2
              }
            }
            
            if (!storedPromptPayload) {
              const r2Key = reconstructR2Key((promptResult as any).id, (promptResult as any).ext, 'preset');
              try {
                const r2Object = await getCachedAsync(`r2head:${r2Key}`, async () =>
                  await R2_BUCKET.head(r2Key)
                );
                const promptJson = r2Object?.customMetadata?.prompt_json;
                if (promptJson?.trim()) {
                  storedPromptPayload = JSON.parse(promptJson);
                  if (promptCacheKV) {
                    promptCacheKV.put(cacheKey, promptJson, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {});
                  }
                }
              } catch (error) {
                // R2 metadata read failed, continue without cache
              }
            }
          }
        }

        if (!storedPromptPayload) {
          const presetImageUrl = promptResult ? getR2PublicUrl(env, reconstructR2Key((promptResult as any).id, (promptResult as any).ext, 'preset'), requestUrl.origin) : targetUrl;
          
          const generateResult = await generateVertexPrompt(presetImageUrl, env);
          if (generateResult.success && generateResult.prompt) {
            storedPromptPayload = generateResult.prompt;
            if (presetImageId && promptResult) {
              const promptJsonString = JSON.stringify(storedPromptPayload);
              const cacheKey = `prompt:${presetImageId}`;
              
              if (promptCacheKV) {
                promptCacheKV.put(cacheKey, promptJsonString, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {});
              }
              
              const r2Key = reconstructR2Key((promptResult as any).id, (promptResult as any).ext, 'preset');
              try {
                const existingObject = await getCachedAsync(`r2head:${r2Key}`, async () =>
                  await R2_BUCKET.head(r2Key)
                );
                if (existingObject) {
                  const objectBody = await R2_BUCKET.get(r2Key);
                  if (objectBody) {
                    await R2_BUCKET.put(r2Key, objectBody.body, {
                      httpMetadata: existingObject.httpMetadata,
                      customMetadata: { ...existingObject.customMetadata, prompt_json: promptJsonString }
                    });
                  }
                }
              } catch (error) {
                console.error(`[R2 Metadata] Write failed for preset ${presetImageId}:`, error);
              }
            }
          } else {
            const errorMsg = generateResult.error || 'Failed to generate Vertex AI prompt from preset image';
            return errorResponse('', 400, { 
              error: errorMsg, 
              path,
              presetImageId: presetImageId || null,
              presetImageUrl: presetImageUrl || null
            }, request, env);
          }
        }
        const augmentedPromptPayload = augmentVertexPrompt(
          storedPromptPayload,
          body.additional_prompt
        );
        const vertexPromptPayload = augmentedPromptPayload;

        // Resolve aspect ratio (faceswap doesn't support "original")
        const validAspectRatio = await resolveAspectRatio(body.aspect_ratio, null, env, { allowOriginal: false });
        // NOTE: There is a known issue with Gemini 2.5 Flash Image where aspectRatio parameter
        // may not work correctly and may always return 1:1 images regardless of the specified ratio.
        // This is a limitation of the current API version.
        // For now, use the first selfie. In a full implementation, you might want to combine multiple selfies
        const modelParam = body.model;
        const faceSwapResult = await callNanoBanana(augmentedPromptPayload, targetUrl, sourceUrl, env, validAspectRatio, modelParam);

          if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
            console.error('[Vertex] Nano Banana provider failed:', faceSwapResult.Message || 'Unknown error');

            let sanitizedVertexFailure: any = null;
            const fullResponse = (faceSwapResult as any).FullResponse;
            if (fullResponse) {
              try {
                const parsedResponse = typeof fullResponse === 'string' ? JSON.parse(fullResponse) : fullResponse;
                // Efficient sanitization - only sanitize 'data' field if it's a long string
                if (typeof parsedResponse === 'object' && parsedResponse !== null) {
                  sanitizedVertexFailure = { ...parsedResponse };
                  if (sanitizedVertexFailure.data && typeof sanitizedVertexFailure.data === 'string' && sanitizedVertexFailure.data.length > 100) {
                    sanitizedVertexFailure.data = '...';
                  }
                } else {
                  sanitizedVertexFailure = parsedResponse;
                }
              } catch (parseErr) {
                if (typeof fullResponse === 'string') {
                  sanitizedVertexFailure = fullResponse.substring(0, 500) + (fullResponse.length > 500 ? '...' : '');
                } else {
                  sanitizedVertexFailure = fullResponse;
                }
              }
            }

            // Extract detailed error information from Vertex AI response
            let errorDetails: any = null;
            const fullResponse2 = (faceSwapResult as any).FullResponse || (faceSwapResult as any).Error;
            if (fullResponse2) {
              try {
                const parsedError = typeof fullResponse2 === 'string' ? JSON.parse(fullResponse2) : fullResponse2;
                errorDetails = parsedError;
              } catch {
                errorDetails = typeof fullResponse2 === 'string' ? fullResponse2 : JSON.stringify(fullResponse2);
              }
            }

            // Keep message simple - detailed error is in debug section
            const enhancedMessage = faceSwapResult.Message || 'Nano Banana provider failed to generate image';

            const flatDebug = buildFlatDebug(faceSwapResult, vertexPromptPayload);
            const debugPayload = debugEnabled ? compact({
              request: requestDebug,
              ...flatDebug,
              fullError: errorDetails,
              parsedError: (faceSwapResult as any).ParsedError,
              fullResponse: (faceSwapResult as any).FullResponse,
            }) : undefined;

            const failureCode = faceSwapResult.StatusCode || 500;
            // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
            const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);

            return jsonResponse({
              data: null,
              status: 'error',
              message: '',
              code: failureCode,
              ...(debugPayload ? { debug: debugPayload } : {}),
            }, httpStatus);
          }

          if (faceSwapResult.ResultImageUrl?.startsWith('r2://')) {
            const r2Key = faceSwapResult.ResultImageUrl.replace('r2://', '');
            faceSwapResult.ResultImageUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
          }

        if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
          const failureCode = faceSwapResult.StatusCode || 500;
          // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const flatDebug = debugEnabled ? buildFlatDebug(faceSwapResult, vertexPromptPayload) : undefined;
          const debugPayload = debugEnabled ? compact({
            request: requestDebug,
            ...flatDebug,
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: '',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, httpStatus);
        }

        // Vision API scanning on result images is disabled - only used for 4k action on selfie uploads
        const safetyDebug: SafetyCheckDebug = {
          checked: false,
          isSafe: true,
          error: 'Safety check skipped for Vertex AI mode',
        };

        const storageDebug: {
          attemptedDownload: boolean;
          downloadStatus: number | null;
          savedToR2: boolean;
          r2Key: string | null;
          publicUrl: string | null;
          error: string | null;
        } = {
          attemptedDownload: false,
          downloadStatus: null,
          savedToR2: false,
          r2Key: null,
          publicUrl: null,
          error: null,
        };

        let resultUrl = faceSwapResult.ResultImageUrl;

        if (resultUrl?.startsWith('r2://')) {
          const r2Key = resultUrl.replace('r2://', '');
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
          storageDebug.attemptedDownload = false;
          storageDebug.savedToR2 = true;
          storageDebug.r2Key = r2Key;
          storageDebug.publicUrl = resultUrl;
        } else {
          try {
            storageDebug.attemptedDownload = true;
            const resultImageResponse = await fetchWithTimeout(resultUrl, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
            storageDebug.downloadStatus = resultImageResponse.status;
            if (resultImageResponse.ok && resultImageResponse.body) {
              const id = nanoid(16);
              const resultKey = `results/${id}.jpg`;
              await R2_BUCKET.put(resultKey, resultImageResponse.body, {
                httpMetadata: {
                  contentType: resultImageResponse.headers.get('content-type') || 'image/jpeg',
                  cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                },
              });
              storageDebug.savedToR2 = true;
              storageDebug.r2Key = resultKey;
              resultUrl = getR2PublicUrl(env, resultKey, requestUrl.origin);
              storageDebug.publicUrl = resultUrl;
            } else {
              storageDebug.error = `Download failed with status ${resultImageResponse.status}`;
            }
          } catch (r2Error) {
            storageDebug.error = r2Error instanceof Error ? r2Error.message : String(r2Error);
          }
        }

        const databaseDebug: {
          attempted: boolean;
          success: boolean;
          resultId: string | null;
          error: string | null;
          lookupError: string | null;
        } = {
          attempted: false,
          success: false,
          resultId: null,
          error: null,
          lookupError: null,
        };

        let savedResultId: string | null = null;
        if (body.profile_id) {
          databaseDebug.attempted = true;
          try {
            savedResultId = await saveResultToDatabase(DB, resultUrl, body.profile_id, env, R2_BUCKET);
            
            if (savedResultId !== null) {
              databaseDebug.success = true;
              databaseDebug.resultId = String(savedResultId);
              databaseDebug.error = null;
            } else {
              databaseDebug.error = 'Database insert failed';
            }
          } catch (dbError) {
            databaseDebug.error = dbError instanceof Error ? dbError.message : String(dbError);
          }
        }

        const flatDebug = debugEnabled ? buildFlatDebug(faceSwapResult, vertexPromptPayload) : undefined;
        const visionDebug = debugEnabled ? buildVisionDebug(safetyDebug) : undefined;
        const storageDebugPayload = debugEnabled ? compact(storageDebug as unknown as Record<string, any>) : undefined;
        const databaseDebugPayload = debugEnabled ? compact(databaseDebug as unknown as Record<string, any>) : undefined;
        const debugPayload = debugEnabled ? compact({
          ...flatDebug,
          vision: visionDebug,
          storage: Object.keys(storageDebugPayload || {}).length ? storageDebugPayload : undefined,
          database: Object.keys(databaseDebugPayload || {}).length ? databaseDebugPayload : undefined,
        }) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
            selfies: hasSelfieIds && selfieIds.length > 0 ? selfieIds.map((id, idx) => ({
              id,
              action: selfieActions[idx] || null,
              url: selfieUrls[idx] || null,
            })) : undefined,
          },
          status: 'success',
          message: faceSwapResult.Message || 'Processing successful',
          code: 200,
          ...(debugPayload ? { debug: debugPayload } : {}),
        });
      } catch (error) {
        logCriticalError('/faceswap', error, request, env, {
          body: {
            preset_image_id: body?.preset_image_id,
            profile_id: body?.profile_id,
            selfie_ids: body?.selfie_ids,
            has_preset_id: !!body?.preset_image_id,
            has_selfie_ids: Array.isArray(body?.selfie_ids)
          }
        });
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('', 500, { 
          error: errorMsg, 
          path, 
          ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {})
        }, request, env);
      }
    }

    // Handle background endpoint
    if (path === '/background' && request.method === 'POST') {
      let body: BackgroundRequest | undefined;
      try {
        body = await request.json() as BackgroundRequest;

        // Normalize preset_image_id to remove file extensions (mobile apps may send IDs with extensions)
        if (body.preset_image_id) {
          const normalized = normalizePresetId(body.preset_image_id);
          if (normalized) {
            body.preset_image_id = normalized;
          }
        }

        const hasPresetId = body.preset_image_id && body.preset_image_id.trim() !== '';
        const hasPresetUrl = body.preset_image_url && body.preset_image_url.trim() !== '';
        const hasCustomPrompt = body.custom_prompt && body.custom_prompt.trim() !== '';

        if (!hasPresetId && !hasPresetUrl && !hasCustomPrompt) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if ((hasPresetId && hasPresetUrl) || (hasPresetId && hasCustomPrompt) || (hasPresetUrl && hasCustomPrompt)) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (!body.profile_id) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const hasSelfieId = body.selfie_id && body.selfie_id.trim() !== '';
        const hasSelfieUrl = body.selfie_image_url && body.selfie_image_url.trim() !== '';

        if (!hasSelfieId && !hasSelfieUrl) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (hasSelfieId && hasSelfieUrl) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const DB = getD1Database(env);
        const R2_BUCKET = getR2Bucket(env);
        const requestUrl = new URL(request.url);

        // Optimize database queries: validate profile, preset, and selfie in parallel with JOINs where applicable
        const queries: Promise<any>[] = [
          DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first()
        ];

        if (hasPresetId) {
          queries.push(
            DB.prepare('SELECT id, ext FROM presets WHERE id = ?').bind(body.preset_image_id).first()
          );
        }

        if (hasSelfieId) {
          // Use JOIN to validate selfie belongs to profile
          queries.push(
            DB.prepare(`
              SELECT s.id, s.ext, p.id as profile_exists
              FROM selfies s
              INNER JOIN profiles p ON s.profile_id = p.id
              WHERE s.id = ? AND p.id = ?
            `).bind(body.selfie_id, body.profile_id).first()
          );
        }

        // Execute all queries in parallel
        const results = await Promise.all(queries);

        const profileCheck = results[0];
        if (!profileCheck) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
        }

        let targetUrl: string;
        let presetName: string;
        let presetImageId: string | null = null;

        if (hasCustomPrompt) {
          const envError = validateEnv(env, 'vertex');
          if (envError) {
            const debugEnabled = isDebugEnabled(env);
            return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
          }

          // Get selfie URL for aspect ratio calculation
          let selfieUrlForRatio = '';
          if (hasSelfieId) {
            const selfieResult = results[hasPresetId ? 2 : 1];
            if (selfieResult) {
              const storedKey = reconstructR2Key((selfieResult as any).id, (selfieResult as any).ext, 'selfie');
              selfieUrlForRatio = getR2PublicUrl(env, storedKey, requestUrl.origin);
            }
          } else if (hasSelfieUrl) {
            selfieUrlForRatio = body.selfie_image_url!;
          }
          
          // Resolve aspect ratio from selfie image if "original" is specified
          const validAspectRatio = await resolveAspectRatio(body.aspect_ratio, selfieUrlForRatio, env, { allowOriginal: true });
          const modelParam = body.model;

          const backgroundGenResult = await generateBackgroundFromPrompt(body.custom_prompt!, env, validAspectRatio, modelParam);

          if (!backgroundGenResult.Success || !backgroundGenResult.ResultImageUrl) {
            const failureCode = backgroundGenResult.StatusCode || 500;
            const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
            const debugEnabled = isDebugEnabled(env);
            const flatDebug = debugEnabled ? buildFlatDebug(backgroundGenResult) : undefined;
            const debugPayload = debugEnabled ? compact({
              customPrompt: body.custom_prompt,
              ...flatDebug,
            }) : undefined;
            return jsonResponse({
              data: null,
              status: 'error',
              message: '',
              code: failureCode,
              ...(debugPayload ? { debug: debugPayload } : {}),
            }, httpStatus);
          }

          if (backgroundGenResult.ResultImageUrl?.startsWith('r2://')) {
            const r2Key = backgroundGenResult.ResultImageUrl.replace('r2://', '');
            targetUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
          } else {
            targetUrl = backgroundGenResult.ResultImageUrl!;
          }
          presetName = 'Generated Background';
          presetImageId = null;
        } else if (hasPresetId) {
          const presetResult = results[1];
          if (!presetResult) {
            const debugEnabled = isDebugEnabled(env);
            return errorResponse('Preset image not found', 404, debugEnabled ? { presetId: body.preset_image_id, path } : undefined, request, env);
          }

          const storedKey = reconstructR2Key((presetResult as any).id, (presetResult as any).ext, 'preset');
          targetUrl = getR2PublicUrl(env, storedKey, requestUrl.origin);
          presetName = 'Preset';
          presetImageId = body.preset_image_id || null;
        } else {
          targetUrl = body.preset_image_url!;
          presetName = 'Result Preset';
          presetImageId = null;
        }

        let selfieUrl: string;
        if (hasSelfieId) {
          const selfieResult = results[hasPresetId ? 2 : 1];
          if (!selfieResult) {
            const debugEnabled = isDebugEnabled(env);
            return errorResponse(`Selfie with ID ${body.selfie_id} not found or does not belong to profile`, 404, debugEnabled ? { selfieId: body.selfie_id, profileId: body.profile_id, path } : undefined, request, env);
          }

          const storedKey = reconstructR2Key((selfieResult as any).id, (selfieResult as any).ext, 'selfie');
          selfieUrl = getR2PublicUrl(env, storedKey, requestUrl.origin);
        } else {
          selfieUrl = body.selfie_image_url!;
        }

        const requestDebug = compact({
          targetUrl: targetUrl,
          selfieUrl: selfieUrl,
          presetImageId: presetImageId,
          presetImageUrl: hasPresetUrl ? body.preset_image_url : undefined,
          presetName: presetName,
          selfieId: body.selfie_id,
          customPrompt: hasCustomPrompt ? body.custom_prompt : undefined,
          additionalPrompt: body.additional_prompt,
        });

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        const defaultMergePrompt = VERTEX_AI_PROMPTS.MERGE_PROMPT_DEFAULT;

        let mergePrompt = defaultMergePrompt;
        if (body.additional_prompt) {
          mergePrompt = `${defaultMergePrompt} Additional instructions: ${body.additional_prompt}`;
        }

        // Resolve aspect ratio from selfie image if "original" is specified
        const validAspectRatio = await resolveAspectRatio(body.aspect_ratio, selfieUrl, env, { allowOriginal: true });
        const modelParam = body.model;

        const mergeResult = await callNanoBananaMerge(mergePrompt, selfieUrl, targetUrl, env, validAspectRatio, modelParam);

        if (!mergeResult.Success || !mergeResult.ResultImageUrl) {
          const failureCode = mergeResult.StatusCode || 500;
          // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const debugEnabled = isDebugEnabled(env);
          const flatDebug = debugEnabled ? buildFlatDebug(mergeResult) : undefined;
          const debugPayload = debugEnabled ? compact({
            request: requestDebug,
            ...flatDebug,
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: '',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, httpStatus);
        }

        if (mergeResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = mergeResult.ResultImageUrl.replace('r2://', '');
          mergeResult.ResultImageUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        // Vision API scanning on result images is disabled - only used for 4k action on selfie uploads
        const safetyDebug: SafetyCheckDebug = {
          checked: false,
          isSafe: true,
          error: 'Safety check skipped for Vertex AI mode',
        };

        const storageDebug: {
          attemptedDownload: boolean;
          downloadStatus: number | null;
          savedToR2: boolean;
          r2Key: string | null;
          publicUrl: string | null;
          error: string | null;
        } = {
          attemptedDownload: false,
          downloadStatus: null,
          savedToR2: false,
          r2Key: null,
          publicUrl: null,
          error: null,
        };

        let resultUrl = mergeResult.ResultImageUrl;
        try {
          storageDebug.attemptedDownload = true;
          const resultImageResponse = await fetchWithTimeout(mergeResult.ResultImageUrl, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
          storageDebug.downloadStatus = resultImageResponse.status;
          if (resultImageResponse.ok && resultImageResponse.body) {
            const id = nanoid(16);
            const resultKey = `results/${id}.jpg`;
            await R2_BUCKET.put(resultKey, resultImageResponse.body, {
              httpMetadata: {
                contentType: resultImageResponse.headers.get('content-type') || 'image/jpeg',
                cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
              },
            });
            storageDebug.savedToR2 = true;
            storageDebug.r2Key = resultKey;
            resultUrl = getR2PublicUrl(env, resultKey, requestUrl.origin);
            storageDebug.publicUrl = resultUrl;
          } else {
            storageDebug.error = `Download failed with status ${resultImageResponse.status}`;
          }
        } catch (r2Error) {
          storageDebug.error = r2Error instanceof Error ? r2Error.message : String(r2Error);
        }

        const databaseDebug: {
          attempted: boolean;
          success: boolean;
          resultId: string | null;
          error: string | null;
          lookupError: string | null;
        } = {
          attempted: false,
          success: false,
          resultId: null,
          error: null,
          lookupError: null,
        };

        let savedResultId: string | null = null;
        if (body.profile_id) {
          databaseDebug.attempted = true;
          try {
            savedResultId = await saveResultToDatabase(DB, resultUrl, body.profile_id, env, R2_BUCKET);
            
            if (savedResultId !== null) {
              databaseDebug.success = true;
              databaseDebug.resultId = String(savedResultId);
              databaseDebug.error = null;
            } else {
              databaseDebug.error = 'Database insert failed';
            }
          } catch (dbError) {
            databaseDebug.error = dbError instanceof Error ? dbError.message : String(dbError);
          }
        }

        const debugEnabled = isDebugEnabled(env);
        const flatDebug = debugEnabled ? buildFlatDebug(mergeResult) : undefined;
        const visionDebug = debugEnabled ? buildVisionDebug(safetyDebug) : undefined;
        const storageDebugPayload = debugEnabled ? compact(storageDebug as unknown as Record<string, any>) : undefined;
        const databaseDebugPayload = debugEnabled ? compact(databaseDebug as unknown as Record<string, any>) : undefined;
        const debugPayload = debugEnabled ? compact({
          ...flatDebug,
          vision: visionDebug,
          storage: Object.keys(storageDebugPayload || {}).length ? storageDebugPayload : undefined,
          database: Object.keys(databaseDebugPayload || {}).length ? databaseDebugPayload : undefined,
        }) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: mergeResult.Message || 'Processing successful',
          code: 200,
          ...(debugPayload ? { debug: debugPayload } : {}),
        });
      } catch (error) {
        logCriticalError('/background', error, request, env, {
          body: {
            preset_image_id: body?.preset_image_id,
            preset_image_url: body?.preset_image_url,
            custom_prompt: body?.custom_prompt ? '***present***' : 'missing',
            profile_id: body?.profile_id,
            selfie_id: body?.selfie_id,
            selfie_image_url: body?.selfie_image_url ? '***present***' : 'missing'
          }
        });
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {}) } : undefined, request, env);
      }
    }

    // Handle upscaler4k endpoint
    if (path === '/upscaler4k' && request.method === 'POST') {
      let body: { image_url: string; profile_id?: string; aspect_ratio?: string } | undefined;
      try {
        body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string };
        
        if (!body.image_url) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (!body.profile_id) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        // Validate that the image_url is a selfie with action='4k' or '4K'
        const r2Key = extractR2KeyFromUrl(body.image_url);
        if (!r2Key || !r2Key.startsWith('selfie/')) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Image must be a selfie', 400, debugEnabled ? { path, imageUrl: body.image_url } : undefined, request, env);
        }

        // Extract selfie ID from R2 key (format: selfie/{id}.{ext})
        const keyParts = r2Key.replace('selfie/', '').split('.');
        if (keyParts.length < 2) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Invalid selfie URL format', 400, debugEnabled ? { path, imageUrl: body.image_url } : undefined, request, env);
        }
        const selfieId = keyParts.slice(0, -1).join('.');

        // Single JOIN query to validate profile exists, selfie exists, belongs to profile, and has action='4k'
        const validation = await DB.prepare(`
          SELECT s.id, s.action, s.ext, p.id as profile_exists
          FROM selfies s
          INNER JOIN profiles p ON s.profile_id = p.id
          WHERE s.id = ? AND p.id = ? AND LOWER(s.action) = '4k'
        `).bind(selfieId, body.profile_id).first<{ id: string; action: string | null; ext: string; profile_exists: string }>();
        
        if (!validation) {
          const debugEnabled = isDebugEnabled(env);
          // Check if profile exists separately to provide better error message
          const profileCheck = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first();
          if (!profileCheck) {
            return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
          }
          // Profile exists but selfie validation failed
          const selfieCheck = await DB.prepare('SELECT id, action FROM selfies WHERE id = ?').bind(selfieId).first<{ id: string; action: string | null }>();
          if (!selfieCheck) {
            return errorResponse('Selfie not found', 404, debugEnabled ? { selfieId, profileId: body.profile_id, path } : undefined, request, env);
          }
          const selfieAction = selfieCheck.action?.toLowerCase();
          return errorResponse('Only selfies with action="4k" or "4K" can be used for 4K upscaling', 400, debugEnabled ? { selfieId, selfieAction, path } : undefined, request, env);
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        const upscalerResult = await callUpscaler4k(body.image_url, env);

        if (!upscalerResult.Success || !upscalerResult.ResultImageUrl) {
          const failureCode = upscalerResult.StatusCode || 500;
          // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const debugEnabled = isDebugEnabled(env);
          const flatDebug = debugEnabled ? buildFlatDebug(upscalerResult) : undefined;
          const debugPayload = debugEnabled ? compact({
            ...flatDebug,
            rawError: upscalerResult.Error,
            fullResponse: (upscalerResult as any).FullResponse,
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: '',
            code: failureCode,
            ...(debugEnabled && debugPayload ? { debug: debugPayload } : {}),
          }, httpStatus, request, env);
        }

        let resultUrl = upscalerResult.ResultImageUrl;
        if (upscalerResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = upscalerResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        const savedResultId = await saveResultToDatabase(DB, resultUrl, body.profile_id, env, R2_BUCKET);

        const debugEnabled = isDebugEnabled(env);
        const flatDebug = debugEnabled ? buildFlatDebug(upscalerResult) : undefined;
        const debugPayload = debugEnabled ? compact({
          ...flatDebug,
        }) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: upscalerResult.Message || 'Upscaling completed',
          code: 200,
          ...(debugPayload ? { debug: debugPayload } : {}),
        });
      } catch (error) {
        logCriticalError('/upscaler4k', error, request, env, {
          body: {
            image_url: body?.image_url,
            profile_id: body?.profile_id
          }
        });
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {}) } : undefined, request, env);
      }
    }

    // Handle enhance endpoint
    if (path === '/enhance' && request.method === 'POST') {
      let body: { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number } | undefined;
      try {
        body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number };

        if (!body.image_url) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (!body.profile_id) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();

        if (!profileCheck) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        // Safety pre-check with Gemini 2.5 Flash Lite before processing
        const safetyCheck = await checkImageSafetyWithFlashLite(body.image_url, env);
        if (!safetyCheck.safe) {
          console.log('[Enhance] Safety check failed:', safetyCheck.reason || safetyCheck.error);
          const debugEnabled = isDebugEnabled(env);
          return errorResponse(
            safetyCheck.reason || 'Image failed safety check',
            400,
            debugEnabled ? {
              path,
              safetyCheck: {
                safe: false,
                reason: safetyCheck.reason,
                category: safetyCheck.category,
                error: safetyCheck.error
              }
            } : undefined,
            request,
            env
          );
        }

        const validAspectRatio = await resolveAspectRatio(body.aspect_ratio, body.image_url, env, { allowOriginal: true });
        const modelParam = body.model;

        // Get extended image dimensions for debug (includes EXIF orientation)
        let imageDimensionsExtended: import('./utils').ImageDimensionsExtended | null = null;
        if (body.aspect_ratio === 'original' || !body.aspect_ratio) {
          const { getImageDimensionsExtended } = await import('./utils');
          imageDimensionsExtended = await getImageDimensionsExtended(body.image_url, env);
        }

        const enhancePrompt = `Enhance this image with better lighting, contrast, and sharpness. Improve overall image quality while maintaining natural appearance. CRITICAL: Preserve the ENTIRE image content - do not crop, cut off, or remove any parts of the image. Maintain the original composition, framing, and all visible elements. Keep the full subject visible including all edges and corners. Maintain the correct horizontal orientation and do not rotate or flip the image. The output must show the complete original image with enhanced quality, not a cropped or modified composition.`;
        
        const enhancedResult = await callNanoBanana(
          enhancePrompt,
          body.image_url,
          body.image_url,
          env,
          validAspectRatio,
          modelParam
        );

        if (!enhancedResult.Success || !enhancedResult.ResultImageUrl) {
          const failureCode = enhancedResult.StatusCode || 500;
          // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const debugEnabled = isDebugEnabled(env);
          const flatDebug = debugEnabled ? buildFlatDebug(enhancedResult) : undefined;
          const debugPayload = debugEnabled ? compact({
            ...flatDebug,
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: '',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, httpStatus);
        }

        let resultUrl = enhancedResult.ResultImageUrl;
        if (enhancedResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = enhancedResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        const savedResultId = await saveResultToDatabase(DB, resultUrl, body.profile_id, env, R2_BUCKET);

        const debugEnabled = isDebugEnabled(env);
        const aspectRatioDebug = debugEnabled ? {
          requested: body.aspect_ratio || 'undefined',
          resolved: validAspectRatio,
          imageUrl: body.image_url,
          imageDimensions: imageDimensionsExtended ? {
            width: imageDimensionsExtended.width,
            height: imageDimensionsExtended.height,
            rawWidth: imageDimensionsExtended.rawWidth,
            rawHeight: imageDimensionsExtended.rawHeight,
            exifOrientation: imageDimensionsExtended.orientation,
            rotated90: imageDimensionsExtended.rotated,
            calculatedRatio: (imageDimensionsExtended.width / imageDimensionsExtended.height).toFixed(4),
            orientation: imageDimensionsExtended.width > imageDimensionsExtended.height ? 'landscape' : imageDimensionsExtended.width < imageDimensionsExtended.height ? 'portrait' : 'square',
          } : null,
        } : undefined;

        const flatDebug = debugEnabled ? buildFlatDebug(enhancedResult) : undefined;
        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: enhancedResult.Message || 'Image enhancement completed',
          code: 200,
          ...(debugEnabled ? { debug: compact({
            ...flatDebug,
            aspectRatio: aspectRatioDebug,
          }) } : {}),
        });
      } catch (error) {
        logCriticalError('/enhance', error, request, env, {
          body: {
            image_url: body?.image_url,
            profile_id: body?.profile_id,
            aspect_ratio: body?.aspect_ratio
          }
        });
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {}) } : undefined, request, env);
      }
    }

    // Handle beauty endpoint
    if (path === '/beauty' && request.method === 'POST') {
      let body: { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number } | undefined;
      try {
        body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number };

        if (!body.image_url) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (!body.profile_id) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();

        if (!profileCheck) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        // Safety pre-check with Gemini 2.5 Flash Lite before processing
        const safetyCheck = await checkImageSafetyWithFlashLite(body.image_url, env);
        if (!safetyCheck.safe) {
          console.log('[Beauty] Safety check failed:', safetyCheck.reason || safetyCheck.error);
          const debugEnabled = isDebugEnabled(env);
          return errorResponse(
            safetyCheck.reason || 'Image failed safety check',
            400,
            debugEnabled ? {
              path,
              safetyCheck: {
                safe: false,
                reason: safetyCheck.reason,
                category: safetyCheck.category,
                error: safetyCheck.error
              }
            } : undefined,
            request,
            env
          );
        }

        const validAspectRatio = await resolveAspectRatio(body.aspect_ratio, body.image_url, env, { allowOriginal: true });
        const modelParam = body.model;

        const beautyResult = await callNanoBanana(
          IMAGE_PROCESSING_PROMPTS.BEAUTY,
          body.image_url,
          body.image_url,
          env,
          validAspectRatio,
          modelParam
        );

        if (!beautyResult.Success || !beautyResult.ResultImageUrl) {
          const failureCode = beautyResult.StatusCode || 500;
          // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const debugEnabled = isDebugEnabled(env);
          const flatDebug = debugEnabled ? buildFlatDebug(beautyResult) : undefined;
          const debugPayload = debugEnabled ? compact({
            ...flatDebug,
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: '',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, httpStatus);
        }

        let resultUrl = beautyResult.ResultImageUrl;
        if (beautyResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = beautyResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        const savedResultId = await saveResultToDatabase(DB, resultUrl, body.profile_id, env, R2_BUCKET);

        const debugEnabled = isDebugEnabled(env);
        const flatDebug = debugEnabled ? buildFlatDebug(beautyResult) : undefined;
        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: beautyResult.Message || 'Image beautification completed',
          code: 200,
          ...(debugEnabled && flatDebug ? { debug: compact({
            ...flatDebug,
          }) } : {}),
        });
      } catch (error) {
        logCriticalError('/beauty', error, request, env, {
          body: {
            image_url: body?.image_url,
            profile_id: body?.profile_id,
            aspect_ratio: body?.aspect_ratio
          }
        });
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {}) } : undefined, request, env);
      }
    }

    // Handle filter endpoint
    if (path === '/filter' && request.method === 'POST') {
      const debugEnabled = isDebugEnabled(env);
      const requestCache = new Map<string, Promise<any>>();
      const getCachedAsync = async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
        if (!requestCache.has(key)) {
          requestCache.set(key, compute());
        }
        return requestCache.get(key) as Promise<T>;
      };

      let body: {
        preset_image_id?: string;
        preset_image_url?: string; 
        selfie_id?: string;
        selfie_image_url?: string;
        profile_id: string;
        aspect_ratio?: string; 
        model?: string | number;
        additional_prompt?: string;
      } | undefined;
      try {
        body = await request.json() as { 
          preset_image_id?: string;
          preset_image_url?: string; 
          selfie_id?: string;
          selfie_image_url?: string;
          profile_id: string;
          aspect_ratio?: string; 
          model?: string | number;
          additional_prompt?: string;
        };

        // Normalize preset_image_id to remove file extensions (mobile apps may send IDs with extensions)
        if (body.preset_image_id) {
          const normalized = normalizePresetId(body.preset_image_id);
          if (normalized) {
            body.preset_image_id = normalized;
          }
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          return errorResponse('Missing environment configuration', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        // Validate profile_id is required
        if (!body.profile_id) {
          return errorResponse('Missing required field: profile_id', 400, debugEnabled ? { path } : undefined, request, env);
        }

        // Validate profile exists
        const profileCheck = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first();
        if (!profileCheck) {
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
        }

        // Validate preset inputs (ID or URL required)
        const hasPresetId = body.preset_image_id && body.preset_image_id.trim() !== '';
        const hasPresetUrl = body.preset_image_url && body.preset_image_url.trim() !== '';
        
        if (!hasPresetId && !hasPresetUrl) {
          return errorResponse('Missing required field: preset_image_id or preset_image_url', 400, debugEnabled ? { path } : undefined, request, env);
        }
        
        if (hasPresetId && hasPresetUrl) {
          return errorResponse('Cannot provide both preset_image_id and preset_image_url', 400, debugEnabled ? { path } : undefined, request, env);
        }

        // Validate selfie inputs (ID or URL required)
        const hasSelfieId = body.selfie_id && body.selfie_id.trim() !== '';
        const hasSelfieUrl = body.selfie_image_url && body.selfie_image_url.trim() !== '';
        
        if (!hasSelfieId && !hasSelfieUrl) {
          return errorResponse('Missing required field: selfie_id or selfie_image_url', 400, debugEnabled ? { path } : undefined, request, env);
        }
        
        if (hasSelfieId && hasSelfieUrl) {
          return errorResponse('Cannot provide both selfie_id and selfie_image_url', 400, debugEnabled ? { path } : undefined, request, env);
        }

        // Resolve preset image URL
        let presetImageUrl: string = '';
        let presetResult: any = null;
        let r2Key: string | null = null;

        if (hasPresetId) {
          // Lookup preset by ID from database
          presetResult = await DB.prepare('SELECT id, ext FROM presets WHERE id = ?').bind(body.preset_image_id).first();
          if (!presetResult) {
            return errorResponse('Preset image not found', 404, debugEnabled ? { presetImageId: body.preset_image_id, path } : undefined, request, env);
          }
          r2Key = reconstructR2Key((presetResult as any).id, (presetResult as any).ext, 'preset');
          presetImageUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        } else if (hasPresetUrl) {
          // Use preset URL directly
          presetImageUrl = body.preset_image_url!;
          if (!validateImageUrl(presetImageUrl, env)) {
            return errorResponse('Invalid preset image URL', 400, debugEnabled ? { path } : undefined, request, env);
          }
          
          // Try to extract R2 key from URL for prompt lookup
          try {
            const presetUrl = new URL(presetImageUrl);
            const pathParts = presetUrl.pathname.split('/').filter(p => p);
            if (pathParts.length >= 2 && ['preset', 'selfie', 'results'].includes(pathParts[0])) {
              r2Key = `${pathParts[0]}/${pathParts[1]}`;
            }
          } catch {
            // Not an R2 URL or invalid URL, continue without r2Key
          }
        }

        // Resolve selfie image URL
        let selfieImageUrl: string = '';

        let selfieAction: string | null = null;
        if (hasSelfieId) {
          // Lookup selfie by ID and validate ownership, include action
          const selfieResult = await DB.prepare(`
            SELECT s.id, s.ext, s.action, p.id as profile_exists
            FROM selfies s
            INNER JOIN profiles p ON s.profile_id = p.id
            WHERE s.id = ? AND p.id = ?
          `).bind(body.selfie_id, body.profile_id).first();
          
          if (!selfieResult) {
            return errorResponse('Selfie not found or does not belong to profile', 404, debugEnabled ? { selfieId: body.selfie_id, profileId: body.profile_id, path } : undefined, request, env);
          }
          
          selfieAction = (selfieResult as any).action || null;
          const selfieR2Key = reconstructR2Key((selfieResult as any).id, (selfieResult as any).ext, 'selfie');
          selfieImageUrl = getR2PublicUrl(env, selfieR2Key, requestUrl.origin);
        } else if (hasSelfieUrl) {
          // Use selfie URL directly
          selfieImageUrl = body.selfie_image_url!;
          if (!validateImageUrl(selfieImageUrl, env)) {
            return errorResponse('Invalid selfie image URL', 400, debugEnabled ? { path } : undefined, request, env);
          }
        }

        // Safety pre-check with Gemini 2.5 Flash Lite before processing
        const safetyCheck = await checkImageSafetyWithFlashLite(selfieImageUrl, env);
        if (!safetyCheck.safe) {
          console.log('[Filter] Safety check failed:', safetyCheck.reason || safetyCheck.error);
          return errorResponse(
            safetyCheck.reason || 'Image failed safety check',
            400,
            debugEnabled ? {
              path,
              safetyCheck: {
                safe: false,
                reason: safetyCheck.reason,
                category: safetyCheck.category,
                error: safetyCheck.error
              }
            } : undefined,
            request,
            env
          );
        }

        // Read prompt_json from R2 metadata or cache
        let storedPromptPayload: any = null;
        const promptCacheKV = getPromptCacheKV(env);
        const presetImageId = hasPresetId ? body.preset_image_id : (presetResult ? (presetResult as any).id : null);
        
        if (presetImageId && r2Key) {
          const cacheKey = `prompt:${presetImageId}`;
          
          if (promptCacheKV) {
            try {
              const cached = await promptCacheKV.get(cacheKey, 'json');
              if (cached) storedPromptPayload = cached;
            } catch (error) {
              // KV cache read failed, fallback to R2
            }
          }
          
          if (!storedPromptPayload) {
            try {
              const r2Object = await getCachedAsync(`r2head:${r2Key}`, async () =>
                await R2_BUCKET.head(r2Key)
              );
              const promptJson = r2Object?.customMetadata?.prompt_json;
              if (promptJson?.trim()) {
                storedPromptPayload = JSON.parse(promptJson);
                if (promptCacheKV) {
                  promptCacheKV.put(cacheKey, promptJson, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {});
                }
              }
            } catch (error) {
              // R2 metadata read failed, continue without cache
            }
          }
        } else if (r2Key) {
          // Fallback for preset_image_url case (no preset ID available)
          const cacheKey = `prompt:${r2Key}`;
          
          if (promptCacheKV) {
            try {
              const cached = await promptCacheKV.get(cacheKey, 'json');
              if (cached) storedPromptPayload = cached;
            } catch (error) {
              // KV cache read failed, fallback to R2
            }
          }
          
          if (!storedPromptPayload) {
            try {
              const r2Object = await getCachedAsync(`r2head:${r2Key}`, async () =>
                await R2_BUCKET.head(r2Key)
              );
              const promptJson = r2Object?.customMetadata?.prompt_json;
              if (promptJson?.trim()) {
                storedPromptPayload = JSON.parse(promptJson);
                if (promptCacheKV) {
                  promptCacheKV.put(cacheKey, promptJson, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {});
                }
              }
            } catch (error) {
              // R2 metadata read failed, continue without cache
            }
          }
        }

        if (!storedPromptPayload) {
          return errorResponse('Prompt JSON not found in preset image metadata', 400, debugEnabled ? { error: 'Preset must have prompt_json metadata for filter mode', path } : undefined, request, env);
        }

        const transformedPrompt = transformPromptForFilter(storedPromptPayload);
        const augmentedPrompt = augmentVertexPrompt(
          transformedPrompt,
          body.additional_prompt
        );

        const validAspectRatio = await resolveAspectRatio(body.aspect_ratio, selfieImageUrl, env, { allowOriginal: true });
        const modelParam = body.model;

        const filterResult = await callNanoBanana(
          augmentedPrompt,
          selfieImageUrl,
          selfieImageUrl,
          env,
          validAspectRatio,
          modelParam
        );

        if (!filterResult.Success || !filterResult.ResultImageUrl) {
          const failureCode = filterResult.StatusCode || 500;
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const flatDebug = debugEnabled ? buildFlatDebug(filterResult) : undefined;
          const debugPayload = debugEnabled ? compact({
            ...flatDebug,
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: filterResult.Message || 'Style filter processing failed',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, httpStatus);
        }

        let resultUrl = filterResult.ResultImageUrl;
        if (filterResult.ResultImageUrl?.startsWith('r2://')) {
          const r2ResultKey = filterResult.ResultImageUrl.replace('r2://', '');
          resultUrl = getR2PublicUrl(env, r2ResultKey, requestUrl.origin);
        }

        // Save result to database for history
        const savedResultId = await saveResultToDatabase(DB, resultUrl, body.profile_id, env, R2_BUCKET);

        const flatDebug = debugEnabled ? buildFlatDebug(filterResult) : undefined;
        return jsonResponse({
          data: {
            resultImageUrl: resultUrl,
            resultId: savedResultId,
            selfie: hasSelfieId ? {
              id: body.selfie_id,
              action: selfieAction,
            } : undefined,
          },
          status: 'success',
          message: filterResult.Message || 'Style filter applied successfully',
          code: 200,
          ...(debugEnabled && flatDebug ? { debug: compact({
            ...flatDebug,
            database: savedResultId ? { saved: true, resultId: savedResultId } : { saved: false },
          }) } : {}),
        });
      } catch (error) {
        logCriticalError('/filter', error, request, env, {
          body: {
            preset_image_id: body?.preset_image_id,
            preset_image_url: body?.preset_image_url ? '***present***' : 'missing',
            selfie_id: body?.selfie_id,
            selfie_image_url: body?.selfie_image_url ? '***present***' : 'missing',
            profile_id: body?.profile_id
          }
        });
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('Internal server error', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {}) } : undefined, request, env);
      }
    }

    // Handle restore endpoint
    if (path === '/restore' && request.method === 'POST') {
      let body: { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number } | undefined;
      try {
        body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number };

        if (!body.image_url) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (!body.profile_id) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();
        if (!profileCheck) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        const validAspectRatio = await resolveAspectRatio(body.aspect_ratio, body.image_url, env, { allowOriginal: true });
        const modelParam = body.model;

        const restoredResult = await callNanoBanana(
          IMAGE_PROCESSING_PROMPTS.FILTER,
          body.image_url,
          body.image_url,
          env,
          validAspectRatio,
          modelParam
        );

        if (!restoredResult.Success || !restoredResult.ResultImageUrl) {
          const failureCode = restoredResult.StatusCode || 500;
          // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const debugEnabled = isDebugEnabled(env);
          const flatDebug = debugEnabled ? buildFlatDebug(restoredResult) : undefined;
          const debugPayload = debugEnabled ? compact({
            ...flatDebug,
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: '',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, httpStatus);
        }

        let resultUrl = restoredResult.ResultImageUrl;
        if (restoredResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = restoredResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        const savedResultId = await saveResultToDatabase(DB, resultUrl, body.profile_id, env, R2_BUCKET);

        const debugEnabled = isDebugEnabled(env);
        const flatDebug = debugEnabled ? buildFlatDebug(restoredResult) : undefined;
        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: restoredResult.Message || 'Image restoration completed',
          code: 200,
          ...(debugEnabled && flatDebug ? { debug: compact({
            ...flatDebug,
          }) } : {}),
        });
      } catch (error) {
        logCriticalError('/restore', error, request, env, {
          body: {
            image_url: body?.image_url,
            profile_id: body?.profile_id,
            aspect_ratio: body?.aspect_ratio
          }
        });
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {}) } : undefined, request, env);
      }
    }

    // Handle aging endpoint
    if (path === '/aging' && request.method === 'POST') {
      let body: { image_url: string; age_years?: number; profile_id?: string; aspect_ratio?: string; model?: string | number } | undefined;
      try {
        body = await request.json() as { image_url: string; age_years?: number; profile_id?: string; aspect_ratio?: string; model?: string | number };

        if (!body.image_url) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (!body.profile_id) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();
        if (!profileCheck) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
        }

        const ageYears = body.age_years || 20;
        const envError = validateEnv(env, 'vertex');
        if (envError) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        const validAspectRatio = await resolveAspectRatio(body.aspect_ratio, body.image_url, env, { allowOriginal: true });
        const modelParam = body.model;

        // For now, implement aging using existing Nano Banana API
        // This is a placeholder - in production, you'd want a dedicated aging model
        const agingResult = await callNanoBanana(
          `Age this person by ${ageYears} years. Add realistic aging effects including facial wrinkles, gray hair, maturity in appearance while maintaining the person's identity and natural features. Make the changes subtle and realistic.`,
          body.image_url,
          body.image_url, // Use same image as target and source for aging
          env,
          validAspectRatio,
          modelParam
        );

        if (!agingResult.Success || !agingResult.ResultImageUrl) {
          const failureCode = agingResult.StatusCode || 500;
          // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const debugEnabled = isDebugEnabled(env);
          const flatDebug = debugEnabled ? buildFlatDebug(agingResult) : undefined;
          const debugPayload = debugEnabled ? compact({
            ...flatDebug,
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: '',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, httpStatus);
        }

        let resultUrl = agingResult.ResultImageUrl;
        if (agingResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = agingResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        const savedResultId = await saveResultToDatabase(DB, resultUrl, body.profile_id, env, R2_BUCKET);

        const debugEnabled = isDebugEnabled(env);
        const flatDebug = debugEnabled ? buildFlatDebug(agingResult) : undefined;
        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: agingResult.Message || 'Aging transformation completed',
          code: 200,
          ...(debugEnabled && flatDebug ? { debug: compact({
            ...flatDebug,
          }) } : {}),
        });
      } catch (error) {
        logCriticalError('/aging', error, request, env, {
          body: {
            image_url: body?.image_url,
            profile_id: body?.profile_id,
            age_years: body?.age_years,
            aspect_ratio: body?.aspect_ratio
          }
        });
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 1000) } : {}) } : undefined, request, env);
      }
    }

    // Handle config endpoint - returns public configuration
    if (path === '/config' && request.method === 'GET') {
      const backendDomain = env.BACKEND_DOMAIN;
      const r2Domain = env.R2_DOMAIN;
      const debugEnabled = isDebugEnabled(env);
      const promptCacheKV = getPromptCacheKV(env);
      const kvCacheAvailable = !!promptCacheKV;

      let kvCacheTest = null;
      let kvCacheDetails = null;
      if (kvCacheAvailable && promptCacheKV) {
        try {
          const testKey = `__test__${Date.now()}`;
          const testValue = JSON.stringify({ test: true, timestamp: Date.now() });

          await promptCacheKV.put(testKey, testValue, { expirationTtl: 60 });

          const readBack = await promptCacheKV.get(testKey, 'json');
          if (readBack && (readBack as any).test) {
            await promptCacheKV.delete(testKey);
            kvCacheTest = 'working';
            kvCacheDetails = {
              write: 'success',
              read: 'success',
              delete: 'success'
            };
          } else {
            kvCacheTest = 'write_success_read_failed';
            kvCacheDetails = {
              write: 'success',
              read: 'failed',
              readBack: readBack
            };
          }
        } catch (error) {
          kvCacheTest = `error: ${error instanceof Error ? error.message : String(error)}`;
          kvCacheDetails = {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          };
        }
      } else {
        kvCacheDetails = {
          reason: 'Prompt cache KV not bound',
          bindingName: env.PROMPT_CACHE_KV_BINDING_NAME || 'not set',
          envKeys: Object.keys(env).filter(k => k.includes('KV') || k.includes('CACHE') || k.includes('PROMPT'))
        };
      }

      return jsonResponse({
        data: {
          backendDomain: backendDomain || null,
          r2Domain: r2Domain || null,
          kvCache: {
            available: kvCacheAvailable,
            test: kvCacheTest,
            details: kvCacheDetails
          }
        },
        status: 'success',
        message: 'Configuration retrieved successfully',
        code: 200,
        ...(debugEnabled ? { debug: { path, backendDomain: !!backendDomain, r2Domain: !!r2Domain, kvCacheAvailable, envKeys: Object.keys(env) } } : {})
      }, 200, request, env);
    }

    // 404 for unmatched routes
    const debugEnabled = isDebugEnabled(env);
    return errorResponse('Not found', 404, debugEnabled ? { path, method: request.method } : undefined, request, env);
  },
};
