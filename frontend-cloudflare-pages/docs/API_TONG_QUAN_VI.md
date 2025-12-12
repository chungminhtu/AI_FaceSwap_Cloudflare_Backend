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

### Nội dung yêu cầu

**Ví dụ 1: Sử dụng selfie_ids (từ database)**
```json
{
  "preset_image_id": "preset_1234567890_abc123",
  "selfie_ids": ["selfie_1234567890_xyz789"],
  "profile_id": "profile_1234567890",
  "additional_prompt": "Add dramatic lighting and cinematic atmosphere",
  "character_gender": "male",
  "aspect_ratio": "16:9"
}
```

**Ví dụ 2: Sử dụng selfie_image_urls (URL trực tiếp)**
```json
{
  "preset_image_id": "preset_1234567890_abc123",
  "selfie_image_urls": ["https://example.com/selfie1.jpg", "https://example.com/selfie2.jpg"],
  "profile_id": "profile_1234567890",
  "additional_prompt": "Add dramatic lighting and cinematic atmosphere",
  "character_gender": "male",
  "aspect_ratio": "16:9"
}
```

**Các trường:**
- `preset_image_id` (string, bắt buộc): ID ảnh preset đã lưu trong cơ sở dữ liệu (format: `preset_...`).
- `selfie_ids` (array of strings, tùy chọn): Mảng các ID ảnh selfie đã lưu trong cơ sở dữ liệu (hỗ trợ multiple selfies). Thứ tự: [selfie_chính, selfie_phụ] - selfie đầu tiên sẽ được face swap vào preset, selfie thứ hai (nếu có) sẽ được sử dụng làm tham chiếu bổ sung.
- `selfie_image_urls` (array of strings, tùy chọn): Mảng các URL ảnh selfie trực tiếp (thay thế cho `selfie_ids`). Hỗ trợ multiple selfies. **Lưu ý**: Phải cung cấp `selfie_ids` HOẶC `selfie_image_urls` (không phải cả hai).
- `profile_id` (string, bắt buộc): ID profile người dùng.
- `additional_prompt` (string, tùy chọn): câu mô tả bổ sung, được nối vào cuối trường `prompt` bằng ký tự `+`.
- `character_gender` (string, tùy chọn): `male`, `female` hoặc bỏ trống. Nếu truyền, hệ thống chèn mô tả giới tính tương ứng vào cuối `prompt`.
- `aspect_ratio` (string, tùy chọn): Tỷ lệ khung hình. Các giá trị hỗ trợ: `"1:1"`, `"3:2"`, `"2:3"`, `"3:4"`, `"4:3"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"21:9"`. Mặc định: `"1:1"`. (Cấu hình trong `config.ts`: `ASPECT_RATIO_CONFIG`)

**Lưu ý về prompt generation:**
- Nếu preset đã có `prompt_json` trong database, hệ thống sẽ sử dụng prompt đó.
- Nếu preset chưa có `prompt_json`, hệ thống sẽ tự động tạo prompt bằng Vertex AI và lưu vào database để sử dụng cho các lần sau.

### Phản hồi thành công

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

### Phản hồi lỗi

- Lỗi kiểm duyệt (Google Vision) trả về HTTP 422:

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

- Các lỗi khác (RapidAPI, Vertex, lưu trữ...) trả về HTTP tương ứng với thông tin chi tiết trong `debug.provider.debug` hoặc `debug.vertex.debug`.



## 2. POST `/removeBackground`

### Mục đích
Xóa nền của ảnh selfie, giữ lại người với transparent background sử dụng Vertex AI. Kết quả là ảnh người không có nền, sẵn sàng để sử dụng.

### Nội dung yêu cầu

**Ví dụ 1: Sử dụng selfie_id (từ database)**
```json
{
  "preset_image_id": "preset_1234567890_abc123",
  "selfie_id": "selfie_1234567890_xyz789",
  "profile_id": "profile_1234567890",
  "additional_prompt": "Make the person look happy and relaxed",
  "aspect_ratio": "16:9"
}
```

**Ví dụ 2: Sử dụng selfie_image_url (URL trực tiếp)**
```json
{
  "preset_image_id": "preset_1234567890_abc123",
  "selfie_image_url": "https://example.com/selfie.png",
  "profile_id": "profile_1234567890",
  "additional_prompt": "Make the person look happy and relaxed",
  "aspect_ratio": "16:9"
}
```

**Các trường:**
- `preset_image_id` (string, bắt buộc): ID ảnh preset (landscape scene) đã lưu trong cơ sở dữ liệu (format: `preset_...`).
- `selfie_id` (string, tùy chọn): ID ảnh selfie đã lưu trong cơ sở dữ liệu (người có transparent background). **Lưu ý**: Phải cung cấp `selfie_id` HOẶC `selfie_image_url` (không phải cả hai).
- `selfie_image_url` (string, tùy chọn): URL ảnh selfie trực tiếp (thay thế cho `selfie_id`). Ảnh phải có transparent background sẵn.
- `profile_id` (string, bắt buộc): ID profile người dùng.
- `additional_prompt` (string, tùy chọn): Câu mô tả bổ sung cho việc xóa nền (ví dụ: "Make the person look happy", "Adjust lighting to match sunset").
- `aspect_ratio` (string, tùy chọn): Tỷ lệ khung hình. Các giá trị hỗ trợ: `"1:1"`, `"3:2"`, `"2:3"`, `"3:4"`, `"4:3"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"21:9"`. Mặc định: `"1:1"`. (Cấu hình trong `config.ts`: `ASPECT_RATIO_CONFIG`)

**Lưu ý về merge:**
- API sẽ gửi cả 2 ảnh (selfie và preset) trực tiếp đến Vertex AI cùng với prompt hướng dẫn merge.
- Khuôn mặt sẽ được giữ nguyên (có thể enhance nhẹ để match lighting của scene).
- Tư thế sẽ được điều chỉnh tự nhiên để phù hợp với scene.
- Nếu scene có người khác, sẽ blend tự nhiên (ví dụ: như đang chụp ảnh cùng nhau).

### Phản hồi thành công

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

### Phản hồi lỗi

- Lỗi validation: HTTP 400 nếu thiếu `preset_image_id`, `profile_id`, hoặc cả `selfie_id` và `selfie_image_url`.
- Lỗi không tìm thấy: HTTP 404 nếu preset hoặc selfie không tồn tại.
- Lỗi merge: HTTP 500 với thông tin chi tiết trong `debug.provider`.



## 3. POST `/enhance`

### Mục đích
AI enhance ảnh - cải thiện chất lượng, độ sáng, độ tương phản và chi tiết của ảnh.

### Nội dung yêu cầu

```json
{
  "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
  "profile_id": "profile_1234567890"
}
```

**Các trường:**
- `image_url` (string, bắt buộc): URL ảnh cần enhance.
- `profile_id` (string, bắt buộc): ID profile người dùng.

### Phản hồi thành công

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

## 3. POST `/colorize`

### Mục đích
AI chuyển đổi ảnh đen trắng thành ảnh màu.

### Nội dung yêu cầu

```json
{
  "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
  "profile_id": "profile_1234567890"
}
```

**Các trường:**
- `image_url` (string, bắt buộc): URL ảnh đen trắng cần chuyển thành màu.
- `profile_id` (string, bắt buộc): ID profile người dùng.

### Phản hồi thành công

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

## 4. POST `/aging`

### Mục đích
AI lão hóa khuôn mặt - tạo phiên bản già hơn của khuôn mặt trong ảnh.

### Nội dung yêu cầu

```json
{
  "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
  "age_years": 20,
  "profile_id": "profile_1234567890"
}
```

**Các trường:**
- `image_url` (string, bắt buộc): URL ảnh chứa khuôn mặt cần lão hóa.
- `age_years` (number, tùy chọn): Số năm muốn lão hóa (mặc định: 20).
- `profile_id` (string, bắt buộc): ID profile người dùng.

### Phản hồi thành công

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

## 5. POST `/upscaler4k`

### Mục đích
Upscale ảnh lên độ phân giải 4K sử dụng WaveSpeed AI.

### Nội dung yêu cầu

```json
{
  "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
  "profile_id": "profile_1234567890"
}
```

**Các trường:**
- `image_url` (string, bắt buộc): URL ảnh cần upscale.
- `profile_id` (string, bắt buộc): ID profile người dùng.

### Phản hồi thành công

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

### Phản hồi lỗi
Trả về HTTP 400 nếu ảnh input hoặc output không pass safety check, hoặc HTTP 500 nếu có lỗi từ WaveSpeed API.


## 6. POST `/upload-url`

### Mục đích
Tải ảnh trực tiếp lên server và lưu vào cơ sở dữ liệu với xử lý tự động (Vision scan, Vertex prompt generation).

### Nội dung yêu cầu (multipart/form-data)

**Ví dụ với cURL (multipart/form-data):**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -F "files=@/path/to/image1.jpg" \
  -F "files=@/path/to/image2.jpg" \
  -F "type=preset" \
  -F "profile_id=profile_1234567890" \
  -F "enableVertexPrompt=true"
```

**Ví dụ với JavaScript (FormData) - Upload selfie với action:**
```javascript
const formData = new FormData();
formData.append('files', fileInput.files[0]);
formData.append('type', 'selfie');
formData.append('profile_id', 'profile_1234567890');
formData.append('action', 'faceswap'); // Tùy chọn: 'faceswap' hoặc action khác
```

**Ví dụ với JSON (image_url):**
```json
{
  "image_url": "https://example.com/image.jpg",
  "type": "preset",
  "profile_id": "profile_1234567890",
  "enableVertexPrompt": true
}
```

**Ví dụ với JSON - Upload selfie với action:**
```json
{
  "image_url": "https://example.com/selfie.jpg",
  "type": "selfie",
  "profile_id": "profile_1234567890",
  "action": "faceswap"
}
```

**Các trường:**
- `files` (file[], bắt buộc nếu dùng multipart): Mảng file ảnh cần upload (hỗ trợ nhiều file).
- `image_url` hoặc `image_urls` (string/string[], bắt buộc nếu dùng JSON): URL ảnh trực tiếp.
- `type` (string, bắt buộc): `preset` hoặc `selfie`.
- `profile_id` (string, bắt buộc): ID profile người dùng.
- `enableVertexPrompt` (boolean/string, tùy chọn): `true` hoặc `"true"` để bật tạo prompt Vertex khi upload preset.
- `action` (string, tùy chọn, chỉ áp dụng cho `type=selfie`): Loại action của selfie. Mặc định: `"default"`. 
  - `"faceswap"`: Tối đa 4 ảnh, tự động xóa ảnh cũ khi upload ảnh mới (giữ lại 3 ảnh mới nhất).
  - Các action khác: Tối đa 1 ảnh, tự động xóa ảnh cũ khi upload ảnh mới.

### Phản hồi thành công

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
    ]
  }
}
```

**Phản hồi khi upload selfie:**
```json
{
  "data": {
    "results": [
      {
        "id": "selfie_1234567890_xyz789",
        "url": "https://resources.d.shotpix.app/selfie/example.jpg",
        "filename": "example.jpg",
        "action": "faceswap"
      }
    ],
    "count": 1,
    "successful": 1,
    "failed": 0
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200
}
```

**Lưu ý về auto-delete:**
- Khi upload selfie với `action="faceswap"`: Hệ thống tự động xóa ảnh cũ nếu đã có 4 ảnh, giữ lại 3 ảnh mới nhất.
- Khi upload selfie với action khác: Hệ thống tự động xóa ảnh cũ nếu đã có 1 ảnh, chỉ giữ ảnh mới nhất.
- Việc xóa được thực hiện tự động trước khi insert ảnh mới vào database.

### Phản hồi lỗi

```json
{
  "data": null,
  "status": "error",
  "message": "Upload failed: ...",
  "code": 500,
  "debug": {
    "error": "...",
    "stack": "..."
  }
}
```

**Lưu ý:**
- Khi upload nhiều file, mảng `results` sẽ chứa nhiều phần tử
- Mỗi phần tử trong `results` có `id`, `url`, `filename`
- Với preset: thông tin Vertex AI (`hasPrompt`, `prompt_json`, `vertex_info`) được đặt trong `debug.vertex` (chỉ khi bật `enableVertexPrompt` và `DEBUG` env var = `'true'` hoặc `'1'`)
- Với selfie: chỉ có `id`, `url`, `filename`
- Response format được chuẩn hóa: `{ data, status, message, code, debug? }`
- `debug` property chỉ xuất hiện khi `DEBUG` env var được bật (giống như faceswap API)

## 7. GET `/presets`

### Mục đích
Trả về danh sách preset trong cơ sở dữ liệu.

### Query Parameters

**Ví dụ:**
```
GET https://api.d.shotpix.app/presets
GET https://api.d.shotpix.app/presets?include_thumbnails=true
```

- `include_thumbnails` (tùy chọn): `true` để bao gồm cả presets có thumbnail. Mặc định chỉ trả về presets không có thumbnail.

### Phản hồi

```json
{
  "presets": [
    {
      "id": "preset_1234567890_abc123",
      "image_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
      "hasPrompt": true,
      "prompt_json": { "...": "..." },
      "thumbnail_url": "https://resources.d.shotpix.app/webp_1x/face-swap/wedding_both_1.webp",
      "thumbnail_format": "webp",
      "thumbnail_resolution": "1x",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

**Lưu ý:**
- Metadata (type, sub_category, gender, position) được lưu trong R2 bucket path, không lưu trong database
- `thumbnail_url`, `thumbnail_format`, `thumbnail_resolution` chỉ có khi preset có thumbnail

## 8. DELETE `/presets/{id}`

### Mục đích
Xóa preset khỏi D1 và R2.

**Ví dụ:**
```
DELETE https://api.d.shotpix.app/presets/preset_1234567890_abc123
```

### Phản hồi

```json
{
  "success": true,
  "message": "Preset deleted successfully"
}
```

## 9. GET `/selfies`

### Mục đích
Trả về tối đa 50 selfie gần nhất của một profile.

### Query Parameters

**Ví dụ:**
```
GET https://api.d.shotpix.app/selfies?profile_id=profile_1234567890
```

- `profile_id` (bắt buộc): ID profile.

### Phản hồi

```json
{
  "selfies": [
    {
      "id": "selfie_1234567890_xyz789",
      "selfie_url": "https://resources.d.shotpix.app/selfie/example.jpg",
      "action": "faceswap",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

**Các trường:**
- `id` (string): ID của selfie.
- `selfie_url` (string): URL đầy đủ của ảnh selfie (tự động được assemble từ bucket key và R2_DOMAIN).
- `action` (string | null): Loại action của selfie (ví dụ: `"faceswap"`, `"default"`, hoặc `null` nếu chưa được set).
- `created_at` (string): Thời gian tạo selfie (ISO 8601 format).

**Lưu ý:**
- `selfie_url` trong database chỉ lưu bucket key (ví dụ: `"selfie/filename.jpg"`), không lưu full URL.
- API tự động assemble full URL từ `R2_DOMAIN` environment variable khi trả về response.

## 10. DELETE `/selfies/{id}`

### Mục đích
Xóa selfie khỏi D1 và R2.

**Ví dụ:**
```
DELETE https://api.d.shotpix.app/selfies/selfie_1234567890_xyz789
```

### Phản hồi

```json
{
  "success": true,
  "message": "Selfie deleted successfully"
}
```

## 11. GET `/results`

### Mục đích
Trả về tối đa 50 kết quả face swap gần nhất.

### Query Parameters

**Ví dụ:**
```
GET https://api.d.shotpix.app/results
GET https://api.d.shotpix.app/results?profile_id=profile_1234567890
```

- `profile_id` (tùy chọn): ID profile để lọc kết quả.

### Phản hồi

```json
{
  "results": [
    {
      "id": "...",
      "preset_name": "Studio Neon",
      "result_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
      "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
      "profile_id": "...",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

## 12. DELETE `/results/{id}`

### Mục đích
Xóa kết quả khỏi D1 và R2.

**Ví dụ:**
```
DELETE https://api.d.shotpix.app/results/result_1234567890_abc123
```

### Phản hồi

```json
{
  "success": true,
  "message": "Result deleted successfully",
  "debug": {
    "resultId": "...",
    "databaseDeleted": 1,
    "r2Deleted": true,
    "r2Key": "results/result_123.jpg",
    "r2Error": null,
    "resultUrl": "https://..."
  }
}
```

## 13. POST `/profiles`

### Mục đích
Tạo profile mới.

### Nội dung yêu cầu

```json
{
  "id": "profile_1234567890",
  "name": "John Doe",
  "email": "john@example.com",
  "avatar_url": "https://example.com/avatar.jpg",
  "preferences": {
    "theme": "dark",
    "language": "vi"
  }
}
```

**Các trường:**
- `userID` hoặc `id` (string, tùy chọn): ID profile. Nếu không có, hệ thống tự tạo.
- `name` (string, tùy chọn): tên profile.
- `email` (string, tùy chọn): email.
- `avatar_url` (string, tùy chọn): URL avatar.
- `preferences` (object, tùy chọn): preferences dạng JSON.

### Phản hồi

```json
{
  "id": "profile_...",
  "name": "John Doe",
  "email": "john@example.com",
  "avatar_url": "https://...",
  "preferences": { "...": "..." },
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```

## 14. GET `/profiles/{id}`

### Mục đích
Lấy thông tin profile theo ID.

**Ví dụ:**
```
GET https://api.d.shotpix.app/profiles/profile_1234567890
```

### Phản hồi

```json
{
  "id": "profile_...",
  "name": "John Doe",
  "email": "john@example.com",
  "avatar_url": "https://...",
  "preferences": { "...": "..." },
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```

## 15. PUT `/profiles/{id}`

### Mục đích
Cập nhật thông tin profile.

### Nội dung yêu cầu

```json
{
  "name": "John Doe Updated",
  "email": "john.updated@example.com",
  "avatar_url": "https://example.com/new-avatar.jpg",
  "preferences": {
    "theme": "light",
    "language": "en"
  }
}
```

**Ví dụ:**
```
PUT https://api.d.shotpix.app/profiles/profile_1234567890
```

**Các trường:**
- `name` (string, tùy chọn): tên profile.
- `email` (string, tùy chọn): email.
- `avatar_url` (string, tùy chọn): URL avatar.
- `preferences` (object, tùy chọn): preferences dạng JSON.

### Phản hồi
Trả về profile đã được cập nhật (format giống GET `/profiles/{id}`).

## 16. GET `/profiles`

### Mục đích
Liệt kê tất cả profiles (dùng cho admin/debugging).

**Ví dụ:**
```
GET https://api.d.shotpix.app/profiles
```

### Phản hồi

```json
{
  "profiles": [
    {
      "id": "profile_...",
      "name": "John Doe",
      "email": "john@example.com",
      "avatar_url": "https://...",
      "preferences": { "...": "..." },
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

## 17. GET `/config`

### Mục đích
Lấy cấu hình public của Worker (custom domains).

**Ví dụ:**
```
GET https://api.d.shotpix.app/config
```

### Phản hồi

```json
{
  "BACKEND_DOMAIN": "https://api.d.shotpix.app",
  "R2_DOMAIN": "https://resources.d.shotpix.app"
}
```

## 18. OPTIONS `/*`

### Mục đích
Xử lý CORS preflight requests cho tất cả các endpoints. Tự động được gọi bởi trình duyệt khi thực hiện cross-origin requests.

### Phản hồi

Trả về HTTP 204 (No Content) với các headers CORS:
- `Access-Control-Allow-Origin`: Cho phép tất cả origins
- `Access-Control-Allow-Methods`: GET, POST, PUT, DELETE, OPTIONS
- `Access-Control-Allow-Headers`: Content-Type, Authorization, và các headers khác
- `Access-Control-Max-Age`: 86400 (24 giờ)

**Lưu ý đặc biệt:**
- Endpoint `/upload-proxy/*` có hỗ trợ thêm method PUT trong CORS headers.

---

## 19. POST `/upload-thumbnails`

### Mục đích
Tải lên thư mục chứa thumbnails (WebP và Lottie JSON) và original presets. Hỗ trợ batch upload nhiều file cùng lúc.

### Nội dung yêu cầu (multipart/form-data)

**Cấu trúc thư mục:**
```
/webp_1x/face-swap/wedding_both_1.webp
/webp_1.5x/face-swap/portrait_female_1.webp
/lottie_1x/packs/autum_male_1.json
/original_preset/face-swap/wedding_both_1/webp/wedding_both_1.webp
```

**Ví dụ với JavaScript (FormData):**
```javascript
const formData = new FormData();
// Append files với path prefix
formData.append('files', file1);
formData.append('path_webp_1x_face-swap_wedding_both_1.webp', 'webp_1x/face-swap/');
formData.append('files', file2);
formData.append('path_original_preset_face-swap_wedding_both_1.webp', 'original_preset/face-swap/wedding_both_1/webp/');
```

**Quy tắc đặt tên file:**
- Format: `[type]_[sub_category]_[gender]_[position].[webp|json]`
- Ví dụ: `face-swap_wedding_both_1.webp`
- Type có thể chứa dấu gạch ngang (face-swap, packs, filters)
- Metadata được parse từ tên file và lưu trong R2 path

### Phản hồi thành công

```json
{
  "data": {
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
    ],
    "count": 2,
    "successful": 2,
    "failed": 0
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200
}
```

**Lưu ý:**
- Original presets được tạo record trong database
- Thumbnails được UPDATE vào cùng row với preset (same-row approach)
- R2 path structure: `[format]_[resolution]/[type]/[remaining_filename]`

## 20. GET `/thumbnails`

### Mục đích
Lấy danh sách thumbnails từ database.

### Query Parameters

**Ví dụ:**
```
GET https://api.d.shotpix.app/thumbnails
GET https://api.d.shotpix.app/thumbnails?thumbnail_format=webp
GET https://api.d.shotpix.app/thumbnails?thumbnail_resolution=1x
```

- `thumbnail_format` (tùy chọn): `webp` hoặc `lottie`
- `thumbnail_resolution` (tùy chọn): `1x`, `1.5x`, `2x`, `3x`, `4x`

### Phản hồi

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

## 21. GET `/thumbnails/{id}/preset`

### Mục đích
Lấy preset_id từ thumbnail_id (dùng cho mobile app).

**Ví dụ:**
```
GET https://api.d.shotpix.app/thumbnails/preset_1234567890_abc123/preset
```

### Phản hồi

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

**Lưu ý:** Thumbnail và preset cùng một row trong database, nên `id` chính là `preset_id`.

## Tổng kết

**Tổng số API endpoints: 21**

**Danh sách đầy đủ các API endpoints:**

1. POST `/faceswap` - Đổi mặt (Face Swap) - luôn dùng Vertex AI, hỗ trợ multiple selfies
2. POST `/removeBackground` - Xóa nền (Remove Background)
3. POST `/enhance` - AI enhance ảnh
4. POST `/colorize` - AI chuyển ảnh đen trắng thành màu
5. POST `/aging` - AI lão hóa khuôn mặt
6. POST `/upscaler4k` - AI upscale ảnh lên 4K
7. POST `/upload-url` - Tải ảnh lên server (hỗ trợ nhiều file)
8. GET `/presets` - Liệt kê presets
9. GET `/presets/{id}` - Lấy preset theo ID
10. DELETE `/presets/{id}` - Xóa preset
11. GET `/selfies` - Liệt kê selfies
12. DELETE `/selfies/{id}` - Xóa selfie
13. GET `/results` - Liệt kê results
14. DELETE `/results/{id}` - Xóa result
15. POST `/profiles` - Tạo profile
16. GET `/profiles/{id}` - Lấy profile
17. PUT `/profiles/{id}` - Cập nhật profile
18. GET `/profiles` - Liệt kê profiles
19. POST `/upload-thumbnails` - Tải lên thumbnails và presets (batch)
20. GET `/thumbnails` - Liệt kê thumbnails
21. GET `/thumbnails/{id}/preset` - Lấy preset_id từ thumbnail_id
22. GET `/config` - Lấy config
23. OPTIONS `/*` - CORS preflight requests
 

## Lưu ý về Custom Domain

- **Worker API Domain**: `https://api.d.shotpix.app` - Dùng cho tất cả API endpoints
- **R2 Public Domain**: `https://resources.d.shotpix.app` - Dùng cho public URLs của files trong R2 bucket
- Format R2 public URL: `https://resources.d.shotpix.app/{bucket-name}/{key}`
