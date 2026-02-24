# External Integrations

**Analysis Date:** 2026-02-24

## APIs & External Services

**Image Processing - Face Swap:**
- RapidAPI Face Swap - Primary face swap service
  - SDK/Client: HTTP fetch with RapidAPI headers
  - Auth: `RAPIDAPI_KEY`, `RAPIDAPI_HOST`, `RAPIDAPI_ENDPOINT` environment variables
  - Implementation: `backend-cloudflare-workers/services.ts` → `callFaceSwap()` function
  - Endpoint: Form-encoded multipart request with target_url and source_url
  - Response format: JSON with `file_url`, `message`, `processing_time`

**AI Image Generation - Primary Provider:**
- Google Cloud Vertex AI (Gemini models)
  - SDK/Client: Direct HTTP API calls (no official SDK)
  - Auth: Google Service Account via OAuth2 (service account email and private key)
  - Models:
    - `gemini-2.5-flash-image` - Image generation (default)
    - `gemini-3-flash-preview` - Prompt generation
    - `gemini-2.0-flash-lite` - Safety checks
    - `gemini-3-pro-image-preview` - Alternative model
  - Implementation: `backend-cloudflare-workers/services.ts` → `generateVertexPrompt()`, `callNanoBanana()`
  - Endpoints: Regional (`{location}-aiplatform.googleapis.com`) or global (`aiplatform.googleapis.com`)
  - Supported locations: `us-central1`, `us-east1`, `us-west1`, `europe-west1`, `asia-southeast1`, `global`
  - Auth requirements: `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_VERTEX_PROJECT_ID`
  - Configuration: `backend-cloudflare-workers/config.ts` → `VERTEX_AI_CONFIG`

**AI Image Generation - Fallback/Alternative Provider:**
- WaveSpeed AI API
  - SDK/Client: HTTP API
  - Auth: Bearer token in `Authorization` header (`WAVESPEED_API_KEY`)
  - Endpoints:
    - Image upscaler: `https://api.wavespeed.ai/api/v1/wavespeed-ai/image-upscaler`
    - Text-to-image (Flux 2): `https://api.wavespeed.ai/api/v1/wavespeed-ai/flux-2-dev/text-to-image`
    - Gemini 2.5 Flash Image edit: `https://api.wavespeed.ai/api/v3/google/gemini-2.5-flash-image/edit`
    - SeeAI SeedDream edit: `https://api.wavespeed.ai/api/v3/bytedance/seedream-v4/edit-sequential`
  - Implementation: `backend-cloudflare-workers/services.ts` → `callUpscaler4k()`, `callWaveSpeedTextToImage()`, etc.
  - Request polling supported with configurable retry delays
  - Response format: JSON with `requestId` for async operations

**Content Safety & Image Analysis:**
- Google Cloud Vision API
  - SDK/Client: HTTP API with API key authentication
  - Auth: `GOOGLE_VISION_API_KEY` environment variable
  - Endpoint: `https://vision.googleapis.com/v1/images:annotate?key={apiKey}`
  - Implementation: `backend-cloudflare-workers/services.ts` → `checkSafeSearch()`
  - Features: Safe search annotation (adult, violence, racy, medical, spoof detection)
  - Response: `SafeSearchAnnotation` with likelihood ratings

## Data Storage

**Databases:**
- Cloudflare D1 (SQLite)
  - Connection: Cloudflare binding configured via `D1_DATABASE_BINDING` environment variable
  - ORM/Client: Direct SQL queries (no ORM)
  - Schema: `backend-cloudflare-workers/schema.sql`
  - Tables:
    - `profiles` - User profiles (id, device_id, user_id, name, email, avatar_url, preferences)
    - `presets` - Preset images metadata (id, ext, thumbnail_r2 JSON array)
    - `selfies` - User uploaded selfies (id, profile_id, action, filename, dimensions)
    - `results` - Generated result images (id, profile_id, action)
  - Indexes: Created on device_id, user_id, created_at, action, profile_id, and composite keys
  - Migrations: SQL migration files in `backend-cloudflare-workers/migrations/` directory

**File Storage:**
- Cloudflare R2 (Object Storage)
  - Binding: `R2_BUCKET_BINDING` or `R2_BUCKET_NAME` environment variable (configurable)
  - Client: Cloudflare Workers R2 API
  - Path structure:
    - `preset/{preset_id}/{preset_id}.{ext}` - Preset images
    - `preset_thumb/{preset_id}_{format}_{resolution}.{ext}` - Thumbnail variants (webp, lottie, avif at various resolutions)
    - `selfie/{profile_id}/{selfie_id}.{ext}` - User selfies
    - `results/{profile_id}/{result_id}.{ext}` - Generated results
    - `remove_bg/background/` - Background images for compositing
  - Storage metadata: Prompt JSON stored in R2 object metadata
  - Cache control: `public, max-age=31536000, immutable` for permanent assets

**Caching:**
- Cloudflare KV (Key-Value Store)
  - Dynamic namespaces with configurable bindings
  - Token cache: OAuth tokens cached with 55-minute TTL (tokens valid 1 hour)
  - Prompt cache: Generated prompts cached with 1-year TTL
  - Cache key structure: Profile-based and request-based keys

## Authentication & Identity

**Auth Provider:**
- Google Cloud Service Account (OAuth2)
  - Implementation: Custom JWT token generation for service account authentication
  - Scope: `https://www.googleapis.com/auth/cloud-platform` (for Vertex AI)
  - Token endpoint: `https://oauth2.googleapis.com/token`
  - Implementation: `backend-cloudflare-workers/services.ts` → `getAccessToken()`
  - Token caching: 55-minute TTL with 5-minute buffer before expiry

**Firebase Cloud Messaging (FCM) Authentication:**
- Google OAuth2 for FCM
  - Scope: `https://www.googleapis.com/auth/firebase.messaging`
  - Token endpoint: `https://oauth2.googleapis.com/token`
  - Implementation: `backend-cloudflare-workers/services.ts` → `sendFcmSilentPush()`, `sendResultNotification()`
  - Token cache: 55-minute TTL

**API Authentication:**
- Custom API key authentication (internal use)
  - Generation script: `backend-cloudflare-workers/generate-api-key.js`
  - Storage: Environment configuration

## Monitoring & Observability

**Error Tracking:**
- No external error tracking service detected
- Local error handling with debug info returned in API responses

**Logs:**
- Console logging within Workers
- No external logging service detected
- Debug information embedded in API response objects (sanitized for sensitive data)

**Debugging:**
- Enhanced debug mode with curl commands logged to responses (for development)
- Request/response payload logging in error conditions
- Performance timing metadata in debug objects

## CI/CD & Deployment

**Hosting:**
- Cloudflare Workers - Backend API (serverless)
- Cloudflare Pages - Frontend static hosting

**Deployment Tool:**
- Custom Node.js deployment script: `_deploy-cli-cloudflare-gcp/deploy.js`
- Wrangler CLI integration for Worker deployment
- Environment-based multi-deployment support (ai-office, ai-office-dev, ai-office-prod)

**Database Migration:**
- Manual via npm script: `npm run db:migrate`
- Wrangler D1 migration support
- Schema version control via SQL files in migrations directory

## Environment Configuration

**Required Environment Variables:**

*Cloudflare:*
- `CLOUDFLARE_API_TOKEN` - API authentication
- `CLOUDFLARE_ACCOUNT_ID` - Account identifier
- `R2_BUCKET_BINDING` or `R2_BUCKET_NAME` - R2 bucket binding name
- `D1_DATABASE_BINDING` - D1 database binding name

*RapidAPI Face Swap:*
- `RAPIDAPI_KEY` - API authentication key
- `RAPIDAPI_HOST` - API host header value
- `RAPIDAPI_ENDPOINT` - API endpoint URL

*Google Cloud (Vertex AI):*
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` - Service account email
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` - Service account private key (PEM format)
- `GOOGLE_VERTEX_PROJECT_ID` - GCP project ID

*Google Cloud (Vision API):*
- `GOOGLE_VISION_API_KEY` - API key for Vision API
- `GOOGLE_VISION_ENDPOINT` - Vision API endpoint base URL

*WaveSpeed AI:*
- `WAVESPEED_API_KEY` - Bearer token for API authentication

*Firebase Cloud Messaging:*
- `FCM_PROJECT_ID` - Firebase project ID
- `FCM_VAPID_KEY` - VAPID key for push notifications (optional, from Firebase config)
- Service account credentials for FCM OAuth2

*Deployment:*
- `DEPLOY_ENV` - Target environment (ai-office, ai-office-dev, ai-office-prod)
- `IMAGE_PROVIDER` - Image generation provider override (vertex, wavespeed, wavespeed_gemini_2_5_flash_image)
- `SKIP_POST_DEPLOY_TESTS` - Skip post-deployment testing

**Secrets Location:**
- Cloudflare Workers environment variables/secrets UI
- Deployment secrets configuration file (referenced by deploy.js)
- Environment-specific secret management per deployment environment

## Webhooks & Callbacks

**Incoming:**
- None detected

**Outgoing:**
- Firebase Cloud Messaging (FCM) push notifications
  - Endpoint: `https://fcm.googleapis.com/v1/projects/{projectId}/messages:send` (HTTP v1 API)
  - Implementation: `backend-cloudflare-workers/services.ts` → `sendFcmSilentPush()`, `sendResultNotification()`
  - Sends result notifications to device tokens stored in D1
  - Supports silent push (background data delivery)
  - Token validation and removal of invalid/unregistered tokens

## Rate Limiting

**Cloudflare Built-in:**
- RATE_LIMITER binding available in environment
- Configuration: Limit function with key-based throttling
- Implementation optional (not currently enforced in codebase)

## Request Timeout Configuration

**Service-Specific Timeouts:**
- Default request: 25 seconds (Cloudflare Workers 30s hard limit)
- OAuth token acquisition: 10 seconds
- Image fetch from R2/CDN: 15 seconds
- Vertex AI operations: 60 seconds
- WaveSpeed polling: Configurable with exponential backoff
  - First delay: 8 seconds
  - Subsequent delays: 2-4 seconds
  - Max polling attempts: 20

---

*Integration audit: 2026-02-24*
