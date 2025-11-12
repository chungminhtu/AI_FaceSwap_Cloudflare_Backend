/// <reference types="@cloudflare/workers-types" />

import type { Env, FaceSwapRequest, UploadUrlRequest, Preset } from './types';
import { CORS_HEADERS, jsonResponse, errorResponse } from './utils';
import { callFaceSwap, checkSafeSearch } from './services';
import { validateEnv, validateRequest } from './validators';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' } });
    }

    const url = new URL(request.url);
    const path = url.pathname;

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
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' } });
      }
      
      if (request.method !== 'PUT') {
        return errorResponse('Method not allowed. Use PUT.', 405);
      }
      
      try {
        const key = path.replace('/upload-proxy/', '');
        const fileData = await request.arrayBuffer();
        
        await env.FACESWAP_IMAGES.put(key, fileData, {
          httpMetadata: {
            contentType: request.headers.get('Content-Type') || 'image/jpeg',
          },
        });

        // Get the public URL
        const publicUrl = env.R2_PUBLIC_URL 
          ? `${env.R2_PUBLIC_URL}/${key}`
          : `${url.origin}/r2/${key}`;

        // If this is a preset upload, save to database
        if (key.startsWith('preset/')) {
          const presetName = request.headers.get('X-Preset-Name') || `Preset ${Date.now()}`;
          const presetId = `preset_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          
          await env.DB.prepare(
            'INSERT INTO presets (id, name, image_url, created_at) VALUES (?, ?, ?, ?)'
          ).bind(presetId, presetName, publicUrl, Math.floor(Date.now() / 1000)).run();

          return jsonResponse({ 
            success: true, 
            url: publicUrl,
            presetId: presetId,
            presetName: presetName
          });
        }

        return jsonResponse({ success: true, url: publicUrl });
      } catch (error) {
        console.error('Upload proxy error:', error);
        return errorResponse(`Upload failed: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle preset listing
    if (path === '/presets' && request.method === 'GET') {
      try {
        const result = await env.DB.prepare(
          'SELECT id, name, image_url, created_at FROM presets ORDER BY created_at DESC'
        ).all();

        const presets = result.results.map((row: any) => ({
          id: row.id,
          name: row.name,
          image_url: row.image_url,
          created_at: new Date(row.created_at * 1000).toISOString()
        }));

        return jsonResponse({ presets });
      } catch (error) {
        console.error('List presets error:', error);
        return errorResponse(`Failed to list presets: ${error instanceof Error ? error.message : String(error)}`, 500);
      }
    }

    // Handle results listing
    if (path === '/results' && request.method === 'GET') {
      try {
        const result = await env.DB.prepare(
          'SELECT id, preset_id, preset_name, result_url, created_at FROM results ORDER BY created_at DESC LIMIT 50'
        ).all();

        const results = result.results.map((row: any) => ({
          id: row.id,
          preset_id: row.preset_id,
          preset_name: row.preset_name,
          result_url: row.result_url,
          created_at: new Date(row.created_at * 1000).toISOString()
        }));

        return jsonResponse({ results });
      } catch (error) {
        console.error('List results error:', error);
        return errorResponse(`Failed to list results: ${error instanceof Error ? error.message : String(error)}`, 500);
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

    // Handle face swap endpoint (root path or /faceswap)
    if ((path === '/' || path === '/faceswap') && request.method === 'POST') {
      const envError = validateEnv(env);
      if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

      try {
        const body: FaceSwapRequest & { preset_id?: string; preset_name?: string } = await request.json();
        const requestError = validateRequest(body);
        if (requestError) return errorResponse(requestError, 400);

        const faceSwapResult = await callFaceSwap(body.target_url, body.source_url, env);

        if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
          console.error('FaceSwap failed:', faceSwapResult);
          return jsonResponse(faceSwapResult, faceSwapResult.StatusCode || 500);
        }

        const safeSearchResult = await checkSafeSearch(faceSwapResult.ResultImageUrl, env);

        if (safeSearchResult.error) {
          console.error('Safe search error:', safeSearchResult.error);
          return errorResponse(`Safe search validation failed: ${safeSearchResult.error}`, 500);
        }

        if (!safeSearchResult.isSafe) {
          return errorResponse('Content blocked: Image contains unsafe content (adult, violence, or racy content detected)', 403);
        }

        // Download result image and store in R2
        const resultImageResponse = await fetch(faceSwapResult.ResultImageUrl);
        const resultImageData = await resultImageResponse.arrayBuffer();
        const resultKey = `results/result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}.jpg`;
        
        await env.FACESWAP_IMAGES.put(resultKey, resultImageData, {
          httpMetadata: {
            contentType: 'image/jpeg',
          },
        });

        const resultUrl = env.R2_PUBLIC_URL 
          ? `${env.R2_PUBLIC_URL}/${resultKey}`
          : `${url.origin}/r2/${resultKey}`;

        // Save result to database
        if (body.preset_id && body.preset_name) {
          const resultId = `result_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          await env.DB.prepare(
            'INSERT INTO results (id, preset_id, preset_name, result_url, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(resultId, body.preset_id, body.preset_name, resultUrl, Math.floor(Date.now() / 1000)).run();
        }

        return jsonResponse({
          ...faceSwapResult,
          ResultImageUrl: resultUrl
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
