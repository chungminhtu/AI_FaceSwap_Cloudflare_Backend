# Google Safety Vision API Configuration Guide

## Overview

The Google Safety Vision API checks images for unsafe content (adult, violence, racy). You can configure how strict the safety detection is.

## Configuration Options

### 1. `SAFETY_STRICTNESS` Environment Variable

Controls how strict the safety detection is. Set this in your Cloudflare Workers environment variables.

**Options:**
- **`lenient`** (default) - Only blocks `VERY_LIKELY` unsafe content
- **`strict`** - Blocks both `LIKELY` and `VERY_LIKELY` unsafe content

**Default Behavior:**
- If not set, defaults to `lenient` mode (less strict)
- Only blocks content when Google detects `VERY_LIKELY` unsafe content

### 2. `DISABLE_SAFE_SEARCH` Environment Variable

Completely disables safety checks.

**Options:**
- **`true`** - Disables all safety checks
- **`false`** or not set - Enables safety checks

## How to Configure

### In Cloudflare Workers Dashboard:

1. Go to **Workers & Pages** → Your Worker
2. Click **Settings** → **Variables and Secrets**
3. Add or edit environment variables:

   **For lenient mode (default - less strict):**
   ```
   SAFETY_STRICTNESS = lenient
   ```
   Or simply don't set it (lenient is the default)

   **For strict mode (more strict):**
   ```
   SAFETY_STRICTNESS = strict
   ```

   **To disable safety checks entirely:**
   ```
   DISABLE_SAFE_SEARCH = true
   ```

### Using Wrangler CLI:

Add to your `wrangler.toml` or set as secret:

```bash
# For lenient mode (default)
wrangler secret put SAFETY_STRICTNESS
# Enter: lenient

# For strict mode
wrangler secret put SAFETY_STRICTNESS
# Enter: strict

# To disable
wrangler secret put DISABLE_SAFE_SEARCH
# Enter: true
```

## Safety Levels Explained

Google Vision API returns these levels for each category (adult, violence, racy):

| Level | Meaning | Blocked in Lenient? | Blocked in Strict? |
|-------|---------|---------------------|-------------------|
| `VERY_UNLIKELY` | Very unlikely to be unsafe | ❌ No | ❌ No |
| `UNLIKELY` | Unlikely to be unsafe | ❌ No | ❌ No |
| `POSSIBLE` | Might be unsafe | ❌ No | ❌ No |
| `LIKELY` | Likely unsafe | ❌ No | ✅ **Yes** |
| `VERY_LIKELY` | Very likely unsafe | ✅ **Yes** | ✅ **Yes** |

## Examples

### Example 1: Lenient Mode (Default)

**Configuration:**
```
SAFETY_STRICTNESS = lenient
```

**Result:**
- Image with `adult: LIKELY` → ✅ **Allowed** (not blocked)
- Image with `adult: VERY_LIKELY` → ❌ **Blocked**
- Image with `racy: POSSIBLE` → ✅ **Allowed**

### Example 2: Strict Mode

**Configuration:**
```
SAFETY_STRICTNESS = strict
```

**Result:**
- Image with `adult: LIKELY` → ❌ **Blocked**
- Image with `adult: VERY_LIKELY` → ❌ **Blocked**
- Image with `racy: POSSIBLE` → ✅ **Allowed**

### Example 3: Disabled

**Configuration:**
```
DISABLE_SAFE_SEARCH = true
```

**Result:**
- All images pass regardless of safety level
- No safety check is performed

## Current Configuration

To check your current configuration, look at the API response. The `SafetyCheck` field will show:
- `checked: true/false` - Whether safety check was performed
- `details` - The actual safety ratings from Google
- The blocking behavior depends on your `SAFETY_STRICTNESS` setting

## Recommendation

**For most use cases, use `lenient` mode (default):**
- Less false positives
- Only blocks clearly unsafe content (`VERY_LIKELY`)
- Allows borderline content (`LIKELY`, `POSSIBLE`) that might be acceptable

**Use `strict` mode if:**
- You need maximum content filtering
- You want to block any potentially unsafe content
- You're okay with more false positives

## Summary

**To reduce sensitive content detection (make it less strict):**

1. **Set `SAFETY_STRICTNESS = lenient`** (or leave it unset - this is the default)
   - Only blocks `VERY_LIKELY` unsafe content
   - Allows `LIKELY`, `POSSIBLE`, `UNLIKELY`, `VERY_UNLIKELY`

2. **Or disable entirely:** Set `DISABLE_SAFE_SEARCH = true`
   - No safety checks at all

**Configuration location:**
- Cloudflare Workers Dashboard → Your Worker → Settings → Variables and Secrets
- Or via Wrangler CLI: `wrangler secret put SAFETY_STRICTNESS`

## 📚 Official Documentation

For detailed information about Google Vision API SafeSearch detection, refer to the official documentation:

- **Detect explicit content (SafeSearch):** https://cloud.google.com/vision/docs/detecting-safe-search
- **Cloud Vision API Documentation:** https://cloud.google.com/vision/docs
- **API Reference:** https://cloud.google.com/vision/docs/reference/rest

See `docs/GOOGLE_VISION_API_DOCUMENTATION.md` for complete documentation links and verification.

