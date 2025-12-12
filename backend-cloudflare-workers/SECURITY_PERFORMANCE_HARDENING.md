# Security and Performance Hardening Documentation

## Overview

This document describes all security fixes and performance optimizations implemented in the Cloudflare Workers backend. These changes improve security posture, prevent common vulnerabilities, and optimize resource usage.

## Table of Contents

1. [Security Fixes](#security-fixes)
   - [CORS Configuration](#1-cors-configuration)
   - [SSRF Protection](#2-ssrf-protection)
   - [Rate Limiting](#3-rate-limiting)
   - [Request Size Limits](#4-request-size-limits)
   - [SQL Injection Hardening](#5-sql-injection-hardening)
   - [Token Cache Bounds](#6-token-cache-bounds)
   - [Debug Info Sanitization](#7-debug-info-sanitization)
2. [Performance Optimizations](#performance-optimizations)
   - [Parallel Image Fetches](#8-parallel-image-fetches)
   - [Stream Large Images](#9-stream-large-images)
   - [Enforce Pagination Limits](#10-enforce-pagination-limits)
   - [Cache Preset Prompts](#11-cache-preset-prompts)
   - [Request Timeouts](#12-request-timeouts)
3. [Configuration](#configuration)
4. [Centralized Config System](#centralized-config-system)
5. [Migration Guide](#migration-guide)
6. [Testing](#testing)
7. [Troubleshooting](#troubleshooting)

---

## Security Fixes

### 1. CORS Configuration

**Problem:** Wildcard CORS (`*`) allows any origin to access the API, which is insecure for production.

**Solution:** Origin validation with whitelist support.

**Implementation:**
- Added `getCorsHeaders(request, env)` function
- Validates origin against `ALLOWED_ORIGINS` environment variable
- Automatically allows mobile apps (no Origin header)
- Falls back to wildcard if `ALLOWED_ORIGINS` not set

**Files Changed:**
- `backend-cloudflare-workers/utils.ts` - `getCorsHeaders()` function
- `backend-cloudflare-workers/index.ts` - Uses `getCorsHeaders()` for all responses
- `backend-cloudflare-workers/types.ts` - Added `ALLOWED_ORIGINS` to Env interface

**Configuration:**
```toml
# wrangler.toml
[vars]
ALLOWED_ORIGINS = "https://app.shotpix.app,https://www.shotpix.app"
```

**For Development:**
```toml
ALLOWED_ORIGINS = "*"
```

**For Multiple Environments:**
```toml
ALLOWED_ORIGINS = "https://app.shotpix.app,http://localhost:3000,http://localhost:5173"
```

**Mobile Apps:**
- Android/iOS apps automatically allowed (no configuration needed)
- Detected by missing `Origin` header or mobile User-Agent

**Testing:**
```javascript
// Browser console
fetch('https://api.d.shotpix.app/presets', {
  headers: { 'Origin': 'https://yourdomain.com' }
})
.then(r => console.log('CORS:', r.headers.get('Access-Control-Allow-Origin')));
```

**Affected Endpoints:** All endpoints (20+ endpoints)

---

### 2. SSRF Protection

**Problem:** Image URL fetching could be exploited to access internal services (SSRF attack).

**Solution:** URL validation with domain whitelist and private IP blocking.

**Implementation:**
- Added `validateImageUrl(url, env)` function
- Blocks private IP ranges: `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `127.x.x.x`
- Blocks `localhost` and `::1`
- Requires HTTPS protocol
- Whitelists R2 domains and `R2_DOMAIN`
- Applied to all image fetching operations

**Files Changed:**
- `backend-cloudflare-workers/utils.ts` - `validateImageUrl()` function
- `backend-cloudflare-workers/services.ts` - `fetchImageAsBase64()` validates URLs
- `backend-cloudflare-workers/index.ts` - Validates image URLs in `/upload-url` endpoint

**Code Example:**
```typescript
// Before (vulnerable)
const imageData = await fetchImageAsBase64(imageUrl);

// After (protected)
const imageData = await fetchImageAsBase64(imageUrl, env); // Validates URL internally
```

**Allowed Domains:**
- R2 public URLs (`.r2.cloudflarestorage.com`, `.r2.dev`)
- `R2_DOMAIN` environment variable value
- HTTPS protocol required

**Blocked:**
- Private IP addresses
- Localhost
- HTTP protocol (only HTTPS allowed)
- Unknown domains

**Affected Endpoints:**
- `/upload-url` - Validates `image_urls` parameter
- `/faceswap` - Validates `selfie_image_urls` and `preset_image_url`
- `/removeBackground` - Validates image URLs
- `/enhance`, `/colorize`, `/aging` - Validates image URLs

**Testing:**
```bash
# Should fail (private IP)
curl -X POST https://api.d.shotpix.app/upload-url \
  -d '{"image_urls": ["http://192.168.1.1/image.jpg"]}'

# Should fail (HTTP)
curl -X POST https://api.d.shotpix.app/upload-url \
  -d '{"image_urls": ["http://example.com/image.jpg"]}'

# Should succeed (HTTPS + allowed domain)
curl -X POST https://api.d.shotpix.app/upload-url \
  -d '{"image_urls": ["https://resources.d.shotpix.app/preset/image.jpg"]}'
```

---

### 3. Rate Limiting

**Problem:** No protection against API abuse or DDoS attacks.

**Solution:** KV-based rate limiting (100 requests/minute per IP per endpoint).

**Implementation:**
- Uses Workers KV binding `RATE_LIMIT_KV`
- Key format: `rate_limit:${ip}:${path}`
- Sliding window: 60 seconds
- Limit: 100 requests per window
- Returns 429 status with `Retry-After` header

**Files Changed:**
- `backend-cloudflare-workers/index.ts` - `checkRateLimit()` function
- `backend-cloudflare-workers/types.ts` - Added `RATE_LIMIT_KV` to Env interface

**Configuration:**
```toml
# wrangler.toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "your-kv-namespace-id"
```

**Rate Limit Details:**
- **Limit:** 100 requests per minute
- **Window:** 60 seconds (sliding)
- **Scope:** Per IP address + per endpoint path
- **Response:** 429 Too Many Requests
- **Header:** `Retry-After: <seconds>`

**Example Response:**
```json
{
  "data": null,
  "status": "error",
  "message": "Rate limit exceeded",
  "code": 429
}
```

**Headers:**
```
Retry-After: 45
Access-Control-Allow-Origin: *
```

**Affected Endpoints:** All endpoints (20+ endpoints)

**Testing:**
```bash
# Make 101 requests quickly
for i in {1..101}; do
  curl https://api.d.shotpix.app/presets
done
# 101st request should return 429
```

**Bypass:** Rate limiting is disabled if `RATE_LIMIT_KV` binding is not configured (graceful degradation).

---

### 4. Request Size Limits

**Problem:** No protection against large request body attacks.

**Solution:** Content-Length validation before processing.

**Implementation:**
- Checks `Content-Length` header before parsing body
- 10MB limit for upload endpoints (`/upload-url`, `/upload-thumbnails`)
- 1MB limit for JSON endpoints (all other POST/PUT)
- Returns 413 Payload Too Large

**Files Changed:**
- `backend-cloudflare-workers/index.ts` - `checkRequestSize()` function

**Limits:**
- **Upload endpoints:** 10MB (`/upload-url`, `/upload-thumbnails`)
- **JSON endpoints:** 1MB (all other POST/PUT endpoints)

**Example Response:**
```json
{
  "data": null,
  "status": "error",
  "message": "Request body too large. Maximum size: 10MB",
  "code": 413
}
```

**Affected Endpoints:**
- `/upload-url` POST - 10MB limit
- `/upload-thumbnails` POST - 10MB limit
- `/faceswap` POST - 1MB limit
- `/removeBackground` POST - 1MB limit
- `/upscaler4k` POST - 1MB limit
- `/enhance` POST - 1MB limit
- `/colorize` POST - 1MB limit
- `/aging` POST - 1MB limit
- `/profiles` POST/PUT - 1MB limit

**Testing:**
```bash
# Should fail (too large)
curl -X POST https://api.d.shotpix.app/faceswap \
  -H "Content-Type: application/json" \
  -H "Content-Length: 1048577" \
  -d '{"profile_id":"test"}'
```

---

### 5. SQL Injection Hardening

**Problem:** Dynamic IN clauses could be exploited with large arrays.

**Solution:** Maximum array length validation (100 items).

**Implementation:**
- Validates array length before building SQL IN clause
- Truncates to 100 items if exceeded
- Applied to all deletion operations with IN clauses

**Files Changed:**
- `backend-cloudflare-workers/index.ts` - `saveResultToDatabase()` function
- `backend-cloudflare-workers/index.ts` - Selfie retention logic (lines 730, 754)

**Code Example:**
```typescript
// Before (vulnerable to large arrays)
const placeholders = idsToDelete.map(() => '?').join(',');
await DB.prepare(`DELETE FROM results WHERE id IN (${placeholders})`).bind(...idsToDelete).run();

// After (protected)
if (idsToDelete.length > 100) {
  idsToDelete = idsToDelete.slice(0, 100);
}
const placeholders = idsToDelete.map(() => '?').join(',');
await DB.prepare(`DELETE FROM results WHERE id IN (${placeholders})`).bind(...idsToDelete).run();
```

**Limits:**
- **Maximum array size:** 100 items
- **Behavior:** Truncates to first 100 items if exceeded

**Affected Operations:**
- Result history cleanup (`saveResultToDatabase`)
- Selfie retention policy enforcement (faceswap and other actions)

**Note:** Prepared statements were already used correctly; this adds bounds checking.

---

### 6. Token Cache Bounds

**Problem:** In-memory token cache could grow unbounded.

**Solution:** LRU cache with maximum 50 entries and automatic cleanup.

**Implementation:**
- Replaced `Map` with `LRUCache` class
- Maximum size: 50 entries
- Automatic expiration cleanup
- Last-accessed tracking for LRU eviction

**Files Changed:**
- `backend-cloudflare-workers/utils.ts` - `LRUCache` class and `getAccessToken()` function

**Cache Details:**
- **Max size:** 50 entries
- **TTL:** 55 minutes (tokens valid for 1 hour)
- **Eviction:** LRU (Least Recently Used)
- **Cleanup:** Automatic on cache miss

**Code Example:**
```typescript
// Before (unbounded Map)
const tokenCache = new Map<string, TokenCacheEntry>();

// After (bounded LRU)
const tokenCache = new LRUCache<string, TokenCacheEntry>(50);
```

**Affected:** All Vertex AI calls (faceswap, removeBackground, enhance, colorize, aging, prompt generation)

**Memory Impact:** Reduced from potentially unlimited to maximum 50 entries (~5KB memory).

---

### 7. Debug Info Sanitization

**Problem:** Debug responses could leak sensitive data (API keys, tokens).

**Solution:** Enhanced sanitization to redact sensitive fields.

**Implementation:**
- Enhanced `sanitizeObject()` function
- Detects sensitive keys: `key`, `token`, `password`, `secret`, `api_key`, `authorization`, `private_key`, etc.
- Redacts values with `***REDACTED***`
- Truncates large base64 data fields

**Files Changed:**
- `backend-cloudflare-workers/services.ts` - `sanitizeObject()` function

**Sensitive Keys Detected:**
- `key`, `token`, `password`, `secret`
- `api_key`, `apikey`, `authorization`
- `private_key`, `privatekey`
- `access_token`, `accesstoken`
- `bearer`, `credential`, `credentials`

**Code Example:**
```typescript
// Before (could leak secrets)
debug: {
  api_key: "sk-1234567890abcdef",
  authorization: "Bearer token123"
}

// After (redacted)
debug: {
  api_key: "***REDACTED***",
  authorization: "***REDACTED***"
}
```

**Affected Endpoints:**
- All endpoints that return debug info (faceswap, removeBackground, upscaler4k, enhance, colorize, aging)

**Testing:**
```bash
# Enable debug mode
curl -X POST https://api.d.shotpix.app/faceswap \
  -H "X-Enable-Vertex-Prompt: true" \
  -d '{"profile_id":"test","preset_image_id":"test","selfie_ids":["test"]}'

# Check response - sensitive fields should be redacted
```

---

## Performance Optimizations

### 8. Parallel Image Fetches

**Problem:** Sequential image fetching for multiple selfies was slow.

**Solution:** Parallel fetching with `Promise.all()`.

**Implementation:**
- Changed sequential `for` loop to `Promise.all()`
- Fetches all selfie images concurrently

**Files Changed:**
- `backend-cloudflare-workers/services.ts` - `callNanoBanana()` function

**Code Example:**
```typescript
// Before (sequential - slow)
for (const url of sourceUrls) {
  const imageData = await fetchImageAsBase64(url, env);
  selfieImageDataArray.push(imageData);
}

// After (parallel - fast)
const selfieImageDataArray = await Promise.all(
  sourceUrls.map(url => fetchImageAsBase64(url, env))
);
```

**Performance Impact:**
- **Before:** N × fetch_time (sequential)
- **After:** max(fetch_time) (parallel)
- **Example:** 3 selfies × 2s = 6s → max(2s) = 2s (3x faster)

**Affected:** `/faceswap` endpoint when multiple `selfie_ids` provided

---

### 9. Stream Large Images

**Problem:** Loading full images into memory before uploading to R2 was memory-intensive.

**Solution:** Stream images directly from fetch response to R2.

**Implementation:**
- Added `streamImageToR2()` function
- Streams `response.body` directly to R2
- Only converts to base64 when required by Vertex AI API
- Applied to upscaler result downloads

**Files Changed:**
- `backend-cloudflare-workers/services.ts` - `streamImageToR2()` function
- `backend-cloudflare-workers/services.ts` - `callUpscaler4k()` function
- `backend-cloudflare-workers/index.ts` - Face swap and merge result downloads

**Code Example:**
```typescript
// Before (loads into memory)
const imageResponse = await fetch(imageUrl);
const imageData = await imageResponse.arrayBuffer();
const imageBytes = new Uint8Array(imageData);
await R2_BUCKET.put(resultKey, imageBytes, {...});

// After (streams directly)
const imageResponse = await fetchWithTimeout(imageUrl, {}, 60000);
await R2_BUCKET.put(resultKey, imageResponse.body, {...});
```

**Memory Impact:**
- **Before:** Full image in memory (e.g., 10MB image = 10MB memory)
- **After:** Streaming (minimal memory usage)
- **Benefit:** Can handle larger images without memory issues

**Affected:**
- `/upscaler4k` - Result image download
- `/faceswap` - Result image download (if from external URL)
- `/removeBackground` - Result image download (if from external URL)

**Note:** Vertex AI calls still use base64 (API requirement).

---

### 10. Enforce Pagination Limits

**Problem:** No maximum limit validation on pagination could cause performance issues.

**Solution:** Maximum limit validation (50 items) with configurable limit parameter.

**Implementation:**
- Added `limit` query parameter validation
- Maximum limit: 50 items
- Default limit: 50 items
- Applied to all list endpoints

**Files Changed:**
- `backend-cloudflare-workers/index.ts` - `/presets` GET endpoint
- `backend-cloudflare-workers/index.ts` - `/results` GET endpoint
- `backend-cloudflare-workers/index.ts` - `/selfies` GET endpoint

**API Changes:**
```bash
# Before (no limit validation)
GET /presets?limit=1000  # Could return 1000 items

# After (enforced limit)
GET /presets?limit=1000  # Returns max 50 items
GET /presets?limit=25    # Returns 25 items
GET /presets             # Returns 50 items (default)
```

**Limits:**
- **Maximum:** 50 items
- **Default:** 50 items
- **Minimum:** 1 item

**Affected Endpoints:**
- `/presets` GET - Max 50 items
- `/results` GET - Max 50 items
- `/selfies` GET - Max 50 items

**Testing:**
```bash
# Should return max 50 items
curl "https://api.d.shotpix.app/presets?limit=100"

# Should return 25 items
curl "https://api.d.shotpix.app/presets?limit=25"
```

---

### 11. Cache Preset Prompts

**Problem:** Reading prompt_json from R2 metadata on every faceswap request was slow.

**Solution:** KV cache with 24-hour TTL for preset prompts.

**Implementation:**
- Uses `RATE_LIMIT_KV` binding (same as rate limiting)
- Key format: `prompt:${presetImageId}`
- TTL: 31536000 seconds (1 year)
- Falls back to R2 metadata on cache miss
- Updates cache when prompt is generated

**Files Changed:**
- `backend-cloudflare-workers/index.ts` - `/faceswap` POST handler

**Code Example:**
```typescript
// Before (reads from R2 every time)
const r2Object = await R2_BUCKET.head(r2Key);
const promptJson = r2Object?.customMetadata?.prompt_json;

// After (cached in KV)
const cacheKey = `prompt:${presetImageId}`;
const cached = await env.RATE_LIMIT_KV.get(cacheKey, 'json');
if (cached) {
  storedPromptPayload = cached;
} else {
  // Read from R2 and cache
  const r2Object = await R2_BUCKET.head(r2Key);
  // ... store in cache
}
```

**Cache Details:**
- **Key format:** `prompt:${presetImageId}`
- **TTL:** 86400 seconds (24 hours)
- **Storage:** Workers KV
- **Fallback:** R2 metadata if cache miss

**Performance Impact:**
- **Before:** R2 head request (~50-100ms) on every faceswap
- **After:** KV get request (~5-10ms) on cache hit
- **Speedup:** 5-10x faster for cached prompts

**Affected:** `/faceswap` endpoint

**Note:** Cache is optional - if `RATE_LIMIT_KV` not configured, falls back to R2 metadata.

---

### 12. Request Timeouts

**Problem:** External API calls could hang indefinitely.

**Solution:** 60-second timeout for all external fetch requests.

**Implementation:**
- Added `fetchWithTimeout()` helper function
- Uses `AbortController` for timeout
- 60-second default timeout
- Applied to all external API calls

**Files Changed:**
- `backend-cloudflare-workers/utils.ts` - `fetchWithTimeout()` function
- `backend-cloudflare-workers/services.ts` - All `fetch()` calls replaced
- `backend-cloudflare-workers/index.ts` - Image fetching calls

**Code Example:**
```typescript
// Before (no timeout)
const response = await fetch(url, options);

// After (60s timeout)
const response = await fetchWithTimeout(url, options, 60000);
```

**Timeout Details:**
- **Default:** 60 seconds
- **Error:** Throws "Request timed out after 60000ms"
- **Abort:** Uses `AbortController.signal`

**Affected External APIs:**
- Vertex AI API (`callNanoBanana`, `callNanoBananaMerge`, `generateVertexPrompt`)
- Google Vision API (`checkSafeSearch`)
- WaveSpeed API (`callUpscaler4k`)
- RapidAPI (`callFaceSwap`)
- OAuth token endpoint (`getAccessToken`)
- Image fetching (`fetchImageAsBase64`, `streamImageToR2`)

**Testing:**
```bash
# Should timeout after 60s if API is slow
curl -X POST https://api.d.shotpix.app/faceswap \
  -d '{"profile_id":"test","preset_image_id":"test","selfie_ids":["test"]}'
```

---

## Centralized Config System

**Overview:** All API prompts, model configurations, timeouts, and constants have been centralized into `config.ts` for easy management.

**File:** `backend-cloudflare-workers/config.ts`

**Benefits:**
- ✅ Single source of truth for all prompts and configs
- ✅ Easy to update without searching through code
- ✅ Type-safe configuration
- ✅ Consistent values across all endpoints

**Key Configuration Sections:**
- **API_PROMPTS**: Facial preservation, merge prompts, vertex generation prompts, gender hints
- **API_CONFIG**: Image generation and prompt generation settings (temperature, tokens, safety)
- **MODEL_CONFIG**: Model name mappings and defaults
- **ASPECT_RATIO_CONFIG**: Supported aspect ratios and default
- **TIMEOUT_CONFIG**: Request timeouts and polling settings
- **CACHE_CONFIG**: Cache size, expiry, and R2 cache control
- **DEFAULT_VALUES**: Default MIME types, extensions, resolutions

**Usage:**
All configuration values are imported and used throughout the codebase:
```typescript
import { API_PROMPTS, API_CONFIG, ASPECT_RATIO_CONFIG } from './config';
```

**Modifying Configuration:**
1. Open `backend-cloudflare-workers/config.ts`
2. Locate the relevant section
3. Modify the value
4. Save - changes apply immediately

**Documentation:** See `CONFIG_DOCUMENTATION.md` for detailed documentation.

---

## Configuration

### Environment Variables

Add these to your `wrangler.toml` or Cloudflare Dashboard:

```toml
[vars]
# CORS Configuration
ALLOWED_ORIGINS = "https://app.shotpix.app,https://www.shotpix.app"

# Rate Limiting & Caching (optional but recommended)
# Create KV namespace in Cloudflare Dashboard first
# Then add binding in wrangler.toml:
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"
```

### Required Configuration

**Minimum (for basic security):**
```toml
[vars]
ALLOWED_ORIGINS = "https://yourdomain.com"
```

**Recommended (for production):**
```toml
[vars]
ALLOWED_ORIGINS = "https://app.shotpix.app,https://www.shotpix.app"

[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "your-kv-namespace-id"
```

### Creating KV Namespace

1. Go to Cloudflare Dashboard → Workers & Pages → KV
2. Click "Create a namespace"
3. Name: `RATE_LIMIT_KV`
4. Copy the namespace ID
5. Add to `wrangler.toml` as shown above

---

## Migration Guide

### Step 1: Update Environment Variables

Add `ALLOWED_ORIGINS` to your environment:

```bash
# Via wrangler.toml
[vars]
ALLOWED_ORIGINS = "https://yourdomain.com"

# Or via Cloudflare Dashboard
# Workers & Pages → Your Worker → Settings → Variables
```

### Step 2: Create KV Namespace (Optional but Recommended)

```bash
# Create namespace
wrangler kv:namespace create "RATE_LIMIT_KV"

# Add to wrangler.toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "your-namespace-id"
```

### Step 3: Deploy

```bash
npm run deploy
# or
wrangler publish
```

### Step 4: Test

1. Test CORS from frontend (see Testing section)
2. Test rate limiting (make 101 requests)
3. Test SSRF protection (try private IP)
4. Monitor logs for any issues

### Step 5: Update Frontend (if needed)

If you were using wildcard CORS before, update your frontend to handle specific origins:

```javascript
// Frontend code - no changes needed if using credentials
fetch('https://api.d.shotpix.app/presets', {
  credentials: 'include' // Still works with specific origin
})
```

---

## Testing

### CORS Testing

**Browser Console:**
```javascript
fetch('https://api.d.shotpix.app/presets', {
  headers: { 'Origin': window.location.origin }
})
.then(r => console.log('CORS:', r.headers.get('Access-Control-Allow-Origin')));
```

**Use Test Tool:**
Open `backend-cloudflare-workers/test-cors.html` in your browser.

### Rate Limiting Testing

```bash
# Make 101 requests quickly
for i in {1..101}; do
  curl https://api.d.shotpix.app/presets
done
# 101st should return 429
```

### SSRF Protection Testing

```bash
# Should fail (private IP)
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "Content-Type: application/json" \
  -d '{"image_urls": ["http://192.168.1.1/image.jpg"], "type": "preset", "profile_id": "test"}'

# Should fail (HTTP)
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "Content-Type: application/json" \
  -d '{"image_urls": ["http://example.com/image.jpg"], "type": "preset", "profile_id": "test"}'

# Should succeed (HTTPS + allowed domain)
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "Content-Type: application/json" \
  -d '{"image_urls": ["https://resources.d.shotpix.app/preset/image.jpg"], "type": "preset", "profile_id": "test"}'
```

### Request Size Testing

```bash
# Should fail (too large)
curl -X POST https://api.d.shotpix.app/faceswap \
  -H "Content-Type: application/json" \
  -H "Content-Length: 1048577" \
  -d '{"profile_id":"test"}'
```

### Timeout Testing

```bash
# Should timeout after 60s if API is slow
timeout 70 curl -X POST https://api.d.shotpix.app/faceswap \
  -d '{"profile_id":"test","preset_image_id":"test","selfie_ids":["test"]}'
```

---

## Troubleshooting

### CORS Issues

**Problem:** Frontend can't make requests

**Solutions:**
1. Check `ALLOWED_ORIGINS` includes your frontend URL
2. Verify exact URL match (including protocol and port)
3. Check browser console for CORS error details
4. Verify OPTIONS preflight succeeds

**Debug:**
```javascript
// Check current origin
console.log(window.location.origin);

// Test CORS
fetch('https://api.d.shotpix.app/presets')
  .then(r => console.log('CORS:', r.headers.get('Access-Control-Allow-Origin')))
  .catch(e => console.error('CORS Error:', e));
```

### Rate Limiting Issues

**Problem:** Legitimate requests getting rate limited

**Solutions:**
1. Check if `RATE_LIMIT_KV` is configured correctly
2. Verify KV namespace exists and is bound
3. Check rate limit key format: `rate_limit:${ip}:${path}`
4. Consider increasing limit (modify `checkRateLimit()` function)

**Debug:**
```bash
# Check rate limit status
curl -v https://api.d.shotpix.app/presets 2>&1 | grep -i "retry-after"
```

### SSRF Protection Issues

**Problem:** Valid image URLs being blocked

**Solutions:**
1. Ensure URLs use HTTPS protocol
2. Add domain to `R2_DOMAIN` env var if using custom R2 domain
3. Check URL is not a private IP address
4. Verify domain is in allowed list (R2 domains are auto-allowed)

**Debug:**
```typescript
// Test URL validation
const testUrl = "https://your-image-url.com/image.jpg";
const isValid = validateImageUrl(testUrl, env);
console.log('URL valid:', isValid);
```

### Performance Issues

**Problem:** Slow response times

**Solutions:**
1. Enable KV cache for preset prompts (configure `RATE_LIMIT_KV`)
2. Check if parallel image fetching is working (multiple selfies)
3. Verify streaming is used for large images
4. Monitor external API response times

**Debug:**
```bash
# Check response times
time curl https://api.d.shotpix.app/presets

# Check if caching is working (should be faster on second request)
time curl https://api.d.shotpix.app/faceswap -d '{"profile_id":"test","preset_image_id":"cached-preset","selfie_ids":["test"]}'
```

---

## Summary of Changes

### Security Improvements
✅ CORS origin validation (prevents unauthorized access)
✅ SSRF protection (blocks private IPs and unsafe URLs)
✅ Rate limiting (prevents abuse)
✅ Request size limits (prevents DoS)
✅ SQL injection bounds (limits array sizes)
✅ Token cache bounds (prevents memory leaks)
✅ Debug sanitization (prevents data leaks)

### Performance Improvements
✅ Parallel image fetches (3x faster for multiple selfies)
✅ Stream large images (reduces memory usage)
✅ Pagination limits (prevents large responses)
✅ Preset prompt caching (5-10x faster)
✅ Request timeouts (prevents hanging requests)

### Configuration Required
- `ALLOWED_ORIGINS` - CORS whitelist (required for production)
- `RATE_LIMIT_KV` - KV namespace for rate limiting and caching (optional but recommended)

### Backward Compatibility
- All changes are backward compatible
- Default behavior if env vars not set: allows all origins (CORS), no rate limiting
- Mobile apps work without any configuration

---

## Support

For issues or questions:
1. Check this documentation
2. Review error messages in logs
3. Test with provided test scripts
4. Check Cloudflare Worker logs in dashboard

---

**Last Updated:** 2024
**Version:** 1.0.0

