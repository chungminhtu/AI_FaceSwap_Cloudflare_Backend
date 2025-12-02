# How to Get a Fixed URL for Cloudflare Pages

## The Problem

Cloudflare Pages assigns a **unique URL with a hash** for each deployment. For example:
- Deployment 1: `https://6090bf6c.ai-faceswap-frontend.pages.dev`
- Deployment 2: `https://fc4e2d0a.ai-faceswap-frontend.pages.dev`
- Deployment 3: `https://be972678.ai-faceswap-frontend.pages.dev`

**Each deployment gets a different URL!** This makes it impossible to share a stable link.

## The Solution: Custom Domain

The **ONLY way** to get a fixed URL that never changes is to set up a **custom domain**.

## Step-by-Step Instructions

### Option 1: Using a Domain You Own

1. **Go to Cloudflare Dashboard**
   - Log in at https://dash.cloudflare.com
   - Navigate to **Workers & Pages**
   - Select your project: **ai-faceswap-frontend**

2. **Set Up Custom Domain**
   - Click on the **Custom domains** tab
   - Click **Set up a custom domain**
   - Enter your domain (e.g., `faceswap.yourdomain.com` or `www.yourdomain.com`)
   - Click **Continue**

3. **Configure DNS**
   - **If your domain is managed by Cloudflare:**
     - DNS records will be added automatically
     - Just click **Activate domain**
   
   - **If your domain is managed elsewhere:**
     - Cloudflare will show you a CNAME record to add
     - Go to your domain registrar's DNS settings
     - Add a CNAME record:
       - **Name:** `faceswap` (or `www`, or `@` for root domain)
       - **Target:** `ai-faceswap-frontend.pages.dev`
       - **TTL:** Auto or 3600
     - Wait for DNS propagation (can take up to 24 hours, usually 5-10 minutes)
     - Return to Cloudflare Dashboard and click **Activate domain**

4. **Verify**
   - Once active, your custom domain will work!
   - Example: `https://faceswap.yourdomain.com`
   - **This URL will NEVER change**, even after new deployments!

### Option 2: Using a Free Subdomain Service

If you don't have a domain, you can use free subdomain services:

1. **Freenom** (free domains like `.tk`, `.ml`, `.ga`)
   - Sign up at https://www.freenom.com
   - Get a free domain
   - Point it to Cloudflare (follow Option 1 steps)

2. **No-IP** (free dynamic DNS)
   - Sign up at https://www.noip.com
   - Get a free subdomain like `yourapp.ddns.net`
   - Configure it with Cloudflare

3. **Cloudflare Registrar** (if you want to buy a domain)
   - Buy a domain directly from Cloudflare
   - It will be automatically configured
   - Very affordable (often $8-10/year)

## Redirect Default URL to Custom Domain (Optional)

To ensure users always use your custom domain:

1. In Cloudflare Dashboard → Your Pages Project
2. Go to **Bulk Redirects** section
3. Create a redirect rule:
   - **Source URL:** `*.pages.dev` (or specific pattern)
   - **Target URL:** `https://your-custom-domain.com`
   - **Status:** `301` (Permanent Redirect)
   - Enable: Preserve query string, Subpath matching

## Important Notes

- ✅ **Custom domain = Fixed URL forever**
- ✅ **Works with all future deployments**
- ✅ **Free to set up** (just need a domain)
- ✅ **SSL certificate is automatic** (Cloudflare provides free SSL)
- ⚠️ **Without custom domain, URL changes every deployment**

## Quick Reference

- **Cloudflare Docs:** https://developers.cloudflare.com/pages/configuration/custom-domains/
- **Redirect Guide:** https://developers.cloudflare.com/pages/how-to/redirect-to-custom-domain/
- **Dashboard:** https://dash.cloudflare.com → Workers & Pages → Your Project

## Current Status

- ✅ **Worker (Backend) URL:** Fixed - never changes
- ⚠️ **Pages (Frontend) URL:** Changes with each deployment (needs custom domain)

---

**Bottom Line:** Set up a custom domain to get a fixed URL. It's the only way! 🚀

