/// <reference types="@cloudflare/workers-types" />

import type { Env, FaceSwapRequest, UploadUrlRequest } from './types';
import { CORS_HEADERS, jsonResponse, errorResponse } from './utils';
import { callFaceSwap, checkSafeSearch, generateGeminiPrompt } from './services';
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
          enableGeminiPrompt: body.enableGeminiPrompt // Pass through Gemini prompt flag
        });
      } catch (error) {
        console.error('Upload URL generation error:', error);
        return errorResponse(`Failed to generate upload URL: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle Gemini prompt retrieval for presets
    if (path.startsWith('/gemini/get-prompt/') && request.method === 'GET') {
      try {
        const presetImageId = path.replace('/gemini/get-prompt/', '');

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
        console.error('[Gemini] Prompt retrieval error:', error);
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
          const enableGeminiPrompt = request.headers.get('X-Enable-Gemini-Prompt') === 'true';
          console.log('Raw preset name:', presetName, 'Enable Gemini Prompt:', enableGeminiPrompt);

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

          // Try to save to database, but don't fail the upload if DB fails
          let imageId: string | undefined;
          let promptJson: string | null = null;

          try {
            // First, check if a collection with this name already exists
            let collectionResult = await env.DB.prepare(
              'SELECT id FROM preset_collections WHERE name = ?'
            ).bind(presetName).first();

            let collectionId: string;

            if (!collectionResult) {
              // Create new collection
              collectionId = `collection_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
              await env.DB.prepare(
                'INSERT INTO preset_collections (id, name, created_at) VALUES (?, ?, ?)'
              ).bind(collectionId, presetName, Math.floor(Date.now() / 1000)).run();
            } else {
              collectionId = collectionResult.id as string;
            }

            // Generate Gemini prompt automatically using Gemini API if enabled
            if (enableGeminiPrompt) {
              console.log('[Gemini] Generating prompt for uploaded preset image...');
              const promptResult = await generateGeminiPrompt(publicUrl, env);
              if (promptResult.success && promptResult.prompt) {
                promptJson = JSON.stringify(promptResult.prompt);
                console.log('[Gemini] Generated prompt successfully');
              } else {
                console.warn('[Gemini] Failed to generate prompt:', promptResult.error);
                // Don't fail the upload, just continue without prompt
              }
            }

            // Add image to collection
            imageId = `image_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
            const result = await env.DB.prepare(
              'INSERT INTO preset_images (id, collection_id, image_url, prompt_json, created_at) VALUES (?, ?, ?, ?, ?)'
            ).bind(imageId, collectionId, publicUrl, promptJson, Math.floor(Date.now() / 1000)).run();

            console.log(`Preset image saved to database: ${imageId}, collection: ${collectionId}, hasPrompt: ${!!promptJson}, result:`, result);
          } catch (dbError) {
            console.error('Database save error (non-fatal):', dbError);
            // Still return success since file was uploaded to R2
            // Database might not be initialized yet
            // Generate a temporary ID if DB save failed
            imageId = `preset_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          }

          return jsonResponse({
            success: true,
            url: publicUrl,
            id: imageId || `preset_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`,
            filename: key.replace('preset/', ''),
            hasPrompt: !!promptJson
          });
        } else if (key.startsWith('selfie/')) {
          console.log('Processing selfie upload:', key);

          // Extract filename from key (remove 'selfie/' prefix)
          const filename = key.replace('selfie/', '');
          const selfieId = `selfie_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          const createdAt = Math.floor(Date.now() / 1000);

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

            const result = await env.DB.prepare(
              'INSERT INTO selfies (id, image_url, filename, created_at) VALUES (?, ?, ?, ?)'
            ).bind(selfieId, publicUrl, filename, createdAt).run();

            if (!result.success) {
              console.error('Database insert returned success=false:', result);
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

    // Handle preset listing
    if (path === '/presets' && request.method === 'GET') {
      try {
        console.log('Fetching presets from database...');
        // Get all preset images as a flat list
        const imagesResult = await env.DB.prepare(`
          SELECT
            i.id,
            i.image_url,
            i.prompt_json,
            i.created_at,
            c.name as collection_name
          FROM preset_images i
          LEFT JOIN preset_collections c ON i.collection_id = c.id
          ORDER BY i.created_at DESC
        `).all();

        console.log('Presets query result:', {
          success: imagesResult.success,
          resultsCount: imagesResult.results?.length || 0,
          meta: imagesResult.meta
        });

        if (!imagesResult || !imagesResult.results) {
          console.log('No presets found in database');
          return jsonResponse({ presets: [] });
        }

        // Flatten to match frontend expectations
        const presets = imagesResult.results.map((row: any) => ({
          id: row.id || '',
          image_url: row.image_url || '',
          filename: row.image_url?.split('/').pop() || `preset_${row.id}.jpg`,
          collection_name: row.collection_name || 'Unnamed',
          hasPrompt: row.prompt_json ? true : false,
          created_at: row.created_at ? new Date(row.created_at * 1000).toISOString() : new Date().toISOString()
        }));

        console.log(`Returning ${presets.length} presets`);
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
        console.log(`Deleting preset: ${presetId}`);

        // Get the image URL before deleting
        const imageResult = await env.DB.prepare(
          'SELECT image_url FROM preset_images WHERE id = ?'
        ).bind(presetId).first();

        // Delete from database
        const deleteResult = await env.DB.prepare(
          'DELETE FROM preset_images WHERE id = ?'
        ).bind(presetId).run();

        console.log(`Preset deleted from database: ${presetId}`, {
          success: deleteResult.success,
          meta: deleteResult.meta
        });

        // Try to delete from R2 (non-fatal if it fails)
        if (imageResult && (imageResult as any).image_url) {
          try {
            const imageUrl = (imageResult as any).image_url;
            // Extract key from URL (remove domain part)
            const urlParts = imageUrl.split('/');
            const key = urlParts.slice(-2).join('/'); // Get last two parts (e.g., "preset/filename.jpg")
            
            await env.FACESWAP_IMAGES.delete(key);
            console.log(`Preset deleted from R2: ${key}`);
          } catch (r2Error) {
            console.warn('R2 delete error (non-fatal):', r2Error);
          }
        }

        return jsonResponse({ success: true, message: 'Preset deleted successfully' });
      } catch (error) {
        console.error('Delete preset error:', error);
        return errorResponse(`Failed to delete preset: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle selfies listing
    if (path === '/selfies' && request.method === 'GET') {
      try {
        console.log('Fetching selfies from database...');
        const result = await env.DB.prepare(
          'SELECT id, image_url, filename, created_at FROM selfies ORDER BY created_at DESC LIMIT 50'
        ).all();

        console.log('Selfies query result:', {
          success: result.success,
          resultsCount: result.results?.length || 0,
          meta: result.meta
        });

        if (!result || !result.results) {
          console.log('No selfies found in database');
          return jsonResponse({ selfies: [] });
        }

        const selfies = result.results.map((row: any) => ({
          id: row.id || '',
          image_url: row.image_url || '',
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
        console.log(`Deleting selfie: ${selfieId}`);

        // Get the image URL before deleting
        const selfieResult = await env.DB.prepare(
          'SELECT image_url FROM selfies WHERE id = ?'
        ).bind(selfieId).first();

        // Delete from database
        const deleteResult = await env.DB.prepare(
          'DELETE FROM selfies WHERE id = ?'
        ).bind(selfieId).run();

        console.log(`Selfie deleted from database: ${selfieId}`, {
          success: deleteResult.success,
          meta: deleteResult.meta
        });

        // Try to delete from R2 (non-fatal if it fails)
        if (selfieResult && (selfieResult as any).image_url) {
          try {
            const imageUrl = (selfieResult as any).image_url;
            // Extract key from URL (remove domain part)
            const urlParts = imageUrl.split('/');
            const key = urlParts.slice(-2).join('/'); // Get last two parts (e.g., "selfie/filename.jpg")
            
            await env.FACESWAP_IMAGES.delete(key);
            console.log(`Selfie deleted from R2: ${key}`);
          } catch (r2Error) {
            console.warn('R2 delete error (non-fatal):', r2Error);
          }
        }

        return jsonResponse({ success: true, message: 'Selfie deleted successfully' });
      } catch (error) {
        console.error('Delete selfie error:', error);
        return errorResponse(`Failed to delete selfie: ${error instanceof Error ? error.message : String(error)}`, 500);
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

    // Test Gemini API connectivity
    if (path === '/test-gemini' && request.method === 'GET') {
      try {
        return jsonResponse({
          message: 'Gemini API key configured successfully!',
          hasApiKey: !!env.GOOGLE_CLOUD_API_KEY,
          apiKeyLength: env.GOOGLE_CLOUD_API_KEY?.length || 0,
          ready: true
        });
      } catch (error) {
        return errorResponse(`Gemini test failed: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle face swap endpoint (root path or /faceswap)
    if ((path === '/' || path === '/faceswap') && request.method === 'POST') {
      const envError = validateEnv(env);
      if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

      try {
        const body: FaceSwapRequest & { preset_image_id?: string; preset_collection_id?: string; preset_name?: string; mode?: string } = await request.json();
        const requestError = validateRequest(body);
        if (requestError) return errorResponse(requestError, 400);

        let faceSwapResult;

        // Check if using Gemini mode (Gemini-generated prompts)
        if (body.mode === 'gemini' && body.preset_image_id) {
          console.log('[Gemini] Using Gemini-generated prompt for preset:', body.preset_image_id);

          // Get the stored Gemini-generated prompt JSON from database
          const promptResult = await env.DB.prepare(
            'SELECT prompt_json FROM preset_images WHERE id = ?'
          ).bind(body.preset_image_id).first();

          if (!promptResult || !(promptResult as any).prompt_json) {
            return errorResponse('No Gemini-generated prompt found for this preset image. Please re-upload the preset with Gemini prompt enabled.', 400);
          }

          const promptData = JSON.parse((promptResult as any).prompt_json);

          // TODO: Replace with actual image generation API call
          // For now, we'll simulate the result - in production this would call:
          // - OpenAI DALL-E, Midjourney API, Stable Diffusion, or other image generation service
          // - Send promptData.prompt + source_url (selfie) to generate new image

          console.log('[Gemini] Would generate image with prompt:', {
            prompt: promptData.prompt,
            style: promptData.style,
            lighting: promptData.lighting,
            composition: promptData.composition,
            camera: promptData.camera,
            background: promptData.background,
            source_image: body.source_url
          });

          // Simulate successful generation (replace with actual API call)
          faceSwapResult = {
            Success: true,
            ResultImageUrl: body.target_url, // TODO: Replace with generated image URL
            Message: `Gemini prompt applied: ${promptData.prompt.substring(0, 100)}...`,
            StatusCode: 200,
            ProcessingTime: '5.0'
          };

          console.log('[Gemini] Simulated generation complete with Gemini prompt');
        } else {
          // Use RapidAPI as before
          faceSwapResult = await callFaceSwap(body.target_url, body.source_url, env);
        }

        if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
          console.error('FaceSwap failed:', faceSwapResult);
          return jsonResponse(faceSwapResult, faceSwapResult.StatusCode || 500);
        }

        // Safe search validation - can be disabled via DISABLE_SAFE_SEARCH env variable
        const disableSafeSearch = env.DISABLE_SAFE_SEARCH === 'true';
        let safetyCheckResult: { checked: boolean; isSafe: boolean; details?: any; error?: string } | undefined;
        
        if (!disableSafeSearch) {
          console.log('[FaceSwap] Running safety check on result image:', faceSwapResult.ResultImageUrl);
          const safeSearchResult = await checkSafeSearch(faceSwapResult.ResultImageUrl, env);

          // Always include safety check info in response so user can see it was called
          safetyCheckResult = {
            checked: true,
            isSafe: safeSearchResult.isSafe,
            details: safeSearchResult.details,
            error: safeSearchResult.error
          };

          if (safeSearchResult.error) {
            console.error('[FaceSwap] Safe search error:', safeSearchResult.error);
            // Return error but include safety check info
            return jsonResponse({
              Success: false,
              Message: `Safe search validation failed: ${safeSearchResult.error}`,
              StatusCode: 500,
              SafetyCheck: safetyCheckResult
            }, 500);
          }

          if (!safeSearchResult.isSafe) {
            console.warn('[FaceSwap] Content blocked - unsafe content detected:', safeSearchResult.details);
            // Get violation info for response
            const violationCategory = safeSearchResult.violationCategory || 'unsafe content';
            const violationLevel = safeSearchResult.violationLevel || 'LIKELY';
            const statusCode = safeSearchResult.statusCode || 1002; // Default to VIOLENCE if not set
            
            // Return blocked response in GenericApiResponse format
            return jsonResponse({
              data: null,
              status: 'error',
              message: `Content blocked: Image contains ${violationCategory} content (${violationLevel})`,
              code: statusCode
            }, 403);
          }
          console.log('[FaceSwap] Safe search validation passed:', safeSearchResult.details);
        } else {
          console.log('[FaceSwap] Safe search validation disabled via DISABLE_SAFE_SEARCH config');
          safetyCheckResult = {
            checked: false,
            isSafe: true,
            error: 'Safety check disabled via DISABLE_SAFE_SEARCH'
          };
        }

        // Try to download result image and store in R2 (non-fatal if it fails)
        let resultUrl = faceSwapResult.ResultImageUrl; // Use original URL as fallback
        try {
        const resultImageResponse = await fetch(faceSwapResult.ResultImageUrl);
          if (resultImageResponse.ok) {
        const resultImageData = await resultImageResponse.arrayBuffer();
        const resultKey = `results/result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.jpg`;
        
        await env.FACESWAP_IMAGES.put(resultKey, resultImageData, {
          httpMetadata: {
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=31536000, immutable', // 1 year cache
          },
        });

            resultUrl = getR2PublicUrl(env, resultKey, requestUrl.origin);
          } else {
            console.warn('Failed to download result image, using original URL');
          }
        } catch (r2Error) {
          console.warn('R2 storage error (non-fatal):', r2Error);
          // Continue with original URL
        }

        // Save result to database (non-fatal if it fails)
        if (body.preset_image_id && body.preset_collection_id && body.preset_name) {
          try {
          // Use provided selfie_id or find it by matching the source_url with selfies table
          let selfieId = body.selfie_id;
          if (!selfieId) {
            try {
              const selfieResult = await env.DB.prepare(
                'SELECT id FROM selfies WHERE image_url = ? ORDER BY created_at DESC LIMIT 1'
              ).bind(body.source_url).first();

              if (selfieResult) {
                  selfieId = (selfieResult as any).id;
              }
            } catch (dbError) {
              console.warn('Could not find selfie in database:', dbError);
            }
          }

          const resultId = `result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          await env.DB.prepare(
            'INSERT INTO results (id, selfie_id, preset_collection_id, preset_image_id, preset_name, result_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).bind(resultId, selfieId || null, body.preset_collection_id, body.preset_image_id, body.preset_name, resultUrl, Math.floor(Date.now() / 1000)).run();
          } catch (dbError) {
            console.warn('Database save error (non-fatal):', dbError);
            // Continue - don't fail the request
          }
        }

        // Return success response in GenericApiResponse format
        return jsonResponse({
          data: {
            resultImageUrl: resultUrl
          },
          debug: {
            ...faceSwapResult,
            ResultImageUrl: resultUrl,
            SafetyCheck: safetyCheckResult
          },
          status: 'success',
          message: faceSwapResult.Message || 'Face swap completed successfully',
          code: 200
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
