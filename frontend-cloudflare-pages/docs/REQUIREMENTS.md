# Face Swap AI - Requirements

## Overview
A minimal web application for face swapping that allows users to upload preset images, upload selfies, and generate face-swapped results. The application uses Cloudflare Workers for backend API, Cloudflare R2 for image storage, and Cloudflare D1 for database storage.

## Frontend Structure

### File Organization
- `index.html` - Main HTML structure with inline CSS and JavaScript

### UI Layout
- Main workspace: Two-column grid layout
  - Left column: Preset section (top) and Selfie section (bottom)
  - Right column: Result image (spans both rows, large display)
- Bottom section: Results history gallery
- Both preset and selfie have identical UI: Upload area + Gallery for selection

## UI/UX Design Guide

### Design Principles
- **Minimalism**: Remove all unnecessary elements. Every component must serve a purpose.
- **Clarity**: Users should understand what to do without reading instructions.
- **Efficiency**: Minimize clicks and steps to complete tasks.
- **Consistency**: Use consistent spacing, colors, and interaction patterns throughout.
- **Feedback**: Always provide clear visual feedback for user actions.

### Layout Structure

#### Main Container
- Max width: 1200px (centered on large screens)
- Padding: 24px on desktop, 16px on mobile
- Background: #FFFFFF (white) or #FAFAFA (very light gray)
- Border radius: 0px (sharp, professional edges)

#### Main Workspace - Two Column Grid
- **Layout**: CSS Grid with 2 columns
- **Left Column** (40% width):
  - **Preset Section** (top row):
    - Upload area with drag & drop
    - Gallery grid below for selecting existing presets
    - Selected preset preview (large, prominent)
  - **Selfie Section** (bottom row):
    - Upload area with drag & drop (identical to preset)
    - Gallery grid below for selecting existing selfies
    - Selected selfie preview (large, prominent)
  - Gap between sections: 24px
- **Right Column** (60% width):
  - **Result Image Display** (spans both rows):
    - Large preview area (min-height: 600px)
    - Shows generated face swap result
    - Empty state: "Result will appear here"
    - Centered, object-fit: contain
- **Gap between columns**: 24px
- **Generate Button**: Full width below the grid, centered

#### Bottom Section - Results History
- Full width grid layout
- Responsive grid: 4 columns desktop, 3 tablets, 2 mobile
- Gap: 16px between items

### Color Palette

#### Primary Colors
- **Primary**: #2563EB (Blue 600) - Main actions, selected states
- **Primary Hover**: #1D4ED8 (Blue 700) - Interactive elements on hover
- **Primary Light**: #DBEAFE (Blue 100) - Subtle backgrounds

#### Neutral Colors
- **Background**: #FFFFFF (White)
- **Surface**: #F9FAFB (Gray 50) - Card backgrounds
- **Border**: #E5E7EB (Gray 200) - Dividers, borders
- **Text Primary**: #111827 (Gray 900) - Main text
- **Text Secondary**: #6B7280 (Gray 500) - Secondary text, labels

#### Status Colors
- **Success**: #10B981 (Green 500) - Success messages, completed states
- **Error**: #EF4444 (Red 500) - Error messages, warnings
- **Warning**: #F59E0B (Amber 500) - Warnings
- **Info**: #3B82F6 (Blue 500) - Informational messages

### Typography

#### Font Family
- **Primary**: System font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
- **Monospace**: `'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace` (for filenames only)

#### Font Sizes
- **H1 (Page Title)**: 28px / 1.2 line-height / 700 weight
- **H2 (Section Title)**: 20px / 1.3 line-height / 600 weight
- **Body**: 16px / 1.5 line-height / 400 weight
- **Small**: 14px / 1.4 line-height / 400 weight
- **Caption**: 12px / 1.3 line-height / 400 weight

#### Text Hierarchy
- Page title: H1, centered or left-aligned
- Section headers: H2, left-aligned with 24px margin-bottom
- Labels: Small, Text Secondary color, 8px margin-bottom
- Body text: Body size, Text Primary color

### Spacing System
- Use 4px base unit for consistent spacing
- **XS**: 4px (tight spacing)
- **S**: 8px (small gaps)
- **M**: 16px (default spacing)
- **L**: 24px (section spacing)
- **XL**: 32px (large sections)
- **XXL**: 48px (major sections)

### Component Specifications

#### Upload Areas
- **Container**: 
  - Background: #FFFFFF
  - Border: 2px dashed #D1D5DB (Gray 300)
  - Border radius: 8px
  - Padding: 32px
  - Min height: 200px
  - Display: flex, column, center, align-items center
  - Cursor: pointer
  - Transition: border-color 0.2s ease

- **Hover State**:
  - Border color: #2563EB (Primary)
  - Background: #F9FAFB (subtle highlight)

- **Drag Over State**:
  - Border color: #2563EB (Primary)
  - Background: #DBEAFE (Primary Light)
  - Border style: solid

- **Icon/Illustration**:
  - Size: 48px × 48px
  - Color: #9CA3AF (Gray 400)
  - Margin-bottom: 12px

- **Text**:
  - Primary: "Click to upload or drag and drop"
  - Font: Body, Text Primary
  - Margin-bottom: 4px

- **Subtext**:
  - "JPG, PNG, WebP (max 10MB)"
  - Font: Small, Text Secondary

- **File Input**:
  - Hidden (display: none)
  - Triggered by container click

#### Selected Image Preview (Preset/Selfie)
- **Container**:
  - Position: relative
  - Border radius: 8px
  - Overflow: hidden
  - Background: #F3F4F6 (Gray 100)
  - Min height: 300px
  - Max height: 400px
  - Display: flex
  - Align-items: center
  - Justify-content: center
  - Border: 2px solid #E5E7EB
  - Margin-top: 16px

- **Image**:
  - Width: 100%
  - Height: 100%
  - Max height: 400px
  - Object-fit: contain (show full image without cropping)
  - Display: block

- **Label**:
  - Position: absolute, top-left
  - Background: rgba(0, 0, 0, 0.7)
  - Color: #FFFFFF
  - Padding: 8px 12px
  - Border-radius: 0 0 8px 0
  - Font: Small, 600 weight
  - Text: "Selected Preset" or "Selected Selfie"

- **Delete Button**:
  - Position: absolute, top-right corner
  - Size: 36px × 36px
  - Background: rgba(239, 68, 68, 0.9) (Red 500 with opacity)
  - Color: #FFFFFF
  - Border: none
  - Border-radius: 50%
  - Cursor: pointer
  - Display: flex
  - Align-items: center
  - Justify-content: center
  - Icon: × (close/delete, 20px, white)
  - Z-index: 10
  - Transition: background-color 0.2s ease, transform 0.2s ease
  - Hover: Background rgba(220, 38, 38, 1) (Red 600), transform: scale(1.1)
  - Click: Show confirmation dialog before deletion

#### Result Image Display
- **Container**:
  - Background: #F9FAFB (Surface)
  - Border: 2px solid #E5E7EB
  - Border radius: 8px
  - Min height: 600px
  - Display: flex
  - Align-items: center
  - Justify-content: center
  - Position: relative
  - Grid-row: span 2 (spans both preset and selfie rows)

- **Image** (when result exists):
  - Max width: 100%
  - Max height: 100%
  - Object-fit: contain (show full image)
  - Border radius: 8px

- **Empty State**:
  - Text: "Result will appear here"
  - Font: Body, Text Secondary
  - Icon: 64px × 64px, Gray 300
  - Centered vertically and horizontally

#### Gallery Grid (Preset/Selfie Selection)
- **Container**:
  - Display: grid
  - Gap: 12px
  - Grid-template-columns: repeat(auto-fill, minmax(100px, 1fr))
  - Max columns: 3 on desktop (fits in left column)
  - Max height: 200px
  - Overflow-y: auto
  - Margin-top: 16px
  - Padding: 8px
  - Background: #F9FAFB
  - Border-radius: 8px

- **Gallery Item**:
  - Aspect ratio: 1:1 (square)
  - Border radius: 8px
  - Overflow: hidden
  - Background: #F3F4F6
  - Border: 2px solid transparent
  - Cursor: pointer
  - Transition: transform 0.2s ease, border-color 0.2s ease
  - Position: relative

- **Selected State**:
  - Border color: #2563EB (Primary)
  - Border width: 3px
  - Box shadow: 0 0 0 3px rgba(37, 99, 235, 0.1)

- **Hover State**:
  - Transform: scale(1.02)
  - Box shadow: 0 4px 12px rgba(0, 0, 0, 0.1)

- **Image**:
  - Width: 100%
  - Height: 100%
  - Object-fit: cover
  - Display: block

- **Delete Button** (Gallery Item):
  - Position: absolute, top-right corner
  - Size: 24px × 24px
  - Background: rgba(239, 68, 68, 0.9) (Red 500 with opacity)
  - Color: #FFFFFF
  - Border: none
  - Border-radius: 50%
  - Cursor: pointer
  - Display: flex
  - Align-items: center
  - Justify-content: center
  - Icon: × (close/delete, 14px, white)
  - Z-index: 10
  - Opacity: 0 (hidden by default)
  - Transition: opacity 0.2s ease, background-color 0.2s ease
  - Hover (on gallery item): Opacity: 1
  - Hover (on button): Background rgba(220, 38, 38, 1) (Red 600)
  - Click: Show confirmation dialog, prevent event propagation (don't select item)

#### Buttons

##### Primary Button (Generate)
- **Default**:
  - Background: #2563EB (Primary)
  - Color: #FFFFFF
  - Padding: 12px 24px
  - Border: none
  - Border radius: 6px
  - Font: Body, 600 weight
  - Width: 100% (on mobile), auto (on desktop)
  - Min width: 200px
  - Cursor: pointer
  - Transition: background-color 0.2s ease

- **Hover**:
  - Background: #1D4ED8 (Primary Hover)

- **Disabled**:
  - Background: #D1D5DB (Gray 300)
  - Color: #9CA3AF (Gray 400)
  - Cursor: not-allowed

- **Loading**:
  - Show spinner icon (16px) + text
  - Disable interaction

##### Secondary Button (Reset/Clear)
- Background: transparent
- Color: #6B7280 (Text Secondary)
- Border: 1px solid #E5E7EB
- Same padding and sizing as primary
- Hover: Background #F9FAFB

#### Status Messages
- **Container**:
  - Padding: 12px 16px
  - Border radius: 6px
  - Margin: 8px 0
  - Font: Small
  - Display: flex
  - Align-items: center
  - Gap: 8px

- **Success**:
  - Background: #D1FAE5 (Green 100)
  - Color: #065F46 (Green 800)
  - Icon: ✓ (checkmark)

- **Error**:
  - Background: #FEE2E2 (Red 100)
  - Color: #991B1B (Red 800)
  - Icon: ✕ (cross)

- **Info**:
  - Background: #DBEAFE (Blue 100)
  - Color: #1E40AF (Blue 800)
  - Icon: ℹ (info)

#### Loading Spinner
- **Overlay**:
  - Position: fixed
  - Top: 0, left: 0, right: 0, bottom: 0
  - Background: rgba(0, 0, 0, 0.5)
  - Display: flex
  - Align-items: center
  - Justify-content: center
  - Z-index: 9999

- **Spinner Container**:
  - Background: #FFFFFF
  - Padding: 32px
  - Border radius: 8px
  - Text-align: center
  - Min-width: 200px

- **Spinner**:
  - Size: 40px × 40px
  - Border: 3px solid #E5E7EB
  - Border-top: 3px solid #2563EB
  - Border radius: 50%
  - Animation: spin 0.8s linear infinite
  - Margin: 0 auto 16px

- **Text**:
  - Font: Body, Text Primary
  - Margin-top: 12px

#### Confirmation Dialog
- **Overlay**:
  - Position: fixed
  - Top: 0, left: 0, right: 0, bottom: 0
  - Background: rgba(0, 0, 0, 0.5)
  - Display: flex
  - Align-items: center
  - Justify-content: center
  - Z-index: 10000

- **Dialog Container**:
  - Background: #FFFFFF
  - Padding: 24px
  - Border radius: 8px
  - Min-width: 320px
  - Max-width: 400px
  - Box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2)

- **Title**:
  - Font: H2 (20px, 600 weight)
  - Color: Text Primary
  - Margin-bottom: 12px

- **Message**:
  - Font: Body (16px)
  - Color: Text Secondary
  - Margin-bottom: 24px
  - Line-height: 1.5

- **Button Container**:
  - Display: flex
  - Gap: 12px
  - Justify-content: flex-end

- **Cancel Button**:
  - Background: transparent
  - Color: Text Secondary
  - Border: 1px solid #E5E7EB
  - Padding: 10px 20px
  - Border-radius: 6px
  - Cursor: pointer
  - Hover: Background #F9FAFB

- **Confirm Button** (Delete):
  - Background: #EF4444 (Red 500)
  - Color: #FFFFFF
  - Border: none
  - Padding: 10px 20px
  - Border-radius: 6px
  - Cursor: pointer
  - Hover: Background #DC2626 (Red 600)

### User Flow

#### Primary Flow: Generate Face Swap
1. **Select/Upload Preset** (left column, top)
   - Option A: Upload new preset
     - User clicks upload area or drags file
     - Large preview appears immediately (300-400px height)
     - Status: "Uploading..." → "Uploaded" or "Already exists"
     - Gallery refreshes to show new preset
   - Option B: Select from gallery
     - User clicks thumbnail in gallery
     - Selected preset shows in large preview area
     - Visual feedback: Selected border on thumbnail

2. **Select/Upload Selfie** (left column, bottom)
   - Option A: Upload new selfie
     - User clicks upload area or drags file
     - Large preview appears immediately (300-400px height)
     - Status: "Uploading..." → "Uploaded" or "Already exists"
     - Gallery refreshes to show new selfie
   - Option B: Select from gallery
     - User clicks thumbnail in gallery
     - Selected selfie shows in large preview area
     - Visual feedback: Selected border on thumbnail

3. **Generate Button Enabled**
   - Visual feedback: Button changes from disabled to active
   - Both large previews visible in left column
   - Right column shows empty state

4. **Click Generate**
   - Loading overlay appears
   - Button disabled
   - Status: "Processing face swap..."

5. **Result Display**
   - Loading overlay disappears
   - Result image appears in large right column (spans both rows)
   - Success message: "Face swap completed"
   - Result added to history gallery below

### Responsive Design

#### Breakpoints
- **Mobile**: < 768px
  - Single column layout (stack preset, selfie, result vertically)
  - Full-width buttons
  - 2-column gallery grid for presets/selfies
  - Reduced padding (16px)
  - Result image: Full width, normal height

- **Tablet**: 768px - 1024px
  - Two-column grid layout (40% left, 60% right)
  - 3-column gallery grid for presets/selfies
  - Standard padding (24px)
  - Result image: Spans both rows

- **Desktop**: > 1024px
  - Two-column grid layout (40% left, 60% right)
  - 3-column gallery grid for presets/selfies
  - Max-width container (1200px)
  - Result image: Large display, spans both rows

### Accessibility

#### Keyboard Navigation
- All interactive elements must be keyboard accessible
- Tab order: Upload areas → Gallery items → Generate button → Results
- Enter/Space to activate buttons and select items
- Focus indicators: 2px solid outline in Primary color

#### Screen Readers
- All images must have alt text
- Buttons must have descriptive labels
- Status messages must be announced
- Loading states must be announced

#### Visual Accessibility
- Color contrast: Minimum 4.5:1 for text
- Focus indicators: Clear and visible
- Error states: Use icons + text, not just color
- Touch targets: Minimum 44px × 44px

### Performance Considerations
- Lazy load gallery images (use loading="lazy")
- Optimize images before upload (client-side compression if possible)
- Show skeleton loaders while fetching data
- Debounce search/filter inputs if added later
- Cache gallery images in browser

### Error States

#### Upload Errors
- Network error: "Upload failed. Please check your connection and try again."
- File too large: "File exceeds 10MB limit. Please choose a smaller file."
- Invalid format: "Invalid file type. Please upload JPG, PNG, or WebP."
- Duplicate: "This image already exists. Using existing version."

#### Generation Errors
- API error: "Face swap failed. Please try again."
- Timeout: "Request timed out. Please try again."
- Invalid images: "Could not process images. Please ensure both images contain faces."

### Empty States
- **No Presets Gallery**: "No presets yet. Upload your first preset above."
- **No Selfies Gallery**: "No selfies yet. Upload your first selfie above."
- **No Results History**: "No results yet. Generate your first face swap to see it here."
- **Result Display Empty**: "Result will appear here"
- Use subtle illustration or icon (48px, Gray 300)
- Text: Small, Text Secondary, centered

## Backend API Endpoints


### Backend Database Schema
- `presets` table: `id`, `image_url`, `prompt_json`, `thumbnail_url`, `thumbnail_format`, `thumbnail_resolution`, `thumbnail_r2_key`, `created_at`
- `selfies` table: `id`, `image_url`, `profile_id`, `created_at`
- `results` table: `id`, `preset_name`, `result_url`, `profile_id`, `created_at`

**Lưu ý:**
- Metadata (type, sub_category, gender, position) được lưu trong R2 bucket path, không lưu trong database
- Thumbnails được lưu trong cùng row với preset (same-row approach)

### Endpoints

#### GET `/presets`
- Returns: `{ presets: [...] }`
- Each preset contains: `id`, `image_url`, `prompt_json`, `thumbnail_url`, `thumbnail_format`, `thumbnail_resolution`, `created_at`
- Query params: `include_thumbnails` (optional, default: false) - bao gồm presets có thumbnail
- Presets are stored as individual entries (no collections)
- Backend queries database and returns all presets

#### GET `/selfies`
- Returns: `{ selfies: [...] }`
- Each selfie contains: `id`, `selfie_url` (full URL), `action`, `created_at`
- Selfies are stored as individual entries
- Backend queries database and returns all selfies
- **Lưu ý**: `selfie_url` trong database chỉ lưu bucket key, API tự động assemble full URL từ `R2_DOMAIN` khi trả về

#### DELETE `/presets/:id`
- Path parameter: `id` (preset ID)
- Backend logic:
  1. Find preset by ID in database
  2. Delete file from R2 storage using `image_url`
  3. Delete record from `presets` table
  4. Return `{ success: true, message: "Preset deleted" }`
- Error handling: Return 404 if preset not found, 500 on deletion failure

#### DELETE `/selfies/:id`
- Path parameter: `id` (selfie ID)
- Backend logic:
  1. Find selfie by ID in database
  2. Delete file from R2 storage using `image_url`
  3. Delete record from `selfies` table
  4. Return `{ success: true, message: "Selfie deleted" }`
- Error handling: Return 404 if selfie not found, 500 on deletion failure

#### POST `/upload-url`
- Content-Type: `multipart/form-data` hoặc `application/json`
- Body (multipart): `files` (file[]), `type`, `profile_id`, `enableVertexPrompt` (optional), `action` (optional, chỉ cho selfie)
- Body (JSON): `image_url` hoặc `image_urls` (string[]), `type`, `profile_id`, `enableVertexPrompt` (optional), `action` (optional, chỉ cho selfie)
- Backend logic:
  1. Upload file(s) to R2 storage
  2. Với selfie: 
     - **Chỉ với `action="4k"` hoặc `action="4K"`**: Kiểm tra an toàn bằng Vision API trước khi lưu vào database
     - **Các action khác (như `"faceswap"`, `"wedding"`, `"default"`, v.v.)**: Không kiểm tra Vision API
     - Tự động xóa ảnh cũ dựa trên action:
       - `action="faceswap"`: Tối đa 8 ảnh (có thể cấu hình qua `SELFIE_MAX_FACESWAP`), xóa ảnh cũ nhất khi vượt quá giới hạn
       - `action="wedding"`: Tối đa 2 ảnh (cấu hình qua `SELFIE_MAX_WEDDING`), xóa ảnh cũ nhất khi có >= 2 ảnh
       - `action="4k"` hoặc `"4K"`: Tối đa 1 ảnh (cấu hình qua `SELFIE_MAX_4K`), xóa ảnh cũ khi có >= 1 ảnh
       - Action khác: Tối đa 1 ảnh (cấu hình qua `SELFIE_MAX_OTHER`), xóa ảnh cũ khi có >= 1 ảnh
  3. Insert record(s) vào database (`presets` hoặc `selfies` table) với bucket key (không phải full URL)
  4. Với preset: tự động generate Vertex prompt nếu `enableVertexPrompt=true`
- Response format: `{ data: { results: [...], count, successful, failed }, status, message, code, debug? }`
  - Với selfie: mỗi result có thêm field `action`
- Hỗ trợ upload nhiều file cùng lúc
- **Lưu ý**: `selfie_url` trong database chỉ lưu bucket key (ví dụ: `"selfie/filename.jpg"`), API tự động assemble full URL khi trả về

#### POST `/faceswap`
- Body:
  ```json
  {
    "preset_image_id": "preset_id_from_database",
    "selfie_id": "selfie_id_from_database",
    "profile_id": "user_profile_id"
  }
  ```
- Returns:
  ```json
  {
    "data": {
      "resultImageUrl": "result_url"
    },
    "status": "success",
    "message": "Processing successful",
    "code": 200,
    "debug": {}
  }
  ```

#### GET `/results`
- Returns: `{ results: [...] }`
- Each result contains: `result_url`, `created_at`

## Frontend Functionality

### Preset Section (Left Column, Top)
- **Upload Area**:
  - Single file input (one preset at a time)
  - Drag and drop support
  - On file selection:
    - Use original filename from file input (sanitize for safety)
    - Show preview immediately using FileReader in large preview area
    - Call `/upload-url` with original filename and type 'preset'
    - If response has `exists: true`: Use existing URL, show message "Image already exists"
    - If response has `exists: false`: Upload file to returned uploadUrl
    - Store uploaded/existing URL and preset object
  - Show success/error status messages
  - Reload presets gallery after upload

- **Preset Gallery**:
  - Display below upload area in scrollable grid
  - Load presets from `/presets` endpoint on page load
  - Each preset card shows thumbnail image (square, 100px)
  - Click preset to select (visual feedback with selected state)
  - Selected preset shows in large preview area above gallery
  - Use `image_url` directly from database (no conversion needed)
  - Empty state: "No presets yet. Upload your first preset above."
  - Delete button on each gallery item (top-right corner, appears on hover)
  - Delete button on selected preset preview (top-right corner, always visible)

- **Delete Preset**:
  - On delete button click (gallery or preview):
    - Show confirmation dialog: "Are you sure you want to delete this preset?"
    - If confirmed: Call `DELETE /presets/:id`
    - On success: Remove from gallery, clear selection if deleted preset was selected, show success message
    - On error: Show error message, keep item in gallery
    - Reload presets gallery after successful deletion

### Selfie Section (Left Column, Bottom)
- **Upload Area**:
  - Identical UI and functionality to Preset Upload
  - Single file input (one selfie at a time)
  - Drag and drop support
  - On file selection:
    - Use original filename from file input (sanitize for safety)
    - Show preview immediately using FileReader in large preview area
    - Call `/upload-url` with original filename and type 'selfie'
    - If response has `exists: true`: Use existing URL, show message "Image already exists"
    - If response has `exists: false`: Upload file to returned uploadUrl
    - Store uploaded/existing URL and selfie object
  - Show success/error status messages
  - Reload selfies gallery after upload

- **Selfie Gallery**:
  - Display below upload area in scrollable grid
  - Load selfies from `/selfies` endpoint on page load
  - Each selfie card shows thumbnail image (square, 100px)
  - Click selfie to select (visual feedback with selected state)
  - Selected selfie shows in large preview area above gallery
  - Use `image_url` directly from database (no conversion needed)
  - Empty state: "No selfies yet. Upload your first selfie above."
  - Delete button on each gallery item (top-right corner, appears on hover)
  - Delete button on selected selfie preview (top-right corner, always visible)

- **Delete Selfie**:
  - On delete button click (gallery or preview):
    - Show confirmation dialog: "Are you sure you want to delete this selfie?"
    - If confirmed: Call `DELETE /selfies/:id`
    - On success: Remove from gallery, clear selection if deleted selfie was selected, show success message
    - On error: Show error message, keep item in gallery
    - Reload selfies gallery after successful deletion

### Result Display (Right Column, Spans Both Rows)
- Large display area (min-height: 600px)
- Shows generated face swap result
- Empty state: "Result will appear here" with icon
- Result image: Max width/height 100%, object-fit: contain
- Updates automatically after successful generation

### Face Swap Generation
- Button positioned below main workspace grid
- Enabled when both preset and selfie are selected
- On click:
  - Show loading spinner overlay
  - Disable button
  - Call `/faceswap` with preset URL and selfie URL
  - Display result image in right column on success
  - Show error message on failure
  - Reload results history gallery after success

### Results Display
- Load results from `/results` on page load
- Display results in simple grid gallery
- Each result card shows image and date
- Date formatted as Vietnamese locale

## Data Structures

### Preset Object
```javascript
{
  id: string,
  image_url: string,
  prompt_json: object | null,
  thumbnail_url: string | null,
  thumbnail_format: 'webp' | 'lottie' | null,
  thumbnail_resolution: string | null,
  created_at: string
}
```

### Selfie Object
```javascript
{
  id: string,
  image_url: string,
  created_at: string
}
```

### Result Object
```javascript
{
  result_url: string,
  created_at: string (ISO format)
}
```

## State Variables
- `selectedPreset`: Currently selected preset object or null
- `selectedSelfie`: Currently selected selfie object or null
- `presets`: Array of all preset objects (loaded from `/presets`)
- `selfies`: Array of all selfie objects (loaded from `/selfies`)
- `results`: Array of all result objects (loaded from `/results`)

## UI Elements

### Preset Gallery
- Simple grid layout
- Each card: square aspect ratio, image only
- Selected state: border highlight

### Status Messages
- Success: Green color
- Error: Red color
- Loading: Spinner animation

## Image URL Handling
- Database stores the final accessible URL directly in `image_url` field
- Backend constructs the correct R2 URL (e.g., `/r2/preset/filename.jpg` or full URL with worker domain) when uploading
- Frontend uses `image_url` from database directly - no conversion needed
- URLs are ready to use as-is for display and API calls

## Error Handling
- Network errors: Show error message
- API errors: Display error message from response
- Image load errors: Show placeholder

## Initialization
- Load presets from `/presets` on page load
- Load selfies from `/selfies` on page load
- Load results from `/results` on page load
- Display loading placeholders while fetching
- Show empty states if no data available

