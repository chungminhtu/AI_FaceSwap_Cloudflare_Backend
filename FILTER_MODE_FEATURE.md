# Filter Mode Feature

## Overview

The Filter Mode feature allows you to toggle between two different Vertex AI prompt generation strategies when uploading preset images:

1. **Default Mode** (Checkbox unchecked): Standard face-swap prompt with detailed HDR lighting, composition, and face preservation instructions
2. **Filter Mode** (Checkbox checked): Art style analysis prompt that identifies and describes specific artistic styles

## Use Cases

### Default Mode
- Standard face-swap presets
- Photorealistic images
- Images where you want detailed scene description with face-swap rules
- General purpose preset uploads

### Filter Mode
- Images with distinct artistic styles (figurine, pop mart, clay, disney, etc.)
- Themed collections (anime, cartoon, artistic renders)
- Stylized presets where art style is more important than photorealism
- When you need the AI to identify and preserve the unique aesthetic

## Technical Implementation

### Configuration (`config.ts`)

Two separate prompts are defined:

```typescript
export const VERTEX_AI_PROMPTS = {
  // Default mode - detailed face-swap with HDR and composition
  PROMPT_GENERATION_DEFAULT: `Analyze the provided image and return a detailed description of its contents, pose, clothing, environment, HDR lighting, style, and composition...`,

  // Filter mode - art style analysis
  PROMPT_GENERATION_FILTER: `Analyze the image the art and thematic styles and return a detailed description of its specific art styles contents. For example if its figurine, pop mart unique style, clay, disney.. to reimagine the image. Ensure the details does not specify gender to apply to any gender...`,
};
```

### API Parameter

Add `is_filter_mode` parameter to your requests:

#### For `/upload-url` (Single preset upload)

**Form Data:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -F "file=@preset.png" \
  -F "type=preset" \
  -F "profile_id=your-profile-id" \
  -F "enableVertexPrompt=true" \
  -F "is_filter_mode=true"
```

**JSON:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://example.com/preset.png",
    "type": "preset",
    "profile_id": "your-profile-id",
    "enableVertexPrompt": true,
    "is_filter_mode": true
  }'
```

#### For `/upload-thumbnails` (Batch ZIP upload)

```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@thumbnails.zip" \
  -F "is_filter_mode=true"
```

#### For `/process-thumbnails` (Presigned URL flow)

```bash
curl -X POST https://api.d.shotpix.app/process-thumbnails \
  -H "Content-Type: application/json" \
  -d '{
    "uploadId": "your-upload-id",
    "files": [
      {
        "uploadKey": "temp/uploads/...",
        "processPath": "preset/",
        "filename": "fs_wonder_f_3.png"
      }
    ],
    "is_filter_mode": true
  }'
```

## Output Differences

### Default Mode Output Example

```json
{
  "prompt": "Replace the original face with the face from the image I will upload later. Keep the person exactly as shown in the reference image with 100% identical facial features... A professional business woman standing in a modern office, wearing elegant suit...",
  "style": "photorealistic, professional",
  "lighting": "soft natural lighting from large windows, HDR",
  "composition": "portrait orientation, rule of thirds",
  "camera": "50mm lens, f/2.8, professional DSLR",
  "background": "modern office interior with glass walls"
}
```

### Filter Mode Output Example

```json
{
  "prompt": "Pop mart style collectible figurine character in cute pose, vibrant colors, glossy finish, chibi proportions, standing on round display base",
  "style": "pop mart aesthetic, collectible toy style, vinyl figure",
  "lighting": "studio lighting with soft highlights on glossy surface",
  "composition": "centered character, full body visible",
  "camera": "product photography style",
  "background": "solid color backdrop with subtle gradient"
}
```

## Frontend Integration

### UI Checkbox
Add a checkbox in your upload UI:

```html
<input 
  type="checkbox" 
  id="filterMode" 
  name="is_filter_mode"
  value="true"
>
<label for="filterMode">
  Use Art Style Filter Mode
  <span class="help-text">
    Enable this for images with distinct artistic styles (figurine, pop mart, clay, disney, etc.)
  </span>
</label>
```

### JavaScript Example

```javascript
// For single file upload
const formData = new FormData();
formData.append('file', file);
formData.append('type', 'preset');
formData.append('profile_id', profileId);
formData.append('enableVertexPrompt', 'true');
formData.append('is_filter_mode', isFilterModeChecked ? 'true' : 'false');

fetch('https://api.d.shotpix.app/upload-url', {
  method: 'POST',
  body: formData
});

// For ZIP batch upload
const zipFormData = new FormData();
zipFormData.append('files', zipFile);
zipFormData.append('is_filter_mode', isFilterModeChecked ? 'true' : 'false');

fetch('https://api.d.shotpix.app/upload-thumbnails', {
  method: 'POST',
  body: zipFormData
});
```

## Important Notes

1. **Filter mode only affects preset images**: Thumbnail files (webp, json) are not processed by Vertex AI, so the mode doesn't affect them
2. **Parameter is optional**: If not provided, defaults to `false` (uses default mode)
3. **No breaking changes**: Existing API calls without this parameter continue to work as before
4. **Same response structure**: Both modes return the same JSON structure with `prompt`, `style`, `lighting`, `composition`, `camera`, `background` keys
5. **Gender-neutral prompts**: Filter mode specifically avoids gender-specific descriptions to apply to any gender

## Costs

- Both modes use the same Vertex AI model (`gemini-3-flash-preview`)
- Same API call cost per image
- Filter mode is NOT more expensive than default mode
- Only preset images incur Vertex AI costs (thumbnails don't)

## Migration Guide

**No migration needed!** This is a backward-compatible addition. Existing code continues to work without changes. Add the `is_filter_mode` parameter only when you want to use the art style filter.

