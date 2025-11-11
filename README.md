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

Set your environment variables using Wrangler CLI:

```bash
# Set RapidAPI key
wrangler secret put RAPIDAPI_KEY
# When prompted, enter: a6c4db0ee6msh0dc524a0797828dp1a04bcjsnc80ab176f0ef

# Set Google Cloud Vision API key
wrangler secret put GOOGLE_CLOUD_API_KEY
# When prompted, enter your Google Cloud Vision API key

# Optional: Set Google Cloud Project ID (if using service account)
wrangler secret put GOOGLE_CLOUD_PROJECT_ID
```

**Note:** For local development, you can also create a `.dev.vars` file:

```bash
# .dev.vars
RAPIDAPI_KEY=a6c4db0ee6msh0dc524a0797828dp1a04bcjsnc80ab176f0ef
GOOGLE_CLOUD_API_KEY=your_google_cloud_api_key_here
GOOGLE_CLOUD_PROJECT_ID=your_project_id_here
```

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

### Test the API

```bash
curl --location 'http://localhost:8787/faceswap' \
--header 'Content-Type: application/json' \
--data '{
    "TargetImageUrl": "https://raw.githubusercontent.com/anh/refs/heads/gh-pages/20251107_094328.jpg",
    "SourceImageUrl": "https://raw.githubusercontent.com/anh/refs/heads/gh-pages/MT_Face.jpg"
}'
```

## Deployment

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
    "TargetImageUrl": "https://raw.githubusercontent.com/anh/refs/heads/gh-pages/20251107_094328.jpg",
    "SourceImageUrl": "https://raw.githubusercontent.com/anh/refs/heads/gh-pages/MT_Face.jpg"
}'
```

## API Endpoint

### POST `/faceswap`

**Request Body:**
```json
{
    "TargetImageUrl": "https://example.com/target.jpg",
    "SourceImageUrl": "https://example.com/source.jpg"
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
    "Message": "Missing required fields: TargetImageUrl and SourceImageUrl",
    "StatusCode": 400
}
```

## Mobile App Integration

### Example (React Native / Expo)

```javascript
const faceSwap = async (targetImageUrl, sourceImageUrl) => {
  try {
    const response = await fetch('https://your-worker.workers.dev/faceswap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        TargetImageUrl: targetImageUrl,
        SourceImageUrl: sourceImageUrl,
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
- Make sure you've set the secret using `wrangler secret put RAPIDAPI_KEY`
- For local dev, check your `.dev.vars` file

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

