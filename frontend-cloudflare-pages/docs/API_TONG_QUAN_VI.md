# Tổng quan API Face Swap AI

Tài liệu này mô tả đầy đủ các điểm cuối (endpoint) mà Cloudflare Worker cung cấp sau khi cập nhật cấu trúc phản hồi với trường `debug`.

## 1. POST `/faceswap`

### Nội dung yêu cầu

- `target_url` (string, bắt buộc): URL ảnh mục tiêu (preset).
- `source_url` (string, bắt buộc): URL ảnh nguồn (selfie).
- `mode` (string, tùy chọn): `rapidapi` hoặc `vertex`. Mặc định `rapidapi`.
- `api_provider` (string, tùy chọn): chấp nhận `google-nano-banana` để kích hoạt chế độ Vertex.
- `preset_image_id`, `preset_collection_id`, `preset_name` (string, tùy chọn): thông tin preset đã chọn.
- `selfie_id` (string, tùy chọn): mã selfie đã lưu trong cơ sở dữ liệu.
- `additional_prompt` (string, tùy chọn): câu mô tả bổ sung, được nối vào cuối trường `prompt` bằng ký tự `+` (chỉ áp dụng cho chế độ Vertex).
- `character_gender` (string, tùy chọn): `male`, `female` hoặc bỏ trống (`none`). Nếu truyền, hệ thống chèn mô tả giới tính tương ứng vào cuối `prompt`.

### Phản hồi thành công

```json
{
  "data": {
    "resultImageUrl": "https://.../results/result_123.jpg"
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
      "finalResultImageUrl": "https://.../results/result_123.jpg",
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
      "publicUrl": "https://.../results/result_123.jpg"
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
- `presetName` (string, tùy chọn): tên bộ sưu tập preset.
- `enableVertexPrompt` (boolean, tùy chọn): bật tạo prompt Vertex khi upload preset.

### Phản hồi

```json
{
  "uploadUrl": "https://<worker-domain>/upload-proxy/preset/example.jpg",
  "publicUrl": "https://pub-...r2.dev/preset/example.jpg",
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
- `X-Enable-Vertex-Prompt`, `X-Enable-Vision-Scan` (tùy chọn): bật Vertex/Vision.

### Phản hồi thành công (preset)

```json
{
  "success": true,
  "url": "https://.../preset/example.jpg",
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
  "url": "https://.../selfie/example.jpg",
  "id": "selfie_...",
  "filename": "example.jpg"
}
```

## 4. GET `/presets`

- Trả về danh sách preset trong cơ sở dữ liệu.
- Phản hồi dạng `{ "presets": [ { "id": "...", "image_url": "...", "prompt_json": "...", ... } ] }`.

## 5. DELETE `/presets/{id}`

- Xóa preset khỏi D1 và R2.
- Phản hồi:

```json
{
  "success": true,
  "message": "Preset deleted successfully",
  "debug": {
    "presetId": "...",
    "databaseDeleted": 1,
    "r2Deleted": true,
    "r2Key": "preset/example.jpg"
  }
}
```

## 6. GET `/selfies`

- Trả về tối đa 50 selfie gần nhất.
- Phản hồi dạng `{ "selfies": [ { "id": "...", "image_url": "...", "filename": "...", ... } ] }`.

## 7. DELETE `/selfies/{id}`

- Xóa selfie và kết quả liên quan.
- Phản hồi tương tự `/presets/{id}` với trường `debug` mô tả tác vụ.

## 8. GET `/results`

- Trả về tối đa 50 kết quả face swap gần nhất.
- Phản hồi: `{ "results": [ { "id": "...", "result_url": "...", ... } ] }`.

## 9. DELETE `/results/{id}`

- Xóa kết quả khỏi D1 và R2.
- Phản hồi:

```json
{
  "success": true,
  "message": "Result deleted successfully",
  "debug": {
    "resultId": "...",
    "databaseDeleted": 1,
    "r2Deleted": true,
    "r2Key": "results/result_123.jpg"
  }
}
```

## 10. GET `/vertex/get-prompt/{preset_image_id}`

- Trả về prompt đã lưu cho preset.
- Phản hồi:

```json
{
  "success": true,
  "presetImage": {
    "id": "...",
    "image_url": "...",
    "hasPrompt": true,
    "promptJson": { "...": "..." }
  }
}
```

## 11. POST `/test-safety`

- Body: `{ "image_url": "https://..." }`.
- Phản hồi: `{ "success": true, "imageUrl": "...", "result": { "isSafe": true, ... }, "timestamp": "..." }`.

## 12. GET `/test-vertex`

- Kiểm tra kết nối Vertex (liệt kê model).
- Phản hồi chứa trạng thái HTTP thực tế, danh sách model và lỗi nếu có.

---

Các phản hồi lỗi từ Worker đều tuân thủ một trong hai dạng:

1. Lỗi chung: `{ "Success": false, "Message": "...", "StatusCode": 500, "Debug": { ... } }` (đối với các endpoint cũ chưa chuyển sang cấu trúc mới).
2. Lỗi chuẩn hóa: `{ "data": null, "debug": { ... }, "status": "error", "message": "...", "code": 4xx/5xx }`.

Trường `debug` luôn chứa thông tin chi tiết giúp truy vết: endpoint gọi tới, thời gian phản hồi, payload gửi đi, phản hồi gốc (đã được khử dữ liệu nhạy cảm như base64) và các khóa phụ (`vertex`, `vision`, `storage`, `database`) tùy vào ngữ cảnh.

