# Testing Patterns

**Analysis Date:** 2026-02-24

## Test Framework

**Runner:**
- Not detected - No test framework configured (no Jest, Vitest, or similar)
- No test files found in codebase

**Assertion Library:**
- Not applicable

**Run Commands:**
```bash
# No test commands defined in package.json
# Testing setup: Not implemented
```

## Test Organization

**Location:**
- No dedicated test directory structure
- No `.test.ts` or `.spec.ts` files present in codebase
- Testing approach: Manual/integration testing only

**Naming:**
- Not applicable (no test files exist)

**Structure:**
- Not applicable (no test framework)

## Manual Testing Approach

The codebase relies on manual testing through HTML test interfaces instead of automated tests:

**Test Files:**
- `frontend-cloudflare-pages/api-test.html` - Manual API endpoint testing interface
- `frontend-cloudflare-pages/fcm-test.html` - Firebase Cloud Messaging manual testing

These HTML files provide interactive forms to test endpoints without running automated test suites.

## Development Validation

**Type Checking:**
- TypeScript strict mode enforced (`"strict": true` in tsconfig.json)
- Compilation validates all type safety at build time
- Source: `tsconfig.json`

**Configuration:**
- `tsconfig.json` at root level
- Includes: `["backend-cloudflare-workers/**/*"]`
- Excludes: `["node_modules"]`
- TypeScript version: ^5.3.3 (from package.json)

## Validation Functions

**Request Validation:**
- Located: `backend-cloudflare-workers/validators.ts`
- Functions:
  - `validateEnv(env: Env, mode: string): string | null` - Validates required environment variables
  - `validateRequest(body: any): string | null` - Validates request body shape

**Pattern:**
```typescript
export const validateEnv = (env: Env, mode: 'rapidapi' | 'vertex' | 'wavespeed' = 'rapidapi'): string | null => {
  if (mode !== 'vertex' && mode !== 'wavespeed') {
    if (!env.RAPIDAPI_KEY) return 'RAPIDAPI_KEY not set';
    if (!env.RAPIDAPI_HOST) return 'RAPIDAPI_HOST not set';
    if (!env.RAPIDAPI_ENDPOINT) return 'RAPIDAPI_ENDPOINT not set';
  }

  if (mode === 'wavespeed' && !env.WAVESPEED_API_KEY) return 'WAVESPEED_API_KEY not set';

  if (!env.GOOGLE_VISION_API_KEY) return 'GOOGLE_VISION_API_KEY not set';

  return null; // Success
};
```

**Request Validation Pattern:**
```typescript
export const validateRequest = (body: any): string | null => {
  if (!body || typeof body !== 'object') {
    return 'Invalid request body: must be a JSON object';
  }

  const hasPresetId = body.preset_image_id && typeof body.preset_image_id === 'string';
  const hasPresetUrl = body.preset_image_url && typeof body.preset_image_url === 'string';
  if (!hasPresetId && !hasPresetUrl) {
    return 'Missing required field: preset_image_id or preset_image_url';
  }

  return null; // Success
};
```

## Error Handling Testing

**Safety Check Testing:**
- `checkImageSafetyWithFlashLite()` in `services.ts` tests content safety using Gemini API
- `checkSafeSearch()` in `services.ts` tests using Google Vision API
- Safety violations categorized and tracked:
  - `ADULT: 1001`, `VIOLENCE: 1002`, `RACY: 1003`, `MEDICAL: 1004`, `SPOOF: 1005`
  - Vertex AI categories: `HATE_SPEECH: 2001`, `HARASSMENT: 2002`, `SEXUALLY_EXPLICIT: 2003`, `DANGEROUS_CONTENT: 2004`

**Pattern:**
```typescript
// Safety checks are called for all image generation/processing
const safetyCheck = await checkImageSafetyWithFlashLite(imageUrl, env);
if (!safetyCheck.isSafe) {
  return {
    Success: false,
    Message: 'Content blocked by safety policy',
    StatusCode: safetyCheck.statusCode || 400,
    Error: safetyCheck.error,
    SafetyCheck: safetyCheck
  };
}
```

## Retry Logic Testing

**Retry Mechanism:**
- `generateVertexPromptWithRetry()` in `index.ts` implements exponential backoff
- Configurable max retries (default 15)
- Initial delay 2000ms with exponential backoff: `baseDelay * Math.pow(2, attempt)`
- Jitter added: `Math.random() * 0.3 * baseDelay`
- Max delay capped at 5s (fast) or 30s (normal)

**Retryable Error Detection:**
```typescript
const isRetryableError = (error: string, debug?: any): boolean => {
  // Check if error is transient (should retry)
  // Non-retryable: permanent 4xx except 429
  if (httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
    return false;
  }

  // Retryable: JSON errors, timeouts, 5xx, rate limits
  return errorLower.includes('timeout') ||
         errorLower.includes('rate limit') ||
         (httpStatus >= 500 && httpStatus < 600);
};
```

## Rate Limiting Testing

**Rate Limiter:**
- Cloudflare built-in rate limiter accessed via `env.RATE_LIMITER`
- Rate limit key pattern: `${ip}:${path}` or `ray-${cfRay}:${path}`
- Returns: `{ success: boolean }`

**Pattern:**
```typescript
const checkRateLimit = async (env: Env, request: Request, path: string): Promise<boolean> => {
  if (!env.RATE_LIMITER) return true;

  const cfIp = request.headers.get('CF-Connecting-IP');
  const ip = cfIp || forwardedFor?.split(',')[0].trim();
  const rateLimitKey = `${ip}:${path}`;
  const result = await env.RATE_LIMITER.limit({ key: rateLimitKey });
  return result.success;
};
```

## What's NOT Tested

**Coverage Gaps:**
- No unit tests for utility functions (`utils.ts`)
- No integration tests for service orchestration
- No end-to-end test suite for complete workflows
- No property-based testing
- No performance/load testing framework
- No mutation testing

**Risk Areas:**
- Complex image processing pipelines (Vertex AI, WaveSpeed API integrations) depend on manual testing
- Retry logic not tested with simulated failures
- Safety filter bypass scenarios not covered by automated tests
- Database interactions (D1) not tested automatically

## Performance Testing

**Performance Monitoring:**
- Timestamps captured: `const startTime = Date.now(); const durationMs = Date.now() - startTime;`
- Processing time tracked in responses: `ProcessingTime`, `ProcessingTimeSpan`, `ProcessStartedDateTime`
- Debug output includes: `durationMs` for each API call

**Example:**
```typescript
const startTime = Date.now();
const response = await fetchWithTimeout(env.RAPIDAPI_ENDPOINT, {...}, 60000);
const durationMs = Date.now() - startTime;
debugInfo.durationMs = durationMs;
```

## Configuration Testing

**Environment Validation:**
- `validateEnv()` checks all required environment variables before processing
- Called on request path: `/api/validate-env` endpoint
- Mode-specific validation: `rapidapi`, `vertex`, `wavespeed`

**Example:**
```typescript
const envError = validateEnv(env, provider);
if (envError) {
  return errorResponse(request, 500, 'Environment validation failed', envError);
}
```

## Mocking & Test Doubles

**Mock ID Generation:**
- `generateMockId()` creates mock IDs for performance testing: `mock-${nanoid(16)}`
- Located in `services.ts`
- Used to avoid database conflicts during testing

**Pattern:**
```typescript
const generateMockId = () => `mock-${nanoid(16)}`;
```

## What Test Infrastructure Exists

**VSCode Settings:**
- No test runner extensions configured in `.vscode/settings.json`
- Live Server configured for frontend testing

**Type Safety:**
- TypeScript provides compile-time validation
- Strict mode catches type errors before runtime

**Manual Test Interfaces:**
- HTML-based test UIs for interactive API testing
- No automated assertion or reporting

---

*Testing analysis: 2026-02-24*

## Summary

This codebase relies on **manual testing only** - there are no automated tests, test frameworks, or CI test pipelines configured. Testing is performed through:
1. TypeScript type checking (strict mode)
2. Manual HTML test interfaces (api-test.html, fcm-test.html)
3. Environment validation functions (validateEnv, validateRequest)
4. Runtime error handling and safety checks

**Recommendation:** Add a test framework (Jest or Vitest) and create unit tests for critical functions like validators, retry logic, and safety checks. Integration tests for API flows would also reduce regression risk.
