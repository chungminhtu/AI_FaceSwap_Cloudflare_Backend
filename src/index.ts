/// <reference types="@cloudflare/workers-types" />

import type { Env, FaceSwapRequest } from './types';
import { CORS_HEADERS, jsonResponse, errorResponse } from './utils';
import { callFaceSwap, checkSafeSearch } from './services';
import { validateEnv, validateRequest } from './validators';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' } });
    }

    if (request.method !== 'POST') {
      return errorResponse('Method not allowed. Use POST.', 405);
    }

    const envError = validateEnv(env);
    if (envError) return errorResponse(`Server configuration error: ${envError}`, 500);

    try {
      const body: FaceSwapRequest = await request.json();
      const requestError = validateRequest(body);
      if (requestError) return errorResponse(requestError, 400);

      const faceSwapResult = await callFaceSwap(body.target_url, body.source_url, env);

      if (!faceSwapResult.Success || !faceSwapResult.ResultImageUrl) {
        return jsonResponse(faceSwapResult, faceSwapResult.StatusCode || 500);
      }

      const safeSearchResult = await checkSafeSearch(faceSwapResult.ResultImageUrl, env);

      if (safeSearchResult.error) {
        console.error('Safe search error:', safeSearchResult.error);
      }

      if (!safeSearchResult.isSafe) {
        return errorResponse('Content blocked: Image contains unsafe content (adult, violence, or racy content detected)', 403);
      }

      return jsonResponse(faceSwapResult);
    } catch (error) {
      return errorResponse(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  },
};
