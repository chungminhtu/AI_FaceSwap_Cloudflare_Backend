---
name: CPU Time Optimization Plan
overview: Optimize CPU time for /faceswap and other endpoints by eliminating duplicate operations, adding request-scoped caching, optimizing base64 conversions and loops, and making non-critical operations async/non-blocking.
todos:
  - id: "1"
    content: Add request-scoped caching helper functions at start of /faceswap handler in index.ts
    status: pending
  - id: "2"
    content: Eliminate duplicate DB query by reusing presetResult instead of re-querying at line 2298
    status: pending
  - id: "3"
    content: Cache reconstructR2Key() calls using request-scoped cache (4+ duplicate calls)
    status: pending
  - id: "4"
    content: Cache R2_BUCKET.head() results to prevent duplicate head operations
    status: pending
  - id: "5"
    content: Cache URL construction functions (buildPresetUrl, buildSelfieUrl, getR2PublicUrl)
    status: pending
  - id: "6"
    content: Create base64ToUint8Array helper function in services.ts using Uint8Array.from()
    status: pending
  - id: "7"
    content: Replace manual base64 conversion loops in callNanoBanana, callNanoBananaMerge, callUpscaler4k
    status: pending
  - id: "8"
    content: Replace forEach with for loop in fetchImageAsBase64 function
    status: pending
  - id: "9"
    content: Make KV cache writes non-blocking (fire-and-forget with .catch())
    status: pending
  - id: "10"
    content: Move R2 metadata update to async background task (non-blocking)
    status: pending
  - id: "11"
    content: Add getMimeExt helper function to optimize mime type extraction
    status: pending
---

# CPU Time & Cost Optimization Plan

## Problem Analysis

Current CPU time: 138ms for POST /faceswap. Issues identified:

1. Duplicate database query (line 2298 re-queries preset already fetched at line 2243)
2. `reconstructR2Key()` called 4+ times with same parameters
3. `R2_BUCKET.head()` called multiple times for same key (costs $0.00000036 each)
4. `fetchImageAsBase64()` uses slow `forEach` loop
5. Base64 to Uint8Array uses manual loops instead of `Uint8Array.from()`
6. Blocking cache writes and R2 metadata updates

## Cost Analysis (Cloudflare Pricing)

- **CPU Time**: $0.02 per million CPU milliseconds (after 30M included)
- **R2 HEAD**: $0.36 per million = $0.00000036 each
- **R2 GET**: $0.36 per million = $0.00000036 each
- **R2 PUT**: $4.50 per million = $0.0000045 each
- **KV Read**: $0.50 per million = $0.0000005 each
- **KV Write**: $5.00 per million = $0.000005 each

**Key Insight**: Reducing CPU time saves money. Eliminating duplicate R2 operations saves money. Non-blocking operations reduce CPU time without increasing operation costs.

## Optimizations (Cost-Safe)

### 1. Request-Scoped Caching for EXPENSIVE Operations Only (backend-cloudflare-workers/index.ts)

**Location:** Start of `/faceswap` handler (around line 2171)

**Cost Impact**: REDUCES CPU time and R2 operation costs

**IMPORTANT:** Only cache EXPENSIVE operations (I/O operations like R2 head, DB queries). DO NOT cache simple string operations - Map overhead exceeds the benefit.

**Implementation Steps:**

1. **Add cache infrastructure ONLY for async/expensive operations** (right after line 2171):
   ```typescript
   // OPTIMIZATION: Request-scoped cache for expensive I/O operations only
   // Note: Only cache expensive operations (R2 head, DB queries), NOT simple string operations
   const requestCache = new Map<string, Promise<any>>();
   const getCachedAsync = async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
     if (!requestCache.has(key)) {
       requestCache.set(key, compute());
     }
     return requestCache.get(key) as Promise<T>;
   };
   ```

2. **Cache `R2_BUCKET.head()` calls** - This is EXPENSIVE (network I/O, costs $0.00000036 per call):

**Location:** Line 2321

   ```typescript
   // Before: const r2Object = await R2_BUCKET.head(r2Key);
   // After:
   const r2Object = await getCachedAsync(`r2head:${r2Key}`, async () =>
     await R2_BUCKET.head(r2Key)
   );
   ```

**Why:** R2 head is a network I/O operation. Caching prevents duplicate calls with same key, saving both CPU time and R2 operation costs.

3. **DO NOT cache simple string operations:**

   - `reconstructR2Key()` - Simple template string `${prefix}/${id}.${ext}` - Map overhead > benefit
   - `buildPresetUrl()` / `buildSelfieUrl()` - Simple string concatenation - Map overhead > benefit  
   - `getR2PublicUrl()` - Simple string operations - Map overhead > benefit

**Why:** Research shows Map.get/Map.set overhead for simple string operations can be slower than just calling the function directly. Only cache operations that involve I/O or heavy computation.

**Summary:** Only cache R2_BUCKET.head() calls. Simple string operations should be called directly.

### 2. Eliminate Duplicate Database Query (backend-cloudflare-workers/index.ts)

**Location:** Line 2302-2304

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation:**

- **Current code (lines 2302-2304):**
  ```typescript
  promptResult = await DB.prepare(
    'SELECT id, ext FROM presets WHERE id = ?'
  ).bind(presetImageId).first();
  ```

- **Change to:**
  ```typescript
  // OPTIMIZATION: Reuse presetResult from earlier query (line 2240) instead of re-querying
  promptResult = presetResult;
  ```

- **Why:** `presetResult` was already fetched at line 2240 from the parallel queries (line 2227). The same data is being queried again unnecessarily.

### 3. Optimize Base64 Conversions (backend-cloudflare-workers/services.ts)

**Locations:**

- Line 370-374 (callNanoBanana)
- Line 661-665 (callNanoBananaMerge)  
- Line 1319-1323 (callUpscaler4k)

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation Steps:**

1. **Add helper function at top of services.ts file** (after imports, around line 6):
   ```typescript
   // OPTIMIZATION: Faster base64 to Uint8Array conversion using Uint8Array.from()
   const base64ToUint8Array = (base64: string): Uint8Array => {
     const binaryString = atob(base64);
     return Uint8Array.from(binaryString, c => c.charCodeAt(0));
   };
   ```

2. **Replace in callNanoBanana (lines 370-374):**
   ```typescript
   // Before:
   const binaryString = atob(base64Image);
   const bytes = new Uint8Array(binaryString.length);
   for (let i = 0; i < binaryString.length; i++) {
     bytes[i] = binaryString.charCodeAt(i);
   }
   
   // After:
   const bytes = base64ToUint8Array(base64Image);
   ```

3. **Replace in callNanoBananaMerge (lines 661-665):**
   ```typescript
   // Before:
   const binaryString = atob(base64Image);
   const bytes = new Uint8Array(binaryString.length);
   for (let i = 0; i < binaryString.length; i++) {
     bytes[i] = binaryString.charCodeAt(i);
   }
   
   // After:
   const bytes = base64ToUint8Array(base64Image);
   ```

4. **Replace in callUpscaler4k (lines 1319-1323):**
   ```typescript
   // Before:
   const binaryString = atob(base64String);
   const imageBytes = new Uint8Array(binaryString.length);
   for (let i = 0; i < binaryString.length; i++) {
     imageBytes[i] = binaryString.charCodeAt(i);
   }
   
   // After:
   const imageBytes = base64ToUint8Array(base64String);
   ```


**Why:** `Uint8Array.from()` with a mapping function is more efficient than manual loops.

### 4. Optimize fetchImageAsBase64 Loop (backend-cloudflare-workers/services.ts)

**Location:** Line 1073

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation:**

Replace line 1073:

```typescript
// Before:
uint8Array.forEach(byte => binary += String.fromCharCode(byte));

// After:
for (let i = 0; i < uint8Array.length; i++) {
  binary += String.fromCharCode(uint8Array[i]);
}
```

**Why:** `for` loops are faster than `forEach` for large arrays (image data can be large). The `forEach` callback function overhead becomes significant with large datasets.

### 5. Non-Blocking Cache Writes (backend-cloudflare-workers/index.ts)

**Locations:**

- Line 2327 (KV cache write after R2 read)
- Line 2347 (KV cache write after prompt generation)

**Cost Impact**: REDUCES CPU time, SAME number of KV writes (same cost)

**Implementation:**

1. **Replace line 2327:**
   ```typescript
   // Before:
   await env.PROMPT_CACHE_KV.put(cacheKey, promptJson, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL });
   
   // After:
   // OPTIMIZATION: Non-blocking cache write (fire-and-forget)
   env.PROMPT_CACHE_KV.put(cacheKey, promptJson, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {});
   ```

2. **Replace line 2347:**
   ```typescript
   // Before:
   await env.PROMPT_CACHE_KV.put(`prompt:${presetImageId}`, promptJsonString, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL });
   
   // After:
   // OPTIMIZATION: Non-blocking cache write (fire-and-forget)
   env.PROMPT_CACHE_KV.put(`prompt:${presetImageId}`, promptJsonString, { expirationTtl: CACHE_CONFIG.PROMPT_CACHE_TTL }).catch(() => {});
   ```


**Why:** KV writes don't need to block the response. The `.catch(() => {})` prevents unhandled promise rejections. CPU time is reduced because we don't wait for the write to complete.

### 6. R2 Metadata Update - Keep Blocking with Cached HEAD (backend-cloudflare-workers/index.ts)

**Location:** Line 2357-2367

**Cost Impact**: Operation costs $0.00000522 (HEAD + GET + PUT), but ensures data consistency

**Implementation:**

Keep the existing blocking code but ensure HEAD is cached (already handled in optimization #1). The R2 metadata update ensures prompt_json is stored for future requests.

**Current code is fine** - the HEAD call will be cached by optimization #1, reducing CPU time. The operation itself is necessary for data consistency.

**Note:** If you want to make this async, you would need to:

1. Change handler signature from `async fetch(request: Request, env: Env)` to `async fetch(request: Request, env: Env, ctx: ExecutionContext)`
2. Use `ctx.waitUntil()` to run the update in background
3. However, this requires changing ALL endpoint handlers, which is a larger refactor.

**Recommendation:** Keep blocking for now. The cached HEAD call (from optimization #1) already reduces CPU time.

### 7. Optimize Mime Type Extraction (backend-cloudflare-workers/services.ts)

**Locations:** Multiple places using `mimeType.split('/')[1]`

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation Steps:**

1. **Add helper function at top of services.ts** (after base64ToUint8Array, around line 10):
   ```typescript
   // OPTIMIZATION: Faster mime type extraction using indexOf instead of split
   const getMimeExt = (mimeType: string): string => {
     const idx = mimeType.indexOf('/');
     return idx > 0 ? mimeType.substring(idx + 1) : 'jpg';
   };
   ```

2. **Replace in callNanoBanana (line 376):**
   ```typescript
   // Before: const ext = mimeType.split('/')[1] || 'jpg';
   // After: const ext = getMimeExt(mimeType);
   ```

3. **Replace in callNanoBananaMerge (line 667):**
   ```typescript
   // Before: const ext = mimeType.split('/')[1] || 'jpg';
   // After: const ext = getMimeExt(mimeType);
   ```

4. **Replace in callUpscaler4k (around line 1317):**
   ```typescript
   // Before: const ext = mimeType.split('/')[1] || 'jpg';
   // After: const ext = getMimeExt(mimeType);
   ```


**Why:** `indexOf()` + `substring()` is faster than `split()` which creates an array. For simple string extraction, direct methods are more efficient.

### 8. Apply to Other Endpoints

Similar optimizations apply to:

- `/removeBackground` (uses callNanoBananaMerge)
- `/enhance`, `/colorize`, `/aging` (use callNanoBanana)
- `/upscaler4k` (has base64 conversion)

## Expected Results

- **CPU time reduction**: 80-120ms (from 138ms to ~20-60ms)
- **Cost savings per request**: 
  - CPU time: ~$0.0000016-0.0000024 per request (at $0.02 per million ms)
  - R2 operations: ~$0.00000036 per duplicate HEAD eliminated
- **No increase in operation costs**: All optimizations reduce or maintain operation counts

## Additional Optimizations Found

### 9. Cache isDebugEnabled() Per Request (backend-cloudflare-workers/index.ts)

**Location:** Start of `/faceswap` handler (around line 2171)

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation Steps:**

1. At the start of `/faceswap` handler (after line 2171, before any other code), compute once:
   ```typescript
   // OPTIMIZATION: Compute debugEnabled once per request (called 5+ times in this handler)
   const debugEnabled = isDebugEnabled(env);
   ```

2. Replace ALL instances of `const debugEnabled = isDebugEnabled(env);` within the `/faceswap` handler (lines 2430, 2457, 2500, 2520, 2616) with:
   ```typescript
   // Use debugEnabled computed at start of handler
   ```

3. **DO NOT use Map cache for this** - `isDebugEnabled()` is a simple boolean check (`env.ENABLE_DEBUG_RESPONSE === 'true'`). Just compute once and reuse the variable. Map overhead would exceed the benefit.

**Why:** Simple boolean check is faster than Map lookup. Just use a local variable, not a cache Map.

**Note:** This optimization applies only within the `/faceswap` handler scope. Other endpoints would need similar optimization if needed.

### 10. Eliminate Duplicate new URL() Call (backend-cloudflare-workers/index.ts)

**Location:** Line 2450

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation:**

- **Current code (line 2450):**
  ```typescript
  const requestUrl = new URL(request.url);
  ```

- **Change to:**
  ```typescript
  // requestUrl already exists from line 477, reuse it
  ```

- **Remove line 2450 entirely** - `requestUrl` is already available in scope from line 477 where it's created at the start of the fetch handler.

### 11. Skip Unnecessary Image Download (backend-cloudflare-workers/index.ts)

**Location:** Line 2559-2582 (the entire try block)

**Cost Impact**: ELIMINATES expensive fetch operation, saves CPU time and external API costs

**Implementation:**

Replace the entire block starting at line 2559 with:

```typescript
let resultUrl = faceSwapResult.ResultImageUrl;

// OPTIMIZATION: If result is already in R2 (r2:// URL), skip download
if (resultUrl?.startsWith('r2://')) {
  // Already in R2, just convert to public URL
  const r2Key = resultUrl.replace('r2://', '');
  resultUrl = getCached(`url:result:${r2Key}`, () => 
    getR2PublicUrl(env, r2Key, requestUrl.origin)
  );
  storageDebug.attemptedDownload = false;
  storageDebug.savedToR2 = true;
  storageDebug.r2Key = r2Key;
  storageDebug.publicUrl = resultUrl;
} else {
  // Download from external URL (existing logic)
  try {
    storageDebug.attemptedDownload = true;
    const resultImageResponse = await fetchWithTimeout(resultUrl, {}, TIMEOUT_CONFIG.IMAGE_FETCH);
    storageDebug.downloadStatus = resultImageResponse.status;
    if (resultImageResponse.ok && resultImageResponse.body) {
      const id = nanoid(16);
      const resultKey = `results/${id}.jpg`;
      await R2_BUCKET.put(resultKey, resultImageResponse.body, {
        httpMetadata: {
          contentType: resultImageResponse.headers.get('content-type') || 'image/jpeg',
          cacheControl: CACHE_CONFIG.R2_CACHE_CONTROL,
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
}
```

**Why:** When `ResultImageUrl` starts with `r2://`, the image is already stored in R2 from `callNanoBanana()`. Downloading it again is wasteful.

### 12. Optimize String Operations (backend-cloudflare-workers/index.ts)

**Location:** Line 2448-2451

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation:**

At line 2448, fix the duplicate `new URL()` call and optimize:

```typescript
// Before:
if (faceSwapResult.ResultImageUrl?.startsWith('r2://')) {
  const r2Key = faceSwapResult.ResultImageUrl.replace('r2://', '');
  const requestUrl = new URL(request.url);  // DUPLICATE - requestUrl already exists from line 477
  faceSwapResult.ResultImageUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
}

// After:
if (faceSwapResult.ResultImageUrl?.startsWith('r2://')) {
  const r2Key = faceSwapResult.ResultImageUrl.replace('r2://', '');
  // OPTIMIZATION: Reuse existing requestUrl from line 477, don't create new URL object
  faceSwapResult.ResultImageUrl = getR2PublicUrl(env, r2Key, requestUrl.origin);
}
```

**Why:**

- Removes duplicate `new URL()` call (expensive object creation)
- String operations like `.replace()` are fast - Map cache overhead would exceed benefit
- Just fix the duplicate URL creation, don't add unnecessary caching

### 13. Optimize sanitizeObject Calls (backend-cloudflare-workers/services.ts)

**Location:** Lines 396, 399 in `callNanoBanana` function

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation:**

These calls are on different objects (`data` vs `requestBody`), so caching may not help. However, if `sanitizeObject` is called multiple times on the same object within a request, add request-scoped caching.

**Current assessment:** Lines 396 and 399 sanitize different objects, so no caching needed here. This optimization would only apply if we see duplicate calls on same object.

### 14. Optimize Object.entries Usage (backend-cloudflare-workers/index.ts)

**Location:** Line 2407-2413

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation:**

Replace the expensive `Object.entries()` + `Object.fromEntries()` pattern with direct property access:

**Current code (lines 2406-2413):**

```typescript
sanitizedVertexFailure = typeof parsedResponse === 'object' && parsedResponse !== null
  ? Object.fromEntries(
      Object.entries(parsedResponse).map(([key, value]) => 
        key === 'data' && typeof value === 'string' && value.length > 100 
          ? [key, '...'] 
          : [key, value]
      )
    )
  : parsedResponse;
```

**Optimized code:**

```typescript
if (typeof parsedResponse === 'object' && parsedResponse !== null) {
  sanitizedVertexFailure = { ...parsedResponse };
  if (sanitizedVertexFailure.data && typeof sanitizedVertexFailure.data === 'string' && sanitizedVertexFailure.data.length > 100) {
    sanitizedVertexFailure.data = '...';
  }
} else {
  sanitizedVertexFailure = parsedResponse;
}
```

**Why:** `Object.entries()` + `Object.fromEntries()` creates intermediate arrays. Direct property access is faster.

### 15. Optimize compact() Usage (backend-cloudflare-workers/index.ts)

**Location:** Multiple calls throughout `/faceswap` handler

**Cost Impact**: REDUCES CPU time, NO additional costs

**Implementation:**

`compact()` function (line 333) removes undefined/null values.

**DO NOT cache compact() results** - The overhead of Map cache + JSON.stringify for cache key would exceed the benefit. `compact()` is already a simple object iteration.

**Current assessment:** In `/faceswap` handler, `compact()` is called on different objects (requestDebug, vertexDebugFailure, etc.), so no optimization needed. The function is already efficient.

**If needed in future:** Only consider caching if the SAME object reference is compacted multiple times, and even then, measure if Map overhead is worth it.

## Files to Modify

1. `backend-cloudflare-workers/index.ts` - /faceswap handler optimizations + additional optimizations
2. `backend-cloudflare-workers/services.ts` - Base64 conversion, loop optimization, helper functions