# Coding Conventions

**Analysis Date:** 2026-02-24

## Naming Patterns

**Files:**
- `kebab-case.ts` for general utilities (`config.ts`, `validators.ts`, `types.ts`)
- `camelCase.ts` for module-specific files (`index.ts`, `services.ts`, `utils.ts`)
- No file suffixes like `.service.ts` or `.util.ts` used; naming is implicit from context
- Example: `backend-cloudflare-workers/index.ts`, `backend-cloudflare-workers/utils.ts`

**Functions:**
- `camelCase` for all functions: `generateVertexPrompt()`, `validateRequest()`, `callFaceSwap()`
- Private helper functions use same convention: `sanitizeObject()`, `getMimeExt()`, `getR2Bucket()`
- Constants in `UPPER_SNAKE_CASE`: `SENSITIVE_KEYS`, `CORS_HEADERS`, `SAFETY_STATUS_CODES`
- Boolean functions prefixed with `is`, `has`, `get`, or `check`: `isRetryableError()`, `isUnsafe()`, `checkSafeSearch()`

**Variables:**
- `camelCase` for local variables: `imageUrl`, `lastError`, `projectId`, `formData`
- `UPPER_SNAKE_CASE` for constants and enums: `RATE_LIMITER`, `VERTEX_AI_CONFIG`, `TIMEOUT_CONFIG`
- Array parameters documented with plural naming: `selfie_ids[]`, `sourceUrls`, `imageUrls`

**Types:**
- `PascalCase` for interfaces: `FaceSwapRequest`, `FaceSwapResponse`, `SafeSearchResult`, `Env`
- Interfaces use property names matching API contracts: `preset_image_id`, `selfie_ids`, `profile_id` (snake_case for database/API fields)
- Internal properties use `camelCase`: `imageUrl`, `profileId` (when creating new properties)

## Code Style

**Formatting:**
- TypeScript with strict mode enabled (`"strict": true` in tsconfig.json)
- Target: ES2021 output
- Module: ES2022
- 2-space indentation (inferred from code patterns)
- Line length appears unlimited but code is readable

**Linting:**
- No ESLint config detected; relies on TypeScript strict mode
- No Prettier config detected; code follows consistent manual formatting
- Type safety enforced through TypeScript compiler

## Import Organization

**Order:**
1. External libraries (React, utilities): `import { customAlphabet } from 'nanoid'`
2. Type imports: `import type { Env, FaceSwapRequest } from './types'`
3. Local utility exports: `import { CORS_HEADERS, getCorsHeaders, jsonResponse } from './utils'`
4. Service functions: `import { callFaceSwap, callNanoBanana } from './services'`
5. Validators: `import { validateEnv, validateRequest } from './validators'`
6. Centralized config: `import { VERTEX_AI_PROMPTS, ASPECT_RATIO_CONFIG } from './config'`

**Path Aliases:**
- No path aliases configured; uses relative imports: `./types`, `./utils`, `./services`, `./config`
- Structured by directory: all backend code in `backend-cloudflare-workers/`

## Error Handling

**Patterns:**
- Try-catch wrapping API calls with detailed error transformation
- Errors wrapped in response objects with shape: `{ success: false, error: string, debug?: any }`
- HTTP-style status codes used: `StatusCode: response.status` or custom codes (1001-3001)
- Safety violation codes: `ADULT: 1001`, `VIOLENCE: 1002`, `RACY: 1003`, `MEDICAL: 1004`, `SPOOF: 1005`
- Vertex AI safety codes: `HATE_SPEECH: 2001`, `HARASSMENT: 2002`, `SEXUALLY_EXPLICIT: 2003`, `DANGEROUS_CONTENT: 2004`

**Error Response Pattern:**
```typescript
return {
  Success: false,
  Message: 'User-friendly error message',
  StatusCode: 400,
  Error: 'Detailed error for debugging',
  Debug: { /* Full context */ }
}
```

**Retry Logic:**
- Transient errors (network, timeout, 5xx, 429) are retryable
- Permanent errors (4xx except 429) are not retried
- Exponential backoff with jitter: `baseDelay * Math.pow(2, attempt) + Math.random() * 0.3 * baseDelay`
- Max delay capped: 5s for fast retries, 30s for normal operations

## Logging

**Framework:** `console` object (no logging library)

**Patterns:**
- `console.log()` for info: `console.log('[Vertex Prompt Retry] Success on attempt ${attempt + 1}/${maxRetries}')`
- `console.warn()` for warnings: `console.warn('[Vertex Prompt Retry] Attempt ${attempt + 1}/${maxRetries} failed')`
- `console.error()` for errors: `console.error('[Vertex-NanoBanana] Missing service account credentials')`
- Log prefix pattern: `[ServiceName-OperationName]` for categorization
- Time calculations logged: `Retrying in ${Math.round(delay)}ms...`

**When to Log:**
- Service initialization errors (missing credentials, invalid config)
- Retry attempts and backoff delays
- API response errors with status codes
- Safety filter violations
- Content policy rejections
- JSON parsing errors with context

## Comments

**When to Comment:**
- Complex retry logic includes inline comments explaining each branch
- Configuration objects have comment headers describing sections
- Safety violation mappings include Vietnamese translations alongside English descriptions
- Non-obvious business logic: "MUST succeed before uploading to R2"

**JSDoc/TSDoc:**
- Minimal TSDoc usage; most functions lack docstrings
- Comments inline within function bodies rather than block comments
- No structured parameter/return documentation observed

## Function Design

**Size:**
- Functions range from 10-100 lines typically
- Large functions handle orchestration (e.g., `callNanoBanana` ~150 lines including nested functions)
- Helper functions are small: `getMimeExt()` 4 lines, `base64ToUint8Array()` 3 lines

**Parameters:**
- Functions use object destructuring for configuration: `options?: { skipFacialPreservation?: boolean; provider?: string }`
- Optional parameters marked with `?`
- Env object passed as last parameter in most functions
- Type-safe with TypeScript annotations for all params

**Return Values:**
- Consistent response shape for async operations: `{ success: boolean, data?: any, error?: string, debug?: any }`
- API endpoints return `FaceSwapResponse` interface
- Validators return `string | null` (null for success, error message on failure)

## Module Design

**Exports:**
- `export const` for public functions and constants: `export const callFaceSwap = async (...)`
- `export type` or `export interface` for types: `export interface FaceSwapRequest`
- Private functions/constants use `const` without export
- Default exports not used

**Barrel Files:**
- No barrel files (index.ts files as entry points); imports are explicit from individual modules
- Entry point: `backend-cloudflare-workers/index.ts` (Cloudflare Worker handler)

## API Response Standardization

All API responses follow a standard envelope:
```typescript
{
  Success: boolean;
  Message: string;
  StatusCode: number;
  Error?: string;
  Debug?: Record<string, any>;
  ResultImageUrl?: string;
  ProcessingTime?: string;
  // ... operation-specific fields
}
```

Status codes use HTTP conventions (200, 400, 429, 500) plus custom safety codes (1001-3001).

## Security Patterns

**Secrets Handling:**
- Sensitive keys identified by keyword matching: `key`, `token`, `password`, `secret`, `api_key`, `authorization`
- Function `sanitizeObject()` redacts sensitive values to `'***REDACTED***'` in debug output
- No secrets logged in console output for production safety

**API Key Validation:**
- Constant-time comparison used: `constantTimeCompare()` prevents timing attacks
- API key checked on every request: `checkApiKey(env, request)`
- Custom X-API-Key header checked against environment config

---

*Convention analysis: 2026-02-24*
