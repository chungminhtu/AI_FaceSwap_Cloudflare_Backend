# How to Check if Google Safety API is Working

## ✅ What Changed

Now **every face swap API response includes safety check information** so you can verify:
1. ✅ That the Google Safety API was called
2. ✅ What the safety check results were
3. ✅ Whether the image passed or failed

## 📋 Response Format

When you call the face swap API (`POST /faceswap`), the response now includes a `SafetyCheck` field:

```json
{
  "Success": true,
  "ResultImageUrl": "https://...",
  "Message": "Face swap completed",
  "SafetyCheck": {
    "checked": true,
    "isSafe": true,
    "details": {
      "adult": "VERY_UNLIKELY",
      "violence": "UNLIKELY",
      "racy": "VERY_UNLIKELY"
    }
  }
}
```

### Safety Check Response Fields:

- **`checked`**: `true` if safety check was performed, `false` if disabled
- **`isSafe`**: `true` if image passed, `false` if blocked
- **`details`**: Object with safety ratings:
  - `adult`: "VERY_UNLIKELY" | "UNLIKELY" | "POSSIBLE" | "LIKELY" | "VERY_LIKELY"
  - `violence`: Same values
  - `racy`: Same values
- **`error`**: Error message if safety check failed (optional)

## 🔍 How to Check

### Method 1: Check API Response (Easiest)

1. **Make a face swap request:**
   ```bash
   curl -X POST https://ai-faceswap-backend.chungminhtu03.workers.dev/faceswap \
     -H "Content-Type: application/json" \
     -d '{
       "target_url": "https://example.com/target.jpg",
       "source_url": "https://example.com/source.jpg"
     }'
   ```

2. **Look for `SafetyCheck` in the response:**
   - If `checked: true` → Safety API was called ✅
   - If `checked: false` → Safety check is disabled
   - Check `details` to see the actual safety ratings

### Method 2: Check Cloudflare Workers Logs

1. **Go to Cloudflare Dashboard:**
   - https://dash.cloudflare.com
   - Navigate to **Workers & Pages** → **ai-faceswap-backend**

2. **View Real-time Logs:**
   - Click on your worker
   - Go to **Logs** tab
   - Look for log entries with `[SafeSearch]` or `[FaceSwap]` prefix

3. **What to Look For:**
   ```
   [SafeSearch] Calling Google Vision API: {...}
   [SafeSearch] API Response status: 200 OK
   [SafeSearch] API Response data: {...}
   [SafeSearch] Safety check result: {...}
   [FaceSwap] Safe search validation passed: {...}
   ```

### Method 3: Test Safety API Directly

Use the test endpoint to check safety API without doing a face swap:

```bash
curl -X POST https://ai-faceswap-backend.chungminhtu03.workers.dev/test-safety \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://example.com/test-image.jpg"
  }'
```

**Response:**
```json
{
  "success": true,
  "imageUrl": "https://example.com/test-image.jpg",
  "result": {
    "isSafe": true,
    "details": {
      "adult": "VERY_UNLIKELY",
      "violence": "UNLIKELY",
      "racy": "VERY_UNLIKELY"
    }
  },
  "timestamp": "2025-11-17T..."
}
```

## 🚨 Safety Check Statuses

### ✅ Image is Safe:
```json
{
  "SafetyCheck": {
    "checked": true,
    "isSafe": true,
    "details": {
      "adult": "VERY_UNLIKELY",
      "violence": "UNLIKELY",
      "racy": "VERY_UNLIKELY"
    }
  }
}
```

### ❌ Image is Blocked:
```json
{
  "Success": false,
  "Message": "Content blocked: Image contains unsafe content",
  "StatusCode": 403,
  "SafetyCheck": {
    "checked": true,
    "isSafe": false,
    "details": {
      "adult": "LIKELY",
      "violence": "VERY_UNLIKELY",
      "racy": "POSSIBLE"
    }
  }
}
```

### ⚠️ Safety Check Error:
```json
{
  "Success": false,
  "Message": "Safe search validation failed: ...",
  "StatusCode": 500,
  "SafetyCheck": {
    "checked": true,
    "isSafe": false,
    "error": "API error: 400 - Invalid API key"
  }
}
```

### 🔕 Safety Check Disabled:
```json
{
  "SafetyCheck": {
    "checked": false,
    "isSafe": true,
    "error": "Safety check disabled via DISABLE_SAFE_SEARCH"
  }
}
```

## 📊 Safety Rating Levels

Google Vision API returns these levels for each category:

- **`VERY_UNLIKELY`** - Content is very unlikely to be unsafe ✅
- **`UNLIKELY`** - Content is unlikely to be unsafe ✅
- **`POSSIBLE`** - Content might be unsafe ⚠️
- **`LIKELY`** - Content is likely unsafe ❌ (BLOCKED)
- **`VERY_LIKELY`** - Content is very likely unsafe ❌ (BLOCKED)

**Blocking Rules:**
- Image is blocked if ANY category is `LIKELY` or `VERY_LIKELY`
- Image passes if all categories are `POSSIBLE` or lower

## 🔧 Troubleshooting

### If `SafetyCheck` is missing:
- Check if `DISABLE_SAFE_SEARCH=true` is set in secrets
- Check Cloudflare Workers logs for errors

### If `checked: false`:
- Safety check is disabled via `DISABLE_SAFE_SEARCH` environment variable
- To enable: Remove or set `DISABLE_SAFE_SEARCH=false`

### If `error` is present:
- Check `GOOGLE_VISION_API_KEY` is set correctly
- Verify API key has Vision API permissions
- Check Google Cloud Console for API quota/limits

## 📝 Example: Full API Response

```json
{
  "Success": true,
  "ResultImageUrl": "https://ai-faceswap-backend.chungminhtu03.workers.dev/r2/results/result_123.jpg",
  "Message": "Face swap completed",
  "StatusCode": 200,
  "ProcessingTime": "3.5",
  "SafetyCheck": {
    "checked": true,
    "isSafe": true,
    "details": {
      "adult": "VERY_UNLIKELY",
      "violence": "VERY_UNLIKELY",
      "racy": "VERY_UNLIKELY"
    }
  }
}
```

## ✅ Summary

**To verify Google Safety API is working:**
1. ✅ Make a face swap request
2. ✅ Check response for `SafetyCheck` field
3. ✅ Verify `checked: true` (means API was called)
4. ✅ Check `details` to see safety ratings
5. ✅ Check Cloudflare logs for `[SafeSearch]` entries

**The safety check happens automatically after every face swap!** 🛡️

