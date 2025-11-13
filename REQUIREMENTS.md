# Face Swap AI - Requirements

## Overview
A web application for face swapping that allows users to upload preset images, upload selfies, and generate face-swapped results. The application uses Cloudflare Workers for backend API, Cloudflare R2 for image storage, and Cloudflare D1 for database storage.

## Frontend Structure

### File Organization
- `index.html` - Main HTML structure
- `styles.css` - All CSS styles
- `script.js` - All JavaScript functionality

### UI Layout
- Three-column grid layout: Left panel, Center panel, Right panel
- Left panel: Preset upload section and preset gallery
- Center panel: Selfie upload section and face swap result display
- Right panel: Results history gallery

## Backend API Endpoints

### Base URL
- Production: `https://ai-faceswap-backend.chungminhtu03.workers.dev`

### Endpoints

#### GET `/presets`
- Returns: `{ preset_collections: [...] }`
- Each collection contains: `id`, `name`, `images[]`
- Each image contains: `id`, `collection_id`, `image_url`, `created_at`
- Frontend must flatten collections into individual preset objects

#### POST `/upload-url`
- Body: `{ filename: string, type: 'preset' | 'selfie' }`
- Returns: `{ uploadUrl: string }`

#### PUT `/upload-proxy/{key}`
- Headers: 
  - `Content-Type: image/*`
  - `X-Preset-Name: base64_encoded_name` (for preset uploads)
  - `X-Preset-Name-Encoded: 'base64'` (for preset uploads)
- Body: Image file binary
- Returns: `{ url: string }`

#### POST `/faceswap`
- Body: 
  ```json
  {
    "target_url": "preset_image_url",
    "source_url": "selfie_image_url",
  }
  ```
- Returns: 
  ```json
  {
    "Success": true,
    "ResultImageUrl": "result_url",
    "Message": "message"
  }
  ```

#### GET `/results`
- Returns: `{ results: [...] }`
- Each result contains: `result_url`, `preset_name`, `created_at`

## Frontend Functionality

### Preset Management
- Display preset gallery in grid layout
- Each preset card shows image and name
- Click preset to select (visual feedback with selected state)
- Selected preset shows status message for 2 seconds
- Convert image URLs from `/upload-proxy/` to `/r2/` for display

### Preset Upload
- Input field for preset collection name
- File input accepts multiple images
- For each file:
  - Generate filename: `preset-{timestamp}-{index}-{random}.{ext}`
  - Get upload URL from `/upload-url`
  - Encode preset name to base64
  - Upload file to returned uploadUrl with headers
  - Show progress: "Đang tải... (successCount/totalFiles)"
- After upload: Clear inputs, reload presets after 500ms delay
- Show success/error status messages

### Selfie Upload
- Single file input
- Show preview immediately using FileReader
- Generate filename: `selfie-{timestamp}-{random}.{ext}`
- Get upload URL from `/upload-url`
- Upload file to returned uploadUrl
- Store uploaded URL in `selfieImageUrl` variable
- Show success/error status messages

### Face Swap Generation
- Button enabled only when both preset and selfie are selected
- On click:
  - Show loading spinner
  - Hide result image
  - Disable button
  - Call `/faceswap` with preset and selfie URLs
  - Display result image on success
  - Show error message on failure
  - Reload results gallery after success

### Results Display
- Load results from `/results` on page load
- Display results in grid gallery
- Each result card shows image, preset name, and date
- Date formatted as Vietnamese locale

## Data Structures

### Preset Object
```javascript
{
  id: string,
  collection_id: string,
  name: string,
  image_url: string,
  created_at: string
}
```

### Result Object
```javascript
{
  result_url: string,
  preset_name: string,
  created_at: string (ISO format)
}
```

## State Variables
- `selectedPreset`: Currently selected preset object or null
- `selfieImageUrl`: URL of uploaded selfie or null
- `presets`: Array of all preset objects
- `results`: Array of all result objects

## UI Elements

### Preset Gallery
- Grid layout: `repeat(auto-fill, minmax(120px, 1fr))`
- Max height: 400px with scroll
- Each card: square aspect ratio, image with name overlay
- Selected state: thicker border, different background color

### Status Messages
- Success: Green color (#10b981)
- Error: Red color (#ef4444)
- Loading: Purple color (#667eea)

### Loading States
- Spinner animation for face swap processing
- Status text updates during uploads

## Image URL Handling
- Backend returns URLs with `/upload-proxy/` prefix
- Frontend must convert to `/r2/` for display
- Example: `/upload-proxy/preset-123.jpg` → `/r2/preset-123.jpg`

## Error Handling
- Network errors: Show error message in status element
- API errors: Display error message from response or generic message
- Image load errors: Show placeholder SVG

## Initialization
- Load presets on page load
- Load results on page load
- Display loading placeholders while fetching

