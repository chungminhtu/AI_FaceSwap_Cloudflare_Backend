# CORS Configuration Guide

## Overview

The backend supports CORS (Cross-Origin Resource Sharing) for web frontends and automatically allows mobile apps (Android/iOS) which don't have CORS restrictions.

## Configuration

### Environment Variable: `ALLOWED_ORIGINS`

Set this in your Cloudflare Worker environment variables (wrangler.toml or dashboard):

```toml
# wrangler.toml
[vars]
ALLOWED_ORIGINS = "https://yourdomain.com,https://www.yourdomain.com,https://app.yourdomain.com"
```

Or in Cloudflare Dashboard:
- Workers & Pages → Your Worker → Settings → Variables
- Add `ALLOWED_ORIGINS` with comma-separated origins

### Examples

**Development (allow all):**
```toml
ALLOWED_ORIGINS = "*"
```

**Production (specific domains):**
```toml
ALLOWED_ORIGINS = "https://app.shotpix.app,https://www.shotpix.app"
```

**Multiple environments:**
```toml
ALLOWED_ORIGINS = "https://app.shotpix.app,https://staging.shotpix.app,http://localhost:3000,http://localhost:5173"
```

## How It Works

### Web Frontend (Browser)
- Browser sends `Origin` header with each request
- Backend validates `Origin` against `ALLOWED_ORIGINS`
- If match found → returns that specific origin
- If no match → returns first allowed origin (or `*` if configured)
- If `ALLOWED_ORIGINS` not set → defaults to `*` (allows all)

### Mobile Apps (Android/iOS)
- Mobile apps don't send `Origin` header
- Backend detects mobile app by:
  - Missing `Origin` header, OR
  - User-Agent contains: `okhttp`, `Android`, `Dart` (Flutter)
- Automatically returns `*` (allows all) for mobile apps
- **No configuration needed for mobile apps**

## Testing CORS from Frontend

### 1. Browser Console Test

Open browser console on your frontend and run:

```javascript
// Test OPTIONS preflight
fetch('https://api.d.shotpix.app/faceswap', {
  method: 'OPTIONS',
  headers: {
    'Origin': 'https://yourdomain.com'
  }
})
.then(r => {
  console.log('CORS Headers:', {
    'Access-Control-Allow-Origin': r.headers.get('Access-Control-Allow-Origin'),
    'Access-Control-Allow-Methods': r.headers.get('Access-Control-Allow-Methods'),
    'Access-Control-Allow-Headers': r.headers.get('Access-Control-Allow-Headers')
  });
});

// Test actual request
fetch('https://api.d.shotpix.app/presets', {
  method: 'GET',
  headers: {
    'Origin': 'https://yourdomain.com'
  }
})
.then(r => r.json())
.then(data => console.log('Success:', data))
.catch(err => console.error('CORS Error:', err));
```

### 2. Check Network Tab

1. Open browser DevTools → Network tab
2. Make a request from your frontend
3. Check the response headers:
   - `Access-Control-Allow-Origin` should match your frontend origin
   - `Access-Control-Allow-Credentials: true` should be present

### 3. Common CORS Errors

**Error: "No 'Access-Control-Allow-Origin' header"**
- Your origin is not in `ALLOWED_ORIGINS`
- Solution: Add your frontend URL to `ALLOWED_ORIGINS`

**Error: "Credentials flag is true, but 'Access-Control-Allow-Origin' is '*'"**
- Can't use `*` with credentials
- Solution: Use specific origin in `ALLOWED_ORIGINS` (not `*`)

**Error: "Preflight request doesn't pass"**
- OPTIONS request failing
- Solution: Check that `ALLOWED_ORIGINS` includes your origin

## Android App Configuration

### No CORS Needed

Android apps use HTTP clients (OkHttp, Retrofit, etc.) which don't enforce CORS:
- ✅ No `Origin` header sent
- ✅ No CORS preflight (OPTIONS) needed
- ✅ Direct API calls work immediately

### Example Android Code

```kotlin
// OkHttp - works without CORS configuration
val client = OkHttpClient()
val request = Request.Builder()
    .url("https://api.d.shotpix.app/faceswap")
    .post(requestBody)
    .build()
val response = client.newCall(request).execute()
```

```dart
// Flutter/Dart - works without CORS configuration
final response = await http.post(
  Uri.parse('https://api.d.shotpix.app/faceswap'),
  headers: {'Content-Type': 'application/json'},
  body: jsonEncode(requestData),
);
```

### Backend Detection

The backend automatically detects mobile apps and allows all origins:
- Detects missing `Origin` header
- Detects mobile User-Agent patterns
- Returns `Access-Control-Allow-Origin: *` for mobile

## Testing Checklist

### Frontend Testing
- [ ] Set `ALLOWED_ORIGINS` with your frontend URL
- [ ] Test from browser console
- [ ] Check Network tab for CORS headers
- [ ] Test with credentials (cookies/auth headers)
- [ ] Test OPTIONS preflight request

### Mobile Testing
- [ ] No configuration needed
- [ ] Test API call from Android app
- [ ] Verify response received
- [ ] Check logs for mobile User-Agent detection

## Security Notes

1. **Production**: Use specific origins, not `*`
   ```toml
   ALLOWED_ORIGINS = "https://app.shotpix.app"
   ```

2. **Development**: Can use `*` for convenience
   ```toml
   ALLOWED_ORIGINS = "*"
   ```

3. **Multiple Domains**: Comma-separated list
   ```toml
   ALLOWED_ORIGINS = "https://app.shotpix.app,https://admin.shotpix.app"
   ```

4. **Mobile Apps**: Always allowed (no CORS restrictions)

## Troubleshooting

### Issue: Frontend can't make requests

1. Check `ALLOWED_ORIGINS` includes your frontend URL
2. Verify exact URL match (including `http://` vs `https://`, trailing slashes)
3. Check browser console for CORS error details
4. Verify OPTIONS preflight succeeds (Network tab)

### Issue: Mobile app works but frontend doesn't

- This is expected if `ALLOWED_ORIGINS` doesn't include frontend URL
- Mobile apps bypass CORS, web browsers enforce it
- Add frontend URL to `ALLOWED_ORIGINS`

### Issue: Credentials not working

- Can't use `*` with credentials
- Use specific origin: `ALLOWED_ORIGINS = "https://yourdomain.com"`

