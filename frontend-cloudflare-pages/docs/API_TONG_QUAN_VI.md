# Tổng quan API Face Swap AI

Tài liệu này mô tả đầy đủ các điểm cuối (endpoint) mà Cloudflare Worker cung cấp.

**Base URL:** `https://api.d.shotpix.app`

---

## Mục lục

- [Xác thực API](#xác-thực-api-api-authentication)
- [APIs cần tích hợp với mobile](#apis-cần-tích-hợp-với-mobile-22-apis)
- [Provider Aspect Ratio (Vertex / WaveSpeed)](#provider-aspect-ratio-vertex--wavespeed)
- [AI Model / Provider theo từng API](#ai-model--provider-theo-từng-api)
- [Error Codes Reference](#error-codes-reference)
- [API Endpoints (Chi tiết)](#api-endpoints-chi-tiết)
  - [1. Upload & Quản lý File](API_UPLOAD_VI.md)
  - [2. AI Processing](API_AI_PROCESSING_VI.md)
  - [3. Quản lý Profile](API_PROFILE_DATA_VI.md)
  - [4. Truy vấn Dữ liệu](API_PROFILE_DATA_VI.md#4-truy-vấn-dữ-liệu)
  - [5. Hệ thống & Cấu hình](API_SYSTEM_VI.md)
  - [6. Thanh toán & Subscription](API_BILLING_VI.md)
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
- POST `/remove-object`
- POST `/expression`
- POST `/expand`
- POST `/replace-object`
- POST `/remove-text`
- POST `/editor`
- POST `/hair-style`
- POST `/upload-url` (type=mask) - Upload mask image
- POST `/profiles` - Chỉ khi tạo profile mới
- GET `/profiles/{id}` - Chỉ khi lấy profile theo ID
- DELETE `/results/{id}` - Xóa result

**Lưu ý:**
- POST `/upload-url` (type=preset) không yêu cầu API key (backend only)
- Các endpoints khác không nằm trong danh sách trên không yêu cầu API key

---

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

## APIs cần tích hợp với mobile (22 APIs)

**Tổng số API endpoints: 30**

### APIs cần tích hợp với mobile (22 APIs)

1. POST `/upload-url` (type=selfie) - Upload selfie
2. POST `/upload-url` (type=mask) - Upload mask image (cho remove object)
3. POST `/faceswap` - Đổi mặt (Face Swap) - luôn dùng Vertex AI, hỗ trợ multiple selfies
4. POST `/background` - Tạo nền AI (AI Background)
5. POST `/enhance` - AI enhance ảnh (cải thiện chất lượng kỹ thuật)
6. POST `/beauty` - AI beautify ảnh (cải thiện thẩm mỹ khuôn mặt)
7. POST `/filter` - AI Filter (Styles) - Áp dụng style từ preset lên selfie
8. POST `/restore` - AI khôi phục và nâng cấp ảnh
9. POST `/aging` - AI lão hóa khuôn mặt
10. POST `/upscaler4k` - AI upscale ảnh lên 4K
11. POST `/remove-object` - AI xóa vật thể khỏi ảnh bằng mask
12. POST `/expression` - AI thay đổi biểu cảm khuôn mặt
13. POST `/expand` - AI mở rộng ảnh
14. POST `/replace-object` - AI thay thế vật thể trong ảnh
15. POST `/remove-text` - AI xóa text khỏi ảnh
16. POST `/hair-style` - AI thay đổi kiểu tóc
17. POST `/profiles` - Tạo profile
18. GET `/profiles/{id}` - Lấy profile (hỗ trợ cả Profile ID và Device ID)
19. PUT `/profiles/{id}` - Cập nhật profile (hỗ trợ phone)
20. DELETE `/profiles/{id}` - Xóa profile (yêu cầu xác minh: profile_id + user_id + email hoặc phone)
21. GET `/selfies` - Liệt kê selfies
21. GET `/results` - Liệt kê results (generated images)
22. DELETE `/results/{id}` - Xóa result

### APIs không cần tích hợp với mobile (11 APIs)

20. GET `/profiles` - Liệt kê profiles
21. POST `/upload-url` (type=preset) - Upload preset (backend only)
22. GET `/presets` - Liệt kê presets
23. GET `/presets/{id}` - Lấy preset theo ID (bao gồm prompt_json)
24. DELETE `/presets/{id}` - Xóa preset
25. DELETE `/selfies/{id}` - Xóa selfie
26. POST `/upload-thumbnails` - Tải lên thumbnails và presets (batch)
27. GET `/thumbnails` - Liệt kê thumbnails
28. GET `/thumbnails/{id}/preset` - Lấy preset_id từ thumbnail_id
29. GET `/config` - Lấy config
30. OPTIONS `/*` - CORS preflight requests

---

## Provider Aspect Ratio (Vertex / WaveSpeed)

Backend hỗ trợ hai provider: **Vertex AI** và **WaveSpeed**. Mỗi provider có cách xử lý aspect ratio và kích thước khác nhau.

### Vertex AI (Google)
- **Chỉ dùng tỷ lệ chuẩn.** Ảnh input được map sang tỷ lệ hỗ trợ gần nhất; tỷ lệ gốc có thể không giữ nguyên.
- **Tỷ lệ hỗ trợ:** 1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9.
- **Dùng khi:** Cần tỷ lệ chuẩn (9:16 stories, 1:1 posts, v.v.).

### WaveSpeed
- **Giữ nguyên tỷ lệ gốc.** Hỗ trợ custom dimensions 256–1536 px mỗi cạnh; scale tỷ lệ trong giới hạn.
- **Giới hạn:** Min 256px, max 1536px mỗi cạnh.
- **Dùng khi:** Cần giữ đúng tỷ lệ ảnh gốc, không crop méo.

### So sánh

| Feature | Vertex AI | WaveSpeed |
|---------|-----------|-----------|
| Aspect Ratio | Chỉ tỷ lệ chuẩn | Custom dimensions |
| Giữ tỷ lệ | Snap gần nhất | Giữ chính xác |
| Kích thước | Theo ratio | 256–1536px linh hoạt |

### Override theo request

Mọi endpoint AI có thể gửi `"provider": "vertex"`, `"provider": "wavespeed"` (Flux), hoặc `"provider": "wavespeed_gemini_2_5_flash_image"` (Gemini 2.5 Flash Image qua WaveSpeed). Mặc định theo env `IMAGE_PROVIDER`.

### Endpoints áp dụng

`/enhance`, `/beauty`, `/restore`, `/aging`, `/filter`, `/faceswap` — đều hỗ trợ cả hai provider với hành vi trên.

---

## AI Model / Provider theo từng API

| Endpoint | Provider URL | Điểm | Chi phí/lần | Custom Prompt | Vision |
|----------|-------------|------|-------------|---------------|--------|
| POST `/enhance` | `api.wavespeed.ai/api/v3/google/gemini-2.5-flash-image/edit` hoặc `.../flux-2-klein-9b/edit` | 2 | $0.038 / $0.016 | Không | Check Vision sau khi upload selfie. |
| POST `/restore` | `api.wavespeed.ai/api/v3/google/gemini-2.5-flash-image/edit` hoặc `.../flux-2-klein-9b/edit` | 2 | $0.038 / $0.016 | Không | Check Vision sau khi upload selfie. |
| POST `/upscaler4k` | `api.wavespeed.ai/api/v1/wavespeed-ai/image-upscaler` | 5 | $0.010 | Không | Check Vision sau khi upload selfie. |
| POST `/beauty` | `api.wavespeed.ai/api/v1/wavespeed-ai/flux-2-klein-9b/edit` | 2 | $0.016 | Không | Check Vision sau khi upload selfie. |
| POST `/filter` | `api.wavespeed.ai/api/v1/wavespeed-ai/flux-2-klein-9b/edit` | 3 | $0.016 | Có | Check Vision sau khi upload selfie. Check Vision kết quả sau khi gen ảnh. |
| POST `/faceswap` | `api.wavespeed.ai/api/v1/wavespeed-ai/flux-2-klein-9b/edit` | 5 | $0.016 | Có | Check Vision sau khi upload selfie. |
| POST `/expression` | Vertex AI Gemini (`aiplatform.googleapis.com`) | 1 | — | Không | Check Vision sau khi upload selfie. |
| POST `/hair-style` | `api.wavespeed.ai/api/v3/google/gemini-2.5-flash-image/edit` | 1 | $0.038 | Không | Check Vision sau khi upload selfie. |
| POST `/aging` | `api.wavespeed.ai/api/v3/google/gemini-2.5-flash-image/edit` | 1 | $0.038 | Có | Check Vision sau khi upload selfie. |
| POST `/remove-object` | `api.wavespeed.ai/api/v3/bria/eraser` | 1 | $0.040 | Không | Check Vision sau khi upload selfie. |
| POST `/background` | `api.wavespeed.ai/api/v3/bytedance/seedream-v4/edit-sequential` | 5 | $0.027 | Có | Check Vision sau khi upload selfie. Check Vision kết quả sau khi gen ảnh. |
| POST `/expand` | `api.wavespeed.ai/api/v1/wavespeed-ai/flux-2-klein-9b/edit` | 2 | $0.016 | Không | Check Vision sau khi upload selfie. |
| POST `/replace-object` | `api.wavespeed.ai/api/v1/wavespeed-ai/flux-2-klein-9b/edit` | 2 | $0.016 | Có | Check Vision sau khi upload selfie. Check Vision kết quả sau khi gen ảnh. |
| POST `/remove-text` | `api.wavespeed.ai/api/v3/google/gemini-2.5-flash-image/edit` | 1 | $0.038 | Không | Check Vision sau khi upload selfie. |
| POST `/editor` | `api.wavespeed.ai/api/v3/google/gemini-2.5-flash-image/edit` hoặc `.../flux-2-klein-9b/edit` | 5 | $0.016-$0.038 | Có | Check Vision sau khi upload selfie. Check Vision kết quả sau khi gen ảnh. |

---

## Error Codes Reference

### Vision API Safety Error Codes (1001-1005) & Flat Color Detection (1010)

Các error codes này được trả về khi Google Vision API SafeSearch phát hiện nội dung không phù hợp trong ảnh, hoặc khi phát hiện ảnh đơn sắc/flat color. Được sử dụng cho:
- POST `/upload-url` (type=selfie) - Kiểm tra **tất cả** ảnh selfie trước khi lưu (trừ custom prompt flow - kiểm tra sau khi generate xong)

| Error Code | Category | Mô tả |
|------------|----------|-------|
| **1001** | ADULT | Thể hiện khả năng nội dung dành cho người lớn của hình ảnh. Nội dung dành cho người lớn có thể bao gồm các yếu tố như khỏa thân, hình ảnh hoặc phim hoạt hình khiêu dâm, hoặc các hoạt động tình dục. |
| **1002** | VIOLENCE | Hình ảnh này có khả năng chứa nội dung bạo lực. Nội dung bạo lực có thể bao gồm cái chết, thương tích nghiêm trọng hoặc tổn hại đến cá nhân hoặc nhóm cá nhân. |
| **1003** | RACY | Khả năng cao hình ảnh được yêu cầu chứa nội dung khiêu dâm. Nội dung khiêu dâm có thể bao gồm (nhưng không giới hạn) quần áo mỏng manh hoặc xuyên thấu, khỏa thân được che đậy một cách khéo léo, tư thế tục tĩu hoặc khiêu khích, hoặc cận cảnh các vùng nhạy cảm trên cơ thể. |
| **1004** | MEDICAL | Rất có thể đây là hình ảnh y tế. |
| **1005** | SPOOF | Xác suất chế giễu. Xác suất xảy ra việc chỉnh sửa phiên bản gốc của hình ảnh để làm cho nó trông hài hước hoặc phản cảm. |
| **1010** | FLAT_COLOR | Ảnh chỉ chứa màu đơn sắc/flat color, không có đối tượng hoặc người. Ảnh này bị chặn để ngăn chặn lạm dụng tạo nội dung không phù hợp từ canvas trống. Kiểm tra dựa trên: tỉ lệ nén (bytes/pixel), entropy byte data, và số lượng byte unique. |

#### Tìm kiếm An toàn (Safe Search)

Tập hợp các đặc điểm liên quan đến hình ảnh, được tính toán bằng các phương pháp thị giác máy tính trên các lĩnh vực tìm kiếm an toàn (ví dụ: người lớn, giả mạo, y tế, bạo lực).

**Các trường (Fields):**

- **adult** (Likelihood): Thể hiện khả năng nội dung dành cho người lớn của hình ảnh. Nội dung dành cho người lớn có thể bao gồm các yếu tố như khỏa thân, hình ảnh hoặc phim hoạt hình khiêu dâm, hoặc các hoạt động tình dục.

- **spoof** (Likelihood): Xác suất chế giễu. Xác suất xảy ra việc chỉnh sửa phiên bản gốc của hình ảnh để làm cho nó trông hài hước hoặc phản cảm.

- **medical** (Likelihood): Rất có thể đây là hình ảnh y tế.

- **violence** (Likelihood): Hình ảnh này có khả năng chứa nội dung bạo lực. Nội dung bạo lực có thể bao gồm cái chết, thương tích nghiêm trọng hoặc tổn hại đến cá nhân hoặc nhóm cá nhân.

- **racy** (Likelihood): Khả năng cao hình ảnh được yêu cầu chứa nội dung khiêu dâm. Nội dung khiêu dâm có thể bao gồm (nhưng không giới hạn) quần áo mỏng manh hoặc xuyên thấu, khỏa thân được che đậy một cách khéo léo, tư thế tục tĩu hoặc khiêu khích, hoặc cận cảnh các vùng nhạy cảm trên cơ thể.

#### Severity Levels (Độ nghiêm trọng)

Google Vision API SafeSearch trả về mức độ nghiêm trọng cho mỗi field (adult, violence, racy, medical, spoof). App kiểm tra **tất cả các fields** và sử dụng **mức độ cao nhất** trong bất kỳ field nào để quyết định có chặn ảnh hay không:

| Severity Level | Giá trị | Mô tả | Có bị chặn? |
|----------------|---------|-------|-------------|
| **VERY_UNLIKELY** | -1 | Không có nội dung nhạy cảm, chắc chắn | ✅ **Cho phép** |
| **UNLIKELY** | 0 | Không có nội dung nhạy cảm, nhưng chưa chắc chắn | ✅ **Cho phép** |
| **POSSIBLE** | 1 | Có thể có nội dung nhạy cảm, nhưng chưa chắc chắn | ❌ **Chặn** |
| **LIKELY** | 2 | Có nội dung nhạy cảm, chắc chắn | ❌ **Chặn** |
| **VERY_LIKELY** | 3 | Có nội dung nhạy cảm, chắc chắn | ❌ **Chặn** |

**Cách hoạt động:**
- App kiểm tra tất cả 5 fields: `adult`, `violence`, `racy`, `medical`, `spoof`
- Nếu **bất kỳ field nào** có level là `POSSIBLE`, `LIKELY`, hoặc `VERY_LIKELY` → Ảnh bị chặn
- `statusCode` (1001-1005) được trả về dựa trên field có **mức độ cao nhất** (worst violation)
- Error code mapping: `adult`=1001, `violence`=1002, `racy`=1003, `medical`=1004, `spoof`=1005

**Ví dụ:**

**Ví dụ 1 - Ảnh bị chặn:**
```json
{
  "adult": "VERY_UNLIKELY",
  "violence": "POSSIBLE",
  "racy": "UNLIKELY",
  "medical": "VERY_UNLIKELY",
  "spoof": "VERY_UNLIKELY"
}
```
→ **Kết quả:** Bị chặn vì `violence` có level `POSSIBLE`. Trả về `code: 1002` (violence).

**Ví dụ 2 - Ảnh bị chặn (nhiều violations):**
```json
{
  "adult": "LIKELY",
  "violence": "POSSIBLE",
  "racy": "VERY_LIKELY",
  "medical": "UNLIKELY",
  "spoof": "VERY_UNLIKELY"
}
```
→ **Kết quả:** Bị chặn. `racy` có level cao nhất (`VERY_LIKELY`), nên trả về `code: 1003` (racy).

**Ví dụ 3 - Ảnh được phép:**
```json
{
  "adult": "VERY_UNLIKELY",
  "violence": "UNLIKELY",
  "racy": "VERY_UNLIKELY",
  "medical": "UNLIKELY",
  "spoof": "VERY_UNLIKELY"
}
```
→ **Kết quả:** Được phép vì tất cả fields đều là `VERY_UNLIKELY` hoặc `UNLIKELY`.

**Ví dụ Response khi bị chặn:**
```json
{
  "data": null,
  "status": "error",
  "message": "Upload failed",
  "code": 1001
}
```

---

### Vertex AI Safety Error Codes (2001-2004)

Các error codes này được trả về khi Vertex AI Gemini safety filters chặn generated image. Được sử dụng cho:
- POST `/faceswap` - Khi Vertex AI chặn generated image
- POST `/background` - Khi Vertex AI chặn generated image
- POST `/enhance` - Khi Vertex AI chặn generated image
- POST `/beauty` - Khi Vertex AI chặn generated image
- POST `/filter` - Khi Vertex AI chặn generated image
- POST `/restore` - Khi Vertex AI chặn generated image
- POST `/aging` - Khi Vertex AI chặn generated image

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

| Mức độ tin cậy | Giá trị | Mô tả | Có bị chặn? |
|----------------|---------|-------|-------------|
| **NEGLIGIBLE** | Rất thấp | Khả năng có nội dung gây hại là không đáng kể | ✅ **Cho phép** |
| **LOW** | Thấp | Khả năng có nội dung gây hại là thấp | ✅ **Cho phép** |
| **MEDIUM** | Trung bình | Khả năng có nội dung gây hại là trung bình | ✅ **Cho phép** |
| **HIGH** | Cao | Khả năng có nội dung gây hại là cao | ❌ **Chặn** |

#### Safety Threshold Configuration

**Cấu hình hiện tại:**
- ✅ **Cho phép**: `NEGLIGIBLE`, `LOW`, `MEDIUM`
- ❌ **Chặn**: `HIGH` only

**Áp dụng cho tất cả các loại tác hại:**
- HARM_CATEGORY_HATE_SPEECH (Lời lẽ kích động thù hận)
- HARM_CATEGORY_HARASSMENT (Quấy rối)
- HARM_CATEGORY_SEXUALLY_EXPLICIT (Nội dung khiêu dâm)
- HARM_CATEGORY_DANGEROUS_CONTENT (Nội dung nguy hiểm)

**Lưu ý:**
- App chỉ chặn nội dung khi phát hiện vi phạm với `HIGH` confidence level
- Nội dung với `NEGLIGIBLE`, `LOW`, hoặc `MEDIUM` confidence level đều được cho phép
- Safety violations trả về HTTP 422 với internal error codes 2001-2004 trong trường `code`
- Message trả về từ Vertex AI API response (có thể là finishMessage, refusalText, hoặc generic message)

**Ví dụ Response:**
```json
{
  "data": null,
  "status": "error",
  "message": "Processing failed",
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
| **422** | Unprocessable Entity - Content bị chặn (sử dụng error codes 1001-1005, 1010 hoặc 2001-2004) |
| **429** | Rate Limit Exceeded - Vượt quá giới hạn request |
| **500** | Internal Server Error - Lỗi server |

**Lưu ý:**
- Error codes 1001-1005, 1010 và 2001-2004 được trả về trong trường `code` của response body
- HTTP status code luôn là 422 cho các safety violations (content bị chặn)
- Chi tiết về violation có thể được tìm thấy trong `debug.vision` (cho Vision API) hoặc `debug.provider` (cho Vertex AI)

---

## Tổng kết

**Tổng số API endpoints: 33**

Xem danh sách đầy đủ tại [APIs cần tích hợp với mobile](#apis-cần-tích-hợp-với-mobile-22-apis) ở đầu tài liệu.

---

## Custom Domain

- **Worker API Domain**: `https://api.d.shotpix.app` - Dùng cho tất cả API endpoints
- **R2 Public Domain**: `https://resources.d.shotpix.app` - Dùng cho public URLs của files trong R2 bucket
- Format R2 public URL: `https://resources.d.shotpix.app/{bucket-name}/{key}`
