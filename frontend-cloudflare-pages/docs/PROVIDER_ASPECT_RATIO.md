# Provider-Specific Aspect Ratio Handling

## Overview

The backend supports two image generation providers: **Vertex AI** and **WaveSpeed**. Each provider has different capabilities and constraints for image dimensions and aspect ratios.

---

## Vertex AI (Google)

### Behavior
- **Uses standard aspect ratios only**
- Input image dimensions are mapped to the closest supported ratio
- Original aspect ratio may not be preserved exactly

### Supported Ratios
```
1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
```

### Flow
```
Input Image (1240x2772, ratio 0.447)
    ↓
resolveAspectRatio() → finds closest standard ratio
    ↓
"9:16" (ratio 0.5625) ← closest match
    ↓
Vertex AI generates image with 9:16 aspect ratio
```

### When to Use
- When standard aspect ratios are acceptable
- For consistent social media formats (9:16 for stories, 1:1 for posts, etc.)

---

## WaveSpeed

### Behavior
- **Preserves exact original aspect ratio**
- Supports custom dimensions: 256-1536 pixels per dimension
- Scales proportionally to fit within limits

### Dimension Constraints
| Constraint | Value |
|------------|-------|
| Minimum | 256px per dimension |
| Maximum | 1536px per dimension |

### Flow
```
Input Image (1240x2772, ratio 0.447)
    ↓
getImageDimensionsExtended() → { width: 1240, height: 2772 }
    ↓
normalizeSize("1240x2772"):
  - scale = min(1536/1240, 1536/2772) = 0.554
  - width = round(1240 × 0.554) = 687
  - height = round(2772 × 0.554) = 1536
    ↓
API receives: "size": "687x1536" (ratio 0.447 preserved)
    ↓
WaveSpeed generates image with exact 687x1536 dimensions
```

### When to Use
- When original aspect ratio must be preserved exactly
- For non-standard aspect ratios
- When image cropping/distortion is unacceptable

---

## Comparison Table

| Feature | Vertex AI | WaveSpeed |
|---------|-----------|-----------|
| Aspect Ratio | Standard ratios only | Custom dimensions |
| Ratio Preservation | Snaps to closest standard | Exact preservation |
| Dimension Range | Fixed by ratio | 256-1536px flexible |
| Best For | Social media formats | Original ratio preservation |

---

## API Request Examples

### Vertex AI Request
```json
{
  "image_url": "https://example.com/image.jpg",
  "profile_id": "abc123",
  "aspect_ratio": "9:16",
  "provider": "vertex"
}
```
- `aspect_ratio` is used directly
- If omitted or "original", closest standard ratio is calculated

### WaveSpeed Request
```json
{
  "image_url": "https://example.com/image.jpg",
  "profile_id": "abc123",
  "provider": "wavespeed"
}
```
- No `aspect_ratio` needed for original ratio preservation
- Backend automatically calculates and scales dimensions
- If `aspect_ratio` is explicitly set (e.g., "9:16"), that ratio will be used instead

---

## Affected Endpoints

The following endpoints support both providers with this behavior:

| Endpoint | Description |
|----------|-------------|
| `/enhance` | Image enhancement |
| `/beauty` | Beauty filter |
| `/restore` | Image restoration |
| `/aging` | Age transformation |
| `/filter` | Style transfer |
| `/faceswap` | Face swap |

---

## Code Reference

### Key Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `resolveAspectRatio()` | `utils.ts` | Maps dimensions to standard ratios (Vertex) |
| `getClosestAspectRatio()` | `utils.ts` | Finds nearest standard ratio |
| `normalizeSize()` | `services.ts:2475` | Scales dimensions proportionally (WaveSpeed) |
| `aspectRatioToSize()` | `services.ts:2504` | Converts ratio to pixel dimensions |
| `callWaveSpeedEdit()` | `services.ts:2455` | WaveSpeed API call with size handling |

### Logic Separation

```typescript
// Determine provider
const effectiveProvider = body.provider || env.IMAGE_PROVIDER;

// WaveSpeed: Use original dimensions
if (effectiveProvider === 'wavespeed' && !userExplicitlySetAspectRatio) {
  const dims = await getImageDimensionsExtended(imageUrl, env);
  sizeForWaveSpeed = `${dims.width}x${dims.height}`;
}

// Vertex: Use standard aspect ratio (unchanged)
const validAspectRatio = await resolveAspectRatio(...);
```

---

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `IMAGE_PROVIDER` | Default provider: `"vertex"` or `"wavespeed"` |
| `WAVESPEED_API_KEY` | WaveSpeed API authentication |
| `GOOGLE_VERTEX_PROJECT_ID` | Vertex AI project ID |

### Per-Request Override

Any endpoint can override the default provider:
```json
{
  "provider": "wavespeed"
}
```
