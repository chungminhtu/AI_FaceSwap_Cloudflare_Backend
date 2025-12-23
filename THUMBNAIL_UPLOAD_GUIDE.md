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

### Endpoint
```
POST https://api.d.shotpix.app/upload-thumbnails
```

### Upload Methods

#### Method 1: Upload Individual Files
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/preset/fs_wonder_f_3.png" \
  -F "path_preset_fs_wonder_f_3.png=preset/" \
  -F "files=@/path/to/webp_1x/fs_wonder_f_3.webp" \
  -F "path_webp_1x_fs_wonder_f_3.webp=webp_1x/" \
  -F "files=@/path/to/lottie_1x/fs_wonder_f_3.json" \
  -F "path_lottie_1x_fs_wonder_f_3.json=lottie_1x/" \
  -F "files=@/path/to/lottie_avif_2x/fs_wonder_f_3.json" \
  -F "path_lottie_avif_2x_fs_wonder_f_3.json=lottie_avif_2x/"
```

#### Method 2: Upload Zip File (Recommended)
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/thumbnails.zip"
```

**Zip file structure should match the folder structure above.**

### Zip File Requirements
- **Format**: Standard ZIP archive (.zip)
- **Structure**: Files organized in folders as shown in the folder structure above
- **Contents**: Can contain preset images, WebP thumbnails, Lottie JSON files, and AVIF files
- **Processing**: Server automatically extracts and processes all files based on their folder paths

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
- ✅ **Batch Efficiency**: Parallel processing with Promise.all
- ✅ **Multi-Resolution**: Supports 1x, 1.5x, 2x, 3x, 4x resolutions
- ✅ **Format Support**: Handles WebP, PNG, JSON, AVIF formats
- ✅ **Error Handling**: Proper validation and error reporting
- ✅ **Database Integrity**: Ensures presets exist before storing thumbnails

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
