/// <reference types="@cloudflare/workers-types" />

import type { Env, FaceSwapRequest, FaceSwapResponse, UploadUrlRequest, Profile } from './types';
import { CORS_HEADERS, jsonResponse, errorResponse } from './utils';
import { callFaceSwap, callNanoBanana, checkSafeSearch, generateVertexPrompt, callUpscaler4k } from './services';
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
      'INSERT OR IGNORE INTO presets (id, image_url, filename, preset_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(systemPresetId, '', 'system', 'System', Math.floor(Date.now() / 1000)).run();
  }
  return systemPresetId;
};

const ensureSystemSelfie = async (DB: D1Database, profileId: string, imageUrl: string): Promise<string | null> => {
  try {
    let selfieResult = await DB.prepare(
      'SELECT id FROM selfies WHERE image_url = ? AND profile_id = ? LIMIT 1'
    ).bind(imageUrl, profileId).first();
    
    if (!selfieResult) {
      const urlParts = imageUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      selfieResult = await DB.prepare(
        'SELECT id FROM selfies WHERE filename = ? AND profile_id = ? LIMIT 1'
      ).bind(filename, profileId).first();
    }
    
    if (selfieResult) {
      return (selfieResult as any).id;
    }
    
    const urlParts = imageUrl.split('/');
    const filename = urlParts[urlParts.length - 1] || `image_${Date.now()}.jpg`;
    const systemSelfieId = `system_selfie_${profileId}_${Date.now()}`;
    const insertResult = await DB.prepare(
      'INSERT OR IGNORE INTO selfies (id, image_url, filename, profile_id, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(systemSelfieId, imageUrl, filename, profileId, Math.floor(Date.now() / 1000)).run();
    
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

  const clone = JSON.parse(JSON.stringify(promptPayload));
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

    // Handle direct file upload endpoint - handles both preset and selfie uploads
    if (path === '/upload-url' && request.method === 'POST') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        if (!contentType.toLowerCase().includes('multipart/form-data')) {
          return errorResponse(`Content-Type must be multipart/form-data. Received: ${contentType}`, 400);
        }

        const formData = await request.formData();
        const file = formData.get('file') as unknown as File;
        const type = formData.get('type') as string;
        const profileId = formData.get('profile_id') as string;
        const presetName = formData.get('presetName') as string;
        const enableVertexPrompt = formData.get('enableVertexPrompt') === 'true';
        const enableVisionScan = formData.get('enableVisionScan') === 'true';
        const gender = formData.get('gender') as 'male' | 'female';

        if (!file || !type || !profileId) {
          return errorResponse('Missing required fields: file, type, and profile_id', 400);
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

        const fileData = await file.arrayBuffer();
        if (!fileData || fileData.byteLength === 0) {
          return errorResponse('Empty file data', 400);
        }

        // Generate a unique key for the file
        const filename = file.name || `upload_${Date.now()}`;
        const key = `${type}/${filename}`;

        console.log(`Upload request: type=${type}, key=${key}, content-type=${file.type}, size=${fileData.byteLength}`);

        // Upload to R2 with cache-control headers
        try {
          await R2_BUCKET.put(key, fileData, {
            httpMetadata: {
              contentType: file.type || 'image/jpeg',
              cacheControl: 'public, max-age=31536000, immutable', // 1 year cache
            },
          });
          console.log(`File uploaded successfully to R2: ${key}`);
        } catch (r2Error) {
          console.error('R2 upload error:', r2Error);
          return errorResponse(`R2 upload failed: ${r2Error instanceof Error ? r2Error.message : String(r2Error)}`, 500);
        }

        // Get the public URL (R2 CDN URL)
        const publicUrl = getR2PublicUrl(env, key, requestUrl.origin);

        // Save upload metadata to database based on type
        if (type === 'preset') {
          console.log('Processing preset upload:', key);

          // Perform Vision API safety scan if enabled
          let visionScanResult: { success: boolean; isSafe?: boolean; error?: string; rawResponse?: any } | null = null;
          if (enableVisionScan) {
            console.log('[Vision] Scanning preset image with Google Vision API for safety check...');
            try {
              const visionResult = await checkSafeSearch(publicUrl, env);
              visionScanResult = {
                success: visionResult.isSafe !== undefined,
                isSafe: visionResult.isSafe,
                error: visionResult.error,
                rawResponse: visionResult.rawResponse
              };
              if (visionResult.isSafe) {
                console.log('[Vision] ✅ Image passed safety check');
              } else {
                console.warn('[Vision] ⚠️ Image failed safety check:', visionResult.error);
              }
            } catch (visionError) {
              console.error('[Vision] ❌ Error during Vision API scan:', visionError);
              visionScanResult = {
                success: false,
                error: visionError instanceof Error ? visionError.message : String(visionError)
              };
            }
          } else {
            console.log('[Vision] Vision API scan skipped (not enabled)');
          }

          // Generate Vertex AI prompt only if enabled
          let vertexCallInfo: { success: boolean; error?: string; promptKeys?: string[]; debug?: any } = { success: false };
          let promptJson: string | null = null;

          if (enableVertexPrompt) {
            console.log('[Vertex] Generating prompt for uploaded preset image:', publicUrl);
            try {
              const promptResult = await generateVertexPrompt(publicUrl, env);
              if (promptResult.success && promptResult.prompt) {
                promptJson = JSON.stringify(promptResult.prompt);
                const promptKeys = Object.keys(promptResult.prompt);
                vertexCallInfo = {
                  success: true,
                  promptKeys,
                  debug: promptResult.debug
                };
                console.log('[Vertex] ✅ Generated prompt successfully, length:', promptJson.length);
              } else {
                vertexCallInfo = {
                  success: false,
                  error: promptResult.error || 'Unknown error',
                  debug: promptResult.debug
                };
                console.error('[Vertex] ❌ Failed to generate prompt:', promptResult.error);
              }
            } catch (vertexError) {
              const errorMsg = vertexError instanceof Error ? vertexError.message : String(vertexError);
              vertexCallInfo = {
                success: false,
                error: errorMsg,
                debug: { errorDetails: errorMsg }
              };
              console.error('[Vertex] ❌ Exception during prompt generation:', vertexError);
            }
          } else {
            console.log('[Vertex] Vertex AI prompt generation skipped (not enabled)');
          }

          // Always save image to database (even if prompt generation or vision scan failed)
          const imageId = `image_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          const createdAt = Math.floor(Date.now() / 1000);

          console.log(`[DB] Inserting preset image:`, {
            id: imageId,
            imageUrl: publicUrl,
            hasPrompt: !!promptJson,
            promptLength: promptJson ? promptJson.length : 0,
            createdAt
          });

          // Validate gender before insert
          const validGender = (gender === 'male' || gender === 'female') ? gender : null;

          // Insert into simplified presets table
          const result = await DB.prepare(
            'INSERT INTO presets (id, image_url, filename, preset_name, prompt_json, gender, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(imageId, publicUrl, filename, presetName || `Preset ${Date.now()}`, promptJson, validGender, createdAt).run();

          if (!result.success) {
            console.error('[DB] Insert result:', result);
            throw new Error(`Database insert failed: ${JSON.stringify(result)}`);
          }

          console.log(`[DB] Preset saved successfully:`, {
            imageId,
            presetName,
            hasPrompt: !!promptJson,
            meta: result.meta
          });

          // Verify the save by querying back
          const verify = await DB.prepare(
            'SELECT id, CASE WHEN prompt_json IS NOT NULL THEN 1 ELSE 0 END as has_prompt FROM presets WHERE id = ?'
          ).bind(imageId).first();

          if (verify) {
            console.log(`[DB] Verified save: id=${(verify as any).id}, has_prompt=${(verify as any).has_prompt}`);
          }

          return jsonResponse({
            success: true,
            url: publicUrl,
            id: imageId,
            filename: filename,
            hasPrompt: !!promptJson,
            prompt_json: promptJson ? JSON.parse(promptJson) : null,
            vertex_info: vertexCallInfo,
            vision_scan: visionScanResult
          });

        } else if (type === 'selfie') {
          console.log('Processing selfie upload:', key);

          const selfieId = `selfie_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          const createdAt = Math.floor(Date.now() / 1000);

          console.log(`Saving selfie to database: id=${selfieId}, url=${publicUrl}, filename=${filename}, created_at=${createdAt}`);

          const tableCheck = await DB.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='selfies'"
          ).first();

          if (!tableCheck) {
            console.error('ERROR: selfies table does not exist in database!');
            return errorResponse('Database schema not initialized. Please run database migration.', 500);
          }

          const result = await DB.prepare(
            'INSERT INTO selfies (id, image_url, filename, profile_id, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(selfieId, publicUrl, filename, profileId, createdAt).run();

          if (!result.success) {
            console.error('Database insert returned success=false:', result);
            return errorResponse('Failed to save selfie to database', 500);
          }

          console.log(`Selfie saved to database successfully: ${selfieId}`, {
            success: result.success,
            meta: result.meta
          });

          // Verify it was saved by querying it back
          const verifyResult = await DB.prepare(
            'SELECT id, image_url, filename FROM selfies WHERE id = ?'
          ).bind(selfieId).first();

          if (verifyResult) {
            console.log('Selfie verified in database:', verifyResult);
            return jsonResponse({
              success: true,
              url: publicUrl,
              id: selfieId,
              filename: filename
            });
          } else {
            console.error('CRITICAL: Selfie not found in database after insert!');
            return errorResponse('Selfie was not saved to database properly', 500);
          }
        }

        return jsonResponse({ success: true, url: publicUrl });
      } catch (error) {
        console.error('Upload error:', error);
        return errorResponse(`Upload failed: ${error instanceof Error ? error.message : String(error)}`, 500);
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
        
        console.log('[DB] Attempting to insert profile:', {
          profileId,
          name: body.name || null,
          email: body.email || null,
          avatar_url: body.avatar_url || null,
          preferences: body.preferences || null,
          createdAt,
          updatedAt
        });

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

        console.log('[DB] Profile insert result:', {
          success: result.success,
          meta: result.meta,
          changes: result.meta?.changes
        });

        if (!result.success) {
          console.error('[DB] Profile insert failed:', {
            success: result.success,
            meta: result.meta,
            error: (result as any).error
          });
          const errorDetails = result.meta?.error || (result as any).error || 'Unknown database error';
          return errorResponse(`Failed to create profile: ${errorDetails}`, 500);
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
        console.error('Profile creation error:', error);
        console.error('Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          errorType: error instanceof Error ? error.constructor.name : typeof error
        });
        return errorResponse(`Profile creation failed: ${error instanceof Error ? error.message : String(error)}`, 500);
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
        console.error('Profile retrieval error:', error);
        return errorResponse(`Profile retrieval failed: ${error instanceof Error ? error.message : String(error)}`, 500);
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
        console.error('Profile update error:', error);
        return errorResponse(`Profile update failed: ${error instanceof Error ? error.message : String(error)}`, 500);
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
        console.error('Profile listing error:', error);
        return errorResponse(`Profile listing failed: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle preset listing
    if (path === '/presets' && request.method === 'GET') {
      try {
        console.log('Fetching presets from database...');

        // Check for gender filter query parameter
        const url = new URL(request.url);
        const genderFilter = url.searchParams.get('gender') as 'male' | 'female' | null;

        let query = `
          SELECT
            id,
            image_url,
            filename,
            preset_name,
            prompt_json,
            gender,
            created_at
          FROM presets
        `;

        const params: any[] = [];

        if (genderFilter) {
          query += ' WHERE gender = ?';
          params.push(genderFilter);
          console.log(`Filtering presets by gender: ${genderFilter}`);
        }

        query += ' ORDER BY created_at DESC';

        const imagesResult = await DB.prepare(query).bind(...params).all();

        console.log('Presets query result:', {
          success: imagesResult.success,
          resultsCount: imagesResult.results?.length || 0,
          meta: imagesResult.meta,
          genderFilter: genderFilter || 'none'
        });

        if (!imagesResult || !imagesResult.results) {
          console.log('No presets found in database');
          return jsonResponse({ presets: [] });
        }

        // Flatten to match frontend expectations
        const presets = imagesResult.results.map((row: any) => ({
          id: row.id || '',
          image_url: convertLegacyUrl(row.image_url || '', env),
          filename: row.filename || row.image_url?.split('/').pop() || `preset_${row.id}.jpg`,
          preset_name: row.preset_name || null,
          hasPrompt: row.prompt_json ? true : false,
          prompt_json: row.prompt_json || null,
          gender: row.gender || null,
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        console.log(`Returning ${presets.length} presets${genderFilter ? ` (filtered by gender: ${genderFilter})` : ''}`);
        return jsonResponse({ presets });
      } catch (error) {
        console.error('List presets error:', error);
        console.error('Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
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
          'SELECT id, image_url FROM presets WHERE id = ?'
        ).bind(presetId).first();

        if (!checkResult) {
          console.warn(`[DELETE] Preset not found: ${presetId}`);
          return errorResponse('Preset not found', 404);
        }

        const imageUrl = (checkResult as any).image_url;

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
            console.log(`[DELETE] Successfully deleted from R2: ${r2Key}`);
          } catch (r2DeleteError) {
            r2Error = r2DeleteError instanceof Error ? r2DeleteError.message : String(r2DeleteError);
            console.warn('[DELETE] R2 delete error (non-fatal):', r2Error);
            // Continue - database deletion succeeded, R2 deletion is optional
          }
        }

        return jsonResponse({ 
          success: true, 
          message: 'Preset deleted successfully'
        });
      } catch (error) {
        console.error('[DELETE] Delete preset exception:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
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
        console.log('Fetching selfies from database...');

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

        let query = 'SELECT id, image_url, filename, profile_id, created_at FROM selfies WHERE profile_id = ? ORDER BY created_at DESC LIMIT 50';

        const result = await DB.prepare(query).bind(profileId).all();

        console.log('Selfies query result:', {
          success: result.success,
          resultsCount: result.results?.length || 0,
          meta: result.meta,
          profileId: profileId
        });

        if (!result || !result.results) {
          console.log('No selfies found in database');
          return jsonResponse({ selfies: [] });
        }

        const selfies = result.results.map((row: any) => ({
          id: row.id || '',
          image_url: convertLegacyUrl(row.image_url || '', env),
          filename: row.filename || '',
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        console.log(`Returning ${selfies.length} selfies`);
        return jsonResponse({ selfies });
      } catch (error) {
        console.error('List selfies error:', error);
        console.error('Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
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
          'SELECT id, image_url FROM selfies WHERE id = ?'
        ).bind(selfieId).first();

        if (!checkResult) {
          return errorResponse('Selfie not found', 404);
        }

        const imageUrl = (checkResult as any).image_url;

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
            console.log(`[DELETE] Successfully deleted from R2: ${r2Key}`);
          } catch (r2DeleteError) {
            r2Error = r2DeleteError instanceof Error ? r2DeleteError.message : String(r2DeleteError);
            console.warn('[DELETE] R2 delete error (non-fatal):', r2Error);
            // Continue - database deletion succeeded, R2 deletion is optional
          }
        }

        return jsonResponse({ 
          success: true, 
          message: 'Selfie deleted successfully'
        });
      } catch (error) {
        console.error('[DELETE] Delete selfie exception:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
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
        console.error('[Results] List results error:', error);
        console.error('[Results] Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
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

        console.log(`[DELETE] Deleting result: ${resultId}`);

        // First, check if result exists and get the R2 key
        const checkResult = await DB.prepare(
          'SELECT result_url FROM results WHERE id = ?'
        ).bind(resultId).first();

        if (!checkResult) {
          console.warn(`[DELETE] Result not found: ${resultId}`);
          return errorResponse('Result not found', 404);
        }

        const resultUrl = (checkResult as any).result_url || '';

        // Delete from database
        const deleteResult = await DB.prepare(
          'DELETE FROM results WHERE id = ?'
        ).bind(resultId).run();

        if (!deleteResult.success || deleteResult.meta?.changes === 0) {
          console.warn(`[DELETE] No rows deleted for result: ${resultId}`);
          return errorResponse('Result not found or already deleted', 404);
        }

        console.log(`[DELETE] Successfully deleted result from database: ${resultId}`);

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
              console.log(`[DELETE] Successfully deleted from R2: ${r2Key}`);
            }
          } catch (r2DeleteError) {
            r2Error = r2DeleteError instanceof Error ? r2DeleteError.message : String(r2DeleteError);
            console.warn('[DELETE] R2 delete error (non-fatal):', r2Error);
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
        console.error('[DELETE] Delete result exception:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
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

        const profileCheck = await DB.prepare(
          'SELECT id FROM profiles WHERE id = ?'
        ).bind(body.profile_id).first();

        if (!profileCheck) {
          return errorResponse('Profile not found', 404);
        }

        // Look up preset image URL from database
        const presetResult = await DB.prepare(
          'SELECT id, image_url, preset_name FROM presets WHERE id = ?'
        ).bind(body.preset_image_id).first();

        if (!presetResult) {
          return errorResponse('Preset image not found', 404);
        }

        // Validate selfie_ids or selfie_image_urls
        const hasSelfieIds = Array.isArray(body.selfie_ids) && body.selfie_ids.length > 0;
        const hasSelfieUrls = Array.isArray(body.selfie_image_urls) && body.selfie_image_urls.length > 0;
        
        if (!hasSelfieIds && !hasSelfieUrls) {
          return errorResponse('Either selfie_ids or selfie_image_urls must be provided as a non-empty array', 400);
        }

        // Look up all selfie image URLs from database or use provided URLs
        const selfieUrls: string[] = [];
        const selfieIds: string[] = [];

        if (hasSelfieIds) {
          for (const selfieId of body.selfie_ids!) {
            const selfieResult = await DB.prepare(
              'SELECT id, image_url FROM selfies WHERE id = ?'
            ).bind(selfieId).first();

            if (!selfieResult) {
              return errorResponse(`Selfie with ID ${selfieId} not found`, 404);
            }

            selfieUrls.push((selfieResult as any).image_url);
            selfieIds.push(selfieId);
          }
        } else if (hasSelfieUrls) {
          selfieUrls.push(...body.selfie_image_urls!);
        }

        const targetUrl = (presetResult as any).image_url;
        const presetName = (presetResult as any).preset_name || 'Unnamed Preset';

        // For now, use the first selfie as the primary source
        // In a full implementation, you might want to combine multiple selfies
        const sourceUrl = selfieUrls[0];

        const requestDebug = compact({
          targetUrl: targetUrl,
          sourceUrls: selfieUrls,
          presetImageId: body.preset_image_id,
          presetName: presetName,
          selfieIds: selfieIds,
          additionalPrompt: body.additional_prompt,
          characterGender: body.character_gender,
        });

        console.log('[Vertex] Using Vertex AI-generated prompt for preset:', body.preset_image_id);

        let promptResult = await DB.prepare(
          'SELECT prompt_json, image_url FROM presets WHERE id = ?'
        ).bind(body.preset_image_id).first();

        let storedPromptPayload: any = null;

        if (promptResult && (promptResult as any).prompt_json) {
          const promptJson = (promptResult as any).prompt_json;
          if (promptJson && promptJson.trim() !== '') {
            try {
              storedPromptPayload = JSON.parse(promptJson);
            } catch (parseError) {
              console.error('[Vertex] Failed to parse stored prompt_json:', parseError);
            }
          }
        }

        if (!storedPromptPayload) {
          console.log('[Vertex] No valid prompt_json found in database, generating on-the-fly for preset:', body.preset_image_id);
          const presetImageUrl = (promptResult as any)?.image_url || targetUrl;
          
          const generateResult = await generateVertexPrompt(presetImageUrl, env);
          if (generateResult.success && generateResult.prompt) {
            storedPromptPayload = generateResult.prompt;
            const promptJsonString = JSON.stringify(storedPromptPayload);
            
            await DB.prepare(
              'UPDATE presets SET prompt_json = ? WHERE id = ?'
            ).bind(promptJsonString, body.preset_image_id).run();
            
            console.log('[Vertex] Generated and saved prompt_json to database for preset:', body.preset_image_id);
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

        console.log('[Vertex] Dispatching prompt to Nano Banana provider with', selfieUrls.length, 'selfie(s)');
        // Extract aspect ratio from request body, default to "1:1" if not provided
        console.log('[Vertex] Full request body:', JSON.stringify(body, null, 2));
        console.log('[Vertex] body.aspect_ratio value:', body.aspect_ratio);
        console.log('[Vertex] body.aspect_ratio type:', typeof body.aspect_ratio);
        // Validate aspect ratio is one of the supported values for Vertex AI
        // Supported: "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
        const supportedRatios = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
        const providedAspectRatio = body.aspect_ratio && typeof body.aspect_ratio === 'string' ? body.aspect_ratio.trim() : null;
        const validAspectRatio = providedAspectRatio && supportedRatios.includes(providedAspectRatio) ? providedAspectRatio : "1:1";
        console.log('[Vertex] Provided aspect ratio:', providedAspectRatio);
        console.log('[Vertex] Using validated aspect ratio:', validAspectRatio);
        console.log('[Vertex] Passing aspect ratio to callNanoBanana:', validAspectRatio);
        // NOTE: There is a known issue with Gemini 2.5 Flash Image where aspectRatio parameter
        // may not work correctly and may always return 1:1 images regardless of the specified ratio.
        // This is a limitation of the current API version.
        // For now, use the first selfie. In a full implementation, you might want to combine multiple selfies
        const faceSwapResult = await callNanoBanana(augmentedPromptPayload, targetUrl, sourceUrl, env, validAspectRatio);
        console.log('[Vertex] callNanoBanana completed with aspect ratio:', validAspectRatio);

          if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
            console.error('[Vertex] Nano Banana provider failed:', JSON.stringify(faceSwapResult, null, 2));

            let sanitizedVertexFailure: any = null;
            const fullResponse = (faceSwapResult as any).FullResponse;
            if (fullResponse) {
              try {
                const parsedResponse = typeof fullResponse === 'string' ? JSON.parse(fullResponse) : fullResponse;
                sanitizedVertexFailure = JSON.parse(JSON.stringify(parsedResponse, (key, value) => {
                  if (key === 'data' && typeof value === 'string' && value.length > 100) {
                    return '...';
                  }
                  return value;
                }));
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

            const debugPayload = compact({
              request: requestDebug,
              provider: buildProviderDebug(faceSwapResult),
              vertex: vertexDebugFailure,
            });

            const failureCode = faceSwapResult.StatusCode || 500;

            return jsonResponse({
              data: null,
              status: 'error',
              message: faceSwapResult.Message || 'Nano Banana provider failed to generate image',
              code: failureCode,
              debug: debugPayload,
            }, failureCode);
          }

          if (faceSwapResult.ResultImageUrl?.startsWith('r2://')) {
            const r2Key = faceSwapResult.ResultImageUrl.replace('r2://', '');
            const requestUrl = new URL(request.url);
            faceSwapResult.ResultImageUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
            console.log('[Vertex] Converted R2 URL to public URL:', faceSwapResult.ResultImageUrl);
          }

        if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
          console.error('FaceSwap failed:', faceSwapResult);
          const failureCode = faceSwapResult.StatusCode || 500;
          const debugPayload = compact({
            request: requestDebug,
            provider: buildProviderDebug(faceSwapResult),
            vertex: mergeVertexDebug(faceSwapResult, vertexPromptPayload),
          });
          return jsonResponse({
            data: null,
            status: 'error',
            message: faceSwapResult.Message || 'Face swap provider error',
            code: failureCode,
            debug: debugPayload,
          }, failureCode);
        }

        const disableSafeSearch = env.DISABLE_SAFE_SEARCH === 'true';
        const skipSafetyCheckForVertex = true; // Always skip for Vertex AI mode
        let safetyDebug: SafetyCheckDebug | null = null;

        if (!disableSafeSearch && !skipSafetyCheckForVertex) {
          console.log('[FaceSwap] Running safety check on result image:', faceSwapResult.ResultImageUrl);
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
            console.error('[FaceSwap] Safe search error:', safeSearchResult.error);
            const debugPayload = compact({
              request: requestDebug,
              provider: buildProviderDebug(faceSwapResult),
              vertex: undefined,
              vision: buildVisionDebug(safetyDebug),
            });
            return jsonResponse({
              data: null,
              status: 'error',
              message: `Safe search validation failed: ${safeSearchResult.error}`,
              code: 500,
              debug: debugPayload,
            }, 500);
          }

          if (!safeSearchResult.isSafe) {
            console.warn('[FaceSwap] Content blocked - unsafe content detected:', safeSearchResult.details);
            const violationCategory = safeSearchResult.violationCategory || 'unsafe content';
            const violationLevel = safeSearchResult.violationLevel || 'LIKELY';
            const debugPayload = compact({
              request: requestDebug,
              provider: buildProviderDebug(faceSwapResult),
              vertex: undefined,
              vision: buildVisionDebug(safetyDebug),
            });
            return jsonResponse({
              data: null,
              status: 'error',
              message: `Content blocked: Image contains ${violationCategory} content (${violationLevel})`,
              code: 422,
              debug: debugPayload,
            }, 422);
          }
          console.log('[FaceSwap] Safe search validation passed:', safeSearchResult.details);
        } else {
          if (skipSafetyCheckForVertex) {
            console.log('[FaceSwap] Safe search validation skipped for Nano Banana (Vertex AI)');
            safetyDebug = {
              checked: false,
              isSafe: true,
              error: 'Safety check skipped for Vertex AI mode',
            };
          } else {
            console.log('[FaceSwap] Safe search validation disabled via DISABLE_SAFE_SEARCH config');
            safetyDebug = {
              checked: false,
              isSafe: true,
              error: 'Safety check disabled via DISABLE_SAFE_SEARCH',
            };
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

        let resultUrl = faceSwapResult.ResultImageUrl;
        try {
          storageDebug.attemptedDownload = true;
          const resultImageResponse = await fetch(faceSwapResult.ResultImageUrl);
          storageDebug.downloadStatus = resultImageResponse.status;
          if (resultImageResponse.ok) {
            const resultImageData = await resultImageResponse.arrayBuffer();
            const resultKey = `results/result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.jpg`;
            await R2_BUCKET.put(resultKey, resultImageData, {
              httpMetadata: {
                contentType: 'image/jpeg',
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
        if (body.preset_image_id) {
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

        const providerDebug = buildProviderDebug(faceSwapResult, resultUrl);
        const vertexDebug = mergeVertexDebug(faceSwapResult, vertexPromptPayload);
        const visionDebug = buildVisionDebug(safetyDebug);
        const storageDebugPayload = compact(storageDebug as unknown as Record<string, any>);
        const databaseDebugPayload = compact(databaseDebug as unknown as Record<string, any>);
        const debugPayload = compact({
          request: requestDebug,
          provider: providerDebug,
          vertex: vertexDebug,
          vision: visionDebug,
          storage: Object.keys(storageDebugPayload).length ? storageDebugPayload : undefined,
          database: Object.keys(databaseDebugPayload).length ? databaseDebugPayload : undefined,
        });

        return jsonResponse({
          data: {
            id: savedResultId,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: faceSwapResult.Message || 'Processing successful',
          code: 200,
          debug: debugPayload,
        });
      } catch (error) {
        console.error('Unhandled error:', error);
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle upscaler4k endpoint
    if (path === '/upscaler4k' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string };
        
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
          console.log('[Upscaler4K] Running safety check on input image:', body.image_url);
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
            console.warn('[Upscaler4K] Input image failed safety check');
            const debugPayload = compact({
              inputSafety: buildVisionDebug(inputSafetyDebug),
            });
            return jsonResponse({
              data: null,
              debug: debugPayload,
              status: 'error',
              message: `Input image failed safety check: ${inputSafeSearchResult.violationCategory || 'unsafe content detected'}`,
              code: 400,
            }, 400);
          }
        }

        const upscalerResult = await callUpscaler4k(body.image_url, env);

        if (!upscalerResult.Success || !upscalerResult.ResultImageUrl) {
          console.error('Upscaler4K failed:', upscalerResult);
          const failureCode = upscalerResult.StatusCode || 500;
          const debugPayload = compact({
            provider: buildProviderDebug(upscalerResult),
            vertex: buildVertexDebug(upscalerResult),
            inputSafety: buildVisionDebug(inputSafetyDebug),
          });
          return jsonResponse({
            data: null,
            debug: debugPayload,
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
          console.log('[Upscaler4K] Converted R2 URL to public URL:', resultUrl);
        }

        // Check output image safety after upscaling
        let outputSafetyDebug: SafetyCheckDebug | null = null;

        if (!disableSafeSearch) {
          console.log('[Upscaler4K] Running safety check on output image:', resultUrl);
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
            console.warn('[Upscaler4K] Output image failed safety check');
            const debugPayload = compact({
              provider: buildProviderDebug(upscalerResult, resultUrl),
              vertex: buildVertexDebug(upscalerResult),
              inputSafety: buildVisionDebug(inputSafetyDebug),
              outputSafety: buildVisionDebug(outputSafetyDebug),
            });
            return jsonResponse({
              data: null,
              debug: debugPayload,
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

        const providerDebug = buildProviderDebug(upscalerResult, resultUrl);
        const vertexDebug = buildVertexDebug(upscalerResult);
        const debugPayload = compact({
          provider: providerDebug,
          vertex: vertexDebug,
          inputSafety: buildVisionDebug(inputSafetyDebug),
          outputSafety: buildVisionDebug(outputSafetyDebug),
        });

        return jsonResponse({
          data: {
            id: savedResultId,
            resultImageUrl: resultUrl,
          },
          debug: debugPayload,
          status: 'success',
          message: upscalerResult.Message || 'Upscaling completed',
          code: 200,
        });
      } catch (error) {
        console.error('Upscaler4K unhandled error:', error);
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle enhance endpoint
    if (path === '/enhance' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string };

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

        const enhancedResult = await callNanoBanana(
          'Enhance this image with better lighting, contrast, and sharpness. Improve overall image quality while maintaining natural appearance.',
          body.image_url,
          body.image_url,
          env
        );

        if (!enhancedResult.Success || !enhancedResult.ResultImageUrl) {
          console.error('Enhance failed:', enhancedResult);
          const failureCode = enhancedResult.StatusCode || 500;
          const debugPayload = compact({
            provider: buildProviderDebug(enhancedResult),
            vertex: mergeVertexDebug(enhancedResult, undefined),
          });
          return jsonResponse({
            data: null,
            status: 'error',
            message: enhancedResult.Message || 'Enhancement failed',
            code: failureCode,
            debug: debugPayload,
          }, failureCode);
        }

        let resultUrl = enhancedResult.ResultImageUrl;
        if (enhancedResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = enhancedResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
          console.log('[Enhance] Converted R2 URL to public URL:', resultUrl);
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

        const providerDebug = buildProviderDebug(enhancedResult, resultUrl);
        const vertexDebug = mergeVertexDebug(enhancedResult, undefined);

        return jsonResponse({
          data: {
            id: savedResultId,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: enhancedResult.Message || 'Image enhancement completed',
          code: 200,
          debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
          }),
        });
      } catch (error) {
        console.error('Enhance unhandled error:', error);
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle colorize endpoint
    if (path === '/colorize' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; profile_id?: string };

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

        const colorizedResult = await callNanoBanana(
          'Restore and enhance this damaged photo to a hyper-realistic, ultra-detailed image, 16K DSLR quality. Fix scratches, tears, noise, and blurriness. Enhance colors to vivid, vibrant tones while keeping natural skin tones. Perfectly sharpen details in face, eyes, hair, and clothing. Add realistic lighting, shadows, and depth of field. Photoshop-level professional retouching. High dynamic range, ultra-HD, lifelike textures, cinematic finish, crisp and clean background, fully restored and enhanced version of the original photo.',
          body.image_url,
          body.image_url,
          env
        );

        if (!colorizedResult.Success || !colorizedResult.ResultImageUrl) {
          console.error('Colorize failed:', colorizedResult);
          const failureCode = colorizedResult.StatusCode || 500;
          const debugPayload = compact({
            provider: buildProviderDebug(colorizedResult),
            vertex: mergeVertexDebug(colorizedResult, undefined),
          });
          return jsonResponse({
            data: null,
            status: 'error',
            message: colorizedResult.Message || 'Colorization failed',
            code: failureCode,
            debug: debugPayload,
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

        const providerDebug = buildProviderDebug(colorizedResult, resultUrl);
        const vertexDebug = mergeVertexDebug(colorizedResult, undefined);

        return jsonResponse({
          data: {
            id: savedResultId,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: colorizedResult.Message || 'Colorization completed',
          code: 200,
          debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
          }),
        });
      } catch (error) {
        console.error('Colorize unhandled error:', error);
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle aging endpoint
    if (path === '/aging' && request.method === 'POST') {
      try {
        const body = await request.json() as { image_url: string; age_years?: number; profile_id?: string };

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

        // For now, implement aging using existing Nano Banana API
        // This is a placeholder - in production, you'd want a dedicated aging model
        const agingResult = await callNanoBanana(
          `Age this person by ${ageYears} years. Add realistic aging effects including facial wrinkles, gray hair, maturity in appearance while maintaining the person's identity and natural features. Make the changes subtle and realistic.`,
          body.image_url,
          body.image_url, // Use same image as target and source for aging
          env
        );

        if (!agingResult.Success || !agingResult.ResultImageUrl) {
          console.error('Aging failed:', agingResult);
          const failureCode = agingResult.StatusCode || 500;
          const debugPayload = compact({
            provider: buildProviderDebug(agingResult),
            vertex: mergeVertexDebug(agingResult, undefined),
          });
          return jsonResponse({
            data: null,
            status: 'error',
            message: agingResult.Message || 'Aging transformation failed',
            code: failureCode,
            debug: debugPayload,
          }, failureCode);
        }

        let resultUrl = agingResult.ResultImageUrl;
        if (agingResult.ResultImageUrl?.startsWith('r2://')) {
          const r2Key = agingResult.ResultImageUrl.replace('r2://', '');
          const requestUrl = new URL(request.url);
          resultUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
          console.log('[Aging] Converted R2 URL to public URL:', resultUrl);
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

        const providerDebug = buildProviderDebug(agingResult, resultUrl);
        const vertexDebug = mergeVertexDebug(agingResult, undefined);

        return jsonResponse({
          data: {
            id: savedResultId,
            resultImageUrl: resultUrl,
          },
          status: 'success',
          message: agingResult.Message || 'Aging transformation completed',
          code: 200,
          debug: compact({
            provider: providerDebug,
            vertex: vertexDebug,
          }),
        });
      } catch (error) {
        console.error('Aging unhandled error:', error);
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, 500);
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
