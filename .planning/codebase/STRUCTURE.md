# Codebase Structure

**Analysis Date:** 2026-02-24

## Directory Layout

```
/Volumes/DATA/TOOLS/AI_FaceSwap_Cloudflare_Backend/
├── backend-cloudflare-workers/          # Cloudflare Worker backend API
│   ├── index.ts                         # Main HTTP request handler & routing (6,930 lines)
│   ├── services.ts                      # External API integrations (3,124 lines)
│   ├── utils.ts                         # Helper functions (1,460 lines)
│   ├── config.ts                        # Centralized config & prompts (377 lines)
│   ├── types.ts                         # TypeScript interfaces (174 lines)
│   ├── validators.ts                    # Input validation (42 lines)
│   ├── schema.sql                       # D1 database schema
│   ├── cleanup-old-thumbnails.js        # Maintenance script for R2 cleanup
│   ├── delete-r2-files.js               # R2 file manager CLI
│   ├── clear-kv-cache.js                # KV cache invalidation
│   ├── generate-api-key.js              # Generate secure API keys
│   ├── r2-file-manager.html             # R2 browser UI
│   ├── r2-file-manager.js               # R2 file manager backend
│   ├── migrations/                      # D1 migration files
│   └── package.json                     # Dependencies (uses pnpm)
│
├── frontend-cloudflare-pages/           # Single-page app (served as static)
│   ├── index.html                       # Main UI (320KB single file app)
│   ├── api-test.html                    # API testing interface
│   ├── fcm-test.html                    # Firebase Cloud Messaging test
│   ├── firebase-messaging-sw.js         # Service worker for push notifications
│   └── docs/                            # Documentation & static assets
│
├── _deploy-cli-cloudflare-gcp/          # Deployment orchestration
│   ├── deploy.js                        # Main deployment script (multi-environment)
│   ├── deployments-secrets.json         # Environment configs (secrets redacted)
│   ├── cloudflare-token-updater.js      # Token refresh automation
│   ├── list-r2-objects.js               # R2 inventory tool
│   ├── upload-zip-to-r2.js              # Bulk upload utility
│   ├── electron-app/                    # Electron desktop CLI app
│   ├── wrangler-configs/                # Environment-specific wrangler configs
│   │   ├── wrangler.ai-office.toml
│   │   ├── wrangler.ai-office-dev.toml
│   │   └── wrangler.ai-office-prod.toml
│   └── SECURITY_PERFORMANCE_HARDENING.OLD.md
│
├── .planning/
│   ├── codebase/                        # GSD codebase analysis documents
│   │   ├── ARCHITECTURE.md
│   │   ├── STRUCTURE.md
│   │   ├── CONVENTIONS.md
│   │   ├── TESTING.md
│   │   ├── STACK.md
│   │   ├── INTEGRATIONS.md
│   │   └── CONCERNS.md
│
├── package.json                         # Root monorepo manifest
├── tsconfig.json                        # TypeScript configuration
├── ARCHITECTURE_DETAILED.md             # Detailed architecture notes
├── DIAGRAMS_SEPARATED.md                # System diagrams
└── FCM_COMPLETE_GUIDE.md                # Firebase Cloud Messaging setup guide
```

## Directory Purposes

**backend-cloudflare-workers:**
- Purpose: Cloudflare Worker serverless backend serving all APIs
- Contains: TypeScript request handlers, service integrations, database schemas, utilities
- Key files: index.ts (routing), services.ts (external APIs), schema.sql (D1 tables)

**frontend-cloudflare-pages:**
- Purpose: Static web UI served via Cloudflare Pages
- Contains: Single HTML file with embedded CSS/JS, test utilities, FCM service worker
- Key files: index.html (main app), api-test.html (debugging), firebase-messaging-sw.js (push notifications)

**_deploy-cli-cloudflare-gcp:**
- Purpose: Deployment automation and environment management
- Contains: Multi-environment deploy scripts, wrangler configs, Electron CLI app
- Key files: deploy.js (orchestration), wrangler-configs/ (per-environment settings)

## Key File Locations

**Entry Points:**
- `backend-cloudflare-workers/index.ts`: HTTP fetch handler (line 878, export default.fetch)
- `backend-cloudflare-workers/index.ts`: Scheduled event handler (line 6868, export default.scheduled)
- `frontend-cloudflare-pages/index.html`: Web UI entry point

**Configuration:**
- `backend-cloudflare-workers/config.ts`: API prompts, model configs, aspect ratios, timeouts
- `_deploy-cli-cloudflare-gcp/deployments-secrets.json`: Environment variables per deployment
- `_deploy-cli-cloudflare-gcp/wrangler-configs/`: Wrangler TOML files for each environment

**Core Logic:**
- `backend-cloudflare-workers/index.ts`: Route handlers and request processing
- `backend-cloudflare-workers/services.ts`: Third-party API calls (Vertex AI, RapidAPI, WaveSpeed, Vision)
- `backend-cloudflare-workers/utils.ts`: Helper functions and common utilities

**Data Access:**
- `backend-cloudflare-workers/schema.sql`: Database schema (tables: profiles, presets, selfies, results)
- R2 Storage: Image files stored via `services.ts` streamImageToR2() and getR2Bucket()

**Testing:**
- `frontend-cloudflare-pages/api-test.html`: Manual API endpoint testing
- `frontend-cloudflare-pages/fcm-test.html`: Push notification testing

## Naming Conventions

**Files:**

- **Backend TypeScript:** camelCase.ts (index.ts, services.ts, utils.ts, validators.ts)
- **Frontend HTML:** index.html, {feature}-test.html (api-test.html)
- **Scripts:** lowercase-with-hyphens.js (cleanup-old-thumbnails.js, delete-r2-files.js)
- **Schemas:** schema.sql (database)
- **Config:** {feature}.ts (config.ts), wrangler.{environment}.toml

**Directories:**

- **Module dirs:** camelCase (backend-cloudflare-workers, frontend-cloudflare-pages, _deploy-cli-cloudflare-gcp)
- **Sub-dirs:** camelCase (migrations/, electron-app/, wrangler-configs/, docs/)
- **Planning:** ALL_CAPS.md (.planning/codebase/)

**TypeScript/JavaScript:**

- **Interfaces:** PascalCase (Env, FaceSwapRequest, FaceSwapResponse, SafeSearchResult)
- **Functions:** camelCase (callFaceSwap, generateVertexPrompt, checkSafeSearch)
- **Constants:** UPPER_SNAKE_CASE (CORS_HEADERS, PROTECTED_MOBILE_APIS, SAFETY_STATUS_CODES)
- **Variables:** camelCase (profileId, presetImageUrl, enableVertexPrompt)
- **Route paths:** /kebab-case (/faceswap, /upload-url, /process-thumbnail-file)

## Where to Add New Code

**New Endpoint/Route:**
- Primary code: `backend-cloudflare-workers/index.ts`
- Pattern: Add route check in main fetch handler (line 878+)
  ```typescript
  if (path === '/new-endpoint' && request.method === 'POST') {
    // Route handler implementation
  }
  ```
- Add to PROTECTED_MOBILE_APIS if authentication required (line 179)
- Request/Response types: Add to `backend-cloudflare-workers/types.ts`

**New Service Integration (external API):**
- Primary code: `backend-cloudflare-workers/services.ts`
- Pattern: Export new async function following existing pattern
  ```typescript
  export const callNewService = async (params: Type, env: Env): Promise<FaceSwapResponse> => {
    // Implementation
  }
  ```
- Import in `index.ts` and call from route handler
- Add any required prompts to `config.ts`

**New Utility Function:**
- Primary code: `backend-cloudflare-workers/utils.ts`
- Pattern: Export utility function, import in caller
- Common categories: image processing, URL handling, encoding, safety checks

**Database Model (new table):**
- Primary code: `backend-cloudflare-workers/schema.sql`
- Pattern: Add CREATE TABLE IF NOT EXISTS with indexes
- Reference with D1 prepared statements in `index.ts`

**Configuration or Prompt:**
- Primary code: `backend-cloudflare-workers/config.ts`
- Pattern: Add to appropriate export object (VERTEX_AI_PROMPTS, TIMEOUT_CONFIG, etc.)

**Frontend UI Feature:**
- Primary code: `frontend-cloudflare-pages/index.html`
- Pattern: Single file contains all HTML/CSS/JavaScript
- Embedded within <style> tag for CSS, <script> tag for JavaScript

## Special Directories

**migrations/:**
- Purpose: D1 database migration files for schema versioning
- Generated: Yes (automatically created by wrangler)
- Committed: Yes

**wrangler-configs/:**
- Purpose: Environment-specific Wrangler configuration files
- Files: wrangler.ai-office.toml (dev), wrangler.ai-office-prod.toml (production)
- Used by: deploy.js script to select correct config per environment
- Committed: Yes

**docs/:**
- Purpose: Static documentation and API reference
- Generated: Partially (docs/index.html built by docs/build-static.js)
- Committed: Yes

**node_modules/**
- Purpose: npm dependencies (pnpm workspace)
- Generated: Yes (from package.json)
- Committed: No (.gitignore)

**.wrangler/**
- Purpose: Wrangler local state and cache
- Generated: Yes
- Committed: No (.gitignore)

**.env files:**
- Purpose: Local development environment variables
- Files: .env (not checked in per .gitignore)
- Used by: Local development only, secrets stored in Cloudflare environment

## Route Mapping Reference

**Profile Management:**
- POST `/profiles` - Create new profile
- GET `/profiles` - List all profiles
- GET `/profiles/{id}` - Get profile details
- PUT `/profiles/{id}` - Update profile

**File Upload:**
- POST `/upload-url` - Upload preset or selfie (handles files or URLs)
- POST `/upload-multipart/create` - Multipart upload initiation
- PUT `/upload-multipart/part` - Upload part
- POST `/upload-multipart/complete` - Finalize multipart upload
- POST `/upload-multipart/abort` - Cancel multipart upload

**Image Browsing:**
- GET `/presets` - List all presets with pagination
- GET `/presets/{id}` - Get single preset details
- GET `/selfies` - List user's selfies
- GET `/thumbnails` - List available thumbnail formats
- GET `/thumbnails/{id}/preset` - Get preset thumbnails for specific format

**Image Processing:**
- POST `/faceswap` - Swap faces on preset with selfie(s)
- POST `/background` - Generate or merge backgrounds
- POST `/enhance` - Enhance image quality
- POST `/beauty` - Apply beauty effects
- POST `/upscaler4k` - 4K upscaling
- POST `/filter` - Apply artistic filters
- POST `/restore` - Restore old/damaged photos
- POST `/aging` - Age transformation

**Result Management:**
- GET `/results` - List processing results
- DELETE `/results/{id}` - Delete result

**Thumbnail Processing:**
- POST `/process-thumbnail-file` - Generate thumbnail for single preset
- POST `/process-thumbnail-zip` - Batch generate thumbnails from ZIP archive

**Device/Push Notifications:**
- POST `/api/device/register` - Register device for push notifications
- DELETE `/api/device/unregister` - Unregister device
- POST `/api/push/silent` - Send silent push notification

**Configuration:**
- GET `/config` - Get backend configuration (debug mode only)

**Cleanup & Maintenance:**
- DELETE `/presets/{id}` - Delete preset and its files
- DELETE `/selfies/{id}` - Delete selfie

## Import/Export Patterns

**Backend TypeScript:**

```typescript
// Imports (standard pattern)
import { customAlphabet } from 'nanoid';
import JSZip from 'jszip';
import type { Env, FaceSwapRequest, FaceSwapResponse } from './types';
import { CORS_HEADERS, getCorsHeaders, jsonResponse, errorResponse } from './utils';
import { callFaceSwap, callNanoBanana, generateVertexPrompt } from './services';

// Exports (standard pattern)
export const functionName = async (...): Promise<Type> => { ... };
export const CONSTANT_NAME = { ... };
export default { fetch, scheduled };
```

**Frontend JavaScript:**

```javascript
// All code embedded in single index.html file
// No module imports - global namespace
// Event listeners on window and document
```

**Configuration File:**

```typescript
// Export objects with related configs
export const VERTEX_AI_PROMPTS = { ... };
export const TIMEOUT_CONFIG = { ... };
```
