/// <reference types="@cloudflare/workers-types" />

import { customAlphabet } from 'nanoid';
const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_', 21);
import JSZip from 'jszip';
import type { Env, FaceSwapRequest, FaceSwapResponse, Profile, BackgroundRequest } from './types';
import { CORS_HEADERS, getCorsHeaders, jsonResponse, errorResponse, successResponse, validateImageUrl, fetchWithTimeout, getImageDimensions, getClosestAspectRatio, resolveAspectRatio, promisePoolWithConcurrency, normalizePresetId } from './utils';
import { callFaceSwap, callNanoBanana, callNanoBananaMerge, checkSafeSearch, checkImageSafetyWithFlashLite, generateVertexPrompt, callUpscaler4k, generateBackgroundFromPrompt } from './services';
import { validateEnv, validateRequest } from './validators';
import { VERTEX_AI_PROMPTS, IMAGE_PROCESSING_PROMPTS, ASPECT_RATIO_CONFIG, CACHE_CONFIG, TIMEOUT_CONFIG } from './config';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const DEFAULT_R2_BUCKET_NAME = '';
const PROTECTED_MOBILE_APIS = ['/upload-url', '/faceswap', '/background', '/enhance', '/beauty', '/filter', '/restore', '/aging', '/upscaler4k', '/profiles'];

const trimTrailingSlash = (v: string) => v.replace(/\/+$/, '');
const constantTimeCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

const compact = <T extends Record<string, any>>(input: T): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const k of Object.keys(input)) {
    if (input[k] !== undefined && input[k] !== null) out[k] = input[k];
  }
  return out;
};

const isDebugEnabled = (env: Env): boolean => env.ENABLE_DEBUG_RESPONSE === 'true';

const checkRateLimit = async (env: Env, request: Request, path: string): Promise<boolean> => {
  if (!env.RATE_LIMITER) return true;
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';
  return (await env.RATE_LIMITER.limit({ key: `${ip}:${path}` })).success;
};

const checkApiKey = (env: Env, request: Request): boolean => {
  if (env.ENABLE_MOBILE_API_KEY_AUTH !== 'true' && env.ENABLE_MOBILE_API_KEY_AUTH !== true) return true;
  const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  return !!(apiKey && env.MOBILE_API_KEY && constantTimeCompare(apiKey, env.MOBILE_API_KEY));
};

const checkRequestSize = (request: Request, maxSizeBytes: number): { valid: boolean; error?: string } => {
  const cl = request.headers.get('Content-Length');
  if (cl) {
    const size = parseInt(cl, 10);
    if (isNaN(size) || size > maxSizeBytes) return { valid: false, error: `Request body too large. Maximum size: ${maxSizeBytes / 1024 / 1024}MB` };
  }
  return { valid: true };
};

const logCriticalError = (endpoint: string, error: unknown, request: Request, env: Env, context?: Record<string, any>): void => {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  console.error(`[CRITICAL ERROR] ${endpoint}:`, JSON.stringify({
    endpoint, error: errorMsg, stack: errorStack?.substring(0, 1000),
    request: { method: request.method, url: request.url, path: new URL(request.url).pathname, requestId: request.headers.get('cf-ray') || 'unknown' },
    ...(context || {})
  }, null, 2));
};

const getR2Bucket = (env: Env): R2Bucket => {
  const name = env.R2_BUCKET_BINDING || env.R2_BUCKET_NAME || DEFAULT_R2_BUCKET_NAME;
  const bucket = (env as any)[name] as R2Bucket;
  if (!bucket) throw new Error(`R2 bucket binding '${name}' not found`);
  return bucket;
};

const getPromptCacheKV = (env: Env): KVNamespace | null => {
  const name = env.PROMPT_CACHE_KV_BINDING_NAME;
  return name ? ((env as any)[name] as KVNamespace || null) : null;
};

const getD1Database = (env: Env): D1Database => {
  const name = env.D1_DATABASE_BINDING || env.D1_DATABASE_NAME || 'DB';
  const db = (env as any)[name] as D1Database;
  if (!db) throw new Error(`D1 database binding '${name}' not found`);
  return db;
};

const resolveBucketName = (env: Env): string => env.R2_BUCKET_NAME || DEFAULT_R2_BUCKET_NAME;

const getR2PublicUrl = (env: Env, key: string, fallbackOrigin?: string): string => {
  if (env.R2_DOMAIN) return `${trimTrailingSlash(env.R2_DOMAIN)}/${key}`;
  if (fallbackOrigin) return `${trimTrailingSlash(fallbackOrigin)}/r2/${resolveBucketName(env)}/${key}`;
  throw new Error('Unable to determine R2 public URL. Configure R2_DOMAIN environment variable.');
};

const extractR2KeyFromUrl = (url: string): string | null => {
  if (!url) return null;
  try {
    if (url.startsWith('r2://')) return url.replace('r2://', '');
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/').filter(p => p);
    if (urlObj.pathname.startsWith('/r2/') && parts.length >= 3 && parts[0] === 'r2') return parts.slice(2).join('/');
    if (parts.length > 0) {
      const fullPath = parts.join('/');
      if (['preset_thumb/', 'preset/', 'selfie/', 'selfies/', 'presets/', 'results/'].some(p => fullPath.startsWith(p))) return fullPath;
      const fn = parts[parts.length - 1];
      if (fn.startsWith('result_') || fn.startsWith('vertex_') || fn.startsWith('merge_') || fn.startsWith('upscaler4k_')) return `results/${fullPath}`;
      if (fn.startsWith('selfie_')) return `selfie/${fullPath}`;
      if (fn.startsWith('preset_')) return `preset_thumb/${fullPath}`;
      return fullPath;
    }
    return parts.join('/') || null;
  } catch { return null; }
};

const reconstructR2Key = (id: string, ext: string, prefix: 'selfie' | 'preset' | 'results'): string => `${prefix}/${id}.${ext}`;

const convertLegacyUrl = (url: string, env: Env): string => {
  if (!url) return url;
  try {
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/').filter(p => p);
    if (urlObj.pathname.startsWith('/r2/') && parts.length >= 3 && parts[0] === 'r2') {
      return getR2PublicUrl(env, parts.slice(2).join('/'), urlObj.origin);
    }
    if (env.R2_DOMAIN && urlObj.hostname === new URL(env.R2_DOMAIN).hostname) {
      const bn = resolveBucketName(env);
      if (parts.length >= 2 && parts[0] === bn) return getR2PublicUrl(env, parts.slice(1).join('/'), urlObj.origin);
    }
  } catch {}
  return url;
};

const extractPathId = (path: string, prefix: string): string | null => {
  if (!path.startsWith(prefix)) return null;
  const parts = path.split(prefix);
  if (parts.length < 2) return null;
  const idPart = parts[1].split('/').filter(p => p)[0] || parts[1].split('?')[0];
  return idPart?.trim() || null;
};

// Retry helper with exponential backoff
const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = 10,
  initialDelay: number = 1000,
  isRetryable?: (error: Error) => boolean
): Promise<T> => {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const msg = lastError.message.toLowerCase();
      const shouldRetry = isRetryable ? isRetryable(lastError) : (
        msg.includes('timeout') || msg.includes('network') || msg.includes('connection') ||
        msg.includes('rate limit') || msg.includes('429') || msg.includes('503') ||
        msg.includes('502') || msg.includes('500') || msg.includes('unspecified error')
      );
      if (!shouldRetry && attempt === 0) throw lastError;
      if (attempt < maxRetries - 1) {
        const delay = Math.min(initialDelay * Math.pow(2, attempt) + Math.random() * 0.3 * initialDelay * Math.pow(2, attempt), 30000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError || new Error('Operation failed after all retries');
};

// Vertex AI prompt generation with retry
const generateVertexPromptWithRetry = async (
  imageUrl: string, env: Env, isFilterMode: boolean = false, customPromptText: string | null = null, maxRetries: number = 15, initialDelay: number = 2000
): Promise<{ success: boolean; prompt?: any; error?: string; debug?: any }> => {
  let lastError: string | undefined;
  let lastDebug: any;
  const isRetryableError = (error: string, debug?: any): boolean => {
    if (!error) return true;
    const el = error.toLowerCase();
    const status = debug?.httpStatus;
    if (status && status >= 400 && status < 500 && status !== 429) return false;
    if (el.includes('no valid json') || el.includes('could not extract')) return true;
    return el.includes('timeout') || el.includes('network') || el.includes('429') || el.includes('rate limit') ||
           el.includes('503') || el.includes('502') || el.includes('500') || status === undefined || (status >= 500 && status < 600);
  };
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await generateVertexPrompt(imageUrl, env, isFilterMode, customPromptText);
      if (result.success && result.prompt) return result;
      lastError = result.error || 'Unknown error';
      lastDebug = result.debug;
      if (!isRetryableError(lastError, lastDebug)) {
        return { success: false, error: lastError, debug: { ...lastDebug, totalAttempts: attempt + 1, finalError: lastError } };
      }
      if (attempt < maxRetries - 1) {
        const delay = Math.min(initialDelay * Math.pow(2, attempt) + Math.random() * 0.3 * initialDelay * Math.pow(2, attempt), maxRetries <= 3 ? 5000 : 30000);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      lastDebug = { errorDetails: lastError };
      if (!isRetryableError(lastError, lastDebug)) return { success: false, error: lastError, debug: lastDebug };
      if (attempt < maxRetries - 1) {
        const delay = Math.min(initialDelay * Math.pow(2, attempt) + Math.random() * 0.3 * initialDelay * Math.pow(2, attempt), maxRetries <= 3 ? 5000 : 30000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return { success: false, error: lastError || 'All retry attempts failed', debug: { ...lastDebug, totalAttempts: maxRetries, retriesExhausted: true, finalError: lastError } };
};

// Database helpers
const ensureSystemPreset = async (DB: D1Database): Promise<string> => {
  const id = 'system_no_preset';
  const existing = await DB.prepare('SELECT id FROM presets WHERE id = ?').bind(id).first();
  if (!existing) await DB.prepare('INSERT OR IGNORE INTO presets (id, ext, created_at) VALUES (?, ?, ?)').bind(id, 'jpg', Math.floor(Date.now() / 1000)).run();
  return id;
};

const ensureSystemSelfie = async (DB: D1Database, profileId: string, imageUrl: string, R2_BUCKET: R2Bucket): Promise<string | null> => {
  try {
    let key = extractR2KeyFromUrl(imageUrl) || imageUrl;
    let id: string | null = null, ext = 'jpg';
    if (key.startsWith('selfie/')) {
      const parts = key.replace('selfie/', '').split('.');
      if (parts.length >= 2) { ext = parts[parts.length - 1]; id = parts.slice(0, -1).join('.'); }
    }
    if (id) {
      const r = await DB.prepare('SELECT id FROM selfies WHERE id = ? AND profile_id = ? LIMIT 1').bind(id, profileId).first();
      if (r) return (r as any).id;
    }
    const newId = nanoid(16);
    ext = key.includes('.') ? key.split('.').pop() || 'jpg' : 'jpg';
    const res = await DB.prepare('INSERT OR IGNORE INTO selfies (id, ext, profile_id, action, created_at) VALUES (?, ?, ?, ?, ?)').bind(newId, ext, profileId, 'default', Math.floor(Date.now() / 1000)).run();
    return res.success ? newId : null;
  } catch { return null; }
};

const saveResultToDatabase = async (DB: D1Database, resultUrl: string, profileId: string, env: Env, R2_BUCKET: R2Bucket): Promise<string | null> => {
  try {
    let key = extractR2KeyFromUrl(resultUrl) || resultUrl;
    if (key && !key.startsWith('results/') && (key.startsWith('result_') || key.startsWith('vertex_') || key.startsWith('merge_') || key.startsWith('upscaler4k_'))) {
      key = `results/${key}`;
    }
    const parts = key.replace('results/', '').split('.');
    if (parts.length < 2) return null;
    const ext = parts[parts.length - 1], id = parts.slice(0, -1).join('.');
    const existing = await DB.prepare('SELECT id FROM results WHERE id = ? AND profile_id = ? LIMIT 1').bind(id, profileId).first<{ id: string }>();
    if (existing) return existing.id;
    let maxHistory = parseInt(env.RESULT_MAX_HISTORY || '10', 10);
    if (isNaN(maxHistory) || maxHistory < 1) maxHistory = 10;
    maxHistory = Math.floor(Math.max(1, maxHistory));
    const countRes = await DB.prepare('SELECT COUNT(*) as count FROM results WHERE profile_id = ?').bind(profileId).first<{ count: number }>();
    const currentCount = countRes?.count || 0;
    if (currentCount >= maxHistory) {
      const excess = Math.floor(Math.max(1, currentCount - maxHistory + 1));
      const old = await DB.prepare('SELECT id, ext FROM results WHERE profile_id = ? ORDER BY created_at ASC LIMIT ?').bind(profileId, excess).all<{ id: string; ext: string }>();
      if (old.results?.length) {
        let ids = old.results.map(r => r.id).slice(0, 100);
        await DB.prepare(`DELETE FROM results WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
        for (const r of old.results) { try { await R2_BUCKET.delete(reconstructR2Key(r.id, r.ext, 'results')); } catch {} }
      }
    }
    const res = await DB.prepare('INSERT INTO results (id, ext, profile_id, created_at) VALUES (?, ?, ?, ?)').bind(id, ext, profileId, Math.floor(Date.now() / 1000)).run();
    return res.success ? id : null;
  } catch { return null; }
};

// Debug payload builders
type SafetyCheckDebug = { checked: boolean; isSafe: boolean; statusCode?: number; violationCategory?: string; violationLevel?: string; details?: { adult: string; spoof?: string; medical?: string; violence: string; racy: string }; error?: string; rawResponse?: unknown; debug?: Record<string, any> };

const buildProviderDebug = (result: FaceSwapResponse, finalUrl?: string): Record<string, any> => compact({
  success: result.Success, statusCode: result.StatusCode, message: result.Message, processingTime: result.ProcessingTime || result.ProcessingTimeSpan,
  processStarted: result.ProcessStartedDateTime, faceSwapCount: result.FaceSwapCount, error: result.Error, originalResultImageUrl: result.ResultImageUrl,
  finalResultImageUrl: finalUrl, debug: (result as any).Debug, fullResponse: (result as any).FullResponse, httpStatus: (result as any).HttpStatus, httpStatusText: (result as any).HttpStatusText
});

const buildVertexDebug = (result: FaceSwapResponse): Record<string, any> | undefined => {
  const ext = result as FaceSwapResponse & { VertexResponse?: any; Prompt?: any; CurlCommand?: string };
  if (!ext.VertexResponse && !ext.Prompt && !ext.CurlCommand) return undefined;
  return compact({ prompt: ext.Prompt, response: ext.VertexResponse, curlCommand: ext.CurlCommand });
};

const mergeVertexDebug = (result: FaceSwapResponse, promptPayload: any): Record<string, any> | undefined => {
  const base = buildVertexDebug(result);
  const debug = (result as any).Debug;
  let merged = base ? { ...base } : undefined;
  if (promptPayload && (!merged || !('prompt' in merged))) merged = { ...(merged ?? {}), prompt: promptPayload };
  if (debug) merged = { ...(merged ?? {}), debug };
  return merged ? compact(merged) : undefined;
};

const buildVisionDebug = (vision?: SafetyCheckDebug | null): Record<string, any> | undefined => {
  if (!vision) return undefined;
  return compact({ checked: vision.checked, isSafe: vision.isSafe, statusCode: vision.statusCode, violationCategory: vision.violationCategory, violationLevel: vision.violationLevel, details: vision.details, error: vision.error, rawResponse: vision.rawResponse, debug: vision.debug });
};

// Prompt augmentation
const augmentVertexPrompt = (promptPayload: any, additionalPrompt?: string) => {
  if (!promptPayload || typeof promptPayload !== 'object') return promptPayload;
  const clone = { ...promptPayload };
  const extra = additionalPrompt?.trim();
  if (!extra) return clone;
  const base = typeof clone.prompt === 'string' ? clone.prompt : '';
  clone.prompt = base ? `${base} + ${extra}` : extra;
  return clone;
};

const transformPromptForFilter = (promptPayload: any): any => {
  if (!promptPayload || typeof promptPayload !== 'object') return promptPayload;
  const clone = { ...promptPayload };
  if (typeof clone.prompt === 'string') {
    let p = clone.prompt;
    if (p.includes('Replace the original face')) p = p.replace(/Replace the original face with the face from the image I will upload later\.[^.]*/g, VERTEX_AI_PROMPTS.FILTER_STYLE_APPLICATION_INSTRUCTION);
    else if (!p.includes('Apply this creative style')) p = `${p} ${VERTEX_AI_PROMPTS.FILTER_STYLE_APPLICATION_INSTRUCTION}`;
    clone.prompt = p;
  } else {
    clone.prompt = VERTEX_AI_PROMPTS.FILTER_DEFAULT_PROMPT;
  }
  return clone;
};

// Thumbnail filename parser
const parseThumbnailFilename = (filename: string): { preset_id: string; format: string } | null => {
  if (!filename?.trim()) return null;
  let presetId = filename.replace(/\.(left|right)\.(png|webp)$/i, '');
  if (presetId === filename) presetId = filename.replace(/\.(webp|json|png)$/i, '');
  if (presetId === filename || !presetId) return null;
  return { preset_id: presetId, format: filename.toLowerCase().endsWith('.json') ? 'lottie' : 'webp' };
};

// Generate thumbnail data paths for all resolutions
const generateThumbnailPaths = (presetId: string, formats: string[]): Record<string, string> => {
  const data: Record<string, string> = {};
  const resolutions = ['1x', '1.5x', '2x', '3x', '4x'];
  for (const format of formats) {
    const ext = format === 'json' ? 'json' : 'webp';
    const prefix = format === 'json' ? 'lottie' : 'webp';
    resolutions.forEach(r => { data[`${prefix}_${r}`] = `preset_thumb/${prefix}_${r}/${presetId}.${ext}`; });
    if (format === 'webp') resolutions.forEach(r => { data[`webp_avif_${r}`] = `preset_thumb/webp_avif_${r}/${presetId}.avif`; });
    if (format === 'json') resolutions.forEach(r => { data[`lottie_avif_${r}`] = `preset_thumb/lottie_avif_${r}/${presetId}.avif`; });
  }
  return data;
};

// Get primary thumbnail URL
const getPrimaryThumbnailUrl = (env: Env, thumbnailData: Record<string, string>, formats: string[], origin: string): string | null => {
  const primary = formats[0] || 'webp';
  const prefix = primary === 'json' ? 'lottie' : 'webp';
  const key = thumbnailData[`${prefix}_4x`];
  return key ? getR2PublicUrl(env, key, origin) : null;
};

// R2 URL resolution for result images
const resolveR2Url = (url: string | undefined, env: Env, origin: string): string => {
  if (!url) return '';
  if (url.startsWith('r2://')) return getR2PublicUrl(env, url.replace('r2://', ''), origin);
  return url;
};

// Common result storage logic
const storeResultImage = async (
  resultUrl: string, R2_BUCKET: R2Bucket, env: Env, origin: string
): Promise<{ url: string; r2Key: string | null; saved: boolean; error: string | null }> => {
  try {
    const resp = await fetchWithTimeout(resultUrl, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
    if (resp.ok && resp.body) {
      const id = nanoid(16);
      const key = `results/${id}.jpg`;
      await R2_BUCKET.put(key, resp.body, { httpMetadata: { contentType: resp.headers.get('content-type') || 'image/jpeg', cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL } });
      return { url: getR2PublicUrl(env, key, origin), r2Key: key, saved: true, error: null };
    }
    return { url: resultUrl, r2Key: null, saved: false, error: `Download failed with status ${resp.status}` };
  } catch (e) {
    return { url: resultUrl, r2Key: null, saved: false, error: e instanceof Error ? e.message : String(e) };
  }
};

// Common endpoint response handler for image processing endpoints
const handleImageProcessingResult = async (
  result: FaceSwapResponse, prompt: any, R2_BUCKET: R2Bucket, DB: D1Database, env: Env, request: Request, profileId?: string
): Promise<Response> => {
  const debugEnabled = isDebugEnabled(env);
  const origin = new URL(request.url).origin;

  if (!result.Success || !result.ResultImageUrl) {
    const code = result.StatusCode || 500;
    const httpStatus = code >= 1000 ? 422 : (code >= 200 && code < 600 ? code : 500);
    return jsonResponse({
      data: null, status: 'error', message: '', code,
      ...(debugEnabled ? { debug: compact({ provider: buildProviderDebug(result), vertex: mergeVertexDebug(result, prompt) }) } : {})
    }, httpStatus);
  }

  let resultUrl = resolveR2Url(result.ResultImageUrl, env, origin);
  const storage = await storeResultImage(resultUrl, R2_BUCKET, env, origin);
  resultUrl = storage.url;

  let savedId: string | null = null;
  if (profileId) {
    try { savedId = await saveResultToDatabase(DB, resultUrl, profileId, env, R2_BUCKET); } catch {}
  }

  return jsonResponse({
    data: { id: savedId !== null ? String(savedId) : null, resultImageUrl: resultUrl },
    status: 'success', message: result.Message || 'Processing successful', code: 200,
    ...(debugEnabled ? { debug: compact({ provider: buildProviderDebug(result, resultUrl), vertex: mergeVertexDebug(result, prompt) }) } : {})
  });
};

// ============================================================================
// MAIN WORKER EXPORT
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const DB = getD1Database(env);
    const R2_BUCKET = getR2Bucket(env);
    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;
    const corsHeaders = getCorsHeaders(request, env);
    const debugEnabled = isDebugEnabled(env);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      const headers = path.startsWith('/upload-proxy/')
        ? { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '86400' }
        : { ...corsHeaders, 'Access-Control-Max-Age': '86400' };
      return new Response(null, { status: 204, headers });
    }

    // Rate limiting
    if (!(await checkRateLimit(env, request, path))) {
      return jsonResponse({ data: null, status: 'error', message: 'Rate limit exceeded', code: 429, ...(debugEnabled ? { debug: { path, method: request.method } } : {}) }, 429, request, env);
    }

    // API key auth for protected paths
    const checkProtectedPath = (p: string, m: string): boolean => {
      if (p === '/upload-url') return false;
      if (p === '/profiles') return m === 'POST';
      if (p.startsWith('/profiles/') && p.split('/').length === 3) return m === 'GET';
      return PROTECTED_MOBILE_APIS.includes(p);
    };
    if (checkProtectedPath(path, request.method) && !checkApiKey(env, request)) {
      return jsonResponse({ data: null, status: 'error', message: 'Unauthorized', code: 401, ...(debugEnabled ? { debug: { path, method: request.method } } : {}) }, 401, request, env);
    }

    // Request size check
    if (request.method === 'POST' || request.method === 'PUT') {
      if (path !== '/process-thumbnail-file' && path !== '/process-thumbnail-zip') {
        const isLarge = path === '/upload-url' || path.startsWith('/r2-upload/');
        const maxSize = isLarge ? 100 * 1024 * 1024 : 1024 * 1024;
        const check = checkRequestSize(request, maxSize);
        if (!check.valid) return errorResponse(check.error || 'Request too large', 413, debugEnabled ? { path, method: request.method, maxSize } : undefined, request, env);
      }
    }

    // ========================================================================
    // UPLOAD URL ENDPOINT
    // ========================================================================
    if (path === '/upload-url' && request.method === 'POST') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        let files: File[] = [], imageUrls: string[] = [], type = '', profileId = '', presetName = '';
        let enableVertexPrompt = false, isFilterMode = false, customPromptText: string | null = null, action: string | null = null;

        if (contentType.toLowerCase().includes('multipart/form-data')) {
          const fd = await request.formData();
          const fileEntries = fd.getAll('files');
          for (const e of fileEntries) if (e && typeof e !== 'string') files.push(e as any as File);
          if (!files.length) { const f = fd.get('file') as any; if (f && typeof f !== 'string') files.push(f as File); }
          const urlEntries = fd.getAll('image_urls');
          imageUrls = urlEntries.filter((u): u is string => typeof u === 'string' && u.trim() !== '');
          if (!imageUrls.length) { const u = fd.get('image_url') as string | null; if (u) imageUrls = [u]; }
          type = fd.get('type') as string;
          profileId = fd.get('profile_id') as string;
          presetName = fd.get('presetName') as string;
          enableVertexPrompt = fd.get('enableVertexPrompt') === 'true';
          const fm = fd.get('is_filter_mode');
          isFilterMode = fm === 'true' || (typeof fm === 'string' && fm.toLowerCase() === 'true');
          customPromptText = fd.get('custom_prompt_text') as string | null;
          const ae = fd.get('action');
          action = (ae && typeof ae === 'string') ? ae : null;
        } else if (contentType.toLowerCase().includes('application/json')) {
          const body = await request.json() as any;
          imageUrls = body.image_urls || (body.image_url ? [body.image_url] : []);
          type = body.type || '';
          profileId = body.profile_id || '';
          presetName = body.presetName || '';
          enableVertexPrompt = body.enableVertexPrompt === true;
          isFilterMode = body.is_filter_mode === true;
          customPromptText = body.custom_prompt_text || null;
          action = body.action || null;
        } else {
          return errorResponse('', 400, debugEnabled ? { contentType, path } : undefined, request, env);
        }

        for (const url of imageUrls) if (!validateImageUrl(url, env)) return errorResponse('', 400, debugEnabled ? { url, path } : undefined, request, env);
        if (!profileId?.trim()) return errorResponse('profile_id is required', 400, debugEnabled ? { type, profileId, path } : undefined, request, env);
        profileId = profileId.trim();
        if (!type?.trim()) return errorResponse('type is required', 400, debugEnabled ? { type, profileId, path } : undefined, request, env);
        type = type.trim();
        if (type !== 'preset' && type !== 'selfie') return errorResponse('type must be "preset" or "selfie"', 400, debugEnabled ? { type, path } : undefined, request, env);
        if (type === 'selfie' && !checkApiKey(env, request)) return jsonResponse({ data: null, status: 'error', message: 'Unauthorized', code: 401, ...(debugEnabled ? { debug: { path, method: request.method, type } } : {}) }, 401, request, env);

        const profile = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(profileId).first();
        if (!profile) return errorResponse('Profile not found', 404, debugEnabled ? { profileId, path } : undefined, request, env);

        interface FileData { fileData: ArrayBuffer; filename: string; contentType: string; }
        const allFileData: FileData[] = [];
        for (const file of files) {
          const data = await file.arrayBuffer();
          if (!data?.byteLength) continue;
          allFileData.push({ fileData: data, filename: file.name || `upload_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`, contentType: file.type || 'image/jpeg' });
        }
        for (const url of imageUrls) {
          try {
            const resp = await fetchWithTimeout(url, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
            if (!resp.ok) continue;
            const data = await resp.arrayBuffer();
            if (!data?.byteLength) continue;
            const ct = resp.headers.get('content-type') || 'image/jpeg';
            let fn = url.split('/').pop() || `image_${Date.now()}.${ct.split('/')[1] || 'jpg'}`;
            fn = fn.split('?')[0];
            allFileData.push({ fileData: data, filename: fn, contentType: ct });
          } catch {}
        }
        if (!allFileData.length) return errorResponse('', 400, debugEnabled ? { filesCount: files.length, imageUrlsCount: imageUrls.length, path } : undefined, request, env);

        const processFile = async (fd: FileData, _idx: number): Promise<any> => {
          const id = nanoid(16);
          let ext = 'jpg';
          if (fd.contentType) {
            const p = fd.contentType.split('/');
            if (p.length > 1 && p[1]?.trim()) { ext = p[1].trim().toLowerCase(); if (ext === 'jpeg') ext = 'jpg'; }
          }
          if (ext === 'jpg' && fd.filename) {
            const fe = fd.filename.split('.').pop()?.toLowerCase();
            if (fe && ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(fe)) ext = fe === 'jpeg' ? 'jpg' : fe;
          }
          const key = `${type}/${id}.${ext}`;

          try { await R2_BUCKET.put(key, fd.fileData, { httpMetadata: { contentType: fd.contentType, cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL } }); }
          catch (e) { return { success: false, error: `R2 upload failed: ${e instanceof Error ? e.message.substring(0, 200) : String(e).substring(0, 200)}`, filename: fd.filename }; }

          const publicUrl = getR2PublicUrl(env, key, requestUrl.origin);
          const createdAt = Math.floor(Date.now() / 1000);

          // Vision check for selfie 4k action
          let visionResult: any = null;
          if (type === 'selfie') {
            const actionVal = action?.toLowerCase() || 'faceswap';
            const needsCheck = actionVal === '4k' && env.DISABLE_VISION_API !== 'true';
            if (needsCheck) {
              const ssr = await checkSafeSearch(publicUrl, env);
              if (debugEnabled) visionResult = { checked: true, isSafe: ssr.isSafe, statusCode: ssr.statusCode, violationCategory: ssr.violationCategory, violationLevel: ssr.violationLevel, details: ssr.details, error: ssr.error };
              if (ssr.error) { try { await R2_BUCKET.delete(key); } catch {} return { success: false, error: 'Vision scan failed', filename: fd.filename, visionError: true, ...(debugEnabled ? { visionDetails: { error: ssr.error, debug: ssr.debug } } : {}) }; }
              if (!ssr.isSafe) {
                try { await R2_BUCKET.delete(key); } catch {}
                const code = ssr.statusCode && ssr.statusCode >= 1001 && ssr.statusCode <= 1005 ? ssr.statusCode : 1001;
                return { success: false, error: 'Upload failed', filename: fd.filename, visionBlocked: true, visionStatusCode: code, ...(debugEnabled ? { visionDetails: { violationCategory: ssr.violationCategory, violationLevel: ssr.violationLevel, details: ssr.details } } : {}) };
              }
            }
          }

          if (type === 'preset') {
            let promptJson: string | null = null;
            let vertexInfo: any = { success: false };
            if (enableVertexPrompt) {
              try {
                const pr = await generateVertexPrompt(publicUrl, env, isFilterMode === true, customPromptText);
                if (pr.success && pr.prompt) { promptJson = JSON.stringify(pr.prompt); vertexInfo = { success: true, promptKeys: Object.keys(pr.prompt), debug: pr.debug }; }
                else { vertexInfo = { success: false, error: pr.error || 'Unknown error', debug: pr.debug }; }
              } catch (e) { vertexInfo = { success: false, error: (e instanceof Error ? e.message : String(e)).substring(0, 200) }; }
            }
            if (promptJson) {
              try { await R2_BUCKET.put(key, fd.fileData, { httpMetadata: { contentType: fd.contentType, cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL }, customMetadata: { prompt_json: promptJson } }); }
              catch {}
            }
            const thumbData = { webp_4x: key };
            const existing = await DB.prepare('SELECT created_at FROM presets WHERE id = ?').bind(id).first();
            const finalCreatedAt = existing?.created_at ? (existing as any).created_at : createdAt;
            await DB.prepare('INSERT OR REPLACE INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)').bind(id, ext, finalCreatedAt, JSON.stringify(thumbData)).run();
            return { success: true, url: publicUrl, id, filename: `${id}.${ext}`, hasPrompt: !!promptJson, prompt_json: promptJson ? JSON.parse(promptJson) : null, vertex_info: vertexInfo, thumbnail_4x: getR2PublicUrl(env, key, requestUrl.origin), thumbnail_created: true, filter_mode_used: isFilterMode, prompt_type: isFilterMode ? 'filter' : (customPromptText ? 'custom' : 'default'), ...(debugEnabled && visionResult ? { visionCheck: visionResult } : {}) };
          } else {
            // Selfie
            let actionVal = action?.trim() || 'faceswap';
            if (actionVal.toLowerCase() === '4k') actionVal = '4k';
            if (!actionVal) actionVal = 'faceswap';

            let maxCount: number, queryCondition: string, queryBindings: any[];
            const al = actionVal.toLowerCase();
            if (al === 'faceswap') { maxCount = parseInt(env.SELFIE_MAX_FACESWAP || '5', 10); queryCondition = 'profile_id = ? AND action = ?'; queryBindings = [profileId, actionVal]; }
            else if (al === 'wedding') { maxCount = parseInt(env.SELFIE_MAX_WEDDING || '2', 10); queryCondition = 'profile_id = ? AND action = ?'; queryBindings = [profileId, actionVal]; }
            else if (al === '4k') { maxCount = parseInt(env.SELFIE_MAX_4K || '1', 10); queryCondition = 'profile_id = ? AND (action = ? OR action = ?)'; queryBindings = [profileId, '4k', '4K']; }
            else { maxCount = parseInt(env.SELFIE_MAX_OTHER || '1', 10); queryCondition = 'profile_id = ? AND action = ?'; queryBindings = [profileId, actionVal]; }
            if (isNaN(maxCount) || maxCount < 1) maxCount = 1;
            maxCount = Math.floor(Math.max(1, maxCount));

            const existingRes = await DB.prepare(`SELECT id, ext FROM selfies WHERE ${queryCondition} ORDER BY created_at ASC LIMIT ?`).bind(...queryBindings, maxCount).all();
            const currentCount = existingRes.results?.length || 0;
            if (currentCount >= maxCount) {
              const toDelete = existingRes.results!.slice(0, currentCount - maxCount + 1);
              const ids = toDelete.map((s: any) => s.id);
              await DB.prepare(`DELETE FROM selfies WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
              for (const old of toDelete) { try { await R2_BUCKET.delete(reconstructR2Key((old as any).id, (old as any).ext, 'selfie')); } catch {} }
            }

            try {
              await DB.prepare('INSERT INTO selfies (id, ext, profile_id, action, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, ext, profileId, actionVal, Math.floor(createdAt)).run();
            } catch (e) {
              return { success: false, error: `Database insert error: ${e instanceof Error ? e.message : String(e)}`, filename: fd.filename };
            }
            return { success: true, url: publicUrl, id, filename: `${id}.${ext}`, action: actionVal, ...(debugEnabled && visionResult ? { visionCheck: visionResult } : {}) };
          }
        };

        let results: any[];
        if (type === 'preset') {
          results = await promisePoolWithConcurrency(allFileData, (fd, i) => processFile(fd, i), 5);
        } else {
          results = [];
          for (let i = 0; i < allFileData.length; i++) results.push(await processFile(allFileData[i], i));
        }

        const visionBlocked = results.find(r => r.visionBlocked === true);
        if (visionBlocked) {
          const code = visionBlocked.visionStatusCode || 1001;
          return jsonResponse({ data: null, status: 'error', message: 'Upload failed', code, ...(debugEnabled ? { debug: { vision: { checked: true, isSafe: false, statusCode: code, violationCategory: visionBlocked.visionDetails?.violationCategory } } } : {}) }, 422, request, env);
        }

        const successful = results.filter(r => r.success), failed = results.filter(r => !r.success);
        const allFailed = !successful.length && failed.length > 0;
        const partial = successful.length > 0 && failed.length > 0;

        return jsonResponse({
          data: { results: results.map(r => r.success ? { id: r.id, url: r.url, filename: r.filename, ...(r.filter_mode_used !== undefined ? { filter_mode_used: r.filter_mode_used } : {}), ...(r.prompt_type ? { prompt_type: r.prompt_type } : {}) } : { success: false, error: r.error, filename: r.filename }), count: results.length, successful: successful.length, failed: failed.length },
          status: allFailed ? 'error' : (partial ? 'partial' : 'success'),
          message: allFailed ? `Upload failed: ${failed.length} file${failed.length !== 1 ? 's' : ''} failed` : (partial ? `Partial success: ${successful.length} of ${results.length} file${results.length !== 1 ? 's' : ''} uploaded` : 'Processing successful'),
          code: allFailed ? 422 : 200
        }, allFailed ? 422 : 200, request, env);
      } catch (error) {
        logCriticalError('/upload-url', error, request, env, { path, errorType: 'upload_error' });
        const msg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse(`Upload failed: ${msg}`, 500, debugEnabled ? { error: msg, path } : undefined, request, env);
      }
    }

    // ========================================================================
    // MULTIPART UPLOAD APIs
    // ========================================================================
    if (path === '/upload-multipart/create' && request.method === 'POST') {
      try {
        const body = await request.json() as { key: string; contentType?: string };
        if (!body.key) return errorResponse('key is required', 400, undefined, request, env);
        const key = `temp/multipart_${nanoid(16)}_${body.key.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const upload = await R2_BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: body.contentType || 'application/octet-stream' } });
        return successResponse({ uploadId: upload.uploadId, key: upload.key }, 200, request, env);
      } catch (e) { logCriticalError('/upload-multipart/create', e, request, env); return errorResponse('Failed to create multipart upload', 500, debugEnabled ? { error: (e instanceof Error ? e.message : String(e)).substring(0, 200) } : undefined, request, env); }
    }

    if (path === '/upload-multipart/part' && request.method === 'PUT') {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get('key'), uploadId = url.searchParams.get('uploadId'), partNum = parseInt(url.searchParams.get('partNumber') || '0', 10);
        if (!key || !uploadId || partNum < 1) return errorResponse('key, uploadId, and partNumber (>=1) are required', 400, undefined, request, env);
        if (!request.body) return errorResponse('No body provided', 400, undefined, request, env);
        const part = await R2_BUCKET.resumeMultipartUpload(key, uploadId).uploadPart(partNum, request.body);
        return successResponse({ partNumber: part.partNumber, etag: part.etag }, 200, request, env);
      } catch (e) { logCriticalError('/upload-multipart/part', e, request, env); return errorResponse('Failed to upload part', 500, debugEnabled ? { error: (e instanceof Error ? e.message : String(e)).substring(0, 200) } : undefined, request, env); }
    }

    if (path === '/upload-multipart/complete' && request.method === 'POST') {
      try {
        const body = await request.json() as { key: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }> };
        if (!body.key || !body.uploadId || !body.parts?.length) return errorResponse('key, uploadId, and parts array are required', 400, undefined, request, env);
        await R2_BUCKET.resumeMultipartUpload(body.key, body.uploadId).complete(body.parts);
        return successResponse({ key: body.key, completed: true }, 200, request, env);
      } catch (e) { logCriticalError('/upload-multipart/complete', e, request, env); return errorResponse('Failed to complete multipart upload', 500, debugEnabled ? { error: (e instanceof Error ? e.message : String(e)).substring(0, 200) } : undefined, request, env); }
    }

    if (path === '/upload-multipart/abort' && request.method === 'POST') {
      try {
        const body = await request.json() as { key: string; uploadId: string };
        if (!body.key || !body.uploadId) return errorResponse('key and uploadId are required', 400, undefined, request, env);
        await R2_BUCKET.resumeMultipartUpload(body.key, body.uploadId).abort();
        return successResponse({ aborted: true }, 200, request, env);
      } catch (e) { logCriticalError('/upload-multipart/abort', e, request, env); return errorResponse('Failed to abort multipart upload', 500, debugEnabled ? { error: (e instanceof Error ? e.message : String(e)).substring(0, 200) } : undefined, request, env); }
    }

    // Direct R2 upload for files <100MB
    if (path.startsWith('/r2-upload/') && request.method === 'PUT') {
      try {
        const uploadKey = decodeURIComponent(path.replace('/r2-upload/', ''));
        const ct = new URL(request.url).searchParams.get('contentType') || 'application/octet-stream';
        if (!uploadKey?.startsWith('temp/')) return errorResponse('Invalid upload key', 400, { uploadKey }, request, env);
        if (!request.body) return errorResponse('No body provided', 400, undefined, request, env);
        await R2_BUCKET.put(uploadKey, request.body, { httpMetadata: { contentType: ct, cacheControl: 'private, max-age=3600' } });
        return successResponse({ key: uploadKey, uploaded: true }, 200, request, env);
      } catch (e) { logCriticalError('/r2-upload', e, request, env); return errorResponse('', 500, debugEnabled ? { error: (e instanceof Error ? e.message : String(e)).substring(0, 200) } : undefined, request, env); }
    }

    // ========================================================================
    // PROCESS THUMBNAIL FILE
    // ========================================================================
    if (path === '/process-thumbnail-file' && request.method === 'POST') {
      try {
        return await retryWithBackoff(async () => {
          const contentType = request.headers.get('Content-Type') || '';

          // JSON request for preset prompt generation
          if (contentType.toLowerCase().includes('application/json')) {
            const body = await request.json() as { r2_key?: string; r2_url?: string; filename?: string; preset_id?: string; is_filter_mode?: boolean; custom_prompt_text?: string };
            if (body.r2_key || body.r2_url) {
              const r2Key = body.r2_key || (body.r2_url ? extractR2KeyFromUrl(body.r2_url) : null);
              if (!r2Key) return errorResponse('Invalid R2 key or URL', 400, undefined, request, env);
              let presetId = body.preset_id;
              if (!presetId) {
                const fn = body.filename || r2Key.split('/').pop() || '';
                const parsed = parseThumbnailFilename(fn);
                if (!parsed) return errorResponse('Could not extract preset_id from filename or R2 key', 400, undefined, request, env);
                presetId = parsed.preset_id;
              }
              const existing = await R2_BUCKET.head(r2Key);
              if (!existing) return errorResponse(`File not found in R2: ${r2Key}`, 404, undefined, request, env);
              const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
              const promptRes = await generateVertexPromptWithRetry(publicUrl, env, body.is_filter_mode === true, body.custom_prompt_text || null);
              if (!promptRes.success || !promptRes.prompt) return errorResponse(`Vertex AI prompt generation failed: ${promptRes.error || 'Unknown error'}`, 500, { vertex_info: { success: false, error: promptRes.error, debug: promptRes.debug } }, request, env);
              const promptJson = JSON.stringify(promptRes.prompt);
              const fileData = await (await R2_BUCKET.get(r2Key))?.arrayBuffer();
              if (!fileData) return errorResponse('Failed to read file from R2', 500, undefined, request, env);
              await R2_BUCKET.put(r2Key, fileData, { httpMetadata: { contentType: existing.httpMetadata?.contentType || 'application/octet-stream', cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL }, customMetadata: { prompt_json: promptJson } });
              const kv = getPromptCacheKV(env);
              if (kv) { try { await kv.delete(`prompt:${presetId}`); } catch {} }
              const existingPreset = await DB.prepare('SELECT id FROM presets WHERE id = ?').bind(presetId).first();
              if (existingPreset) await DB.prepare("UPDATE presets SET updated_at = datetime('now') WHERE id = ?").bind(presetId).run();
              else { const ext = r2Key.split('.').pop() || 'webp'; await DB.prepare("INSERT INTO presets (id, ext, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))").bind(presetId, ext).run(); }
              return successResponse({ success: true, preset_id: presetId, r2_key: r2Key, url: publicUrl, hasPrompt: true, kvCacheDeleted: true, vertex_info: { success: true, promptKeys: Object.keys(promptRes.prompt) } }, 200, request, env);
            }
            return errorResponse('r2_key or r2_url is required for preset prompt generation', 400, undefined, request, env);
          }

          // Multipart form - file upload
          const formData = await request.formData();
          const zipFile = formData.get('zip') as File | null;
          const thumbFormatsRaw = (formData.get('thumbnail_formats') as string | null) || (formData.get('thumbnail_format') as string | null) || 'webp';
          const thumbFormats = thumbFormatsRaw.split(',').map(f => f.trim()).filter(f => f);
          const isFilterMode = formData.get('is_filter_mode') === 'true';
          const customPromptText = formData.get('custom_prompt_text') as string | null;

          // Zip file processing
          if (zipFile?.type === 'application/zip') {
            const zipData = await zipFile.arrayBuffer();
            const zip = await JSZip.loadAsync(zipData);
            const presetFiles: Array<{ filename: string; relativePath: string; zipEntry: JSZip.JSZipObject }> = [];
            zip.forEach((p: string, e: JSZip.JSZipObject) => {
              if (!e.dir && p.toLowerCase().startsWith('preset/') && (p.toLowerCase().endsWith('.webp') || p.toLowerCase().endsWith('.png'))) {
                presetFiles.push({ filename: p.split('/').pop() || p, relativePath: p.replace(/\\/g, '/'), zipEntry: e });
              }
            });
            if (!presetFiles.length) return errorResponse('No PNG/WebP files found in preset folder', 400, undefined, request, env);

            let successful = 0, failed = 0, presetsProcessed = 0, presetsWithPrompts = 0;
            const results: any[] = [];
            const startTime = Date.now();
            const MAX_TIME = 25000;
            let processedCount = 0, timeoutReached = false;

            const processPreset = async ({ filename, relativePath, zipEntry }: typeof presetFiles[0]) => {
              try {
                const parsed = parseThumbnailFilename(filename);
                if (!parsed) return { success: false, filename, error: 'Invalid filename format' };
                const { preset_id: presetId } = parsed;
                const fileDataUint8 = await zipEntry.async('uint8array');
                if (!fileDataUint8?.length) return { success: false, filename, error: 'File is empty' };
                const fileData = new ArrayBuffer(fileDataUint8.length);
                new Uint8Array(fileData).set(fileDataUint8);

                const tempKey = `temp/${presetId}_${Date.now()}.${filename.split('.').pop()}`;
                await R2_BUCKET.put(tempKey, fileData, { httpMetadata: { contentType: 'image/png', cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL } });
                const tempUrl = getR2PublicUrl(env, tempKey, requestUrl.origin);
                const promptRes = await generateVertexPromptWithRetry(tempUrl, env, isFilterMode, customPromptText);
                try { await R2_BUCKET.delete(tempKey); } catch {}
                if (!promptRes.success || !promptRes.prompt) return { success: false, filename, error: `Vertex AI prompt generation failed: ${promptRes.error || 'Unknown error'}` };

                const parts = relativePath.split('/').filter(p => p);
                parts.pop();
                const cleanParts = parts.filter(p => !/\.(webp|png|json|jpg|jpeg|gif)$/i.test(p));
                const folder = cleanParts.includes('preset') ? 'preset' : (cleanParts.length > 0 ? cleanParts[0] : 'preset');
                const presetR2Key = `${folder}/${presetId}.webp`;
                const promptJson = JSON.stringify(promptRes.prompt);

                await retryWithBackoff(async () => {
                  await R2_BUCKET.put(presetR2Key, fileData, { httpMetadata: { contentType: 'image/webp', cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL }, customMetadata: { prompt_json: promptJson } });
                  const verify = await R2_BUCKET.head(presetR2Key);
                  if (!verify) throw new Error('Upload verification failed');
                }, 10, 1000);

                const presetUrl = getR2PublicUrl(env, presetR2Key, requestUrl.origin);
                let thumbData = generateThumbnailPaths(presetId, thumbFormats);
                const thumbUrl = getPrimaryThumbnailUrl(env, thumbData, thumbFormats, requestUrl.origin);

                const existingPreset = await DB.prepare('SELECT id, thumbnail_r2, created_at FROM presets WHERE id = ?').bind(presetId).first();
                const createdAt = existingPreset?.created_at ? (existingPreset as any).created_at : Math.floor(Date.now() / 1000);
                if (existingPreset && (existingPreset as any).thumbnail_r2) {
                  try { thumbData = { ...JSON.parse((existingPreset as any).thumbnail_r2), ...thumbData }; } catch {}
                }
                await DB.prepare('INSERT OR REPLACE INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)').bind(presetId, 'webp', createdAt, JSON.stringify(thumbData)).run();
                const kv = getPromptCacheKV(env);
                if (kv) { try { await kv.delete(`prompt:${presetId}`); } catch {} }

                return { success: true, type: 'preset', preset_id: presetId, url: presetUrl, hasPrompt: true, kvCacheDeleted: true, vertex_info: { success: true, promptKeys: Object.keys(promptRes.prompt) }, thumbnail_url: thumbUrl, thumbnail_formats: thumbFormats, thumbnail_created: true };
              } catch (e) { return { success: false, filename, error: (e instanceof Error ? e.message : String(e)).substring(0, 200) }; }
            };

            for (let i = 0; i < presetFiles.length; i += 5) {
              if (Date.now() - startTime > MAX_TIME) { timeoutReached = true; break; }
              const batch = presetFiles.slice(i, i + 5);
              const batchRes = await Promise.all(batch.map(processPreset));
              processedCount += batch.length;
              for (const r of batchRes) {
                if (r.success) { successful++; results.push(r); presetsProcessed++; if (r.hasPrompt) presetsWithPrompts++; }
                else { failed++; results.push(r); }
              }
              if (i + 5 < presetFiles.length) await new Promise(r => setTimeout(r, 100));
            }

            return successResponse({ success: true, total: presetFiles.length, processed: processedCount, successful, failed, presets_processed: presetsProcessed, presets_with_prompts: presetsWithPrompts, timeout_reached: timeoutReached, processing_time_ms: Date.now() - startTime, thumbnail_formats: thumbFormats }, 200, request, env);
          }

          // Single file upload
          const file = formData.get('file') as File | null;
          const filePath = (formData.get('path') as string | null) || '';
          if (!file) return errorResponse('file is required', 400, undefined, request, env);

          const filename = file.name;
          const basename = filename.split('/').pop() || filename.split('\\').pop() || filename;
          const parsed = parseThumbnailFilename(basename);
          if (!parsed) return errorResponse('Invalid filename format. Could not extract preset_id from filename.', 400, undefined, request, env);
          const { preset_id: presetId, format } = parsed;
          const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
          const pathParts = normalizedPath.split('/').filter(p => p);
          const isFromPresetFolder = normalizedPath.includes('preset/') || normalizedPath.startsWith('preset/') || normalizedPath === 'preset' || (pathParts.length > 0 && pathParts[0] === 'preset') || (!normalizedPath && (filename.toLowerCase().endsWith('.webp') || filename.toLowerCase().endsWith('.png')));

          if (isFromPresetFolder) {
            const fileData = await file.arrayBuffer();
            const singleThumbFormatsRaw = (formData.get('thumbnail_formats') as string | null) || (formData.get('thumbnail_format') as string | null) || 'webp';
            const singleThumbFormats = singleThumbFormatsRaw.split(',').map(f => f.trim()).filter(f => f);

            const tempKey = `temp/${presetId}_${Date.now()}.${filename.split('.').pop()}`;
            await R2_BUCKET.put(tempKey, fileData, { httpMetadata: { contentType: file.type || 'image/png', cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL } });
            const tempUrl = getR2PublicUrl(env, tempKey, requestUrl.origin);
            const promptRes = await generateVertexPromptWithRetry(tempUrl, env, isFilterMode, customPromptText);
            try { await R2_BUCKET.delete(tempKey); } catch {}
            if (!promptRes.success || !promptRes.prompt) return errorResponse(`Vertex AI prompt generation failed: ${promptRes.error || 'Unknown error'}`, 500, { vertex_info: { success: false, error: promptRes.error, debug: promptRes.debug } }, request, env);

            let folder = 'preset';
            if (filePath) {
              const parts = filePath.replace(/\\/g, '/').split('/').filter(p => p && p !== basename && !/\.(webp|png|json)$/i.test(p.replace(/\.(webp|png|json)$/i, '')) && p.replace(/\.(webp|png|json)$/i, '') !== presetId);
              if (parts.length > 0) folder = parts.join('/');
            }
            const presetR2Key = `${folder}/${presetId}.webp`;
            const promptJson = JSON.stringify(promptRes.prompt);

            await retryWithBackoff(async () => {
              await R2_BUCKET.put(presetR2Key, fileData, { httpMetadata: { contentType: 'image/webp', cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL }, customMetadata: { prompt_json: promptJson } });
              const verify = await R2_BUCKET.head(presetR2Key);
              if (!verify) throw new Error('Upload verification failed');
            }, 10, 1000);

            const presetUrl = getR2PublicUrl(env, presetR2Key, requestUrl.origin);
            let thumbData = generateThumbnailPaths(presetId, singleThumbFormats);
            const thumbUrl = getPrimaryThumbnailUrl(env, thumbData, singleThumbFormats, requestUrl.origin);

            const existingPreset = await DB.prepare('SELECT id, thumbnail_r2, created_at FROM presets WHERE id = ?').bind(presetId).first();
            const createdAt = existingPreset?.created_at ? (existingPreset as any).created_at : Math.floor(Date.now() / 1000);
            const ext = filename.toLowerCase().endsWith('.json') ? 'json' : 'webp';
            if (existingPreset && (existingPreset as any).thumbnail_r2) {
              try { thumbData = { ...JSON.parse((existingPreset as any).thumbnail_r2), ...thumbData }; } catch {}
            }
            await DB.prepare('INSERT OR REPLACE INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)').bind(presetId, ext, createdAt, JSON.stringify(thumbData)).run();
            const kv = getPromptCacheKV(env);
            if (kv) { try { await kv.delete(`prompt:${presetId}`); } catch {} }

            return successResponse({ success: true, type: 'preset', preset_id: presetId, url: presetUrl, hasPrompt: true, kvCacheDeleted: true, vertex_info: { success: true, promptKeys: Object.keys(promptRes.prompt) }, thumbnail_url: thumbUrl, thumbnail_formats: singleThumbFormats, thumbnail_created: true }, 200, request, env);
          }

          // Thumbnail file (not preset)
          const fileData = await file.arrayBuffer();
          const pathFolders = pathParts.filter(p => !p.includes(basename));
          const resolution = pathFolders.find(p => ['1x', '1.5x', '2x', '3x', '4x'].includes(p.replace(/^(webp|lottie)(_avif)?_/i, '')));
          let formatFolder = pathFolders.find(p => p.startsWith('webp') || p.startsWith('lottie')) || '';
          const fileExt = filename.split('.').pop()?.toLowerCase() || 'webp';

          if (!formatFolder) {
            if (fileExt === 'json') formatFolder = resolution ? `lottie_${resolution}` : 'lottie_4x';
            else if (fileExt === 'avif') formatFolder = resolution ? `webp_avif_${resolution}` : 'webp_avif_4x';
            else formatFolder = resolution ? `webp_${resolution}` : 'webp_4x';
          }

          const thumbR2Key = `preset_thumb/${formatFolder}/${presetId}.${fileExt}`;
          await R2_BUCKET.put(thumbR2Key, fileData, { httpMetadata: { contentType: file.type || `image/${fileExt}`, cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL } });
          const thumbUrl = getR2PublicUrl(env, thumbR2Key, requestUrl.origin);

          const existingPreset = await DB.prepare('SELECT id, thumbnail_r2 FROM presets WHERE id = ?').bind(presetId).first();
          if (existingPreset) {
            let thumbData: Record<string, string> = {};
            if ((existingPreset as any).thumbnail_r2) { try { thumbData = JSON.parse((existingPreset as any).thumbnail_r2); } catch {} }
            thumbData[formatFolder] = thumbR2Key;
            await DB.prepare('UPDATE presets SET thumbnail_r2 = ? WHERE id = ?').bind(JSON.stringify(thumbData), presetId).run();
          } else {
            const thumbData: Record<string, string> = { [formatFolder]: thumbR2Key };
            await DB.prepare('INSERT INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)').bind(presetId, 'webp', Math.floor(Date.now() / 1000), JSON.stringify(thumbData)).run();
          }

          return successResponse({ success: true, type: 'thumbnail', preset_id: presetId, url: thumbUrl, r2_key: thumbR2Key, format: formatFolder }, 200, request, env);
        }, 10, 1000);
      } catch (e) {
        logCriticalError('/process-thumbnail-file', e, request, env);
        return errorResponse(`Processing failed: ${e instanceof Error ? e.message.substring(0, 200) : String(e).substring(0, 200)}`, 500, debugEnabled ? { error: e instanceof Error ? e.message : String(e) } : undefined, request, env);
      }
    }

    // ========================================================================
    // PROCESS THUMBNAIL ZIP
    // ========================================================================
    if (path === '/process-thumbnail-zip' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const zipFile = formData.get('zip') as File | null;
        if (!zipFile || zipFile.type !== 'application/zip') return errorResponse('zip file is required', 400, undefined, request, env);

        const zipData = await zipFile.arrayBuffer();
        const zip = await JSZip.loadAsync(zipData);
        const thumbFiles: Array<{ filename: string; relativePath: string; zipEntry: JSZip.JSZipObject }> = [];
        zip.forEach((p: string, e: JSZip.JSZipObject) => {
          if (!e.dir && (p.toLowerCase().endsWith('.webp') || p.toLowerCase().endsWith('.json') || p.toLowerCase().endsWith('.avif'))) {
            thumbFiles.push({ filename: p.split('/').pop() || p, relativePath: p.replace(/\\/g, '/'), zipEntry: e });
          }
        });
        if (!thumbFiles.length) return errorResponse('No thumbnail files found in zip', 400, undefined, request, env);

        let successful = 0, failed = 0;
        const results: any[] = [];
        const startTime = Date.now();
        const MAX_TIME = 25000;
        let processedCount = 0, timeoutReached = false;

        const processThumb = async ({ filename, relativePath, zipEntry }: typeof thumbFiles[0]) => {
          try {
            const parsed = parseThumbnailFilename(filename);
            if (!parsed) return { success: false, filename, error: 'Invalid filename format' };
            const { preset_id: presetId } = parsed;
            const fileDataUint8 = await zipEntry.async('uint8array');
            if (!fileDataUint8?.length) return { success: false, filename, error: 'File is empty' };
            const fileData = new ArrayBuffer(fileDataUint8.length);
            new Uint8Array(fileData).set(fileDataUint8);

            const pathParts = relativePath.split('/').filter(p => p);
            pathParts.pop();
            let formatFolder = pathParts.find(p => p.startsWith('webp') || p.startsWith('lottie')) || '';
            const fileExt = filename.split('.').pop()?.toLowerCase() || 'webp';

            if (!formatFolder) {
              const resolution = pathParts.find(p => ['1x', '1.5x', '2x', '3x', '4x'].includes(p));
              if (fileExt === 'json') formatFolder = resolution ? `lottie_${resolution}` : 'lottie_4x';
              else if (fileExt === 'avif') formatFolder = resolution ? `webp_avif_${resolution}` : 'webp_avif_4x';
              else formatFolder = resolution ? `webp_${resolution}` : 'webp_4x';
            }

            const thumbR2Key = `preset_thumb/${formatFolder}/${presetId}.${fileExt}`;
            const ct = fileExt === 'json' ? 'application/json' : (fileExt === 'avif' ? 'image/avif' : 'image/webp');
            await R2_BUCKET.put(thumbR2Key, fileData, { httpMetadata: { contentType: ct, cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL } });
            const thumbUrl = getR2PublicUrl(env, thumbR2Key, requestUrl.origin);

            const existingPreset = await DB.prepare('SELECT id, thumbnail_r2 FROM presets WHERE id = ?').bind(presetId).first();
            if (existingPreset) {
              let thumbData: Record<string, string> = {};
              if ((existingPreset as any).thumbnail_r2) { try { thumbData = JSON.parse((existingPreset as any).thumbnail_r2); } catch {} }
              thumbData[formatFolder] = thumbR2Key;
              await DB.prepare('UPDATE presets SET thumbnail_r2 = ? WHERE id = ?').bind(JSON.stringify(thumbData), presetId).run();
            } else {
              const thumbData: Record<string, string> = { [formatFolder]: thumbR2Key };
              await DB.prepare('INSERT INTO presets (id, ext, created_at, thumbnail_r2) VALUES (?, ?, ?, ?)').bind(presetId, 'webp', Math.floor(Date.now() / 1000), JSON.stringify(thumbData)).run();
            }

            return { success: true, type: 'thumbnail', preset_id: presetId, url: thumbUrl, r2_key: thumbR2Key, format: formatFolder };
          } catch (e) { return { success: false, filename, error: (e instanceof Error ? e.message : String(e)).substring(0, 200) }; }
        };

        for (let i = 0; i < thumbFiles.length; i += 10) {
          if (Date.now() - startTime > MAX_TIME) { timeoutReached = true; break; }
          const batch = thumbFiles.slice(i, i + 10);
          const batchRes = await Promise.all(batch.map(processThumb));
          processedCount += batch.length;
          for (const r of batchRes) { if (r.success) successful++; else failed++; results.push(r); }
          if (i + 10 < thumbFiles.length) await new Promise(r => setTimeout(r, 50));
        }

        return successResponse({ success: true, total: thumbFiles.length, processed: processedCount, successful, failed, timeout_reached: timeoutReached, processing_time_ms: Date.now() - startTime, results: results.slice(0, 100) }, 200, request, env);
      } catch (e) {
        logCriticalError('/process-thumbnail-zip', e, request, env);
        return errorResponse(`Processing failed: ${e instanceof Error ? e.message.substring(0, 200) : String(e).substring(0, 200)}`, 500, debugEnabled ? { error: e instanceof Error ? e.message : String(e) } : undefined, request, env);
      }
    }

    // ========================================================================
    // PROFILES CRUD
    // ========================================================================
    if (path === '/profiles' && request.method === 'POST') {
      try {
        const body = await request.json() as { id?: string; name?: string };
        const id = body.id?.trim() || nanoid(16);
        const name = body.name?.trim() || 'Anonymous';
        const existing = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(id).first();
        if (existing) return errorResponse('Profile with this ID already exists', 409, debugEnabled ? { id } : undefined, request, env);
        await DB.prepare('INSERT INTO profiles (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, Math.floor(Date.now() / 1000)).run();
        return successResponse({ id, name, created_at: Math.floor(Date.now() / 1000) }, 201, request, env);
      } catch (e) {
        logCriticalError('/profiles POST', e, request, env);
        return errorResponse('Failed to create profile', 500, debugEnabled ? { error: e instanceof Error ? e.message : String(e) } : undefined, request, env);
      }
    }

    if (path.startsWith('/profiles/') && request.method === 'GET') {
      try {
        const id = extractPathId(path, '/profiles/');
        if (!id) return errorResponse('Profile ID is required', 400, undefined, request, env);
        const profile = await DB.prepare('SELECT id, name, created_at FROM profiles WHERE id = ?').bind(id).first();
        if (!profile) return errorResponse('Profile not found', 404, debugEnabled ? { id } : undefined, request, env);
        const selfies = await DB.prepare('SELECT id, ext, action, created_at FROM selfies WHERE profile_id = ? ORDER BY created_at DESC').bind(id).all();
        const results = await DB.prepare('SELECT id, ext, created_at FROM results WHERE profile_id = ? ORDER BY created_at DESC').bind(id).all();
        const selfieData = (selfies.results || []).map((s: any) => ({ id: s.id, url: getR2PublicUrl(env, reconstructR2Key(s.id, s.ext, 'selfie'), requestUrl.origin), action: s.action, created_at: s.created_at }));
        const resultData = (results.results || []).map((r: any) => ({ id: r.id, url: getR2PublicUrl(env, reconstructR2Key(r.id, r.ext, 'results'), requestUrl.origin), created_at: r.created_at }));
        return successResponse({ ...(profile as any), selfies: selfieData, results: resultData }, 200, request, env);
      } catch (e) {
        logCriticalError('/profiles/:id GET', e, request, env);
        return errorResponse('Failed to get profile', 500, debugEnabled ? { error: e instanceof Error ? e.message : String(e) } : undefined, request, env);
      }
    }

    if (path === '/profiles' && request.method === 'GET') {
      try {
        const limit = parseInt(requestUrl.searchParams.get('limit') || '50', 10);
        const offset = parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        const profiles = await DB.prepare('SELECT id, name, created_at FROM profiles ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
        const count = await DB.prepare('SELECT COUNT(*) as count FROM profiles').first<{ count: number }>();
        return successResponse({ profiles: profiles.results || [], total: count?.count || 0, limit, offset }, 200, request, env);
      } catch (e) {
        logCriticalError('/profiles GET', e, request, env);
        return errorResponse('Failed to list profiles', 500, debugEnabled ? { error: e instanceof Error ? e.message : String(e) } : undefined, request, env);
      }
    }

    // ========================================================================
    // PRESETS LIST
    // ========================================================================
    if (path === '/presets' && request.method === 'GET') {
      try {
        const limit = parseInt(requestUrl.searchParams.get('limit') || '100', 10);
        const offset = parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        const category = requestUrl.searchParams.get('category');
        const search = requestUrl.searchParams.get('search');

        let query = 'SELECT id, ext, created_at, thumbnail_r2 FROM presets';
        const conditions: string[] = [];
        const params: any[] = [];

        if (category) { conditions.push('id LIKE ?'); params.push(`${category}_%`); }
        if (search) { conditions.push('id LIKE ?'); params.push(`%${search}%`); }
        if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const presets = await DB.prepare(query).bind(...params).all();
        const count = await DB.prepare(`SELECT COUNT(*) as count FROM presets${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''}`).bind(...params.slice(0, -2)).first<{ count: number }>();

        const presetsData = (presets.results || []).map((p: any) => {
          const url = getR2PublicUrl(env, reconstructR2Key(p.id, p.ext, 'preset'), requestUrl.origin);
          let thumbData: any = null;
          if (p.thumbnail_r2) { try { thumbData = JSON.parse(p.thumbnail_r2); } catch {} }
          return { id: p.id, url, created_at: p.created_at, thumbnail_data: thumbData };
        });

        return successResponse({ presets: presetsData, total: count?.count || 0, limit, offset }, 200, request, env);
      } catch (e) {
        logCriticalError('/presets GET', e, request, env);
        return errorResponse('Failed to list presets', 500, debugEnabled ? { error: e instanceof Error ? e.message : String(e) } : undefined, request, env);
      }
    }

    // ========================================================================
    // SELFIES LIST
    // ========================================================================
    if (path === '/selfies' && request.method === 'GET') {
      try {
        const profileId = requestUrl.searchParams.get('profile_id');
        const action = requestUrl.searchParams.get('action');
        const limit = parseInt(requestUrl.searchParams.get('limit') || '50', 10);
        const offset = parseInt(requestUrl.searchParams.get('offset') || '0', 10);

        let query = 'SELECT id, ext, profile_id, action, created_at FROM selfies';
        const conditions: string[] = [];
        const params: any[] = [];

        if (profileId) { conditions.push('profile_id = ?'); params.push(profileId); }
        if (action) { conditions.push('action = ?'); params.push(action); }
        if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const selfies = await DB.prepare(query).bind(...params).all();
        const count = await DB.prepare(`SELECT COUNT(*) as count FROM selfies${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''}`).bind(...params.slice(0, -2)).first<{ count: number }>();

        const selfiesData = (selfies.results || []).map((s: any) => ({ id: s.id, url: getR2PublicUrl(env, reconstructR2Key(s.id, s.ext, 'selfie'), requestUrl.origin), profile_id: s.profile_id, action: s.action, created_at: s.created_at }));

        return successResponse({ selfies: selfiesData, total: count?.count || 0, limit, offset }, 200, request, env);
      } catch (e) {
        logCriticalError('/selfies GET', e, request, env);
        return errorResponse('Failed to list selfies', 500, debugEnabled ? { error: e instanceof Error ? e.message : String(e) } : undefined, request, env);
      }
    }

    // ========================================================================
    // THUMBNAILS GET
    // ========================================================================
    if (path === '/thumbnails' && request.method === 'GET') {
      try {
        const presetId = requestUrl.searchParams.get('preset_id');
        if (!presetId) return errorResponse('preset_id is required', 400, undefined, request, env);
        const preset = await DB.prepare('SELECT id, thumbnail_r2 FROM presets WHERE id = ?').bind(presetId).first();
        if (!preset) return errorResponse('Preset not found', 404, debugEnabled ? { presetId } : undefined, request, env);
        let thumbData: any = null;
        if ((preset as any).thumbnail_r2) { try { thumbData = JSON.parse((preset as any).thumbnail_r2); } catch {} }
        const thumbUrls: Record<string, string> = {};
        if (thumbData) for (const [k, v] of Object.entries(thumbData)) if (typeof v === 'string') thumbUrls[k] = getR2PublicUrl(env, v, requestUrl.origin);
        return successResponse({ preset_id: presetId, thumbnails: thumbUrls }, 200, request, env);
      } catch (e) {
        logCriticalError('/thumbnails GET', e, request, env);
        return errorResponse('Failed to get thumbnails', 500, debugEnabled ? { error: e instanceof Error ? e.message : String(e) } : undefined, request, env);
      }
    }

    // ========================================================================
    // RESULTS LIST
    // ========================================================================
    if (path === '/results' && request.method === 'GET') {
      try {
        const profileId = requestUrl.searchParams.get('profile_id');
        const limit = parseInt(requestUrl.searchParams.get('limit') || '50', 10);
        const offset = parseInt(requestUrl.searchParams.get('offset') || '0', 10);

        let query = 'SELECT id, ext, profile_id, created_at FROM results';
        const params: any[] = [];
        if (profileId) { query += ' WHERE profile_id = ?'; params.push(profileId); }
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const results = await DB.prepare(query).bind(...params).all();
        const count = await DB.prepare(`SELECT COUNT(*) as count FROM results${profileId ? ' WHERE profile_id = ?' : ''}`).bind(...(profileId ? [profileId] : [])).first<{ count: number }>();

        const resultsData = (results.results || []).map((r: any) => ({ id: r.id, url: getR2PublicUrl(env, reconstructR2Key(r.id, r.ext, 'results'), requestUrl.origin), profile_id: r.profile_id, created_at: r.created_at }));

        return successResponse({ results: resultsData, total: count?.count || 0, limit, offset }, 200, request, env);
      } catch (e) {
        logCriticalError('/results GET', e, request, env);
        return errorResponse('Failed to list results', 500, debugEnabled ? { error: e instanceof Error ? e.message : String(e) } : undefined, request, env);
      }
    }

    // ========================================================================
    // FACESWAP ENDPOINT
    // ========================================================================
    if (path === '/faceswap' && request.method === 'POST') {
      let body: FaceSwapRequest | undefined;
      try {
        try { body = JSON.parse(await request.text()); } catch (e) { return errorResponse('', 400, { error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, path }, request, env); }
        if (!body) return errorResponse('', 400, { error: 'Request body is required', path }, request, env);
        if (body.preset_image_id) { const n = normalizePresetId(body.preset_image_id); if (n) body.preset_image_id = n; }

        const envErr = validateEnv(env, 'vertex');
        if (envErr) return errorResponse('', 500, { error: envErr, path }, request, env);
        const reqErr = validateRequest(body);
        if (reqErr) return errorResponse('', 400, { error: reqErr, path, body: { preset_image_id: body?.preset_image_id, profile_id: body?.profile_id, selfie_ids: body?.selfie_ids } }, request, env);

        const hasSelfieIds = Array.isArray(body.selfie_ids) && body.selfie_ids.length > 0;
        const hasSelfieUrls = Array.isArray(body.selfie_image_urls) && body.selfie_image_urls.length > 0;
        const hasPresetId = body.preset_image_id?.trim();
        const hasPresetUrl = body.preset_image_url?.trim();

        if (hasSelfieUrls && body.selfie_image_urls) for (const u of body.selfie_image_urls) if (!validateImageUrl(u, env)) return errorResponse('', 400, { error: `Invalid selfie URL: ${u}`, path }, request, env);
        if (hasPresetUrl && body.preset_image_url && !validateImageUrl(body.preset_image_url, env)) return errorResponse('', 400, { error: `Invalid preset URL: ${body.preset_image_url}`, path }, request, env);

        const queries: Promise<any>[] = [DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first()];
        if (hasPresetId) queries.push(DB.prepare('SELECT id, ext FROM presets WHERE id = ?').bind(body.preset_image_id).first());
        if (hasSelfieIds && body.selfie_ids) for (const sid of body.selfie_ids) queries.push(DB.prepare('SELECT s.id, s.ext, s.action FROM selfies s INNER JOIN profiles p ON s.profile_id = p.id WHERE s.id = ? AND p.id = ?').bind(sid, body.profile_id).first());

        let results: any[];
        try { results = await Promise.all(queries); } catch (e) {
          logCriticalError('/faceswap', e, request, env, { body: { preset_image_id: body?.preset_image_id, profile_id: body?.profile_id, selfie_ids: body?.selfie_ids } });
          const msg = e instanceof Error ? e.message : String(e);
          const isClient = msg.toLowerCase().includes('mismatch') || msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('syntax');
          return errorResponse('', isClient ? 400 : 500, { error: `Database query failed: ${msg}`, path }, request, env);
        }

        if (!results[0]) return errorResponse('Profile not found', 404, undefined, request, env);

        let targetUrl = '', presetImageId: string | null = null;
        if (hasPresetId) {
          const preset = results[1];
          if (!preset) return errorResponse('Preset image not found', 404, undefined, request, env);
          targetUrl = getR2PublicUrl(env, reconstructR2Key(preset.id, preset.ext, 'preset'), requestUrl.origin);
          presetImageId = body.preset_image_id || null;
        } else if (hasPresetUrl) {
          targetUrl = body.preset_image_url!;
        } else {
          return errorResponse('', 400, { error: 'Missing both preset_image_id and preset_image_url', path }, request, env);
        }

        const selfieUrls: string[] = [], selfieIds: string[] = [];
        const selfieStartIdx = hasPresetId ? 2 : 1;
        const requestedAction = body.action?.trim().toLowerCase();
        if (hasSelfieIds && body.selfie_ids) {
          for (let i = 0; i < body.selfie_ids.length; i++) {
            const s = results[selfieStartIdx + i];
            if (!s) return errorResponse(`Selfie with ID ${body.selfie_ids[i]} not found`, 404, debugEnabled ? { selfieId: body.selfie_ids[i], profileId: body.profile_id } : undefined, request, env);
            const sAction = s.action?.toLowerCase();
            if (requestedAction) {
              if (requestedAction === '4k' && sAction !== '4k') return errorResponse(`Selfie action mismatch`, 400, { selfieId: body.selfie_ids[i], selfieAction: s.action, requestedAction }, request, env);
              else if (requestedAction !== '4k' && sAction !== requestedAction) return errorResponse(`Selfie action mismatch`, 400, { selfieId: body.selfie_ids[i], selfieAction: s.action, requestedAction }, request, env);
            }
            selfieUrls.push(getR2PublicUrl(env, reconstructR2Key(s.id, s.ext, 'selfie'), requestUrl.origin));
            selfieIds.push(body.selfie_ids[i]);
          }
        } else if (hasSelfieUrls) {
          selfieUrls.push(...body.selfie_image_urls!);
        }
        if (!selfieUrls.length) return errorResponse('', 400, { error: 'No valid selfie images found', path }, request, env);

        const sourceUrl = selfieUrls.length === 1 ? selfieUrls[0] : selfieUrls;
        const requestCache = new Map<string, Promise<any>>();
        const getCached = async <T>(key: string, fn: () => Promise<T>): Promise<T> => { if (!requestCache.has(key)) requestCache.set(key, fn()); return requestCache.get(key) as Promise<T>; };

        let storedPrompt: any = null;
        const kv = getPromptCacheKV(env);
        if (presetImageId) {
          if (kv) { try { storedPrompt = await kv.get(`prompt:${presetImageId}`, 'json'); } catch {} }
          if (!storedPrompt) {
            const r2Key = reconstructR2Key(presetImageId, results[1]?.ext || 'webp', 'preset');
            try {
              const obj = await getCached(`r2head:${r2Key}`, () => R2_BUCKET.head(r2Key));
              const pj = obj?.customMetadata?.prompt_json;
              if (pj?.trim()) { storedPrompt = JSON.parse(pj); if (kv) kv.put(`prompt:${presetImageId}`, pj, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {}); }
            } catch {}
          }
        }
        if (!storedPrompt) {
          const genRes = await generateVertexPrompt(targetUrl, env);
          if (genRes.success && genRes.prompt) {
            storedPrompt = genRes.prompt;
            if (presetImageId && kv) kv.put(`prompt:${presetImageId}`, JSON.stringify(storedPrompt), { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {});
          } else {
            return errorResponse('', 400, { error: genRes.error || 'Failed to generate prompt', path, presetImageId }, request, env);
          }
        }

        const prompt = augmentVertexPrompt(storedPrompt, body.additional_prompt);
        const aspectRatio = await resolveAspectRatio(body.aspect_ratio, null, env, { allowOriginal: false });
        const result = await callNanoBanana(prompt, targetUrl, sourceUrl, env, aspectRatio, body.model);
        return await handleImageProcessingResult(result, prompt, R2_BUCKET, DB, env, request, body.profile_id);
      } catch (error) {
        logCriticalError('/faceswap', error, request, env, { body: { preset_image_id: body?.preset_image_id, profile_id: body?.profile_id, selfie_ids: body?.selfie_ids } });
        return errorResponse('', 500, debugEnabled ? { error: error instanceof Error ? error.message : String(error), path } : undefined, request, env);
      }
    }

    // ========================================================================
    // BACKGROUND ENDPOINT
    // ========================================================================
    if (path === '/background' && request.method === 'POST') {
      let body: BackgroundRequest | undefined;
      try {
        body = await request.json() as BackgroundRequest;
        if (body.preset_image_id) { const n = normalizePresetId(body.preset_image_id); if (n) body.preset_image_id = n; }

        const hasPresetId = body.preset_image_id?.trim();
        const hasPresetUrl = body.preset_image_url?.trim();
        const hasCustomPrompt = body.custom_prompt?.trim();
        const hasSelfieId = body.selfie_id?.trim();
        const hasSelfieUrl = body.selfie_image_url?.trim();

        if (!hasPresetId && !hasPresetUrl && !hasCustomPrompt) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if ((hasPresetId && hasPresetUrl) || (hasPresetId && hasCustomPrompt) || (hasPresetUrl && hasCustomPrompt)) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (!body.profile_id) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (!hasSelfieId && !hasSelfieUrl) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (hasSelfieId && hasSelfieUrl) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);

        const queries: Promise<any>[] = [DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first()];
        if (hasPresetId) queries.push(DB.prepare('SELECT id, ext FROM presets WHERE id = ?').bind(body.preset_image_id).first());
        if (hasSelfieId) queries.push(DB.prepare('SELECT s.id, s.ext FROM selfies s INNER JOIN profiles p ON s.profile_id = p.id WHERE s.id = ? AND p.id = ?').bind(body.selfie_id, body.profile_id).first());

        const results = await Promise.all(queries);
        if (!results[0]) return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id } : undefined, request, env);

        let targetUrl = '', selfieUrl = '';

        if (hasCustomPrompt) {
          const envErr = validateEnv(env, 'vertex');
          if (envErr) return errorResponse('', 500, debugEnabled ? { error: envErr } : undefined, request, env);
          if (hasSelfieId) {
            const s = results[hasPresetId ? 2 : 1];
            if (s) selfieUrl = getR2PublicUrl(env, reconstructR2Key(s.id, s.ext, 'selfie'), requestUrl.origin);
          } else selfieUrl = body.selfie_image_url!;
          const ar = await resolveAspectRatio(body.aspect_ratio, selfieUrl, env, { allowOriginal: true });
          const bgRes = await generateBackgroundFromPrompt(body.custom_prompt!, env, ar, body.model);
          if (!bgRes.Success || !bgRes.ResultImageUrl) {
            const code = bgRes.StatusCode || 500;
            return jsonResponse({ data: null, status: 'error', message: '', code, ...(debugEnabled ? { debug: compact({ customPrompt: body.custom_prompt, provider: buildProviderDebug(bgRes) }) } : {}) }, code >= 1000 ? 422 : (code >= 200 && code < 600 ? code : 500));
          }
          targetUrl = resolveR2Url(bgRes.ResultImageUrl, env, requestUrl.origin);
        } else if (hasPresetId) {
          const p = results[1];
          if (!p) return errorResponse('Preset image not found', 404, debugEnabled ? { presetId: body.preset_image_id } : undefined, request, env);
          targetUrl = getR2PublicUrl(env, reconstructR2Key(p.id, p.ext, 'preset'), requestUrl.origin);
        } else {
          targetUrl = body.preset_image_url!;
        }

        if (hasSelfieId) {
          const s = results[hasPresetId ? 2 : 1];
          if (!s) return errorResponse(`Selfie not found`, 404, debugEnabled ? { selfieId: body.selfie_id } : undefined, request, env);
          selfieUrl = getR2PublicUrl(env, reconstructR2Key(s.id, s.ext, 'selfie'), requestUrl.origin);
        } else {
          selfieUrl = body.selfie_image_url!;
        }

        const envErr = validateEnv(env, 'vertex');
        if (envErr) return errorResponse('', 500, debugEnabled ? { error: envErr } : undefined, request, env);

        let mergePrompt = VERTEX_AI_PROMPTS.MERGE_PROMPT_DEFAULT;
        if (body.additional_prompt) mergePrompt = `${mergePrompt} Additional instructions: ${body.additional_prompt}`;
        const ar = await resolveAspectRatio(body.aspect_ratio, selfieUrl, env, { allowOriginal: true });
        const result = await callNanoBananaMerge(mergePrompt, selfieUrl, targetUrl, env, ar, body.model);
        return await handleImageProcessingResult(result, mergePrompt, R2_BUCKET, DB, env, request, body.profile_id);
      } catch (error) {
        logCriticalError('/background', error, request, env, { body: { preset_image_id: body?.preset_image_id, profile_id: body?.profile_id, selfie_id: body?.selfie_id } });
        return errorResponse('', 500, debugEnabled ? { error: error instanceof Error ? error.message : String(error), path } : undefined, request, env);
      }
    }

    // ========================================================================
    // UPSCALER 4K ENDPOINT
    // ========================================================================
    if (path === '/upscaler4k' && request.method === 'POST') {
      let body: { image_url: string; profile_id?: string; aspect_ratio?: string } | undefined;
      try {
        body = await request.json() as typeof body;
        if (!body?.image_url) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (!body.profile_id) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);

        const profile = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first();
        if (!profile) return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id } : undefined, request, env);

        const envErr = validateEnv(env, 'vertex');
        if (envErr) return errorResponse('', 500, debugEnabled ? { error: envErr } : undefined, request, env);

        const result = await callUpscaler4k(body.image_url, env);
        return await handleImageProcessingResult(result, undefined, R2_BUCKET, DB, env, request, body.profile_id);
      } catch (error) {
        logCriticalError('/upscaler4k', error, request, env, { body });
        return errorResponse('', 500, debugEnabled ? { error: error instanceof Error ? error.message : String(error), path } : undefined, request, env);
      }
    }

    // ========================================================================
    // ENHANCE ENDPOINT
    // ========================================================================
    if (path === '/enhance' && request.method === 'POST') {
      let body: { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number } | undefined;
      try {
        body = await request.json() as typeof body;
        if (!body?.image_url) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (!body.profile_id) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);

        const profile = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first();
        if (!profile) return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id } : undefined, request, env);

        const envErr = validateEnv(env, 'vertex');
        if (envErr) return errorResponse('', 500, debugEnabled ? { error: envErr } : undefined, request, env);

        const ar = await resolveAspectRatio(body.aspect_ratio, body.image_url, env, { allowOriginal: true });
        const result = await callNanoBanana(IMAGE_PROCESSING_PROMPTS.ENHANCE, body.image_url, body.image_url, env, ar, body.model);
        return await handleImageProcessingResult(result, IMAGE_PROCESSING_PROMPTS.ENHANCE, R2_BUCKET, DB, env, request, body.profile_id);
      } catch (error) {
        logCriticalError('/enhance', error, request, env, { body });
        return errorResponse('', 500, debugEnabled ? { error: error instanceof Error ? error.message : String(error), path } : undefined, request, env);
      }
    }

    // ========================================================================
    // BEAUTY ENDPOINT
    // ========================================================================
    if (path === '/beauty' && request.method === 'POST') {
      let body: { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number } | undefined;
      try {
        body = await request.json() as typeof body;
        if (!body?.image_url) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (!body.profile_id) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);

        const profile = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first();
        if (!profile) return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id } : undefined, request, env);

        const envErr = validateEnv(env, 'vertex');
        if (envErr) return errorResponse('', 500, debugEnabled ? { error: envErr } : undefined, request, env);

        const ar = await resolveAspectRatio(body.aspect_ratio, body.image_url, env, { allowOriginal: true });
        const result = await callNanoBanana(IMAGE_PROCESSING_PROMPTS.ENHANCE, body.image_url, body.image_url, env, ar, body.model);
        return await handleImageProcessingResult(result, IMAGE_PROCESSING_PROMPTS.ENHANCE, R2_BUCKET, DB, env, request, body.profile_id);
      } catch (error) {
        logCriticalError('/beauty', error, request, env, { body });
        return errorResponse('', 500, debugEnabled ? { error: error instanceof Error ? error.message : String(error), path } : undefined, request, env);
      }
    }

    // ========================================================================
    // FILTER ENDPOINT
    // ========================================================================
    if (path === '/filter' && request.method === 'POST') {
      let body: { image_url: string; preset_image_id?: string; preset_image_url?: string; profile_id?: string; aspect_ratio?: string; model?: string | number } | undefined;
      try {
        body = await request.json() as typeof body;
        if (!body?.image_url) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (!body.profile_id) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (body.preset_image_id) { const n = normalizePresetId(body.preset_image_id); if (n) body.preset_image_id = n; }

        const hasPresetId = body.preset_image_id?.trim();
        const hasPresetUrl = body.preset_image_url?.trim();
        if (!hasPresetId && !hasPresetUrl) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);

        const profile = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first();
        if (!profile) return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id } : undefined, request, env);

        let presetUrl = '';
        if (hasPresetId) {
          const preset = await DB.prepare('SELECT id, ext FROM presets WHERE id = ?').bind(body.preset_image_id).first();
          if (!preset) return errorResponse('Preset not found', 404, debugEnabled ? { presetId: body.preset_image_id } : undefined, request, env);
          presetUrl = getR2PublicUrl(env, reconstructR2Key((preset as any).id, (preset as any).ext, 'preset'), requestUrl.origin);
        } else {
          presetUrl = body.preset_image_url!;
        }

        const envErr = validateEnv(env, 'vertex');
        if (envErr) return errorResponse('', 500, debugEnabled ? { error: envErr } : undefined, request, env);

        let storedPrompt: any = null;
        const kv = getPromptCacheKV(env);
        if (hasPresetId && body.preset_image_id) {
          if (kv) { try { storedPrompt = await kv.get(`prompt:${body.preset_image_id}`, 'json'); } catch {} }
          if (!storedPrompt) {
            const preset = await DB.prepare('SELECT id, ext FROM presets WHERE id = ?').bind(body.preset_image_id).first();
            if (preset) {
              const r2Key = reconstructR2Key((preset as any).id, (preset as any).ext, 'preset');
              try {
                const obj = await R2_BUCKET.head(r2Key);
                const pj = obj?.customMetadata?.prompt_json;
                if (pj?.trim()) { storedPrompt = JSON.parse(pj); if (kv) kv.put(`prompt:${body.preset_image_id}`, pj, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {}); }
              } catch {}
            }
          }
        }
        if (!storedPrompt) {
          const genRes = await generateVertexPrompt(presetUrl, env, true);
          if (genRes.success && genRes.prompt) {
            storedPrompt = genRes.prompt;
            if (hasPresetId && body.preset_image_id && kv) kv.put(`prompt:${body.preset_image_id}`, JSON.stringify(storedPrompt), { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {});
          } else {
            return errorResponse('', 400, { error: genRes.error || 'Failed to generate prompt', path }, request, env);
          }
        }

        const prompt = transformPromptForFilter(storedPrompt);
        const ar = await resolveAspectRatio(body.aspect_ratio, body.image_url, env, { allowOriginal: true });
        const result = await callNanoBanana(prompt, body.image_url, presetUrl, env, ar, body.model);
        return await handleImageProcessingResult(result, prompt, R2_BUCKET, DB, env, request, body.profile_id);
      } catch (error) {
        logCriticalError('/filter', error, request, env, { body });
        return errorResponse('', 500, debugEnabled ? { error: error instanceof Error ? error.message : String(error), path } : undefined, request, env);
      }
    }

    // ========================================================================
    // RESTORE ENDPOINT
    // ========================================================================
    if (path === '/restore' && request.method === 'POST') {
      let body: { image_url: string; profile_id?: string; aspect_ratio?: string; model?: string | number } | undefined;
      try {
        body = await request.json() as typeof body;
        if (!body?.image_url) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (!body.profile_id) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);

        const profile = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first();
        if (!profile) return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id } : undefined, request, env);

        const envErr = validateEnv(env, 'vertex');
        if (envErr) return errorResponse('', 500, debugEnabled ? { error: envErr } : undefined, request, env);

        const ar = await resolveAspectRatio(body.aspect_ratio, body.image_url, env, { allowOriginal: true });
        const result = await callNanoBanana(IMAGE_PROCESSING_PROMPTS.FILTER, body.image_url, body.image_url, env, ar, body.model);
        return await handleImageProcessingResult(result, IMAGE_PROCESSING_PROMPTS.FILTER, R2_BUCKET, DB, env, request, body.profile_id);
      } catch (error) {
        logCriticalError('/restore', error, request, env, { body });
        return errorResponse('', 500, debugEnabled ? { error: error instanceof Error ? error.message : String(error), path } : undefined, request, env);
      }
    }

    // ========================================================================
    // AGING ENDPOINT
    // ========================================================================
    if (path === '/aging' && request.method === 'POST') {
      let body: { image_url: string; age_years?: number; profile_id?: string; aspect_ratio?: string; model?: string | number } | undefined;
      try {
        body = await request.json() as typeof body;
        if (!body?.image_url) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        if (!body.profile_id) return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);

        const profile = await DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first();
        if (!profile) return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id } : undefined, request, env);

        const ageYears = body.age_years || 20;
        const envErr = validateEnv(env, 'vertex');
        if (envErr) return errorResponse('', 500, debugEnabled ? { error: envErr } : undefined, request, env);

        const ar = await resolveAspectRatio(body.aspect_ratio, body.image_url, env, { allowOriginal: true });
        const prompt = `Age this person by ${ageYears} years. Add realistic aging effects including facial wrinkles, gray hair, maturity in appearance while maintaining the person's identity and natural features. Make the changes subtle and realistic.`;
        const result = await callNanoBanana(prompt, body.image_url, body.image_url, env, ar, body.model);
        return await handleImageProcessingResult(result, prompt, R2_BUCKET, DB, env, request, body.profile_id);
      } catch (error) {
        logCriticalError('/aging', error, request, env, { body });
        return errorResponse('', 500, debugEnabled ? { error: error instanceof Error ? error.message : String(error), path } : undefined, request, env);
      }
    }

    // ========================================================================
    // CONFIG ENDPOINT
    // ========================================================================
    if (path === '/config' && request.method === 'GET') {
      const kv = getPromptCacheKV(env);
      const kvAvailable = !!kv;
      let kvTest = null, kvDetails = null;

      if (kvAvailable && kv) {
        try {
          const testKey = `__test__${Date.now()}`;
          const testVal = JSON.stringify({ test: true, timestamp: Date.now() });
          await kv.put(testKey, testVal, { expirationTtl: 60 });
          const read = await kv.get(testKey, 'json');
          if (read && (read as any).test) { await kv.delete(testKey); kvTest = 'working'; kvDetails = { write: 'success', read: 'success', delete: 'success' }; }
          else { kvTest = 'write_success_read_failed'; kvDetails = { write: 'success', read: 'failed', readBack: read }; }
        } catch (e) { kvTest = `error: ${e instanceof Error ? e.message : String(e)}`; kvDetails = { error: e instanceof Error ? e.message : String(e) }; }
      } else {
        kvDetails = { reason: 'Prompt cache KV not bound', bindingName: env.PROMPT_CACHE_KV_BINDING_NAME || 'not set' };
      }

      return jsonResponse({ data: { backendDomain: env.BACKEND_DOMAIN || null, r2Domain: env.R2_DOMAIN || null, kvCache: { available: kvAvailable, test: kvTest, details: kvDetails } }, status: 'success', message: 'Configuration retrieved successfully', code: 200, ...(debugEnabled ? { debug: { path, backendDomain: !!env.BACKEND_DOMAIN, r2Domain: !!env.R2_DOMAIN, kvCacheAvailable: kvAvailable } } : {}) }, 200, request, env);
    }

    // 404 for unmatched routes
    return errorResponse('Not found', 404, debugEnabled ? { path, method: request.method } : undefined, request, env);
  },
};
