# Tổng quan API Face Swap AI

Tài liệu này mô tả đầy đủ các điểm cuối (endpoint) mà Cloudflare Worker cung cấp. Base URL: `https://api.d.shotpix.app`

## 1. POST `/faceswap` hoặc POST `/`

### Mục đích
Thực hiện face swap giữa ảnh preset và ảnh selfie.

### Nội dung yêu cầu

- `target_url` (string, bắt buộc): URL ảnh mục tiêu (preset).
- `source_url` (string, bắt buộc): URL ảnh nguồn (selfie).
- `profile_id` (string, bắt buộc): ID profile người dùng.
- `mode` (string, tùy chọn): `rapidapi` hoặc `vertex`. Mặc định `rapidapi`.
- `api_provider` (string, tùy chọn): chấp nhận `google-nano-banana` để kích hoạt chế độ Vertex.
- `preset_image_id`, `preset_name` (string, tùy chọn): thông tin preset đã chọn.
- `selfie_id` (string, tùy chọn): mã selfie đã lưu trong cơ sở dữ liệu.
- `additional_prompt` (string, tùy chọn): câu mô tả bổ sung, được nối vào cuối trường `prompt` bằng ký tự `+` (chỉ áp dụng cho chế độ Vertex).
- `character_gender` (string, tùy chọn): `male`, `female` hoặc bỏ trống. Nếu truyền, hệ thống chèn mô tả giới tính tương ứng vào cuối `prompt`.

### Phản hồi thành công

```json
{
  "data": {
    "resultImageUrl": "https://d.shotpix.app/faceswap-images/results/result_123.jpg"
  },
  "debug": {
    "request": {
      "mode": "vertex",
      "targetUrl": "https://...",
      "sourceUrl": "https://..."
    },
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Processing successful",
      "finalResultImageUrl": "https://d.shotpix.app/faceswap-images/results/result_123.jpg",
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
      "publicUrl": "https://d.shotpix.app/faceswap-images/results/result_123.jpg"
    },
    "database": {
      "attempted": true,
      "success": true,
      "resultId": "result_..."
    }
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200
}
```

### Phản hồi lỗi

- Lỗi kiểm duyệt (Google Vision) trả về HTTP 422:

```json
{
  "data": null,
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
  },
  "status": "error",
  "message": "Content blocked: Image contains adult content (VERY_LIKELY)",
  "code": 422
}
```

- Các lỗi khác (RapidAPI, Vertex, lưu trữ...) trả về HTTP tương ứng với thông tin chi tiết trong `debug.provider.debug` hoặc `debug.vertex.debug`.

## 2. POST `/upload-url`

### Mục đích
Tạo URL tạm để trình duyệt tải ảnh lên thông qua Worker (`/upload-proxy/{key}`) và lấy URL công khai R2.

### Nội dung yêu cầu

- `filename` (string, bắt buộc): tên tệp.
- `type` (string, bắt buộc): `preset` hoặc `selfie`.
- `profile_id` (string, bắt buộc): ID profile người dùng.
- `presetName` (string, tùy chọn): tên bộ sưu tập preset.
- `enableVertexPrompt` (boolean, tùy chọn): bật tạo prompt Vertex khi upload preset.

### Phản hồi

```json
{
  "uploadUrl": "https://api.d.shotpix.app/upload-proxy/preset/example.jpg",
  "publicUrl": "https://d.shotpix.app/faceswap-images/preset/example.jpg",
  "key": "preset/example.jpg",
  "presetName": "Studio Neon",
  "enableVertexPrompt": true
}
```

## 3. PUT `/upload-proxy/{key}`

### Mục đích
Nhận dữ liệu nhị phân từ trình duyệt, lưu vào R2 và cập nhật cơ sở dữ liệu (preset/selfie).

### Header quan trọng

- `Content-Type`: mime-type ảnh.
- `X-Preset-Name` (tùy chọn): tên bộ sưu tập preset.
- `X-Preset-Name-Encoded` (tùy chọn): `base64` nếu preset name được encode.
- `X-Enable-Vertex-Prompt`, `X-Enable-Gemini-Prompt` (tùy chọn): bật Vertex prompt generation.
- `X-Enable-Vision-Scan` (tùy chọn): bật Vision API safety scan.
- `X-Gender` (tùy chọn): `male` hoặc `female`.
- `X-Profile-Id` (bắt buộc cho selfie): ID profile.

### Phản hồi thành công (preset)

```json
{
  "success": true,
  "url": "https://d.shotpix.app/faceswap-images/preset/example.jpg",
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
  "url": "https://d.shotpix.app/faceswap-images/selfie/example.jpg",
  "id": "selfie_...",
  "filename": "example.jpg"
}
```

## 4. GET `/upload-proxy/{key}`

### Mục đích
Lấy file đã upload từ R2 thông qua Worker proxy.

### Phản hồi
Trả về file binary với headers:
- `Content-Type`: mime-type của file
- `Cache-Control`: `public, max-age=31536000`
- `Access-Control-Allow-Origin`: `*`

## 5. GET `/presets`

### Mục đích
Trả về danh sách preset trong cơ sở dữ liệu.

### Query Parameters

- `gender` (tùy chọn): `male` hoặc `female` để lọc theo giới tính.

### Phản hồi

```json
{
  "presets": [
    {
      "id": "...",
      "image_url": "https://d.shotpix.app/faceswap-images/preset/example.jpg",
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

## 6. DELETE `/presets/{id}`

### Mục đích
Xóa preset khỏi D1 và R2, đồng thời xóa tất cả kết quả liên quan.

### Phản hồi

```json
{
  "success": true,
  "message": "Preset deleted successfully",
  "debug": {
    "presetId": "...",
    "resultsDeleted": 2,
    "databaseDeleted": 1,
    "r2Deleted": true,
    "r2Key": "preset/example.jpg",
    "r2Error": null,
    "imageUrl": "https://..."
  }
}
```

## 7. GET `/selfies`

### Mục đích
Trả về tối đa 50 selfie gần nhất của một profile.

### Query Parameters

- `profile_id` (bắt buộc): ID profile.
- `gender` (tùy chọn): `male` hoặc `female` để lọc theo giới tính.

### Phản hồi

```json
{
  "selfies": [
    {
      "id": "...",
      "image_url": "https://d.shotpix.app/faceswap-images/selfie/example.jpg",
      "filename": "example.jpg",
      "gender": "male",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

## 8. DELETE `/selfies/{id}`

### Mục đích
Xóa selfie và tất cả kết quả liên quan khỏi D1 và R2.

### Phản hồi

```json
{
  "success": true,
  "message": "Selfie deleted successfully",
  "debug": {
    "selfieId": "...",
    "resultsDeleted": 3,
    "databaseDeleted": 1,
    "r2Deleted": true,
    "r2Key": "selfie/example.jpg",
    "r2Error": null,
    "imageUrl": "https://..."
  }
}
```

## 9. GET `/results`

### Mục đích
Trả về tối đa 50 kết quả face swap gần nhất.

### Query Parameters

- `profile_id` (tùy chọn): ID profile để lọc kết quả.
- `gender` (tùy chọn): `male` hoặc `female` để lọc theo giới tính.

### Phản hồi

```json
{
  "results": [
    {
      "id": "...",
      "selfie_id": "...",
      "preset_id": "...",
      "preset_name": "Studio Neon",
      "result_url": "https://d.shotpix.app/faceswap-images/results/result_123.jpg",
      "profile_id": "...",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

## 10. DELETE `/results/{id}`

### Mục đích
Xóa kết quả khỏi D1 và R2.

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

## 11. GET `/vertex/get-prompt/{preset_image_id}`

### Mục đích
Trả về prompt đã lưu cho preset (nếu có).

### Phản hồi

```json
{
  "success": true,
  "presetImage": {
    "id": "...",
    "image_url": "https://d.shotpix.app/faceswap-images/preset/example.jpg",
    "hasPrompt": true,
    "promptJson": {
      "prompt": "...",
      "style": "...",
      "lighting": "...",
      "composition": "...",
      "camera": "...",
      "background": "..."
    }
  }
}
```

## 12. GET `/test-vertex`

### Mục đích
Kiểm tra kết nối Vertex AI API và liệt kê các model có sẵn.

### Phản hồi

```json
{
  "message": "Vertex AI API reachable",
  "hasApiKey": true,
  "status": 200,
  "ok": true,
  "models": [
    "projects/ai-photo-office/locations/us-central1/models/gemini-2.5-flash",
    "..."
  ],
  "error": null
}
```

## 13. POST `/upscaler4k`

### Mục đích
Upscale ảnh lên độ phân giải 4K sử dụng WaveSpeed AI.

### Nội dung yêu cầu

- `image_url` (string, bắt buộc): URL ảnh cần upscale.

### Phản hồi thành công

```json
{
  "data": {
    "resultImageUrl": "https://d.shotpix.app/faceswap-images/results/upscaler4k_123.jpg"
  },
  "debug": {
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Upscaler4K image upscaling completed",
      "finalResultImageUrl": "https://d.shotpix.app/faceswap-images/results/upscaler4k_123.jpg"
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
  },
  "status": "success",
  "message": "Upscaling completed",
  "code": 200
}
```

### Phản hồi lỗi
Trả về HTTP 400 nếu ảnh input hoặc output không pass safety check, hoặc HTTP 500 nếu có lỗi từ WaveSpeed API.

## 14. POST `/profiles`

### Mục đích
Tạo profile mới.

### Nội dung yêu cầu

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

## 15. GET `/profiles/{id}`

### Mục đích
Lấy thông tin profile theo ID.

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

## 16. PUT `/profiles/{id}`

### Mục đích
Cập nhật thông tin profile.

### Nội dung yêu cầu

- `name` (string, tùy chọn): tên profile.
- `email` (string, tùy chọn): email.
- `avatar_url` (string, tùy chọn): URL avatar.
- `preferences` (object, tùy chọn): preferences dạng JSON.

### Phản hồi
Trả về profile đã được cập nhật (format giống GET `/profiles/{id}`).

## 17. GET `/profiles`

### Mục đích
Liệt kê tất cả profiles (dùng cho admin/debugging).

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

## 18. GET `/r2/{key}`

### Mục đích
Phục vụ file từ R2 bucket thông qua Worker (fallback khi không có CUSTOM_DOMAIN).

### Phản hồi
Trả về file binary với headers tương tự GET `/upload-proxy/{key}`.

## 19. GET `/config`

### Mục đích
Lấy cấu hình public của Worker (custom domains).

### Phản hồi

```json
{
  "workerCustomDomain": "https://api.d.shotpix.app",
  "customDomain": "https://d.shotpix.app"
}
```

---

## Tổng kết

**Tổng số API endpoints: 19**

1. POST `/faceswap` hoặc POST `/` - Face swap
2. POST `/upload-url` - Tạo upload URL
3. PUT `/upload-proxy/{key}` - Upload file
4. GET `/upload-proxy/{key}` - Lấy file đã upload
5. GET `/presets` - Liệt kê presets
6. DELETE `/presets/{id}` - Xóa preset
7. GET `/selfies` - Liệt kê selfies
8. DELETE `/selfies/{id}` - Xóa selfie
9. GET `/results` - Liệt kê results
10. DELETE `/results/{id}` - Xóa result
11. GET `/vertex/get-prompt/{preset_image_id}` - Lấy Vertex prompt
12. GET `/test-vertex` - Test Vertex AI
13. POST `/upscaler4k` - Upscale ảnh 4K
14. POST `/profiles` - Tạo profile
15. GET `/profiles/{id}` - Lấy profile
16. PUT `/profiles/{id}` - Cập nhật profile
17. GET `/profiles` - Liệt kê profiles
18. GET `/r2/{key}` - Phục vụ R2 file
19. GET `/config` - Lấy config

## Lưu ý về Custom Domain

- **Worker API Domain**: `https://api.d.shotpix.app` - Dùng cho tất cả API endpoints
- **R2 Public Domain**: `https://d.shotpix.app` - Dùng cho public URLs của files trong R2 bucket
- Format R2 public URL: `https://d.shotpix.app/{bucket-name}/{key}`

## Cấu trúc phản hồi lỗi

Các phản hồi lỗi từ Worker đều tuân thủ một trong hai dạng:

1. Lỗi chuẩn hóa: `{ "data": null, "debug": { ... }, "status": "error", "message": "...", "code": 4xx/5xx }`
2. Lỗi cũ (legacy): `{ "Success": false, "Message": "...", "StatusCode": 500, "Debug": { ... } }`

Trường `debug` luôn chứa thông tin chi tiết giúp truy vết: endpoint gọi tới, thời gian phản hồi, payload gửi đi, phản hồi gốc (đã được khử dữ liệu nhạy cảm như base64) và các khóa phụ (`vertex`, `vision`, `storage`, `database`) tùy vào ngữ cảnh.
