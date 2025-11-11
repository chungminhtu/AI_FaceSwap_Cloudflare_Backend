# How to Safely Set Environment Variables in Cloudflare Workers

## 🔐 For Sensitive Data (API Keys, Secrets)

**Use `wrangler secret put`** - This encrypts and stores secrets securely.

### Set Secrets One by One:

```bash
# Set RapidAPI key
npx wrangler secret put RAPIDAPI_KEY
# When prompted, paste your key and press Enter

# Set RapidAPI host
npx wrangler secret put RAPIDAPI_HOST
# Enter: ai-face-swap2.p.rapidapi.com

# Set RapidAPI endpoint
npx wrangler secret put RAPIDAPI_ENDPOINT
# Enter: https://ai-face-swap2.p.rapidapi.com/public/process/urls

# Set Google Cloud Vision API key
npx wrangler secret put GOOGLE_CLOUD_API_KEY
# Enter your Google Cloud Vision API key

# Set Google Vision endpoint
npx wrangler secret put GOOGLE_VISION_ENDPOINT
# Enter: https://vision.googleapis.com/v1/images:annotate
```

### Bulk Upload Secrets (Recommended):

**Step 1:** Edit `secrets.json` file and fill in your actual values:
```json
{
  "RAPIDAPI_KEY": "a6c4db0ee6msh0dc524a0797828dp1a04bcjsnc80ab176f0ef",
  "RAPIDAPI_HOST": "ai-face-swap2.p.rapidapi.com",
  "RAPIDAPI_ENDPOINT": "https://ai-face-swap2.p.rapidapi.com/public/process/urls",
  "GOOGLE_CLOUD_API_KEY": "your_google_cloud_vision_api_key_here",
  "GOOGLE_VISION_ENDPOINT": "https://vision.googleapis.com/v1/images:annotate"
}
```

**Step 2:** Upload all secrets at once:
```bash
npx wrangler secret bulk secrets.json
```

**Note:** `secrets.json` is already in `.gitignore` - it won't be committed to git.

### List All Secrets:

```bash
npx wrangler secret list
```

### Delete a Secret:

```bash
npx wrangler secret delete SECRET_NAME
```

## 📝 For Local Development

**Use `.env` file** (already created in your project):

```bash
# .env file
RAPIDAPI_KEY=a6c4db0ee6msh0dc524a0797828dp1a04bcjsnc80ab176f0ef
RAPIDAPI_HOST=ai-face-swap2.p.rapidapi.com
RAPIDAPI_ENDPOINT=https://ai-face-swap2.p.rapidapi.com/public/process/urls
GOOGLE_CLOUD_API_KEY=your_google_key_here
GOOGLE_VISION_ENDPOINT=https://vision.googleapis.com/v1/images:annotate
```

**Note:** `.env` is already in `.gitignore` - it won't be committed to git.

## 🚀 Quick Setup Commands

### Production Deployment (Set all secrets):

```bash
# Make sure you're logged in first
npx wrangler login

# Set all required secrets
npx wrangler secret put RAPIDAPI_KEY
npx wrangler secret put RAPIDAPI_HOST
npx wrangler secret put RAPIDAPI_ENDPOINT
npx wrangler secret put GOOGLE_CLOUD_API_KEY
npx wrangler secret put GOOGLE_VISION_ENDPOINT

# Deploy
npm run deploy
```

### Local Development:

```bash
# 1. Fill in your .env file with actual values
# 2. Run dev server
npm run dev
```

## ✅ Security Best Practices

1. **Never commit secrets to git** - `.env` is in `.gitignore` ✅
2. **Use `wrangler secret put` for production** - Encrypted storage ✅
3. **Don't hardcode secrets in code** - All in env variables ✅
4. **Use different secrets for dev/staging/prod** - Use `--env` flag

## 📚 Official Documentation

- [Cloudflare Workers Environment Variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Wrangler Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

