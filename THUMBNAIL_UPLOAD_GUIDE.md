# Thumbnail Upload System

## Overview

The thumbnail upload system processes preset images and multi-resolution thumbnails in a structured folder format. It supports both individual file uploads and zip file uploads containing all assets. The system automatically generates AI prompts for preset images and stores thumbnails at different resolutions.

## Folder Structure

```
├── preset/
│   ├── fs_wonder_f_3.png    # Images for AI prompt generation
│   └── fs_wonder_m_2.png
├── webp_1x/
│   ├── fs_wonder_f_3.webp   # 1x resolution WebP thumbnails
│   └── fs_wonder_m_2.webp
├── webp_1.5x/
│   ├── fs_wonder_f_3.webp   # 1.5x resolution WebP thumbnails
│   └── fs_wonder_m_2.webp
├── webp_2x/
│   ├── fs_wonder_f_3.webp   # 2x resolution WebP thumbnails
│   └── fs_wonder_m_2.webp
├── webp_3x/
│   ├── fs_wonder_f_3.webp   # 3x resolution WebP thumbnails
│   └── fs_wonder_m_2.webp
├── webp_4x/
│   ├── fs_wonder_f_3.webp   # 4x resolution WebP thumbnails
│   └── fs_wonder_m_2.webp
├── lottie_1x/
│   ├── fs_wonder_f_3.json   # 1x resolution Lottie thumbnails
│   └── fs_wonder_m_2.json
├── lottie_1.5x/
│   ├── fs_wonder_f_3.json   # 1.5x resolution Lottie thumbnails
│   └── fs_wonder_m_2.json
├── lottie_2x/
│   ├── fs_wonder_f_3.json   # 2x resolution Lottie thumbnails
│   └── fs_wonder_m_2.json
├── lottie_3x/
│   ├── fs_wonder_f_3.json   # 3x resolution Lottie thumbnails
│   └── fs_wonder_m_2.json
├── lottie_4x/
│   ├── fs_wonder_f_3.json   # 4x resolution Lottie thumbnails
│   └── fs_wonder_m_2.json
├── lottie_avif_1x/
│   ├── fs_wonder_f_3.json   # 1x AVIF Lottie thumbnails
│   └── fs_wonder_m_2.json
├── lottie_avif_1.5x/
│   ├── fs_wonder_f_3.json   # 1.5x AVIF Lottie thumbnails
│   └── fs_wonder_m_2.json
├── lottie_avif_2x/
│   ├── fs_wonder_f_3.json   # 2x AVIF Lottie thumbnails
│   └── fs_wonder_m_2.json
├── lottie_avif_3x/
│   ├── fs_wonder_f_3.json   # 3x AVIF Lottie thumbnails
│   └── fs_wonder_m_2.json
├── lottie_avif_4x/
│   ├── fs_wonder_f_3.json   # 4x AVIF Lottie thumbnails
│   └── fs_wonder_m_2.json
└── [other resolution folders...]
```

## How It Works

1. **Preset Processing**: Images in `preset/` folder are sent to Vertex AI for prompt generation
2. **Thumbnail Storage**: Files in resolution folders are stored as thumbnails without AI processing
3. **Database Updates**: Preset records are created/updated with thumbnail links at different resolutions

## API Usage

### Endpoints

| Endpoint | Method | Max Size | Description |
|----------|--------|----------|-------------|
| `/upload-thumbnails` | POST | 100MB* | Direct upload (files in request body) |
| `/upload-thumbnails-url` | POST | - | Get presigned URLs for large uploads |
| `/r2-upload/:key` | PUT | 100MB* | Direct R2 upload endpoint |
| `/process-thumbnails` | POST | - | Process files uploaded via presigned URLs |

> **\*Cloudflare Workers Limits**: Free/Pro = 100MB, Business = 200MB, Enterprise = 500MB.  
> For uploads >100MB, use the **Presigned URL flow** (Method 2).

---

## Method 1: Direct Upload (Up to 100MB)

### Endpoint
```
POST https://api.d.shotpix.app/upload-thumbnails
```

### Upload Individual Files
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/preset/fs_wonder_f_3.png" \
  -F "path_preset_fs_wonder_f_3.png=preset/" \
  -F "files=@/path/to/webp_1x/fs_wonder_f_3.webp" \
  -F "path_webp_1x_fs_wonder_f_3.webp=webp_1x/" \
  -F "files=@/path/to/lottie_1x/fs_wonder_f_3.json" \
  -F "path_lottie_1x_fs_wonder_f_3.json=lottie_1x/" \
  -F "files=@/path/to/lottie_avif_2x/fs_wonder_f_3.json" \
  -F "path_lottie_avif_2x_fs_wonder_f_3.json=lottie_avif_2x/" \
  -F "is_filter_mode=true"  # Optional: Enable art style filter mode
```

### Upload Zip File (Recommended for multiple files)
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/thumbnails.zip" \
  -F "is_filter_mode=true"  # Optional: Enable art style filter mode
```

**Zip file structure should match the folder structure above.**

### Zip File Requirements
- **Format**: Standard ZIP archive (.zip)
- **Structure**: Files organized in folders as shown in the folder structure above
- **Contents**: Can contain preset images, WebP thumbnails, Lottie JSON files, and AVIF files
- **Processing**: Server automatically extracts and processes all files based on their folder paths
- **Max Size**: 100MB per request (Cloudflare Workers limit)

---

## Method 2: Multipart Upload (For Large Files 100MB - 5GB)

For files larger than 100MB, use **R2 Multipart Upload** which splits files into chunks.  
**Supports uploads up to 5GB per file.**

### Multipart Upload Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/upload-multipart/create` | POST | Create upload session |
| `/upload-multipart/part` | PUT | Upload a chunk (max 95MB) |
| `/upload-multipart/complete` | POST | Finalize upload |
| `/upload-multipart/abort` | POST | Cancel upload |

### Step 1: Create Multipart Upload Session

```bash
curl -X POST https://api.d.shotpix.app/upload-multipart/create \
  -H "Content-Type: application/json" \
  -d '{
    "key": "thumbnails.zip",
    "contentType": "application/zip"
  }'
```

**Response:**
```json
{
  "data": {
    "uploadId": "ABC123XYZ",
    "key": "temp/multipart_abc123_thumbnails.zip"
  }
}
```

### Step 2: Upload Parts (Chunks)

Split your file into chunks of max 95MB each, then upload each part:

```bash
# Part 1 (first 95MB)
curl -X PUT "https://api.d.shotpix.app/upload-multipart/part?key=temp/multipart_abc123_thumbnails.zip&uploadId=ABC123XYZ&partNumber=1" \
  --data-binary @chunk1.bin

# Part 2 (next 95MB)
curl -X PUT "https://api.d.shotpix.app/upload-multipart/part?key=temp/multipart_abc123_thumbnails.zip&uploadId=ABC123XYZ&partNumber=2" \
  --data-binary @chunk2.bin

# ... continue for all parts
```

**Response (save etag for each part):**
```json
{
  "data": {
    "partNumber": 1,
    "etag": "abc123def456"
  }
}
```

### Step 3: Complete Multipart Upload

```bash
curl -X POST https://api.d.shotpix.app/upload-multipart/complete \
  -H "Content-Type: application/json" \
  -d '{
    "key": "temp/multipart_abc123_thumbnails.zip",
    "uploadId": "ABC123XYZ",
    "parts": [
      {"partNumber": 1, "etag": "abc123def456"},
      {"partNumber": 2, "etag": "ghi789jkl012"}
    ]
  }'
```

### Step 4: Process Uploaded File

```bash
curl -X POST https://api.d.shotpix.app/process-thumbnails \
  -H "Content-Type: application/json" \
  -d '{
    "uploadId": "abc123",
    "files": [
      {
        "uploadKey": "temp/multipart_abc123_thumbnails.zip",
        "processPath": "",
        "filename": "thumbnails.zip"
      }
    ]
  }'
```

---

## Method 3: Simple Upload Flow (For Files <95MB)

For smaller files, use the simpler direct upload flow:

### Step 1: Get Upload URL

```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails-url \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      {"filename": "fs_wonder_f_3.png", "path": "preset/", "contentType": "image/png", "size": 5242880}
    ]
  }'
```

### Step 2: Upload File

```bash
curl -X PUT "https://api.d.shotpix.app/r2-upload/temp%2Fupload_abc123_fs_wonder_f_3.png?contentType=image%2Fpng" \
  --data-binary @/path/to/preset/fs_wonder_f_3.png
```

### Step 3: Process File

```bash
curl -X POST https://api.d.shotpix.app/process-thumbnails \
  -H "Content-Type: application/json" \
  -d '{
    "uploadId": "abc123",
    "files": [
      {
        "uploadKey": "temp/upload_abc123_fs_wonder_f_3.png",
        "processPath": "preset/",
        "filename": "fs_wonder_f_3.png"
      }
    ]
  }'
```

### File Naming
- **Format**: `[preset_id].[extension]`
- **Example**: `fs_wonder_f_3.png`, `fs_wonder_m_2.json`
- **Rule**: Filename (without extension) becomes the `preset_id`

## Processing Rules

| Folder Type | Files | Vertex AI | Database Storage |
|-------------|-------|-----------|------------------|
| `preset/` | PNG/WebP images | ✅ Generate prompt_json | Create preset record |
| `webp_*x/` | WebP files | ❌ Skip | Store as WebP thumbnails |
| `lottie_*x/` | JSON files | ❌ Skip | Store as Lottie thumbnails |
| `lottie_avif_*x/` | JSON files | ❌ Skip | Store as AVIF thumbnails |

## Response Format

### Success Response
```json
{
  "data": {
    "total": 4,
    "successful": 4,
    "failed": 0,
    "results": [
      {
        "filename": "fs_wonder_f_3.png",
        "success": true,
        "type": "preset",
        "preset_id": "fs_wonder_f_3",
        "url": "https://resources.d.shotpix.app/presets/fs_wonder_f_3.png",
        "hasPrompt": true,
        "prompt_json": {
          "scene": "wonder woman portrait",
          "style": "heroic",
          "mood": "confident"
        },
        "vertex_info": {
          "success": true
        }
      },
      {
        "filename": "fs_wonder_f_3.webp",
        "success": true,
        "type": "thumbnail",
        "preset_id": "fs_wonder_f_3",
        "url": "https://resources.d.shotpix.app/webp_1x/fs_wonder_f_3.webp",
        "hasPrompt": false,
        "metadata": {
          "format": "webp",
          "resolution": "1x"
        }
      },
      {
        "filename": "fs_wonder_f_3.json",
        "success": true,
        "type": "thumbnail",
        "preset_id": "fs_wonder_f_3",
        "url": "https://resources.d.shotpix.app/lottie_1x/fs_wonder_f_3.json",
        "hasPrompt": false,
        "metadata": {
          "format": "lottie",
          "resolution": "1x"
        }
      },
      {
        "filename": "fs_wonder_f_3.json",
        "success": true,
        "type": "thumbnail",
        "preset_id": "fs_wonder_f_3",
        "url": "https://resources.d.shotpix.app/lottie_avif_2x/fs_wonder_f_3.json",
        "hasPrompt": false,
        "metadata": {
          "format": "lottie",
          "resolution": "2x"
        }
      }
    ]
  },
  "status": "success",
  "message": "Processed 4 of 4 files",
  "code": 200
}
```

## Database Storage

### Preset Table
- **Primary Key**: `preset_id` (from filename)
- **Columns**:
  - `thumbnail_r2`: JSON string containing all thumbnail R2 keys by resolution and format
    ```json
    {
      "webp_1x": "webp_1x/fs_wonder_f_3.webp",
      "lottie_1x": "lottie_1x/fs_wonder_f_3.json",
      "lottie_avif_2x": "lottie_avif_2x/fs_wonder_f_3.json"
    }
    ```

### R2 Storage Paths
- **Presets**: `presets/{preset_id}.{ext}`
- **Thumbnails**: `{format}_{resolution}/{preset_id}.{ext}`
  - Examples:
    - `webp_1x/fs_wonder_f_3.webp`
    - `lottie_1x/fs_wonder_f_3.json`
    - `lottie_avif_2x/fs_wonder_f_3.json`

## Key Features

- ✅ **Smart AI Processing**: Only preset images get expensive Vertex AI calls
- ✅ **Filter Mode**: Optional art style analysis for preset images
- ✅ **Batch Efficiency**: Parallel processing with Promise.all
- ✅ **Multi-Resolution**: Supports 1x, 1.5x, 2x, 3x, 4x resolutions
- ✅ **Format Support**: Handles WebP, PNG, JSON, AVIF formats
- ✅ **Error Handling**: Proper validation and error reporting
- ✅ **Database Integrity**: Ensures presets exist before storing thumbnails

---

## Filter Mode

The system supports two modes for Vertex AI prompt generation:

### Default Mode (Unchecked)
Uses detailed face-swap prompt with HDR lighting, composition, and face preservation instructions. This is the standard mode for creating realistic face-swap presets.

### Filter Mode (Checked)
Uses art style analysis prompt that identifies specific artistic styles like:
- Figurine style
- Pop Mart unique style
- Clay style
- Disney style
- And other artistic aesthetics

**When to use Filter Mode**: When your preset images have distinct artistic or thematic styles that need to be preserved in the reimagined image.

**How to enable**: Add `is_filter_mode=true` parameter to your upload request.

## Supported Resolutions

| Format | Resolutions | File Type |
|--------|-------------|-----------|
| webp | 1x, 1.5x, 2x, 3x, 4x | .webp files |
| lottie | 1x, 1.5x, 2x, 3x, 4x | .json files |
| lottie_avif | 1x, 1.5x, 2x, 3x, 4x | .json files |

## Error Handling

- **Invalid filename**: Returns error for files not matching `[preset_id].[ext]` format
- **Missing preset**: Thumbnails return error if corresponding preset doesn't exist
- **Vertex AI failure**: Continues processing other files, marks as failed in response

## Performance Notes

- Vertex AI calls are batched and processed in parallel
- File uploads happen concurrently
- Temporary files are cleaned up automatically
- Database operations are optimized with batch updates
