# Tổng quan API Face Swap AI

Tài liệu này mô tả đầy đủ các điểm cuối (endpoint) mà Cloudflare Worker cung cấp. Base URL: `https://api.d.shotpix.app`

## Cấu hình và Prompts

Tất cả các prompts và cấu hình API đã được tập trung vào file `config.ts` để dễ dàng quản lý và thay đổi. Xem thêm tài liệu chi tiết tại `backend-cloudflare-workers/CONFIG_DOCUMENTATION.md`.

**Các cấu hình chính:**
- **API Prompts**: Facial preservation, merge prompts, vertex generation prompts
- **Model Config**: Model mappings và default values
- **Aspect Ratios**: Danh sách aspect ratios được hỗ trợ
- **Timeouts**: Cấu hình timeout cho các request
- **API Config**: Temperature, tokens, safety settings cho image generation

## 1. POST `/faceswap`

### Mục đích
Thực hiện face swap giữa ảnh preset và ảnh selfie sử dụng Vertex AI (luôn dùng chế độ Vertex). Hỗ trợ multiple selfies để tạo composite results (ví dụ: wedding photos với cả male và female).

### Request

**Sử dụng selfie_ids (từ database):**
```bash
curl -X POST https://api.d.shotpix.app/faceswap \
  -H "Content-Type: application/json" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_ids": ["selfie_1234567890_xyz789"],
    "profile_id": "profile_1234567890",
    "additional_prompt": "Add dramatic lighting and cinematic atmosphere",
    "character_gender": "male",
    "aspect_ratio": "16:9"
  }'
```

**Sử dụng selfie_image_urls (URL trực tiếp):**
```bash
curl -X POST https://api.d.shotpix.app/faceswap \
  -H "Content-Type: application/json" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_image_urls": ["https://example.com/selfie1.jpg", "https://example.com/selfie2.jpg"],
    "profile_id": "profile_1234567890",
    "additional_prompt": "Add dramatic lighting and cinematic atmosphere",
    "character_gender": "male",
    "aspect_ratio": "16:9"
  }'
```

**Các trường:**
- `preset_image_id` (string, required): ID ảnh preset đã lưu trong database (format: `preset_...`).
- `selfie_ids` (array of strings, optional): Mảng các ID ảnh selfie đã lưu trong database (hỗ trợ multiple selfies). Thứ tự: [selfie_chính, selfie_phụ] - selfie đầu tiên sẽ được face swap vào preset, selfie thứ hai (nếu có) sẽ được sử dụng làm tham chiếu bổ sung.
- `selfie_image_urls` (array of strings, optional): Mảng các URL ảnh selfie trực tiếp (thay thế cho `selfie_ids`). Hỗ trợ multiple selfies. Phải cung cấp `selfie_ids` HOẶC `selfie_image_urls` (không phải cả hai).
- `profile_id` (string, required): ID profile người dùng.
- `additional_prompt` (string, optional): câu mô tả bổ sung, được nối vào cuối trường `prompt` bằng ký tự `+`.
- `character_gender` (string, optional): `male`, `female` hoặc bỏ trống. Nếu truyền, hệ thống chèn mô tả giới tính tương ứng vào cuối `prompt`.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Các giá trị hỗ trợ: `"1:1"`, `"3:2"`, `"2:3"`, `"3:4"`, `"4:3"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"21:9"`. Mặc định: `"1:1"`. (Cấu hình trong `config.ts`: `ASPECT_RATIO_CONFIG`)

### Response

```json
{
  "data": {
    "id": "result_1234567890_abc123",
    "resultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg"
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200,
  "debug": {
    "request": {
      "targetUrl": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
      "sourceUrls": [
        "https://resources.d.shotpix.app/faceswap-images/selfie/selfie_001.jpg",
        "https://resources.d.shotpix.app/faceswap-images/selfie/selfie_002.jpg"
      ]
    },
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Processing successful",
      "finalResultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
      "debug": {
        "endpoint": "https://...",
        "status": 200,
        "durationMs": 843
      }
    },
    "vertex": {
      "prompt": { "...": "..." },
      "debug": {
        "endpoint": "https://.../generateContent",
        "status": 200,
        "durationMs": 5180,
        "requestPayload": {
          "promptLength": 746,
          "imageBytes": 921344
        }
      }
    },
    "vision": {
      "checked": false,
      "isSafe": true,
      "error": "Safety check skipped for Vertex AI mode"
    },
    "storage": {
      "attemptedDownload": true,
      "downloadStatus": 200,
      "savedToR2": true,
      "r2Key": "results/result_123.jpg",
      "publicUrl": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg"
    },
    "database": {
      "attempted": true,
      "success": true,
      "resultId": "result_..."
    }
  }
}
```

### Error Response

**Lỗi kiểm duyệt (Google Vision) trả về HTTP 422:**
```json
{
  "data": null,
  "status": "error",
  "message": "Content blocked: Image contains adult content (VERY_LIKELY)",
  "code": 422,
  "debug": {
    "provider": { "...": "..." },
    "vision": {
      "checked": true,
      "isSafe": false,
      "violationCategory": "adult",
      "violationLevel": "VERY_LIKELY",
      "debug": {
        "endpoint": "https://vision.googleapis.com/v1/images:annotate",
        "status": 200
      }
    }
  }
}
```

**Lỗi 400 (Bad Request):**
```json
{
  "data": null,
  "status": "error",
  "message": "Bad Request",
  "code": 400,
  "debug": {
    "error": "Detailed error information here",
    "path": "/faceswap"
  }
}
```

**Lỗi 500 (Internal Server Error):**
```json
{
  "data": null,
  "status": "error",
  "message": "Internal Server Error",
  "code": 500,
  "debug": {
    "error": "Detailed error information here",
    "path": "/faceswap",
    "stack": "Stack trace (truncated)"
  }
}
```

## 2. POST `/removeBackground`

### Mục đích
Xóa nền của ảnh selfie, giữ lại người với transparent background sử dụng Vertex AI. Kết quả là ảnh người không có nền, sẵn sàng để sử dụng.

### Request

**Sử dụng selfie_id (từ database):**
```bash
curl -X POST https://api.d.shotpix.app/removeBackground \
  -H "Content-Type: application/json" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_id": "selfie_1234567890_xyz789",
    "profile_id": "profile_1234567890",
    "additional_prompt": "Make the person look happy and relaxed",
    "aspect_ratio": "16:9"
  }'
```

**Sử dụng selfie_image_url (URL trực tiếp):**
```bash
curl -X POST https://api.d.shotpix.app/removeBackground \
  -H "Content-Type: application/json" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_image_url": "https://example.com/selfie.png",
    "profile_id": "profile_1234567890",
    "additional_prompt": "Make the person look happy and relaxed",
    "aspect_ratio": "16:9"
  }'
```

**Các trường:**
- `preset_image_id` (string, required): ID ảnh preset (landscape scene) đã lưu trong database (format: `preset_...`).
- `selfie_id` (string, optional): ID ảnh selfie đã lưu trong database (người có transparent background). Phải cung cấp `selfie_id` HOẶC `selfie_image_url` (không phải cả hai).
- `selfie_image_url` (string, optional): URL ảnh selfie trực tiếp (thay thế cho `selfie_id`). Ảnh phải có transparent background sẵn.
- `profile_id` (string, required): ID profile người dùng.
- `additional_prompt` (string, optional): Câu mô tả bổ sung cho việc xóa nền (ví dụ: "Make the person look happy", "Adjust lighting to match sunset").
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Các giá trị hỗ trợ: `"1:1"`, `"3:2"`, `"2:3"`, `"3:4"`, `"4:3"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"21:9"`. Mặc định: `"1:1"`. (Cấu hình trong `config.ts`: `ASPECT_RATIO_CONFIG`)

### Response

```json
{
  "data": {
    "id": "result_1234567890_abc123",
    "resultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg"
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200,
  "debug": {
    "request": {
      "targetUrl": "https://resources.d.shotpix.app/faceswap-images/preset/landscape.jpg",
      "selfieUrl": "https://resources.d.shotpix.app/faceswap-images/selfie/selfie_001.png"
    },
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Processing successful",
      "finalResultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg"
    },
    "vision": {
      "checked": false,
      "isSafe": true,
      "error": "Safety check skipped for Vertex AI mode"
    },
    "storage": {
      "attemptedDownload": true,
      "downloadStatus": 200,
      "savedToR2": true,
      "r2Key": "results/result_123.jpg",
      "publicUrl": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg"
    },
    "database": {
      "attempted": true,
      "success": true,
      "resultId": "result_1234567890_abc123"
    }
  }
}
```

## 3. POST `/enhance`

### Mục đích
AI enhance ảnh - cải thiện chất lượng, độ sáng, độ tương phản và chi tiết của ảnh.

### Request

```bash
curl -X POST https://api.d.shotpix.app/enhance \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
    "profile_id": "profile_1234567890"
  }'
```

**Các trường:**
- `image_url` (string, required): URL ảnh cần enhance.
- `profile_id` (string, required): ID profile người dùng.

### Response

```json
{
  "data": {
    "id": "result_1234567890_abc123",
    "resultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/enhance_123.jpg"
  },
  "status": "success",
  "message": "Image enhancement completed",
  "code": 200,
  "debug": {
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Enhancement completed"
    }
  }
}
```

## 4. POST `/colorize`

### Mục đích
AI chuyển đổi ảnh đen trắng thành ảnh màu.

### Request

```bash
curl -X POST https://api.d.shotpix.app/colorize \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
    "profile_id": "profile_1234567890"
  }'
```

**Các trường:**
- `image_url` (string, required): URL ảnh đen trắng cần chuyển thành màu.
- `profile_id` (string, required): ID profile người dùng.

### Response

```json
{
  "data": {
    "id": "result_1234567890_abc123",
    "resultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/colorize_123.jpg"
  },
  "status": "success",
  "message": "Colorization completed",
  "code": 200,
  "debug": {
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Colorization completed"
    }
  }
}
```

## 5. POST `/aging`

### Mục đích
AI lão hóa khuôn mặt - tạo phiên bản già hơn của khuôn mặt trong ảnh.

### Request

```bash
curl -X POST https://api.d.shotpix.app/aging \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
    "age_years": 20,
    "profile_id": "profile_1234567890"
  }'
```

**Các trường:**
- `image_url` (string, required): URL ảnh chứa khuôn mặt cần lão hóa.
- `age_years` (number, optional): Số năm muốn lão hóa (mặc định: 20).
- `profile_id` (string, required): ID profile người dùng.

### Response

```json
{
  "data": {
    "id": "result_1234567890_abc123",
    "resultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/aging_123.jpg"
  },
  "status": "success",
  "message": "Aging transformation completed",
  "code": 200,
  "debug": {
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Aging completed"
    }
  }
}
```

## 6. POST `/upscaler4k`

### Mục đích
Upscale ảnh lên độ phân giải 4K sử dụng WaveSpeed AI.

### Request

```bash
curl -X POST https://api.d.shotpix.app/upscaler4k \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
    "profile_id": "profile_1234567890"
  }'
```

**Các trường:**
- `image_url` (string, required): URL ảnh cần upscale.
- `profile_id` (string, required): ID profile người dùng.

### Response

```json
{
  "data": {
    "id": "result_1234567890_abc123",
    "resultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/upscaler4k_123.jpg"
  },
  "status": "success",
  "message": "Upscaling completed",
  "code": 200,
  "debug": {
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Upscaler4K image upscaling completed",
      "finalResultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/upscaler4k_123.jpg"
    },
    "vertex": {
      "debug": {
        "endpoint": "https://api.wavespeed.ai/api/v3/wavespeed-ai/ultimate-image-upscaler",
        "status": 200,
        "durationMs": 5000
      }
    },
    "inputSafety": {
      "checked": true,
      "isSafe": true
    },
    "outputSafety": {
      "checked": true,
      "isSafe": true
    }
  }
}
```

## 7. POST `/upload-url`

### Mục đích
Tải ảnh trực tiếp lên server và lưu vào database với xử lý tự động (Vision scan, Vertex prompt generation).

### Request

**Multipart/form-data:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -F "files=@/path/to/image1.jpg" \
  -F "files=@/path/to/image2.jpg" \
  -F "type=preset" \
  -F "profile_id=profile_1234567890" \
  -F "enableVertexPrompt=true"
```

**JSON với image_url:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://example.com/image.jpg",
    "type": "preset",
    "profile_id": "profile_1234567890",
    "enableVertexPrompt": true
  }'
```

**Upload selfie với action:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -F "files=@/path/to/selfie.jpg" \
  -F "type=selfie" \
  -F "profile_id=profile_1234567890" \
  -F "action=faceswap"
```

**Các trường:**
- `files` (file[], required nếu dùng multipart): Mảng file ảnh cần upload (hỗ trợ nhiều file).
- `image_url` hoặc `image_urls` (string/string[], required nếu dùng JSON): URL ảnh trực tiếp.
- `type` (string, required): `preset` hoặc `selfie`.
- `profile_id` (string, required): ID profile người dùng.
- `enableVertexPrompt` (boolean/string, optional): `true` hoặc `"true"` để bật tạo prompt Vertex khi upload preset.
- `action` (string, optional, chỉ áp dụng cho `type=selfie`): Loại action của selfie. Mặc định: `"default"`. 
  - `"faceswap"`: Tối đa 4 ảnh, tự động xóa ảnh cũ khi upload ảnh mới (giữ lại 3 ảnh mới nhất).
  - Các action khác: Tối đa 1 ảnh, tự động xóa ảnh cũ khi upload ảnh mới.

### Response

```json
{
  "data": {
    "results": [
      {
        "id": "preset_1234567890_abc123",
        "url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
        "filename": "example.jpg"
      }
    ],
    "count": 1,
    "successful": 1,
    "failed": 0
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200,
  "debug": {
    "vertex": [
      {
        "hasPrompt": true,
        "prompt_json": {
          "prompt": "...",
          "style": "...",
          "lighting": "..."
        },
        "vertex_info": {
          "success": true,
          "promptKeys": ["prompt", "style", "lighting"],
          "debug": {
            "endpoint": "https://.../generateContent",
            "status": 200,
            "responseTimeMs": 4200
          }
        }
      }
    ],
    "filesProcessed": 1,
    "resultsCount": 1
  }
}
```

## 8. GET `/presets`

### Mục đích
Trả về danh sách preset trong database.

### Request

```bash
curl https://api.d.shotpix.app/presets
curl https://api.d.shotpix.app/presets?include_thumbnails=true
```

**Query Parameters:**
- `include_thumbnails` (optional): `true` để bao gồm cả presets có thumbnail. Mặc định chỉ trả về presets không có thumbnail.

### Response

```json
{
  "data": {
    "presets": [
      {
        "id": "preset_1234567890_abc123",
        "preset_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
        "image_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
        "hasPrompt": true,
        "prompt_json": null,
        "thumbnail_url": "https://resources.d.shotpix.app/webp_1x/face-swap/wedding_both_1.webp",
        "thumbnail_format": "webp",
        "thumbnail_resolution": "1x",
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "status": "success",
  "message": "Presets retrieved successfully",
  "code": 200,
  "debug": {
    "count": 1
  }
}
```

## 9. GET `/presets/{id}`

### Mục đích
Lấy thông tin chi tiết của một preset theo ID (bao gồm `prompt_json`).

### Request

```bash
curl https://api.d.shotpix.app/presets/preset_1234567890_abc123
```

### Response

```json
{
  "data": {
    "id": "preset_1234567890_abc123",
    "preset_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
    "image_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
    "hasPrompt": true,
    "prompt_json": {
      "prompt": "...",
      "style": "...",
      "lighting": "..."
    },
    "thumbnail_url": "https://resources.d.shotpix.app/webp_1x/face-swap/wedding_both_1.webp",
    "thumbnail_format": "webp",
    "thumbnail_resolution": "1x",
    "created_at": 1704067200
  },
  "status": "success",
  "message": "Preset retrieved successfully",
  "code": 200,
  "debug": {
    "presetId": "preset_1234567890_abc123",
    "hasPrompt": true
  }
}
```

## 10. DELETE `/presets/{id}`

### Mục đích
Xóa preset khỏi D1 và R2.

### Request

```bash
curl -X DELETE https://api.d.shotpix.app/presets/preset_1234567890_abc123
```

### Response

```json
{
  "data": null,
  "status": "success",
  "message": "Preset deleted successfully",
  "code": 200
}
```

## 11. GET `/selfies`

### Mục đích
Trả về tối đa 50 selfie gần nhất của một profile.

### Request

```bash
curl https://api.d.shotpix.app/selfies?profile_id=profile_1234567890
```

**Query Parameters:**
- `profile_id` (required): ID profile.

### Response

```json
{
  "data": {
    "selfies": [
      {
        "id": "selfie_1234567890_xyz789",
        "selfie_url": "https://resources.d.shotpix.app/faceswap-images/selfie/example.jpg",
        "action": "faceswap",
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "status": "success",
  "message": "Selfies retrieved successfully",
  "code": 200
}
```

## 12. DELETE `/selfies/{id}`

### Mục đích
Xóa selfie khỏi D1 và R2.

### Request

```bash
curl -X DELETE https://api.d.shotpix.app/selfies/selfie_1234567890_xyz789
```

### Response

```json
{
  "data": null,
  "status": "success",
  "message": "Selfie deleted successfully",
  "code": 200,
  "debug": {
    "selfieId": "selfie_1234567890_xyz789",
    "r2Deleted": true,
    "r2Error": null
  }
}
```

## 13. GET `/results`

### Mục đích
Trả về tối đa 50 kết quả face swap gần nhất.

### Request

```bash
curl https://api.d.shotpix.app/results
curl https://api.d.shotpix.app/results?profile_id=profile_1234567890
```

**Query Parameters:**
- `profile_id` (optional): ID profile để lọc kết quả.

### Response

```json
{
  "data": {
    "results": [
      {
        "id": "result_1234567890_abc123",
        "result_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
        "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
        "profile_id": "profile_1234567890",
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "status": "success",
  "message": "Results retrieved successfully",
  "code": 200
}
```

## 14. DELETE `/results/{id}`

### Mục đích
Xóa kết quả khỏi D1 và R2.

### Request

```bash
curl -X DELETE https://api.d.shotpix.app/results/result_1234567890_abc123
```

### Response

```json
{
  "data": null,
  "status": "success",
  "message": "Result deleted successfully",
  "code": 200,
  "debug": {
    "resultId": "result_1234567890_abc123",
    "databaseDeleted": 1,
    "r2Deleted": true,
    "r2Key": "results/result_123.jpg",
    "r2Error": null
  }
}
```

## 15. POST `/profiles`

### Mục đích
Tạo profile mới.

### Request

**Minimal (chỉ cần device_id):**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "device_1765774126587_yaq0uh6rvz"
  }'
```

**Full request:**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "userID": "profile_1234567890",
    "name": "John Doe",
    "email": "john@example.com",
    "avatar_url": "https://example.com/avatar.jpg",
    "preferences": "{\"theme\":\"dark\",\"language\":\"vi\"}"
  }'
```

**Với preferences dạng object:**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "name": "John Doe",
    "email": "john@example.com",
    "avatar_url": "https://example.com/avatar.jpg",
    "preferences": {
      "theme": "dark",
      "language": "vi"
    }
  }'
```

**Hoặc gửi device_id qua header:**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -H "x-device-id: device_1765774126587_yaq0uh6rvz" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com"
  }'
```

**Các trường:**
- `device_id` (string, optional): ID thiết bị. Có thể gửi trong body hoặc header `x-device-id`. Nếu không có, sẽ là `null`.
- `userID` hoặc `id` (string, optional): ID profile. Nếu không có, hệ thống tự tạo bằng `nanoid(16)`.
- `name` (string, optional): tên profile.
- `email` (string, optional): email.
- `avatar_url` (string, optional): URL avatar.
- `preferences` (string hoặc object, optional): preferences dạng JSON string hoặc object. Nếu là object, hệ thống tự động chuyển thành JSON string trước khi lưu vào D1 database (vì D1 không hỗ trợ JSON object trực tiếp).

### Response

```json
{
  "data": {
    "id": "uYNgRR70Ry9OFuMV",
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "created_at": "2025-12-15T04:48:47.676Z",
    "updated_at": "2025-12-15T04:48:47.676Z"
  },
  "status": "success",
  "message": "Profile created successfully",
  "code": 200,
  "debug": {
    "profileId": "uYNgRR70Ry9OFuMV",
    "deviceId": "device_1765774126587_yaq0uh6rvz"
  }
}
```

## 16. GET `/profiles/{id}`

### Mục đích
Lấy thông tin profile theo ID.

### Request

```bash
curl https://api.d.shotpix.app/profiles/profile_1234567890
```

### Response

```json
{
  "data": {
    "id": "uYNgRR70Ry9OFuMV",
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "name": "John Doe",
    "email": "john@example.com",
    "avatar_url": "https://example.com/avatar.jpg",
    "preferences": "{\"theme\":\"dark\",\"language\":\"vi\"}",
    "created_at": "2025-12-15T04:48:47.676Z",
    "updated_at": "2025-12-15T04:48:47.676Z"
  },
  "status": "success",
  "message": "Profile retrieved successfully",
  "code": 200
}
```

## 17. PUT `/profiles/{id}`

### Mục đích
Cập nhật thông tin profile.

### Request

```bash
curl -X PUT https://api.d.shotpix.app/profiles/profile_1234567890 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe Updated",
    "email": "john.updated@example.com",
    "avatar_url": "https://example.com/new-avatar.jpg",
    "preferences": {
      "theme": "light",
      "language": "en"
    }
  }'
```

**Các trường:**
- `name` (string, optional): tên profile.
- `email` (string, optional): email.
- `avatar_url` (string, optional): URL avatar.
- `preferences` (string hoặc object, optional): preferences dạng JSON string hoặc object. Nếu là object, hệ thống tự động chuyển thành JSON string trước khi lưu vào D1 database (vì D1 không hỗ trợ JSON object trực tiếp).

### Response

```json
{
  "data": {
    "id": "uYNgRR70Ry9OFuMV",
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "name": "John Doe Updated",
    "email": "john.updated@example.com",
    "avatar_url": "https://example.com/new-avatar.jpg",
    "preferences": "{\"theme\":\"light\",\"language\":\"en\"}",
    "created_at": "2025-12-15T04:48:47.676Z",
    "updated_at": "2025-12-15T05:00:00.000Z"
  },
  "status": "success",
  "message": "Profile updated successfully",
  "code": 200
}
```

## 18. GET `/profiles`

### Mục đích
Liệt kê tất cả profiles (dùng cho admin/debugging).

### Request

```bash
curl https://api.d.shotpix.app/profiles
```

### Response

```json
{
  "data": {
    "profiles": [
      {
        "id": "uYNgRR70Ry9OFuMV",
        "device_id": "device_1765774126587_yaq0uh6rvz",
        "name": "John Doe",
        "email": "john@example.com",
        "avatar_url": "https://example.com/avatar.jpg",
        "preferences": "{\"theme\":\"dark\",\"language\":\"vi\"}",
        "created_at": "2025-12-15T04:48:47.676Z",
        "updated_at": "2025-12-15T04:48:47.676Z"
      }
    ]
  },
  "status": "success",
  "message": "Profiles retrieved successfully",
  "code": 200
}
```

## 19. GET `/config`

### Mục đích
Lấy cấu hình public của Worker (custom domains).

### Request

```bash
curl https://api.d.shotpix.app/config
```

### Response

```json
{
  "data": {
    "backendDomain": "https://api.d.shotpix.app",
    "r2Domain": "https://resources.d.shotpix.app",
    "kvCache": {
      "available": true,
      "test": "success",
      "details": {
        "bindingName": "PROMPT_CACHE_KV",
        "envKeys": ["PROMPT_CACHE_KV_BINDING_NAME", "..."]
      }
    }
  },
  "status": "success",
  "message": "Config retrieved successfully",
  "code": 200
}
```

## 20. OPTIONS `/*`

### Mục đích
Xử lý CORS preflight requests cho tất cả các endpoints. Tự động được gọi bởi trình duyệt khi thực hiện cross-origin requests.

### Response

Trả về HTTP 204 (No Content) với các headers CORS:
- `Access-Control-Allow-Origin`: Cho phép tất cả origins
- `Access-Control-Allow-Methods`: GET, POST, PUT, DELETE, OPTIONS
- `Access-Control-Allow-Headers`: Content-Type, Authorization, và các headers khác
- `Access-Control-Max-Age`: 86400 (24 giờ)

Endpoint `/upload-proxy/*` có hỗ trợ thêm method PUT trong CORS headers.

## 21. POST `/upload-thumbnails`

### Mục đích
Tải lên thư mục chứa thumbnails (WebP và Lottie JSON) và original presets. Hỗ trợ batch upload nhiều file cùng lúc.

### Request

```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/webp_1x/face-swap/wedding_both_1.webp" \
  -F "path_webp_1x_face-swap_wedding_both_1.webp=webp_1x/face-swap/" \
  -F "files=@/path/to/original_preset/face-swap/wedding_both_1/webp/wedding_both_1.webp" \
  -F "path_original_preset_face-swap_wedding_both_1.webp=original_preset/face-swap/wedding_both_1/webp/"
```

**Quy tắc đặt tên file:**
- Format: `[type]_[sub_category]_[gender]_[position].[webp|json]`
- Ví dụ: `face-swap_wedding_both_1.webp`
- Type có thể chứa dấu gạch ngang (face-swap, packs, filters)
- Metadata được parse từ tên file và lưu trong R2 path

### Response

```json
{
  "data": {
    "total": 2,
    "successful": 2,
    "failed": 0,
    "presets_created": 1,
    "thumbnails_created": 1,
    "results": [
      {
        "filename": "face-swap_wedding_both_1.webp",
        "success": true,
        "type": "preset",
        "preset_id": "preset_1234567890_abc123",
        "url": "https://resources.d.shotpix.app/original_preset/face-swap/wedding_both_1/webp/wedding_both_1.webp"
      },
      {
        "filename": "wedding_both_1.webp",
        "success": true,
        "type": "thumbnail",
        "preset_id": "preset_1234567890_abc123",
        "url": "https://resources.d.shotpix.app/webp_1x/face-swap/wedding_both_1.webp",
        "metadata": {
          "format": "webp",
          "resolution": "1x"
        }
      }
    ]
  },
  "status": "success",
  "message": "Processed 2 of 2 files",
  "code": 200,
  "debug": {
    "filesProcessed": 2,
    "resultsCount": 2
  }
}
```

## 22. GET `/thumbnails`

### Mục đích
Lấy danh sách thumbnails từ database.

### Request

```bash
curl https://api.d.shotpix.app/thumbnails
curl https://api.d.shotpix.app/thumbnails?thumbnail_format=webp
curl https://api.d.shotpix.app/thumbnails?thumbnail_resolution=1x
```

**Query Parameters:**
- `thumbnail_format` (optional): `webp` hoặc `lottie`
- `thumbnail_resolution` (optional): `1x`, `1.5x`, `2x`, `3x`, `4x`

### Response

```json
{
  "data": {
    "thumbnails": [
      {
        "id": "preset_1234567890_abc123",
        "image_url": "https://resources.d.shotpix.app/original_preset/face-swap/wedding_both_1/webp/wedding_both_1.webp",
        "thumbnail_url": "https://resources.d.shotpix.app/webp_1x/face-swap/wedding_both_1.webp",
        "thumbnail_format": "webp",
        "thumbnail_resolution": "1x",
        "thumbnail_r2_key": "webp_1x/face-swap/wedding_both_1.webp",
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "status": "success",
  "message": "Thumbnails retrieved successfully",
  "code": 200
}
```

## 23. GET `/thumbnails/{id}/preset`

### Mục đích
Lấy preset_id từ thumbnail_id (dùng cho mobile app).

### Request

```bash
curl https://api.d.shotpix.app/thumbnails/preset_1234567890_abc123/preset
```

### Response

```json
{
  "data": {
    "preset_id": "preset_1234567890_abc123"
  },
  "status": "success",
  "message": "Preset ID retrieved successfully",
  "code": 200
}
```

## Tổng kết

**Tổng số API endpoints: 23**

**Danh sách đầy đủ các API endpoints:**

1. POST `/faceswap` - Đổi mặt (Face Swap) - luôn dùng Vertex AI, hỗ trợ multiple selfies
2. POST `/removeBackground` - Xóa nền (Remove Background)
3. POST `/enhance` - AI enhance ảnh
4. POST `/colorize` - AI chuyển ảnh đen trắng thành màu
5. POST `/aging` - AI lão hóa khuôn mặt
6. POST `/upscaler4k` - AI upscale ảnh lên 4K
7. POST `/upload-url` - Tải ảnh lên server (hỗ trợ nhiều file)
8. GET `/presets` - Liệt kê presets
9. GET `/presets/{id}` - Lấy preset theo ID (bao gồm prompt_json)
10. DELETE `/presets/{id}` - Xóa preset
11. GET `/selfies` - Liệt kê selfies
12. DELETE `/selfies/{id}` - Xóa selfie
13. GET `/results` - Liệt kê results
14. DELETE `/results/{id}` - Xóa result
15. POST `/profiles` - Tạo profile
16. GET `/profiles/{id}` - Lấy profile
17. PUT `/profiles/{id}` - Cập nhật profile
18. GET `/profiles` - Liệt kê profiles
19. GET `/config` - Lấy config
20. OPTIONS `/*` - CORS preflight requests
21. POST `/upload-thumbnails` - Tải lên thumbnails và presets (batch)
22. GET `/thumbnails` - Liệt kê thumbnails
23. GET `/thumbnails/{id}/preset` - Lấy preset_id từ thumbnail_id

## Custom Domain

- **Worker API Domain**: `https://api.d.shotpix.app` - Dùng cho tất cả API endpoints
- **R2 Public Domain**: `https://resources.d.shotpix.app` - Dùng cho public URLs của files trong R2 bucket
- Format R2 public URL: `https://resources.d.shotpix.app/{bucket-name}/{key}`
