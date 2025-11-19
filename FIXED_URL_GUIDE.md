# Fixed URL Guide for Cloudflare Pages

## Understanding Cloudflare URLs

### ✅ Your URLs Are Already Fixed!

**Cloudflare Pages URL:**
- Format: `https://ai-faceswap-frontend.<your-account-subdomain>.pages.dev`
- This URL **NEVER changes** between deployments
- Example: `https://ai-faceswap-frontend.chungminhtu03.pages.dev`

**Cloudflare Worker URL:**
- Format: `https://ai-faceswap-backend.<your-account-subdomain>.workers.dev`
- This URL **NEVER changes** between deployments
- Example: `https://ai-faceswap-backend.chungminhtu03.workers.dev`

## Option 1: Use the Default Fixed URLs (Recommended)

The URLs provided by Cloudflare are already fixed and stable. You can:
1. Find your Pages URL in Cloudflare Dashboard → Pages → Your Project
2. Find your Worker URL in Cloudflare Dashboard → Workers & Pages → Your Worker
3. Use these URLs directly - they won't change

## Option 2: Add a Custom Domain

If you want a custom domain (e.g., `faceswap.yourdomain.com`):

### Step 1: Add Domain in Cloudflare Dashboard

1. Go to **Cloudflare Dashboard** → **Pages** → **ai-faceswap-frontend**
2. Click **Custom domains** tab
3. Click **Set up a custom domain**
4. Enter your domain (e.g., `faceswap.yourdomain.com`)
5. Follow the DNS setup instructions

### Step 2: Configure DNS Records

Add these DNS records in your domain's DNS settings:

**For Pages (Frontend):**
- Type: `CNAME`
- Name: `faceswap` (or `www` for www.yourdomain.com)
- Target: `ai-faceswap-frontend.pages.dev`
- Proxy: Enabled (orange cloud)

**For Worker (Backend API):**
- Type: `CNAME`
- Name: `api` (or `backend`)
- Target: `ai-faceswap-backend.workers.dev`
- Proxy: Enabled (orange cloud)

### Step 3: Update Your Code

After setting up custom domains, update `public_page/index.html`:

```javascript
// Change from:
const WORKER_URL = 'https://ai-faceswap-backend.chungminhtu03.workers.dev';

// To:
const WORKER_URL = 'https://api.yourdomain.com';
```

## Option 3: Use Cloudflare Workers Custom Domain

For the Worker (API), you can also use a custom domain:

1. Go to **Workers & Pages** → **ai-faceswap-backend** → **Settings** → **Triggers**
2. Under **Routes**, click **Add route**
3. Enter your custom domain pattern (e.g., `api.yourdomain.com/*`)
4. Configure DNS as shown above

## Finding Your Current URLs

After deployment, run:
```bash
wrangler pages deployment list --project-name=ai-faceswap-frontend
wrangler deployments list
```

Or check the Cloudflare Dashboard:
- **Pages URL**: Dashboard → Pages → ai-faceswap-frontend → Overview
- **Worker URL**: Dashboard → Workers & Pages → ai-faceswap-backend → Overview

## Quick Reference

| Service | Default URL Format | Custom Domain |
|---------|-------------------|---------------|
| Pages (Frontend) | `*.pages.dev` | Add in Pages Dashboard |
| Worker (Backend) | `*.workers.dev` | Add in Worker Routes |

**Note**: Both default URLs are **already fixed** and won't change between deployments!






