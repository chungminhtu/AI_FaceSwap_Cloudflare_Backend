/// <reference types="@cloudflare/workers-types" />

import type { Env, FaceSwapRequest, FaceSwapResponse, UploadUrlRequest } from './types';
import { CORS_HEADERS, jsonResponse, errorResponse } from './utils';
import { callFaceSwap, callNanoBanana, checkSafeSearch, generateVertexPrompt } from './services';
import { validateEnv, validateRequest } from './validators';

const DEFAULT_R2_BUCKET_NAME = 'faceswap-images';

const globalScopeWithAccount = globalThis as typeof globalThis & {
  ACCOUNT_ID?: string;
  __CF_ACCOUNT_ID?: string;
  __ACCOUNT_ID?: string;
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const resolveAccountId = (env: Env): string | undefined =>
  env.R2_ACCOUNT_ID ||
  env.CF_ACCOUNT_ID ||
  env.ACCOUNT_ID ||
  globalScopeWithAccount.ACCOUNT_ID ||
  globalScopeWithAccount.__CF_ACCOUNT_ID ||
  globalScopeWithAccount.__ACCOUNT_ID;

const resolveBucketName = (env: Env): string => env.R2_BUCKET_NAME || DEFAULT_R2_BUCKET_NAME;

const buildR2DevBaseUrl = (env: Env): string | undefined => {
  // Use the correct public r2.dev URL assigned by Cloudflare
  // This was generated when enabling public access: https://pub-961528defa6742bb9d9cac7150eda479.r2.dev
  return 'https://pub-961528defa6742bb9d9cac7150eda479.r2.dev';
};

const resolveR2PublicBase = (env: Env): string | undefined => {
  // Always use r2.dev URL for direct CDN access (requires bucket public access enabled)
  // Format: https://<bucket-name>.r2.dev
  // This provides better performance by avoiding Worker execution
  return buildR2DevBaseUrl(env);
};

const getR2PublicUrl = (env: Env, key: string, fallbackOrigin?: string): string => {
  const baseUrl = resolveR2PublicBase(env);
  if (baseUrl) {
    return `${baseUrl}/${key}`;
  }
  if (fallbackOrigin) {
    const origin = trimTrailingSlash(fallbackOrigin);
    // Use worker proxy route - this works even if bucket doesn't have public access
    return `${origin}/r2/${key}`;
  }
  throw new Error('Unable to determine R2 public URL. Configure R2_PUBLIC_URL, set R2_USE_R2_DEV=true (if bucket has public access), or ensure worker origin is available.');
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

    // Handle upload URL generation endpoint - now generates presigned URLs for direct R2 upload
    if (path === '/upload-url' && request.method === 'POST') {
      try {
        const body: UploadUrlRequest = await request.json();

        if (!body.filename || !body.type) {
          return errorResponse('Missing required fields: filename and type', 400);
        }

        // Generate a unique key for the file
        const key = `${body.type}/${body.filename}`;

        // Get R2 public URL (direct r2.dev CDN URL)
        const publicUrl = getR2PublicUrl(env, key, requestUrl.origin);

        // For R2, we'll use a worker endpoint that handles metadata but upload goes to worker first
        // then worker uploads to R2 with proper cache headers
        return jsonResponse({
          uploadUrl: `${requestUrl.origin}/upload-proxy/${key}`,
          publicUrl,
          key,
          presetName: body.presetName, // Pass through preset name for frontend
          enableVertexPrompt: body.enableVertexPrompt // Pass through Vertex AI prompt flag
        });
      } catch (error) {
        console.error('Upload URL generation error:', error);
        return errorResponse(`Failed to generate upload URL: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle Vertex AI prompt retrieval for presets
    if (path.startsWith('/vertex/get-prompt/') && request.method === 'GET') {
      try {
        const presetImageId = path.replace('/vertex/get-prompt/', '');

        const result = await env.DB.prepare(
          'SELECT id, image_url, prompt_json FROM preset_images WHERE id = ?'
        ).bind(presetImageId).first();

        if (!result) {
          return errorResponse('Preset image not found', 404);
        }

        const promptJson = result.prompt_json ? JSON.parse(result.prompt_json as string) : null;

        return jsonResponse({
          success: true,
          presetImage: {
            id: result.id,
            image_url: result.image_url,
            hasPrompt: !!promptJson,
            promptJson: promptJson
          }
        });
      } catch (error) {
        console.error('[Vertex] Prompt retrieval error:', error);
        return errorResponse(`Prompt retrieval failed: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle proxy upload endpoint (for direct browser uploads)
    if (path.startsWith('/upload-proxy/')) {
      // OPTIONS already handled above, but double-check
      if (request.method === 'OPTIONS') {
        return new Response(null, { 
          status: 204, 
          headers: { 
            ...CORS_HEADERS, 
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Max-Age': '86400' 
          } 
        });
      }
      
      // Allow GET to serve the file (for viewing uploaded files)
      if (request.method === 'GET') {
        try {
          const key = path.replace('/upload-proxy/', '');
          const object = await env.FACESWAP_IMAGES.get(key);
          
          if (!object) {
            return errorResponse('File not found', 404);
          }
          
          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set('etag', object.httpEtag);
          headers.set('Cache-Control', 'public, max-age=31536000');
          headers.set('Access-Control-Allow-Origin', '*');
          
          return new Response(object.body, { headers });
        } catch (error) {
          console.error('Error serving file:', error);
          return errorResponse(`Failed to serve file: ${error instanceof Error ? error.message : String(error)}`, 500);
        }
      }
      
      if (request.method !== 'PUT') {
        return new Response(JSON.stringify({ 
          Success: false, 
          Message: `Method not allowed. Use PUT or GET. Got: ${request.method}`, 
          StatusCode: 405 
        }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
      
      try {
        const key = path.replace('/upload-proxy/', '');
        console.log(`Upload request: method=${request.method}, key=${key}, content-type=${request.headers.get('Content-Type')}`);
        
        const fileData = await request.arrayBuffer();
        
        if (!fileData || fileData.byteLength === 0) {
          return errorResponse('Empty file data', 400);
        }
        
        // Upload to R2 with cache-control headers
        try {
          await env.FACESWAP_IMAGES.put(key, fileData, {
            httpMetadata: {
              contentType: request.headers.get('Content-Type') || 'image/jpeg',
              cacheControl: 'public, max-age=31536000, immutable', // 1 year cache
            },
          });
          console.log(`File uploaded successfully to R2: ${key}`);
        } catch (r2Error) {
          console.error('R2 upload error:', r2Error);
          return errorResponse(`R2 upload failed: ${r2Error instanceof Error ? r2Error.message : String(r2Error)}`, 500);
        }

        // Get the public URL (R2 CDN URL, not worker proxy)
        const publicUrl = getR2PublicUrl(env, key, requestUrl.origin);

        // Save upload metadata to database based on type
        if (key.startsWith('preset/')) {
          console.log('Processing preset upload:', key);
          let presetName = request.headers.get('X-Preset-Name') || `Preset ${Date.now()}`;
          // Accept both header names for compatibility
          const enableVertexPrompt =
            request.headers.get('X-Enable-Vertex-Prompt') === 'true' ||
            request.headers.get('X-Enable-Gemini-Prompt') === 'true';
          const enableVisionScan = request.headers.get('X-Enable-Vision-Scan') === 'true';
          const genderHeader = request.headers.get('X-Gender');
          const gender = (genderHeader && (genderHeader === 'male' || genderHeader === 'female')) 
            ? genderHeader as 'male' | 'female' 
            : undefined;
          console.log('Raw preset name:', presetName, 'Enable Vertex AI Prompt:', enableVertexPrompt, 'Enable Vision Scan:', enableVisionScan, 'Gender:', gender);

          // Decode base64 if encoded
          const isEncoded = request.headers.get('X-Preset-Name-Encoded') === 'base64';
          if (isEncoded) {
            try {
              presetName = decodeURIComponent(escape(atob(presetName)));
              console.log('Decoded preset name:', presetName);
            } catch (e) {
              console.warn('Failed to decode preset name, using as-is:', e);
            }
          }

          // Save to database - ensure this always happens
          let imageId: string | undefined;
          let promptJson: string | null = null;
          
          // Track Vertex AI API call details for response (declared outside try block for access in return)
          let vertexCallInfo: { 
            success: boolean; 
            error?: string; 
            promptKeys?: string[];
            debug?: {
              endpoint?: string;
              model?: string;
              requestSent?: boolean;
              httpStatus?: number;
              httpStatusText?: string;
              responseTimeMs?: number;
              responseStructure?: string;
              errorDetails?: string;
              rawError?: string;
            };
          } = { success: false };
          
          // Track Vision API scan results for response (declared outside try block for access in return)
          let visionScanResult: { success: boolean; isSafe?: boolean; error?: string; rawResponse?: any } | null = null;

          try {
            // First, check if a collection with this name already exists
            let collectionResult = await env.DB.prepare(
              'SELECT id FROM preset_collections WHERE name = ?'
            ).bind(presetName).first();

            let collectionId: string;

            if (!collectionResult) {
              // Create new collection
              collectionId = `collection_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
              const collectionInsert = await env.DB.prepare(
                'INSERT INTO preset_collections (id, name, created_at) VALUES (?, ?, ?)'
              ).bind(collectionId, presetName, Math.floor(Date.now() / 1000)).run();
              console.log(`Created new collection: ${collectionId}`, collectionInsert);
            } else {
              collectionId = collectionResult.id as string;
              console.log(`Using existing collection: ${collectionId}`);
            }

            // Perform Vision API safety scan if enabled
            if (enableVisionScan) {
              console.log('[Vision] Scanning preset image with Google Vision API for safety check...');
              try {
                const visionResult = await checkSafeSearch(publicUrl, env);
                visionScanResult = {
                  success: visionResult.isSafe !== undefined,
                  isSafe: visionResult.isSafe,
                  error: visionResult.error,
                  rawResponse: visionResult.rawResponse // Include full raw Vision API response
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
            if (enableVertexPrompt) {
              console.log('[Vertex] Generating prompt for uploaded preset image:', publicUrl);
            console.log('[Vertex] Calling Vertex AI API with exact prompt text and preset image');
            } else {
              console.log('[Vertex] Vertex AI prompt generation skipped (not enabled)');
            }
            
            if (enableVertexPrompt) {
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
                console.log('[Vertex] Prompt keys:', promptKeys);
                console.log('[Vertex] ✅ Will store prompt_json in database');
                if (promptResult.debug) {
                  console.log('[Vertex] Debug info:', JSON.stringify(promptResult.debug));
                }
              } else {
                vertexCallInfo = { 
                  success: false, 
                  error: promptResult.error || 'Unknown error',
                  debug: promptResult.debug 
                };
                console.error('[Vertex] ❌ Failed to generate prompt:', promptResult.error);
                console.error('[Vertex] Error details:', promptResult.error);
                if (promptResult.debug) {
                  console.error('[Vertex] Debug info:', JSON.stringify(promptResult.debug));
                }
                console.error('[Vertex] ⚠️ Image will be saved without prompt_json. Please check your GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY and ensure Vertex AI API is enabled.');
                // Continue without prompt - image will still be saved
              }
            } catch (vertexError) {
              const errorMsg = vertexError instanceof Error ? vertexError.message : String(vertexError);
              const errorStack = vertexError instanceof Error ? vertexError.stack : undefined;
              vertexCallInfo = { 
                success: false, 
                error: errorMsg,
                debug: {
                  errorDetails: errorMsg,
                  rawError: errorStack || String(vertexError)
                }
              };
              console.error('[Vertex] ❌ Exception during prompt generation:', vertexError);
              console.error('[Vertex] Error type:', vertexError instanceof Error ? vertexError.constructor.name : typeof vertexError);
              console.error('[Vertex] Stack trace:', errorStack || 'No stack trace');
              console.error('[Vertex] ⚠️ Image will be saved without prompt_json due to exception.');
              // Continue without prompt - image will still be saved
              }
            }

            // Always save image to database (even if prompt generation or vision scan failed)
            imageId = `image_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
            const createdAt = Math.floor(Date.now() / 1000);
            
            console.log(`[DB] Inserting preset image:`, {
              id: imageId,
              collectionId,
              imageUrl: publicUrl,
              hasPrompt: !!promptJson,
              promptLength: promptJson ? promptJson.length : 0,
              createdAt
            });
            
            // Validate gender before insert
            const validGender = (gender === 'male' || gender === 'female') ? gender : null;
            
            // Check if gender column exists
            let hasGenderColumn = false;
            try {
              const tableInfo = await env.DB.prepare("PRAGMA table_info(preset_images)").all();
              hasGenderColumn = (tableInfo.results as any[]).some((col: any) => col.name === 'gender');
            } catch {
              // If we can't check, assume it doesn't exist
              hasGenderColumn = false;
            }
            
            let result;
            if (hasGenderColumn) {
              result = await env.DB.prepare(
                'INSERT INTO preset_images (id, collection_id, image_url, prompt_json, gender, created_at) VALUES (?, ?, ?, ?, ?, ?)'
              ).bind(imageId, collectionId, publicUrl, promptJson, validGender, createdAt).run();
            } else {
              // Insert without gender column (for databases that haven't been migrated yet)
              console.warn('[DB] Gender column not found, inserting without gender');
              result = await env.DB.prepare(
                'INSERT INTO preset_images (id, collection_id, image_url, prompt_json, created_at) VALUES (?, ?, ?, ?, ?)'
              ).bind(imageId, collectionId, publicUrl, promptJson, createdAt).run();
            }

            if (!result.success) {
              console.error('[DB] Insert result:', result);
              throw new Error(`Database insert failed: ${JSON.stringify(result)}`);
            }

            console.log(`[DB] Preset image saved successfully:`, {
              imageId,
              collectionId,
              hasPrompt: !!promptJson,
              meta: result.meta
            });

            // Verify the save by querying back
            const verify = await env.DB.prepare(
              'SELECT id, CASE WHEN prompt_json IS NOT NULL THEN 1 ELSE 0 END as has_prompt FROM preset_images WHERE id = ?'
            ).bind(imageId).first();
            
            if (verify) {
              console.log(`[DB] Verified save: id=${(verify as any).id}, has_prompt=${(verify as any).has_prompt}`);
            }
          } catch (dbError) {
            console.error('[DB] Database save error:', dbError);
            console.error('[DB] Error details:', {
              message: dbError instanceof Error ? dbError.message : String(dbError),
              stack: dbError instanceof Error ? dbError.stack : undefined,
              errorType: dbError instanceof Error ? dbError.constructor.name : typeof dbError
            });
            
            const errorMsg = dbError instanceof Error ? dbError.message : String(dbError);
            let errorMessage = `Database save failed: ${errorMsg}`;
            let warning = 'File uploaded to R2 but not saved to database. Please retry or contact support.';
            
            // Check if it's a missing column error
            if (errorMsg.includes('no column named gender')) {
              errorMessage = 'Gender column missing. Please run migration: POST /migrate-gender';
              warning = 'File uploaded to R2 but not saved to database. Run migration to add gender column.';
            }
            
            // Return error response - don't silently fail
            // File was uploaded to R2, but DB save failed - this is a critical error
            return jsonResponse({
              success: false,
              url: publicUrl,
              id: null,
              filename: key.replace('preset/', ''),
              hasPrompt: false,
              error: errorMessage,
              warning: warning
            }, 500);
          }

          // Only return success if database save completed
          if (!imageId) {
            console.error('[DB] No imageId generated - database save must have failed');
            return jsonResponse({
              success: false,
              url: publicUrl,
              error: 'Database save failed - no image ID was generated'
            }, 500);
          }

          // Parse prompt_json for response (it's stored as string in DB)
          let promptJsonObject = null;
          if (promptJson) {
            try {
              promptJsonObject = JSON.parse(promptJson);
              console.log('[Upload] Returning prompt_json in response:', {
                hasPrompt: true,
                keys: Object.keys(promptJsonObject)
              });
            } catch (parseError) {
              console.error('[Upload] Failed to parse prompt_json for response:', parseError);
            }
          } else {
            console.log('[Upload] No prompt_json to return');
          }

          return jsonResponse({
            success: true,
            url: publicUrl,
            id: imageId,
            filename: key.replace('preset/', ''),
            hasPrompt: !!promptJson,
            prompt_json: promptJsonObject,
            vertex_info: vertexCallInfo,  // Include Vertex AI API call details for frontend logging
            vision_scan: visionScanResult  // Include Vision API scan results for frontend logging
          });
        } else if (key.startsWith('selfie/')) {
          console.log('Processing selfie upload:', key);

          // Extract filename from key (remove 'selfie/' prefix)
          const filename = key.replace('selfie/', '');
          const selfieId = `selfie_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          const createdAt = Math.floor(Date.now() / 1000);
          const genderHeader = request.headers.get('X-Gender');
          const gender = (genderHeader && (genderHeader === 'male' || genderHeader === 'female')) 
            ? genderHeader as 'male' | 'female' 
            : undefined;
          console.log('Selfie upload - Gender:', gender);

          console.log(`Saving selfie to database: id=${selfieId}, url=${publicUrl}, filename=${filename}, created_at=${createdAt}`);

          // Save to database - this MUST succeed for the upload to be considered successful
          let dbSaved = false;
          try {
            // First check if selfies table exists
            const tableCheck = await env.DB.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='selfies'"
            ).first();
            
            if (!tableCheck) {
              console.error('ERROR: selfies table does not exist in database!');
              console.error('Database schema needs to be initialized. Run: wrangler d1 execute faceswap-db --remote --file=schema.sql');
              return errorResponse('Database schema not initialized. Please run database migration.', 500);
            }

            // Validate gender before insert
            const validGender = (gender === 'male' || gender === 'female') ? gender : null;
            
            // Check if gender column exists
            let hasGenderColumn = false;
            try {
              const tableInfo = await env.DB.prepare("PRAGMA table_info(selfies)").all();
              hasGenderColumn = (tableInfo.results as any[]).some((col: any) => col.name === 'gender');
            } catch {
              // If we can't check, assume it doesn't exist
              hasGenderColumn = false;
            }
            
            let result;
            if (hasGenderColumn) {
              result = await env.DB.prepare(
                'INSERT INTO selfies (id, image_url, filename, gender, created_at) VALUES (?, ?, ?, ?, ?)'
              ).bind(selfieId, publicUrl, filename, validGender, createdAt).run();
            } else {
              // Insert without gender column (for databases that haven't been migrated yet)
              console.warn('[DB] Gender column not found, inserting without gender');
              result = await env.DB.prepare(
                'INSERT INTO selfies (id, image_url, filename, created_at) VALUES (?, ?, ?, ?)'
              ).bind(selfieId, publicUrl, filename, createdAt).run();
            }

            if (!result.success) {
              console.error('Database insert returned success=false:', result);
              console.error('Insert details:', { selfieId, publicUrl, filename, gender: validGender, createdAt });
              return errorResponse('Failed to save selfie to database', 500);
            }

            console.log(`Selfie saved to database successfully: ${selfieId}`, {
              success: result.success,
              meta: result.meta
            });

            // Verify it was saved by querying it back
            const verifyResult = await env.DB.prepare(
              'SELECT id, image_url, filename FROM selfies WHERE id = ?'
            ).bind(selfieId).first();
            
            if (verifyResult) {
              console.log('Selfie verified in database:', verifyResult);
              dbSaved = true;
            } else {
              console.error('CRITICAL: Selfie not found in database after insert!');
              return errorResponse('Selfie was not saved to database properly', 500);
            }
          } catch (dbError) {
            console.error('Selfie database save error:', dbError);
            console.error('Error details:', {
              message: dbError instanceof Error ? dbError.message : String(dbError),
              stack: dbError instanceof Error ? dbError.stack : undefined
            });
            
            // Check if it's a table missing error
            const errorMsg = dbError instanceof Error ? dbError.message : String(dbError);
            if (errorMsg.includes('no such table') || errorMsg.includes('selfies')) {
              return errorResponse('Database schema not initialized. Please run: wrangler d1 execute faceswap-db --remote --file=schema.sql', 500);
            }
            
            // Check if it's a missing column error
            if (errorMsg.includes('no column named gender')) {
              return errorResponse('Gender column missing. Please run migration: POST /migrate-gender or wrangler d1 execute faceswap-db --remote --file=migrate-gender-columns.sql', 500);
            }
            
            return errorResponse(`Database save failed: ${errorMsg}`, 500);
          }

          if (!dbSaved) {
            return errorResponse('Failed to verify selfie was saved to database', 500);
          }

          return jsonResponse({
            success: true,
            url: publicUrl,
            id: selfieId,
            filename: filename
          });
        }

        return jsonResponse({ success: true, url: publicUrl });
      } catch (error) {
        console.error('Upload proxy error:', error);
        return errorResponse(`Upload failed: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle data migration
    if (path === '/migrate' && request.method === 'POST') {
      try {
        // Migrate existing data from presets table to new structure
        await env.DB.prepare(`
          INSERT OR IGNORE INTO preset_collections (id, name, created_at)
          SELECT 'collection_' || id, name, created_at FROM presets
        `).run();

        await env.DB.prepare(`
          INSERT OR IGNORE INTO preset_images (id, collection_id, image_url, created_at)
          SELECT 'image_' || id, 'collection_' || id, image_url, created_at FROM presets
        `).run();

        return jsonResponse({ success: true, message: 'Migration completed' });
      } catch (error) {
        console.error('Migration error:', error);
        return errorResponse('Migration failed', 500);
      }
    }

    // Handle gender column migration
    if (path === '/migrate-gender' && request.method === 'POST') {
      try {
        const results: string[] = [];
        
        // Check if gender column exists in preset_images
        try {
          const presetTableInfo = await env.DB.prepare("PRAGMA table_info(preset_images)").all();
          const hasPresetGender = (presetTableInfo.results as any[]).some((col: any) => col.name === 'gender');
          
          if (!hasPresetGender) {
            await env.DB.prepare('ALTER TABLE preset_images ADD COLUMN gender TEXT CHECK(gender IN (\'male\', \'female\'))').run();
            results.push('Added gender column to preset_images');
          } else {
            results.push('Gender column already exists in preset_images');
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('duplicate column')) {
            results.push('Gender column already exists in preset_images');
          } else {
            throw error;
          }
        }

        // Check if gender column exists in selfies
        try {
          const selfieTableInfo = await env.DB.prepare("PRAGMA table_info(selfies)").all();
          const hasSelfieGender = (selfieTableInfo.results as any[]).some((col: any) => col.name === 'gender');
          
          if (!hasSelfieGender) {
            await env.DB.prepare('ALTER TABLE selfies ADD COLUMN gender TEXT CHECK(gender IN (\'male\', \'female\'))').run();
            results.push('Added gender column to selfies');
          } else {
            results.push('Gender column already exists in selfies');
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('duplicate column')) {
            results.push('Gender column already exists in selfies');
          } else {
            throw error;
          }
        }

        // Create indexes
        try {
          await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_preset_images_gender ON preset_images(gender)').run();
          results.push('Created index on preset_images.gender');
        } catch (error) {
          results.push('Index on preset_images.gender already exists or failed');
        }

        try {
          await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_selfies_gender ON selfies(gender)').run();
          results.push('Created index on selfies.gender');
        } catch (error) {
          results.push('Index on selfies.gender already exists or failed');
        }

        return jsonResponse({ success: true, message: 'Gender columns migration completed', results });
      } catch (error) {
        console.error('Gender migration error:', error);
        return errorResponse(`Gender migration failed: ${error instanceof Error ? error.message : String(error)}`, 500);
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
            i.id,
            i.collection_id,
            i.image_url,
            i.prompt_json,
            i.gender,
            i.created_at,
            c.name as collection_name
          FROM preset_images i
          LEFT JOIN preset_collections c ON i.collection_id = c.id
        `;

        const params: any[] = [];

        if (genderFilter) {
          query += ' WHERE i.gender = ?';
          params.push(genderFilter);
          console.log(`Filtering presets by gender: ${genderFilter}`);
        }

        query += ' ORDER BY i.created_at DESC';

        const imagesResult = await env.DB.prepare(query).bind(...params).all();

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
          collection_id: row.collection_id || '',
          image_url: row.image_url || '',
          filename: row.image_url?.split('/').pop() || `preset_${row.id}.jpg`,
          collection_name: row.collection_name || 'Unnamed',
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

        console.log(`[DELETE] Deleting preset: ${presetId}`);

        // First, check if preset exists
        const checkResult = await env.DB.prepare(
          'SELECT id, image_url FROM preset_images WHERE id = ?'
        ).bind(presetId).first();

        if (!checkResult) {
          console.warn(`[DELETE] Preset not found: ${presetId}`);
          return errorResponse('Preset not found', 404);
        }

        const imageUrl = (checkResult as any).image_url;

        // First, delete all related results (to avoid foreign key constraint error)
        const deleteResultsResult = await env.DB.prepare(
          'DELETE FROM results WHERE preset_image_id = ?'
        ).bind(presetId).run();
        
        const resultsDeleted = deleteResultsResult.meta?.changes || 0;
        console.log(`[DELETE] Deleted ${resultsDeleted} related result(s) for preset: ${presetId}`);

        // Then delete from database
        const deleteResult = await env.DB.prepare(
          'DELETE FROM preset_images WHERE id = ?'
        ).bind(presetId).run();

        console.log(`[DELETE] Database delete result:`, {
          presetId,
          success: deleteResult.success,
          meta: deleteResult.meta,
          changes: deleteResult.meta?.changes
        });

        // Verify deletion succeeded
        if (!deleteResult.success) {
          console.error(`[DELETE] Database delete failed for preset: ${presetId}`);
          return errorResponse('Failed to delete preset from database', 500);
        }

        // Check if any rows were actually deleted
        if (deleteResult.meta?.changes === 0) {
          console.warn(`[DELETE] No rows deleted for preset: ${presetId}`);
          return errorResponse('Preset not found or already deleted', 404);
        }

        console.log(`[DELETE] Successfully deleted preset from database: ${presetId}`);

        // Try to delete from R2 (non-fatal if it fails)
        let r2Deleted = false;
        let r2Key = null;
        let r2Error = null;
        if (imageUrl) {
          try {
            // Extract key from URL (handle both r2.dev and worker proxy URLs)
            const urlParts = imageUrl.split('/');
            r2Key = urlParts.slice(-2).join('/'); // Get last two parts (e.g., "preset/filename.jpg")
            
            await env.FACESWAP_IMAGES.delete(r2Key);
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
          message: 'Preset deleted successfully',
          debug: {
            presetId,
            resultsDeleted,
            databaseDeleted: deleteResult.meta?.changes || 0,
            r2Deleted,
            r2Key,
            r2Error: r2Error || null,
            imageUrl
          }
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

        // Check for gender filter query parameter
        const url = new URL(request.url);
        const genderFilter = url.searchParams.get('gender') as 'male' | 'female' | null;

        let query = 'SELECT id, image_url, filename, gender, created_at FROM selfies';
        const params: any[] = [];

        if (genderFilter) {
          query += ' WHERE gender = ?';
          params.push(genderFilter);
          console.log(`Filtering selfies by gender: ${genderFilter}`);
        }

        query += ' ORDER BY created_at DESC LIMIT 50';

        const result = await env.DB.prepare(query).bind(...params).all();

        console.log('Selfies query result:', {
          success: result.success,
          resultsCount: result.results?.length || 0,
          meta: result.meta,
          genderFilter: genderFilter || 'none'
        });

        if (!result || !result.results) {
          console.log('No selfies found in database');
          return jsonResponse({ selfies: [] });
        }

        const selfies = result.results.map((row: any) => ({
          id: row.id || '',
          image_url: row.image_url || '',
          filename: row.filename || '',
          gender: row.gender || null,
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        console.log(`Returning ${selfies.length} selfies${genderFilter ? ` (filtered by gender: ${genderFilter})` : ''}`);
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

        console.log(`[DELETE] Deleting selfie: ${selfieId}`);

        // First, check if selfie exists
        const checkResult = await env.DB.prepare(
          'SELECT id, image_url FROM selfies WHERE id = ?'
        ).bind(selfieId).first();

        if (!checkResult) {
          console.warn(`[DELETE] Selfie not found: ${selfieId}`);
          return errorResponse('Selfie not found', 404);
        }

        const imageUrl = (checkResult as any).image_url;

        // First, delete all related results (to avoid foreign key constraint error)
        const deleteResultsResult = await env.DB.prepare(
          'DELETE FROM results WHERE selfie_id = ?'
        ).bind(selfieId).run();
        
        const resultsDeleted = deleteResultsResult.meta?.changes || 0;
        console.log(`[DELETE] Deleted ${resultsDeleted} related result(s) for selfie: ${selfieId}`);

        // Then delete from database
        const deleteResult = await env.DB.prepare(
          'DELETE FROM selfies WHERE id = ?'
        ).bind(selfieId).run();

        console.log(`[DELETE] Database delete result:`, {
          selfieId,
          success: deleteResult.success,
          meta: deleteResult.meta,
          changes: deleteResult.meta?.changes
        });

        // Verify deletion succeeded
        if (!deleteResult.success) {
          console.error(`[DELETE] Database delete failed for selfie: ${selfieId}`);
          return errorResponse('Failed to delete selfie from database', 500);
        }

        // Check if any rows were actually deleted
        if (deleteResult.meta?.changes === 0) {
          console.warn(`[DELETE] No rows deleted for selfie: ${selfieId}`);
          return errorResponse('Selfie not found or already deleted', 404);
        }

        console.log(`[DELETE] Successfully deleted selfie from database: ${selfieId}`);

        // Try to delete from R2 (non-fatal if it fails)
        let r2Deleted = false;
        let r2Key = null;
        let r2Error = null;
        if (imageUrl) {
          try {
            // Extract key from URL (handle both r2.dev and worker proxy URLs)
            const urlParts = imageUrl.split('/');
            r2Key = urlParts.slice(-2).join('/'); // Get last two parts (e.g., "selfie/filename.jpg")
            
            await env.FACESWAP_IMAGES.delete(r2Key);
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
          message: 'Selfie deleted successfully',
          debug: {
            selfieId,
            resultsDeleted,
            databaseDeleted: deleteResult.meta?.changes || 0,
            r2Deleted,
            r2Key,
            r2Error: r2Error || null,
            imageUrl
          }
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

    // Handle assets by gender endpoint
    if (path === '/assets/by-gender' && request.method === 'GET') {
      try {
        console.log('Fetching assets grouped by gender...');

        // Get all preset images with gender
        const presetsResult = await env.DB.prepare(`
          SELECT
            id,
            collection_id,
            image_url,
            gender,
            created_at
          FROM preset_images
          WHERE gender IS NOT NULL
          ORDER BY created_at DESC
        `).all();

        // Get all selfies with gender
        const selfiesResult = await env.DB.prepare(`
          SELECT
            id,
            image_url,
            filename,
            gender,
            created_at
          FROM selfies
          WHERE gender IS NOT NULL
          ORDER BY created_at DESC
        `).all();

        const presets = presetsResult.results || [];
        const selfies = selfiesResult.results || [];

        // Group by gender
        const malePresets = presets.filter((row: any) => row.gender === 'male').map((row: any) => ({
          id: row.id,
          collection_id: row.collection_id,
          image_url: row.image_url,
          gender: row.gender,
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        const femalePresets = presets.filter((row: any) => row.gender === 'female').map((row: any) => ({
          id: row.id,
          collection_id: row.collection_id,
          image_url: row.image_url,
          gender: row.gender,
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        const maleSelfies = selfies.filter((row: any) => row.gender === 'male').map((row: any) => ({
          id: row.id,
          image_url: row.image_url,
          filename: row.filename,
          gender: row.gender,
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        const femaleSelfies = selfies.filter((row: any) => row.gender === 'female').map((row: any) => ({
          id: row.id,
          image_url: row.image_url,
          filename: row.filename,
          gender: row.gender,
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        const response = {
          male: {
            presets: malePresets,
            selfies: maleSelfies
          },
          female: {
            presets: femalePresets,
            selfies: femaleSelfies
          }
        };

        console.log(`Returning assets by gender: male presets=${malePresets.length}, female presets=${femalePresets.length}, male selfies=${maleSelfies.length}, female selfies=${femaleSelfies.length}`);
        return jsonResponse(response);
      } catch (error) {
        console.error('List assets by gender error:', error);
        console.error('Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        // Return empty structure instead of error to prevent UI breaking
        return jsonResponse({
          male: { presets: [], selfies: [] },
          female: { presets: [], selfies: [] }
        });
      }
    }

    // Handle results listing
    if (path === '/results' && request.method === 'GET') {
      try {
        const result = await env.DB.prepare(
          'SELECT id, selfie_id, preset_collection_id, preset_image_id, preset_name, result_url, created_at FROM results ORDER BY created_at DESC LIMIT 50'
        ).all();

        if (!result || !result.results) {
          return jsonResponse({ results: [] });
        }

        const results = result.results.map((row: any) => ({
          id: row.id || '',
          selfie_id: row.selfie_id || '',
          preset_collection_id: row.preset_collection_id || '',
          preset_image_id: row.preset_image_id || '',
          preset_name: row.preset_name || 'Unnamed',
          result_url: row.result_url || '',
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        return jsonResponse({ results });
      } catch (error) {
        console.error('List results error:', error);
        // Return empty array instead of error to prevent UI breaking
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
        const checkResult = await env.DB.prepare(
          'SELECT result_url FROM results WHERE id = ?'
        ).bind(resultId).first();

        if (!checkResult) {
          console.warn(`[DELETE] Result not found: ${resultId}`);
          return errorResponse('Result not found', 404);
        }

        const resultUrl = (checkResult as any).result_url || '';

        // Delete from database
        const deleteResult = await env.DB.prepare(
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
            } else if (resultUrl.includes('r2.dev') && resultUrl.includes('/results/')) {
              // Extract from public R2 URL: https://pub-xxx.r2.dev/results/xxx.jpg
              const urlParts = resultUrl.split('/results/');
              if (urlParts.length > 1) {
                r2Key = `results/${urlParts[1]}`;
              }
            }

            if (r2Key) {
              await env.FACESWAP_IMAGES.delete(r2Key);
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

    // Handle R2 file serving (if no public URL configured)
    if (path.startsWith('/r2/') && request.method === 'GET') {
      try {
        const key = path.replace('/r2/', '');
        const object = await env.FACESWAP_IMAGES.get(key);
        
        if (!object) {
          return errorResponse('File not found', 404);
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Cache-Control', 'public, max-age=31536000');
        headers.set('Access-Control-Allow-Origin', '*');

        return new Response(object.body, { headers });
      } catch (error) {
        console.error('R2 serve error:', error);
        return errorResponse(`Failed to serve file: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle safety check test endpoint
    if (path === '/test-safety' && request.method === 'POST') {
      try {
        const body: { image_url?: string; imageUrl?: string } = await request.json();
        const imageUrl = body.image_url || body.imageUrl;

        if (!imageUrl) {
          return errorResponse('Missing image_url in request body', 400);
        }

        console.log('[TestSafety] Testing safety check for image:', imageUrl);
        const safeSearchResult = await checkSafeSearch(imageUrl, env);

        return jsonResponse({
          success: true,
          imageUrl: imageUrl,
          result: safeSearchResult,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('[TestSafety] Error:', error);
        return errorResponse(`Test failed: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Test Vertex AI API connectivity
    if (path === '/test-vertex' && request.method === 'GET') {
      try {
        if (!env.GOOGLE_VERTEX_PROJECT_ID) {
          return errorResponse('Vertex AI project ID not configured', 500);
        }

        if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
          return errorResponse('Vertex AI service account credentials not configured. GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are required.', 500);
        }

        const location = env.GOOGLE_VERTEX_LOCATION || 'us-central1';
        const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
        console.log('[Test-Vertex] Testing Vertex AI API connectivity...');

        // Generate OAuth token from service account
        const { getAccessToken } = await import('./utils');
        const accessToken = await getAccessToken(
          env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
        );

        const testEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/models`;
        const listResponse = await fetch(testEndpoint, {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        const rawBody = await listResponse.text();
        let models: string[] = [];
        if (listResponse.ok) {
          try {
            const parsed = JSON.parse(rawBody);
            if (Array.isArray(parsed.models)) {
              models = parsed.models.slice(0, 5).map((model: any) => model.name);
            }
          } catch {
            // Ignore JSON parse errors for the list response
          }
        }

        console.log('[Test-Vertex] Response status:', listResponse.status);
        console.log('[Test-Vertex] Response body:', rawBody.substring(0, 200));

        return jsonResponse({
          message: listResponse.ok ? 'Vertex AI API reachable' : 'Vertex AI API returned an error',
          hasApiKey: true,
          status: listResponse.status,
          ok: listResponse.ok,
          models,
          error: listResponse.ok ? null : rawBody.substring(0, 500)
        });
      } catch (error) {
        return errorResponse(`Vertex AI test failed: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle face swap endpoint (root path or /faceswap)
    if ((path === '/' || path === '/faceswap') && request.method === 'POST') {
      try {
        const body: FaceSwapRequest & {
          preset_image_id?: string;
          preset_collection_id?: string;
          preset_name?: string;
          mode?: string;
          api_provider?: string;
        } = await request.json();

        const resolvedMode: 'rapidapi' | 'vertex' =
          body.mode === 'vertex' || body.api_provider === 'google-nano-banana'
            ? 'vertex'
            : 'rapidapi';

        const envError = validateEnv(env, resolvedMode);
        if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

        const requestError = validateRequest(body, resolvedMode);
        if (requestError) return errorResponse(requestError, 400);

        const requestDebug = compact({
          mode: resolvedMode,
          targetUrl: body.target_url,
          sourceUrl: body.source_url,
          presetImageId: body.preset_image_id,
          presetCollectionId: body.preset_collection_id,
          presetName: body.preset_name,
          selfieId: body.selfie_id,
          apiProvider: body.api_provider,
          additionalPrompt: body.additional_prompt,
          characterGender: body.character_gender,
        });

        let faceSwapResult: FaceSwapResponse;
        let vertexPromptPayload: any = null;

        if (resolvedMode === 'vertex' && body.preset_image_id) {
          console.log('[Vertex] Using Vertex AI-generated prompt for preset:', body.preset_image_id);

          const promptResult = await env.DB.prepare(
            'SELECT prompt_json FROM preset_images WHERE id = ?'
          ).bind(body.preset_image_id).first();

          if (!promptResult || !(promptResult as any).prompt_json) {
            console.error('[Vertex] No prompt_json found in database for preset:', body.preset_image_id);
            return errorResponse('No Vertex AI-generated prompt found for this preset image. Please re-upload the preset image to automatically generate the prompt using Vertex AI API. If you continue to see this error, check that your Google Vertex AI credentials are configured correctly.', 400);
          }

          const storedPromptPayload = JSON.parse((promptResult as any).prompt_json);
          const augmentedPromptPayload = augmentVertexPrompt(
            storedPromptPayload,
            body.additional_prompt,
            body.character_gender
          );
          vertexPromptPayload = augmentedPromptPayload;

          console.log('[Vertex] Dispatching prompt to Nano Banana provider');
          const nanoResult = await callNanoBanana(augmentedPromptPayload, body.target_url, body.source_url, env);

          if (!nanoResult.Success || !nanoResult.ResultImageUrl) {
            console.error('[Vertex] Nano Banana provider failed:', JSON.stringify(nanoResult, null, 2));

            let sanitizedVertexFailure: any = null;
            const fullResponse = (nanoResult as any).FullResponse;
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
              response: sanitizedVertexFailure || (nanoResult as any).VertexResponse,
              curlCommand: (nanoResult as any).CurlCommand,
            });

            const debugPayload = compact({
              request: requestDebug,
              provider: buildProviderDebug(nanoResult),
              vertex: vertexDebugFailure,
            });

            const failureCode = nanoResult.StatusCode || 500;

            return jsonResponse({
              data: null,
              debug: debugPayload,
              status: 'error',
              message: nanoResult.Message || 'Nano Banana provider failed to generate image',
              code: failureCode,
            }, failureCode);
          }

          if (nanoResult.ResultImageUrl?.startsWith('r2://')) {
            const r2Key = nanoResult.ResultImageUrl.replace('r2://', '');
            const requestUrl = new URL(request.url);
            nanoResult.ResultImageUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
            console.log('[Vertex] Converted R2 URL to public URL:', nanoResult.ResultImageUrl);
          }

          faceSwapResult = nanoResult;
        } else {
          faceSwapResult = await callFaceSwap(body.target_url, body.source_url, env);
        }

        if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
          console.error('FaceSwap failed:', faceSwapResult);
          const failureCode = faceSwapResult.StatusCode || 500;
          const debugPayload = compact({
            request: requestDebug,
            provider: buildProviderDebug(faceSwapResult),
            vertex: resolvedMode === 'vertex' ? mergeVertexDebug(faceSwapResult, vertexPromptPayload) : undefined,
          });
          return jsonResponse({
            data: null,
            debug: debugPayload,
            status: 'error',
            message: faceSwapResult.Message || 'Face swap provider error',
            code: failureCode,
          }, failureCode);
        }

        const disableSafeSearch = env.DISABLE_SAFE_SEARCH === 'true';
        const skipSafetyCheckForVertex = resolvedMode === 'vertex';
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
              vertex: resolvedMode === 'vertex' ? mergeVertexDebug(faceSwapResult, vertexPromptPayload) : undefined,
              vision: buildVisionDebug(safetyDebug),
            });
            return jsonResponse({
              data: null,
              debug: debugPayload,
              status: 'error',
              message: `Safe search validation failed: ${safeSearchResult.error}`,
              code: 500,
            }, 500);
          }

          if (!safeSearchResult.isSafe) {
            console.warn('[FaceSwap] Content blocked - unsafe content detected:', safeSearchResult.details);
            const violationCategory = safeSearchResult.violationCategory || 'unsafe content';
            const violationLevel = safeSearchResult.violationLevel || 'LIKELY';
            const debugPayload = compact({
              request: requestDebug,
              provider: buildProviderDebug(faceSwapResult),
              vertex: resolvedMode === 'vertex' ? mergeVertexDebug(faceSwapResult, vertexPromptPayload) : undefined,
              vision: buildVisionDebug(safetyDebug),
            });
            return jsonResponse({
              data: null,
              debug: debugPayload,
              status: 'error',
              message: `Content blocked: Image contains ${violationCategory} content (${violationLevel})`,
              code: 422,
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
            await env.FACESWAP_IMAGES.put(resultKey, resultImageData, {
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

        if (body.preset_image_id && body.preset_collection_id && body.preset_name) {
          databaseDebug.attempted = true;
          try {
            let selfieId = body.selfie_id;
            if (!selfieId) {
              try {
                const selfieResult = await env.DB.prepare(
                  'SELECT id FROM selfies WHERE image_url = ? ORDER BY created_at DESC LIMIT 1'
                ).bind(body.source_url).first();
                if (selfieResult) {
                  selfieId = (selfieResult as any).id;
                }
              } catch (lookupError) {
                console.warn('Could not find selfie in database:', lookupError);
                databaseDebug.lookupError = lookupError instanceof Error ? lookupError.message : String(lookupError);
              }
            }

            const resultId = `result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
            await env.DB.prepare(
              'INSERT INTO results (id, selfie_id, preset_collection_id, preset_image_id, preset_name, result_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).bind(resultId, selfieId || null, body.preset_collection_id, body.preset_image_id, body.preset_name, resultUrl, Math.floor(Date.now() / 1000)).run();
            databaseDebug.success = true;
            databaseDebug.resultId = resultId;
            databaseDebug.error = null;
          } catch (dbError) {
            console.warn('Database save error (non-fatal):', dbError);
            databaseDebug.error = dbError instanceof Error ? dbError.message : String(dbError);
          }
        }

        const providerDebug = buildProviderDebug(faceSwapResult, resultUrl);
        const vertexDebug = resolvedMode === 'vertex' ? mergeVertexDebug(faceSwapResult, vertexPromptPayload) : undefined;
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
            resultImageUrl: resultUrl,
          },
          debug: debugPayload,
          status: 'success',
          message: faceSwapResult.Message || 'Processing successful',
          code: 200,
        });
      } catch (error) {
        console.error('Unhandled error:', error);
        return errorResponse(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // 404 for unmatched routes
    return errorResponse('Not found', 404);
  },
};
