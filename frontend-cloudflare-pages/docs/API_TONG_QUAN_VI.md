# Tổng quan API Face Swap AI

Tài liệu này mô tả đầy đủ các điểm cuối (endpoint) mà Cloudflare Worker cung cấp.

**Base URL:** `https://api.d.shotpix.app`

---

## Mục lục

- [Xác thực API](#xác-thực-api-api-authentication)
- [APIs cần tích hợp với mobile](#apis-cần-tích-hợp-với-mobile-15-apis)
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
- DELETE `/results/{id}` - Xóa result

**Lưu ý:**
- POST `/upload-url` (type=preset) không yêu cầu API key (backend only)
- Các endpoints khác không nằm trong danh sách trên không yêu cầu API key

---

## Silent Push Notifications (FCM)

Hệ thống hỗ trợ gửi silent push notifications (không hiển thị notification bar) cho Web, Android, và iOS thông qua Firebase Cloud Messaging (FCM).

### Đặc Điểm

- **Silent Push:** Không hiển thị notification bar, app xử lý data trong background
- **Multi-Device:** Một profile có thể có nhiều devices (phone, tablet, web)
- **Auto-Cleanup:** Tự động xóa invalid tokens (app uninstall, token expired)
- **Profile-Based:** Push gửi đến tất cả devices của một profile
- **High Performance:** OAuth tokens được cache trong KV (55 phút)

### Endpoints

#### 1. Đăng Ký Device (POST /api/device/register)

**URL:** `POST /api/device/register`

**Auth:** None (public endpoint)

**Request Body:**
```json
{
  "profile_id": "profile_1234567890",
  "platform": "android",
  "token": "fcm-device-token-here",
  "app_version": "1.0.0"
}
```

**Fields:**
- `profile_id` (string, required): ID của profile (từ `/profiles`)
- `platform` (string, required): `android`, `ios`, hoặc `web`
- `token` (string, required): FCM device token
- `app_version` (string, optional): Version của app

**Response Success (200):**
```json
{
  "data": { "registered": true },
  "status": "success",
  "message": "Processing successful",
  "code": 200
}
```

**Errors:**
- `400`: Missing fields hoặc invalid platform
- `404`: Profile không tồn tại
- `500`: Database error

**Ví dụ:**
```bash
curl -X POST https://api.d.shotpix.app/api/device/register \
  -H "Content-Type: application/json" \
  -d '{
    "profile_id": "profile_abc123",
    "platform": "web",
    "token": "fcm-web-token-xyz",
    "app_version": "1.0.0"
  }'
```

---

#### 2. Gửi Silent Push (POST /api/push/silent)

**URL:** `POST /api/push/silent`

**Auth:** Requires `X-API-Key` header (MOBILE_API_KEY từ deployments-secrets.json)

**Request Body:**
```json
{
  "profile_id": "profile_1234567890",
  "data": {
    "type": "operation_complete",
    "operation": "faceswap",
    "status": "success",
    "result_id": "result_xyz"
  },
  "exclude_token": "current-device-fcm-token"
}
```

**Fields:**
- `profile_id` (string, required): ID của profile nhận push
- `data` (object, required): Custom data payload (tất cả values phải là string)
- `exclude_token` (string, optional): Token của device hiện tại, sẽ không gửi push cho device này

**Response Success (200):**
```json
{
  "data": {
    "sent": 2,
    "failed": 0,
    "cleaned": 1,
    "results": [
      { "token": "token1", "platform": "android", "success": true },
      { "token": "token2", "platform": "ios", "success": true }
    ]
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200
}
```

**Response Fields:**
- `sent`: Số devices nhận push thành công
- `failed`: Số devices thất bại
- `cleaned`: Số tokens invalid đã xóa khỏi database

**Errors:**
- `401`: Invalid API key
- `400`: Missing fields
- `500`: FCM error hoặc database error

**Ví dụ:**
```bash
curl -X POST https://api.d.shotpix.app/api/push/silent \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-mobile-api-key-here" \
  -d '{
    "profile_id": "profile_abc123",
    "data": {
      "type": "balance_sync",
      "amount": "100",
      "timestamp": "1706900000"
    }
  }'
```

---

#### 3. Hủy Đăng Ký Device (DELETE /api/device/unregister)

**URL:** `DELETE /api/device/unregister`

**Auth:** None (public endpoint)

**Request Body:**
```json
{
  "token": "fcm-device-token-to-remove"
}
```

**Response Success (200):**
```json
{
  "data": { "unregistered": true },
  "status": "success",
  "message": "Processing successful",
  "code": 200
}
```

**Ví dụ:**
```bash
curl -X DELETE https://api.d.shotpix.app/api/device/unregister \
  -H "Content-Type: application/json" \
  -d '{
    "token": "fcm-device-token-xyz"
  }'
```

---

### Auto-Push Sau Mỗi Operation

**Tất cả API operations sẽ tự động gửi silent push sau khi hoàn thành:**

- `/faceswap` → Push với `type: "operation_complete", operation: "faceswap"`
- `/beauty` → Push với `type: "operation_complete", operation: "beauty"`
- `/filter` → Push với `type: "operation_complete", operation: "filter"`
- `/upscaler4k` → Push với `type: "operation_complete", operation: "upscale"`
- `/background` → Push với `type: "operation_complete", operation: "background"`

**Push Data Structure:**
```json
{
  "type": "operation_complete",
  "operation": "faceswap",
  "status": "success",
  "result_id": "result_1234567890",
  "timestamp": "1706900000"
}
```

**Nếu operation thất bại:**
```json
{
  "type": "operation_complete",
  "operation": "faceswap",
  "status": "error",
  "error": "Error message here",
  "timestamp": "1706900000"
}
```

---

### Test UI

**URL:** `https://your-domain.com/fcm-test.html`

Test UI cung cấp:
- ✅ Đăng ký FCM token (Web)
- 📤 Gửi test push
- 📝 View logs realtime
- ❌ Hủy đăng ký device

---

### Mobile/Web Integration

**Docs đầy đủ:** [FCM_SETUP_VI.md](./FCM_SETUP_VI.md) và [FCM_QUICK_SETUP.md](./FCM_QUICK_SETUP.md)

**Web (Firebase SDK):**
```javascript
import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';

const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

// Get token
const token = await getToken(messaging, { vapidKey: 'YOUR_VAPID_KEY' });

// Register with backend
await fetch('/api/device/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    profile_id: userProfileId,
    platform: 'web',
    token: token
  })
});

// Listen for foreground messages
onMessage(messaging, (payload) => {
  console.log('Received:', payload.data);
  // Handle data (refresh UI, update balance, etc.)
});
```

**Android (Kotlin):**
```kotlin
// Register on app startup
FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
    if (task.isSuccessful) {
        ApiService.registerDevice(
            profileId = UserSession.getProfileId(),
            platform = "android",
            token = task.result
        )
    }
}

// Handle data-only message
class MyFirebaseMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        when (data["type"]) {
            "operation_complete" -> handleOperationComplete(data)
            "balance_sync" -> BalanceRepository.updateBalance(data["amount"])
        }
    }
}
```

**iOS (Swift):**
```swift
// Register on app startup
Messaging.messaging().token { token, error in
    guard let token = token else { return }
    ApiService.registerDevice(
        profileId: UserSession.shared.profileId,
        platform: "ios",
        token: token
    )
}

// Handle silent push
func application(_ application: UIApplication,
                 didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                 fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    let type = userInfo["type"] as? String
    switch type {
    case "operation_complete":
        handleOperationComplete(userInfo)
        completionHandler(.newData)
    default:
        completionHandler(.noData)
    }
}
```

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

## APIs cần tích hợp với mobile (15 APIs)

**Tổng số API endpoints: 26**

### APIs cần tích hợp với mobile (15 APIs)

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
11. GET `/profiles/{id}` - Lấy profile (hỗ trợ cả Profile ID và Device ID)
12. PUT `/profiles/{id}` - Cập nhật profile
13. GET `/selfies` - Liệt kê selfies
14. GET `/results` - Liệt kê results (generated images)
15. DELETE `/results/{id}` - Xóa result

### APIs không cần tích hợp với mobile (11 APIs)

16. GET `/profiles` - Liệt kê profiles
17. POST `/upload-url` (type=preset) - Upload preset (backend only)
18. GET `/presets` - Liệt kê presets
19. GET `/presets/{id}` - Lấy preset theo ID (bao gồm prompt_json)
20. DELETE `/presets/{id}` - Xóa preset
21. DELETE `/selfies/{id}` - Xóa selfie
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
| **422** | Unprocessable Entity - Content bị chặn (sử dụng error codes 1001-1005 hoặc 2001-2004) |
| **429** | Rate Limit Exceeded - Vượt quá giới hạn request |
| **500** | Internal Server Error - Lỗi server |

**Lưu ý:**
- Error codes 1001-1005 và 2001-2004 được trả về trong trường `code` của response body
- HTTP status code luôn là 422 cho các safety violations (content bị chặn)
- Chi tiết về violation có thể được tìm thấy trong `debug.vision` (cho Vision API) hoặc `debug.provider` (cho Vertex AI)

---

## API Endpoints (Chi tiết)

### 1. Upload & Quản lý File

#### 1.1. POST `/upload-url` (type=selfie) - Upload selfie

**Mục đích:** Tải ảnh selfie trực tiếp lên server và lưu vào database. Endpoint này được sử dụng bởi mobile app để upload selfie.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true` (chỉ áp dụng cho `type=selfie`).

**Request:**

**Upload single selfie với action:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "X-API-Key: your_api_key_here" \
  -F "files=@/path/to/selfie.jpg" \
  -F "type=selfie" \
  -F "profile_id=profile_1234567890" \
  -F "action=faceswap" \
  -F "dimensions=1024x768"
```

**Upload multiple selfies với dimensions array:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "X-API-Key: your_api_key_here" \
  -F "files=@/path/to/selfie1.jpg" \
  -F "files=@/path/to/selfie2.jpg" \
  -F "type=selfie" \
  -F "profile_id=profile_1234567890" \
  -F "action=faceswap" \
  -F 'dimensions=["1024x768", "800x600"]'
```

**JSON với image_urls và dimensions array:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "image_urls": ["https://example.com/selfie1.jpg", "https://example.com/selfie2.jpg"],
    "type": "selfie",
    "profile_id": "profile_1234567890",
    "action": "faceswap",
    "dimensions": ["1024x768", "800x600"]
  }'
```

**Request Parameters:**
- `files` (file[], required nếu dùng multipart): Mảng file ảnh selfie cần upload (hỗ trợ nhiều file).
- `image_url` hoặc `image_urls` (string/string[], required nếu dùng JSON): URL ảnh selfie trực tiếp.
- `type` (string, required): Phải là `"selfie"` cho mobile app.
- `profile_id` (string, required): ID profile người dùng.
- `action` (string, required, chỉ áp dụng cho `type=selfie`): Loại action của selfie. Phải được chỉ định rõ ràng. Các giá trị hỗ trợ:
  - `"faceswap"`: Tối đa 8 ảnh (có thể cấu hình), tự động xóa ảnh cũ khi upload ảnh mới (giữ lại số ảnh mới nhất theo giới hạn). **Không kiểm tra Vision API.**
  - `"wedding"`: Tối đa 2 ảnh, tự động xóa ảnh cũ khi upload ảnh mới (giữ lại 1 ảnh mới nhất). **Không kiểm tra Vision API.**
  - `"4k"` hoặc `"4K"`: Tối đa 1 ảnh, tự động xóa ảnh cũ khi upload ảnh mới. **Ảnh sẽ được kiểm tra bằng Vision API trước khi lưu vào database.**
  - Các action khác: Tối đa 1 ảnh, tự động xóa ảnh cũ khi upload ảnh mới. **Không kiểm tra Vision API.**
- `dimensions` (string | string[], optional): Kích thước ảnh selfie theo định dạng `"widthxheight"` (ví dụ: `"1024x768"`). Được sử dụng để truyền kích thước ảnh gốc cho WaveSpeed API khi thực hiện face swap, giúp giữ nguyên tỷ lệ và kích thước ảnh đầu ra. Nếu không cung cấp, WaveSpeed API sẽ tự động xác định kích thước từ ảnh đầu vào.
  - **Cho single file**: Có thể truyền string đơn: `"1024x768"`
  - **Cho multiple files**: Truyền JSON array cùng thứ tự với files: `["1024x768", "800x600", null]` (null cho file không xác định được kích thước)

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
- **Vertex AI Error Codes (2001-2004):** Được trả về khi Vertex AI Gemini safety filters chặn generated image. Áp dụng cho các endpoints: `/faceswap`, `/background`, `/enhance`, `/beauty`, `/filter`, `/restore`, `/aging`. Xem chi tiết error codes tại [Vertex AI Safety Error Codes](#vertex-ai-safety-error-codes-2001-2004).
- Chặn `POSSIBLE`, `LIKELY`, và `VERY_LIKELY` violations
- Nếu ảnh không an toàn, file sẽ bị xóa khỏi R2 storage và trả về error code tương ứng
- Error code được trả về trong trường `code` của response
- **Giới hạn số lượng selfie:** Mỗi action có giới hạn riêng và tự động xóa ảnh cũ khi vượt quá giới hạn:
  - `faceswap`: Tối đa 8 ảnh (có thể cấu hình qua `SELFIE_MAX_FACESWAP`)
  - `wedding`: Tối đa 2 ảnh (cấu hình qua `SELFIE_MAX_WEDDING`)
  - `4k`/`4K`: Tối đa 1 ảnh (cấu hình qua `SELFIE_MAX_4K`)
  - Các action khác: Tối đa 1 ảnh (cấu hình qua `SELFIE_MAX_OTHER`)

---

#### 1.2. POST `/upload-url` (type=preset) - Upload preset (backend only)

**Mục đích:** Tải ảnh preset trực tiếp lên server và lưu vào database với xử lý tự động (Vision scan, Vertex prompt generation). Endpoint này chỉ được sử dụng bởi backend, không cần test trên mobile.

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
- `enableVertexPrompt` (boolean/string, optional): `true` hoặc `"true"` để bật tạo prompt Vertex khi upload preset. Sử dụng Vertex AI để phân tích ảnh và tạo prompt_json tự động.
- `art_style` (string, optional): Filter art style cho prompt generation. Giá trị: `auto` (mặc định), `photorealistic`, `figurine`, `popmart`, `clay`, `disney`, `anime`, `chibi`, `watercolor`, `oil_painting`, `sketch`, `comic`, `pixel_art`, `cyberpunk`, `fantasy`, `vintage`, `minimalist`, `ghibli`, `lego`, `cartoon`.

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

**Mục đích:** Tải lên thumbnails (WebP và Lottie JSON) và tự động tạo presets. Hỗ trợ upload file zip chứa tất cả assets hoặc upload từng file riêng lẻ. Mỗi file sẽ trở thành một preset với filename làm preset_id. Vertex AI sẽ tự động phân tích ảnh WebP từ thư mục preset và tạo prompt_json metadata.

**Authentication:** Không yêu cầu API key.

**Upload individual files:**
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/preset/fs_wonder_f_3.png" \
  -F "path_preset_fs_wonder_f_3.png=preset/" \
  -F "files=@/path/to/lottie_1x/fs_wonder_f_3.json" \
  -F "path_lottie_1x_fs_wonder_f_3.json=lottie_1x/" \
  -F "files=@/path/to/lottie_avif_2x/fs_wonder_f_3.json" \
  -F "path_lottie_avif_2x_fs_wonder_f_3.json=lottie_avif_2x/" \
  -F "art_style=auto"
```

**Upload with Art Style Filter (e.g., Pop Mart style):**
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/preset/popmart_figure.png" \
  -F "path_popmart_figure.png=preset/" \
  -F "art_style=popmart"
```

**Upload zip file containing all assets:**
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/thumbnails.zip" \
  -F "art_style=disney"
```

**Supported Art Styles:**
| Style | Description |
|-------|-------------|
| `auto` | Auto-detect style (default) |
| `photorealistic` | Real photography |
| `figurine` | 3D figurine/toy |
| `popmart` | Pop Mart blind box |
| `clay` | Clay/plasticine animation |
| `disney` | Disney/Pixar 3D animation |
| `anime` | Japanese anime/manga |
| `chibi` | Chibi/super-deformed |
| `watercolor` | Watercolor painting |
| `oil_painting` | Classical oil painting |
| `sketch` | Pencil/charcoal sketch |
| `comic` | Western comic book |
| `pixel_art` | Retro pixel art |
| `cyberpunk` | Cyberpunk/neon futuristic |
| `fantasy` | Fantasy/magical illustration |
| `vintage` | Vintage/retro photography |
| `minimalist` | Minimalist/flat design |
| `ghibli` | Studio Ghibli animation |
| `lego` | LEGO minifigure |
| `cartoon` | General cartoon |

**Cấu trúc thư mục:**
```
├── preset/
│   ├── fs_wonder_f_3.png    # Files here get Vertex AI prompt generation
│   └── fs_wonder_m_2.png
├── lottie_1x/
│   ├── fs_wonder_f_3.json   # Thumbnails at 1x resolution
│   └── fs_wonder_m_2.json
├── lottie_1.5x/
│   ├── fs_wonder_f_3.json   # Thumbnails at 1.5x resolution
│   └── fs_wonder_m_2.json
├── lottie_2x/
│   ├── fs_wonder_f_3.json   # Thumbnails at 2x resolution
│   └── fs_wonder_m_2.json
├── lottie_avif_1x/
│   ├── fs_wonder_f_3.json   # AVIF thumbnails at 1x resolution
│   └── fs_wonder_m_2.json
└── [other resolution folders...]
```

**Quy tắc đặt tên file:**
- Format: `[preset_id].[png|webp|json]`
- Ví dụ: `fs_wonder_f_3.png`, `fs_wonder_m_2.webp`, `fireworks_animation.json`
- Tên file (không bao gồm extension) sẽ trở thành `preset_id`
- Vertex AI chỉ phân tích file ảnh từ thư mục "preset" để tạo `prompt_json` metadata
- File từ các thư mục resolution khác (lottie_*, lottie_avif_*) là thumbnails, KHÔNG được gửi đến Vertex AI

**Tính năng Vertex AI:**
- Tự động gọi Vertex AI Gemini để phân tích file ảnh từ thư mục "preset"
- Sử dụng `Promise.all` để xử lý batch upload và tạo prompt song song
- `prompt_json` được lưu trong R2 custom metadata của preset files
- Thumbnails được lưu ở nhiều resolution (1x, 1.5x, 2x, 3x, 4x) trong database
- Chỉ áp dụng cho file ảnh từ thư mục "preset", bỏ qua thumbnails

**Response:**
```json
{
  "data": {
    "total": 3,
    "successful": 3,
    "failed": 0,
    "thumbnails_processed": 3,
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
          "mood": "confident",
          "colors": ["red", "blue", "gold"]
        },
        "vertex_info": {
          "success": true,
          "promptKeys": ["scene", "style", "mood", "colors"]
        },
        "metadata": {
          "format": "webp"
        }
      },
      {
        "filename": "fs_wonder_f_3.json",
        "success": true,
        "type": "thumbnail",
        "preset_id": "fs_wonder_f_3",
        "url": "https://resources.d.shotpix.app/lottie_1x/fs_wonder_f_3.json",
        "hasPrompt": false,
        "vertex_info": {
          "success": false
        },
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
        "vertex_info": {
          "success": false
        },
        "metadata": {
          "format": "lottie",
          "resolution": "2x"
        }
      }
    ]
  },
  "status": "success",
  "message": "Processed 3 of 3 files",
  "code": 200,
  "debug": {
    "filesProcessed": 3,
    "resultsCount": 3
  }
}
```

---

### 2. AI Processing

#### 2.1. POST `/faceswap` - Face Swap

**Mục đích:** Thực hiện face swap giữa ảnh preset và ảnh selfie. Hỗ trợ multiple selfies để tạo composite results (ví dụ: wedding photos với cả male và female).

**Lưu ý:**
- Khác với `/background`: FaceSwap thay đổi khuôn mặt trong preset, còn AI Background merge selfie vào preset scene.
- Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Hành vi theo Provider:**
- **Vertex AI (mặc định):** Sử dụng `prompt_json` từ metadata của preset để thực hiện faceswap.
- **WaveSpeed (`provider: "wavespeed"`):** Không sử dụng `prompt_json`. Sử dụng prompt cố định:
  - **Single mode (1 selfie):** Gửi `[selfie, preset]` với prompt: "Put the person in image1 into image2, keep all the makeup same as preset."
  - **Couple mode (2 selfies):** Gửi `[selfie1, selfie2, preset]` với prompt: "Put both persons in image1 and image2 into image3, keep all the makeup same as preset."

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
    "aspect_ratio": "16:9"
  }'
```

**Request Parameters:**
- `preset_image_id` (string, required): ID ảnh preset đã lưu trong database (format: `preset_...`).
- `selfie_ids` (array of strings, optional): Mảng các ID ảnh selfie đã lưu trong database (hỗ trợ multiple selfies). Thứ tự: [selfie_chính, selfie_phụ] - selfie đầu tiên sẽ được face swap vào preset, selfie thứ hai (nếu có) sẽ được sử dụng làm tham chiếu bổ sung.
- `selfie_image_urls` (array of strings, optional): Mảng các URL ảnh selfie trực tiếp (thay thế cho `selfie_ids`). Hỗ trợ multiple selfies. Phải cung cấp `selfie_ids` HOẶC `selfie_image_urls` (không phải cả hai).
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình (mặc định: "3:4"). Hỗ trợ: "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9".
  - **Lưu ý về kích thước đầu ra (WaveSpeed provider):** Nếu `aspect_ratio` được chỉ định rõ ràng, hệ thống sẽ sử dụng aspect ratio đó. Nếu không chỉ định hoặc là "original", hệ thống sẽ sử dụng kích thước gốc của selfie (từ trường `dimensions` được lưu khi upload) để giữ nguyên kích thước ảnh đầu ra.
- `additional_prompt` (string, optional): câu mô tả bổ sung, được nối vào cuối trường `prompt` bằng ký tự `+`.

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
    "aspect_ratio": "16:9"
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
  1. **Tạo ảnh nền**: Sử dụng Vertex AI Gemini để tạo ảnh nền từ text prompt
  2. **Merge selfie**: Tự động merge selfie vào ảnh nền vừa tạo với lighting và color grading phù hợp
- `custom_prompt` không thể kết hợp với `preset_image_id` hoặc `preset_image_url` (chỉ chọn một trong ba)
- `aspect_ratio` và `model` sẽ được áp dụng cho cả việc tạo nền và merge

**Lưu ý về preset_image_id:**
- Hỗ trợ cả preset từ database (trong bảng `presets`) và file trực tiếp trong folder `/remove_bg/background/` trên R2
- Có thể truyền `preset_image_id` kèm extension (ví dụ: `"background_001.webp"`) hoặc không có extension (ví dụ: `"background_001"`)
- Nếu không có extension, hệ thống sẽ tự động thử các extension phổ biến: .webp, .jpg, .png, .jpeg
- Hệ thống sẽ tìm file theo thứ tự: database trước, sau đó folder `/remove_bg/background/` nếu không tìm thấy trong database

**Request Parameters:**
- `preset_image_id` (string, optional): ID ảnh preset hoặc filename trong folder `/remove_bg/background/`. Phải cung cấp `preset_image_id` HOẶC `preset_image_url` HOẶC `custom_prompt` (chỉ một trong ba).
- `preset_image_url` (string, optional): URL ảnh preset trực tiếp (thay thế cho `preset_image_id`). Phải cung cấp `preset_image_id` HOẶC `preset_image_url` HOẶC `custom_prompt` (chỉ một trong ba).
- `custom_prompt` (string, optional): Prompt tùy chỉnh để tạo ảnh nền từ text sử dụng Vertex AI (thay thế cho preset image). Khi sử dụng `custom_prompt`, hệ thống sẽ:
  1. Tạo ảnh nền từ text prompt bằng Vertex AI Gemini
  2. Merge selfie vào ảnh nền đã tạo
  Phải cung cấp `preset_image_id` HOẶC `preset_image_url` HOẶC `custom_prompt` (chỉ một trong ba).
- `selfie_id` (string, optional): ID ảnh selfie đã lưu trong database (người). Phải cung cấp `selfie_id` HOẶC `selfie_image_url` (không phải cả hai).
- `selfie_image_url` (string, optional): URL ảnh selfie trực tiếp (thay thế cho `selfie_id`).
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Các giá trị hỗ trợ: `"original"`, `"1:1"`, `"3:2"`, `"2:3"`, `"3:4"`, `"4:3"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"21:9"`. Mặc định: `"3:4"`. Khi sử dụng `custom_prompt`, tỷ lệ này sẽ được áp dụng cho cả việc tạo nền và merge.

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
  }'
```

**Request Parameters:**
- `image_url` (string, required): URL ảnh cần enhance.
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Xem [Lưu ý về Aspect Ratio](#23-post-enhance---ai-enhance) cho chi tiết. Mặc định: `"original"`.

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
  }'
```

**Request Parameters:**
- `image_url` (string, required): URL ảnh cần beautify.
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Xem [Lưu ý về Aspect Ratio](#23-post-enhance---ai-enhance) cho chi tiết. Mặc định: `"original"`.

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

**Mục đích:** AI Filter (Styles) - Áp dụng các style sáng tạo hoặc điện ảnh từ preset lên selfie trong khi giữ nguyên tính toàn vẹn khuôn mặt.

**Lưu ý:** Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Hành vi theo Provider:**
- **Vertex AI (mặc định):** Sử dụng `prompt_json` từ metadata của preset để áp dụng style. Preset phải có `prompt_json`.
- **WaveSpeed (`provider: "wavespeed"`):** Không sử dụng `prompt_json`. Thay vào đó, WaveSpeed tự phân tích style của preset image (figurine, pop mart, clay, disney, etc.) và áp dụng style đó lên selfie. Gửi images theo thứ tự `[selfie, preset]` - image 1 là selfie (ảnh cần áp dụng style), image 2 là preset (nguồn style).

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
- `preset_image_id` (string, required): ID preset đã lưu trong database (format: `preset_...`). Preset phải có `prompt_json` (chỉ yêu cầu cho Vertex provider).
- `selfie_id` (string, optional): ID selfie đã lưu trong database. Bắt buộc nếu không có `selfie_image_url`.
- `selfie_image_url` (string, optional): URL ảnh selfie trực tiếp. Bắt buộc nếu không có `selfie_id`.
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Xem [Lưu ý về Aspect Ratio](#23-post-enhance---ai-enhance) cho chi tiết. Mặc định: `"original"`.
- `additional_prompt` (string, optional): Prompt bổ sung để tùy chỉnh style.
- `provider` (string, optional): Provider AI. Giá trị: `"vertex"` (mặc định) hoặc `"wavespeed"`. WaveSpeed không yêu cầu `prompt_json` trong preset.

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
- Preset phải có prompt_json (được tạo tự động khi upload preset với `enableVertexPrompt=true`)
- Nếu preset chưa có prompt_json, API sẽ tự động generate từ preset image
- Khác với `/faceswap`: Filter giữ nguyên khuôn mặt và chỉ áp dụng style, không thay đổi khuôn mặt

**Parameter `redraw`:**
- `redraw: true` → Bỏ qua cache, luôn generate ảnh mới (sử dụng cho nút "Redraw")
- `redraw: false` hoặc không set → Check cache trước khi generate

**Flow xử lý /filter:**

```mermaid
flowchart TD
    START([Client Request]) --> PARSE[Parse Request Body]
    PARSE --> VALIDATE{Valid Input?}
    
    VALIDATE -->|No| ERR400[400: Missing required field]
    VALIDATE -->|Yes| CHECK_REDRAW{redraw: true?}
    
    CHECK_REDRAW -->|Yes| LOOKUP_SELFIE_REDRAW[Lookup Selfie in DB]
    CHECK_REDRAW -->|No| LOOKUP_SELFIE[Lookup Selfie in DB]
    
    LOOKUP_SELFIE --> SELFIE_EXISTS{Selfie Exists?}
    LOOKUP_SELFIE_REDRAW --> SELFIE_EXISTS_REDRAW{Selfie Exists?}
    
    SELFIE_EXISTS -->|Yes| CALL_AI[Call AI Provider]
    SELFIE_EXISTS -->|No| CHECK_CACHE{Check KV Cache}
    
    SELFIE_EXISTS_REDRAW -->|Yes| CALL_AI_REDRAW[Call AI Provider]
    SELFIE_EXISTS_REDRAW -->|No| ERR404_REDRAW[404: Selfie not found<br/>Cannot redraw without selfie]
    
    CHECK_CACHE -->|Found| RETURN_CACHED[200: Return Cached Result<br/>cached: true]
    CHECK_CACHE -->|Not Found| ERR404[404: Selfie not found<br/>No cached result]
    
    CALL_AI --> AI_RESULT{AI Success?}
    CALL_AI_REDRAW --> AI_RESULT_REDRAW{AI Success?}
    
    AI_RESULT -->|Error| ERR500[500: AI Processing Error<br/>Selfie NOT deleted<br/>NO cache stored]
    AI_RESULT -->|Success| CACHE_RESULT[Cache Result in KV<br/>TTL: 24h]
    
    AI_RESULT_REDRAW -->|Error| ERR500
    AI_RESULT_REDRAW -->|Success| CACHE_RESULT_REDRAW[Update Cache in KV<br/>TTL: 24h]
    
    CACHE_RESULT --> SUCCESS[200: Return Result<br/>resultImageUrl]
    CACHE_RESULT_REDRAW --> SUCCESS_REDRAW[200: Return NEW Result<br/>resultImageUrl]
    
    ERR400 --> END([End])
    ERR404 --> END
    ERR404_REDRAW --> END
    ERR500 --> RETRY_POSSIBLE([Client Can Retry<br/>Selfie still exists])
    RETURN_CACHED --> END
    SUCCESS --> END
    SUCCESS_REDRAW --> END
    
    style START fill:#e1f5fe
    style SUCCESS fill:#c8e6c9
    style SUCCESS_REDRAW fill:#c8e6c9
    style RETURN_CACHED fill:#fff9c4
    style ERR400 fill:#ffcdd2
    style ERR404 fill:#ffcdd2
    style ERR404_REDRAW fill:#ffcdd2
    style ERR500 fill:#ffcdd2
    style RETRY_POSSIBLE fill:#ffe0b2
```

**Bảng tóm tắt các trường hợp:**

| Scenario | `redraw` | Selfie Exists | Cache Exists | Result |
|----------|----------|---------------|--------------|--------|
| First request | `false` | ✅ | ❌ | Generate new |
| Retry after success | `false` | ❌ (deleted by queue) | ✅ | Return cached |
| Redraw button | `true` | ✅ | ✅ (ignored) | Generate new |
| Retry after API error | `false` | ✅ (not deleted) | ❌ | Generate new |
| Invalid selfie + no cache | `false` | ❌ | ❌ | 404 Error |

**Key Rules:**
1. **Chỉ cache khi SUCCESS** - Error không cache
2. **Selfie được quản lý theo queue** - Tối đa `SELFIE_MAX_FILTER` selfies (mặc định: 5), tự động xóa cũ nhất khi vượt quá
3. **`redraw: true` bỏ qua cache** - Luôn generate mới
4. **Cache TTL = 24h** - Sau 24h cache tự expire

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
  }'
```

**Request Parameters:**
- `image_url` (string, required): URL ảnh cần khôi phục (ảnh cũ, bị hư hỏng, mờ, hoặc đen trắng).
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Xem [Lưu ý về Aspect Ratio](#23-post-enhance---ai-enhance) cho chi tiết. Mặc định: `"original"`.

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

**Mục đích:** AI biến đổi tuổi khuôn mặt - áp dụng style tuổi từ preset lên selfie. Mỗi preset chứa prompt_json định nghĩa style tuổi cụ thể (em bé, người già, v.v.).

**Lưu ý:** Endpoint này yêu cầu API key authentication khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Hành vi theo Provider:**
- **Vertex AI (mặc định):** Sử dụng `prompt_json` từ metadata của preset để áp dụng biến đổi tuổi. Preset phải có `prompt_json`.
- **WaveSpeed (`provider: "wavespeed"`):** Sử dụng `prompt_json` nếu có, hoặc phân tích style của preset image trực tiếp. Gửi images theo thứ tự `[selfie, preset]`.

**Request:**
```bash
curl -X POST https://api.d.shotpix.app/aging \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "preset_image_id": "aging_baby_preset_001",
    "selfie_id": "selfie_1234567890_xyz789",
    "profile_id": "profile_1234567890"
  }'
```

**Hoặc sử dụng selfie_image_url:**
```bash
curl -X POST https://api.d.shotpix.app/aging \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "preset_image_id": "aging_elderly_preset_001",
    "selfie_image_url": "https://example.com/selfie.jpg",
    "profile_id": "profile_1234567890",
    "additional_prompt": "Make the aging look natural"
  }'
```

**Request Parameters:**
- `preset_image_id` (string, required*): ID preset aging đã lưu trong database. Preset chứa `prompt_json` định nghĩa style tuổi. *Bắt buộc nếu không có `preset_image_url`.
- `preset_image_url` (string, required*): URL ảnh preset trực tiếp. *Bắt buộc nếu không có `preset_image_id`.
- `selfie_id` (string, required*): ID selfie đã lưu trong database. *Bắt buộc nếu không có `selfie_image_url`.
- `selfie_image_url` (string, required*): URL ảnh selfie trực tiếp. *Bắt buộc nếu không có `selfie_id`.
- `profile_id` (string, required): ID profile người dùng.
- `aspect_ratio` (string, optional): Tỷ lệ khung hình. Mặc định: `"original"`.
- `additional_prompt` (string, optional): Prompt bổ sung để tùy chỉnh.
- `provider` (string, optional): Provider AI. Giá trị: `"vertex"` (mặc định) hoặc `"wavespeed"`.

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

**Tính năng AI Aging:**
- Sử dụng prompt_json từ preset (chứa hướng dẫn biến đổi tuổi cụ thể)
- Mỗi preset có style tuổi riêng (em bé, thiếu niên, trung niên, người già, v.v.)
- Giữ nguyên race, ethnicity, skin tone, gender
- Hỗ trợ additional_prompt để tùy chỉnh thêm

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
    "userID": "user_external_123",
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
- `userID` hoặc `user_id` (string, optional): **User ID bên ngoài** dùng để tìm kiếm profile. Đây là ID từ hệ thống của bạn (ví dụ: Firebase UID, Auth0 ID, v.v.). Có thể dùng để tìm profile sau này.
- `id` (string, optional): ID profile nội bộ. Nếu không có, hệ thống tự tạo bằng `nanoid(16)`.
- `name` (string, optional): tên profile.
- `email` (string, optional): email.
- `avatar_url` (string, optional): URL avatar.
- `preferences` (string hoặc object, optional): preferences dạng JSON string hoặc object. Nếu là object, hệ thống tự động chuyển thành JSON string trước khi lưu vào D1 database (vì D1 không hỗ trợ JSON object trực tiếp).

**Lưu ý về ID:**
- `id` (profile_id): ID nội bộ của profile, tự động tạo nếu không cung cấp.
- `user_id`: ID từ hệ thống bên ngoài (Firebase, Auth0, v.v.), dùng để liên kết với user của bạn.
- `device_id`: ID thiết bị, dùng để theo dõi user chưa đăng nhập.

**Response:**
```json
{
  "data": {
    "id": "uYNgRR70Ry9OFuMV",
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "user_id": "user_external_123",
    "created_at": "2025-12-15T04:48:47.676Z",
    "updated_at": "2025-12-15T04:48:47.676Z"
  },
  "status": "success",
  "message": "Profile created successfully",
  "code": 200,
  "debug": {
    "profileId": "uYNgRR70Ry9OFuMV",
    "deviceId": "device_1765774126587_yaq0uh6rvz",
    "userId": "user_external_123"
  }
}
```

---

#### 3.2. GET `/profiles/{id}` - Lấy profile

**Mục đích:** Lấy thông tin profile theo Profile ID, Device ID, hoặc User ID.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Path Parameters:**
- `id` (string, required): Có thể là **Profile ID**, **Device ID**, hoặc **User ID**. API sẽ tìm theo thứ tự: profile_id → device_id → user_id.

**Request:**
```bash
# Tìm bằng Profile ID
curl https://api.d.shotpix.app/profiles/uYNgRR70Ry9OFuMV \
  -H "X-API-Key: your_api_key_here"

# Tìm bằng Device ID
curl https://api.d.shotpix.app/profiles/device_1765774126587_yaq0uh6rvz \
  -H "X-API-Key: your_api_key_here"

# Tìm bằng User ID (từ hệ thống bên ngoài)
curl https://api.d.shotpix.app/profiles/user_external_123 \
  -H "X-API-Key: your_api_key_here"
```

**Response:**
```json
{
  "data": {
    "id": "uYNgRR70Ry9OFuMV",
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "user_id": "user_external_123",
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

**Lưu ý:** Cả ba cách tìm (bằng Profile ID, Device ID, hoặc User ID) đều trả về cùng một profile với đầy đủ thông tin.

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
    "user_id": "user_external_123",
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
        "user_id": "user_external_123",
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

**Mục đích:** Trả về tối đa 50 selfie gần nhất của một profile. Endpoint này được sử dụng bởi mobile app để lấy danh sách selfies đã upload.

**Authentication:** Không yêu cầu API key (có thể được bật trong tương lai).

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

**Mục đích:** Trả về tối đa 50 kết quả generated images (face swap, background, enhance, beauty, filter, restore, aging, upscaler4k) gần nhất. Endpoint này được sử dụng bởi mobile app để lấy danh sách các ảnh đã được tạo.

**Authentication:** Không yêu cầu API key (có thể được bật trong tương lai).

**Request:**
```bash
curl https://api.d.shotpix.app/results
curl https://api.d.shotpix.app/results?profile_id=profile_1234567890
```

**Query Parameters:**
- `profile_id` (optional): ID profile để lọc kết quả.
- `limit` (optional): Số lượng results tối đa trả về (1-50). Mặc định: 50.

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
        "action": "faceswap",
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "status": "success",
  "message": "Results retrieved successfully",
  "code": 200
}
```

**Response Fields:**
- `id`: ID duy nhất của result
- `result_url` / `image_url`: URL public của ảnh kết quả
- `profile_id`: ID profile sở hữu result này
- `action`: Loại action đã tạo ra result (`faceswap`, `background`, `upscaler4k`, `enhance`, `beauty`, `filter`, `restore`, `aging`). Có thể null cho results cũ.
- `created_at`: Thời gian tạo (ISO 8601)
```

---

#### 4.7. DELETE `/results/{id}` - Xóa result

**Mục đích:** Xóa kết quả khỏi D1 và R2.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

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

**Lưu ý:** Endpoint này query từ bảng `presets` với điều kiện `thumbnail_r2` không null và không rỗng. Dữ liệu thumbnail được lưu dưới dạng JSON object trong trường `thumbnail_r2`.

**Response:**
```json
{
  "data": {
    "thumbnails": [
      {
        "id": "fs_wonder_f_3",
        "ext": "png",
        "thumbnail_r2": "{\"webp_1x\":\"webp_1x/fs_wonder_f_3.webp\",\"lottie_1x\":\"lottie_1x/fs_wonder_f_3.json\",\"lottie_avif_2x\":\"lottie_avif_2x/fs_wonder_f_3.json\"}",
        "thumbnail_url": "https://resources.d.shotpix.app/webp_1x/fs_wonder_f_3.webp",
        "thumbnail_url_1x": "https://resources.d.shotpix.app/webp_1x/fs_wonder_f_3.webp",
        "thumbnail_url_1_5x": null,
        "thumbnail_url_2x": null,
        "thumbnail_url_3x": null,
        "thumbnail_url_4x": null,
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

#### 4.10. Thumbnail URL Rules - Quy tắc URL Thumbnail

**Mục đích:** Tài liệu chi tiết về cấu trúc URL và quy tắc đặt tên cho thumbnails trong hệ thống.

**Cấu trúc URL Thumbnail:**

Thumbnails được lưu trữ trong R2 bucket với cấu trúc path như sau:

```
preset_thumb/{folderType}_{resolution}/{presetId}.{ext}
```

**Format URL đầy đủ:**

```
https://resources.d.shotpix.app/{bucket-name}/preset_thumb/{folderType}_{resolution}/{presetId}.{ext}
```

**Ví dụ:**

```
https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json
https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/lottie_avif_2x/fs_wonder_f_3.json
https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/webp_4x/preset_1234567890_abc123.webp
```

**Folder Types (Loại thư mục):**

| Folder Type | Mô tả | Extension | Content Type |
|-------------|-------|-----------|--------------|
| `webp` | WebP image format | `.webp` | `image/webp` |
| `lottie` | Lottie animation JSON | `.json` | `application/json` |
| `lottie_avif` | Lottie animation với AVIF optimization | `.json` | `application/json` |

**Resolutions (Độ phân giải):**

| Resolution | Mô tả | Use Case |
|------------|-------|----------|
| `1x` | Base resolution | Standard displays |
| `1.5x` | 1.5x resolution | Retina displays (1.5x) |
| `2x` | 2x resolution | Retina displays (2x) |
| `3x` | 3x resolution | High-DPI displays (3x) |
| `4x` | 4x resolution | Ultra high-DPI displays (4x) |

**Folder Naming Convention (Quy tắc đặt tên thư mục):**

Format: `{folderType}_{resolution}`

**Tất cả các folder types và resolutions được hỗ trợ:**

- `webp_1x`, `webp_1.5x`, `webp_2x`, `webp_3x`, `webp_4x`
- `lottie_1x`, `lottie_1.5x`, `lottie_2x`, `lottie_3x`, `lottie_4x`
- `lottie_avif_1x`, `lottie_avif_1.5x`, `lottie_avif_2x`, `lottie_avif_3x`, `lottie_avif_4x`

**Tổng cộng: 15 folder types × resolutions**

**File Naming Convention (Quy tắc đặt tên file):**

Format: `{presetId}.{ext}`

- `presetId`: ID của preset (ví dụ: `fs_frosted_window_portrait_f_4`, `preset_1234567890_abc123`)
- `ext`: Extension dựa trên folder type:
  - `webp` → `.webp`
  - `lottie` → `.json`
  - `lottie_avif` → `.json`

**Ví dụ file names:**

- `fs_frosted_window_portrait_f_4.json` (lottie thumbnail)
- `fs_wonder_f_3.webp` (webp thumbnail)
- `preset_1234567890_abc123.json` (lottie_avif thumbnail)

**Database Storage (Lưu trữ trong Database):**

Thumbnails được lưu trong bảng `presets` với trường `thumbnail_r2` dạng JSON:

```json
{
  "webp_1x": "preset_thumb/webp_1x/fs_frosted_window_portrait_f_4.webp",
  "webp_1.5x": "preset_thumb/webp_1.5x/fs_frosted_window_portrait_f_4.webp",
  "webp_2x": "preset_thumb/webp_2x/fs_frosted_window_portrait_f_4.webp",
  "webp_3x": "preset_thumb/webp_3x/fs_frosted_window_portrait_f_4.webp",
  "webp_4x": "preset_thumb/webp_4x/fs_frosted_window_portrait_f_4.webp",
  "lottie_1x": "preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json",
  "lottie_1.5x": "preset_thumb/lottie_1.5x/fs_frosted_window_portrait_f_4.json",
  "lottie_2x": "preset_thumb/lottie_2x/fs_frosted_window_portrait_f_4.json",
  "lottie_3x": "preset_thumb/lottie_3x/fs_frosted_window_portrait_f_4.json",
  "lottie_4x": "preset_thumb/lottie_4x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_1x": "preset_thumb/lottie_avif_1x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_1.5x": "preset_thumb/lottie_avif_1.5x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_2x": "preset_thumb/lottie_avif_2x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_3x": "preset_thumb/lottie_avif_3x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_4x": "preset_thumb/lottie_avif_4x/fs_frosted_window_portrait_f_4.json"
}
```

**Key trong JSON = `{folderType}_{resolution}`**
**Value trong JSON = R2 key (full path từ root)**

**Cách xây dựng URL từ R2 key:**

1. Lấy R2 key từ database: `preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json`
2. Kết hợp với R2 public domain: `https://resources.d.shotpix.app/{bucket-name}/{r2Key}`
3. Kết quả: `https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json`

**Lưu ý quan trọng:**

1. **Không có duplicate folders:** URL không bao giờ có dạng `preset_thumb/lottie_1x/lottie_1x/` (folder name bị lặp). Format đúng là `preset_thumb/lottie_1x/{presetId}.json`.

2. **Preset ID extraction:** Preset ID được extract từ filename (basename), không bao gồm path. Ví dụ:
   - File: `lottie_1x/fs_frosted_window_portrait_f_4.json`
   - Preset ID: `fs_frosted_window_portrait_f_4` (không phải `lottie_1x/fs_frosted_window_portrait_f_4`)

3. **Bucket name:** Bucket name khác nhau theo environment:
   - Development: `faceswap-images-office-dev`
   - Production: `faceswap-images-office-prod`
   - Default: `faceswap-images-office`

4. **R2 Public Domain:** Luôn sử dụng `https://resources.d.shotpix.app` cho public URLs.

5. **Cache Control:** Tất cả thumbnails có cache control header: `public, max-age=31536000, immutable` (1 năm).

**Ví dụ sử dụng trong code:**

**JavaScript/TypeScript:**
```javascript
// Lấy thumbnail URL từ database response
const preset = {
  id: "fs_frosted_window_portrait_f_4",
  thumbnail_r2: '{"lottie_1x":"preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json"}'
};

const thumbnailData = JSON.parse(preset.thumbnail_r2);
const r2Key = thumbnailData['lottie_1x']; // "preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json"
const bucketName = "faceswap-images-office-dev";
const publicUrl = `https://resources.d.shotpix.app/${bucketName}/${r2Key}`;
// Result: https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json
```

**Mobile App (Swift/Kotlin):**
```swift
// Swift example
let thumbnailData = try JSONDecoder().decode([String: String].self, from: preset.thumbnailR2.data(using: .utf8)!)
if let r2Key = thumbnailData["lottie_1x"] {
    let bucketName = "faceswap-images-office-dev"
    let publicUrl = "https://resources.d.shotpix.app/\(bucketName)/\(r2Key)"
    // Use publicUrl to load thumbnail
}
```

**Best Practices:**

1. **Fallback resolution:** Luôn có fallback khi resolution không tồn tại:
   ```javascript
   const thumbnailUrl = 
     thumbnailData['lottie_4x'] || 
     thumbnailData['lottie_3x'] || 
     thumbnailData['lottie_2x'] || 
     thumbnailData['lottie_1x'] || 
     thumbnailData['webp_4x'] || 
     thumbnailData['webp_1x'];
   ```

2. **Format preference:** Ưu tiên format theo thứ tự:
   - Lottie AVIF (tối ưu nhất cho animation)
   - Lottie (standard animation)
   - WebP (static image fallback)

3. **Resolution selection:** Chọn resolution dựa trên device pixel ratio:
   - 1x devices: `1x` hoặc `1.5x`
   - 2x devices (Retina): `2x` hoặc `3x`
   - 3x+ devices (Super Retina): `3x` hoặc `4x`

4. **Error handling:** Luôn kiểm tra URL tồn tại trước khi sử dụng:
   ```javascript
   if (thumbnailUrl && thumbnailUrl.startsWith('https://')) {
     // Safe to use
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

Xem danh sách đầy đủ tại [APIs cần tích hợp với mobile](#apis-cần-tích-hợp-với-mobile-15-apis) ở đầu tài liệu.

---

## Custom Domain

- **Worker API Domain**: `https://api.d.shotpix.app` - Dùng cho tất cả API endpoints
- **R2 Public Domain**: `https://resources.d.shotpix.app` - Dùng cho public URLs của files trong R2 bucket
- Format R2 public URL: `https://resources.d.shotpix.app/{bucket-name}/{key}`
