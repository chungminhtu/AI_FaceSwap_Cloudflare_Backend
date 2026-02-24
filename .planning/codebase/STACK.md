# Technology Stack

**Analysis Date:** 2026-02-24

## Languages

**Primary:**
- TypeScript 5.3.3 - Backend Workers, shared configuration, utilities, type definitions
- JavaScript (Node.js) - Deployment and utility scripts

**HTML/CSS/JavaScript:**
- HTML5 - Frontend UI (Cloudflare Pages)
- JavaScript - Frontend interactivity and API testing pages

## Runtime

**Environment:**
- Cloudflare Workers - Primary backend runtime (serverless compute)
- Cloudflare Pages - Frontend hosting
- Node.js - Local development and deployment tooling

**Package Manager:**
- pnpm - Primary package manager (indicated by `.pnpm` directory structure in node_modules)
- Lockfile: `.pnpm-lock.yaml` expected (structure present)

## Frameworks

**Core Backend:**
- Cloudflare Workers - Serverless compute platform
- Express.js 4.18.2 - HTTP framework for API routing (used in Workers context)

**Frontend:**
- Static HTML/JavaScript - No frontend framework detected, pure HTML with vanilla JavaScript

**Development/Build:**
- Wrangler 4.54.0 - Cloudflare Workers CLI and bundler
- TypeScript 5.3.3 - Type safety and compilation

## Key Dependencies

**Critical:**
- @cloudflare/workers-types 4.20241106.0 - TypeScript types for Cloudflare Worker APIs
- wrangler 4.54.0 - Worker development and deployment
- @cf-wasm/photon 0.3.4 - Image processing library (WebAssembly)
- sharp - Image processing and manipulation
- jszip 3.10.1 - ZIP file creation and manipulation
- nanoid 5.0.0 - Unique ID generation (21-character IDs)

**Infrastructure:**
- undici - HTTP client for Workers
- miniflare - Local Cloudflare Workers emulator
- esbuild - Bundler for Workers
- workerd - Cloudflare Workers runtime

## Configuration

**Environment:**
- Deployment configuration via `deploy.js` script with multiple environment support:
  - `ai-office` (production)
  - `ai-office-dev` (development)
  - `ai-office-prod` (production variant)
- Environment variables loaded from deployment secrets configuration
- `DEPLOY_ENV` environment variable determines target deployment

**Build:**
- TypeScript compilation to Workers-compatible JavaScript
- No explicit build config file (wrangler handles compilation)
- Bundling managed by Wrangler and esbuild

**Key Configuration Files:**
- `tsconfig.json` - TypeScript compiler options (target: ES2021, module: ES2022)
- `backend-cloudflare-workers/config.ts` - API configurations, model settings, safety thresholds, timeout settings
- `backend-cloudflare-workers/types.ts` - TypeScript interface definitions for environment and requests

## Database

**Primary:**
- Cloudflare D1 - SQLite-based serverless database
  - Binding name: configured via `D1_DATABASE_BINDING` environment variable
  - Migrations directory: `backend-cloudflare-workers/migrations/`
  - Schema: `backend-cloudflare-workers/schema.sql` (tables: profiles, presets, selfies, results)

## Storage

**File Storage:**
- Cloudflare R2 - Object storage for images
  - Binding name: `R2_BUCKET_BINDING` or `R2_BUCKET_NAME` environment variables
  - Stores: preset images, selfie images, result images, thumbnails
  - Paths: `preset/`, `selfie/`, `remove_bg/background/`, `preset_thumb/`

**Caching:**
- Cloudflare KV - Key-value store for caching
  - Dynamic namespaces with configurable bindings
  - Used for: OAuth token caching, prompt generation caching
  - Cache TTL: 55 minutes for tokens, 1 year for prompts

## Platform Requirements

**Development:**
- Node.js (version not specified, but modern LTS compatible)
- pnpm package manager
- Git for version control
- Cloudflare account with API token and account ID

**Production:**
- Cloudflare account with:
  - Workers enabled
  - R2 bucket provisioned
  - D1 database provisioned
  - KV namespaces created
  - API token with appropriate permissions
- GCP project (for Vertex AI and Google Vision APIs)
- Valid SSL/TLS certificates (managed by Cloudflare)

## Deployment

**CI/CD:**
- Custom deployment script: `_deploy-cli-cloudflare-gcp/deploy.js`
- Manual deployment via npm scripts: `deploy:ai-office`, `deploy:ai-office-dev`, `deploy:ai-office-prod`
- Database migrations: `npm run db:migrate`
- Pre-deployment checks and validation included

**Container/Packaging:**
- Wrangler handles Worker packaging and deployment
- No Docker configuration detected
- ZIP-based deployment to Cloudflare Workers

---

*Stack analysis: 2026-02-24*
