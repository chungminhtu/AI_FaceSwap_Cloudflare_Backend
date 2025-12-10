/// <reference types="@cloudflare/workers-types" />

import type { Env, FaceSwapRequest, FaceSwapResponse, UploadUrlRequest, Profile, RemoveBackgroundRequest } from './types';
import { CORS_HEADERS, jsonResponse, errorResponse } from './utils';
import { callFaceSwap, callNanoBanana, callNanoBananaMerge, checkSafeSearch, generateVertexPrompt, callUpscaler4k } from './services';
import { validateEnv, validateRequest } from './validators';

const DEFAULT_R2_BUCKET_NAME = '';

const globalScopeWithAccount = globalThis as typeof globalThis & {
  ACCOUNT_ID?: string;
  __CF_ACCOUNT_ID?: string;
  __ACCOUNT_ID?: string;
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

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
      'INSERT OR IGNORE INTO presets (id, preset_url, created_at) VALUES (?, ?, ?)'
    ).bind(systemPresetId, '', Math.floor(Date.now() / 1000)).run();
  }
  return systemPresetId;
};

const ensureSystemSelfie = async (DB: D1Database, profileId: string, imageUrl: string): Promise<string | null> => {
  try {
    const selfieResult = await DB.prepare(
      'SELECT id FROM selfies WHERE selfie_url = ? AND profile_id = ? LIMIT 1'
    ).bind(imageUrl, profileId).first();
    
    if (selfieResult) {
      return (selfieResult as any).id;
    }
    
    const systemSelfieId = `system_selfie_${profileId}_${Date.now()}`;
    const insertResult = await DB.prepare(
      'INSERT OR IGNORE INTO selfies (id, selfie_url, profile_id, created_at) VALUES (?, ?, ?, ?)'
    ).bind(systemSelfieId, imageUrl, profileId, Math.floor(Date.now() / 1000)).run();
    
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
  resultId: string,
  resultUrl: string,
  profileId: string,
  imageUrl: string,
  presetName: string
): Promise<boolean> => {
  try {
    const insertResult = await DB.prepare(
      'INSERT INTO results (id, preset_name, result_url, profile_id, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(resultId, presetName, resultUrl, profileId, Math.floor(Date.now() / 1000)).run();
    
    if (insertResult.success) {
      if ((insertResult.meta?.changes || 0) > 0) {
        return true;
      }
      const checkExisting = await DB.prepare('SELECT id FROM results WHERE id = ?').bind(resultId).first();
      return !!checkExisting;
    }
    
    return false;
  } catch (dbError) {
    return false;
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
  if (env.CUSTOM_DOMAIN) {
    return `${trimTrailingSlash(env.CUSTOM_DOMAIN)}/${key}`;
  }
  if (fallbackOrigin) {
    const bucketName = resolveBucketName(env);
    return `${trimTrailingSlash(fallbackOrigin)}/r2/${bucketName}/${key}`;
  }
  throw new Error('Unable to determine R2 public URL. Configure CUSTOM_DOMAIN environment variable.');
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
    
    if (env.CUSTOM_DOMAIN && urlObj.hostname === new URL(env.CUSTOM_DOMAIN).hostname) {
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
  return env.DEBUG === 'true' || env.DEBUG === '1';
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

const GENDER_PROMPT_HINTS: Record<'male' | 'female', string> = {
  male: 'Emphasize that the character is male with confident, masculine presence and styling.',
  female: 'Emphasize that the character is female with graceful, feminine presence and styling.',
};

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const DB = getD1Database(env);
    const R2_BUCKET = getR2Bucket(env);
    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;

    // Handle OPTIONS (CORS preflight) - must be before other handlers
    if (request.method === 'OPTIONS') {
      // For upload-proxy, allow PUT method explicitly
      if (path.startsWith('/upload-proxy/')) {
        return new Response(null, { 
          status: 204, 
          headers: { 
            ...CORS_HEADERS, 
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Max-Age': '86400' 
          } 
        });
      }
      // For all other endpoints
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' } });
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
        } else if (contentType.toLowerCase().includes('application/json')) {
          const body = await request.json() as { 
            image_urls?: string[];
            image_url?: string;
            type?: string; 
            profile_id?: string; 
            presetName?: string; 
            enableVertexPrompt?: boolean; 
            gender?: 'male' | 'female' 
          };
          imageUrls = body.image_urls || (body.image_url ? [body.image_url] : []);
          type = body.type || '';
          profileId = body.profile_id || '';
          presetName = body.presetName || '';
          enableVertexPrompt = body.enableVertexPrompt === true;
          gender = body.gender || null;
        } else {
          return errorResponse(`Content-Type must be multipart/form-data or application/json. Received: ${contentType}`, 400);
        }

        if (!type || !profileId) {
          return errorResponse('Missing required fields: type and profile_id', 400);
        }

        if (type !== 'preset' && type !== 'selfie') {
          return errorResponse('Type must be either "preset" or "selfie"', 400);
        }

        // Validate that profile exists
        const profileResult = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(profileId).first();
        if (!profileResult) {
          return errorResponse('Profile not found', 404);
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

        // Process image URLs
        for (const imageUrl of imageUrls) {
          try {
            const imageResponse = await fetch(imageUrl);
            if (!imageResponse.ok) {
              console.warn(`[Upload] Failed to fetch image from URL: ${imageResponse.status}`);
              continue; // Skip failed URLs
            }
            const fileData = await imageResponse.arrayBuffer();
            if (!fileData || fileData.byteLength === 0) {
              continue; // Skip empty data
            }
            const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
            const urlParts = imageUrl.split('/');
            let filename = urlParts[urlParts.length - 1] || `image_${Date.now()}.${contentType.split('/')[1] || 'jpg'}`;
            filename = filename.split('?')[0]; // Remove query parameters
            allFileData.push({
              fileData,
              filename,
              contentType
            });
          } catch (fetchError) {
            console.error('[Upload] Error fetching image from URL:', fetchError instanceof Error ? fetchError.message.substring(0, 200) : String(fetchError).substring(0, 200));
            // Continue with other files
          }
        }

        if (allFileData.length === 0) {
          return errorResponse('No valid files or image URLs provided', 400);
        }

        // Process all files in parallel
        const processFile = async (fileData: FileData, index: number): Promise<any> => {
          const timestamp = Date.now();
          const randomSuffix = Math.random().toString(36).substring(2, 15);
          const uniqueFilename = `${timestamp}_${index}_${randomSuffix}_${fileData.filename}`;
          const key = `${type}/${uniqueFilename}`;

          // Upload to R2
          try {
            await R2_BUCKET.put(key, fileData.fileData, {
              httpMetadata: {
                contentType: fileData.contentType,
                cacheControl: 'public, max-age=31536000, immutable',
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

            const imageId = `preset_${timestamp}_${randomSuffix}`;

            // Save to database
            const result = await DB.prepare(
              'INSERT INTO presets (id, preset_url, prompt_json, created_at) VALUES (?, ?, ?, ?)'
            ).bind(imageId, publicUrl, promptJson, createdAt).run();

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
              id: imageId,
              filename: uniqueFilename,
              hasPrompt: !!promptJson,
              prompt_json: promptJson ? JSON.parse(promptJson) : null,
              vertex_info: vertexCallInfo
            };
          } else if (type === 'selfie') {
            const selfieId = `selfie_${timestamp}_${randomSuffix}`;

            const result = await DB.prepare(
              'INSERT INTO selfies (id, selfie_url, profile_id, created_at) VALUES (?, ?, ?, ?)'
            ).bind(selfieId, publicUrl, profileId, createdAt).run();

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
              id: selfieId,
              filename: uniqueFilename
            };
          }

          return { success: true, url: publicUrl };
        };

        // Process all files in parallel
        const results = await Promise.all(allFileData.map((fileData, index) => processFile(fileData, index)));

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
        return errorResponse(
          `Upload failed: ${errorMsg}`, 
          500,
          { 
            error: errorMsg,
            ...(error instanceof Error && error.stack ? { stack: error.stack.substring(0, 500) } : {})
          }
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
          return errorResponse('Content-Type must be multipart/form-data', 400);
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
          return errorResponse('No files provided', 400);
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
                cacheControl: 'public, max-age=31536000, immutable',
              },
            });

            const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
            
            // Check if preset already exists by image_url (R2 path is unique)
            let presetId: string | undefined = presetMap.get(r2Key);
            
            if (!presetId) {
              // Check database for existing preset with same preset_url
              const existing = await DB.prepare(
                'SELECT id FROM presets WHERE preset_url = ?'
              ).bind(publicUrl).first();
              
              if (existing) {
                presetId = (existing as any).id as string;
                if (presetId) {
                  presetMap.set(r2Key, presetId);
                }
              } else {
                // Create new preset
                presetId = `preset_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
                const createdAt = Math.floor(Date.now() / 1000);
                
                await DB.prepare(
                  'INSERT INTO presets (id, preset_url, created_at) VALUES (?, ?, ?)'
                ).bind(presetId, publicUrl, createdAt).run();
                
                presetMap.set(r2Key, presetId);
              }
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
                cacheControl: 'public, max-age=31536000, immutable',
              },
            });

            const publicUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
            
            // Find preset by matching original_preset R2 path
            // Build expected original preset R2 key from thumbnail metadata
            const originalPresetR2Key = `original_preset/${parsed.type}/${parsed.remainingFilename.replace(/\.(webp|json)$/i, '')}/webp/${parsed.remainingFilename}`;
            const originalPresetUrl = getR2PublicUrl(env, originalPresetR2Key, requestUrl.origin);
            
            // Find preset by image_url
            let presetId: string | undefined = presetMap.get(originalPresetR2Key);
            
            if (!presetId) {
              // Try to find in database by preset_url
              const existing = await DB.prepare(
                'SELECT id FROM presets WHERE preset_url = ?'
              ).bind(originalPresetUrl).first();
              
              if (existing) {
                presetId = (existing as any).id as string;
                if (presetId) {
                  presetMap.set(originalPresetR2Key, presetId);
                }
              }
            }
            
            if (!presetId) {
              results.push({
                filename,
                success: false,
                error: 'Preset not found. Upload preset first before thumbnail.'
              });
              continue;
            }
            
            // UPDATE preset row with thumbnail fields (multiple resolutions)
            // Update the specific resolution column based on resolution value
            let updateQuery = '';
            if (resolution === '1x') {
              updateQuery = 'UPDATE presets SET thumbnail_url_1x = ?, thumbnail_url = ? WHERE id = ?';
              await DB.prepare(updateQuery).bind(publicUrl, publicUrl, presetId).run();
            } else if (resolution === '1.5x') {
              updateQuery = 'UPDATE presets SET thumbnail_url_1_5x = ? WHERE id = ?';
              await DB.prepare(updateQuery).bind(publicUrl, presetId).run();
            } else if (resolution === '2x') {
              updateQuery = 'UPDATE presets SET thumbnail_url_2x = ? WHERE id = ?';
              await DB.prepare(updateQuery).bind(publicUrl, presetId).run();
            } else if (resolution === '3x') {
              updateQuery = 'UPDATE presets SET thumbnail_url_3x = ? WHERE id = ?';
              await DB.prepare(updateQuery).bind(publicUrl, presetId).run();
            } else if (resolution === '4x') {
              updateQuery = 'UPDATE presets SET thumbnail_url_4x = ? WHERE id = ?';
              await DB.prepare(updateQuery).bind(publicUrl, presetId).run();
            } else {
              // Default to 1x if resolution not recognized
              updateQuery = 'UPDATE presets SET thumbnail_url_1x = ?, thumbnail_url = ? WHERE id = ?';
              await DB.prepare(updateQuery).bind(publicUrl, publicUrl, presetId).run();
            }

            results.push({
              filename,
              success: true,
              type: 'thumbnail',
              preset_id: presetId,
              url: publicUrl,
              metadata: {
                format: fileFormat,
                resolution
              }
            });
          } catch (fileError) {
            results.push({
              filename: file.name || 'unknown',
              success: false,
              error: fileError instanceof Error ? fileError.message : String(fileError)
            });
          }
        }

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
          code: 200
        });
      } catch (error) {
        console.error('Thumbnail upload error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Thumbnail upload failed: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }



    // Handle profile creation
    if (path === '/profiles' && request.method === 'POST') {
      try {
        const body = await request.json() as Partial<Profile & { userID?: string; id?: string }>;
        const profileId = body.userID || body.id || `profile_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

        const tableCheck = await DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='profiles'"
        ).first();
        
        if (!tableCheck) {
          console.error('ERROR: profiles table does not exist in database!');
          console.error('Database schema needs to be initialized. Run: wrangler d1 execute faceswap-db --remote --file=schema.sql');
          return errorResponse('Database schema not initialized. Please run database migration.', 500);
        }

        if (body.userID || body.id) {
          const existingProfile = await DB.prepare(
            'SELECT id FROM profiles WHERE id = ?'
          ).bind(profileId).first();
          
          if (existingProfile) {
            return errorResponse(`Profile with ID "${profileId}" already exists`, 409);
          }
        }

        const createdAt = Math.floor(Date.now() / 1000);
        const updatedAt = Math.floor(Date.now() / 1000);
        

        const result = await DB.prepare(
          'INSERT INTO profiles (id, name, email, avatar_url, preferences, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          profileId,
          body.name || null,
          body.email || null,
          body.avatar_url || null,
          body.preferences || null,
          createdAt,
          updatedAt
        ).run();


        if (!result.success) {
          console.error('[DB] Profile insert failed');
          const errorDetails = result.meta?.error || (result as any).error || 'Unknown database error';
          return errorResponse(`Failed to create profile: ${errorDetails.substring(0, 200)}`, 500);
        }

        if (result.meta?.changes === 0) {
          console.error('[DB] Profile insert returned 0 changes');
          return errorResponse('Failed to create profile: No rows inserted', 500);
        }

        const profile = {
          id: profileId,
          name: body.name || undefined,
          email: body.email || undefined,
          avatar_url: body.avatar_url || undefined,
          preferences: body.preferences || undefined,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        return jsonResponse(profile);
      } catch (error) {
        console.error('Profile creation error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Profile creation failed: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle profile retrieval
    if (path.startsWith('/profiles/') && request.method === 'GET') {
      try {
        const profileId = path.replace('/profiles/', '');
        const result = await DB.prepare(
          'SELECT id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles WHERE id = ?'
        ).bind(profileId).first();

        if (!result) {
          return errorResponse('Profile not found', 404);
        }

        const profile: Profile = {
          id: (result as any).id,
          name: (result as any).name || undefined,
          email: (result as any).email || undefined,
          avatar_url: (result as any).avatar_url || undefined,
          preferences: (result as any).preferences || undefined,
          created_at: new Date((result as any).created_at * 1000).toISOString(),
          updated_at: new Date((result as any).updated_at * 1000).toISOString()
        };

        return jsonResponse(profile);
      } catch (error) {
        console.error('Profile retrieval error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Profile retrieval failed: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle profile update
    if (path.startsWith('/profiles/') && request.method === 'PUT') {
      try {
        const profileId = path.replace('/profiles/', '');
        const body = await request.json() as Partial<Profile>;

        const result = await DB.prepare(
          'UPDATE profiles SET name = ?, email = ?, avatar_url = ?, preferences = ?, updated_at = ? WHERE id = ?'
        ).bind(
          body.name || null,
          body.email || null,
          body.avatar_url || null,
          body.preferences || null,
          Math.floor(Date.now() / 1000),
          profileId
        ).run();

        if (!result.success || result.meta?.changes === 0) {
          return errorResponse('Profile not found or update failed', 404);
        }

        // Return updated profile
        const updatedResult = await DB.prepare(
          'SELECT id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles WHERE id = ?'
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

        return jsonResponse(profile);
      } catch (error) {
        console.error('Profile update error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Profile update failed: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle profile listing (for admin/debugging)
    if (path === '/profiles' && request.method === 'GET') {
      try {
        const results = await DB.prepare(
          'SELECT id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles ORDER BY created_at DESC'
        ).all();

        const profiles: Profile[] = results.results?.map((row: any) => ({
          id: row.id,
          name: row.name || undefined,
          email: row.email || undefined,
          avatar_url: row.avatar_url || undefined,
          preferences: row.preferences || undefined,
          created_at: new Date(row.created_at * 1000).toISOString(),
          updated_at: new Date(row.updated_at * 1000).toISOString()
        })) || [];

        return jsonResponse({ profiles });
      } catch (error) {
        console.error('Profile listing error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Profile listing failed: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle preset listing
    // Get single preset by ID
    if (path.startsWith('/presets/') && path.split('/').length === 3 && request.method === 'GET') {
      try {
        const presetId = path.split('/presets/')[1];
        if (!presetId) {
          return errorResponse('Preset ID required', 400);
        }

        const DB = getD1Database(env);
        const result = await DB.prepare(
          'SELECT * FROM presets WHERE id = ?'
        ).bind(presetId).first();

        if (!result) {
          return errorResponse('Preset not found', 404);
        }

        return jsonResponse(result);
      } catch (error) {
        console.error('Get preset error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Failed to retrieve preset: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    if (path === '/presets' && request.method === 'GET') {
      try {
        // Gender filter removed - metadata is in R2 path, not DB
        const url = new URL(request.url);

        const includeThumbnails = url.searchParams.get('include_thumbnails') === 'true';
        
        // By default, exclude presets with thumbnails (check all thumbnail columns)
        let query = `
          SELECT
            id,
            preset_url,
            prompt_json,
            thumbnail_url,
            thumbnail_url_1x,
            thumbnail_url_1_5x,
            thumbnail_url_2x,
            thumbnail_url_3x,
            thumbnail_url_4x,
            created_at
          FROM presets
          WHERE ${includeThumbnails ? '1=1' : '(thumbnail_url IS NULL AND thumbnail_url_1x IS NULL AND thumbnail_url_1_5x IS NULL AND thumbnail_url_2x IS NULL AND thumbnail_url_3x IS NULL AND thumbnail_url_4x IS NULL)'}
        `;

        const params: any[] = [];

        query += ' ORDER BY created_at DESC';

        const imagesResult = await DB.prepare(query).bind(...params).all();

        if (!imagesResult || !imagesResult.results) {
          return jsonResponse({ presets: [] });
        }

        // Flatten to match frontend expectations
        const presets = imagesResult.results.map((row: any) => {
          // Use new columns if available, fallback to legacy thumbnail_url
          const thumbnailUrl = row.thumbnail_url_1x || row.thumbnail_url || null;
          
          return {
            id: row.id || '',
            preset_url: convertLegacyUrl(row.preset_url || '', env),
            hasPrompt: row.prompt_json ? true : false,
            prompt_json: row.prompt_json || null,
            thumbnail_url: thumbnailUrl,
            thumbnail_url_1x: row.thumbnail_url_1x || null,
            thumbnail_url_1_5x: row.thumbnail_url_1_5x || null,
            thumbnail_url_2x: row.thumbnail_url_2x || null,
            thumbnail_url_3x: row.thumbnail_url_3x || null,
            thumbnail_url_4x: row.thumbnail_url_4x || null,
            created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
          };
        });

        return jsonResponse({ presets });
      } catch (error) {
        console.error('List presets error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        // Return empty array instead of error to prevent UI breaking
        return jsonResponse({ presets: [] });
      }
    }

    // Handle preset deletion
    if (path.startsWith('/presets/') && request.method === 'DELETE') {
      try {
        const presetId = path.replace('/presets/', '');
        if (!presetId) {
          return errorResponse('Preset ID is required', 400);
        }


        // First, check if preset exists
        const checkResult = await DB.prepare(
          'SELECT id, preset_url FROM presets WHERE id = ?'
        ).bind(presetId).first();

        if (!checkResult) {
          return errorResponse('Preset not found', 404);
        }

        const imageUrl = (checkResult as any).preset_url;

        // Delete preset from database
        // NOTE: Results are NOT deleted when preset is deleted - they belong to profiles and should be preserved
        const deleteResult = await DB.prepare(
          'DELETE FROM presets WHERE id = ?'
        ).bind(presetId).run();

        if (!deleteResult.success || deleteResult.meta?.changes === 0) {
          return errorResponse('Preset not found or already deleted', 404);
        }

        // Try to delete from R2 (non-fatal if it fails)
        let r2Deleted = false;
        let r2Key = null;
        let r2Error = null;
        if (imageUrl) {
          try {
            const urlParts = imageUrl.split('/');
            r2Key = urlParts.slice(-2).join('/');
            
            await R2_BUCKET.delete(r2Key);
            r2Deleted = true;
          } catch (r2DeleteError) {
            r2Error = r2DeleteError instanceof Error ? r2DeleteError.message : String(r2DeleteError);
            // Continue - database deletion succeeded, R2 deletion is optional
          }
        }

        return jsonResponse({ 
          success: true, 
          message: 'Preset deleted successfully'
        });
      } catch (error) {
        console.error('[DELETE] Delete preset exception:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const errorMessage = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return jsonResponse({ 
          success: false, 
          message: `Failed to delete preset: ${errorMessage}`,
          debug: {
            presetId: path.replace('/presets/', ''),
            error: errorMessage,
            errorType: error instanceof Error ? error.constructor.name : typeof error
          }
        }, 500);
      }
    }

    // Handle selfies listing
    if (path === '/selfies' && request.method === 'GET') {
      try {
        // Check for required profile_id query parameter
        const url = new URL(request.url);
        const profileId = url.searchParams.get('profile_id');
        if (!profileId) {
          return errorResponse('profile_id query parameter is required', 400);
        }

        // Validate that profile exists
        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(profileId).first();
        if (!profileCheck) {
          return errorResponse('Profile not found', 404);
        }

        let query = 'SELECT id, selfie_url, profile_id, created_at FROM selfies WHERE profile_id = ? ORDER BY created_at DESC LIMIT 50';

        const result = await DB.prepare(query).bind(profileId).all();

        if (!result || !result.results) {
          return jsonResponse({ selfies: [] });
        }

        const selfies = result.results.map((row: any) => ({
          id: row.id || '',
          selfie_url: convertLegacyUrl(row.selfie_url || '', env),
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        return jsonResponse({ selfies });
      } catch (error) {
        console.error('List selfies error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        // Return empty array instead of error to prevent UI breaking
        return jsonResponse({ selfies: [] });
      }
    }

    // Handle selfie deletion
    if (path.startsWith('/selfies/') && request.method === 'DELETE') {
      try {
        const selfieId = path.replace('/selfies/', '');
        if (!selfieId) {
          return errorResponse('Selfie ID is required', 400);
        }

        // First, check if selfie exists
        const checkResult = await DB.prepare(
          'SELECT id, selfie_url FROM selfies WHERE id = ?'
        ).bind(selfieId).first();

        if (!checkResult) {
          return errorResponse('Selfie not found', 404);
        }

        const imageUrl = (checkResult as any).selfie_url;

        // Delete selfie from database
        // NOTE: Results are NOT deleted when selfie is deleted - they belong to profiles and should be preserved
        const deleteResult = await DB.prepare(
          'DELETE FROM selfies WHERE id = ?'
        ).bind(selfieId).run();

        if (!deleteResult.success || deleteResult.meta?.changes === 0) {
          return errorResponse('Selfie not found or already deleted', 404);
        }

        // Try to delete from R2 (non-fatal if it fails)
        let r2Deleted = false;
        let r2Key = null;
        let r2Error = null;
        if (imageUrl) {
          try {
            const urlParts = imageUrl.split('/');
            r2Key = urlParts.slice(-2).join('/');
            
            await R2_BUCKET.delete(r2Key);
            r2Deleted = true;
          } catch (r2DeleteError) {
            r2Error = r2DeleteError instanceof Error ? r2DeleteError.message : String(r2DeleteError);
            // Continue - database deletion succeeded, R2 deletion is optional
          }
        }

        return jsonResponse({ 
          success: true, 
          message: 'Selfie deleted successfully'
        });
      } catch (error) {
        console.error('[DELETE] Delete selfie exception:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const errorMessage = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return jsonResponse({ 
          success: false, 
          message: `Failed to delete selfie: ${errorMessage}`,
          debug: {
            selfieId: path.replace('/selfies/', ''),
            error: errorMessage,
            errorType: error instanceof Error ? error.constructor.name : typeof error
          }
        }, 500);
      }
    }


    // Handle results listing
    // Get preset_id from thumbnail_id (for mobile app) - thumbnail is in same row as preset
    if (path.startsWith('/thumbnails/') && path.endsWith('/preset') && request.method === 'GET') {
      try {
        const thumbnailId = path.split('/thumbnails/')[1]?.replace('/preset', '');
        if (!thumbnailId) {
          return errorResponse('Thumbnail ID required', 400);
        }

        const DB = getD1Database(env);
        // Thumbnail is stored in same row as preset, so the ID is the preset ID
        const preset = await DB.prepare(
          'SELECT id FROM presets WHERE id = ? AND thumbnail_url IS NOT NULL'
        ).bind(thumbnailId).first();

        if (!preset) {
          return errorResponse('Thumbnail not found', 404);
        }

        return jsonResponse({
          data: { preset_id: (preset as any).id },
          status: 'success',
          message: 'Preset ID retrieved successfully',
          code: 200
        });
      } catch (error) {
        console.error('Get preset from thumbnail error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Failed to retrieve preset ID: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
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
          thumbnail_url_4x,
          created_at 
        FROM presets 
        WHERE thumbnail_url IS NOT NULL 
           OR thumbnail_url_1x IS NOT NULL 
           OR thumbnail_url_1_5x IS NOT NULL 
           OR thumbnail_url_2x IS NOT NULL 
           OR thumbnail_url_3x IS NOT NULL 
           OR thumbnail_url_4x IS NOT NULL`;
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
          
        return jsonResponse({
          data: { thumbnails },
          status: 'success',
          message: 'Thumbnails retrieved successfully',
          code: 200
        });
      } catch (error) {
        console.error('Get thumbnails error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Failed to retrieve thumbnails: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
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
            return errorResponse(`Invalid gender parameter. Must be 'male' or 'female', received: '${genderParam}'`, 400);
        }
        }

        let query = 'SELECT id, preset_name, result_url, profile_id, created_at FROM results';
        const params: any[] = [];

        if (profileId) {
        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(profileId).first();
        if (!profileCheck) {
          return errorResponse('Profile not found', 404);
        }
          query += ' WHERE profile_id = ?';
          params.push(profileId);
        }

        query += ' ORDER BY created_at DESC LIMIT 50';

        const result = await DB.prepare(query).bind(...params).all();

        if (!result || !result.results) {
          return jsonResponse({ results: [] });
        }

        const results = result.results.map((row: any) => {
          const resultUrl = convertLegacyUrl(row.result_url || '', env);
          return {
            id: row.id || '',
            preset_name: row.preset_name || 'Unnamed',
            result_url: resultUrl,
            image_url: resultUrl,
            profile_id: row.profile_id || '',
            created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
          };
        });

        return jsonResponse({ results });
      } catch (error) {
        console.error('[Results] List results error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return jsonResponse({ results: [] });
      }
    }

    // Handle results deletion (reuse same pattern as presets/selfies)
    if (path.startsWith('/results/') && request.method === 'DELETE') {
      try {
        const resultId = path.replace('/results/', '');
        if (!resultId) {
          return errorResponse('Result ID is required', 400);
        }

        // First, check if result exists and get the R2 key
        const checkResult = await DB.prepare(
          'SELECT result_url FROM results WHERE id = ?'
        ).bind(resultId).first();

        if (!checkResult) {
          return errorResponse('Result not found', 404);
        }

        const resultUrl = (checkResult as any).result_url || '';

        // Delete from database
        const deleteResult = await DB.prepare(
          'DELETE FROM results WHERE id = ?'
        ).bind(resultId).run();

        if (!deleteResult.success || deleteResult.meta?.changes === 0) {
          return errorResponse('Result not found or already deleted', 404);
        }

        // Try to delete from R2 (non-fatal if it fails)
        let r2Deleted = false;
        let r2Key = null;
        let r2Error = null;
        if (resultUrl) {
          try {
            // Extract R2 key from URL (format: r2://key or https://.../key)
            if (resultUrl.startsWith('r2://')) {
              r2Key = resultUrl.replace('r2://', '');
            } else if (resultUrl.includes('/results/')) {
              r2Key = resultUrl.split('/results/')[1];
              if (!r2Key.startsWith('results/')) {
                r2Key = `results/${r2Key}`;
              }
            }

            if (r2Key) {
              await R2_BUCKET.delete(r2Key);
              r2Deleted = true;
            }
          } catch (r2DeleteError) {
            r2Error = r2DeleteError instanceof Error ? r2DeleteError.message : String(r2DeleteError);
          }
        }

        return jsonResponse({
          success: true,
          message: 'Result deleted successfully',
          debug: {
            resultId,
            databaseDeleted: deleteResult.meta?.changes || 0,
            r2Deleted,
            r2Key,
            r2Error: r2Error || null,
            resultUrl
          }
        });
      } catch (error) {
        console.error('[DELETE] Delete result exception:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        const errorMessage = error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200);
        return jsonResponse({ 
          success: false, 
          message: `Failed to delete result: ${errorMessage}`,
          debug: {
            resultId: path.replace('/results/', ''),
            error: errorMessage,
          }
        }, 500);
      }
    }




    // Handle face swap endpoint
    if (path === '/faceswap' && request.method === 'POST') {
      try {
        const body: FaceSwapRequest = await request.json();

        const envError = validateEnv(env, 'vertex');
        if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

        const requestError = validateRequest(body);
        if (requestError) return errorResponse(requestError, 400);

        // Validate selfie_ids or selfie_image_urls early
        const hasSelfieIds = Array.isArray(body.selfie_ids) && body.selfie_ids.length > 0;
        const hasSelfieUrls = Array.isArray(body.selfie_image_urls) && body.selfie_image_urls.length > 0;
        
        if (!hasSelfieIds && !hasSelfieUrls) {
          return errorResponse('Either selfie_ids or selfie_image_urls must be provided as a non-empty array', 400);
        }

        const hasPresetId = body.preset_image_id && body.preset_image_id.trim() !== '';
        const hasPresetUrl = body.preset_image_url && body.preset_image_url.trim() !== '';

        if (!hasPresetId && !hasPresetUrl) {
          return errorResponse('Either preset_image_id or preset_image_url must be provided', 400);
        }

        // Parallelize all independent database queries
        const queries: Promise<any>[] = [
          DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first()
        ];

        if (hasPresetId) {
          queries.push(
            DB.prepare('SELECT id, preset_url FROM presets WHERE id = ?').bind(body.preset_image_id).first()
          );
        }

        if (hasSelfieIds && body.selfie_ids) {
          // Add all selfie lookups in parallel
          for (const selfieId of body.selfie_ids) {
            queries.push(
              DB.prepare('SELECT id, selfie_url FROM selfies WHERE id = ?').bind(selfieId).first()
            );
          }
        }

        // Execute all queries in parallel
        const results = await Promise.all(queries);

        // Extract results
        const profileCheck = results[0];
        if (!profileCheck) {
          return errorResponse('Profile not found', 404);
        }

        let targetUrl: string = '';
        let presetName: string = '';
        let presetImageId: string | null = null;
        let presetResult: any = null;

        if (hasPresetId) {
          presetResult = results[1];
          if (!presetResult) {
            return errorResponse('Preset image not found', 404);
          }
          targetUrl = presetResult.preset_url;
          presetName = presetResult.preset_name || 'Unnamed Preset';
          presetImageId = body.preset_image_id || null;
        } else if (hasPresetUrl) {
          targetUrl = body.preset_image_url!;
          presetName = 'Result Preset';
          presetImageId = null;
        } else {
          // This should never happen due to earlier validation, but TypeScript needs this
          return errorResponse('Either preset_image_id or preset_image_url must be provided', 400);
        }

        // Extract selfie results
        const selfieUrls: string[] = [];
        const selfieIds: string[] = [];
        const selfieStartIndex = hasPresetId ? 2 : 1;

        if (hasSelfieIds && body.selfie_ids) {
          for (let i = 0; i < body.selfie_ids.length; i++) {
            const selfieResult = results[selfieStartIndex + i];
            if (!selfieResult) {
              return errorResponse(`Selfie with ID ${body.selfie_ids[i]} not found`, 404);
            }
            selfieUrls.push(selfieResult.selfie_url);
            selfieIds.push(body.selfie_ids[i]);
          }
        } else if (hasSelfieUrls) {
          selfieUrls.push(...body.selfie_image_urls!);
        }

        // Support multiple selfies for wedding faceswap (e.g., bride and groom)
        if (selfieUrls.length === 0) {
          return errorResponse('No valid selfie URLs found', 400);
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
        if (presetImageId) {
          promptResult = await DB.prepare(
            'SELECT prompt_json, preset_url FROM presets WHERE id = ?'
          ).bind(presetImageId).first();
        }

        let storedPromptPayload: any = null;

        if (promptResult && (promptResult as any).prompt_json) {
          const promptJson = (promptResult as any).prompt_json;
          if (promptJson && promptJson.trim() !== '') {
            try {
              storedPromptPayload = JSON.parse(promptJson);
            } catch (parseError) {
              console.error('[Vertex] Failed to parse stored prompt_json:', parseError instanceof Error ? parseError.message.substring(0, 200) : String(parseError).substring(0, 200));
            }
          }
        }

        if (!storedPromptPayload) {
          const presetImageUrl = (promptResult as any)?.preset_url || targetUrl;
          
          const generateResult = await generateVertexPrompt(presetImageUrl, env);
          if (generateResult.success && generateResult.prompt) {
            storedPromptPayload = generateResult.prompt;
            if (presetImageId) {
              const promptJsonString = JSON.stringify(storedPromptPayload);
              await DB.prepare(
                'UPDATE presets SET prompt_json = ? WHERE id = ?'
              ).bind(promptJsonString, presetImageId).run();
            }
          } else {
            return errorResponse(`Failed to generate prompt for preset image. ${generateResult.error || 'Unknown error'}. Please check that your Google Vertex AI credentials are configured correctly.`, 400);
          }
        }
        const augmentedPromptPayload = augmentVertexPrompt(
          storedPromptPayload,
          body.additional_prompt,
          body.character_gender
        );
        const vertexPromptPayload = augmentedPromptPayload;

        // Extract aspect ratio from request body, default to "1:1" if not provided
        const aspectRatio = (body.aspect_ratio as string) || "1:1";
        // Validate aspect ratio is one of the supported values for Vertex AI
        // Supported: "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
        const supportedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : "1:1";
        // NOTE: There is a known issue with Gemini 2.5 Flash Image where aspectRatio parameter
        // may not work correctly and may always return 1:1 images regardless of the specified ratio.
        // This is a limitation of the current API version.
        // For now, use the first selfie. In a full implementation, you might want to combine multiple selfies
        const faceSwapResult = await callNanoBanana(augmentedPromptPayload, targetUrl, sourceUrl, env, validAspectRatio);

          if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
            console.error('[Vertex] Nano Banana provider failed:', faceSwapResult.Message || 'Unknown error');

            let sanitizedVertexFailure: any = null;
            const fullResponse = (faceSwapResult as any).FullResponse;
            if (fullResponse) {
              try {
                const parsedResponse = typeof fullResponse === 'string' ? JSON.parse(fullResponse) : fullResponse;
                // Efficient sanitization - only sanitize 'data' field if it's a long string
                sanitizedVertexFailure = typeof parsedResponse === 'object' && parsedResponse !== null
                  ? Object.fromEntries(
                      Object.entries(parsedResponse).map(([key, value]) => 
                        key === 'data' && typeof value === 'string' && value.length > 100 
                          ? [key, '...'] 
                          : [key, value]
                      )
                    )
                  : parsedResponse;
              } catch (parseErr) {
                if (typeof fullResponse === 'string') {
                  sanitizedVertexFailure = fullResponse.substring(0, 500) + (fullResponse.length > 500 ? '...' : '');
                } else {
                  sanitizedVertexFailure = fullResponse;
                }
              }
            }

            const vertexDebugFailure = compact({
              prompt: vertexPromptPayload,
              response: sanitizedVertexFailure || (faceSwapResult as any).VertexResponse,
              curlCommand: (faceSwapResult as any).CurlCommand,
            });

            const debugEnabled = isDebugEnabled(env);
            const debugPayload = debugEnabled ? compact({
              request: requestDebug,
              provider: buildProviderDebug(faceSwapResult),
              vertex: vertexDebugFailure,
            }) : undefined;

            const failureCode = faceSwapResult.StatusCode || 500;

            return jsonResponse({
              data: null,
              status: 'error',
              message: faceSwapResult.Message || 'Nano Banana provider failed to generate image',
              code: failureCode,
              ...(debugPayload ? { debug: debugPayload } : {}),
            }, failureCode);
          }

          if (faceSwapResult.ResultImageUrl?.startsWith('r2://')) {
            const r2Key = faceSwapResult.ResultImageUrl.replace('r2://', '');
            const requestUrl = new URL(request.url);
            faceSwapResult.ResultImageUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
          }

        if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
          console.error('FaceSwap failed:', faceSwapResult.Message || 'Unknown error');
          const failureCode = faceSwapResult.StatusCode || 500;
          const debugEnabled = isDebugEnabled(env);
          const debugPayload = debugEnabled ? compact({
            request: requestDebug,
            provider: buildProviderDebug(faceSwapResult),
            vertex: mergeVertexDebug(faceSwapResult, vertexPromptPayload),
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: faceSwapResult.Message || 'Face swap provider error',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, failureCode);
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
            const debugEnabled = isDebugEnabled(env);
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
            console.warn('[FaceSwap] Content blocked:', violationCategory, violationLevel);
            const debugEnabled = isDebugEnabled(env);
            const debugPayload = debugEnabled ? compact({
              request: requestDebug,
              provider: buildProviderDebug(faceSwapResult),
              vertex: undefined,
              vision: buildVisionDebug(safetyDebug),
            }) : undefined;
            return jsonResponse({
              data: null,
              status: 'error',
              message: `Content blocked: Image contains ${violationCategory} content (${violationLevel})`,
              code: 422,
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
        try {
          storageDebug.attemptedDownload = true;
          const resultImageResponse = await fetch(faceSwapResult.ResultImageUrl);
          storageDebug.downloadStatus = resultImageResponse.status;
          if (resultImageResponse.ok && resultImageResponse.body) {
            // Stream directly to R2 instead of buffering in memory
            const resultKey = `results/result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.jpg`;
            await R2_BUCKET.put(resultKey, resultImageResponse.body, {
              httpMetadata: {
                contentType: resultImageResponse.headers.get('content-type') || 'image/jpeg',
                cacheControl: 'public, max-age=31536000, immutable',
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
            const resultId = `result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
            const insertResult = await DB.prepare(
              'INSERT INTO results (id, preset_name, result_url, profile_id, created_at) VALUES (?, ?, ?, ?, ?)'
            ).bind(resultId, presetName, resultUrl, body.profile_id, Math.floor(Date.now() / 1000)).run();
            
            if (insertResult.success && (insertResult.meta?.changes || 0) > 0) {
              databaseDebug.success = true;
              databaseDebug.resultId = resultId;
              savedResultId = resultId;
              databaseDebug.error = null;
            } else {
              databaseDebug.error = 'Database insert failed';
            }
          } catch (dbError) {
            databaseDebug.error = dbError instanceof Error ? dbError.message : String(dbError);
          }
        }

        const debugEnabled = isDebugEnabled(env);
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
            id: savedResultId,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: faceSwapResult.Message || 'Processing successful',
          code: 200,
          ...(debugPayload ? { debug: debugPayload } : {}),
        });
      } catch (error) {
        console.error('Unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle removeBackground endpoint
    if (path === '/removeBackground' && request.method === 'POST') {
      try {
        const body: RemoveBackgroundRequest = await request.json();

        const hasPresetId = body.preset_image_id && body.preset_image_id.trim() !== '';
        const hasPresetUrl = body.preset_image_url && body.preset_image_url.trim() !== '';

        if (!hasPresetId && !hasPresetUrl) {
          return errorResponse('Either preset_image_id or preset_image_url is required', 400);
        }

        if (hasPresetId && hasPresetUrl) {
          return errorResponse('Cannot provide both preset_image_id and preset_image_url. Please provide only one.', 400);
        }

        if (!body.profile_id) {
          return errorResponse('profile_id is required', 400);
        }

        const hasSelfieId = body.selfie_id && body.selfie_id.trim() !== '';
        const hasSelfieUrl = body.selfie_image_url && body.selfie_image_url.trim() !== '';

        if (!hasSelfieId && !hasSelfieUrl) {
          return errorResponse('Either selfie_id or selfie_image_url must be provided', 400);
        }

        if (hasSelfieId && hasSelfieUrl) {
          return errorResponse('Cannot provide both selfie_id and selfie_image_url. Please provide only one.', 400);
        }

        const DB = getD1Database(env);
        const R2_BUCKET = getR2Bucket(env);
        const requestUrl = new URL(request.url);

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();
        if (!profileCheck) {
          return errorResponse('Profile not found', 404);
        }

        let targetUrl: string;
        let presetName: string;
        let presetImageId: string | null = null;

        if (hasPresetId) {
          const presetResult = await DB.prepare(
            'SELECT id, preset_url FROM presets WHERE id = ?'
          ).bind(body.preset_image_id).first();

          if (!presetResult) {
            return errorResponse('Preset image not found', 404);
          }

          targetUrl = (presetResult as any).preset_url;
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
            'SELECT id, selfie_url FROM selfies WHERE id = ?'
          ).bind(body.selfie_id!).first();

          if (!selfieResult) {
            return errorResponse(`Selfie with ID ${body.selfie_id} not found`, 404);
          }

          selfieUrl = (selfieResult as any).selfie_url;
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
        if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

        const defaultMergePrompt = `You are a professional background removal specialist. Your task is to remove the background from the person in the image, creating a clean transparent background while preserving the person perfectly.

CRITICAL REQUIREMENTS:
1. PERFECT BACKGROUND REMOVAL:
   - Remove ALL background elements completely - walls, furniture, objects, scenery, everything behind the person
   - Create a 100% transparent background with no visible artifacts or remnants
   - Ensure clean, precise edges around the person with no halos, fringes, or color bleeding
   - Remove shadows cast on the background (but preserve shadows on the person's body/clothing if they are part of the person)

2. PRESERVE THE PERSON COMPLETELY:
   - Keep the person EXACTLY as they appear - same facial features, same body, same clothing, same pose
   - Do NOT alter, modify, or enhance the person's appearance in any way
   - Maintain 100% of the original person's details, colors, lighting, and visual quality
   - Preserve all fine details including hair strands, clothing textures, accessories, and facial features

3. PRECISE EDGE DETECTION:
   - Use advanced edge detection to identify the exact boundary between person and background
   - Handle complex edges like hair, transparent clothing, and fine details with precision
   - Remove background elements that may appear between fingers, arms, or other body parts
   - Ensure smooth, natural edges without jagged or pixelated borders

4. HANDLE COMPLEX AREAS:
   - For hair: Remove background between individual hair strands while keeping all hair visible
   - For clothing: Remove background visible through mesh, lace, or semi-transparent materials
   - For accessories: Remove background around glasses, jewelry, and other items while keeping them intact
   - For overlapping elements: Remove background from areas where body parts overlap (e.g., crossed arms)

5. MAINTAIN ORIGINAL QUALITY:
   - Preserve the original image resolution and quality
   - Keep all fine details, textures, and sharpness of the person
   - Maintain original colors, lighting, and contrast exactly as in the source image
   - Do NOT apply any filters, enhancements, or modifications to the person

6. TRANSPARENT BACKGROUND:
   - The final image must have a completely transparent background (alpha channel)
   - No white, black, or colored background - only transparency
   - The person should appear to float on a transparent canvas
   - Output format must support transparency (PNG with alpha channel)

7. NO ARTIFACTS OR RESIDUES:
   - Remove all background color spill or color contamination on edges
   - Eliminate any halos, fringes, or color bleeding from the removed background
   - Clean up any partial background elements that may remain
   - Ensure professional, studio-quality background removal

Remove the background completely and create a clean transparent image with the person perfectly preserved.`;

        let mergePrompt = defaultMergePrompt;
        if (body.additional_prompt) {
          mergePrompt = `${defaultMergePrompt} Additional instructions: ${body.additional_prompt}`;
        }

        const aspectRatio = (body.aspect_ratio as string) || "1:1";
        const supportedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : "1:1";

        const mergeResult = await callNanoBananaMerge(mergePrompt, selfieUrl, targetUrl, env, validAspectRatio);

        if (!mergeResult.Success || !mergeResult.ResultImageUrl) {
          console.error('[RemoveBackground] Merge failed:', mergeResult.Message || 'Unknown error');
          const failureCode = mergeResult.StatusCode || 500;
          const debugEnabled = isDebugEnabled(env);
          const debugPayload = debugEnabled ? compact({
            request: requestDebug,
            provider: buildProviderDebug(mergeResult),
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: mergeResult.Message || 'Merge provider error',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, failureCode);
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
            console.error('[RemoveBackground] Safe search error:', safeSearchResult.error?.substring(0, 200));
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
              message: `Safe search validation failed: ${safeSearchResult.error}`,
              code: 500,
              ...(debugPayload ? { debug: debugPayload } : {}),
            }, 500);
          }

          if (!safeSearchResult.isSafe) {
            const violationCategory = safeSearchResult.violationCategory || 'unsafe content';
            const violationLevel = safeSearchResult.violationLevel || 'LIKELY';
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
              message: `Content blocked: Image contains ${violationCategory} content (${violationLevel})`,
              code: 422,
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
          const resultImageResponse = await fetch(mergeResult.ResultImageUrl);
          storageDebug.downloadStatus = resultImageResponse.status;
          if (resultImageResponse.ok && resultImageResponse.body) {
            // Stream directly to R2 instead of buffering in memory
            const resultKey = `results/result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.jpg`;
            await R2_BUCKET.put(resultKey, resultImageResponse.body, {
              httpMetadata: {
                contentType: resultImageResponse.headers.get('content-type') || 'image/jpeg',
                cacheControl: 'public, max-age=31536000, immutable',
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
            const resultId = `result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
            const insertResult = await DB.prepare(
              'INSERT INTO results (id, preset_name, result_url, profile_id, created_at) VALUES (?, ?, ?, ?, ?)'
            ).bind(resultId, presetName, resultUrl, body.profile_id, Math.floor(Date.now() / 1000)).run();
            
            if (insertResult.success && (insertResult.meta?.changes || 0) > 0) {
              databaseDebug.success = true;
              databaseDebug.resultId = resultId;
              savedResultId = resultId;
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
            id: savedResultId,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: mergeResult.Message || 'Processing successful',
          code: 200,
          ...(debugPayload ? { debug: debugPayload } : {}),
        });
      } catch (error) {
        console.error('Unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle upscaler4k endpoint
    if (path === '/upscaler4k' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string };
        
        if (!body.image_url) {
          return errorResponse('image_url is required', 400);
        }

        if (!body.profile_id) {
          return errorResponse('profile_id is required', 400);
        }

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();
        if (!profileCheck) {
          return errorResponse('Profile not found', 404);
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

        // Check input image safety before upscaling
        const disableSafeSearch = env.DISABLE_SAFE_SEARCH === 'true';
        let inputSafetyDebug: SafetyCheckDebug | null = null;

        if (!disableSafeSearch) {
          const inputSafeSearchResult = await checkSafeSearch(body.image_url, env);
          inputSafetyDebug = {
            checked: true,
            isSafe: !!inputSafeSearchResult.isSafe,
            statusCode: inputSafeSearchResult.statusCode,
            violationCategory: inputSafeSearchResult.violationCategory,
            violationLevel: inputSafeSearchResult.violationLevel,
            details: inputSafeSearchResult.details,
            error: inputSafeSearchResult.error,
            rawResponse: inputSafeSearchResult.rawResponse,
            debug: inputSafeSearchResult.debug,
          };

          if (!inputSafeSearchResult.isSafe) {
            const debugEnabled = isDebugEnabled(env);
            const debugPayload = debugEnabled ? compact({
              inputSafety: buildVisionDebug(inputSafetyDebug),
            }) : undefined;
            return jsonResponse({
              data: null,
              ...(debugPayload ? { debug: debugPayload } : {}),
              status: 'error',
              message: `Input image failed safety check: ${inputSafeSearchResult.violationCategory || 'unsafe content detected'}`,
              code: 400,
            }, 400);
          }
        }

        const upscalerResult = await callUpscaler4k(body.image_url, env);

        if (!upscalerResult.Success || !upscalerResult.ResultImageUrl) {
          console.error('Upscaler4K failed:', upscalerResult.Message || 'Unknown error');
          const failureCode = upscalerResult.StatusCode || 500;
          const debugEnabled = isDebugEnabled(env);
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(upscalerResult),
            vertex: buildVertexDebug(upscalerResult),
            inputSafety: buildVisionDebug(inputSafetyDebug),
          }) : undefined;
          return jsonResponse({
            data: null,
            ...(debugPayload ? { debug: debugPayload } : {}),
            status: 'error',
            message: upscalerResult.Message || 'Upscaler4K provider error',
            code: failureCode,
          }, failureCode);
        }

        let resultUrl = upscalerResult.ResultImageUrl;
        if (upscalerResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = upscalerResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        // Check output image safety after upscaling
        let outputSafetyDebug: SafetyCheckDebug | null = null;

        if (!disableSafeSearch) {
          const outputSafeSearchResult = await checkSafeSearch(resultUrl, env);
          outputSafetyDebug = {
            checked: true,
            isSafe: !!outputSafeSearchResult.isSafe,
            statusCode: outputSafeSearchResult.statusCode,
            violationCategory: outputSafeSearchResult.violationCategory,
            violationLevel: outputSafeSearchResult.violationLevel,
            details: outputSafeSearchResult.details,
            error: outputSafeSearchResult.error,
            rawResponse: outputSafeSearchResult.rawResponse,
            debug: outputSafeSearchResult.debug,
          };

          if (!outputSafeSearchResult.isSafe) {
            const debugEnabled = isDebugEnabled(env);
            const debugPayload = debugEnabled ? compact({
              provider: buildProviderDebug(upscalerResult, resultUrl),
              vertex: buildVertexDebug(upscalerResult),
              inputSafety: buildVisionDebug(inputSafetyDebug),
              outputSafety: buildVisionDebug(outputSafetyDebug),
            }) : undefined;
            return jsonResponse({
              data: null,
              ...(debugPayload ? { debug: debugPayload } : {}),
              status: 'error',
              message: `Upscaled image failed safety check: ${outputSafeSearchResult.violationCategory || 'unsafe content detected'}`,
              code: 400,
            }, 400);
          }
        }

        const resultId = `result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
        const savedResultId: string = resultId;
        
        let saved = await saveResultToDatabase(DB, resultId, resultUrl, body.profile_id, body.image_url, '4K Upscale');
        if (!saved) {
          const directInsert = await DB.prepare(
            'INSERT INTO results (id, preset_name, result_url, profile_id, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(resultId, '4K Upscale', resultUrl, body.profile_id, Math.floor(Date.now() / 1000)).run();
          saved = directInsert.success === true;
        }

        const debugEnabled = isDebugEnabled(env);
        const providerDebug = debugEnabled ? buildProviderDebug(upscalerResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? buildVertexDebug(upscalerResult) : undefined;
        const debugPayload = debugEnabled ? compact({
          provider: providerDebug,
          vertex: vertexDebug,
          inputSafety: buildVisionDebug(inputSafetyDebug),
          outputSafety: buildVisionDebug(outputSafetyDebug),
        }) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId,
            resultImageUrl: resultUrl,
          },
          ...(debugPayload ? { debug: debugPayload } : {}),
          status: 'success',
          message: upscalerResult.Message || 'Upscaling completed',
          code: 200,
        });
      } catch (error) {
        console.error('Upscaler4K unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle enhance endpoint
    if (path === '/enhance' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string };

        if (!body.image_url) {
          return errorResponse('image_url is required', 400);
        }

        if (!body.profile_id) {
          return errorResponse('profile_id is required', 400);
        }

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();

        if (!profileCheck) {
          return errorResponse('Profile not found', 404);
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

        const aspectRatio = (body.aspect_ratio as string) || "1:1";
        const supportedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : "1:1";

        const enhancedResult = await callNanoBanana(
          'Enhance this image with better lighting, contrast, and sharpness. Improve overall image quality while maintaining natural appearance.',
          body.image_url,
          body.image_url,
          env,
          validAspectRatio
        );

        if (!enhancedResult.Success || !enhancedResult.ResultImageUrl) {
          console.error('Enhance failed:', enhancedResult.Message || 'Unknown error');
          const failureCode = enhancedResult.StatusCode || 500;
          const debugEnabled = isDebugEnabled(env);
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(enhancedResult),
            vertex: mergeVertexDebug(enhancedResult, undefined),
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: enhancedResult.Message || 'Enhancement failed',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, failureCode);
        }

        let resultUrl = enhancedResult.ResultImageUrl;
        if (enhancedResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = enhancedResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        const resultId = `result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
        const savedResultId: string = resultId;
        
        let saved = await saveResultToDatabase(DB, resultId, resultUrl, body.profile_id, body.image_url, 'Enhance');
        if (!saved) {
          const directInsert = await DB.prepare(
            'INSERT INTO results (id, preset_name, result_url, profile_id, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(resultId, 'Enhance', resultUrl, body.profile_id, Math.floor(Date.now() / 1000)).run();
          saved = directInsert.success === true;
        }

        const debugEnabled = isDebugEnabled(env);
        const providerDebug = debugEnabled ? buildProviderDebug(enhancedResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(enhancedResult, undefined) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId,
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
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle colorize endpoint
    if (path === '/colorize' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string; aspect_ratio?: string };

        if (!body.image_url) {
          return errorResponse('image_url is required', 400);
        }

        if (!body.profile_id) {
          return errorResponse('profile_id is required', 400);
        }

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();
        if (!profileCheck) {
          return errorResponse('Profile not found', 404);
        }

        const envError = validateEnv(env, 'vertex');
        if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

        const aspectRatio = (body.aspect_ratio as string) || "1:1";
        const supportedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : "1:1";

        const colorizedResult = await callNanoBanana(
          'Restore and enhance this damaged photo to a hyper-realistic, ultra-detailed image, 16K DSLR quality. Fix scratches, tears, noise, and blurriness. Enhance colors to vivid, vibrant tones while keeping natural skin tones. Perfectly sharpen details in face, eyes, hair, and clothing. Add realistic lighting, shadows, and depth of field. Photoshop-level professional retouching. High dynamic range, ultra-HD, lifelike textures, cinematic finish, crisp and clean background, fully restored and enhanced version of the original photo.',
          body.image_url,
          body.image_url,
          env,
          validAspectRatio
        );

        if (!colorizedResult.Success || !colorizedResult.ResultImageUrl) {
          console.error('Colorize failed:', colorizedResult.Message || 'Unknown error');
          const failureCode = colorizedResult.StatusCode || 500;
          const debugEnabled = isDebugEnabled(env);
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(colorizedResult),
            vertex: mergeVertexDebug(colorizedResult, undefined),
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: colorizedResult.Message || 'Colorization failed',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, failureCode);
        }

        let resultUrl = colorizedResult.ResultImageUrl;
        if (colorizedResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = colorizedResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        const resultId = `result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
        const savedResultId: string = resultId;
        
        let saved = await saveResultToDatabase(DB, resultId, resultUrl, body.profile_id, body.image_url, 'Colorize');
        if (!saved) {
          const directInsert = await DB.prepare(
            'INSERT INTO results (id, preset_name, result_url, profile_id, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(resultId, 'Colorize', resultUrl, body.profile_id, Math.floor(Date.now() / 1000)).run();
          saved = directInsert.success === true;
        }

        const debugEnabled = isDebugEnabled(env);
        const providerDebug = debugEnabled ? buildProviderDebug(colorizedResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(colorizedResult, undefined) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: colorizedResult.Message || 'Colorization completed',
          code: 200,
          ...(debugEnabled && providerDebug && vertexDebug ? { debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
          }) } : {}),
        });
      } catch (error) {
        console.error('Colorize unhandled error:', error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200));
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle aging endpoint
    if (path === '/aging' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; age_years?: number; profile_id?: string; aspect_ratio?: string };

        if (!body.image_url) {
          return errorResponse('image_url is required', 400);
        }

        if (!body.profile_id) {
          return errorResponse('profile_id is required', 400);
        }

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();
        if (!profileCheck) {
          return errorResponse('Profile not found', 404);
        }

        const ageYears = body.age_years || 20;
        const envError = validateEnv(env, 'vertex');
        if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

        const aspectRatio = (body.aspect_ratio as string) || "1:1";
        const supportedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
        const validAspectRatio = supportedRatios.includes(aspectRatio) ? aspectRatio : "1:1";

        // For now, implement aging using existing Nano Banana API
        // This is a placeholder - in production, you'd want a dedicated aging model
        const agingResult = await callNanoBanana(
          `Age this person by ${ageYears} years. Add realistic aging effects including facial wrinkles, gray hair, maturity in appearance while maintaining the person's identity and natural features. Make the changes subtle and realistic.`,
          body.image_url,
          body.image_url, // Use same image as target and source for aging
          env,
          validAspectRatio
        );

        if (!agingResult.Success || !agingResult.ResultImageUrl) {
          console.error('Aging failed:', agingResult.Message || 'Unknown error');
          const failureCode = agingResult.StatusCode || 500;
          const debugEnabled = isDebugEnabled(env);
          const debugPayload = debugEnabled ? compact({
            provider: buildProviderDebug(agingResult),
            vertex: mergeVertexDebug(agingResult, undefined),
          }) : undefined;
          return jsonResponse({
            data: null,
            status: 'error',
            message: agingResult.Message || 'Aging transformation failed',
            code: failureCode,
            ...(debugPayload ? { debug: debugPayload } : {}),
          }, failureCode);
        }

        let resultUrl = agingResult.ResultImageUrl;
        if (agingResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = agingResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
        }

        const resultId = `result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
        const savedResultId: string = resultId;
        
        let saved = await saveResultToDatabase(DB, resultId, resultUrl, body.profile_id, body.image_url, 'Aging');
        if (!saved) {
          const directInsert = await DB.prepare(
            'INSERT INTO results (id, preset_name, result_url, profile_id, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(resultId, 'Aging', resultUrl, body.profile_id, Math.floor(Date.now() / 1000)).run();
          saved = directInsert.success === true;
        }

        const debugEnabled = isDebugEnabled(env);
        const providerDebug = debugEnabled ? buildProviderDebug(agingResult, resultUrl) : undefined;
        const vertexDebug = debugEnabled ? mergeVertexDebug(agingResult, undefined) : undefined;

        return jsonResponse({
          data: {
            id: savedResultId,
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
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message.substring(0, 200) : String(error).substring(0, 200)}`, 500);
      }
    }

    // Handle config endpoint - returns public configuration
    if (path === '/config' && request.method === 'GET') {
      const workerCustomDomain = env.WORKER_CUSTOM_DOMAIN;
      const customDomain = env.CUSTOM_DOMAIN;

      return jsonResponse({
        workerCustomDomain: workerCustomDomain || null,
        customDomain: customDomain || null,
      });
    }

    // 404 for unmatched routes
    return errorResponse('Not found', 404);
  },
};
