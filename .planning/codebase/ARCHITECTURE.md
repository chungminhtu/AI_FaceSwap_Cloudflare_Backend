# Architecture

**Analysis Date:** 2026-02-24

## Pattern Overview

**Overall:** Serverless API-driven monolith with layered service architecture

**Key Characteristics:**
- Single TypeScript-based Cloudflare Worker handling all API endpoints
- Stateless request-response pattern with database and object storage as persistence layers
- Multi-provider face swap engine (RapidAPI, Vertex AI, WaveSpeed) with configurable fallback
- Event-driven processing for async operations (thumbnails, caching, cleanup)
- Request-level rate limiting and API key validation before processing

## Layers

**HTTP Request Handler:**
- Purpose: Route incoming requests and validate authentication/rate limits
- Location: `backend-cloudflare-workers/index.ts` (fetch export, lines 878-6850)
- Contains: Route matching (path-based dispatch), CORS handling, request size validation, API key checks
- Depends on: Cloudflare Workers runtime, Env bindings (D1, R2, KV, Rate Limiter)
- Used by: All HTTP clients (web, mobile)

**Services Layer:**
- Purpose: Encapsulate third-party API calls and complex business logic
- Location: `backend-cloudflare-workers/services.ts` (3,124 lines)
- Contains: Face swap engines (callFaceSwap, callNanoBanana, callWaveSpeedFaceSwap), image enhancement (callUpscaler4k, checkImageSafetyWithFlashLite), generation (generateVertexPrompt, generateBackgroundFromPrompt), FCM push notifications
- Depends on: Vertex AI API, RapidAPI, WaveSpeed API, Google Vision API, Firebase Cloud Messaging
- Used by: Route handlers in index.ts

**Database Layer:**
- Purpose: Persist profiles, presets, selfies, results metadata
- Location: `backend-cloudflare-workers/schema.sql`
- Tables: profiles (user identity), presets (preset templates), selfies (user photos), results (processed outputs), device_tokens (FCM push)
- Access: D1 Database binding in Cloudflare Worker
- Query pattern: Prepared statements with bindings for SQL injection prevention

**Storage Layer:**
- Purpose: Store image files, thumbnails, generated outputs
- Location: R2 bucket (Cloudflare storage)
- Path structure:
  - `preset/{preset_id}.{ext}` - Preset images
  - `preset_thumb/{preset_id}/{format}_{resolution}.{ext}` - Thumbnails (e.g., webp_1x, lottie_2x, avif_3x)
  - `selfie/{selfie_id}.{ext}` - User selfies
  - `result/{result_id}.{ext}` - Processing results
  - `remove_bg/{filename}` - Background removal images
- URL patterns: Direct R2 domain or `/r2/{bucket}/{path}` proxy routes
- Metadata storage: R2 object metadata for prompt_json, safety checks, processing timestamps

**Caching Layer:**
- Purpose: Reduce latency and API calls for repeated queries
- Location: KV Namespace (Cloudflare Workers KV)
- Key patterns:
  - `prompt:{preset_id}` - Cached Vertex AI prompt analysis
  - `r2head:{r2_key}` - Cached R2 object head (metadata) checks
  - `result:{result_id}` - Cached processing results
- TTL: Configurable per endpoint, default 24-48 hours

**Utility & Helper Layer:**
- Purpose: Common functions for validation, image processing, encoding
- Location: `backend-cloudflare-workers/utils.ts` (1,460 lines)
- Functions: validateImageUrl, fetchWithTimeout, getImageDimensions, resolveAspectRatio, getCorsHeaders, normalizePresetId, promisePoolWithConcurrency, base64Encode, isUnsafe (safety check), getVertexAILocation, getAccessToken
- Depends on: Photon WASM image library for fast image operations
- Used by: All layers

**Validation Layer:**
- Purpose: Input validation and environment configuration checks
- Location: `backend-cloudflare-workers/validators.ts` (42 lines)
- Functions: validateEnv, validateRequest
- Used by: Request handlers before processing

**Configuration Layer:**
- Purpose: Centralize API endpoints, prompts, model configs, timeouts
- Location: `backend-cloudflare-workers/config.ts` (377 lines)
- Contains: VERTEX_AI_PROMPTS (face preservation, content safety), IMAGE_PROCESSING_PROMPTS, WAVESPEED_PROMPTS, ASPECT_RATIO_CONFIG, CACHE_CONFIG, TIMEOUT_CONFIG, API_ENDPOINTS, VERTEX_AI_CONFIG
- Used by: Services and handlers

## Data Flow

**Image Upload & Storage:**

1. Client calls POST `/upload-url` with file(s) or URL(s)
2. Handler validates request size, API key, profile existence
3. File(s) downloaded/received into memory
4. Stored to R2 bucket with unique ID and extension preserved
5. Database record created (presets table for templates, selfies table for user photos)
6. Response returns R2 URL and internal ID
7. Optional: If enableVertexPrompt=true, async prompt generation triggered

**Face Swap Processing:**

1. Client calls POST `/faceswap` with preset_id and selfie_id(s)
2. Fetch preset and selfie images from R2 or database
3. Determine provider (Vertex AI, WaveSpeed, RapidAPI) from env.IMAGE_PROVIDER
4. Call appropriate service function with retry logic (15 retries for Vertex, exponential backoff)
5. Service calls external API with images as base64 or URLs
6. Result image received and stored to R2 in `result/` path
7. Database record created in results table with action="faceswap"
8. KV cache entry set for quick retrieval
9. Response returns result image URL and metadata

**Async Thumbnail Generation:**

1. After preset upload with multiple formats requested
2. POST `/process-thumbnail-file` or `/process-thumbnail-zip`
3. Load preset image, generate thumbnails for each format (webp, avif, lottie)
4. Store to R2 at `preset_thumb/{preset_id}/{format}_{resolution}.{ext}`
5. Update presets table thumbnail_r2 JSON array with all URLs
6. KV cache invalidated for preset thumbnails

**Image Enhancement (Upscaler, Beauty, Enhance):**

1. Client calls POST `/upscaler4k`, `/beauty`, `/enhance`
2. Load selfie/result image from URL or ID
3. Call Vertex AI or WaveSpeed with specialized prompts
4. Store result to R2
5. Create result record with action type
6. Return result URL

**Safety Check & Content Filter:**

1. Image loaded for face swap or enhancement
2. Call checkImageSafetyWithFlashLite or checkSafeSearch
3. Check Vertex AI safetyRatings or Google Vision API
4. If blocked (POSSIBLE/LIKELY/VERY_LIKELY severity), reject with error code 1001-1005
5. Proceed only if isSafe=true

**State Management:**

- **Transient:** Request parameters, temporary image buffers, computation results (in-memory only)
- **Persistent:** User profiles, uploaded images, processing results (D1 + R2)
- **Cached:** Prompt analyses, R2 head checks (KV with TTL)
- **Config:** Environment variables from deployment config (Cloudflare environment)

## Key Abstractions

**FaceSwapResponse:**
- Purpose: Standardized response format for all image processing endpoints
- Examples: `backend-cloudflare-workers/types.ts` (line 36-62)
- Pattern: { Success, Message, StatusCode, ResultImageUrl, ProcessingTime, Error?, Debug?, SafetyCheck?, VertexResponse? }
- Used by: All service functions and handlers

**Env Interface:**
- Purpose: Typed access to Cloudflare bindings and environment variables
- Examples: `backend-cloudflare-workers/types.ts` (line 3-8)
- Pattern: Dynamic key access for KV namespaces, database, R2 bucket, plus typed optional properties (RATE_LIMITER, etc.)
- Used by: All handlers and services

**Request Type Interfaces:**
- Purpose: Validate and type-check incoming request bodies
- Examples: `backend-cloudflare-workers/types.ts` (FaceSwapRequest, BackgroundRequest, UploadUrlRequest)
- Pattern: Profile ID required, flexible image sources (ID or URL), optional parameters for model/provider/prompt
- Used by: Request handlers for type safety and validation

**SafeSearchResult:**
- Purpose: Standardized safety check response
- Examples: `backend-cloudflare-workers/types.ts` (line 65-80)
- Pattern: { isSafe, statusCode, violationCategory, violationLevel, details }
- Used by: Safety validation before processing

## Entry Points

**HTTP Server:**
- Location: `backend-cloudflare-workers/index.ts` export default.fetch (line 878)
- Triggers: Any HTTP request to Cloudflare Worker
- Responsibilities: Route dispatch, CORS headers, rate limiting, authentication, request delegation to handlers

**Scheduled Events:**
- Location: `backend-cloudflare-workers/index.ts` export default.scheduled (line 6868)
- Triggers: Cron schedule from wrangler.toml
- Responsibilities: Cleanup old selfies based on retention policy, cache invalidation

## Error Handling

**Strategy:** Layered error capture with context preservation and debug logging

**Patterns:**

1. **Input Validation Errors** (400):
   - Missing required fields, invalid data types
   - Logged in request handler, returns error response with validation details

2. **Authentication Errors** (401):
   - Missing/invalid API key for protected endpoints
   - Returns 401 with 'Unauthorized' message
   - Checked in checkApiKey() before route handler

3. **Rate Limit Errors** (429):
   - Request from IP/Ray exceeds limit
   - Returns 429 with 'Rate limit exceeded' message
   - Checked by checkRateLimit() before route handler

4. **Not Found Errors** (404):
   - Preset, selfie, or profile not in database
   - Returns 404 with resource-specific message
   - Caught in route handler query

5. **Retry-able Errors** (5xx with exponential backoff):
   - External API failures (Vertex AI, RapidAPI, WaveSpeed)
   - generateVertexPromptWithRetry() retries up to 15 times with exponential backoff
   - Distinguishes retryable (network, timeout, 5xx) from permanent errors (4xx except 429)

6. **Critical Errors**:
   - logCriticalError() captures endpoint, error stack, request context, user agent, IP
   - Logged to console with sanitized object inspection
   - Debug mode includes full debug information in response

## Cross-Cutting Concerns

**Logging:**

- Console.log() for all major operations (upload start, processing status, retries)
- Console.error() for failures and warnings
- logCriticalError() for unhandled exceptions with context
- Sanitized output via sanitizeObject() to prevent credential leaks

**Validation:**

- validateImageUrl(): Whitelist check against env.ALLOWED_IMAGE_DOMAINS
- validateEnv(): Ensure required env vars present for selected mode (rapidapi, vertex, wavespeed)
- validateRequest(): Check required fields in request body
- constantTimeCompare(): Safe string comparison for API keys to prevent timing attacks

**Authentication:**

- API key from X-API-Key header or Authorization Bearer token
- constantTimeCompare() prevents timing-based attacks
- PROTECTED_MOBILE_APIS list defines which endpoints require authentication
- checkProtectedPath() logic differentiates auth requirements by method (POST vs GET)

**CORS:**

- getCorsHeaders() normalizes and validates Origin header
- Allows mobile apps (okhttp, Android User-Agent, no Origin header) with `*`
- Matches browser requests against env.ALLOWED_ORIGINS whitelist
- Includes credentials: true for cross-origin cookie support

**Performance Optimization:**

- promisePoolWithConcurrency() limits concurrent operations (multipart uploads, thumbnail generation)
- Exponential backoff with jitter for retries (2s initial, up to 30s max)
- KV caching for prompt analyses and R2 metadata checks
- Batch operations: /process-thumbnail-zip accepts ZIP archive for bulk thumbnail generation
