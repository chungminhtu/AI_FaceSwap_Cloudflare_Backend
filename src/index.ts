/// <reference types="@cloudflare/workers-types" />

import type { Env, FaceSwapRequest, UploadUrlRequest, Preset } from './types';
import { CORS_HEADERS, jsonResponse, errorResponse } from './utils';
import { callFaceSwap, checkSafeSearch } from './services';
import { validateEnv, validateRequest } from './validators';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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

    // Handle upload URL generation endpoint
    if (path === '/upload-url' && request.method === 'POST') {
      try {
        const body: UploadUrlRequest = await request.json();
        
        if (!body.filename || !body.type) {
          return errorResponse('Missing required fields: filename and type', 400);
        }

        // Generate presigned URL for R2 upload
        // R2 doesn't have built-in presigned URLs, so we'll create a PUT URL
        // The HTML will upload directly using the R2 S3-compatible API
        // For now, we'll return a URL that the worker can proxy, or use R2's public access
        
        // Generate a unique key for the file
        const key = `${body.type}/${body.filename}`;
        
        // Store metadata (we'll use the worker to handle uploads via a proxy endpoint)
        // Actually, for direct browser uploads, we need R2 public access or presigned URLs
        // Since R2 doesn't support presigned URLs natively, we'll create a proxy upload endpoint
        
        // Return the key and let the HTML use a proxy endpoint
        const publicUrl = env.R2_PUBLIC_URL 
          ? `${env.R2_PUBLIC_URL}/${key}`
          : `https://${env.FACESWAP_IMAGES ? 'your-account-id' : 'pub'}.r2.dev/${key}`;

        return jsonResponse({
          uploadUrl: `${url.origin}/upload-proxy/${key}`,
          publicUrl: publicUrl,
          key: key
        });
      } catch (error) {
        console.error('Upload URL generation error:', error);
        return errorResponse(`Failed to generate upload URL: ${error instanceof Error ? error.message : String(error)}`, 500);
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
        
        // Upload to R2
        try {
          await env.FACESWAP_IMAGES.put(key, fileData, {
            httpMetadata: {
              contentType: request.headers.get('Content-Type') || 'image/jpeg',
            },
          });
          console.log(`File uploaded successfully to R2: ${key}`);
        } catch (r2Error) {
          console.error('R2 upload error:', r2Error);
          return errorResponse(`R2 upload failed: ${r2Error instanceof Error ? r2Error.message : String(r2Error)}`, 500);
        }

        // Get the public URL
        const publicUrl = env.R2_PUBLIC_URL 
          ? `${env.R2_PUBLIC_URL}/${key}`
          : `${url.origin}/r2/${key}`;

        // Save upload metadata to database based on type
        if (key.startsWith('preset/')) {
          console.log('Processing preset upload:', key);
          let presetName = request.headers.get('X-Preset-Name') || `Preset ${Date.now()}`;
          console.log('Raw preset name:', presetName);

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

          const presetId = `preset_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          console.log('Generated preset ID:', presetId);
          console.log('Public URL:', publicUrl);

          // Try to save to database, but don't fail the upload if DB fails
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

            // Add image to collection
            const imageId = `image_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
            const result = await env.DB.prepare(
              'INSERT INTO preset_images (id, collection_id, image_url, created_at) VALUES (?, ?, ?, ?)'
            ).bind(imageId, collectionId, publicUrl, Math.floor(Date.now() / 1000)).run();

            console.log(`Preset image saved to database: ${imageId}, collection: ${collectionId}, result:`, result);
          } catch (dbError) {
            console.error('Database save error (non-fatal):', dbError);
            // Still return success since file was uploaded to R2
            // Database might not be initialized yet
          }

          return jsonResponse({ 
            success: true, 
            url: publicUrl,
            presetId: presetId,
            presetName: presetName
          });
        } else if (key.startsWith('selfie/')) {
          console.log('Processing selfie upload:', key);

          // Extract filename from key (remove 'selfie/' prefix)
          const filename = key.replace('selfie/', '');
          const selfieId = `selfie_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          const createdAt = Math.floor(Date.now() / 1000);

          console.log(`Saving selfie to database: id=${selfieId}, url=${publicUrl}, filename=${filename}, created_at=${createdAt}`);

          // Try to save to database, but don't fail the upload if DB fails
          try {
            const result = await env.DB.prepare(
              'INSERT INTO selfies (id, image_url, filename, created_at) VALUES (?, ?, ?, ?)'
            ).bind(selfieId, publicUrl, filename, createdAt).run();

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
            } else {
              console.warn('Selfie not found in database after insert - possible database issue');
            }
          } catch (dbError) {
            console.error('Selfie database save error (non-fatal):', dbError);
            console.error('Error details:', {
              message: dbError instanceof Error ? dbError.message : String(dbError),
              stack: dbError instanceof Error ? dbError.stack : undefined
            });
            // Still return success since file was uploaded to R2
            // Database might not be initialized yet
          }

          return jsonResponse({
            success: true,
            url: publicUrl,
            selfieId: selfieId
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
        // Get all collections with their images
        const collectionsResult = await env.DB.prepare(`
          SELECT
            c.id,
            c.name,
            c.created_at as collection_created_at,
            i.id as image_id,
            i.image_url,
            i.created_at as image_created_at
          FROM preset_collections c
          LEFT JOIN preset_images i ON c.id = i.collection_id
          ORDER BY c.created_at DESC, i.created_at DESC
        `).all();

        if (!collectionsResult || !collectionsResult.results) {
          return jsonResponse({ preset_collections: [] });
        }

        // Group images by collection
        const collectionsMap = new Map();

        for (const row of collectionsResult.results as any[]) {
          const collectionId = row.id;
          if (!collectionsMap.has(collectionId)) {
            collectionsMap.set(collectionId, {
              id: collectionId,
          name: row.name || 'Unnamed',
              created_at: row.collection_created_at ? new Date(row.collection_created_at * 1000).toISOString() : new Date().toISOString(),
              images: []
            });
          }

          if (row.image_id && row.image_url) {
            collectionsMap.get(collectionId).images.push({
              id: row.image_id,
              collection_id: collectionId,
              image_url: row.image_url,
              created_at: row.image_created_at ? new Date(row.image_created_at * 1000).toISOString() : new Date().toISOString()
            });
          }
        }

        const presetCollections = Array.from(collectionsMap.values());

        return jsonResponse({ preset_collections: presetCollections });
      } catch (error) {
        console.error('List presets error:', error);
        // Return empty array instead of error to prevent UI breaking
        return jsonResponse({ preset_collections: [] });
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
        const body = await request.json();
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

    // Handle face swap endpoint (root path or /faceswap)
    if ((path === '/' || path === '/faceswap') && request.method === 'POST') {
      const envError = validateEnv(env);
      if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

      try {
        const body: FaceSwapRequest & { preset_image_id?: string; preset_collection_id?: string; preset_name?: string } = await request.json();
        const requestError = validateRequest(body);
        if (requestError) return errorResponse(requestError, 400);

        const faceSwapResult = await callFaceSwap(body.target_url, body.source_url, env);

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
          },
        });

            resultUrl = env.R2_PUBLIC_URL 
          ? `${env.R2_PUBLIC_URL}/${resultKey}`
          : `${url.origin}/r2/${resultKey}`;
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
