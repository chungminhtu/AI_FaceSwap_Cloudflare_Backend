# Tổng quan API Face Swap AI

Tài liệu này mô tả đầy đủ các điểm cuối (endpoint) mà Cloudflare Worker cung cấp.

**Base URL:** `https://api.d.shotpix.app`

---

## Mục lục

- [Xác thực API](#xác-thực-api-api-authentication)
- [APIs cần tích hợp với mobile](#apis-cần-tích-hợp-với-mobile-11-apis)
- [Error Codes Reference](#error-codes-reference)
- [API Endpoints (Chi tiết)](#api-endpoints-chi-tiết)
  - [1. Upload & Quản lý File](#1-upload--quản-lý-file)
  - [2. AI Processing](#2-ai-processing)
  - [3. Quản lý Profile](#3-quản-lý-profile)
  - [4. Truy vấn Dữ liệu](#4-truy-vấn-dữ-liệu)
  - [5. Hệ thống & Cấu hình](#5-hệ-thống--cấu-hình)
- [Tổng kết](#tổng-kết)

---

## Xác thực API (API Authentication)

### Mobile API Key Authentication

Hệ thống hỗ trợ xác thực bằng API key cho các mobile APIs. Tính năng này có thể được bật/tắt thông qua biến môi trường `ENABLE_MOBILE_API_KEY_AUTH`.

**Khi bật (`ENABLE_MOBILE_API_KEY_AUTH=true`):**
- Các mobile APIs được bảo vệ yêu cầu API key trong request header
- API key có thể được gửi qua:
  - Header `X-API-Key`: `X-API-Key: your_api_key_here`
  - Header `Authorization`: `Authorization: Bearer your_api_key_here`

**Các endpoints được bảo vệ (khi authentication được bật):**
- POST `/upload-url` (type=selfie) - Chỉ khi upload selfie
- POST `/faceswap`
- POST `/background`
- POST `/enhance`
- POST `/beauty`
- POST `/filter`
- POST `/restore`
- POST `/aging`
- POST `/upscaler4k`
- POST `/profiles` - Chỉ khi tạo profile mới
- GET `/profiles/{id}` - Chỉ khi lấy profile theo ID

**Lưu ý:**
- POST `/upload-url` (type=preset) không yêu cầu API key (backend only)
- Các endpoints khác không nằm trong danh sách trên không yêu cầu API key

**Tạo API Key:**

Sử dụng script `generate-api-key.js` để tạo API key mới:

```bash
node backend-cloudflare-workers/generate-api-key.js
```

Script sẽ tạo một API key ngẫu nhiên 32 bytes (256 bits) và hiển thị hướng dẫn thêm vào `deployments-secrets.json`:

```json
{
  "MOBILE_API_KEY": "your_generated_key_here",
  "ENABLE_MOBILE_API_KEY_AUTH": "true"
}
```

**Ví dụ request với API key:**

```bash
curl -X POST https://api.d.shotpix.app/faceswap \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_ids": ["selfie_1234567890_xyz789"],
    "profile_id": "profile_1234567890"
  }'
```

Hoặc sử dụng Authorization header:

```bash
curl -X POST https://api.d.shotpix.app/faceswap \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_api_key_here" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_ids": ["selfie_1234567890_xyz789"],
    "profile_id": "profile_1234567890"
  }'
```

**Error Response (401 Unauthorized):**

Khi API key không hợp lệ hoặc thiếu:

```json
{
  "data": null,
  "status": "error",
  "message": "Unauthorized",
  "code": 401
}
```

---

## APIs cần tích hợp với mobile (11 APIs)

**Tổng số API endpoints: 26**

### APIs cần tích hợp với mobile (11 APIs)

1. POST `/upload-url` (type=selfie) - Upload selfie
2. POST `/faceswap` - Đổi mặt (Face Swap) - luôn dùng Vertex AI, hỗ trợ multiple selfies
3. POST `/background` - Tạo nền AI (AI Background)
4. POST `/enhance` - AI enhance ảnh (cải thiện chất lượng kỹ thuật)
5. POST `/beauty` - AI beautify ảnh (cải thiện thẩm mỹ khuôn mặt)
6. POST `/filter` - AI Filter (Styles) - Áp dụng style từ preset lên selfie
7. POST `/restore` - AI khôi phục và nâng cấp ảnh
8. POST `/aging` - AI lão hóa khuôn mặt
9. POST `/upscaler4k` - AI upscale ảnh lên 4K
10. POST `/profiles` - Tạo profile
11. GET `/profiles/{id}` - Lấy profile

### APIs không cần tích hợp với mobile (15 APIs)

12. PUT `/profiles/{id}` - Cập nhật profile
13. GET `/profiles` - Liệt kê profiles
14. POST `/upload-url` (type=preset) - Upload preset (backend only)
15. GET `/presets` - Liệt kê presets
16. GET `/presets/{id}` - Lấy preset theo ID (bao gồm prompt_json)
17. DELETE `/presets/{id}` - Xóa preset
18. GET `/selfies` - Liệt kê selfies
19. DELETE `/selfies/{id}` - Xóa selfie
20. GET `/results` - Liệt kê results
21. DELETE `/results/{id}` - Xóa result
22. POST `/upload-thumbnails` - Tải lên thumbnails và presets (batch)
23. GET `/thumbnails` - Liệt kê thumbnails
24. GET `/thumbnails/{id}/preset` - Lấy preset_id từ thumbnail_id
25. GET `/config` - Lấy config
26. OPTIONS `/*` - CORS preflight requests

---

## Error Codes Reference

### Vision API Safety Error Codes (1001-1005)

Các error codes này được trả về khi Google Vision API SafeSearch phát hiện nội dung không phù hợp trong ảnh. Được sử dụng cho:
- POST `/upload-url` (type=selfie, action="4k" hoặc "4K") - Kiểm tra ảnh selfie trước khi lưu
- POST `/faceswap` - Kiểm tra ảnh kết quả (nếu Vision scan được bật)
- POST `/background` - Kiểm tra ảnh kết quả (nếu Vision scan được bật)

| Error Code | Category | Mô tả |
|------------|----------|-------|
| **1001** | ADULT | Thể hiện khả năng nội dung dành cho người lớn của hình ảnh. Nội dung dành cho người lớn có thể bao gồm các yếu tố như khỏa thân, hình ảnh hoặc phim hoạt hình khiêu dâm, hoặc các hoạt động tình dục. |
| **1002** | VIOLENCE | Hình ảnh này có khả năng chứa nội dung bạo lực. Nội dung bạo lực có thể bao gồm cái chết, thương tích nghiêm trọng hoặc tổn hại đến cá nhân hoặc nhóm cá nhân. |
| **1003** | RACY | Khả năng cao hình ảnh được yêu cầu chứa nội dung khiêu dâm. Nội dung khiêu dâm có thể bao gồm (nhưng không giới hạn) quần áo mỏng manh hoặc xuyên thấu, khỏa thân được che đậy một cách khéo léo, tư thế tục tĩu hoặc khiêu khích, hoặc cận cảnh các vùng nhạy cảm trên cơ thể. |
| **1004** | MEDICAL | Rất có thể đây là hình ảnh y tế. |
| **1005** | SPOOF | Xác suất chế giễu. Xác suất xảy ra việc chỉnh sửa phiên bản gốc của hình ảnh để làm cho nó trông hài hước hoặc phản cảm. |

#### Tìm kiếm An toàn (Safe Search)

Tập hợp các đặc điểm liên quan đến hình ảnh, được tính toán bằng các phương pháp thị giác máy tính trên các lĩnh vực tìm kiếm an toàn (ví dụ: người lớn, giả mạo, y tế, bạo lực).

**Các trường (Fields):**

- **adult** (Likelihood): Thể hiện khả năng nội dung dành cho người lớn của hình ảnh. Nội dung dành cho người lớn có thể bao gồm các yếu tố như khỏa thân, hình ảnh hoặc phim hoạt hình khiêu dâm, hoặc các hoạt động tình dục.

- **spoof** (Likelihood): Xác suất chế giễu. Xác suất xảy ra việc chỉnh sửa phiên bản gốc của hình ảnh để làm cho nó trông hài hước hoặc phản cảm.

- **medical** (Likelihood): Rất có thể đây là hình ảnh y tế.

- **violence** (Likelihood): Hình ảnh này có khả năng chứa nội dung bạo lực. Nội dung bạo lực có thể bao gồm cái chết, thương tích nghiêm trọng hoặc tổn hại đến cá nhân hoặc nhóm cá nhân.

- **racy** (Likelihood): Khả năng cao hình ảnh được yêu cầu chứa nội dung khiêu dâm. Nội dung khiêu dâm có thể bao gồm (nhưng không giới hạn) quần áo mỏng manh hoặc xuyên thấu, khỏa thân được che đậy một cách khéo léo, tư thế tục tĩu hoặc khiêu khích, hoặc cận cảnh các vùng nhạy cảm trên cơ thể.

#### Severity Levels (Độ nghiêm trọng)

Google Vision API SafeSearch trả về các mức độ nghiêm trọng cho mỗi category. App sử dụng các mức độ này để quyết định có chặn ảnh hay không:

| Severity Level | Giá trị | Mô tả | Có bị chặn? |
|----------------|---------|-------|-------------|
| **VERY_UNLIKELY** | -1 | Không có nội dung nhạy cảm, chắc chắn | ❌ Không |
| **UNLIKELY** | 0 | Không có nội dung nhạy cảm, nhưng chưa chắc chắn | ❌ Không |
| **POSSIBLE** | 1 | Có thể có nội dung nhạy cảm, nhưng chưa chắc chắn | ✅ Có (chỉ trong strict mode) |
| **LIKELY** | 2 | Có nội dung nhạy cảm, chắc chắn | ✅ Có (chỉ trong strict mode) |
| **VERY_LIKELY** | 3 | Có nội dung nhạy cảm, chắc chắn | ✅ Có (cả strict và lenient mode) |

#### Strictness Modes (Chế độ kiểm tra)

App hỗ trợ 2 chế độ kiểm tra, được cấu hình qua biến môi trường `SAFETY_STRICTNESS`:

**Strict Mode (Mặc định):**
- Chặn: `POSSIBLE`, `LIKELY`, và `VERY_LIKELY`
- Cho phép: `VERY_UNLIKELY`, `UNLIKELY`
- Sử dụng khi: `SAFETY_STRICTNESS=strict` hoặc không set (default)

**Lenient Mode:**
- Chặn: `VERY_LIKELY` only
- Cho phép: `VERY_UNLIKELY`, `UNLIKELY`, `POSSIBLE`, `LIKELY`
- Sử dụng khi: `SAFETY_STRICTNESS=lenient`

**Lưu ý:**
- `statusCode` (1001-1005) chỉ được trả về khi nội dung thực sự bị chặn
- Trong strict mode, `POSSIBLE`, `LIKELY`, và `VERY_LIKELY` đều bị chặn
- Trong lenient mode, chỉ `VERY_LIKELY` bị chặn

**Ví dụ Response:**
```json
{
  "data": null,
  "status": "error",
  "message": "Content blocked: Image contains adult content (VERY_LIKELY)",
  "code": 1001
}
```

---

### Vertex AI Safety Error Codes (2001-2004)

Các error codes này được trả về khi Vertex AI Gemini safety filters chặn nội dung trong prompt hoặc generated image. Được sử dụng cho:
- POST `/faceswap` - Khi Vertex AI chặn prompt hoặc generated image
- POST `/background` - Khi Vertex AI chặn prompt hoặc generated image
- POST `/enhance` - Khi Vertex AI chặn prompt hoặc generated image
- POST `/beauty` - Khi Vertex AI chặn prompt hoặc generated image
- POST `/filter` - Khi Vertex AI chặn prompt hoặc generated image
- POST `/restore` - Khi Vertex AI chặn prompt hoặc generated image
- POST `/aging` - Khi Vertex AI chặn prompt hoặc generated image

#### Các loại tác hại

Bộ lọc nội dung đánh giá nội dung dựa trên các loại tác hại sau:

| Error Code | Loại nguy hiểm | Sự định nghĩa |
|------------|----------------|---------------|
| **2001** | Lời lẽ kích động thù hận | Những bình luận tiêu cực hoặc gây hại nhắm vào danh tính và/hoặc các thuộc tính được bảo vệ. |
| **2002** | Quấy rối | Những lời lẽ đe dọa, hăm dọa, bắt nạt hoặc lăng mạ nhắm vào người khác. |
| **2003** | Nội dung khiêu dâm | Có chứa nội dung liên quan đến hành vi tình dục hoặc các nội dung khiêu dâm khác. |
| **2004** | Nội dung nguy hiểm | Thúc đẩy hoặc tạo điều kiện tiếp cận các hàng hóa, dịch vụ và hoạt động có hại. |

#### So sánh điểm xác suất và điểm mức độ nghiêm trọng (Probability Scores and Severity Scores)

Điểm an toàn xác suất phản ánh khả năng phản hồi của mô hình có liên quan đến tác hại tương ứng. Nó có một điểm tin cậy tương ứng nằm trong khoảng từ **0.0 đến 1.0**, được làm tròn đến một chữ số thập phân.

Điểm tin cậy được chia thành bốn mức độ tin cậy:

| Mức độ tin cậy | Mô tả |
|----------------|-------|
| **NEGLIGIBLE** | Rất thấp - Khả năng có nội dung gây hại là không đáng kể |
| **LOW** | Thấp - Khả năng có nội dung gây hại là thấp |
| **MEDIUM** | Trung bình - Khả năng có nội dung gây hại là trung bình |
| **HIGH** | Cao - Khả năng có nội dung gây hại là cao |

**Lưu ý:**
- App chặn nội dung khi Vertex AI trả về `HIGH` hoặc `MEDIUM` probability
- Nội dung với `LOW` hoặc `NEGLIGIBLE` probability thường được cho phép
- Chi tiết về probability level có thể được tìm thấy trong `debug.provider` hoặc `debug.vertex` của response

**Ví dụ Response (Input Blocked):**
```json
{
  "data": null,
  "status": "error",
  "message": "Content blocked: hate speech - Input blocked: SAFETY",
  "code": 2001
}
```

**Ví dụ Response (Output Blocked):**
```json
{
  "data": null,
  "status": "error",
  "message": "Content blocked: sexually explicit - Output blocked: SAFETY - HARM_CATEGORY_SEXUALLY_EXPLICIT (HIGH)",
  "code": 2003
}
```

---

### HTTP Status Codes

Ngoài các error codes trên, API cũng trả về các HTTP status codes chuẩn:

| Status Code | Mô tả |
|-------------|-------|
| **200** | Success |
| **400** | Bad Request - Request không hợp lệ |
| **401** | Unauthorized - API key không hợp lệ hoặc thiếu (khi `ENABLE_MOBILE_API_KEY_AUTH=true`) |
| **422** | Unprocessable Entity - Content bị chặn (sử dụng error codes 1001-1005 hoặc 2001-2004) |
| **429** | Rate Limit Exceeded - Vượt quá giới hạn request |
| **500** | Internal Server Error - Lỗi server |

**Lưu ý:**
- Error codes 1001-1005 và 2001-2004 được trả về trong trường `code` của response body
- HTTP status code có thể là 422 hoặc chính error code (1001-1005, 2001-2004) tùy thuộc vào implementation
- Chi tiết về violation có thể được tìm thấy trong `debug.vision` (cho Vision API) hoặc `debug.provider` (cho Vertex AI)

---

## API Endpoints (Chi tiết)

### 1. Upload & Quản lý File

#### 1.1. POST `/upload-url` (type=selfie) - Upload selfie

**Mục đích:** Tải ảnh selfie trực tiếp lên server và lưu vào database. Endpoint này được sử dụng bởi mobile app để upload selfie.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true` (chỉ áp dụng cho `type=selfie`).

**Request:**

**Upload selfie với action:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "X-API-Key: your_api_key_here" \
  -F "files=@/path/to/selfie.jpg" \
  -F "type=selfie" \
  -F "profile_id=profile_1234567890" \
  -F "action=faceswap"
```

**Multipart/form-data:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -F "files=@/path/to/selfie.jpg" \
  -F "type=selfie" \
  -F "profile_id=profile_1234567890"
```

**JSON với image_url:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "image_url": "https://example.com/selfie.jpg",
    "type": "selfie",
    "profile_id": "profile_1234567890",
    "action": "faceswap"
  }'
```

**Request Parameters:**
- `files` (file[], required nếu dùng multipart): Mảng file ảnh selfie cần upload (hỗ trợ nhiều file).
- `image_url` hoặc `image_urls` (string/string[], required nếu dùng JSON): URL ảnh selfie trực tiếp.
- `type` (string, required): Phải là `"selfie"` cho mobile app.
- `profile_id` (string, required): ID profile người dùng.
- `action` (string, optional, chỉ áp dụng cho `type=selfie`): Loại action của selfie. Mặc định: `"faceswap"`. 
  - `"faceswap"`: Tối đa 8 ảnh (có thể cấu hình), tự động xóa ảnh cũ khi upload ảnh mới (giữ lại số ảnh mới nhất theo giới hạn). **Không kiểm tra Vision API.**
  - `"wedding"`: Tối đa 2 ảnh, tự động xóa ảnh cũ khi upload ảnh mới (giữ lại 1 ảnh mới nhất). **Không kiểm tra Vision API.**
  - `"4k"` hoặc `"4K"`: Tối đa 1 ảnh, tự động xóa ảnh cũ khi upload ảnh mới. **Ảnh sẽ được kiểm tra bằng Vision API trước khi lưu vào database.**
  - Các action khác: Tối đa 1 ảnh, tự động xóa ảnh cũ khi upload ảnh mới. **Không kiểm tra Vision API.**

**Response (Success 200):**
```json
{
  "data": {
    "results": [
      {
        "id": "selfie_1234567890_xyz789",
        "url": "https://resources.d.shotpix.app/faceswap-images/selfie/example.jpg",
        "filename": "example.jpg"
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

**Response (Error - Vision API Blocked):**
Khi ảnh selfie không vượt qua kiểm tra an toàn của Vision API, endpoint sẽ trả về error code tương ứng với loại vi phạm:

```json
{
  "data": null,
  "status": "error",
  "message": "Upload failed",
  "code": 1001
}
```

**Lưu ý quan trọng:**
- **Vision API Error Codes (1001-1005):** Chỉ selfie uploads với `action="4k"` hoặc `action="4K"` mới được quét bởi Vision API trước khi lưu vào database. Các action khác (như `"faceswap"`, `"wedding"`, `"default"`, v.v.) **không** được kiểm tra bằng Vision API. Xem chi tiết error codes tại [Vision API Safety Error Codes](#vision-api-safety-error-codes-1001-1005).
- **Vertex AI Error Codes (2001-2004):** Được trả về khi Vertex AI Gemini safety filters chặn nội dung trong prompt hoặc generated image. Áp dụng cho các endpoints: `/faceswap`, `/background`, `/enhance`, `/beauty`, `/filter`, `/restore`, `/aging`. Xem chi tiết error codes tại [Vertex AI Safety Error Codes](#vertex-ai-safety-error-codes-2001-2004).
- Scan level mặc định: `strict` (chặn `POSSIBLE`, `LIKELY`, và `VERY_LIKELY` violations)
- Nếu ảnh không an toàn, file sẽ bị xóa khỏi R2 storage và trả về error code tương ứng
- Error code được trả về trong trường `code` của response
- **Giới hạn số lượng selfie:** Mỗi action có giới hạn riêng và tự động xóa ảnh cũ khi vượt quá giới hạn:
  - `faceswap`: Tối đa 8 ảnh (có thể cấu hình qua `SELFIE_MAX_FACESWAP`)
  - `wedding`: Tối đa 2 ảnh (cấu hình qua `SELFIE_MAX_WEDDING`)
  - `4k`/`4K`: Tối đa 1 ảnh (cấu hình qua `SELFIE_MAX_4K`)
  - Các action khác: Tối đa 1 ảnh (cấu hình qua `SELFIE_MAX_OTHER`)

---

#### 1.2. POST `/upload-url` (type=preset) - Upload preset (backend only)

**Mục đích:** Tải ảnh preset trực tiếp lên server và lưu vào database với xử lý tự động (Vision scan, Vertex prompt generation sử dụng Gemini 3 Flash Preview). Endpoint này chỉ được sử dụng bởi backend, không cần test trên mobile.

**Authentication:** Không yêu cầu API key.

**Request:**

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

**Request Parameters:**
- `files` (file[], required nếu dùng multipart): Mảng file ảnh preset cần upload (hỗ trợ nhiều file).
- `image_url` hoặc `image_urls` (string/string[], required nếu dùng JSON): URL ảnh preset trực tiếp.
- `type` (string, required): Phải là `"preset"` cho backend upload.
- `profile_id` (string, required): ID profile người dùng.
- `enableVertexPrompt` (boolean/string, optional): `true` hoặc `"true"` để bật tạo prompt Vertex khi upload preset. Sử dụng Gemini 3 Flash Preview để phân tích ảnh và tạo prompt_json tự động.

**Response:**
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

---

#### 1.3. POST `/upload-thumbnails` - Upload thumbnails (backend only)

**Mục đích:** Tải lên thư mục chứa thumbnails (WebP và Lottie JSON) và original presets. Hỗ trợ batch upload nhiều file cùng lúc.

**Authentication:** Không yêu cầu API key.

**Request:**
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

**Response:**
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

---

### 2. AI Processing

#### 2.1. POST `/faceswap` - Face Swap

**Mục đích:** Thực hiện face swap giữa ảnh preset và ảnh selfie sử dụng Vertex AI (luôn dùng chế độ Vertex). Hỗ trợ multiple selfies để tạo composite results (ví dụ: wedding photos với cả male và female).

**Lưu ý:** 
- Khác với `/background`: FaceSwap thay đổi khuôn mặt trong preset, còn AI Background merge selfie vào preset scene.
- Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**

**Sử dụng selfie_ids (từ database):**
```bash
curl -X POST https://api.d.shotpix.app/faceswap \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
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
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_image_urls": ["https://example.com/selfie1.jpg", "https://example.com/selfie2.jpg"],
    "profile_id": "profile_1234567890",
    "additional_prompt": "Add dramatic lighting and cinematic atmosphere",
    "character_gender": "male",
    "aspect_ratio": "16:9"
  }'
```

**Request Parameters:**
- `preset_image_id` (string, required): ID ảnh preset đã lưu trong database (format: `preset_...`).
- `selfie_ids` (array of strings, optional): Mảng các ID ảnh selfie đã lưu trong database (hỗ trợ multiple selfies). Thứ tự: [selfie_chính, selfie_phụ] - selfie đầu tiên sẽ được face swap vào preset, selfie thứ hai (nếu có) sẽ được sử dụng làm tham chiếu bổ sung.
- `selfie_image_urls` (array of strings, optional): Mảng các URL ảnh selfie trực tiếp (thay thế cho `selfie_ids`). Hỗ trợ multiple selfies. Phải cung cấp `selfie_ids` HOẶC `selfie_image_urls` (không phải cả hai).
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình (mặc định: "3:4"). Hỗ trợ: "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9".
- `model` (string | number, optional): Model để sử dụng. "2.5" hoặc 2.5 cho Gemini 2.5 Flash (mặc định), "3" hoặc 3 cho Gemini 3 Pro.
- `additional_prompt` (string, optional): câu mô tả bổ sung, được nối vào cuối trường `prompt` bằng ký tự `+`.
- `character_gender` (string, optional): `male`, `female` hoặc bỏ trống. Nếu truyền, hệ thống chèn mô tả giới tính tương ứng vào cuối `prompt`.

**Response:**
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

**Error Responses:** Xem [Error Codes Reference](#error-codes-reference)

---

#### 2.2. POST `/background` - AI Background

**Mục đích:** Tạo ảnh mới bằng cách merge selfie (người) vào preset (cảnh nền) sử dụng AI. Selfie sẽ được đặt vào preset scene một cách tự nhiên với nền AI được tạo tự động. Hỗ trợ 3 cách cung cấp nền: preset_image_id (từ database), preset_image_url (URL trực tiếp), hoặc custom_prompt (tạo nền từ text prompt sử dụng Vertex AI).

**Lưu ý:** Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**

**Sử dụng selfie_id (từ database):**
```bash
curl -X POST https://api.d.shotpix.app/background \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
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
curl -X POST https://api.d.shotpix.app/background \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_image_url": "https://example.com/selfie.png",
    "profile_id": "profile_1234567890",
    "additional_prompt": "Make the person look happy and relaxed",
    "aspect_ratio": "16:9"
  }'
```

**Sử dụng custom_prompt (tạo nền từ text prompt với Vertex AI):**
```bash
curl -X POST https://api.d.shotpix.app/background \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "custom_prompt": "A beautiful sunset beach scene with palm trees and golden sand",
    "selfie_id": "selfie_1234567890_xyz789",
    "profile_id": "profile_1234567890",
    "additional_prompt": "Make the person look happy and relaxed",
    "aspect_ratio": "16:9",
    "model": "2.5"
  }'
```

**Sử dụng custom_prompt với selfie_image_url:**
```bash
curl -X POST https://api.d.shotpix.app/background \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "custom_prompt": "A futuristic cityscape at night with neon lights and flying cars",
    "selfie_image_url": "https://example.com/selfie.png",
    "profile_id": "profile_1234567890",
    "aspect_ratio": "16:9"
  }'
```

**Lưu ý về custom_prompt:**
- Khi sử dụng `custom_prompt`, hệ thống sẽ thực hiện 2 bước:
  1. **Tạo ảnh nền**: Sử dụng Vertex AI Gemini (gemini-2.5-flash-image hoặc gemini-3-pro-image-preview) để tạo ảnh nền từ text prompt
  2. **Merge selfie**: Tự động merge selfie vào ảnh nền vừa tạo với lighting và color grading phù hợp
- `custom_prompt` không thể kết hợp với `preset_image_id` hoặc `preset_image_url` (chỉ chọn một trong ba)
- `aspect_ratio` và `model` sẽ được áp dụng cho cả việc tạo nền và merge
- `additional_prompt` chỉ ảnh hưởng đến bước merge, không ảnh hưởng đến việc tạo nền

**Request Parameters:**
- `preset_image_id` (string, optional): ID ảnh preset (landscape scene) đã lưu trong database (format: `preset_...`). Phải cung cấp `preset_image_id` HOẶC `preset_image_url` HOẶC `custom_prompt` (chỉ một trong ba).
- `preset_image_url` (string, optional): URL ảnh preset trực tiếp (thay thế cho `preset_image_id`). Phải cung cấp `preset_image_id` HOẶC `preset_image_url` HOẶC `custom_prompt` (chỉ một trong ba).
- `custom_prompt` (string, optional): Prompt tùy chỉnh để tạo ảnh nền từ text sử dụng Vertex AI (thay thế cho preset image). Khi sử dụng `custom_prompt`, hệ thống sẽ:
  1. Tạo ảnh nền từ text prompt bằng Vertex AI Gemini (gemini-2.5-flash-image hoặc gemini-3-pro-image-preview)
  2. Merge selfie vào ảnh nền đã tạo
  Phải cung cấp `preset_image_id` HOẶC `preset_image_url` HOẶC `custom_prompt` (chỉ một trong ba).
- `selfie_id` (string, optional): ID ảnh selfie đã lưu trong database (người). Phải cung cấp `selfie_id` HOẶC `selfie_image_url` (không phải cả hai).
- `selfie_image_url` (string, optional): URL ảnh selfie trực tiếp (thay thế cho `selfie_id`).
- `profile_id` (string, required): ID profile người dùng.
- `additional_prompt` (string, optional): Câu mô tả bổ sung cho việc merge (ví dụ: "Make the person look happy", "Adjust lighting to match sunset"). Chỉ áp dụng cho bước merge, không ảnh hưởng đến việc tạo nền từ `custom_prompt`.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Các giá trị hỗ trợ: `"original"`, `"1:1"`, `"3:2"`, `"2:3"`, `"3:4"`, `"4:3"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"21:9"`. Mặc định: `"3:4"`. Khi sử dụng `custom_prompt`, tỷ lệ này sẽ được áp dụng cho cả việc tạo nền và merge.
- `model` (string | number, optional): Model để sử dụng cho cả việc tạo nền (nếu dùng `custom_prompt`) và merge. "2.5" hoặc 2.5 cho Gemini 2.5 Flash Image (mặc định), "3" hoặc 3 cho Gemini 3 Pro Image Preview.

**Response:**
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

**Error Responses:** Xem [Error Codes Reference](#error-codes-reference)

---

#### 2.3. POST `/enhance` - AI Enhance

**Mục đích:** AI enhance ảnh - cải thiện chất lượng, độ sáng, độ tương phản và chi tiết của ảnh.

**Lưu ý:** 
- Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.
- Các endpoints không phải faceswap (`/enhance`, `/beauty`, `/filter`, `/restore`, `/aging`, `/background`) hỗ trợ giá trị `"original"` cho `aspect_ratio`.
- Khi `aspect_ratio` là `"original"` hoặc không được cung cấp, hệ thống sẽ tự động:
  1. Lấy kích thước (width/height) từ ảnh input
  2. Tính toán tỷ lệ khung hình thực tế
  3. Chọn tỷ lệ gần nhất trong danh sách hỗ trợ của Vertex AI
  4. Sử dụng tỷ lệ đó để generate ảnh
- Điều này đảm bảo ảnh kết quả giữ được tỷ lệ gần với ảnh gốc thay vì mặc định về 1:1.
- **Các giá trị hỗ trợ:** `"original"`, `"1:1"`, `"3:2"`, `"2:3"`, `"3:4"`, `"4:3"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"21:9"`. Mặc định: `"original"`.

**Request:**
```bash
curl -X POST https://api.d.shotpix.app/enhance \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
    "profile_id": "profile_1234567890",
    "aspect_ratio": "1:1",
    "model": "2.5"
  }'
```

**Request Parameters:**
- `image_url` (string, required): URL ảnh cần enhance.
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Xem [Lưu ý về Aspect Ratio](#23-post-enhance---ai-enhance) cho chi tiết. Mặc định: `"original"`.
- `model` (string | number, optional): Model để sử dụng. "2.5" hoặc 2.5 cho Gemini 2.5 Flash (mặc định), "3" hoặc 3 cho Gemini 3 Pro.

**Response:**
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

**Error Responses:** Xem [Error Codes Reference](#error-codes-reference)

---

#### 2.4. POST `/beauty` - AI Beauty

**Mục đích:** AI beautify ảnh - cải thiện thẩm mỹ khuôn mặt (lý tưởng cho selfies và chân dung). Làm mịn da, xóa mụn, làm sáng mắt, tinh chỉnh khuôn mặt một cách tự nhiên.

**Lưu ý:** Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**
```bash
curl -X POST https://api.d.shotpix.app/beauty \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
    "profile_id": "profile_1234567890",
    "aspect_ratio": "1:1",
    "model": "2.5"
  }'
```

**Request Parameters:**
- `image_url` (string, required): URL ảnh cần beautify.
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Xem [Lưu ý về Aspect Ratio](#23-post-enhance---ai-enhance) cho chi tiết. Mặc định: `"original"`.
- `model` (string | number, optional): Model để sử dụng. "2.5" hoặc 2.5 cho Gemini 2.5 Flash (mặc định), "3" hoặc 3 cho Gemini 3 Pro.

**Response:**
```json
{
  "data": {
    "id": "result_1234567890_abc123",
    "resultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/beauty_123.jpg"
  },
  "status": "success",
  "message": "Image beautification completed",
  "code": 200,
  "debug": {
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Beautification completed"
    }
  }
}
```

**Tính năng AI Beauty:**
- Làm mịn da (smooth skin)
- Xóa mụn và vết thâm (removes blemishes/acne)
- Đều màu da (evens skin tone)
- Làm thon mặt và đường viền hàm một cách tinh tế (slims face/jawline subtly)
- Làm sáng mắt (brightens eyes)
- Tăng cường môi và lông mày (enhances lips and eyebrows)
- Mở rộng mắt nhẹ (enlarges eyes slightly, optional)
- Làm mềm hoặc chỉnh hình mũi (softens or reshapes nose)
- Tự động điều chỉnh makeup (adjusts makeup automatically)

**Lưu ý:** AI Beauty tập trung vào cải thiện thẩm mỹ khuôn mặt, khác với AI Enhance (cải thiện chất lượng kỹ thuật như độ sắc nét, giảm nhiễu).

**Error Responses:** Xem [Error Codes Reference](#error-codes-reference)

---

#### 2.5. POST `/filter` - AI Filter (Styles)

**Mục đích:** AI Filter (Styles) - Áp dụng các style sáng tạo hoặc điện ảnh từ preset lên selfie trong khi giữ nguyên tính toàn vẹn khuôn mặt. Sử dụng prompt_json từ preset để áp dụng style.

**Lưu ý:** Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**
```bash
curl -X POST https://api.d.shotpix.app/filter \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_id": "selfie_1234567890_xyz789",
    "profile_id": "profile_1234567890",
    "aspect_ratio": "1:1",
    "additional_prompt": "Add dramatic lighting"
  }'
```

**Hoặc sử dụng selfie_image_url:**
```bash
curl -X POST https://api.d.shotpix.app/filter \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "preset_image_id": "preset_1234567890_abc123",
    "selfie_image_url": "https://resources.d.shotpix.app/faceswap-images/selfie/selfie_001.png",
    "profile_id": "profile_1234567890"
  }'
```

**Request Parameters:**
- `preset_image_id` (string, required): ID preset đã lưu trong database (format: `preset_...`). Preset phải có prompt_json.
- `selfie_id` (string, optional): ID selfie đã lưu trong database. Bắt buộc nếu không có `selfie_image_url`.
- `selfie_image_url` (string, optional): URL ảnh selfie trực tiếp. Bắt buộc nếu không có `selfie_id`.
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Xem [Lưu ý về Aspect Ratio](#23-post-enhance---ai-enhance) cho chi tiết. Mặc định: `"original"`.
- `model` (string | number, optional): Model để sử dụng. "2.5" hoặc 2.5 cho Gemini 2.5 Flash (mặc định), "3" hoặc 3 cho Gemini 3 Pro.
- `additional_prompt` (string, optional): Prompt bổ sung để tùy chỉnh style.

**Response:**
```json
{
  "data": {
    "id": "result_1234567890_abc123",
    "resultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/filter_123.jpg"
  },
  "status": "success",
  "message": "Style filter applied successfully",
  "code": 200,
  "debug": {
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Filter applied"
    }
  }
}
```

**Tính năng AI Filter:**
- Đọc prompt_json từ preset (chứa thông tin về style, lighting, composition, camera, background)
- Áp dụng style sáng tạo/điện ảnh từ preset lên selfie
- Giữ nguyên 100% khuôn mặt, đặc điểm, cấu trúc xương, màu da
- Chỉ thay đổi style, môi trường, ánh sáng, màu sắc, và mood hình ảnh
- Hỗ trợ additional_prompt để tùy chỉnh thêm

**Lưu ý:**
- Preset phải có prompt_json (được tạo tự động khi upload preset với `enableVertexPrompt=true` sử dụng Gemini 3 Flash Preview)
- Nếu preset chưa có prompt_json, API sẽ tự động generate từ preset image sử dụng Gemini 3 Flash Preview
- Khác với `/faceswap`: Filter giữ nguyên khuôn mặt và chỉ áp dụng style, không thay đổi khuôn mặt

**Error Responses:** Xem [Error Codes Reference](#error-codes-reference)

---

#### 2.6. POST `/restore` - AI Restore

**Mục đích:** AI khôi phục và nâng cấp ảnh - phục hồi ảnh bị hư hỏng, cũ, mờ, hoặc đen trắng thành ảnh chất lượng cao với màu sắc sống động.

**Lưu ý:** Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**
```bash
curl -X POST https://api.d.shotpix.app/restore \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
    "profile_id": "profile_1234567890",
    "aspect_ratio": "1:1",
    "model": "2.5"
  }'
```

**Request Parameters:**
- `image_url` (string, required): URL ảnh cần khôi phục (ảnh cũ, bị hư hỏng, mờ, hoặc đen trắng).
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Xem [Lưu ý về Aspect Ratio](#23-post-enhance---ai-enhance) cho chi tiết. Mặc định: `"original"`.
- `model` (string | number, optional): Model để sử dụng. "2.5" hoặc 2.5 cho Gemini 2.5 Flash (mặc định), "3" hoặc 3 cho Gemini 3 Pro.

**Response:**
```json
{
  "data": {
    "id": "result_1234567890_abc123",
    "resultImageUrl": "https://resources.d.shotpix.app/faceswap-images/results/restore_123.jpg"
  },
  "status": "success",
  "message": "Image restoration completed",
  "code": 200,
  "debug": {
    "provider": {
      "success": true,
      "statusCode": 200,
      "message": "Restoration completed"
    }
  }
}
```

**Tính năng AI Restore:**
- Khôi phục ảnh bị hư hỏng (fix scratches, tears, noise, blurriness)
- Chuyển đổi ảnh đen trắng thành màu với màu sắc sống động
- Nâng cấp chất lượng lên 16K DSLR quality
- Tăng cường chi tiết (face, eyes, hair, clothing)
- Thêm ánh sáng, bóng đổ, và độ sâu trường ảnh thực tế
- Retouching chuyên nghiệp cấp Photoshop
- High dynamic range, ultra-HD, lifelike textures

**Error Responses:** Xem [Error Codes Reference](#error-codes-reference)

---

#### 2.7. POST `/aging` - AI Aging

**Mục đích:** AI lão hóa khuôn mặt - tạo phiên bản già hơn của khuôn mặt trong ảnh.

**Lưu ý:** Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**
```bash
curl -X POST https://api.d.shotpix.app/aging \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
    "age_years": 20,
    "profile_id": "profile_1234567890"
  }'
```

**Request Parameters:**
- `image_url` (string, required): URL ảnh chứa khuôn mặt cần lão hóa.
- `age_years` (number, optional): Số năm muốn lão hóa (mặc định: 20).
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Xem [Lưu ý về Aspect Ratio](#23-post-enhance---ai-enhance) cho chi tiết. Mặc định: `"original"`.
- `model` (string | number, optional): Model để sử dụng. "2.5" hoặc 2.5 cho Gemini 2.5 Flash (mặc định), "3" hoặc 3 cho Gemini 3 Pro.

**Response:**
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

**Error Responses:** Xem [Error Codes Reference](#error-codes-reference)

---

#### 2.8. POST `/upscaler4k` - AI Upscale 4K

**Mục đích:** Upscale ảnh lên độ phân giải 4K sử dụng WaveSpeed AI.

**Lưu ý:** Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**
```bash
curl -X POST https://api.d.shotpix.app/upscaler4k \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "image_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
    "profile_id": "profile_1234567890"
  }'
```

**Request Parameters:**
- `image_url` (string, required): URL ảnh cần upscale.
- `profile_id` (string, required): ID profile người dùng.

**Response:**
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

**Error Responses:** Xem [Error Codes Reference](#error-codes-reference)

---

### 3. Quản lý Profile

#### 3.1. POST `/profiles` - Tạo profile

**Mục đích:** Tạo profile mới.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**

**Minimal (chỉ cần device_id):**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "device_id": "device_1765774126587_yaq0uh6rvz"
  }'
```

**Full request:**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
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
  -H "X-API-Key: your_api_key_here" \
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
  -H "X-API-Key: your_api_key_here" \
  -H "x-device-id: device_1765774126587_yaq0uh6rvz" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com"
  }'
```

**Request Parameters:**
- `device_id` (string, optional): ID thiết bị. Có thể gửi trong body hoặc header `x-device-id`. Nếu không có, sẽ là `null`.
- `userID` hoặc `id` (string, optional): ID profile. Nếu không có, hệ thống tự tạo bằng `nanoid(16)`.
- `name` (string, optional): tên profile.
- `email` (string, optional): email.
- `avatar_url` (string, optional): URL avatar.
- `preferences` (string hoặc object, optional): preferences dạng JSON string hoặc object. Nếu là object, hệ thống tự động chuyển thành JSON string trước khi lưu vào D1 database (vì D1 không hỗ trợ JSON object trực tiếp).

**Response:**
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

---

#### 3.2. GET `/profiles/{id}` - Lấy profile

**Mục đích:** Lấy thông tin profile theo ID.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**
```bash
curl https://api.d.shotpix.app/profiles/profile_1234567890 \
  -H "X-API-Key: your_api_key_here"
```

**Response:**
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

---

#### 3.3. PUT `/profiles/{id}` - Cập nhật profile

**Mục đích:** Cập nhật thông tin profile.

**Authentication:** Không yêu cầu API key.

**Request:**
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

**Request Parameters:**
- `name` (string, optional): tên profile.
- `email` (string, optional): email.
- `avatar_url` (string, optional): URL avatar.
- `preferences` (string hoặc object, optional): preferences dạng JSON string hoặc object. Nếu là object, hệ thống tự động chuyển thành JSON string trước khi lưu vào D1 database (vì D1 không hỗ trợ JSON object trực tiếp).

**Lưu ý:** ID profile phải được cung cấp trong URL path (`/profiles/{id}`), không cần gửi trong body.

**Response:**
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

---

#### 3.4. GET `/profiles` - Liệt kê profiles

**Mục đích:** Liệt kê tất cả profiles (dùng cho admin/debugging).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/profiles
```

**Response:**
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

---

### 4. Truy vấn Dữ liệu

#### 4.1. GET `/presets` - Liệt kê presets

**Mục đích:** Trả về danh sách preset trong database.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/presets
curl https://api.d.shotpix.app/presets?include_thumbnails=true
```

**Query Parameters:**
- `include_thumbnails` (optional): `true` để bao gồm cả presets có thumbnail. Mặc định chỉ trả về presets không có thumbnail.

**Response:**
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

---

#### 4.2. GET `/presets/{id}` - Lấy preset theo ID

**Mục đích:** Lấy thông tin chi tiết của một preset theo ID (bao gồm `prompt_json`).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/presets/preset_1234567890_abc123
```

**Response:**
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
    "created_at": "2024-01-01T00:00:00.000Z"
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

---

#### 4.3. DELETE `/presets/{id}` - Xóa preset

**Mục đích:** Xóa preset khỏi D1 và R2.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl -X DELETE https://api.d.shotpix.app/presets/preset_1234567890_abc123
```

**Response:**
```json
{
  "data": null,
  "status": "success",
  "message": "Preset deleted successfully",
  "code": 200
}
```

---

#### 4.4. GET `/selfies` - Liệt kê selfies

**Mục đích:** Trả về tối đa 50 selfie gần nhất của một profile.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/selfies?profile_id=profile_1234567890
```

**Query Parameters:**
- `profile_id` (required): ID profile.
- `limit` (optional): Số lượng selfies tối đa trả về (1-50). Mặc định: 50.

**Response:**
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

---

#### 4.5. DELETE `/selfies/{id}` - Xóa selfie

**Mục đích:** Xóa selfie khỏi D1 và R2.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl -X DELETE https://api.d.shotpix.app/selfies/selfie_1234567890_xyz789
```

**Response:**
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

---

#### 4.6. GET `/results` - Liệt kê results

**Mục đích:** Trả về tối đa 50 kết quả face swap gần nhất.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/results
curl https://api.d.shotpix.app/results?profile_id=profile_1234567890
```

**Query Parameters:**
- `profile_id` (optional): ID profile để lọc kết quả.
- `limit` (optional): Số lượng results tối đa trả về (1-50). Mặc định: 50.
- `gender` (optional): Lọc theo giới tính. Giá trị: `male` hoặc `female`.

**Response:**
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

---

#### 4.7. DELETE `/results/{id}` - Xóa result

**Mục đích:** Xóa kết quả khỏi D1 và R2.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl -X DELETE https://api.d.shotpix.app/results/result_1234567890_abc123
```

**Response:**
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

---

#### 4.8. GET `/thumbnails` - Liệt kê thumbnails

**Mục đích:** Lấy danh sách thumbnails từ database. Trả về tất cả presets có thumbnail (bất kỳ cột thumbnail nào không null).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/thumbnails
```

**Query Parameters:**
- Không có query parameters. Endpoint trả về tất cả presets có thumbnail.

**Lưu ý:** Endpoint này query từ bảng `presets` với điều kiện có bất kỳ cột thumbnail nào không null (`thumbnail_url`, `thumbnail_url_1x`, `thumbnail_url_1_5x`, `thumbnail_url_2x`, `thumbnail_url_3x`).

**Response:**
```json
{
  "data": {
    "thumbnails": [
      {
        "id": "preset_1234567890_abc123",
        "preset_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
        "thumbnail_url": "https://resources.d.shotpix.app/webp_1x/face-swap/wedding_both_1.webp",
        "thumbnail_url_1x": "https://resources.d.shotpix.app/webp_1x/face-swap/wedding_both_1.webp",
        "thumbnail_url_1_5x": null,
        "thumbnail_url_2x": null,
        "thumbnail_url_3x": null,
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "status": "success",
  "message": "Thumbnails retrieved successfully",
  "code": 200
}
```

**Lưu ý:** Response trả về tất cả các cột thumbnail resolution (1x, 1.5x, 2x, 3x) từ database. `thumbnail_url` là alias của `thumbnail_url_1x` cho backward compatibility.

---

#### 4.9. GET `/thumbnails/{id}/preset` - Lấy preset_id từ thumbnail_id

**Mục đích:** Lấy preset_id từ thumbnail_id (dùng cho mobile app).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/thumbnails/preset_1234567890_abc123/preset
```

**Response:**
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

---

### 5. Hệ thống & Cấu hình

#### 5.1. GET `/config` - Lấy config

**Mục đích:** Lấy cấu hình public của Worker (custom domains).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/config
```

**Response:**
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

---

#### 5.2. OPTIONS `/*` - CORS preflight requests

**Mục đích:** Xử lý CORS preflight requests cho tất cả các endpoints. Tự động được gọi bởi trình duyệt khi thực hiện cross-origin requests.

**Authentication:** Không yêu cầu API key.

**Response:**

Trả về HTTP 204 (No Content) với các headers CORS:
- `Access-Control-Allow-Origin`: Cho phép tất cả origins
- `Access-Control-Allow-Methods`: GET, POST, PUT, DELETE, OPTIONS
- `Access-Control-Allow-Headers`: Content-Type, Authorization, X-API-Key, và các headers khác
- `Access-Control-Max-Age`: 86400 (24 giờ)

Endpoint `/upload-proxy/*` có hỗ trợ thêm method PUT trong CORS headers.

---

## Tổng kết

**Tổng số API endpoints: 26**

Xem danh sách đầy đủ tại [APIs cần tích hợp với mobile](#apis-cần-tích-hợp-với-mobile-11-apis) ở đầu tài liệu.

---

## Custom Domain

- **Worker API Domain**: `https://api.d.shotpix.app` - Dùng cho tất cả API endpoints
- **R2 Public Domain**: `https://resources.d.shotpix.app` - Dùng cho public URLs của files trong R2 bucket
- Format R2 public URL: `https://resources.d.shotpix.app/{bucket-name}/{key}`
