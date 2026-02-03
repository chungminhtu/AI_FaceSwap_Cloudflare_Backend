# Push Notifications (FCM)

Hệ thống hỗ trợ gửi silent push notifications (không hiển thị notification bar) cho Web, Android, và iOS thông qua Firebase Cloud Messaging (FCM).

**Setup & vận hành:** Xem [FCM_COMPLETE_GUIDE.md](../../FCM_COMPLETE_GUIDE.md) ở thư mục gốc repo.

---

## Đặc Điểm

- **Silent Push:** Không hiển thị notification bar, app xử lý data trong background
- **Multi-Device:** Một profile có thể có nhiều devices (phone, tablet, web)
- **Auto-Cleanup:** Tự động xóa invalid tokens (app uninstall, token expired)
- **Profile-Based:** Push gửi đến tất cả devices của một profile
- **High Performance:** OAuth tokens được cache trong KV (55 phút)

---

## Endpoints

### 1. Đăng Ký Device (POST /api/device/register)

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

**Errors:** `400` (missing fields / invalid platform), `404` (profile không tồn tại), `500` (database error)

**Ví dụ:**
```bash
curl -X POST https://api.d.shotpix.app/api/device/register \
  -H "Content-Type: application/json" \
  -d '{"profile_id":"profile_abc123","platform":"web","token":"fcm-web-token-xyz","app_version":"1.0.0"}'
```

---

### 2. Gửi Silent Push (POST /api/push/silent)

**URL:** `POST /api/push/silent`  
**Auth:** Header `X-API-Key` (MOBILE_API_KEY từ deployments-secrets.json)

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
- `exclude_token` (string, optional): Token của device hiện tại, không gửi push cho device này

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

**Errors:** `401` (invalid API key), `400` (missing fields), `500` (FCM/database error)

**Ví dụ:**
```bash
curl -X POST https://api.d.shotpix.app/api/push/silent \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-mobile-api-key-here" \
  -d '{"profile_id":"profile_abc123","data":{"type":"balance_sync","amount":"100","timestamp":"1706900000"}}'
```

---

### 3. Hủy Đăng Ký Device (DELETE /api/device/unregister)

**URL:** `DELETE /api/device/unregister`  
**Auth:** None (public endpoint)

**Request Body:** `{ "token": "fcm-device-token-to-remove" }`

**Response Success (200):** `{ "data": { "unregistered": true }, "status": "success", "message": "Processing successful", "code": 200 }`

**Ví dụ:**
```bash
curl -X DELETE https://api.d.shotpix.app/api/device/unregister \
  -H "Content-Type: application/json" \
  -d '{"token":"fcm-device-token-xyz"}'
```

---

## Auto-Push Sau Mỗi Operation

Các API sau khi hoàn thành sẽ tự động gửi silent push tới mọi device của profile:

- `/faceswap` → `type: "operation_complete", operation: "faceswap"`
- `/beauty` → `operation: "beauty"`
- `/filter` → `operation: "filter"`
- `/upscaler4k` → `operation: "upscale"`
- `/background` → `operation: "background"`

**Payload thành công:**
```json
{
  "type": "operation_complete",
  "operation": "faceswap",
  "status": "success",
  "result_id": "result_1234567890",
  "timestamp": "1706900000"
}
```

**Payload lỗi:** `status: "error"`, có thêm field `error`.

---

## Test UI

**URL:** `https://your-domain.com/fcm-test.html`

- Đăng ký FCM token (Web)
- Gửi test push
- View logs realtime
- Hủy đăng ký device

---

## Mobile/Web Integration (tóm tắt)

**Web:** `getToken(messaging, { vapidKey })` → `POST /api/device/register` (profile_id, platform: "web", token). `onMessage` xử lý foreground.

**Android:** `FirebaseMessaging.getInstance().token` → register device. Service kế thừa `FirebaseMessagingService`, `onMessageReceived` xử lý data-only.

**iOS:** APNs key upload Firebase, `Messaging.messaging().token` → register. `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)` xử lý silent push, gọi `completionHandler(.newData)`.

Chi tiết setup (Firebase, VAPID, FCM credentials): [FCM_COMPLETE_GUIDE.md](../../FCM_COMPLETE_GUIDE.md).
