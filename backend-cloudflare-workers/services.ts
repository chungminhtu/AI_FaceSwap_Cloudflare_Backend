// backend-cloudflare-workers/services.ts
import { customAlphabet } from 'nanoid';
const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_', 21);
import type { Env, FaceSwapResponse, SafeSearchResult, GoogleVisionResponse } from './types';
import { isUnsafe, getWorstViolation, getAccessToken, getVertexAILocation, getVertexAIEndpoint, getVertexModelId, validateImageUrl, fetchWithTimeout, getVertexSafetyViolation, VERTEX_SAFETY_STATUS_CODES } from './utils';
import { VERTEX_AI_CONFIG, VERTEX_AI_PROMPTS, ASPECT_RATIO_CONFIG, API_ENDPOINTS, TIMEOUT_CONFIG, DEFAULT_VALUES, CACHE_CONFIG } from './config';

const SENSITIVE_KEYS = ['key', 'token', 'password', 'secret', 'api_key', 'apikey', 'authorization', 'private_key', 'privatekey', 'access_token', 'accesstoken', 'bearer', 'credential', 'credentials'];

const generateMockId = () => `mock-${nanoid(16)}`;
const base64ToUint8Array = (base64: string): Uint8Array => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
const getMimeExt = (mimeType: string): string => { const idx = mimeType.indexOf('/'); return idx > 0 ? mimeType.substring(idx + 1) : 'jpg'; };

const sanitizeObject = (obj: any, maxStringLength = 100): any => {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item, maxStringLength));

  const sanitized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some(sk => lowerKey.includes(sk));
    if (isSensitive && typeof value === 'string') sanitized[key] = '***REDACTED***';
    else if (key === 'data' && typeof value === 'string' && value.length > maxStringLength) sanitized[key] = '...';
    else if (typeof value === 'object' && value !== null) sanitized[key] = sanitizeObject(value, maxStringLength);
    else sanitized[key] = value;
  }
  return sanitized;
};

const getR2Bucket = (env: Env): R2Bucket => {
  const bindingName = env.R2_BUCKET_BINDING || env.R2_BUCKET_NAME || '';
  const bucket = (env as any)[bindingName] as R2Bucket;
  if (!bucket) throw new Error(`R2 bucket binding '${bindingName}' not found`);
  return bucket;
};

// Shared helper: normalize aspect ratio
const normalizeAspectRatio = (aspectRatio?: string): string => {
  if (!aspectRatio || aspectRatio === 'original') return ASPECT_RATIO_CONFIG.DEFAULT;
  return ASPECT_RATIO_CONFIG.SUPPORTED.includes(aspectRatio) ? aspectRatio : ASPECT_RATIO_CONFIG.DEFAULT;
};

// Shared helper: fetch image as base64 with O(n) chunked encoding
const fetchImageAsBase64 = async (imageUrl: string, env: Env): Promise<string> => {
  if (!validateImageUrl(imageUrl, env)) throw new Error(`Invalid or unsafe image URL: ${imageUrl}`);
  const response = await fetchWithTimeout(imageUrl, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

  const uint8Array = new Uint8Array(await response.arrayBuffer());
  const CHUNK_SIZE = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    chunks.push(String.fromCharCode.apply(null, uint8Array.subarray(i, Math.min(i + CHUNK_SIZE, uint8Array.length)) as unknown as number[]));
  }
  return btoa(chunks.join(''));
};

// Shared helper: extract image from Vertex AI response parts
const extractImageFromParts = (parts: any[]): { base64Image: string; mimeType: string } | null => {
  for (const part of parts) {
    const inlineData = part.inlineData || part.inline_data;
    if (inlineData?.data) {
      return {
        base64Image: inlineData.data,
        mimeType: inlineData.mimeType || inlineData.mime_type || 'image/jpeg'
      };
    }
  }
  return null;
};

// Shared helper: upload base64 image to R2
const uploadImageToR2 = async (base64Image: string, mimeType: string, env: Env): Promise<string> => {
  const bytes = base64ToUint8Array(base64Image);
  const ext = getMimeExt(mimeType);
  const resultKey = `results/${nanoid(16)}.${ext}`;
  const R2_BUCKET = getR2Bucket(env);
  await R2_BUCKET.put(resultKey, bytes, { httpMetadata: { contentType: mimeType, cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL } });
  return `r2://${resultKey}`;
};

// Shared helper: create error response
const errorResult = (message: string, statusCode: number, debug?: any): FaceSwapResponse => ({
  Success: false, Message: message, StatusCode: statusCode, Error: message, Debug: debug
});

// Shared helper: create success response
const successResult = (resultUrl: string, message: string, statusCode: number, debug?: any): FaceSwapResponse => ({
  Success: true, ResultImageUrl: resultUrl, Message: message, StatusCode: statusCode, Debug: debug
});

// Shared helper: check credentials
const checkVertexCredentials = (env: Env): FaceSwapResponse | null => {
  if (!env.GOOGLE_VERTEX_PROJECT_ID) return errorResult('GOOGLE_VERTEX_PROJECT_ID is required', 500);
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return errorResult('Google Service Account credentials are required for Vertex AI', 500);
  }
  return null;
};

// Shared helper: process Vertex AI response
const processVertexResponse = async (
  response: Response,
  rawResponse: string,
  env: Env,
  debugInfo?: Record<string, any>
): Promise<FaceSwapResponse> => {
  if (!response.ok) {
    let parsedError: any = null;
    try { parsedError = JSON.parse(rawResponse); } catch {}
    if (debugInfo) debugInfo.rawResponse = parsedError || rawResponse;

    const safetyViolation = parsedError ? getVertexSafetyViolation(parsedError) : null;
    if (safetyViolation) return errorResult(safetyViolation.reason, safetyViolation.code, debugInfo);

    let errorMsg = 'Processing failed';
    if (parsedError?.error?.message) errorMsg = parsedError.error.message;
    else if (parsedError?.message) errorMsg = parsedError.message;

    const statusCode = (response.status >= 200 && response.status < 600) ? response.status : VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR;
    return errorResult(errorMsg, statusCode, debugInfo);
  }

  let data: any;
  try { data = JSON.parse(rawResponse); } catch {
    return errorResult('Failed to parse response', VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR, debugInfo);
  }

  if (debugInfo) debugInfo.rawResponse = sanitizeObject(data);

  const safetyViolation = getVertexSafetyViolation(data);
  if (safetyViolation) return errorResult(safetyViolation.reason, safetyViolation.code, debugInfo);

  const candidates = data.candidates || [];
  if (candidates.length === 0) {
    const sv = getVertexSafetyViolation(data);
    return sv ? errorResult(sv.reason, sv.code, debugInfo) : errorResult('Processing failed', VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR, debugInfo);
  }

  const parts = candidates[0].content?.parts || [];
  const imageData = extractImageFromParts(parts);
  if (!imageData) {
    const sv = getVertexSafetyViolation(data);
    return sv ? errorResult(sv.reason, sv.code, debugInfo) : errorResult('No image data in response', VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR, debugInfo);
  }

  const resultUrl = await uploadImageToR2(imageData.base64Image, imageData.mimeType, env);
  if (debugInfo) { debugInfo.r2Key = resultUrl.replace('r2://', ''); debugInfo.mimeType = imageData.mimeType; }
  return successResult(resultUrl, 'Processing successful', 200, debugInfo);
};

export const callFaceSwap = async (targetUrl: string, sourceUrl: string, env: Env): Promise<FaceSwapResponse> => {
  const formData = new FormData();
  formData.append('target_url', targetUrl);
  formData.append('source_url', sourceUrl);

  const startTime = Date.now();
  const response = await fetchWithTimeout(env.RAPIDAPI_ENDPOINT, {
    method: 'POST',
    headers: { 'accept': 'application/json', 'x-rapidapi-host': env.RAPIDAPI_HOST, 'x-rapidapi-key': env.RAPIDAPI_KEY },
    body: formData,
  }, 60000);

  const responseText = await response.text();
  const debugInfo: Record<string, any> = { endpoint: env.RAPIDAPI_ENDPOINT, status: response.status, durationMs: Date.now() - startTime };

  if (!response.ok) {
    debugInfo.rawResponse = responseText.substring(0, 2000);
    return { Success: false, Message: `FaceSwap API error: ${response.status}`, StatusCode: response.status, Error: responseText, Debug: debugInfo };
  }

  try {
    const data = JSON.parse(responseText);
    const result: FaceSwapResponse = {
      Success: data.message === 'Processing successful' || !!data.file_url,
      ResultImageUrl: data.file_url || data.ResultImageUrl,
      Message: data.message || 'Face swap completed',
      StatusCode: response.status,
      ProcessingTime: data.processing_time?.toString(),
      Debug: debugInfo,
    };
    if (!result.ResultImageUrl) { result.Success = false; result.Message = data.message || 'No result image URL received'; }
    return result;
  } catch {
    return { Success: false, Message: 'Failed to parse FaceSwap API response', StatusCode: 500, Error: responseText.substring(0, 200), Debug: debugInfo };
  }
};

export const callNanoBanana = async (
  prompt: unknown, targetUrl: string, sourceUrl: string | string[], env: Env, aspectRatio?: string, modelParam?: string | number
): Promise<FaceSwapResponse> => {
  const credErr = checkVertexCredentials(env);
  if (credErr) return credErr;

  try {
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = getVertexAILocation(env);
    const geminiModel = getVertexModelId(modelParam);
    const geminiEndpoint = getVertexAIEndpoint(projectId, location, geminiModel);

    let promptText = typeof prompt === 'object' ? JSON.stringify(prompt, null, 2) : String(prompt || '');
    if (!promptText.includes('100% identical facial features')) {
      promptText = `${promptText} ${VERTEX_AI_PROMPTS.FACIAL_PRESERVATION_INSTRUCTION}`;
    }
    const faceSwapPrompt = `${promptText}\n\n${VERTEX_AI_PROMPTS.CONTENT_SAFETY_INSTRUCTION}`;

    const accessToken = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, env);
    const sourceUrls = Array.isArray(sourceUrl) ? sourceUrl : [sourceUrl];
    const selfieImageDataArray = await Promise.all(sourceUrls.map(url => fetchImageAsBase64(url, env)));
    const normalizedAR = normalizeAspectRatio(aspectRatio);

    const imageParts = selfieImageDataArray.map(data => ({ inline_data: { mime_type: 'image/jpeg', data } }));
    const requestBody = {
      contents: [{ role: 'user', parts: [...imageParts, { text: faceSwapPrompt }] }],
      generationConfig: { ...VERTEX_AI_CONFIG.IMAGE_GENERATION, imageConfig: { ...VERTEX_AI_CONFIG.IMAGE_GENERATION.imageConfig, aspectRatio: normalizedAR } },
      safetySettings: VERTEX_AI_CONFIG.SAFETY_SETTINGS,
    };

    const debugEnabled = env.ENABLE_DEBUG_RESPONSE === 'true';
    const debugInfo: Record<string, any> = { endpoint: geminiEndpoint, model: geminiModel, normalizedAspectRatio: normalizedAR };
    if (debugEnabled) debugInfo.requestPayload = sanitizeObject(requestBody);

    if (env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
      const mockKey = `results/${generateMockId()}.jpg`;
      return successResult(`r2://${mockKey}`, 'Vertex AI disabled (performance testing)', 200, { disabled: true, mockId: mockKey });
    }

    const startTime = Date.now();
    const response = await fetchWithTimeout(geminiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(requestBody),
    }, 60000);

    const rawResponse = await response.text();
    debugInfo.durationMs = Date.now() - startTime;
    debugInfo.status = response.status;

    return await processVertexResponse(response, rawResponse, env, debugInfo);
  } catch (error) {
    return errorResult(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR);
  }
};

export const generateBackgroundFromPrompt = async (
  prompt: string, env: Env, aspectRatio?: string, modelParam?: string | number
): Promise<FaceSwapResponse> => {
  const credErr = checkVertexCredentials(env);
  if (credErr) return credErr;

  try {
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = getVertexAILocation(env);
    const geminiModel = getVertexModelId(modelParam);
    const geminiEndpoint = getVertexAIEndpoint(projectId, location, geminiModel);
    const normalizedAR = normalizeAspectRatio(aspectRatio);
    const safePrompt = `${prompt}\n\n${VERTEX_AI_PROMPTS.CONTENT_SAFETY_INSTRUCTION}`;

    const accessToken = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, env);

    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: safePrompt }] }],
      generationConfig: { ...VERTEX_AI_CONFIG.IMAGE_GENERATION, imageConfig: { ...VERTEX_AI_CONFIG.IMAGE_GENERATION.imageConfig, aspectRatio: normalizedAR } },
      safetySettings: VERTEX_AI_CONFIG.SAFETY_SETTINGS,
    };

    const debugEnabled = env.ENABLE_DEBUG_RESPONSE === 'true';
    const debugInfo: Record<string, any> = { endpoint: geminiEndpoint, model: geminiModel, normalizedAspectRatio: normalizedAR };
    if (debugEnabled) debugInfo.requestPayload = sanitizeObject(requestBody);

    if (env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
      const mockKey = `results/${generateMockId()}.jpg`;
      return successResult(`r2://${mockKey}`, 'Vertex AI background generation disabled (performance testing)', 200, { disabled: true });
    }

    const startTime = Date.now();
    const response = await fetchWithTimeout(geminiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(requestBody),
    }, 60000);

    const rawResponse = await response.text();
    debugInfo.durationMs = Date.now() - startTime;
    debugInfo.status = response.status;

    return await processVertexResponse(response, rawResponse, env, debugInfo);
  } catch (error) {
    return errorResult('Processing failed', VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR);
  }
};

export const callNanoBananaMerge = async (
  prompt: unknown, selfieUrl: string, presetUrl: string, env: Env, aspectRatio?: string, modelParam?: string | number
): Promise<FaceSwapResponse> => {
  const credErr = checkVertexCredentials(env);
  if (credErr) return credErr;

  try {
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = getVertexAILocation(env);
    const geminiModel = getVertexModelId(modelParam);
    const geminiEndpoint = getVertexAIEndpoint(projectId, location, geminiModel);

    const promptText = typeof prompt === 'object' ? JSON.stringify(prompt, null, 2) : String(prompt || '');
    const mergePrompt = `${promptText || VERTEX_AI_PROMPTS.MERGE_PROMPT_DEFAULT}\n\n${VERTEX_AI_PROMPTS.CONTENT_SAFETY_INSTRUCTION}`;
    const normalizedAR = normalizeAspectRatio(aspectRatio);

    const accessToken = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, env);
    const [selfieImageData, presetImageData] = await Promise.all([fetchImageAsBase64(selfieUrl, env), fetchImageAsBase64(presetUrl, env)]);

    const requestBody = {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: DEFAULT_VALUES.IMAGE_MIME_TYPE, data: selfieImageData } },
          { inline_data: { mime_type: DEFAULT_VALUES.IMAGE_MIME_TYPE, data: presetImageData } },
          { text: mergePrompt }
        ]
      }],
      generationConfig: { ...VERTEX_AI_CONFIG.IMAGE_GENERATION, imageConfig: { ...VERTEX_AI_CONFIG.IMAGE_GENERATION.imageConfig, aspectRatio: normalizedAR } },
      safetySettings: VERTEX_AI_CONFIG.SAFETY_SETTINGS,
    };

    const debugEnabled = env.ENABLE_DEBUG_RESPONSE === 'true';
    const debugInfo: Record<string, any> = { endpoint: geminiEndpoint, model: geminiModel, normalizedAspectRatio: normalizedAR };
    if (debugEnabled) debugInfo.requestPayload = sanitizeObject(requestBody);

    if (env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
      const mockKey = `results/${generateMockId()}.jpg`;
      return successResult(`r2://${mockKey}`, 'Vertex AI merge disabled (performance testing)', 200, { disabled: true });
    }

    const startTime = Date.now();
    const response = await fetchWithTimeout(geminiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(requestBody),
    }, 60000);

    const rawResponse = await response.text();
    debugInfo.durationMs = Date.now() - startTime;
    debugInfo.status = response.status;

    return await processVertexResponse(response, rawResponse, env, debugInfo);
  } catch (error) {
    return errorResult('Processing failed', VERTEX_SAFETY_STATUS_CODES.UNKNOWN_ERROR);
  }
};

export const checkSafeSearch = async (imageUrl: string, env: Env): Promise<SafeSearchResult> => {
  try {
    const apiKey = env.GOOGLE_VISION_API_KEY;
    if (!apiKey) return { isSafe: false, error: 'GOOGLE_VISION_API_KEY not set' };

    if (env.DISABLE_VISION_API === 'true') return { isSafe: true, debug: { disabled: true, mode: 'performance_testing' } };

    const endpoint = `${env.GOOGLE_VISION_ENDPOINT}?key=${apiKey}`;
    const requestBody = { requests: [{ image: { source: { imageUri: imageUrl } }, features: [{ type: 'SAFE_SEARCH_DETECTION', maxResults: 1 }] }] };

    const startTime = Date.now();
    const response = await fetchWithTimeout(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }, 60000);

    const debugInfo: Record<string, any> = { endpoint: env.GOOGLE_VISION_ENDPOINT, status: response.status, durationMs: Date.now() - startTime, imageUrl };

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `API error: ${response.status} - ${errorText.substring(0, 200)}`;
      if (response.status === 403 && errorText.includes('billing')) {
        errorMessage = 'Billing not enabled for Google Vision API';
      }
      return { isSafe: false, error: errorMessage, debug: debugInfo };
    }

    const data = await response.json() as GoogleVisionResponse;
    const annotation = data.responses?.[0]?.safeSearchAnnotation;

    if (data.responses?.[0]?.error) return { isSafe: false, error: data.responses[0].error.message, rawResponse: data, debug: debugInfo };
    if (!annotation) return { isSafe: false, error: 'No safe search annotation', rawResponse: data, debug: debugInfo };

    const isUnsafeResult = isUnsafe(annotation);
    const worstViolation = getWorstViolation(annotation);
    let statusCode: number | undefined;
    if (isUnsafeResult) statusCode = worstViolation?.code || 1001;

    return {
      isSafe: !isUnsafeResult,
      statusCode,
      violationCategory: worstViolation?.category,
      violationLevel: worstViolation?.level,
      details: annotation,
      rawResponse: data,
      debug: debugInfo,
    };
  } catch (error) {
    return { isSafe: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export const checkImageSafetyWithFlashLite = async (imageUrl: string, env: Env): Promise<{ safe: boolean; reason?: string; category?: string; error?: string; debug?: any }> => {
  const startTime = Date.now();
  const debugInfo: any = {};

  try {
    if (!VERTEX_AI_CONFIG.SAFETY_CHECK_ENABLED || env.DISABLE_SAFETY_CHECK === 'true' || env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
      return { safe: true, debug: { disabled: true, mode: 'safety_check_disabled', responseTimeMs: Date.now() - startTime } };
    }

    if (!env.GOOGLE_VERTEX_PROJECT_ID || !env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      return { safe: false, error: 'Missing Vertex AI credentials', debug: { errorDetails: 'Credentials missing' } };
    }

    const model = VERTEX_AI_CONFIG.MODELS.SAFETY_CHECK;
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = env.GOOGLE_VERTEX_LOCATION || VERTEX_AI_CONFIG.LOCATIONS.MODEL_LOCATIONS[model as keyof typeof VERTEX_AI_CONFIG.LOCATIONS.MODEL_LOCATIONS] || VERTEX_AI_CONFIG.LOCATIONS.DEFAULT;
    const endpoint = VERTEX_AI_CONFIG.ENDPOINTS.REGIONAL(location, projectId, model);

    debugInfo.endpoint = endpoint;
    debugInfo.model = model;

    const imageData = await fetchImageAsBase64(imageUrl, env);
    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: 'Describe this image briefly.' }, { inlineData: { mimeType: 'image/jpeg', data: imageData } }] }],
      generationConfig: VERTEX_AI_CONFIG.SAFETY_CHECK,
      safetySettings: VERTEX_AI_CONFIG.SAFETY_CHECK_SETTINGS,
    };

    const accessToken = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, env);
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }, TIMEOUT_CONFIG.VERTEX_AI);

    debugInfo.responseTimeMs = Date.now() - startTime;
    debugInfo.httpStatus = response.status;

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 400 && errorText.includes('SAFETY')) {
        return { safe: false, reason: 'Image blocked by safety filters', category: 'safety_block', debug: debugInfo };
      }
      return { safe: false, error: `API error: ${response.status}`, debug: { ...debugInfo, rawError: errorText.substring(0, 500) } };
    }

    const data = await response.json() as any;
    debugInfo.rawResponse = data;

    if (data.promptFeedback?.blockReason) {
      return { safe: false, reason: `Image blocked: ${data.promptFeedback.blockReason}`, category: data.promptFeedback.blockReason.toLowerCase(), debug: debugInfo };
    }

    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') {
      const blockedRating = candidate.safetyRatings?.find((r: any) => r.blocked === true);
      return { safe: false, reason: blockedRating ? `Safety blocked: ${blockedRating.category}` : 'Image blocked by safety filter', category: blockedRating?.category?.toLowerCase() || 'safety', debug: debugInfo };
    }

    for (const rating of candidate?.safetyRatings || []) {
      if (rating.blocked === true) {
        return { safe: false, reason: `Safety blocked: ${rating.category}`, category: rating.category?.toLowerCase(), debug: debugInfo };
      }
    }

    return { safe: true, debug: debugInfo };
  } catch (error) {
    return { safe: false, error: error instanceof Error ? error.message : String(error), debug: { ...debugInfo, responseTimeMs: Date.now() - startTime } };
  }
};

export const generateVertexPrompt = async (
  imageUrl: string, env: Env, isFilterMode: boolean = false, customPromptText: string | null = null
): Promise<{ success: boolean; prompt?: any; error?: string; debug?: any }> => {
  const startTime = Date.now();

  if (env.DISABLE_VERTEX_IMAGE_GEN === 'true') {
    return {
      success: true,
      prompt: { prompt: 'A professional portrait with natural lighting', style: 'photorealistic', lighting: 'natural', composition: 'portrait', camera: 'professional', background: 'neutral' },
      debug: { disabled: true, mode: 'performance_testing', responseTimeMs: Date.now() - startTime }
    };
  }

  const debugInfo: any = {};

  try {
    if (!env.GOOGLE_VERTEX_PROJECT_ID || !env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      return { success: false, error: 'Vertex AI credentials required', debug: { errorDetails: 'Missing credentials' } };
    }

    const geminiModel = VERTEX_AI_CONFIG.MODELS.PROMPT_GENERATION;
    const projectId = env.GOOGLE_VERTEX_PROJECT_ID;
    const location = getVertexAILocation(env);
    const vertexEndpoint = getVertexAIEndpoint(projectId, location, geminiModel);

    debugInfo.endpoint = vertexEndpoint;
    debugInfo.model = geminiModel;

    const prompt = customPromptText?.trim() || (isFilterMode ? VERTEX_AI_PROMPTS.PROMPT_GENERATION_FILTER : VERTEX_AI_PROMPTS.PROMPT_GENERATION_DEFAULT);
    const imageData = await fetchImageAsBase64(imageUrl, env);

    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: DEFAULT_VALUES.IMAGE_MIME_TYPE, data: imageData } }] }],
      generationConfig: VERTEX_AI_CONFIG.PROMPT_GENERATION,
      safetySettings: VERTEX_AI_CONFIG.SAFETY_SETTINGS,
    };

    debugInfo.requestSent = true;
    const accessToken = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, env);

    const response = await fetchWithTimeout(vertexEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify(requestBody),
    }, TIMEOUT_CONFIG.VERTEX_AI);

    debugInfo.httpStatus = response.status;
    debugInfo.responseTimeMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      debugInfo.rawError = errorText;
      return { success: false, error: `Vertex AI API error: ${response.status}`, debug: debugInfo };
    }

    const data = await response.json() as any;
    const parts = data.candidates?.[0]?.content?.parts;

    if (!parts || parts.length === 0) {
      return { success: false, error: 'No response parts from Vertex AI API', debug: debugInfo };
    }

    let promptJson: any = null;

    for (const part of parts) {
      if (!part.text) continue;
      let jsonText = part.text.trim();

      // Try direct parse
      try { promptJson = JSON.parse(jsonText); break; } catch {}

      // Try markdown code block extraction
      const jsonMatch = jsonText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) { try { promptJson = JSON.parse(jsonMatch[1]); break; } catch {} }

      // Try incomplete JSON completion
      if (jsonText.startsWith('{') && !jsonText.endsWith('}')) {
        const openBraces = (jsonText.match(/\{/g) || []).length;
        const closeBraces = (jsonText.match(/\}/g) || []).length;
        const completed = jsonText + '}'.repeat(Math.max(0, openBraces - closeBraces));
        try { promptJson = JSON.parse(completed); break; } catch {}
      }

      // Try manual extraction
      const promptMatch = jsonText.match(/"prompt"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
      if (promptMatch) {
        const styleMatch = jsonText.match(/"style"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
        const lightingMatch = jsonText.match(/"lighting"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
        const compositionMatch = jsonText.match(/"composition"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
        const cameraMatch = jsonText.match(/"camera"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
        const backgroundMatch = jsonText.match(/"background"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
        promptJson = {
          prompt: promptMatch[1] || 'A professional portrait',
          style: styleMatch?.[1] || 'photorealistic',
          lighting: lightingMatch?.[1] || 'natural',
          composition: compositionMatch?.[1] || 'portrait',
          camera: cameraMatch?.[1] || 'professional',
          background: backgroundMatch?.[1] || 'neutral'
        };
        break;
      }
    }

    if (!promptJson) {
      debugInfo.fullResponse = parts[0]?.text;
      return { success: false, error: 'No valid JSON response from Vertex AI', debug: debugInfo };
    }

    const requiredKeys = ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'];
    const missingKeys = requiredKeys.filter(key => !promptJson[key]);
    if (missingKeys.length > 0) {
      return { success: false, error: `Missing required keys: ${missingKeys.join(', ')}`, debug: debugInfo };
    }

    if (String(promptJson.prompt || '').length < 50) {
      return { success: false, error: 'Prompt too short - likely truncated response', debug: debugInfo };
    }

    return { success: true, prompt: promptJson, debug: debugInfo };
  } catch (error) {
    debugInfo.responseTimeMs = Date.now() - startTime;
    return { success: false, error: error instanceof Error ? error.message : String(error), debug: debugInfo };
  }
};

export const streamImageToR2 = async (imageUrl: string, r2Key: string, env: Env, contentType?: string, skipValidation?: boolean): Promise<void> => {
  if (!skipValidation && !validateImageUrl(imageUrl, env)) throw new Error(`Invalid or unsafe image URL: ${imageUrl}`);

  const response = await fetchWithTimeout(imageUrl, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
  if (!response.body) throw new Error('Response body is null');

  const detectedContentType = contentType || response.headers.get('content-type') || 'image/jpeg';
  const R2_BUCKET = getR2Bucket(env);
  await R2_BUCKET.put(r2Key, response.body, { httpMetadata: { contentType: detectedContentType, cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL } });
};

export const callUpscaler4k = async (imageUrl: string, env: Env): Promise<FaceSwapResponse> => {
  if (!env.WAVESPEED_API_KEY) return errorResult('WAVESPEED_API_KEY is required', 500);

  const debugInfo: Record<string, any> = { endpoint: API_ENDPOINTS.WAVESPEED_UPSCALER, model: 'wavespeed-ai/image-upscaler', imageUrl };

  try {
    const requestBody = { enable_base64_output: false, enable_sync_mode: false, image: imageUrl, output_format: DEFAULT_VALUES.UPSCALER_OUTPUT_FORMAT, target_resolution: DEFAULT_VALUES.UPSCALER_TARGET_RESOLUTION };

    if (env.DISABLE_4K_UPSCALER === 'true') {
      const mockKey = `results/${generateMockId()}.${DEFAULT_VALUES.UPSCALER_EXT}`;
      return successResult(`r2://${mockKey}`, '4K upscaler disabled (performance testing)', 200, { disabled: true });
    }

    const startTime = Date.now();
    const response = await fetchWithTimeout(API_ENDPOINTS.WAVESPEED_UPSCALER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.WAVESPEED_API_KEY}` },
      body: JSON.stringify(requestBody),
    }, TIMEOUT_CONFIG.DEFAULT_REQUEST);

    const rawResponse = await response.text();
    debugInfo.durationMs = Date.now() - startTime;
    debugInfo.status = response.status;

    if (!response.ok) {
      debugInfo.rawResponse = rawResponse.substring(0, 2000);
      return { Success: false, Message: `WaveSpeed API error: ${response.status}`, StatusCode: response.status, Error: rawResponse, Debug: debugInfo };
    }

    const data = JSON.parse(rawResponse);
    const requestId = data.id || data.requestId || data.request_id || data.data?.id;
    if (!requestId) return errorResult('WaveSpeed API did not return a request ID', 500, debugInfo);

    const resultEndpoint = API_ENDPOINTS.WAVESPEED_RESULT(requestId);
    let resultImageUrl: string | null = null;

    const extractResultUrl = (d: any): string | null => {
      if (d.output && typeof d.output === 'string') return d.output;
      if (d.output?.url) return d.output.url;
      if (d.data?.output && typeof d.data.output === 'string') return d.data.output;
      if (d.data?.output?.url) return d.data.output.url;
      if (d.url) return d.url;
      if (d.data?.url) return d.data.url;
      const outputs = d.data?.outputs || d.outputs;
      if (Array.isArray(outputs) && outputs.length > 0) {
        const o = outputs[0];
        return typeof o === 'string' ? o : o?.url || null;
      }
      return null;
    };

    for (let attempt = 0; attempt < TIMEOUT_CONFIG.POLLING.MAX_ATTEMPTS; attempt++) {
      const delay = attempt === 0 ? TIMEOUT_CONFIG.POLLING.FIRST_DELAY : attempt <= 2 ? TIMEOUT_CONFIG.POLLING.SECOND_THIRD_DELAY : TIMEOUT_CONFIG.POLLING.SUBSEQUENT_DELAY;
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, delay));

      const resultResponse = await fetchWithTimeout(resultEndpoint, { headers: { 'Authorization': `Bearer ${env.WAVESPEED_API_KEY}` } }, TIMEOUT_CONFIG.DEFAULT_REQUEST);
      if (!resultResponse.ok) { if (attempt === TIMEOUT_CONFIG.POLLING.MAX_ATTEMPTS - 1) throw new Error(`Failed to get result: ${resultResponse.status}`); continue; }

      const resultData = await resultResponse.json() as any;
      const pollStatus = resultData.status || resultData.data?.status;

      if (['completed', 'succeeded', 'success'].includes(pollStatus)) { resultImageUrl = extractResultUrl(resultData); if (resultImageUrl) break; }
      else if (['failed', 'error'].includes(pollStatus)) throw new Error(`Upscaling failed: ${resultData.error || resultData.message || 'Unknown error'}`);
      else if (!['processing', 'pending', 'starting'].includes(pollStatus)) { resultImageUrl = extractResultUrl(resultData); if (resultImageUrl) break; }
    }

    if (!resultImageUrl) throw new Error(`Upscaling timed out after ${TIMEOUT_CONFIG.POLLING.MAX_ATTEMPTS} polling attempts`);

    const ext = DEFAULT_VALUES.UPSCALER_EXT;
    const resultKey = `results/${nanoid(16)}.${ext}`;
    let contentType = DEFAULT_VALUES.UPSCALER_MIME_TYPE;

    if (resultImageUrl.startsWith('data:')) {
      const base64Match = resultImageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (base64Match) {
        contentType = base64Match[1] || DEFAULT_VALUES.UPSCALER_MIME_TYPE;
        const R2_BUCKET = getR2Bucket(env);
        await R2_BUCKET.put(resultKey, base64ToUint8Array(base64Match[2]), { httpMetadata: { contentType, cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL } });
      } else throw new Error('Invalid base64 data URL format');
    } else {
      await streamImageToR2(resultImageUrl, resultKey, env, DEFAULT_VALUES.UPSCALER_MIME_TYPE, true);
    }

    debugInfo.r2Key = resultKey;
    return successResult(`r2://${resultKey}`, 'Upscaler4K image upscaling completed', response.status, debugInfo);
  } catch (error) {
    debugInfo.error = error instanceof Error ? error.message : String(error);
    return errorResult(`Upscaler4K request failed: ${error instanceof Error ? error.message : String(error)}`, 500, debugInfo);
  }
};
