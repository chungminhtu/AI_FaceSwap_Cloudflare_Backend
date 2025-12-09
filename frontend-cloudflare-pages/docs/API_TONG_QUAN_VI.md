# Tổng quan API Face Swap AI

Tài liệu này mô tả đầy đủ các điểm cuối (endpoint) mà Cloudflare Worker cung cấp. Base URL: `https://api.d.shotpix.app`

## 1. POST `/faceswap`

### Mục đích
Thực hiện face swap giữa ảnh preset và ảnh selfie sử dụng Vertex AI (luôn dùng chế độ Vertex). Hỗ trợ multiple selfies để tạo composite results (ví dụ: wedding photos với cả male và female).

### Nội dung yêu cầu

**Ví dụ 1: Sử dụng selfie_ids (từ database)**
```json
{
  "preset_image_id": "image_1234567890_abc123",
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
  "preset_image_id": "image_1234567890_abc123",
  "selfie_image_urls": ["https://example.com/selfie1.jpg", "https://example.com/selfie2.jpg"],
  "profile_id": "profile_1234567890",
  "additional_prompt": "Add dramatic lighting and cinematic atmosphere",
  "character_gender": "male",
  "aspect_ratio": "16:9"
}
```

**Các trường:**
- `preset_image_id` (string, bắt buộc): ID ảnh preset đã lưu trong cơ sở dữ liệu.
- `selfie_ids` (array of strings, tùy chọn): Mảng các ID ảnh selfie đã lưu trong cơ sở dữ liệu (hỗ trợ multiple selfies). Thứ tự: [selfie_chính, selfie_phụ] - selfie đầu tiên sẽ được face swap vào preset, selfie thứ hai (nếu có) sẽ được sử dụng làm tham chiếu bổ sung. Thông tin gender (male/female) của mỗi selfie được lưu trong database.
- `selfie_image_urls` (array of strings, tùy chọn): Mảng các URL ảnh selfie trực tiếp (thay thế cho `selfie_ids`). Hỗ trợ multiple selfies. **Lưu ý**: Phải cung cấp `selfie_ids` HOẶC `selfie_image_urls` (không phải cả hai).
- `profile_id` (string, bắt buộc): ID profile người dùng.
- `additional_prompt` (string, tùy chọn): câu mô tả bổ sung, được nối vào cuối trường `prompt` bằng ký tự `+`.
- `character_gender` (string, tùy chọn): `male`, `female` hoặc bỏ trống. Nếu truyền, hệ thống chèn mô tả giới tính tương ứng vào cuối `prompt`.
- `aspect_ratio` (string, tùy chọn): Tỷ lệ khung hình. Các giá trị hỗ trợ: `"1:1"`, `"3:2"`, `"2:3"`, `"3:4"`, `"4:3"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"21:9"`. Mặc định: `"1:1"`.

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



## 2. POST `/enhance`

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

**Ví dụ với cURL:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -F "file=@/path/to/image.jpg" \
  -F "type=preset" \
  -F "profile_id=profile_1234567890" \
  -F "presetName=Studio Neon Collection" \
  -F "enableVertexPrompt=true" \
  -F "enableVisionScan=true" \
  -F "gender=female"
```

**Ví dụ với JavaScript (FormData):**
```javascript
const formData = new FormData();
formData.append('file', fileInput.files[0]);
formData.append('type', 'preset');
formData.append('profile_id', 'profile_1234567890');
formData.append('presetName', 'Studio Neon Collection');
formData.append('enableVertexPrompt', 'true');
formData.append('enableVisionScan', 'true');
formData.append('gender', 'female');
```

**Các trường:**
- `file` (file, bắt buộc): file ảnh cần upload.
- `type` (string, bắt buộc): `preset` hoặc `selfie`.
- `profile_id` (string, bắt buộc): ID profile người dùng.
- `presetName` (string, tùy chọn): tên bộ sưu tập preset.
- `enableVertexPrompt` (string, tùy chọn): `"true"` để bật tạo prompt Vertex khi upload preset.
- `enableVisionScan` (string, tùy chọn): `"true"` để bật Vision API safety scan.
- `gender` (string, tùy chọn): `"male"` hoặc `"female"`.

### Phản hồi thành công (preset)

```json
{
  "success": true,
  "url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
  "id": "image_...",
  "filename": "example.jpg",
  "hasPrompt": true,
  "prompt_json": { "...": "..." },
  "vertex_info": {
    "success": true,
    "promptKeys": ["prompt", "style", "..."],
    "debug": {
      "endpoint": "https://.../generateContent",
      "status": 200,
      "responseTimeMs": 4200
    }
  },
  "vision_scan": {
    "success": true,
    "isSafe": true,
    "rawResponse": { "...": "..." }
  }
}
```

### Phản hồi thành công (selfie)

```json
{
  "success": true,
  "url": "https://resources.d.shotpix.app/faceswap-images/selfie/example.jpg",
  "id": "selfie_...",
  "filename": "example.jpg"
}
```

## 7. GET `/presets`

### Mục đích
Trả về danh sách preset trong cơ sở dữ liệu.

### Query Parameters

**Ví dụ:**
```
GET https://api.d.shotpix.app/presets
GET https://api.d.shotpix.app/presets?gender=male
GET https://api.d.shotpix.app/presets?gender=female
```

- `gender` (tùy chọn): `male` hoặc `female` để lọc theo giới tính.

### Phản hồi

```json
{
  "presets": [
    {
      "id": "...",
      "image_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
      "filename": "example.jpg",
      "preset_name": "Studio Neon",
      "hasPrompt": true,
      "prompt_json": { "...": "..." },
      "gender": "female",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

## 8. DELETE `/presets/{id}`

### Mục đích
Xóa preset khỏi D1 và R2.

**Ví dụ:**
```
DELETE https://api.d.shotpix.app/presets/image_1234567890_abc123
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
      "id": "...",
      "image_url": "https://resources.d.shotpix.app/faceswap-images/selfie/example.jpg",
      "filename": "example.jpg",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

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
- `gender` (tùy chọn): Tham số này được chấp nhận nhưng hiện tại chưa được sử dụng để lọc kết quả.

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
  "workerCustomDomain": "https://api.d.shotpix.app",
  "customDomain": "https://resources.d.shotpix.app"
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

## Tổng kết

**Tổng số API endpoints: 18**

1. POST `/faceswap` - Face swap (luôn dùng Vertex AI, hỗ trợ multiple selfies)
2. POST `/enhance` - AI enhance ảnh
3. POST `/colorize` - AI chuyển ảnh đen trắng thành màu
4. POST `/aging` - AI lão hóa khuôn mặt
5. POST `/upscaler4k` - Upscale ảnh 4K
6. POST `/upload-url` - Upload file trực tiếp
7. GET `/presets` - Liệt kê presets
8. DELETE `/presets/{id}` - Xóa preset
9. GET `/selfies` - Liệt kê selfies
10. DELETE `/selfies/{id}` - Xóa selfie
11. GET `/results` - Liệt kê results
12. DELETE `/results/{id}` - Xóa result
13. POST `/profiles` - Tạo profile
14. GET `/profiles/{id}` - Lấy profile
15. PUT `/profiles/{id}` - Cập nhật profile
16. GET `/profiles` - Liệt kê profiles
17. GET `/config` - Lấy config
18. OPTIONS `/*` - CORS preflight requests
 

## Lưu ý về Custom Domain

- **Worker API Domain**: `https://api.d.shotpix.app` - Dùng cho tất cả API endpoints
- **R2 Public Domain**: `https://resources.d.shotpix.app` - Dùng cho public URLs của files trong R2 bucket
- Format R2 public URL: `https://resources.d.shotpix.app/{bucket-name}/{key}`
