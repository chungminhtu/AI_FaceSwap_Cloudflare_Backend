/// <reference types="@cloudflare/workers-types" />

import { customAlphabet } from 'nanoid';
const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_', 21);
import JSZip from 'jszip';
import type { Env, FaceSwapRequest, FaceSwapResponse, UploadUrlRequest, Profile, BackgroundRequest } from './types';
import { CORS_HEADERS, getCorsHeaders, jsonResponse, errorResponse, successResponse, validateImageUrl, fetchWithTimeout, getImageDimensions, getClosestAspectRatio, promisePoolWithConcurrency } from './utils';
import { callFaceSwap, callNanoBanana, callNanoBananaMerge, checkSafeSearch, generateVertexPrompt, callUpscaler4k, generateBackgroundFromPrompt } from './services';
import { validateEnv, validateRequest } from './validators';
import { VERTEX_AI_PROMPTS, IMAGE_PROCESSING_PROMPTS, ASPECT_RATIO_CONFIG, CACHE_CONFIG, TIMEOUT_CONFIG } from './config';

// Retry helper for Vertex AI prompt generation - MUST succeed before uploading to R2
const generateVertexPromptWithRetry = async (
  imageUrl: string,
  env: Env,
  isFilterMode: boolean = false,
  customPromptText: string | null = null,
  maxRetries: number = 8,
  initialDelay: number = 1000
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
      
      // Store error for final return if all retries fail
      lastError = result.error || 'Unknown error';
      lastDebug = result.debug;
      
      // Check if error is retryable
      if (!isRetryableError(lastError, lastDebug)) {
        console.warn(`[Vertex Prompt Retry] Non-retryable error on attempt ${attempt + 1}: ${lastError}`);
        return {
          success: false,
          error: lastError,
          debug: lastDebug
        };
      }
      
      // If not last attempt, wait before retrying (exponential backoff with jitter)
      if (attempt < maxRetries - 1) {
        const baseDelay = initialDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 0.3 * baseDelay; // Add up to 30% jitter
        const delay = Math.min(baseDelay + jitter, 30000); // Cap at 30 seconds
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
        const delay = Math.min(baseDelay + jitter, 30000);
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
    debug: lastDebug
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

// Helper function to resolve aspect ratio for non-faceswap endpoints
// If aspect_ratio is "original" or null/undefined, calculate from selfie image
const resolveAspectRatioForNonFaceswap = async (
  aspectRatio: string | undefined | null,
  selfieImageUrl: string,
  env: Env
): Promise<string> => {
  const supportedRatios = ASPECT_RATIO_CONFIG.SUPPORTED;
  
  // If aspect_ratio is "original" or null/undefined, calculate from image
  if (!aspectRatio || aspectRatio === 'original') {
    const dimensions = await getImageDimensions(selfieImageUrl, env);
    if (dimensions) {
      const closestRatio = getClosestAspectRatio(dimensions.width, dimensions.height, supportedRatios);
      return closestRatio;
    }
    return ASPECT_RATIO_CONFIG.DEFAULT;
  }
  
  // Validate and return supported ratio, or default
  return supportedRatios.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
};

const globalScopeWithAccount = globalThis as typeof globalThis & {
  ACCOUNT_ID?: string;
  __CF_ACCOUNT_ID?: string;
  __ACCOUNT_ID?: string;
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
    const maxHistory = parseInt(env.RESULT_MAX_HISTORY || '10', 10);
    
    // Check current count of results for this profile
    const countResult = await DB.prepare(
      'SELECT COUNT(*) as count FROM results WHERE profile_id = ?'
    ).bind(profileId).first<{ count: number }>();
    
    const currentCount = countResult?.count || 0;
    
    // If we're at or over the limit, delete oldest results
    if (currentCount >= maxHistory) {
      const excessCount = currentCount - maxHistory + 1; // +1 because we're about to add one
      
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

const resolveAccountId = (env: Env): string | undefined =>
  env.R2_ACCOUNT_ID ||
  env.CF_ACCOUNT_ID ||
  env.ACCOUNT_ID ||
  globalScopeWithAccount.ACCOUNT_ID ||
  globalScopeWithAccount.__CF_ACCOUNT_ID ||
  globalScopeWithAccount.__ACCOUNT_ID;

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
      
      // If path already has a bucket prefix (preset/, selfie/, results/), return as-is
      if (fullPath.startsWith('preset/') || fullPath.startsWith('selfie/') || fullPath.startsWith('selfies/') || fullPath.startsWith('presets/') || fullPath.startsWith('results/')) {
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
        return `preset/${fullPath}`;
      }
      
      // Default: return as-is (might be a legacy format)
      return fullPath;
    }
    
    return pathParts.join('/') || null;
  } catch (error) {
    return null;
  }
};

const buildSelfieUrl = (key: string, env: Env, fallbackOrigin?: string): string => {
  return getR2PublicUrl(env, key, fallbackOrigin);
};

const buildPresetUrl = (key: string, env: Env, fallbackOrigin?: string): string => {
  return getR2PublicUrl(env, key, fallbackOrigin);
};

const buildResultUrl = (key: string, env: Env, fallbackOrigin?: string): string => {
  return getR2PublicUrl(env, key, fallbackOrigin);
};

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

const buildProviderDebug = (result: FaceSwapResponse, finalUrl?: string): Record<string, any> =>
  compact({
    success: result.Success,
    statusCode: result.StatusCode,
    message: result.Message,
    processingTime: result.ProcessingTime || result.ProcessingTimeSpan,
    processStarted: result.ProcessStartedDateTime,
    faceSwapCount: result.FaceSwapCount,
    error: result.Error,
    originalResultImageUrl: result.ResultImageUrl,
    finalResultImageUrl: finalUrl,
    debug: (result as any).Debug,
  });

const buildVertexDebug = (result: FaceSwapResponse): Record<string, any> | undefined => {
  const extended = result as FaceSwapResponse & {
    VertexResponse?: any;
    Prompt?: any;
    CurlCommand?: string;
  };
  if (!extended.VertexResponse && !extended.Prompt && !extended.CurlCommand) {
    return undefined;
  }
  return compact({
    prompt: extended.Prompt,
    response: extended.VertexResponse,
    curlCommand: extended.CurlCommand,
  });
};

const mergeVertexDebug = (result: FaceSwapResponse, promptPayload: any): Record<string, any> | undefined => {
  const base = buildVertexDebug(result);
  const debugDetails = (result as any).Debug;
  let merged = base ? { ...base } : undefined;
  if (promptPayload && (!merged || !('prompt' in merged))) {
    merged = {
      ...(merged ?? {}),
      prompt: promptPayload,
    };
  }
  if (debugDetails) {
    merged = {
      ...(merged ?? {}),
      debug: debugDetails,
    };
  }
  if (!merged) {
    return undefined;
  }
  return compact(merged);
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
  return compact({
    checked: vision.checked,
    isSafe: vision.isSafe,
    statusCode: vision.statusCode,
    violationCategory: vision.violationCategory,
    violationLevel: vision.violationLevel,
    details: vision.details,
    error: vision.error,
    rawResponse: vision.rawResponse,
    debug: vision.debug,
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
      // Large file upload endpoints: 100MB limit (Cloudflare Workers Pro/Free plan limit)
      // For files >100MB, use presigned URL flow: /upload-thumbnails-url → /r2-upload → /process-thumbnails
      const isLargeUploadEndpoint = path === '/upload-url' || path === '/upload-thumbnails' || path.startsWith('/r2-upload/');
      const maxSize = isLargeUploadEndpoint ? 100 * 1024 * 1024 : 1024 * 1024;
      const sizeCheck = checkRequestSize(request, maxSize);
      if (!sizeCheck.valid) {
        const debugEnabled = isDebugEnabled(env);
        return errorResponse(sizeCheck.error || 'Request too large', 413, debugEnabled ? { path, method: request.method, maxSize } : undefined, request, env);
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
          isFilterMode = formData.get('is_filter_mode') === 'true';
          customPromptText = formData.get('custom_prompt_text') as string | null;
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
          imageUrlsCount: imageUrls.length
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
                const promptResult = await generateVertexPrompt(publicUrl, env, isFilterMode, customPromptText);
                if (promptResult.success && promptResult.prompt) {
                  promptJson = JSON.stringify(promptResult.prompt);
                  vertexCallInfo = {
                    success: true,
                    promptKeys: Object.keys(promptResult.prompt),
                    debug: promptResult.debug
                  };
                } else {
                  vertexCallInfo = {
                    success: false,
                    error: promptResult.error || 'Unknown error',
                    debug: promptResult.debug
                  };
                }
              } catch (vertexError) {
                const errorMsg = vertexError instanceof Error ? vertexError.message : String(vertexError);
                vertexCallInfo = {
                  success: false,
                  error: errorMsg.substring(0, 200),
                  debug: { errorDetails: errorMsg.substring(0, 200) }
                };
              }
            }

            // Store prompt_json in R2 metadata
            if (promptJson) {
              try {
                const existingObject = await R2_BUCKET.head(key);
                if (existingObject) {
                  await R2_BUCKET.put(key, fileData.fileData, {
                    httpMetadata: {
                      contentType: fileData.contentType,
                      cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                    },
                    customMetadata: {
                      prompt_json: promptJson
                    }
                  });
                }
              } catch (metadataError) {
              }
            }

            // Save to database (store only id and ext, prompt_json in R2 metadata)
            const dbResult = await DB.prepare(
              'INSERT INTO presets (id, ext, created_at) VALUES (?, ?, ?)'
            ).bind(id, ext, createdAt).run();

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
              vertex_info: vertexCallInfo
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
            // Log values for debugging (in production, remove or make conditional)
            const bindValues = [
              String(validId),           // id: TEXT
              String(validExt),          // ext: TEXT NOT NULL
              String(validProfileId),    // profile_id: TEXT NOT NULL
              String(validAction),       // action: TEXT (nullable)
              Number(validCreatedAt)     // created_at: INTEGER NOT NULL
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
            if (typeof bindValues[4] !== 'number' || isNaN(bindValues[4])) {
              throw new Error(`Invalid created_at type: ${typeof bindValues[4]}, value: ${bindValues[4]}`);
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

        // Process files: presets in parallel (no state conflicts), selfies sequentially (enforce limits without race conditions)
        let results: any[] = [];
        if (type === 'preset') {
          // Presets can be processed in parallel - no limit enforcement conflicts
          results = await Promise.all(allFileData.map((fileData, index) => processFile(fileData, index)));
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
                return {
                  id: r.id,
                  url: r.url,
                  filename: r.filename
                };
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

    // Handle thumbnail folder upload endpoint - processes both original presets and thumbnails
    if (path === '/upload-thumbnails' && request.method === 'POST') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        if (!contentType.toLowerCase().includes('multipart/form-data')) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { contentType, path } : undefined, request, env);
        }

        // Read formData once (request body can only be read once)
        const formData = await request.formData();
        
        // Wrap entire upload process in retry logic
        return await retryUploadOperation(async () => {
        let files: Array<{ file: File; path: string }> = [];
        const fileEntries = formData.getAll('files');
        const results: any[] = [];
        
        // Parse is_filter_mode from formData
        const isFilterMode = formData.get('is_filter_mode') === 'true';
        const customPromptText = formData.get('custom_prompt_text') as string | null;
        
        // Check if any uploaded files are zip files
        const zipFiles: File[] = [];
        const regularFiles: Array<{ file: File; path: string }> = [];

        // First pass: separate zip files from regular files
        for (const entry of fileEntries) {
          if (entry && typeof entry !== 'string') {
            const file = entry as any as File;
            if (file.type === 'application/zip' || file.type === 'application/x-zip-compressed' || file.name.toLowerCase().endsWith('.zip')) {
              zipFiles.push(file);
            } else {
              const pathKey = Array.from(formData.keys()).find(k => k === `path_${file.name}`);
              const filePath = pathKey ? (formData.get(pathKey) as string || '') : '';
              regularFiles.push({ file, path: filePath });
            }
          }
        }

        // Process zip files: extract files incrementally to avoid memory exhaustion
        for (const zipFile of zipFiles) {
          try {
            const zipData = await zipFile.arrayBuffer();
            const zip = await JSZip.loadAsync(zipData);

            // Extract files one at a time to avoid loading all into memory
            const zipEntries: Array<{ relativePath: string; zipEntry: any }> = [];
            zip.forEach((relativePath: string, zipEntry: any) => {
              if (!zipEntry.dir) {
                zipEntries.push({ relativePath, zipEntry });
              }
            });

            // Process entries sequentially to avoid memory issues
            for (const { relativePath, zipEntry } of zipEntries) {
              const blob = await zipEntry.async('blob');
              const fileName = relativePath.split('/').pop() || 'unknown';
              const file = new File([blob], fileName, { type: blob.type });
              
              // Clean path immediately when extracting from zip - remove duplicate folders
              let cleanedPath = relativePath.replace(/\\/g, '/');
              cleanedPath = cleanedPath.replace(/^\/+|\/+$/g, '');
              
              // Remove duplicate consecutive folder names aggressively (case-insensitive)
              let pathParts = cleanedPath.split('/');
              let changed = true;
              while (changed) {
                changed = false;
                const cleanedParts: string[] = [];
                for (let i = 0; i < pathParts.length; i++) {
                  if (i === 0 || pathParts[i].toLowerCase() !== pathParts[i - 1].toLowerCase()) {
                    cleanedParts.push(pathParts[i]);
                  } else {
                    changed = true;
                  }
                }
                pathParts = cleanedParts;
              }
              cleanedPath = pathParts.join('/');
              
              files.push({ file, path: cleanedPath });
            }
          } catch (error) {
            // If zip processing fails, add an error result
            results.push({
              filename: zipFile.name,
              success: false,
              error: `Failed to extract zip file: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        }

        // Add regular files
        files.push(...regularFiles);

        if (files.length === 0) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const DB = getD1Database(env);
        const R2_BUCKET = getR2Bucket(env);
        const requestUrl = new URL(request.url);

        // Process each file as a thumbnail that becomes a preset
        const thumbnailFiles: Array<{ file: File; path: string; parsed: any }> = [];

        // Parse all files
        for (const { file, path } of files) {
          const filename = file.name || '';
          const parsed = parseThumbnailFilename(filename);

          if (!parsed) {
            results.push({
              filename,
              success: false,
              error: 'Invalid filename format. Could not extract preset_id from filename.'
            });
            continue;
          }

          thumbnailFiles.push({ file, path, parsed });
        }

        // Separate files that need Vertex AI prompt generation (images from preset folder) from thumbnail files
        const filesNeedingPrompts: Array<{ file: File; path: string; parsed: any; index: number }> = [];
        const thumbnailFilesOnly: Array<{ file: File; path: string; parsed: any; index: number }> = [];


        thumbnailFiles.forEach((item, index) => {
          const { file, path, parsed } = item;
          const filename = (file.name || '').toLowerCase();
          // Normalize path separators (handle both / and \)
          const normalizedPath = (path || '').replace(/\\/g, '/').toLowerCase();
          
          // Check if it's from preset folder - more comprehensive check
          const pathParts = normalizedPath.split('/').filter(p => p);
          const isFromPresetFolderByPath = 
            normalizedPath.includes('preset/') || 
            normalizedPath.startsWith('preset/') || 
            normalizedPath.includes('/preset/') ||
            normalizedPath === 'preset' ||
            (pathParts.length > 0 && pathParts[0] === 'preset');
          
          // FALLBACK: If no path info, detect preset files by extension
          // PNG files are typically from the preset folder (source images for Vertex AI)
          // WebP/JSON files without preset path are thumbnails
          const isPresetByFilename = !normalizedPath && filename.endsWith('.png');
          
          // Check if it's a thumbnail folder by path pattern (webp_*x, lottie_*x, etc.)
          const isThumbnailFolderByPath = normalizedPath.match(/(webp|lottie|lottie_avif)_[\d.]+x\//);
          
          // Final decision: preset if from preset folder OR (no path AND is PNG)
          const isFromPresetFolder = isFromPresetFolderByPath || (isPresetByFilename && !isThumbnailFolderByPath);


          if (isFromPresetFolder) {
            // Files from preset folder need Vertex AI prompt generation (PNG/WebP images)
            filesNeedingPrompts.push({ file, path, parsed, index });
          } else {
            // Other files (lottie JSON from resolution folders) are thumbnails only
            thumbnailFilesOnly.push({ file, path, parsed, index });
          }
        });


        // Batch generate Vertex AI prompts for files that need them
        const promptResults: Array<{ index: number; promptJson: string | null; vertexCallInfo: any }> = [];

        if (filesNeedingPrompts.length > 0) {
          // Process files incrementally: upload → Vertex AI → cleanup, one at a time
          // This prevents memory exhaustion from keeping all files in memory
          const VERTEX_CONCURRENCY_LIMIT = 2;
          
          const promptGenerationResults = await promisePoolWithConcurrency(
            filesNeedingPrompts,
            async ({ file, parsed, index }) => {
              const presetId = parsed.preset_id;
              const fileFormat = parsed.format;
              const tempR2Key = `temp/${presetId}_${Date.now()}_${index}.${fileFormat === 'lottie' ? 'json' : 'webp'}`;
              
              // Upload temp file to R2 (only this file in memory now)
              const fileData = await file.arrayBuffer();
              const contentType = fileFormat === 'lottie' ? 'application/json' : 'image/webp';
              
              await R2_BUCKET.put(tempR2Key, fileData, {
                httpMetadata: {
                  contentType,
                  cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                },
              });
              
              // fileData can be garbage collected now
              const tempPublicUrl = getR2PublicUrl(env, tempR2Key, requestUrl.origin);
              
              // Generate Vertex AI prompt with retry - MUST succeed before proceeding
              const promptResult = await generateVertexPromptWithRetry(tempPublicUrl, env, isFilterMode, customPromptText);
              
              // Clean up temp file immediately after processing
              try {
                await R2_BUCKET.delete(tempR2Key);
              } catch (e) {
                // Ignore cleanup errors
              }

              if (!promptResult.success || !promptResult.prompt) {
                // Prompt generation failed after all retries - return error
                const vertexCallInfo = {
                  success: false,
                  error: promptResult.error || 'Vertex AI prompt generation failed after retries',
                  debug: promptResult.debug
                };
                return { index, promptJson: null, vertexCallInfo };
              }

              // Prompt generation succeeded
              const promptJson = JSON.stringify(promptResult.prompt);
              const vertexCallInfo = {
                success: true,
                promptKeys: Object.keys(promptResult.prompt),
                debug: promptResult.debug
              };

              return { index, promptJson, vertexCallInfo };
            },
            VERTEX_CONCURRENCY_LIMIT
          );
          
          promptResults.push(...promptGenerationResults);
        }

        // Create a map of prompt results by index
        const promptMap = new Map<number, { promptJson: string | null; vertexCallInfo: any }>();
        promptResults.forEach(({ index, promptJson, vertexCallInfo }) => {
          promptMap.set(index, { promptJson, vertexCallInfo });
        });

        // Process preset files (with Vertex AI prompts) - MUST be processed first before thumbnails
        // Process sequentially to avoid loading all files into memory at once
        for (const { file, path, parsed, index } of filesNeedingPrompts) {
          let presetCreated = false;
          let presetId = '';
          try {
            const filename = file.name;
            presetId = parsed.preset_id;
            const fileFormat = parsed.format;
            const isLottie = fileFormat === 'lottie';

            // Build R2 key preserving original folder structure
            let r2Key: string = '';
            if (path && path.trim()) {
              let normalizedPath = path.replace(/\\/g, '/');
              normalizedPath = normalizedPath.replace(/^\/+|\/+$/g, '');
              normalizedPath = normalizedPath.replace(/^presets?\//i, 'preset/');
              
              // Remove duplicate folder patterns - handle all cases aggressively (case-insensitive)
              // Pattern: folder_name/folder_name/rest -> folder_name/rest
              // Apply multiple passes to catch all duplicates
              let pathParts = normalizedPath.split('/');
              let changed = true;
              while (changed) {
                changed = false;
                const cleanedParts: string[] = [];
                for (let i = 0; i < pathParts.length; i++) {
                  if (i === 0 || pathParts[i].toLowerCase() !== pathParts[i - 1].toLowerCase()) {
                    cleanedParts.push(pathParts[i]);
                  } else {
                    changed = true;
                  }
                }
                pathParts = cleanedParts;
              }
              normalizedPath = pathParts.join('/');
              
              // Remove any parent folders - keep only the actual folder structure at root level
              pathParts = normalizedPath.split('/');
              if (pathParts.length > 2) {
                const expectedPatterns = [
                  /^preset$/i,
                  /^(lottie|lottie_avif|webp)_[\d.]+x$/i
                ];
                
                let foundKey = false;
                for (let i = 0; i < pathParts.length - 1; i++) {
                  const folderName = pathParts[i];
                  const matchesPattern = expectedPatterns.some(pattern => pattern.test(folderName));
                  
                  if (matchesPattern) {
                    r2Key = pathParts.slice(i).join('/');
                    foundKey = true;
                    break;
                  }
                }
                
                if (!foundKey && pathParts.length >= 2) {
                  r2Key = pathParts.slice(-2).join('/');
                } else if (!foundKey) {
                  r2Key = normalizedPath;
                }
              } else {
                r2Key = normalizedPath;
              }
            } else {
              const ext = isLottie ? 'json' : (filename.toLowerCase().endsWith('.png') ? 'png' : 'webp');
              r2Key = `preset/${presetId}.${ext}`;
            }

            // Final safety check: remove any remaining duplicate folders from r2Key
            // Preserve preset_thumb/ and preset/ prefixes
            if (r2Key) {
              const isPresetThumb = r2Key.startsWith('preset_thumb/');
              const isPreset = r2Key.startsWith('preset/');
              const prefix = isPresetThumb ? 'preset_thumb/' : (isPreset ? 'preset/' : '');
              let pathWithoutPrefix = isPresetThumb ? r2Key.replace(/^preset_thumb\//, '') : (isPreset ? r2Key.replace(/^preset\//, '') : r2Key);
              
              let r2KeyParts = pathWithoutPrefix.split('/');
              let changed = true;
              while (changed) {
                changed = false;
                const cleanedParts: string[] = [];
                for (let i = 0; i < r2KeyParts.length; i++) {
                  if (i === 0 || r2KeyParts[i].toLowerCase() !== r2KeyParts[i - 1].toLowerCase()) {
                    cleanedParts.push(r2KeyParts[i]);
                  } else {
                    changed = true;
                  }
                }
                r2KeyParts = cleanedParts;
              }
              r2Key = prefix + r2KeyParts.join('/');
            }

            const fileData = await file.arrayBuffer();
            let contentType = 'image/webp';
            if (filename.toLowerCase().endsWith('.png')) {
              contentType = 'image/png';
            } else if (filename.toLowerCase().endsWith('.json')) {
              contentType = 'application/json';
            }

            const promptData = promptMap.get(index);
            const promptJson = promptData?.promptJson || null;
            const vertexCallInfo = promptData?.vertexCallInfo || { success: false };

            const r2Metadata: any = {
              httpMetadata: {
                contentType,
                cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
              }
            };
            if (promptJson) {
              r2Metadata.customMetadata = {
                prompt_json: promptJson
              };
            }
            await R2_BUCKET.put(r2Key, fileData, r2Metadata);

            const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);

            const existingPreset = await DB.prepare(
              'SELECT id, thumbnail_r2 FROM presets WHERE id = ?'
            ).bind(presetId).first();

            const createdAt = Math.floor(Date.now() / 1000);
            let ext = 'webp';
            if (filename.toLowerCase().endsWith('.png')) {
              ext = 'png';
            } else if (filename.toLowerCase().endsWith('.json')) {
              ext = 'json';
            }

            // DELETE and RECREATE to ensure clean update
            if (existingPreset) {
              // Delete existing preset first
              const deleteResult = await DB.prepare(
                'DELETE FROM presets WHERE id = ?'
              ).bind(presetId).run();
              
              if (!deleteResult.success) {
                throw new Error(`Failed to delete preset ${presetId} in database`);
              }
            }
            
            // Insert new preset (whether it existed or not)
            const insertResult = await DB.prepare(
              'INSERT INTO presets (id, ext, created_at) VALUES (?, ?, ?)'
            ).bind(presetId, ext, createdAt).run();
            
            if (!insertResult.success) {
              throw new Error(`Failed to create preset ${presetId} in database`);
            }
            presetCreated = true;

            results.push({
              filename,
              success: true,
              type: 'preset',
              preset_id: presetId,
              url: publicUrl,
              hasPrompt: !!promptJson,
              vertexError: !promptJson ? (vertexCallInfo.error || 'Vertex AI prompt generation failed') : null
            });
          } catch (fileError) {
            if (!presetCreated && presetId) {
              try {
                const createdAt = Math.floor(Date.now() / 1000);
                const filename = file.name || '';
                let ext = 'webp';
                if (filename.toLowerCase().endsWith('.png')) {
                  ext = 'png';
                } else if (filename.toLowerCase().endsWith('.json')) {
                  ext = 'json';
                }
                await DB.prepare(
                  'INSERT OR IGNORE INTO presets (id, ext, created_at) VALUES (?, ?, ?)'
                ).bind(presetId, ext, createdAt).run();
              } catch (dbError) {
              }
            }
            results.push({
              filename: file.name || 'unknown',
              success: false,
              error: fileError instanceof Error ? fileError.message : String(fileError)
            });
          }
        }

        // Process thumbnail files (without Vertex AI prompts)
        for (const { file, path, parsed } of thumbnailFilesOnly) {
          try {
            const filename = file.name;
            const presetId = parsed.preset_id;
            const fileFormat = parsed.format;
            const isLottie = fileFormat === 'lottie';

            // Extract resolution and format prefix from path
            let resolution = '1x'; // default
            let formatPrefix = 'webp'; // default
            
            // Look for patterns like: webp_1x/, webp_1.5x/, lottie_2x/, lottie_avif_3x/
            // Handle both with and without leading slash (zip paths don't have leading slash)
            const resolutionMatch = path.match(/(?:^|\/)(lottie_avif|lottie|webp)_([\d.]+x)\//i);
            if (resolutionMatch) {
              formatPrefix = resolutionMatch[1].toLowerCase();
              resolution = resolutionMatch[2];
            } else if (isLottie) {
              formatPrefix = 'lottie';
            }

            // Build R2 key preserving original folder structure (e.g., webp_1x/fs_beach-day-selfie_f1_2b.left.webp)
            // Upload to R2 root, not nested under parent folders
            let r2Key: string = '';
            if (path && path.trim()) {
              // Preserve original folder structure from zip, normalize path separators
              let normalizedPath = path.replace(/\\/g, '/');
              // Remove leading/trailing slashes
              normalizedPath = normalizedPath.replace(/^\/+|\/+$/g, '');
              
              // Remove duplicate folder patterns - handle all cases aggressively (case-insensitive)
              // Pattern: folder_name/folder_name/rest -> folder_name/rest
              // Apply multiple passes to catch all duplicates
              let pathParts = normalizedPath.split('/');
              let changed = true;
              while (changed) {
                changed = false;
                const cleanedParts: string[] = [];
                for (let i = 0; i < pathParts.length; i++) {
                  if (i === 0 || pathParts[i].toLowerCase() !== pathParts[i - 1].toLowerCase()) {
                    cleanedParts.push(pathParts[i]);
                  } else {
                    changed = true;
                  }
                }
                pathParts = cleanedParts;
              }
              normalizedPath = pathParts.join('/');
              
              // Remove any parent folders - keep only the actual folder structure at root level
              // Expected folders: preset/, lottie_*x/, lottie_avif_*x/, webp_*x/
              pathParts = normalizedPath.split('/');
              if (pathParts.length > 2) {
                // Find the first part that matches expected folder pattern
                const expectedPatterns = [
                  /^preset$/i,
                  /^(lottie|lottie_avif|webp)_[\d.]+x$/i
                ];
                
                let foundKey = false;
                for (let i = 0; i < pathParts.length - 1; i++) {
                  const folderName = pathParts[i];
                  const matchesPattern = expectedPatterns.some(pattern => pattern.test(folderName));
                  
                  if (matchesPattern) {
                    // Found the actual folder, keep from here to end
                    r2Key = pathParts.slice(i).join('/');
                    // Add preset_thumb/ prefix for thumbnail folders
                    if (/^(lottie|lottie_avif|webp)_[\d.]+x$/i.test(pathParts[i])) {
                      r2Key = `preset_thumb/${r2Key}`;
                    }
                    foundKey = true;
                    break;
                  }
                }
                
                // If no pattern matched, use the last 2 parts (folder + filename)
                if (!foundKey && pathParts.length >= 2) {
                  r2Key = pathParts.slice(-2).join('/');
                  // Add preset_thumb/ prefix if it's a thumbnail folder
                  if (/^(lottie|lottie_avif|webp)_[\d.]+x$/i.test(pathParts[pathParts.length - 2])) {
                    r2Key = `preset_thumb/${r2Key}`;
                  }
                } else if (!foundKey) {
                  r2Key = normalizedPath;
                  // Add preset_thumb/ prefix if it's a thumbnail folder
                  if (/^(lottie|lottie_avif|webp)_[\d.]+x\//i.test(r2Key)) {
                    r2Key = `preset_thumb/${r2Key}`;
                  }
                }
              } else {
                r2Key = normalizedPath;
                // Add preset_thumb/ prefix if it's a thumbnail folder
                if (/^(lottie|lottie_avif|webp)_[\d.]+x\//i.test(r2Key)) {
                  r2Key = `preset_thumb/${r2Key}`;
                }
              }
            } else {
              // Fallback: build from resolution and format
              const ext = fileFormat === 'lottie' ? 'json' : (filename.toLowerCase().endsWith('.png') ? 'png' : 'webp');
              r2Key = `preset_thumb/${formatPrefix}_${resolution}/${presetId}.${ext}`;
            }

            // Final safety check: remove any remaining duplicate folders from r2Key
            // Preserve preset_thumb/ and preset/ prefixes
            if (r2Key) {
              const isPresetThumb = r2Key.startsWith('preset_thumb/');
              const isPreset = r2Key.startsWith('preset/');
              const prefix = isPresetThumb ? 'preset_thumb/' : (isPreset ? 'preset/' : '');
              let pathWithoutPrefix = isPresetThumb ? r2Key.replace(/^preset_thumb\//, '') : (isPreset ? r2Key.replace(/^preset\//, '') : r2Key);
              
              let r2KeyParts = pathWithoutPrefix.split('/');
              let changed = true;
              while (changed) {
                changed = false;
                const cleanedParts: string[] = [];
                for (let i = 0; i < r2KeyParts.length; i++) {
                  if (i === 0 || r2KeyParts[i].toLowerCase() !== r2KeyParts[i - 1].toLowerCase()) {
                    cleanedParts.push(r2KeyParts[i]);
                  } else {
                    changed = true;
                  }
                }
                r2KeyParts = cleanedParts;
              }
              r2Key = prefix + r2KeyParts.join('/');
            }

            // Read file data
            const fileData = await file.arrayBuffer();
            // Determine content type from actual file extension
            let contentType = 'image/webp';
            if (filename.toLowerCase().endsWith('.png')) {
              contentType = 'image/png';
            } else if (filename.toLowerCase().endsWith('.json')) {
              contentType = 'application/json';
            }

            // Upload thumbnail file (no custom metadata for thumbnails)
            await R2_BUCKET.put(r2Key, fileData, {
              httpMetadata: {
                contentType,
                cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
              },
            });

            const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);

            // Check if preset exists (should have been created by preset file processing)
            const presetExists = await DB.prepare(
              'SELECT id FROM presets WHERE id = ?'
            ).bind(presetId).first();

            // Auto-create preset if it doesn't exist (fallback for when preset files weren't detected or failed)
            // DELETE and RECREATE to ensure clean state
            const createdAt = Math.floor(Date.now() / 1000);
            const ext = filename.toLowerCase().endsWith('.json') ? 'json' : 'webp';
            
            if (presetExists) {
              // Delete existing preset first
              const deleteResult = await DB.prepare(
                'DELETE FROM presets WHERE id = ?'
              ).bind(presetId).run();
              
              if (!deleteResult.success) {
                throw new Error(`Failed to delete preset ${presetId} in database`);
              }
            }
            
            // Insert new preset (whether it existed or not)
            const insertResult = await DB.prepare(
              'INSERT INTO presets (id, ext, created_at) VALUES (?, ?, ?)'
            ).bind(presetId, ext, createdAt).run();
            
            if (!insertResult.success) {
              throw new Error(`Failed to create preset ${presetId} in database`);
            }

            // Update preset with thumbnail information in JSON format
            // First get existing thumbnail_r2 data
            const presetWithThumbnails = await DB.prepare(
              'SELECT thumbnail_r2 FROM presets WHERE id = ?'
            ).bind(presetId).first();

            let thumbnailData: Record<string, string> = {};
            if (presetWithThumbnails && presetWithThumbnails.thumbnail_r2) {
              try {
                thumbnailData = JSON.parse(presetWithThumbnails.thumbnail_r2 as string);
              } catch (e) {
                thumbnailData = {};
              }
            }

            // OVERRIDE: Add/update the thumbnail URL for this resolution and format
            // This will override existing thumbnail entry for the same resolution/format
            const thumbnailKey = `${formatPrefix}_${resolution}`;
            thumbnailData[thumbnailKey] = r2Key;

            // Update the thumbnail_r2 field with the JSON data (overrides existing)
            const updateResult = await DB.prepare(
              'UPDATE presets SET thumbnail_r2 = ? WHERE id = ?'
            ).bind(JSON.stringify(thumbnailData), presetId).run();
            
            if (!updateResult.success) {
              throw new Error(`Failed to update thumbnail_r2 for preset ${presetId} in database`);
            }

            results.push({
              filename,
              success: true,
              type: 'thumbnail',
              preset_id: presetId,
              url: publicUrl,
              resolution
            });
          } catch (fileError) {
            results.push({
              filename: file.name || 'unknown',
              success: false,
              error: fileError instanceof Error ? fileError.message : String(fileError)
            });
          }
        }

        const debugEnabled = isDebugEnabled(env);
        const presetsProcessed = results.filter(r => r.type === 'preset').length;
        const thumbnailsProcessed = results.filter(r => r.type === 'thumbnail').length;
        const presetsWithPrompts = results.filter(r => r.type === 'preset' && r.hasPrompt).length;
        
        return jsonResponse({
          data: {
            total: files.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            presets_processed: presetsProcessed,
            presets_with_prompts: presetsWithPrompts,
            thumbnails_processed: thumbnailsProcessed,
            files_needing_prompts: filesNeedingPrompts.length,
            thumbnail_files_only: thumbnailFilesOnly.length,
            results
          },
          status: 'success',
          message: `Processed ${results.filter(r => r.success).length} of ${files.length} files (${presetsProcessed} presets, ${thumbnailsProcessed} thumbnails)`,
          code: 200,
          ...(debugEnabled ? { 
            debug: { 
              filesProcessed: files.length, 
              resultsCount: results.length,
              filesNeedingPromptsCount: filesNeedingPrompts.length,
              thumbnailFilesOnlyCount: thumbnailFilesOnly.length
            } 
          } : {})
        }, 200, request, env);
        }, 10, 1000); // Retry up to 10 times with exponential backoff starting at 1 second
      } catch (error) {
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        console.error(`[Upload Thumbnails] Final error after all retries: ${errorMsg}`);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, retries_exhausted: true, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

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
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('Failed to create multipart upload', 500, { error: errorMsg.substring(0, 200) }, request, env);
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
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('Failed to upload part', 500, { error: errorMsg.substring(0, 200) }, request, env);
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
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('Failed to complete multipart upload', 500, { error: errorMsg.substring(0, 200) }, request, env);
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
        const errorMsg = error instanceof Error ? error.message : String(error);
        return errorResponse('Failed to abort multipart upload', 500, { error: errorMsg.substring(0, 200) }, request, env);
      }
    }

    // ============================================================================
    // SIMPLE UPLOAD API (for files <100MB that still want presigned-style flow)
    // ============================================================================

    // Handle presigned URL generation for thumbnail uploads
    // Endpoint: POST /upload-thumbnails-url
    if (path === '/upload-thumbnails-url' && request.method === 'POST') {
      try {
        const body = await request.json() as { files: Array<{ filename: string; path?: string; contentType?: string; size?: number }> };
        
        if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
          return errorResponse('files array is required', 400, undefined, request, env);
        }

        const requestUrl = new URL(request.url);
        const uploadId = nanoid(16);
        const results: Array<{ filename: string; uploadKey: string; uploadUrl: string; processPath: string; useMultipart: boolean }> = [];
        const CHUNK_SIZE = 95 * 1024 * 1024; // 95MB to stay under 100MB limit

        for (const fileInfo of body.files) {
          const { filename, path: filePath = '', contentType = 'application/octet-stream', size = 0 } = fileInfo;
          
          if (!filename) continue;

          const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const uploadKey = `temp/upload_${uploadId}_${sanitizedFilename}`;
          const processPath = filePath || '';

          // Files >95MB need multipart upload
          if (size > CHUNK_SIZE) {
            results.push({
              filename,
              uploadKey,
              uploadUrl: `${requestUrl.origin}/upload-multipart/create`,
              processPath,
              useMultipart: true
            });
          } else {
            results.push({
              filename,
              uploadKey,
              uploadUrl: `${requestUrl.origin}/r2-upload/${encodeURIComponent(uploadKey)}?contentType=${encodeURIComponent(contentType)}`,
              processPath,
              useMultipart: false
            });
          }
        }

        return successResponse({
          uploadId,
          files: results,
          processEndpoint: `${requestUrl.origin}/process-thumbnails`,
          multipartEndpoints: {
            create: `${requestUrl.origin}/upload-multipart/create`,
            part: `${requestUrl.origin}/upload-multipart/part`,
            complete: `${requestUrl.origin}/upload-multipart/complete`,
            abort: `${requestUrl.origin}/upload-multipart/abort`
          },
          limits: {
            directUploadMax: '95MB',
            partSize: '95MB',
            totalMax: '5GB'
          },
          expiresIn: 3600
        }, 200, request, env);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, { error: errorMsg }, request, env);
      }
    }

    // Handle direct R2 upload for files <100MB
    // Endpoint: PUT /r2-upload/:key
    if (path.startsWith('/r2-upload/') && request.method === 'PUT') {
      try {
        const uploadKey = decodeURIComponent(path.replace('/r2-upload/', ''));
        const url = new URL(request.url);
        const contentType = url.searchParams.get('contentType') || 'application/octet-stream';
        
        if (!uploadKey || !uploadKey.startsWith('temp/')) {
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
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, { error: errorMsg }, request, env);
      }
    }

    // Handle processing of uploaded thumbnails from R2
    // Endpoint: POST /process-thumbnails
    // This processes files that were uploaded via presigned URLs
    if (path === '/process-thumbnails' && request.method === 'POST') {
      try {
        const body = await request.json() as { 
          uploadId: string;
          files: Array<{ uploadKey: string; processPath: string; filename: string }>;
          is_filter_mode?: boolean;
        };
        
        const isFilterMode = body.is_filter_mode === true;
        
        if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('files array is required', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const DB = getD1Database(env);
        const R2_BUCKET = getR2Bucket(env);
        const requestUrl = new URL(request.url);
        const results: any[] = [];

        // Process each uploaded file with retry logic
        for (const fileInfo of body.files) {
          const { uploadKey, processPath, filename } = fileInfo;
          
          // Retry file processing until success
          let processed = false;
          let lastError: Error | null = null;
          const maxRetries = 10;
          
          for (let attempt = 0; attempt < maxRetries && !processed; attempt++) {
            try {
              // Get the file from R2
              const r2Object = await R2_BUCKET.get(uploadKey);
              if (!r2Object) {
                if (attempt === maxRetries - 1) {
                  results.push({
                    filename,
                    success: false,
                    error: 'File not found in R2. Upload may have expired or failed.'
                  });
                } else {
                  await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 30000)));
                  continue;
                }
                break;
              }

              const parsed = parseThumbnailFilename(filename);
              if (!parsed) {
                results.push({
                  filename,
                  success: false,
                  error: 'Invalid filename format. Could not extract preset_id from filename.'
                });
                // Clean up temp file
                await R2_BUCKET.delete(uploadKey);
                break;
              }

              const { preset_id: presetId, format } = parsed;
              const normalizedPath = (processPath || '').replace(/\\/g, '/').toLowerCase();
              
              // Determine if this is a preset image or thumbnail
              const pathParts = normalizedPath.split('/').filter((p: string) => p);
              const isFromPresetFolder = 
                normalizedPath.includes('preset/') || 
                normalizedPath.startsWith('preset/') || 
                normalizedPath.includes('/preset/') ||
                normalizedPath === 'preset' ||
                (pathParts.length > 0 && pathParts[0] === 'preset') ||
                (!normalizedPath && filename.toLowerCase().endsWith('.png'));

              const fileData = await r2Object.arrayBuffer();
              const contentType = r2Object.httpMetadata?.contentType || 'application/octet-stream';

              if (isFromPresetFolder) {
                // This is a preset image - needs Vertex AI prompt generation
                // CRITICAL: Generate prompt FIRST, then upload to R2 with metadata
                const r2Key = `presets/${presetId}.${filename.split('.').pop()}`;
                
                // Upload to temp location first for prompt generation
                const tempR2Key = `temp/${presetId}_${Date.now()}.${filename.split('.').pop()}`;
                await R2_BUCKET.put(tempR2Key, fileData, {
                  httpMetadata: {
                    contentType,
                    cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                  },
                });

                const tempPublicUrl = getR2PublicUrl(env, tempR2Key, requestUrl.origin);

                // Generate Vertex AI prompt with retry - MUST succeed before final upload
                const promptResult = await generateVertexPromptWithRetry(tempPublicUrl, env, isFilterMode, null);
                
                // Clean up temp file
                try {
                  await R2_BUCKET.delete(tempR2Key);
                } catch (e) {
                  // Ignore cleanup errors
                }

                // CRITICAL: Only proceed if prompt generation succeeded
                if (!promptResult.success || !promptResult.prompt) {
                  if (attempt === maxRetries - 1) {
                    results.push({
                      filename,
                      success: false,
                      error: `Vertex AI prompt generation failed after retries: ${promptResult.error || 'Unknown error'}`,
                      type: 'preset',
                      preset_id: presetId,
                      vertex_info: { success: false, error: promptResult.error || 'Unknown error', debug: promptResult.debug }
                    });
                  } else {
                    await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 30000)));
                    continue;
                  }
                  break;
                }

                const promptJson = JSON.stringify(promptResult.prompt);
                const vertexCallInfo = { success: true, promptKeys: Object.keys(promptResult.prompt) };

                // Upload to final location WITH metadata (promptJson is guaranteed to exist)
                await R2_BUCKET.put(r2Key, fileData, {
                  httpMetadata: {
                    contentType,
                    cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                  },
                  customMetadata: {
                    prompt_json: promptJson
                  }
                });

                const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);

                // Upsert preset in database
                const existingPreset = await DB.prepare('SELECT preset_id FROM presets WHERE preset_id = ?').bind(presetId).first();
                
                if (existingPreset) {
                  await DB.prepare(`
                    UPDATE presets SET preset_url = ?, prompt_json = ?, updated_at = datetime('now') WHERE preset_id = ?
                  `).bind(publicUrl, promptJson, presetId).run();
                } else {
                  await DB.prepare(`
                    INSERT INTO presets (preset_id, preset_url, prompt_json, created_at, updated_at) 
                    VALUES (?, ?, ?, datetime('now'), datetime('now'))
                  `).bind(presetId, publicUrl, promptJson).run();
                }

                results.push({
                  filename,
                  success: true,
                  type: 'preset',
                  preset_id: presetId,
                  url: publicUrl,
                  hasPrompt: !!promptJson,
                  vertex_info: vertexCallInfo
                });
              } else {
                // This is a thumbnail file
                const folderMatch = normalizedPath.match(/(webp|lottie|lottie_avif)_([\d.]+x)/);
                let folderType = 'webp';
                let resolution = '1x';

                if (folderMatch) {
                  folderType = folderMatch[1];
                  resolution = folderMatch[2];
                }

                const ext = filename.split('.').pop() || (format === 'lottie' ? 'json' : 'webp');
                const thumbnailFolder = `${folderType}_${resolution}`;
                const thumbnailR2Key = `preset_thumb/${thumbnailFolder}/${presetId}.${ext}`;

                await R2_BUCKET.put(thumbnailR2Key, fileData, {
                  httpMetadata: {
                    contentType,
                    cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
                  },
                });

                const thumbnailUrl = getR2PublicUrl(env, thumbnailR2Key, requestUrl.origin);

                // Update preset's thumbnail_r2 JSON
                const existingPreset = await DB.prepare('SELECT preset_id, thumbnail_r2 FROM presets WHERE preset_id = ?').bind(presetId).first() as { preset_id: string; thumbnail_r2: string | null } | null;

                if (existingPreset) {
                  let thumbnailR2: Record<string, string> = {};
                  try {
                    thumbnailR2 = existingPreset.thumbnail_r2 ? JSON.parse(existingPreset.thumbnail_r2) : {};
                  } catch {}
                  thumbnailR2[thumbnailFolder] = thumbnailR2Key;

                  await DB.prepare(`
                    UPDATE presets SET thumbnail_r2 = ?, updated_at = datetime('now') WHERE preset_id = ?
                  `).bind(JSON.stringify(thumbnailR2), presetId).run();
                }

                results.push({
                  filename,
                  success: true,
                  type: 'thumbnail',
                  preset_id: presetId,
                  url: thumbnailUrl,
                  hasPrompt: false,
                  metadata: { format: folderType, resolution }
                });
              }

              // Clean up temp file
              await R2_BUCKET.delete(uploadKey);
              processed = true;
            } catch (fileError) {
              lastError = fileError instanceof Error ? fileError : new Error(String(fileError));
              if (attempt === maxRetries - 1) {
                results.push({
                  filename,
                  success: false,
                  error: lastError.message.substring(0, 200)
                });
              } else {
                await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 30000)));
              }
            }
          }
        }

        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        const debugEnabled = isDebugEnabled(env);
        return successResponse({
          total: results.length,
          successful,
          failed,
          results
        }, 200, request, env);
      } catch (error) {
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path } : undefined, request, env);
      }
    }

    // Handle single thumbnail file processing - for client-side sequential uploads
    // Endpoint: POST /process-thumbnail-file
    // For presets: Accepts R2 key/URL, generates prompt JSON only (file must be uploaded first)
    // For thumbnails: Accepts file upload, stores without prompt generation
    if (path === '/process-thumbnail-file' && request.method === 'POST') {
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
            
            // Get public URL for Vertex AI
            const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
            
            // Generate Vertex AI prompt with retry
            const isFilterMode = body.is_filter_mode === true;
            const customPromptText = body.custom_prompt_text || null;
            const promptResult = await generateVertexPromptWithRetry(publicUrl, env, isFilterMode, customPromptText);
            
            // CRITICAL: Only proceed if prompt generation succeeded
            if (!promptResult.success || !promptResult.prompt) {
              return errorResponse(
                `Vertex AI prompt generation failed: ${promptResult.error || 'Unknown error'}`,
                500,
                undefined,
                request,
                env
              );
            }
            
            const promptJson = JSON.stringify(promptResult.prompt);
            
            // Update R2 object metadata with prompt JSON
            const fileData = await R2_BUCKET.get(r2Key);
            if (!fileData) {
              return errorResponse(`Failed to read file from R2: ${r2Key}`, 500, undefined, request, env);
            }
            
            await R2_BUCKET.put(r2Key, fileData.body, {
              httpMetadata: fileData.httpMetadata,
              customMetadata: {
                ...fileData.customMetadata,
                prompt_json: promptJson
              }
            });
            
            // Update database preset record
            const ext = r2Key.split('.').pop() || 'png';
            const existingPreset = await DB.prepare('SELECT id FROM presets WHERE id = ?').bind(presetId).first();
            
            if (existingPreset) {
              await DB.prepare('UPDATE presets SET ext = ? WHERE id = ?').bind(ext, presetId).run();
            } else {
              const createdAt = Math.floor(Date.now() / 1000);
              await DB.prepare('INSERT INTO presets (id, ext, created_at) VALUES (?, ?, ?)').bind(presetId, ext, createdAt).run();
            }
            
            return jsonResponse({
              data: {
                filename: body.filename || r2Key.split('/').pop() || '',
                success: true,
                type: 'preset',
                preset_id: presetId,
                url: publicUrl,
                hasPrompt: true
              },
              status: 'success',
              message: 'Preset prompt generated successfully',
              code: 200
            }, 200, request, env);
          }
        }
        
        // For file uploads: handle both preset and thumbnail files
        let file: File;
        let filePath: string = '';
        let isFilterMode: boolean = false;
        let customPromptText: string | null = null;
        
        if (contentType.toLowerCase().includes('multipart/form-data')) {
          const formData = await request.formData();
          const fileEntry = formData.get('file');
          if (!fileEntry || typeof fileEntry === 'string') {
            return errorResponse('File is required', 400, undefined, request, env);
          }
          file = fileEntry as File;
          filePath = (formData.get('path') as string) || '';
          isFilterMode = formData.get('is_filter_mode') === 'true';
          customPromptText = formData.get('custom_prompt_text') as string | null;
        } else {
          return errorResponse('Content-Type must be multipart/form-data for file uploads or application/json for preset prompt generation', 400, undefined, request, env);
        }
        
        const filename = file.name || '';
        const parsed = parseThumbnailFilename(filename);
        
        if (!parsed) {
          return errorResponse('Invalid filename format. Could not extract preset_id from filename.', 400, undefined, request, env);
        }
        
        const { preset_id: presetId, format } = parsed;
        const normalizedPath = (filePath || '').replace(/\\/g, '/').toLowerCase();
        const pathParts = normalizedPath.split('/').filter((p: string) => p);
        
        // Determine if this is a preset image or thumbnail
        const isFromPresetFolder = 
          normalizedPath.includes('preset/') || 
          normalizedPath.startsWith('preset/') || 
          normalizedPath.includes('/preset/') ||
          normalizedPath === 'preset' ||
          (pathParts.length > 0 && pathParts[0] === 'preset') ||
          (!normalizedPath && filename.toLowerCase().endsWith('.png'));
        
        const fileData = await file.arrayBuffer();
        let contentTypeHeader = 'application/octet-stream';
        if (filename.toLowerCase().endsWith('.png')) {
          contentTypeHeader = 'image/png';
        } else if (filename.toLowerCase().endsWith('.webp')) {
          contentTypeHeader = 'image/webp';
        } else if (filename.toLowerCase().endsWith('.json')) {
          contentTypeHeader = 'application/json';
        }
        
        if (isFromPresetFolder) {
          // Preset file: upload first, return immediately, generate prompt in background
          let r2Key: string;
          if (filePath && filePath.trim()) {
            let normalizedPath = filePath.replace(/\\/g, '/');
            normalizedPath = normalizedPath.replace(/^\/+|\/+$/g, '');
            normalizedPath = normalizedPath.replace(/^presets?\//i, 'preset/');
            normalizedPath = normalizedPath.replace(/^preset\/preset(\/|$)/, 'preset$1');
            r2Key = normalizedPath;
          } else {
            const ext = filename.toLowerCase().endsWith('.png') ? 'png' : (filename.toLowerCase().endsWith('.json') ? 'json' : 'webp');
            r2Key = `preset/${presetId}.${ext}`;
          }
          
          // Upload to final location (fast operation)
          await R2_BUCKET.put(r2Key, fileData, {
            httpMetadata: {
              contentType: contentTypeHeader,
              cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
            },
          });
          
          const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
          
          // Update database (fast operation)
          const ext = filename.toLowerCase().endsWith('.png') ? 'png' : (filename.toLowerCase().endsWith('.json') ? 'json' : 'webp');
          const createdAt = Math.floor(Date.now() / 1000);
          const existingPreset = await DB.prepare('SELECT id FROM presets WHERE id = ?').bind(presetId).first();
          
          if (existingPreset) {
            const oldR2Key = `preset/${presetId}.${(existingPreset as any).ext || ext}`;
            if (oldR2Key !== r2Key) {
              try { await R2_BUCKET.delete(oldR2Key); } catch (e) { /* ignore */ }
            }
            await DB.prepare('UPDATE presets SET ext = ? WHERE id = ?').bind(ext, presetId).run();
          } else {
            await DB.prepare('INSERT INTO presets (id, ext, created_at) VALUES (?, ?, ?)').bind(presetId, ext, createdAt).run();
          }
          
          // Generate prompt in background (non-blocking)
          const promptTask = (async () => {
            try {
              const promptResult = await generateVertexPromptWithRetry(publicUrl, env, isFilterMode, customPromptText);
              
              if (promptResult.success && promptResult.prompt) {
                const promptJson = JSON.stringify(promptResult.prompt);
                const existingFile = await R2_BUCKET.get(r2Key);
                if (existingFile) {
                  await R2_BUCKET.put(r2Key, existingFile.body, {
                    httpMetadata: existingFile.httpMetadata,
                    customMetadata: {
                      ...existingFile.customMetadata,
                      prompt_json: promptJson
                    }
                  });
                }
              } else {
                console.warn(`[Preset Prompt] Failed to generate prompt for ${r2Key}: ${promptResult.error || 'Unknown error'}`);
              }
            } catch (error) {
              console.error(`[Preset Prompt] Error generating prompt for ${r2Key}:`, error);
            }
          })();
          
          // Use waitUntil to ensure prompt generation completes even after response is sent
          if (ctx && ctx.waitUntil) {
            ctx.waitUntil(promptTask);
          } else {
            // Fallback: fire and forget (prompt will still generate but may be interrupted)
            promptTask.catch(err => console.error('[Preset Prompt] Background task error:', err));
          }
          
          // Return success immediately (file is uploaded, prompt will be generated in background)
          return jsonResponse({
            data: {
              filename,
              success: true,
              type: 'preset',
              preset_id: presetId,
              url: publicUrl,
              hasPrompt: false // Will be updated when prompt generation completes
            },
            status: 'success',
            message: 'Preset uploaded successfully, prompt generation in progress',
            code: 200
          }, 200, request, env);
        } else {
          // Thumbnail file: upload without prompt generation
          const folderMatch = normalizedPath.match(/(webp|lottie|lottie_avif)_([\d.]+x)/);
          let folderType = 'webp';
          let resolution = '1x';
          
          if (folderMatch) {
            folderType = folderMatch[1];
            resolution = folderMatch[2];
          }
          
          const ext = filename.split('.').pop() || (format === 'lottie' ? 'json' : 'webp');
          const thumbnailFolder = `${folderType}_${resolution}`;
          const thumbnailR2Key = `preset_thumb/${thumbnailFolder}/${presetId}.${ext}`;
          
          await R2_BUCKET.put(thumbnailR2Key, fileData, {
            httpMetadata: {
              contentType: contentTypeHeader,
              cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
            },
          });
          
          const thumbnailUrl = getR2PublicUrl(env, thumbnailR2Key, requestUrl.origin);
          
          // Update preset's thumbnail_r2 JSON
          const existingPreset = await DB.prepare('SELECT id, thumbnail_r2 FROM presets WHERE id = ?').bind(presetId).first() as { id: string; thumbnail_r2: string | null } | null;
          
          if (existingPreset) {
            let thumbnailR2: Record<string, string> = {};
            try {
              thumbnailR2 = existingPreset.thumbnail_r2 ? JSON.parse(existingPreset.thumbnail_r2) : {};
            } catch {}
            thumbnailR2[thumbnailFolder] = thumbnailR2Key;
            
            await DB.prepare('UPDATE presets SET thumbnail_r2 = ? WHERE id = ?').bind(JSON.stringify(thumbnailR2), presetId).run();
          }
          
          return jsonResponse({
            data: {
              filename,
              success: true,
              type: 'thumbnail',
              preset_id: presetId,
              url: thumbnailUrl,
              hasPrompt: false,
              metadata: { format: folderType, resolution }
            },
            status: 'success',
            message: 'Thumbnail processed successfully',
            code: 200
          }, 200, request, env);
        }
      }, 10);
    }

    // Handle profile creation
    if (path === '/profiles' && request.method === 'POST') {
      try {
        const body = await request.json() as Partial<Profile & { userID?: string; id?: string; device_id?: string }>;
        const deviceId = body.device_id || request.headers.get('x-device-id') || null;
        const profileId = body.userID || body.id || nanoid(16);

        const tableCheck = await DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='profiles'"
        ).first();
        
        if (!tableCheck) {
          console.error('ERROR: profiles table does not exist in database!');
          console.error('Database schema needs to be initialized. Run: wrangler d1 execute faceswap-db --remote --file=schema.sql');
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { path } : undefined, request, env);
        }

        if (body.userID || body.id) {
          const existingProfile = await DB.prepare(
            'SELECT id FROM profiles WHERE id = ?'
          ).bind(profileId).first();
          
          if (existingProfile) {
            const debugEnabled = isDebugEnabled(env);
            return errorResponse('Profile already exists', 409, debugEnabled ? { profileId, path } : undefined, request, env);
          }
        }

        const createdAt = Math.floor(Date.now() / 1000);
        const updatedAt = Math.floor(Date.now() / 1000);
        
        // Convert preferences to JSON string if it's an object
        const preferencesString = body.preferences 
          ? (typeof body.preferences === 'string' ? body.preferences : JSON.stringify(body.preferences))
          : null;

        const result = await DB.prepare(
          'INSERT INTO profiles (id, device_id, name, email, avatar_url, preferences, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          profileId,
          deviceId,
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
          ...(debugEnabled ? { debug: { profileId, deviceId } } : {})
        }, 200, request, env);
      } catch (error) {
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Handle profile retrieval
    if (path.startsWith('/profiles/') && request.method === 'GET') {
      try {
        const profileId = extractPathId(path, '/profiles/');
        if (!profileId) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }
        const result = await DB.prepare(
          'SELECT id, device_id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles WHERE id = ?'
        ).bind(profileId).first();

        if (!result) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId, path } : undefined, request, env);
        }

        const profile: Profile = {
          id: (result as any).id,
          device_id: (result as any).device_id || undefined,
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
          ...(debugEnabled ? { debug: { profileId } } : {})
        }, 200, request, env);
      } catch (error) {
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
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
          'SELECT id, device_id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles WHERE id = ?'
        ).bind(profileId).first();

        if (!updatedResult) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found after update', 404, debugEnabled ? { profileId, path } : undefined, request, env);
        }

        const profile: Profile = {
          id: profileId,
          device_id: (updatedResult as any).device_id || undefined,
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
          'SELECT id, device_id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles ORDER BY created_at DESC'
        ).all();

        const profiles: Profile[] = results.results?.map((row: any) => ({
          id: row.id,
          device_id: row.device_id || undefined,
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
        const presetUrl = buildPresetUrl(storedKey, env, requestUrl.origin);
        
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
          const fullUrl = buildPresetUrl(storedKey, env, requestUrl.origin);
          
          // Reconstruct thumbnail URL from thumbnail_r2 if available
          let thumbnailUrl: string | null = null;
          let thumbnailFormat: string | null = null;
          let thumbnailResolution: string | null = null;
          if (row.thumbnail_r2) {
            thumbnailUrl = getR2PublicUrl(env, row.thumbnail_r2, requestUrl.origin);
            // Extract format and resolution from R2 key (e.g., "webp_1x/face-swap/portrait.webp")
            const r2KeyParts = row.thumbnail_r2.split('/');
            if (r2KeyParts.length > 0) {
              const prefix = r2KeyParts[0]; // e.g., "webp_1x" or "lottie_2x"
              const formatMatch = prefix.match(/^(webp|lottie)/i);
              const resolutionMatch = prefix.match(/([\d.]+x)/i);
              thumbnailFormat = formatMatch ? formatMatch[1].toLowerCase() : null;
              thumbnailResolution = resolutionMatch ? resolutionMatch[1] : null;
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
          
          return {
            id: row.id || '',
            preset_url: fullUrl,
            image_url: fullUrl, // Alias for backward compatibility
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
      try {
        // Check for required profile_id query parameter
        const url = new URL(request.url);
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
            fullUrl = buildSelfieUrl(storedKey, env, requestUrl.origin);
          } else if (hasUrl && row.selfie_url) {
            const storedKey = row.selfie_url || '';
            if (storedKey && !storedKey.startsWith('http://') && !storedKey.startsWith('https://')) {
              fullUrl = buildSelfieUrl(storedKey, env, requestUrl.origin);
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
        // Return empty array instead of error to prevent UI breaking
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { selfies: [] },
          status: 'success',
          message: 'Selfies retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200), count: 0 } } : {})
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
      try {
        const DB = getD1Database(env);
        
        let query = `SELECT
          id,
          thumbnail_r2,
          created_at
        FROM presets
        WHERE thumbnail_r2 IS NOT NULL AND thumbnail_r2 != '{}'`;
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
          const response: any = {};
          
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
          
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { thumbnails },
          status: 'success',
          message: 'Thumbnails retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { count: thumbnails.length } } : {})
        }, 200, request, env);
      } catch (error) {
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    if (path === '/results' && request.method === 'GET') {
      try {
        const url = new URL(request.url);
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
          const fullUrl = buildResultUrl(storedKey, env, requestUrl.origin);
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
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { results: [] },
          status: 'success',
          message: 'Results retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { error: error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200), count: 0 } } : {})
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
        const errorMessage = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: null,
          status: 'error',
          message: '',
          code: 500,
          ...(debugEnabled ? { debug: {
            resultId: path.replace('/results/', ''),
            error: errorMessage,
            path,
            ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {})
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

      try {
        const body: FaceSwapRequest = await request.json();

        const envError = validateEnv(env, 'vertex');
        if (envError) return errorResponse('', 500, undefined, request, env);

        const requestError = validateRequest(body);
        if (requestError) return errorResponse('', 400, undefined, request, env);

        const hasSelfieIds = Array.isArray(body.selfie_ids) && body.selfie_ids.length > 0;
        const hasSelfieUrls = Array.isArray(body.selfie_image_urls) && body.selfie_image_urls.length > 0;
        
        if (!hasSelfieIds && !hasSelfieUrls) {
          return errorResponse('', 400, undefined, request, env);
        }

        const hasPresetId = body.preset_image_id && body.preset_image_id.trim() !== '';
        const hasPresetUrl = body.preset_image_url && body.preset_image_url.trim() !== '';

        if (!hasPresetId && !hasPresetUrl) {
          return errorResponse('', 400, undefined, request, env);
        }
        
        if (hasSelfieUrls && body.selfie_image_urls) {
          for (const url of body.selfie_image_urls) {
            if (!validateImageUrl(url, env)) {
              return errorResponse('', 400, undefined, request, env);
            }
          }
        }
        
        if (hasPresetUrl && body.preset_image_url) {
          if (!validateImageUrl(body.preset_image_url, env)) {
            return errorResponse('', 400, undefined, request, env);
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
        const results = await Promise.all(queries);

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
          const storedKey = reconstructR2Key((presetResult as any).id, (presetResult as any).ext, 'preset');
          targetUrl = buildPresetUrl(storedKey, env, requestUrl.origin);
          presetName = 'Unnamed Preset';
          presetImageId = body.preset_image_id || null;
        } else if (hasPresetUrl) {
          targetUrl = body.preset_image_url!;
          presetName = 'Result Preset';
          presetImageId = null;
        } else {
          // This should never happen due to earlier validation, but TypeScript needs this
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
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
                  return errorResponse(
                    `Selfie with ID ${body.selfie_ids[i]} has action "${selfieActionRaw || 'null'}" but request requires action "4k"`,
                    400,
                    debugEnabled ? { selfieId: body.selfie_ids[i], selfieAction: selfieActionRaw, requestedAction, path } : undefined,
                    request,
                    env
                  );
                }
              } else if (selfieAction !== requestedAction) {
                return errorResponse(
                  `Selfie with ID ${body.selfie_ids[i]} has action "${selfieActionRaw || 'null'}" but request requires action "${requestedAction}"`,
                  400,
                  debugEnabled ? { selfieId: body.selfie_ids[i], selfieAction: selfieActionRaw, requestedAction, path } : undefined,
                  request,
                  env
                );
              }
            }
            
            const storedKey = reconstructR2Key((selfieResult as any).id, (selfieResult as any).ext, 'selfie');
            const fullUrl = buildSelfieUrl(storedKey, env, requestUrl.origin);
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
          return errorResponse('', 400, debugEnabled ? { hasSelfieIds, hasSelfieUrls, selfieIdsCount: body.selfie_ids?.length || 0, selfieUrlsCount: body.selfie_image_urls?.length || 0, path } : undefined, request, env);
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
            return errorResponse('', 400, undefined, request, env);
          }
        }
        const augmentedPromptPayload = augmentVertexPrompt(
          storedPromptPayload,
          body.additional_prompt
        );
        const vertexPromptPayload = augmentedPromptPayload;

        // Extract aspect ratio from request body, default to "3:4" if not provided
        const aspectRatio = (body.aspect_ratio as string) || ASPECT_RATIO_CONFIG.DEFAULT;
        // Validate aspect ratio is one of the supported values for Vertex AI
        // Supported: "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
        const supportedRatios = ASPECT_RATIO_CONFIG.SUPPORTED;
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
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

            const vertexDebugFailure = compact({
              prompt: vertexPromptPayload,
              response: sanitizedVertexFailure || (faceSwapResult as any).VertexResponse,
              curlCommand: (faceSwapResult as any).CurlCommand,
              fullError: errorDetails,
              parsedError: (faceSwapResult as any).ParsedError,
              fullResponse: (faceSwapResult as any).FullResponse,
              error: (faceSwapResult as any).Error,
            });

            const debugPayload = debugEnabled ? compact({
              request: requestDebug,
              provider: buildProviderDebug(faceSwapResult),
              vertex: vertexDebugFailure,
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
          const debugPayload = debugEnabled ? compact({
            request: requestDebug,
            provider: buildProviderDebug(faceSwapResult),
            vertex: mergeVertexDebug(faceSwapResult, vertexPromptPayload),
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

        const providerDebug = debugEnabled ? buildProviderDebug(faceSwapResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(faceSwapResult, vertexPromptPayload) : undefined;
        const visionDebug = debugEnabled ? buildVisionDebug(safetyDebug) : undefined;
        const storageDebugPayload = debugEnabled ? compact(storageDebug as unknown as Record<string, any>) : undefined;
        const databaseDebugPayload = debugEnabled ? compact(databaseDebug as unknown as Record<string, any>) : undefined;
        const debugPayload = debugEnabled ? compact({
          request: requestDebug,
          provider: providerDebug,
          vertex: vertexDebug,
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
        console.error('Unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Handle background endpoint
    if (path === '/background' && request.method === 'POST') {
      try {
        const body: BackgroundRequest = await request.json();

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

          const aspectRatio = (body.aspect_ratio as string) || ASPECT_RATIO_CONFIG.DEFAULT;
          const supportedRatios = ASPECT_RATIO_CONFIG.SUPPORTED;
          const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
          const modelParam = body.model;

          const backgroundGenResult = await generateBackgroundFromPrompt(body.custom_prompt!, env, validAspectRatio, modelParam);

          if (!backgroundGenResult.Success || !backgroundGenResult.ResultImageUrl) {
            const failureCode = backgroundGenResult.StatusCode || 500;
            const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
            const debugEnabled = isDebugEnabled(env);
            const debugPayload = debugEnabled ? compact({
              customPrompt: body.custom_prompt,
              provider: buildProviderDebug(backgroundGenResult),
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
          targetUrl = buildPresetUrl(storedKey, env, requestUrl.origin);
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
          selfieUrl = buildSelfieUrl(storedKey, env, requestUrl.origin);
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

        const aspectRatio = (body.aspect_ratio as string) || ASPECT_RATIO_CONFIG.DEFAULT;
        const supportedRatios = ASPECT_RATIO_CONFIG.SUPPORTED;
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
        const modelParam = body.model;

        const mergeResult = await callNanoBananaMerge(mergePrompt, selfieUrl, targetUrl, env, validAspectRatio, modelParam);

        if (!mergeResult.Success || !mergeResult.ResultImageUrl) {
          const failureCode = mergeResult.StatusCode || 500;
          // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const debugEnabled = isDebugEnabled(env);
          const debugPayload = debugEnabled ? compact({
            request: requestDebug,
            provider: buildProviderDebug(mergeResult),
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
        const providerDebug = debugEnabled ? buildProviderDebug(mergeResult, resultUrl) : undefined;
        const visionDebug = debugEnabled ? buildVisionDebug(safetyDebug) : undefined;
        const storageDebugPayload = debugEnabled ? compact(storageDebug as unknown as Record<string, any>) : undefined;
        const databaseDebugPayload = debugEnabled ? compact(databaseDebug as unknown as Record<string, any>) : undefined;
        const debugPayload = debugEnabled ? compact({
          request: requestDebug,
          provider: providerDebug,
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
        console.error('Unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Handle upscaler4k endpoint
    if (path === '/upscaler4k' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string };
        
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
          const providerDebug = debugEnabled ? buildProviderDebug(upscalerResult) : undefined;
          const vertexDebug = debugEnabled ? buildVertexDebug(upscalerResult) : undefined;
          const debugPayload = debugEnabled ? compact({
            provider: providerDebug,
            vertex: vertexDebug,
            rawError: upscalerResult.Error,
            fullResponse: (upscalerResult as any).FullResponse,
            wavespeedDebug: (upscalerResult as any).Debug,
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
        const providerDebug = debugEnabled ? buildProviderDebug(upscalerResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? buildVertexDebug(upscalerResult) : undefined;
        const debugPayload = debugEnabled ? compact({
          provider: providerDebug,
          vertex: vertexDebug,
          wavespeedDebug: (upscalerResult as any).Debug,
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
        console.error('Upscaler4K unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Handle enhance endpoint
    if (path === '/enhance' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number };

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

        const validAspectRatio = await resolveAspectRatioForNonFaceswap(body.aspect_ratio, body.image_url, env);
        const modelParam = body.model;

        const enhancedResult = await callNanoBanana(
          'Enhance this image with better lighting, contrast, and sharpness. Improve overall image quality while maintaining natural appearance.',
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
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(enhancedResult),
            vertex: mergeVertexDebug(enhancedResult, undefined),
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
        const providerDebug = debugEnabled ? buildProviderDebug(enhancedResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(enhancedResult, undefined) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: enhancedResult.Message || 'Image enhancement completed',
          code: 200,
          ...(debugEnabled && providerDebug && vertexDebug ? { debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
          }) } : {}),
        });
      } catch (error) {
        console.error('Enhance unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Handle beauty endpoint
    if (path === '/beauty' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number };

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

        const validAspectRatio = await resolveAspectRatioForNonFaceswap(body.aspect_ratio, body.image_url, env);
        const modelParam = body.model;

        const beautyResult = await callNanoBanana(
          IMAGE_PROCESSING_PROMPTS.ENHANCE,
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
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(beautyResult),
            vertex: mergeVertexDebug(beautyResult, undefined),
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
        const providerDebug = debugEnabled ? buildProviderDebug(beautyResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(beautyResult, undefined) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: beautyResult.Message || 'Image beautification completed',
          code: 200,
          ...(debugEnabled && providerDebug && vertexDebug ? { debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
          }) } : {}),
        });
      } catch (error) {
        console.error('Beauty unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
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

      try {
        const body = await request.json() as { 
          preset_image_id?: string;
          preset_image_url?: string; 
          selfie_id?: string;
          selfie_image_url?: string;
          profile_id: string;
          aspect_ratio?: string; 
          model?: string | number;
          additional_prompt?: string;
        };

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

        // Read prompt_json from R2 metadata or cache
        let storedPromptPayload: any = null;
        if (r2Key) {
          const promptCacheKV = env.PROMPT_CACHE_KV;
          const cacheKey = `prompt:${r2Key}`;

          if (promptCacheKV) {
            try {
              const cachedPrompt = await getCachedAsync(cacheKey, async () =>
                await promptCacheKV.get(cacheKey)
              );
              if (cachedPrompt) {
                try {
                  storedPromptPayload = JSON.parse(cachedPrompt);
                } catch {
                  // Invalid JSON in cache, continue to R2
                }
              }
            } catch {
              // Cache read failed, continue to R2
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
            } catch {
              // R2 metadata read failed
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

        const validAspectRatio = await resolveAspectRatioForNonFaceswap(body.aspect_ratio, selfieImageUrl, env);
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
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(filterResult),
            vertex: mergeVertexDebug(filterResult, undefined),
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

        const providerDebug = debugEnabled ? buildProviderDebug(filterResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(filterResult, undefined) : undefined;

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
          ...(debugEnabled && providerDebug && vertexDebug ? { debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
            database: savedResultId ? { saved: true, resultId: savedResultId } : { saved: false },
          }) } : {}),
        });
      } catch (error) {
        console.error('Filter unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('Internal server error', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Handle restore endpoint
    if (path === '/restore' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number };

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

        const validAspectRatio = await resolveAspectRatioForNonFaceswap(body.aspect_ratio, body.image_url, env);
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
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(restoredResult),
            vertex: mergeVertexDebug(restoredResult, undefined),
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
        const providerDebug = debugEnabled ? buildProviderDebug(restoredResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(restoredResult, undefined) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: restoredResult.Message || 'Image restoration completed',
          code: 200,
          ...(debugEnabled && providerDebug && vertexDebug ? { debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
          }) } : {}),
        });
      } catch (error) {
        console.error('Restore unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    // Handle aging endpoint
    if (path === '/aging' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; age_years?: number; profile_id?: string; aspect_ratio?: string; model?: string | number };

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

        const validAspectRatio = await resolveAspectRatioForNonFaceswap(body.aspect_ratio, body.image_url, env);
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
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(agingResult),
            vertex: mergeVertexDebug(agingResult, undefined),
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
        const providerDebug = debugEnabled ? buildProviderDebug(agingResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(agingResult, undefined) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: agingResult.Message || 'Aging transformation completed',
          code: 200,
          ...(debugEnabled && providerDebug && vertexDebug ? { debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
          }) } : {}),
        });
      } catch (error) {
        console.error('Aging unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
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
