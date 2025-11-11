# AI FaceSwap Cloudflare Backend

A Cloudflare Worker backend API for mobile AI FaceSwap applications. This backend handles FaceSwap API calls and Google Cloud Vision Safe Search validation.

## Features

- ✅ FaceSwap API integration via RapidAPI
- ✅ Google Cloud Vision Safe Search detection
- ✅ CORS support for mobile apps
- ✅ Error handling and validation
- ✅ Content moderation (blocks unsafe content)

## Architecture

```
Mobile App → Cloudflare Worker → RapidAPI FaceSwap → Google Cloud Vision → Response
```

## Prerequisites

1. **Cloudflare Account** - Sign up at [cloudflare.com](https://cloudflare.com)
2. **RapidAPI Key** - Get your key from RapidAPI (already provided in your example)
3. **Google Cloud Vision API Key** - Enable Cloud Vision API and get an API key from [Google Cloud Console](https://console.cloud.google.com)

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

**ALL configuration must be set via environment variables - no hardcoded defaults!**

**For local development:** Create a `.dev.vars` file with all required variables:

```bash
# .dev.vars (ALL REQUIRED - no defaults)
RAPIDAPI_KEY=a6c4db0ee6msh0dc524a0797828dp1a04bcjsnc80ab176f0ef
RAPIDAPI_HOST=ai-face-swap2.p.rapidapi.com
RAPIDAPI_ENDPOINT=https://ai-face-swap2.p.rapidapi.com/public/process/urls
GOOGLE_CLOUD_API_KEY=your_google_cloud_vision_api_key_here
GOOGLE_VISION_ENDPOINT=https://vision.googleapis.com/v1/images:annotate
```

**For production:** Set secrets using Wrangler CLI (see Deployment section below).

### 3. Get Google Cloud Vision API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select an existing one
3. Enable the **Cloud Vision API**
4. Go to **APIs & Services** → **Credentials**
5. Click **Create Credentials** → **API Key**
6. Copy the API key and use it in step 2

## Development

### Run Locally

```bash
npm run dev
```

This will start a local development server. The worker will be available at `http://localhost:8787`

**Note:** Make sure your `.dev.vars` file is configured with all required variables (see Setup Instructions above).

### Test the API

**Using curl:**
```bash
curl --location 'http://localhost:8787/faceswap' \
--header 'Content-Type: application/json' \
--data '{
    "target_url": "https://temp.live3d.io/aifaceswap/static_img/template-2-aafa80bf126595068e90d04e4eb76969.webp",
    "source_url": "https://raw.githubusercontent.com/chungminhtu/anh/refs/heads/gh-pages/IMG_2852_1.jpeg"
}'
```

**Using Postman/Insomnia:**
- **URL:** `http://localhost:8787/faceswap`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`
- **Body (JSON):**
```json
{
    "target_url": "https://temp.live3d.io/aifaceswap/static_img/template-2-aafa80bf126595068e90d04e4eb76969.webp",
    "source_url": "https://raw.githubusercontent.com/chungminhtu/anh/refs/heads/gh-pages/IMG_2852_1.jpeg"
}
```

**Expected Response (Success):**
```json
{
    "ResultImageUrl": "https://...",
    "Success": true,
    "Message": "Successful",
    "StatusCode": 200
}
```

## Deployment

### Set Secrets in Cloudflare

**Option A: Bulk Upload (Recommended)**
```bash
# 1. Edit secrets.json with your actual Google Cloud API key
# 2. Login to Cloudflare
npx wrangler login

# 3. Upload all secrets at once
npx wrangler secret bulk secrets.json
```

**Option B: Set One by One**
```bash
npx wrangler login
npx wrangler secret put RAPIDAPI_KEY
npx wrangler secret put RAPIDAPI_HOST
npx wrangler secret put RAPIDAPI_ENDPOINT
npx wrangler secret put GOOGLE_CLOUD_API_KEY
npx wrangler secret put GOOGLE_VISION_ENDPOINT
```

### Deploy to Cloudflare

```bash
npm run deploy
```

After deployment, you'll get a URL like: `https://ai-faceswap-backend.your-subdomain.workers.dev`

### Test Deployed API

```bash
curl --location 'https://ai-faceswap-backend.your-subdomain.workers.dev/faceswap' \
--header 'Content-Type: application/json' \
--data '{
    "target_url": "https://temp.live3d.io/aifaceswap/static_img/template-2-aafa80bf126595068e90d04e4eb76969.webp",
    "source_url": "https://raw.githubusercontent.com/chungminhtu/anh/refs/heads/gh-pages/IMG_2852_1.jpeg"
}'
```


## API Endpoint

### POST `/faceswap`

**Request Body:**
```json
{
    "target_url": "https://example.com/target.jpg",
    "source_url": "https://example.com/source.jpg"
}
```

**Success Response (200):**
```json
{
    "ResultImageUrl": "https://cdn.morfran.com/container/faceswap/swap_2025_11_10_13_38_56_5082846.jpg",
    "FaceSwapCount": 1,
    "Success": true,
    "Message": "Successful",
    "StatusCode": 200,
    "ProcessingTime": "14.272 seconds.",
    "ProcessingTimeSpan": "00:00:14.2719357",
    "ProcessStartedDateTime": "2025-11-10T13:38:42.6412702Z"
}
```

**Error Response (403 - Unsafe Content):**
```json
{
    "Success": false,
    "Message": "Content blocked: Image contains unsafe content (adult, violence, or racy content detected)",
    "StatusCode": 403,
    "ResultImageUrl": "https://..."
}
```

**Error Response (400 - Bad Request):**
```json
{
    "Success": false,
    "Message": "Missing required fields: target_url and source_url",
    "StatusCode": 400
}
```

## Mobile App Integration

### Example (React Native / Expo)

```javascript
const faceSwap = async (targetUrl, sourceUrl) => {
  try {
    const response = await fetch('https://your-worker.workers.dev/faceswap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_url: targetUrl,
        source_url: sourceUrl,
      }),
    });

    const data = await response.json();
    
    if (data.Success) {
      console.log('FaceSwap successful:', data.ResultImageUrl);
      return data.ResultImageUrl;
    } else {
      console.error('FaceSwap failed:', data.Message);
      throw new Error(data.Message);
    }
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
};
```

## Content Moderation

The backend automatically checks all FaceSwap results using Google Cloud Vision Safe Search API. Images are blocked if they contain:
- **Adult content** (LIKELY or VERY_LIKELY)
- **Violence** (LIKELY or VERY_LIKELY)
- **Racy content** (LIKELY or VERY_LIKELY)

## Troubleshooting

### Error: "RAPIDAPI_KEY not set"
- Make sure you've set the secret using `wrangler secret put RAPIDAPI_KEY` (for production)
- For local dev, check your `.dev.vars` file has all required variables

### Error: "GOOGLE_CLOUD_API_KEY not set"
- Make sure you've set the secret using `wrangler secret put GOOGLE_CLOUD_API_KEY`
- Verify your Google Cloud Vision API is enabled

### Error: "Google Vision API error: 403"
- Check that Cloud Vision API is enabled in your Google Cloud project
- Verify your API key has the correct permissions
- Check API key restrictions in Google Cloud Console

### CORS Issues
- The worker includes CORS headers for all origins (`*`)
- If you need to restrict origins, modify the `Access-Control-Allow-Origin` header in `src/index.ts`

## License

MIT

