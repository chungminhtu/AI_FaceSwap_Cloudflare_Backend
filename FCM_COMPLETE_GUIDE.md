# FCM Silent Push – Setup & Reference

**Mục đích:** Cấu hình FCM (Firebase Cloud Messaging) cho silent push từ Cloudflare Worker; đăng ký device token (Web/Android/iOS) và gửi data-only notification. Tài liệu dùng cho team triển khai và vận hành.

---

## 1. Tổng quan

**Luồng chính:**
- App/Web gọi `POST /api/device/register` (profile_id, platform, token) → Worker lưu vào D1.
- Backend gọi `POST /api/push/silent` (hoặc auto-push sau faceswap/beauty/…) → Worker lấy OAuth token (cache KV), gửi FCM data-only message tới từng device; token lỗi được xóa khỏi D1.

**Config nguồn:** `_deploy-cli-cloudflare-gcp/deployments-secrets.json` (theo từng environment). Backend dùng `gcp` cho Vertex/Vision; FCM dùng `gcp` **hoặc** bộ riêng `FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL` / `FCM_PRIVATE_KEY` nếu Firebase project khác GCP project.

**Schema D1:** Bảng `device_tokens` (token, profile_id, platform, app_version, updated_at); migration `0006_device_tokens.sql`. OAuth token FCM cache trong KV (TTL 55 phút).

---

## 2. Setup – Thứ tự thực hiện

Làm **đủ thứ tự** dưới đây. Thiếu bước dễ gây 403, "applicationServerKey is not valid", hoặc lỗi DB/register.

| Bước | Việc cần làm | Chi tiết / Ghi chú |
|------|----------------|---------------------|
| 1 | **Firebase project & Web app** | Firebase Console → chọn hoặc tạo project (ví dụ `all-aiphoto`). Add app → Web → Register app → lưu **firebaseConfig** (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId). |
| 2 | **firebaseWebConfig trong config** | Trong `deployments-secrets.json`, mỗi env cần có `"firebaseWebConfig": { "apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId" }`. Có thể copy từ Firebase Web app config; hoặc dùng Firebase CLI: `firebase apps:sdkconfig web --project <projectId>` và deploy script sẽ ghi vào file nếu chưa có. |
| 3 | **Bật API (Google Cloud)** | Trong **đúng project** (project Firebase, không nhầm với project Vertex): APIs & Services → Library → bật **Firebase Installations API** và **Firebase Cloud Messaging API**. Deploy script cũng có thể tự bật khi deploy (gcloud). |
| 4 | **FCM credentials** | **Nếu Firebase project = GCP project** (cùng projectId với `gcp`): không cần thêm; backend dùng `gcp.projectId`, `gcp.client_email`, `gcp.private_key`. **Nếu khác** (ví dụ Firebase `all-aiphoto`, GCP `ai-photo-office`): tạo GCP Service Account trong **Firebase project** và điền `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` trong `deployments-secrets.json` — xem [§3](#3-fcm-credentials-khi-firebase-project--gcp-project). |
| 5 | **VAPID (Web Push)** | Firebase Console → Project settings → Cloud Messaging → Web Push certificates → Generate key pair → copy key. Trong `deployments-secrets.json` thêm/sửa `"FCM_VAPID_KEY": "B..."` cho env; hoặc set env khi deploy: `FCM_VAPID_KEY=... npm run deploy:...`. Deploy frontend để inject vào `fcm-test.html`. |
| 6 | **D1 migration** | `npm run db:migrate` (hoặc `wrangler d1 migrations apply <db-name>`). Thiếu → `/api/device/register` lỗi. |
| 7 | **Deploy** | `npm run deploy:<env>` (ví dụ `ai-office-dev`). Script đẩy secrets (gcp, FCM_*, firebaseWebConfig, VAPID…) lên Worker và inject firebaseWebConfig + VAPID vào frontend. |
| 8 | **Profile hợp lệ** | `POST /api/device/register` cần `profile_id` tồn tại trong bảng `profiles`. Tạo profile trước (app chính hoặc `POST /profiles`). |

**Authentication:** `/api/push/silent` dùng header `X-API-Key` = `MOBILE_API_KEY` (cùng key với các API khác). Không cần key riêng cho FCM.

---

## 3. FCM credentials (khi Firebase project ≠ GCP project)

Chỉ cần khi **Firebase project** (nơi có Web app, VAPID) **khác** với **GCP project** trong `gcp` (Vertex/Vision). Ví dụ: `firebaseWebConfig.projectId` = `all-aiphoto`, `gcp.projectId` = `ai-photo-office`.

**Thực hiện:**

1. **Chọn project:** Google Cloud Console → chọn project **trùng Firebase** (ví dụ `all-aiphoto`), không chọn project Vertex.
2. **Bật API (nếu chưa):** APIs & Services → Library → bật **Firebase Installations API**, **Firebase Cloud Messaging API**.
3. **Tạo Service Account:** IAM & Admin → Service Accounts → Create. Tên ví dụ `fcm-sender` → Create and Continue.
4. **Gán role:** Role chọn **Firebase Cloud Messaging API Admin** (hoặc Firebase Admin / Editor) → Done.
5. **Tạo key:** Vào SA vừa tạo → Keys → Add Key → Create new key → JSON → Create. Lưu file an toàn.
6. **Map vào config:** Mở file JSON, trong `deployments-secrets.json` (đúng env) điền:
   - `project_id` → `FCM_PROJECT_ID`
   - `client_email` → `FCM_CLIENT_EMAIL`
   - `private_key` → `FCM_PRIVATE_KEY` (copy toàn bộ chuỗi, giữ `\n` trong JSON)
7. **Deploy:** Chạy deploy để đẩy `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` lên Worker.

Backend sẽ dùng bộ credentials này cho FCM (OAuth + messages:send), không dùng `gcp`.

---

## 4. API Endpoints

| Method | Path | Auth | Mô tả |
|--------|------|------|--------|
| POST | `/api/device/register` | None | Đăng ký/cập nhật FCM token. Body: `profile_id`, `platform` (android \| ios \| web), `token`, (optional) `app_version`. |
| POST | `/api/push/silent` | `X-API-Key: MOBILE_API_KEY` | Gửi silent push tới mọi device của `profile_id`. Body: `profile_id`, `data` (object string key-value), (optional) `exclude_token`. |
| DELETE | `/api/device/unregister` | None | Xóa token. Body: `token`. |

**Lỗi thường gặp:** 400 (thiếu field), 401 (sai API key), 404 (profile không tồn tại), 500 (DB/FCM lỗi).

---

## 5. Mobile / Web integration (tóm tắt)

**Android:** Thêm app Android vào Firebase → `google-services.json` vào `android/app/` → build.gradle: `firebase-bom`, `firebase-messaging` → Service kế thừa `FirebaseMessagingService` (onMessageReceived, onNewToken) → khi có token gọi `POST /api/device/register`. Data-only message → không có `notification` trong payload.

**iOS:** Tạo APNs key (Apple Developer) → upload .p8 vào Firebase (Cloud Messaging → Apple app configuration) → Add app iOS → GoogleService-Info.plist → Xcode: Push Notifications + Background Modes (Remote notifications) → Firebase SDK → khi có token gọi `POST /api/device/register`. Silent push: `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)` → xử lý `userInfo`, gọi `completionHandler(.newData)`.

**Web:** Dùng firebaseConfig (từ firebaseWebConfig) + VAPID. `getToken(messaging, { vapidKey })` → `POST /api/device/register`. Service worker: `firebase-messaging-sw.js` với `onBackgroundMessage`. Deploy script inject firebaseWebConfig và VAPID vào `fcm-test.html` và service worker.

Code mẫu chi tiết (Kotlin/Swift/JS) giữ trong repo tại các file tương ứng; phần trên đủ để team biết luồng và điểm tích hợp.

---

## 6. Testing

- **Test UI:** Mở `https://<pages-host>/fcm-test.html` → Request Permission → nhập Profile ID → Register Device → (nhập MOBILE_API_KEY) Send Push. Kiểm tra log/console.
- **DB:** `wrangler d1 execute <db-name> --command "SELECT * FROM device_tokens"`.
- **Push thủ công:** `curl -X POST <backend>/api/push/silent -H "Content-Type: application/json" -H "X-API-Key: <MOBILE_API_KEY>" -d '{"profile_id":"<id>","data":{"type":"test"}}'`.
- **Auto-push:** Sau khi thêm `ctx.waitUntil(sendResultNotification(...))` ở các endpoint (faceswap, beauty, filter, upscaler4k, background), gọi API tương ứng rồi kiểm tra client nhận payload `type: "operation_complete"`, `operation`, `status`, `result_id`.

---

## 7. Troubleshooting

| Triệu chứng / Lỗi | Nguyên nhân có thể | Hành động |
|-------------------|--------------------|-----------|
| 403 PERMISSION_DENIED (Firebase Installations) | API chưa bật hoặc API key bị restrict | Bật Firebase Installations API + FCM API trong đúng project; Google Cloud Console → Credentials → sửa API key (firebaseConfig.apiKey): bỏ restrict hoặc thêm Firebase Installations API + FCM API vào restrict. |
| 400 INVALID_ARGUMENT (Create Installation) | firebaseConfig/appId sai hoặc placeholder | Dùng đúng firebaseConfig từ Firebase Console (Web app); điền vào `firebaseWebConfig` trong deployments-secrets.json; deploy lại frontend. |
| applicationServerKey is not valid | Thiếu hoặc sai VAPID | Firebase Console → Cloud Messaging → Web Push certificates → lấy key → `FCM_VAPID_KEY` trong deployments-secrets.json → deploy frontend. |
| OAuth / FCM send lỗi | Sai FCM credentials hoặc project | Kiểm tra FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY (hoặc gcp) đúng project Firebase; private_key giữ `\n` đúng. Đẩy lại secrets (deploy). |
| Web không nhận push | Service worker chưa đăng ký hoặc VAPID sai | DevTools → Application → Service Workers; kiểm tra VAPID và firebaseConfig trong sw. |
| Android hiển thị notification bar | Payload có field `notification` | Backend chỉ gửi `data` (và android/apns config), không gửi `notification`. |
| Token invalid (NOT_REGISTERED) | App gỡ, token xoay, bundle/package sai | Worker tự xóa token lỗi khỏi D1; client cần đăng ký lại token mới. |

---

## 8. Implementation checklist (backend)

- **Đã có:** D1 migration, types, FCM config, `getFcmAccessToken`, `sendFcmSilentPush`, `sendResultNotification`, routes `/api/device/register`, `/api/push/silent`, `/api/device/unregister`, frontend `fcm-test.html`, `firebase-messaging-sw.js`.
- **Cần thêm (nếu chưa):** Sau khi upload R2 thành công ở từng endpoint, gọi `ctx.waitUntil(sendResultNotification(env, profile_id, operationType, { success, resultId }))`. Vị trí: `/faceswap`, `/beauty`, `/filter`, `/upscaler4k`, `/background` (tìm sau `R2_BUCKET.put(resultKey, ...)`).

---

## 9. Files & commands

**Files liên quan:**  
`backend-cloudflare-workers/migrations/0006_device_tokens.sql`, `types.ts`, `config.ts`, `services.ts`, `index.ts`; `frontend-cloudflare-pages/fcm-test.html`, `firebase-messaging-sw.js`; `_deploy-cli-cloudflare-gcp/deployments-secrets.json`, `deploy.js`.

**Commands:**
```bash
npm run db:migrate
npm run deploy:<env>
```
