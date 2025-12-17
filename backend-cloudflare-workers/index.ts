/// <reference types="@cloudflare/workers-types" />

import { customAlphabet } from 'nanoid';
const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_', 21);
import type { Env, FaceSwapRequest, FaceSwapResponse, UploadUrlRequest, Profile, BackgroundRequest } from './types';
import { CORS_HEADERS, getCorsHeaders, jsonResponse, errorResponse, validateImageUrl, fetchWithTimeout } from './utils';
import { callFaceSwap, callNanoBanana, callNanoBananaMerge, checkSafeSearch, generateVertexPrompt, callUpscaler4k } from './services';
import { validateEnv, validateRequest } from './validators';
import { API_PROMPTS, ASPECT_RATIO_CONFIG, CACHE_CONFIG, TIMEOUT_CONFIG } from './config';

const checkRateLimit = async (env: Env, request: Request, path: string): Promise<boolean> => {
  if (!env.RATE_LIMITER) return true;
  
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';
  const result = await env.RATE_LIMITER.limit({ key: `${ip}:${path}` });
  return result.success;
};

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
    console.warn('Failed to parse URL for conversion:', url);
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

const GENDER_PROMPT_HINTS: Record<'male' | 'female', string> = API_PROMPTS.GENDER_HINTS;

const augmentVertexPrompt = (
  promptPayload: any,
  additionalPrompt?: string,
  characterGender?: 'male' | 'female'
) => {
  if (!promptPayload || typeof promptPayload !== 'object') {
    return promptPayload;
  }

  // Efficient shallow clone for prompt augmentation
  const clone = typeof promptPayload === 'object' && promptPayload !== null 
    ? { ...promptPayload } 
    : promptPayload;
  const additions: string[] = [];

  if (characterGender && GENDER_PROMPT_HINTS[characterGender]) {
    additions.push(GENDER_PROMPT_HINTS[characterGender]);
  }

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
    
    const styleApplicationInstruction = 'Apply this creative style, lighting, composition, and visual atmosphere to the person in the uploaded image. Keep the person\'s face exactly as shown with 100% identical facial features, bone structure, skin tone, and appearance. Preserve all distinctive facial features, identity, age, and ethnicity. Only transform the style, environment, lighting, colors, and visual mood to match the described scene. Maintain natural appearance and professional quality with 1:1 aspect ratio, 8K ultra-high detail, and ultra-sharp facial features.';
    
    if (promptText.includes('Replace the original face')) {
      promptText = promptText.replace(/Replace the original face with the face from the image I will upload later\.[^.]*/g, styleApplicationInstruction);
    } else if (!promptText.includes('Apply this creative style')) {
      promptText = `${promptText} ${styleApplicationInstruction}`;
    }
    
    clone.prompt = promptText;
  } else {
    clone.prompt = 'Apply the creative style, lighting, composition, and visual atmosphere described in this preset to the person in the uploaded image. Keep the person\'s face exactly as shown with 100% identical facial features, bone structure, skin tone, and appearance. Preserve all distinctive facial features, identity, age, and ethnicity. Only transform the style, environment, lighting, colors, and visual mood. Maintain natural appearance and professional quality.';
  }
  
  return clone;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    if (request.method === 'POST' || request.method === 'PUT') {
      const maxSize = path === '/upload-url' || path === '/upload-thumbnails' ? 10 * 1024 * 1024 : 1024 * 1024;
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
        let gender: 'male' | 'female' | null = null;
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
          gender = (formData.get('gender') as 'male' | 'female') || null;
          action = formData.get('action') as string | null;
        } else if (contentType.toLowerCase().includes('application/json')) {
          const body = await request.json() as { 
            image_urls?: string[];
            image_url?: string;
            type?: string; 
            profile_id?: string; 
            presetName?: string; 
            enableVertexPrompt?: boolean; 
            gender?: 'male' | 'female';
            action?: string;
          };
          imageUrls = body.image_urls || (body.image_url ? [body.image_url] : []);
          type = body.type || '';
          profileId = body.profile_id || '';
          presetName = body.presetName || '';
          enableVertexPrompt = body.enableVertexPrompt === true;
          gender = body.gender || null;
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

        if (!type || !profileId) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { type, profileId, path } : undefined, request, env);
        }

        if (type !== 'preset' && type !== 'selfie') {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { type, path } : undefined, request, env);
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
              console.warn(`[Upload] Failed to fetch image from URL: ${imageResponse.status}`);
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
          const ext = fileData.contentType.split('/')[1] || 'jpg';
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
            console.error('R2 upload error:', r2Error instanceof Error ? r2Error.message.substring(0, 200) : String(r2Error).substring(0, 200));
            return {
              success: false,
              error: `R2 upload failed: ${r2Error instanceof Error ? r2Error.message.substring(0, 200) : String(r2Error).substring(0, 200)}`,
              filename: fileData.filename
            };
          }

          const publicUrl = getR2PublicUrl(env, key, requestUrl.origin);
          const createdAt = Math.floor(Date.now() / 1000);

          // Scan selfie uploads with vision API before saving to database (only for 4k/4K action)
          if (type === 'selfie') {
            const actionValue = action || 'default';
            const needsVisionCheck = actionValue.toLowerCase() === '4k';
            const disableSafeSearch = env.DISABLE_SAFE_SEARCH === 'true';
            if (needsVisionCheck && !disableSafeSearch) {
              const safeSearchResult = await checkSafeSearch(publicUrl, env);
              if (!safeSearchResult.isSafe) {
                // Delete from R2 if unsafe
                try {
                  await R2_BUCKET.delete(key);
                } catch (deleteError) {
                  console.warn('Failed to delete unsafe selfie from R2:', deleteError);
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
                  visionDetails: {
                    violationCategory: safeSearchResult.violationCategory,
                    violationLevel: safeSearchResult.violationLevel,
                    details: safeSearchResult.details,
                    rawResponse: safeSearchResult.rawResponse,
                    debug: safeSearchResult.debug,
                  },
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
                const promptResult = await generateVertexPrompt(publicUrl, env);
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
                console.warn('Failed to store prompt_json in R2 metadata:', metadataError);
              }
            }

            // Save to database (store only id and ext, prompt_json in R2 metadata)
            const result = await DB.prepare(
              'INSERT INTO presets (id, ext, created_at) VALUES (?, ?, ?)'
            ).bind(id, ext, createdAt).run();

            if (!result.success) {
              return {
                success: false,
                error: 'Database insert failed',
                filename: fileData.filename
              };
            }

            return {
              success: true,
              url: publicUrl,
              id: id,
              filename: `${id}.${ext}`,
              hasPrompt: !!promptJson,
              prompt_json: promptJson ? JSON.parse(promptJson) : null,
              vertex_info: vertexCallInfo
            };
          } else if (type === 'selfie') {
            let actionValue = action || 'default';
            const actionLower = actionValue.toLowerCase();
            
            // Normalize 4k action to lowercase for consistency
            if (actionLower === '4k') {
              actionValue = '4k';
            }

            // Helper function to delete old selfies
            const deleteOldSelfies = async (existingSelfies: any, maxCount: number, actionFilter: string) => {
              if (existingSelfies.results && existingSelfies.results.length > 0) {
                // Calculate how many we'll have after adding the new one
                const currentCount = existingSelfies.results.length;
                const totalAfterAdd = currentCount + 1;
                
                // If we'll exceed the limit, delete the oldest ones to make room
                if (totalAfterAdd > maxCount) {
                  const excessCount = totalAfterAdd - maxCount;
                  const toDelete = existingSelfies.results.slice(0, excessCount);
                  const idsToDelete = toDelete.map((s: any) => s.id);
                  if (idsToDelete.length > 0) {
                    const placeholders = idsToDelete.map(() => '?').join(',');
                    await DB.prepare(`DELETE FROM selfies WHERE id IN (${placeholders})`).bind(...idsToDelete).run();
                    
                    // Delete from R2
                    for (const oldSelfie of toDelete) {
                      const oldKey = reconstructR2Key((oldSelfie as any).id, (oldSelfie as any).ext, 'selfie');
                      try {
                        await R2_BUCKET.delete(oldKey);
                      } catch (r2Error) {
                        console.warn('Failed to delete old selfie from R2:', r2Error);
                      }
                    }
                  }
                }
              }
            };

            if (actionLower === 'faceswap') {
              const maxFaceswap = parseInt(env.SELFIE_MAX_FACESWAP || '5', 10);
              const existingSelfies = await DB.prepare(
                'SELECT id, ext FROM selfies WHERE profile_id = ? AND action = ? ORDER BY created_at ASC'
              ).bind(profileId, actionValue).all();
              await deleteOldSelfies(existingSelfies, maxFaceswap, actionValue);
            } else if (actionLower === 'wedding') {
              const maxWedding = parseInt(env.SELFIE_MAX_WEDDING || '2', 10);
              const existingSelfies = await DB.prepare(
                'SELECT id, ext FROM selfies WHERE profile_id = ? AND action = ? ORDER BY created_at ASC'
              ).bind(profileId, actionValue).all();
              await deleteOldSelfies(existingSelfies, maxWedding, actionValue);
            } else if (actionLower === '4k') {
              const max4K = parseInt(env.SELFIE_MAX_4K || '1', 10);
              // Query for both '4k' and '4K' to handle existing data with different cases
              const existingSelfies = await DB.prepare(
                'SELECT id, ext FROM selfies WHERE profile_id = ? AND (action = ? OR action = ?) ORDER BY created_at ASC'
              ).bind(profileId, '4k', '4K').all();
              await deleteOldSelfies(existingSelfies, max4K, '4k');
            } else {
              const maxOther = parseInt(env.SELFIE_MAX_OTHER || '1', 10);
              // For other actions, delete selfies with the same action
              const existingSelfies = await DB.prepare(
                'SELECT id, ext FROM selfies WHERE profile_id = ? AND action = ? ORDER BY created_at ASC'
              ).bind(profileId, actionValue).all();
              await deleteOldSelfies(existingSelfies, maxOther, actionValue);
            }

            const result = await DB.prepare(
              'INSERT INTO selfies (id, ext, profile_id, action, created_at) VALUES (?, ?, ?, ?, ?)'
            ).bind(id, ext, profileId, actionValue, createdAt).run();

            if (!result.success) {
              return {
                success: false,
                error: 'Database insert failed',
                filename: fileData.filename
              };
            }

            return {
              success: true,
              url: publicUrl,
              id: id,
              filename: `${id}.${ext}`,
              action: actionValue
            };
          }

          return { success: true, url: publicUrl };
        };

        // Process all files in parallel
        const results = await Promise.all(allFileData.map((fileData, index) => processFile(fileData, index)));

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
              debug: visionDetails.debug,
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

        const debugPayload = debugEnabled && vertexDebugData.length > 0 
          ? compact({ vertex: vertexDebugData })
          : undefined;

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
          status: 'success',
          message: failed.length === 0 
            ? 'Processing successful'
            : `Uploaded ${successful.length} of ${results.length} file${results.length !== 1 ? 's' : ''}`,
          code: 200,
          ...(debugPayload ? { debug: debugPayload } : {})
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        console.error('Upload error:', errorMsg);
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

    // Parse thumbnail filename: [type]_[sub_category]_[gender]_[position].[ext]
    // Type uses hyphens (face-swap), other parts use underscores
    // Example: face-swap_wedding_both_1.webp -> type: face-swap, sub_category: wedding, gender: both, position: 1
    // Returns remaining filename without type: wedding_both_1.webp
    function parseThumbnailFilename(filename: string): { type: string; sub_category: string; gender: string; position: number; format: string; remainingFilename: string } | null {
      const extMatch = filename.match(/\.(webp|json)$/i);
      if (!extMatch) return null;
      
      const format = extMatch[1].toLowerCase() === 'json' ? 'lottie' : 'webp';
      const nameWithoutExt = filename.replace(/\.(webp|json)$/i, '');
      const fileExtension = extMatch[1];
      
      // Format: [type]_[sub_category]_[gender]_[position]
      // Type can contain hyphens (face-swap), so we need to split carefully
      // Split by underscore and reconstruct: last part is position, second-to-last is gender, rest is type_sub_category
      const parts = nameWithoutExt.split('_');
      if (parts.length < 4) return null;
      
      const position = parseInt(parts[parts.length - 1], 10);
      if (isNaN(position)) return null;
      
      const gender = parts[parts.length - 2];
      // Everything before gender is type_sub_category, but type can have hyphens
      // First part is type (can have hyphens), rest is sub_category
      const type = parts[0]; // e.g., "face-swap"
      const sub_category = parts.slice(1, parts.length - 2).join('_'); // e.g., "wedding"
      
      // Remaining filename without type prefix: [sub_category]_[gender]_[position].[ext]
      const remainingFilename = `${sub_category}_${gender}_${position}.${fileExtension}`;
      
      return { type, sub_category, gender, position, format, remainingFilename };
    }

    // Handle thumbnail folder upload endpoint - processes both original presets and thumbnails
    if (path === '/upload-thumbnails' && request.method === 'POST') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        if (!contentType.toLowerCase().includes('multipart/form-data')) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { contentType, path } : undefined, request, env);
        }

        const formData = await request.formData();
        const files: Array<{ file: File; path: string }> = [];
        const fileEntries = formData.getAll('files');
        
        // Collect files with their paths
        for (const entry of fileEntries) {
          if (entry && typeof entry !== 'string') {
            const file = entry as any as File;
            const pathKey = Array.from(formData.keys()).find(k => k === `path_${file.name}`);
            const filePath = pathKey ? (formData.get(pathKey) as string || '') : '';
            files.push({ file, path: filePath });
          }
        }

        if (files.length === 0) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const DB = getD1Database(env);
        const R2_BUCKET = getR2Bucket(env);
        const requestUrl = new URL(request.url);
        const results: any[] = [];
        
        // Separate original presets from thumbnails
        const originalPresets: Array<{ file: File; path: string; parsed: any }> = [];
        const thumbnails: Array<{ file: File; path: string; parsed: any }> = [];

        // First pass: parse and categorize files
        for (const { file, path } of files) {
          const filename = file.name || '';
          const parsed = parseThumbnailFilename(filename);
          
          if (!parsed) {
            results.push({
              filename,
              success: false,
              error: 'Invalid filename format. Expected: [type]_[sub_category]_[gender]_[position].[webp|json]'
            });
            continue;
          }

          // Check if it's an original preset (in original_preset folder)
          if (path.includes('original_preset/')) {
            originalPresets.push({ file, path, parsed });
          } else {
            thumbnails.push({ file, path, parsed });
          }
        }

        // Process original presets first (create preset records)
        // Map: R2 key -> preset_id (for linking thumbnails)
        const presetMap = new Map<string, string>();
        
        // Step 1: Extract all potential IDs and batch check existing presets
        const potentialIds: string[] = [];
        const r2KeyToIdMap = new Map<string, string>();
        
        for (const { file, path, parsed } of originalPresets) {
          const r2Key = `original_preset/${parsed.type}/${parsed.remainingFilename.replace(/\.(webp|json)$/i, '')}/webp/${parsed.remainingFilename}`;
          const keyParts = r2Key.replace('preset/', '').split('.');
          if (keyParts.length >= 2) {
            const extractedId = keyParts.slice(0, -1).join('.');
            potentialIds.push(extractedId);
            r2KeyToIdMap.set(r2Key, extractedId);
          }
        }
        
        // Batch check existing presets
        const existingPresetsMap = new Map<string, string>();
        if (potentialIds.length > 0) {
          const uniqueIds = [...new Set(potentialIds)];
          const placeholders = uniqueIds.map(() => '?').join(',');
          const existingPresets = await DB.prepare(
            `SELECT id FROM presets WHERE id IN (${placeholders})`
          ).bind(...uniqueIds).all();
          
          if (existingPresets.results) {
            for (const preset of existingPresets.results) {
              existingPresetsMap.set((preset as any).id, (preset as any).id);
            }
          }
        }
        
        // Step 2: Process files and create/use presets
        for (const { file, path, parsed } of originalPresets) {
          try {
            const filename = file.name;
            
            // Build R2 key: original_preset/[type]/[remainingFilename]/webp/[remainingFilename]
            // Example: original_preset/face-swap/wedding_both_1/webp/wedding_both_1.webp
            const r2Key = `original_preset/${parsed.type}/${parsed.remainingFilename.replace(/\.(webp|json)$/i, '')}/webp/${parsed.remainingFilename}`;
            
            // Read and upload file
            const fileData = await file.arrayBuffer();
            await R2_BUCKET.put(r2Key, fileData, {
              httpMetadata: {
                contentType: 'image/webp',
                cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
              },
            });

            const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
            
            // Check if preset already exists
            let presetId: string | undefined = presetMap.get(r2Key);
            
            if (!presetId) {
              const extractedId = r2KeyToIdMap.get(r2Key);
              if (extractedId && existingPresetsMap.has(extractedId)) {
                presetId = extractedId;
                presetMap.set(r2Key, presetId);
              }
            }
            
            if (!presetId) {
                // Create new preset
                const newPresetId = nanoid(16);
              const keyParts = r2Key.replace('preset/', '').split('.');
              const ext = keyParts.length >= 2 ? keyParts[keyParts.length - 1] : 'jpg';
              const createdAt = Math.floor(Date.now() / 1000);
              
              await DB.prepare(
                'INSERT INTO presets (id, ext, created_at) VALUES (?, ?, ?)'
              ).bind(newPresetId, ext, createdAt).run();
              
              presetId = newPresetId;
              presetMap.set(r2Key, newPresetId);
            }

            results.push({
              filename,
              success: true,
              type: 'preset',
              preset_id: presetId,
              url: publicUrl
            });
          } catch (fileError) {
            results.push({
              filename: file.name || 'unknown',
              success: false,
              error: fileError instanceof Error ? fileError.message : String(fileError)
            });
          }
        }

        // Process thumbnails (UPDATE preset row with thumbnail fields - same row approach)
        // Collect all updates first, then batch execute
        const thumbnailUpdates: Array<{
          presetId: string;
          thumbnailKey: string;
          resolution: string;
          filename: string;
          r2Key: string;
          publicUrl: string;
          fileFormat: string;
        }> = [];
        
        for (const { file, path, parsed } of thumbnails) {
          try {
            const filename = file.name;
            
            // Extract resolution from path (webp_1x/, lottie_2x/, etc.)
            let resolution = '1x';
            const resolutionMatch = path.match(/(webp|lottie)_([\d.]+x)/i);
            if (resolutionMatch) {
              resolution = resolutionMatch[2];
            }

            const fileFormat = parsed.format;
            const isLottie = fileFormat === 'lottie';
            
            // Build R2 key: [format]_[resolution]/[type]/[remainingFilename]
            // Example: webp_1.5x/face-swap/portrait_female_1.webp
            // Example: lottie_2x/packs/autum_male_1.json
            const r2Key = `${fileFormat}_${resolution}/${parsed.type}/${parsed.remainingFilename}`;
            
            // Read and upload file
            const fileData = await file.arrayBuffer();
            const contentType = isLottie ? 'application/json' : 'image/webp';
            
            await R2_BUCKET.put(r2Key, fileData, {
              httpMetadata: {
                contentType,
                cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
              },
            });

            const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
            
            // Find preset by matching original_preset R2 path
            // Build expected original preset R2 key from thumbnail metadata
            const originalPresetR2Key = `original_preset/${parsed.type}/${parsed.remainingFilename.replace(/\.(webp|json)$/i, '')}/webp/${parsed.remainingFilename}`;
            
            // Find preset by image_url
            let presetId: string | undefined = presetMap.get(originalPresetR2Key);
            
            if (!presetId) {
              results.push({
                filename,
                success: false,
                error: 'Preset not found. Upload preset first before thumbnail.'
              });
              continue;
            }
            
            // Store only keys, not full URLs
            const thumbnailKey = extractR2KeyFromUrl(publicUrl) || publicUrl;
            
            thumbnailUpdates.push({
              presetId,
              thumbnailKey,
              resolution,
              filename,
              r2Key,
              publicUrl,
              fileFormat
            });
          } catch (fileError) {
            results.push({
              filename: file.name || 'unknown',
              success: false,
              error: fileError instanceof Error ? fileError.message : String(fileError)
            });
          }
        }
        
        // Batch execute updates grouped by resolution
        const updatesByResolution = new Map<string, Array<{ presetId: string; thumbnailKey: string; filename: string; r2Key: string; publicUrl: string; fileFormat: string }>>();
        
        for (const update of thumbnailUpdates) {
          const key = update.resolution;
          if (!updatesByResolution.has(key)) {
            updatesByResolution.set(key, []);
          }
          updatesByResolution.get(key)!.push({
            presetId: update.presetId,
            thumbnailKey: update.thumbnailKey,
            filename: update.filename,
            r2Key: update.r2Key,
            publicUrl: update.publicUrl,
            fileFormat: update.fileFormat
          });
        }
        
        // Execute updates - store R2 key in thumbnail_r2 (use 1x as primary if multiple resolutions)
        for (const [resolution, updates] of updatesByResolution.entries()) {
          // Use 1x resolution as primary thumbnail, or first available
          const primaryResolution = resolution === '1x' ? resolution : (updatesByResolution.has('1x') ? '1x' : resolution);
          
          if (resolution === primaryResolution) {
            // Execute updates in parallel - store R2 key in thumbnail_r2
            await Promise.all(updates.map(update => 
              DB.prepare('UPDATE presets SET thumbnail_r2 = ? WHERE id = ?').bind(update.thumbnailKey, update.presetId).run()
            ));
          }
          
          // Add successful results
          for (const update of updates) {
            results.push({
              filename: update.filename,
              success: true,
              type: 'thumbnail',
              preset_id: update.presetId,
              url: update.publicUrl,
              metadata: {
                format: update.fileFormat,
                resolution
              }
            });
          }
        }

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: {
            total: files.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            presets_created: originalPresets.length,
            thumbnails_created: thumbnails.length,
            results
          },
          status: 'success',
          message: `Processed ${results.filter(r => r.success).length} of ${files.length} files`,
          code: 200,
          ...(debugEnabled ? { debug: { filesProcessed: files.length, resultsCount: results.length } } : {})
        }, 200, request, env);
      } catch (error) {
        console.error('Thumbnail upload error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
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
        console.error('Profile creation error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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
        console.error('Profile retrieval error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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

        const profile: Profile = {
          id: (updatedResult as any).id,
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
        console.error('Profile update error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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
        console.error('Profile listing error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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
        
        // Reconstruct thumbnail URL from thumbnail_r2 if available
        let thumbnailUrl: string | null = null;
        let thumbnailFormat: string | null = null;
        let thumbnailResolution: string | null = null;
        if ((result as any).thumbnail_r2) {
          thumbnailUrl = getR2PublicUrl(env, (result as any).thumbnail_r2, requestUrl.origin);
          // Extract format and resolution from R2 key
          const r2KeyParts = (result as any).thumbnail_r2.split('/');
          if (r2KeyParts.length > 0) {
            const prefix = r2KeyParts[0];
            const formatMatch = prefix.match(/^(webp|lottie)/i);
            const resolutionMatch = prefix.match(/([\d.]+x)/i);
            thumbnailFormat = formatMatch ? formatMatch[1].toLowerCase() : null;
            thumbnailResolution = resolutionMatch ? resolutionMatch[1] : null;
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

        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: {
            id: (result as any).id,
            preset_url: presetUrl,
            image_url: presetUrl, // Alias for backward compatibility
            hasPrompt,
            prompt_json: promptJson,
            thumbnail_url: thumbnailUrl,
            thumbnail_format: thumbnailFormat,
            thumbnail_resolution: thumbnailResolution,
            created_at: (result as any).created_at ? new Date((result as any).created_at * 1000).toISOString() : new Date().toISOString()
          },
          status: 'success',
          message: 'Preset retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { presetId, hasPrompt } } : {})
        }, 200, request, env);
      } catch (error) {
        console.error('Get preset error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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

        const includeThumbnails = url.searchParams.get('include_thumbnails') === 'true';
        
        // By default, exclude presets with thumbnails
        let query = `
          SELECT
            id,
            ext,
            thumbnail_r2,
            created_at
          FROM presets
          WHERE ${includeThumbnails ? '1=1' : 'thumbnail_r2 IS NULL'}
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
        console.error('List presets error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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
        console.error('[DELETE] Delete preset exception:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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

        // Check if new schema (ext column exists) or old schema (selfie_url exists)
        const schemaCheck = await DB.prepare('PRAGMA table_info(selfies)').all();
        const hasExt = schemaCheck.results?.some((col: any) => col.name === 'ext');
        const hasUrl = schemaCheck.results?.some((col: any) => col.name === 'selfie_url');
        
        let query: string;
        const limitParam = url.searchParams.get('limit');
        let limit = 50;
        if (limitParam) {
          const parsedLimit = parseInt(limitParam, 10);
          if (!isNaN(parsedLimit) && parsedLimit > 0 && parsedLimit <= 50) {
            limit = parsedLimit;
          }
        }
        
        if (hasExt) {
          query = `SELECT id, ext, profile_id, action, created_at FROM selfies WHERE profile_id = ? ORDER BY created_at DESC LIMIT ${limit}`;
        } else if (hasUrl) {
          query = `SELECT id, selfie_url, profile_id, action, created_at FROM selfies WHERE profile_id = ? ORDER BY created_at DESC LIMIT ${limit}`;
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

        const result = await DB.prepare(query).bind(profileId).all();

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
        console.error('List selfies error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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
        console.error('[DELETE] Delete selfie exception:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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
        console.error('Get preset from thumbnail error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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
          preset_url, 
          thumbnail_url,
          thumbnail_url_1x,
          thumbnail_url_1_5x,
          thumbnail_url_2x,
          thumbnail_url_3x,
          created_at 
        FROM presets 
        WHERE thumbnail_url IS NOT NULL 
           OR thumbnail_url_1x IS NOT NULL 
           OR thumbnail_url_1_5x IS NOT NULL 
           OR thumbnail_url_2x IS NOT NULL 
           OR thumbnail_url_3x IS NOT NULL`;
        const bindings: any[] = [];
        
        query += ' ORDER BY created_at DESC';
        
        const stmt = DB.prepare(query);
        const result = bindings.length > 0 
          ? await stmt.bind(...bindings).all()
          : await stmt.all();
          
        // Map results to include all thumbnail resolutions
        const thumbnails = (result.results || []).map((row: any) => ({
          ...row,
          // Use 1x as primary thumbnail_url for backward compatibility
          thumbnail_url: row.thumbnail_url_1x || row.thumbnail_url || null
        }));
          
        const debugEnabled = isDebugEnabled(env);
        return jsonResponse({
          data: { thumbnails },
          status: 'success',
          message: 'Thumbnails retrieved successfully',
          code: 200,
          ...(debugEnabled ? { debug: { count: thumbnails.length } } : {})
        }, 200, request, env);
      } catch (error) {
        console.error('Get thumbnails error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
      }
    }

    if (path === '/results' && request.method === 'GET') {
      try {
        const url = new URL(request.url);
        const profileId = url.searchParams.get('profile_id');

        const genderParam = url.searchParams.get('gender');
        let genderFilter: 'male' | 'female' | null = null;

        if (genderParam) {
          if (genderParam === 'male' || genderParam === 'female') {
            genderFilter = genderParam;
          } else {
            const debugEnabled = isDebugEnabled(env);
            return errorResponse('', 400, debugEnabled ? { genderParam, path } : undefined, request, env);
        }
        }

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
        console.error('[Results] List results error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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
        console.error('[DELETE] Delete result exception:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
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

        // Parallelize all independent database queries
        const queries: Promise<any>[] = [
          DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first()
        ];

        if (hasPresetId) {
          queries.push(
            DB.prepare('SELECT id, ext FROM presets WHERE id = ?').bind(body.preset_image_id).first()
          );
        }

        if (hasSelfieIds && body.selfie_ids) {
          // Add all selfie lookups in parallel
          for (const selfieId of body.selfie_ids) {
            queries.push(
              DB.prepare('SELECT id, ext FROM selfies WHERE id = ?').bind(selfieId).first()
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

        // Extract selfie results
        const selfieUrls: string[] = [];
        const selfieIds: string[] = [];
        const selfieStartIndex = hasPresetId ? 2 : 1;

        if (hasSelfieIds && body.selfie_ids) {
          for (let i = 0; i < body.selfie_ids.length; i++) {
            const selfieResult = results[selfieStartIndex + i];
            if (!selfieResult) {
              return errorResponse(`Selfie with ID ${body.selfie_ids[i]} not found`, 404, debugEnabled ? { selfieId: body.selfie_ids[i], path } : undefined, request, env);
            }
            const storedKey = reconstructR2Key((selfieResult as any).id, (selfieResult as any).ext, 'selfie');
            const fullUrl = buildSelfieUrl(storedKey, env, requestUrl.origin);
            selfieUrls.push(fullUrl);
            selfieIds.push(body.selfie_ids[i]);
          }
        } else if (hasSelfieUrls) {
          selfieUrls.push(...body.selfie_image_urls!);
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
          characterGender: body.character_gender,
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
          body.additional_prompt,
          body.character_gender
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
                console.warn('[FaceSwap] Failed to parse/sanitize vertex failure response:', parseErr instanceof Error ? parseErr.message.substring(0, 200) : String(parseErr).substring(0, 200));
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
          console.error('FaceSwap failed:', faceSwapResult.Message || 'Unknown error');
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

        const disableSafeSearch = env.DISABLE_SAFE_SEARCH === 'true';
        const skipSafetyCheckForVertex = true; // Always skip for Vertex AI mode
        let safetyDebug: SafetyCheckDebug | null = null;

        // Early return if safety checks are disabled - skip Vision API call entirely
        if (disableSafeSearch || skipSafetyCheckForVertex) {
          safetyDebug = {
            checked: false,
            isSafe: true,
            error: skipSafetyCheckForVertex ? 'Safety check skipped for Vertex AI mode' : 'Safety check disabled via DISABLE_SAFE_SEARCH',
          };
        } else if (!disableSafeSearch && !skipSafetyCheckForVertex) {
          const safeSearchResult = await checkSafeSearch(faceSwapResult.ResultImageUrl, env);

          safetyDebug = {
            checked: true,
            isSafe: !!safeSearchResult.isSafe,
            statusCode: safeSearchResult.statusCode,
            violationCategory: safeSearchResult.violationCategory,
            violationLevel: safeSearchResult.violationLevel,
            details: safeSearchResult.details,
            error: safeSearchResult.error,
            rawResponse: safeSearchResult.rawResponse,
            debug: safeSearchResult.debug,
          };

          if (safeSearchResult.error) {
            console.error('[FaceSwap] Safe search error:', safeSearchResult.error?.substring(0, 200));
            const debugPayload = debugEnabled ? compact({
              request: requestDebug,
              provider: buildProviderDebug(faceSwapResult),
              vertex: undefined,
              vision: buildVisionDebug(safetyDebug),
            }) : undefined;
            return jsonResponse({
              data: null,
              status: 'error',
              message: `Safe search validation failed: ${safeSearchResult.error}`,
              code: 500,
              ...(debugPayload ? { debug: debugPayload } : {}),
            }, 500);
          }

          if (!safeSearchResult.isSafe) {
            const violationCategory = safeSearchResult.violationCategory || 'unsafe content';
            const violationLevel = safeSearchResult.violationLevel || 'LIKELY';
            const violationCode = safeSearchResult.statusCode || 1001;
            console.warn('[FaceSwap] Content blocked:', violationCategory, violationLevel, violationCode);
            const debugPayload = debugEnabled ? compact({
              request: requestDebug,
              provider: buildProviderDebug(faceSwapResult),
              vertex: undefined,
              vision: buildVisionDebug(safetyDebug),
            }) : undefined;
            // HTTP status must be 422, code field contains Vision API error code (1001-1005)
            return jsonResponse({
              data: null,
              status: 'error',
              message: `Content blocked: Image contains ${violationCategory} content (${violationLevel})`,
              code: violationCode,
              ...(debugPayload ? { debug: debugPayload } : {}),
            }, 422);
          }
        } else {
          safetyDebug = {
            checked: false,
            isSafe: true,
            error: skipSafetyCheckForVertex ? 'Safety check skipped for Vertex AI mode' : 'Safety check disabled via DISABLE_SAFE_SEARCH',
          };
        }

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

    // Handle aiBackground endpoint
    if (path === '/aiBackground' && request.method === 'POST') {
      try {
        const body: BackgroundRequest = await request.json();

        const hasPresetId = body.preset_image_id && body.preset_image_id.trim() !== '';
        const hasPresetUrl = body.preset_image_url && body.preset_image_url.trim() !== '';

        if (!hasPresetId && !hasPresetUrl) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (hasPresetId && hasPresetUrl) {
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

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();
        if (!profileCheck) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
        }

        let targetUrl: string;
        let presetName: string;
        let presetImageId: string | null = null;

        if (hasPresetId) {
          const presetResult = await DB.prepare(
            'SELECT id, ext FROM presets WHERE id = ?'
          ).bind(body.preset_image_id).first();

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
          const selfieResult = await DB.prepare(
            'SELECT id, ext FROM selfies WHERE id = ?'
          ).bind(body.selfie_id!).first();

          if (!selfieResult) {
            const debugEnabled = isDebugEnabled(env);
            return errorResponse(`Selfie with ID ${body.selfie_id} not found`, 404, debugEnabled ? { selfieId: body.selfie_id, path } : undefined, request, env);
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
          additionalPrompt: body.additional_prompt,
        });

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        const defaultMergePrompt = API_PROMPTS.MERGE_PROMPT_DEFAULT;

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
          console.error('[AIBackground] Merge failed:', mergeResult.Message || 'Unknown error');
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

        const disableSafeSearch = env.DISABLE_SAFE_SEARCH === 'true';
        const skipSafetyCheckForVertex = true;
        let safetyDebug: SafetyCheckDebug | null = null;

        // Early return if safety checks are disabled - skip Vision API call entirely
        if (disableSafeSearch || skipSafetyCheckForVertex) {
          safetyDebug = {
            checked: false,
            isSafe: true,
            error: skipSafetyCheckForVertex ? 'Safety check skipped for Vertex AI mode' : 'Safety check disabled via DISABLE_SAFE_SEARCH',
          };
        } else if (!disableSafeSearch && !skipSafetyCheckForVertex) {
          const safeSearchResult = await checkSafeSearch(mergeResult.ResultImageUrl, env);

          safetyDebug = {
            checked: true,
            isSafe: !!safeSearchResult.isSafe,
            statusCode: safeSearchResult.statusCode,
            violationCategory: safeSearchResult.violationCategory,
            violationLevel: safeSearchResult.violationLevel,
            details: safeSearchResult.details,
            error: safeSearchResult.error,
            rawResponse: safeSearchResult.rawResponse,
            debug: safeSearchResult.debug,
          };

          if (safeSearchResult.error) {
            console.error('[AIBackground] Safe search error:', safeSearchResult.error?.substring(0, 200));
            const debugEnabled = isDebugEnabled(env);
            const debugPayload = debugEnabled ? compact({
              request: requestDebug,
              provider: buildProviderDebug(mergeResult),
              vertex: undefined,
              vision: buildVisionDebug(safetyDebug),
            }) : undefined;
            return jsonResponse({
              data: null,
              status: 'error',
              message: '',
              code: 500,
              ...(debugPayload ? { debug: debugPayload } : {}),
            }, 500);
          }

          if (!safeSearchResult.isSafe) {
            const violationCategory = safeSearchResult.violationCategory || 'unsafe content';
            const violationLevel = safeSearchResult.violationLevel || 'LIKELY';
            const violationCode = safeSearchResult.statusCode || 1001;
            const debugEnabled = isDebugEnabled(env);
            const debugPayload = debugEnabled ? compact({
              request: requestDebug,
              provider: buildProviderDebug(mergeResult),
              vertex: undefined,
              vision: buildVisionDebug(safetyDebug),
            }) : undefined;
            // HTTP status must be 422, code field contains Vision API error code (1001-1005)
            return jsonResponse({
              data: null,
              status: 'error',
              message: `Content blocked: Image contains ${violationCategory} content (${violationLevel})`,
              code: violationCode,
              ...(debugPayload ? { debug: debugPayload } : {}),
            }, 422);
          }
        }

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

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();
        if (!profileCheck) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
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

        // Verify selfie exists and has action='4k' or '4K'
        const selfieCheck = await DB.prepare(
          'SELECT id, action FROM selfies WHERE id = ? AND profile_id = ?'
        ).bind(selfieId, body.profile_id).first<{ id: string; action: string | null }>();
        
        if (!selfieCheck) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Selfie not found', 404, debugEnabled ? { selfieId, profileId: body.profile_id, path } : undefined, request, env);
        }

        const selfieAction = selfieCheck.action?.toLowerCase();
        if (selfieAction !== '4k') {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('Only selfies with action="4k" or "4K" can be used for 4K upscaling', 400, debugEnabled ? { selfieId, selfieAction, path } : undefined, request, env);
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          const debugEnabled = isDebugEnabled(env);
          return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        const upscalerResult = await callUpscaler4k(body.image_url, env);

        if (!upscalerResult.Success || !upscalerResult.ResultImageUrl) {
          console.error('Upscaler4K failed:', upscalerResult.Message || 'Unknown error');
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

        const aspectRatio = (body.aspect_ratio as string) || ASPECT_RATIO_CONFIG.DEFAULT;
        const supportedRatios = ASPECT_RATIO_CONFIG.SUPPORTED;
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
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
          console.error('Enhance failed:', enhancedResult.Message || 'Unknown error');
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

        const aspectRatio = (body.aspect_ratio as string) || ASPECT_RATIO_CONFIG.DEFAULT;
        const supportedRatios = ASPECT_RATIO_CONFIG.SUPPORTED;
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
        const modelParam = body.model;

        const beautyResult = await callNanoBanana(
          'Beautify this portrait image by improving facial aesthetics: smooth skin texture, remove blemishes and acne, even out skin tone, subtly slim face and jawline, brighten eyes, enhance lips and eyebrows, slightly enlarge eyes if appropriate, soften or reshape nose subtly, and automatically adjust makeup. Maintain natural appearance and preserve facial structure.',
          body.image_url,
          body.image_url,
          env,
          validAspectRatio,
          modelParam
        );

        if (!beautyResult.Success || !beautyResult.ResultImageUrl) {
          console.error('Beauty failed:', beautyResult.Message || 'Unknown error');
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
          preset_image_id: string; 
          selfie_id?: string; 
          selfie_image_url?: string;
          profile_id: string; 
          aspect_ratio?: string; 
          model?: string | number;
          additional_prompt?: string;
        };

        if (!body.preset_image_id) {
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (!body.selfie_id && !body.selfie_image_url) {
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        if (!body.profile_id) {
          return errorResponse('', 400, debugEnabled ? { path } : undefined, request, env);
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) {
          return errorResponse('', 500, debugEnabled ? { error: envError, path } : undefined, request, env);
        }

        const hasSelfieId = body.selfie_id && body.selfie_id.trim() !== '';
        const hasSelfieUrl = body.selfie_image_url && body.selfie_image_url.trim() !== '';

        if (hasSelfieUrl && !validateImageUrl(body.selfie_image_url!, env)) {
          return errorResponse('', 400, undefined, request, env);
        }

        const queries: Promise<any>[] = [
          DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first(),
          DB.prepare('SELECT id, ext FROM presets WHERE id = ?').bind(body.preset_image_id).first()
        ];

        if (hasSelfieId) {
          queries.push(
            DB.prepare('SELECT id, ext FROM selfies WHERE id = ?').bind(body.selfie_id).first()
          );
        }

        const results = await Promise.all(queries);

        const profileCheck = results[0];
        if (!profileCheck) {
          return errorResponse('Profile not found', 404, debugEnabled ? { profileId: body.profile_id, path } : undefined, request, env);
        }

        const presetResult = results[1];
        if (!presetResult) {
          return errorResponse('Preset image not found', 404, debugEnabled ? { presetId: body.preset_image_id, path } : undefined, request, env);
        }

        let selfieUrl: string;
        if (hasSelfieId) {
          const selfieResult = results[2];
          if (!selfieResult) {
            return errorResponse('Selfie not found', 404, debugEnabled ? { selfieId: body.selfie_id, path } : undefined, request, env);
          }
          const storedKey = reconstructR2Key((selfieResult as any).id, (selfieResult as any).ext, 'selfie');
          selfieUrl = buildSelfieUrl(storedKey, env, requestUrl.origin);
        } else {
          selfieUrl = body.selfie_image_url!;
        }

        const presetImageId = body.preset_image_id;
        const r2Key = reconstructR2Key((presetResult as any).id, (presetResult as any).ext, 'preset');
        
        const promptCacheKV = env.PROMPT_CACHE_KV;
        const cacheKey = `prompt:${presetImageId}`;
        let storedPromptPayload: any = null;

        if (promptCacheKV) {
          try {
            const cachedPrompt = await getCachedAsync(cacheKey, async () =>
              await promptCacheKV.get(cacheKey)
            );
            if (cachedPrompt) {
              try {
                storedPromptPayload = JSON.parse(cachedPrompt);
              } catch {
                // Invalid JSON in cache, continue
              }
            }
          } catch {
            // Cache read failed, continue
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
            // R2 metadata read failed, continue
          }
        }

        if (!storedPromptPayload) {
          const presetImageUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
          const generateResult = await generateVertexPrompt(presetImageUrl, env);
          if (generateResult.success && generateResult.prompt) {
            storedPromptPayload = generateResult.prompt;
            const promptJsonString = JSON.stringify(storedPromptPayload);
            
            if (promptCacheKV) {
              promptCacheKV.put(cacheKey, promptJsonString, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {});
            }
            
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
          } else {
            return errorResponse('', 400, debugEnabled ? { error: 'Failed to generate prompt', path } : undefined, request, env);
          }
        }

        const transformedPrompt = transformPromptForFilter(storedPromptPayload);
        const augmentedPrompt = augmentVertexPrompt(
          transformedPrompt,
          body.additional_prompt,
          undefined
        );

        const aspectRatio = (body.aspect_ratio as string) || ASPECT_RATIO_CONFIG.DEFAULT;
        const supportedRatios = ASPECT_RATIO_CONFIG.SUPPORTED;
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
        const modelParam = body.model;

        const filterResult = await callNanoBanana(
          augmentedPrompt,
          selfieUrl,
          selfieUrl,
          env,
          validAspectRatio,
          modelParam
        );

        if (!filterResult.Success || !filterResult.ResultImageUrl) {
          console.error('Filter failed:', filterResult.Message || 'Unknown error');
          const failureCode = filterResult.StatusCode || 500;
          // HTTP status must be 200-599, so use 422 for Vision/Vertex errors (1000+), 500 for others
          const httpStatus = (failureCode >= 1000) ? 422 : (failureCode >= 200 && failureCode < 600 ? failureCode : 500);
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(filterResult),
            vertex: mergeVertexDebug(filterResult, undefined),
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: '',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, httpStatus);
        }

        let resultUrl = filterResult.ResultImageUrl;
        if (filterResult.ResultImageUrl?.startsWith('r2://')) {
          const r2ResultKey = filterResult.ResultImageUrl.replace('r2://', '');
          resultUrl = getR2PublicUrl(env, r2ResultKey, requestUrl.origin);
        }

        const savedResultId = await saveResultToDatabase(DB, resultUrl, body.profile_id, env, R2_BUCKET);

        const providerDebug = debugEnabled ? buildProviderDebug(filterResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(filterResult, undefined) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId !== null ? String(savedResultId) : null,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: filterResult.Message || 'Style filter applied successfully',
          code: 200,
          ...(debugEnabled && providerDebug && vertexDebug ? { debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
          }) } : {}),
        });
      } catch (error) {
        console.error('Filter unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const debugEnabled = isDebugEnabled(env);
        const errorMsg = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return errorResponse('', 500, debugEnabled ? { error: errorMsg, path, ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {}) } : undefined, request, env);
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

        const aspectRatio = (body.aspect_ratio as string) || ASPECT_RATIO_CONFIG.DEFAULT;
        const supportedRatios = ASPECT_RATIO_CONFIG.SUPPORTED;
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
        const modelParam = body.model;

        const restoredResult = await callNanoBanana(
          'Restore and enhance this damaged photo to a hyper-realistic, ultra-detailed image, 16K DSLR quality. Fix scratches, tears, noise, and blurriness. Enhance colors to vivid, vibrant tones while keeping natural skin tones. Perfectly sharpen details in face, eyes, hair, and clothing. Add realistic lighting, shadows, and depth of field. Photoshop-level professional retouching. High dynamic range, ultra-HD, lifelike textures, cinematic finish, crisp and clean background, fully restored and enhanced version of the original photo.',
          body.image_url,
          body.image_url,
          env,
          validAspectRatio,
          modelParam
        );

        if (!restoredResult.Success || !restoredResult.ResultImageUrl) {
          console.error('Restore failed:', restoredResult.Message || 'Unknown error');
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

        const aspectRatio = (body.aspect_ratio as string) || ASPECT_RATIO_CONFIG.DEFAULT;
        const supportedRatios = ASPECT_RATIO_CONFIG.SUPPORTED;
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
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
          console.error('Aging failed:', agingResult.Message || 'Unknown error');
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
