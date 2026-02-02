# FCM Silent Push - Complete Guide

**Hướng dẫn đầy đủ: Setup → Implementation → Test → Mobile Integration**

---

## 📋 Mục Lục

1. [Kiến Trúc & Diagrams](#kiến-trúc--diagrams)
2. [Complete Setup – Tất cả bước](#complete-setup--tất-cả-bước-không-bỏ-sót) ← **checklist đầy đủ**
3. [Quick Setup (3 Bước)](#quick-setup-3-bước)
   - [Bước 0: Bật API Google Cloud](#bước-0-bật-api-trên-google-cloud-bắt-buộc-cho-web-push)
   - [FCM credentials: chung gcp hay riêng](#11-fcm-credentials-dùng-chung-gcp-hay-tạo-riêng)
   - [Tạo GCP Service Account cho FCM (project khác gcp)](#12-tạo-và-lấy-gcp-service-account-cho-fcm-khi-project-fcm--project-gcp)
4. [Implementation Checklist](#implementation-checklist)
5. [API Endpoints Reference](#api-endpoints-reference)
6. [Mobile/Web Integration](#mobileweb-integration)
   - [Hướng dẫn Android (từng bước)](#hướng-dẫn-android-từng-bước)
   - [Hướng dẫn iOS (từng bước)](#hướng-dẫn-ios-từng-bước)
   - [Web](#web-firebase-sdk-v10)
   - [Android (Kotlin) – Code mẫu](#android-kotlin)
   - [iOS (Swift) – Code mẫu](#ios-swift)
7. [Checklist trước khi test (Web Push)](#checklist-trước-khi-test-web-push)
8. [Testing](#testing)
9. [Troubleshooting](#troubleshooting)
   - [403 PERMISSION_DENIED – Firebase Installations](#403-permission_denied--firebase-installations-api)

---

## Kiến Trúc & Diagrams

### System Architecture

```mermaid
sequenceDiagram
    participant App
    participant Worker as Cloudflare Worker
    participant D1
    participant KV
    participant FCM as FCM HTTP v1
    participant Device

    Note over App,Device: Registration Flow
    App->>Worker: POST /api/device/register
    Worker->>D1: Verify profile exists
    Worker->>D1: Upsert device_tokens
    Worker-->>App: 200 OK

    Note over App,Device: Push Flow
    App->>Worker: POST /api/push/silent
    Worker->>KV: Get cached FCM token
    alt Token expired/missing
        Worker->>FCM: OAuth token exchange
        Worker->>KV: Cache new token
    end
    Worker->>D1: Get tokens for profile_id
    loop Each device
        Worker->>FCM: Send silent message
        FCM->>Device: Push notification
    end
    alt Invalid token detected
        Worker->>D1: Delete stale token
    end
    Worker-->>App: Results summary
```

### Database Schema

```sql
CREATE TABLE device_tokens (
  token TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  app_version TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX idx_device_tokens_profile ON device_tokens(profile_id);
CREATE INDEX idx_device_tokens_updated ON device_tokens(updated_at);
```

### Performance

**OAuth Token Caching:**
- Without cache: ~300ms (JWT sign + HTTP exchange)
- With KV cache: ~5ms
- Cache TTL: 55 minutes (tokens valid 60 minutes)
- Reuses existing `PROMPT_CACHE_KV` namespace

---

## Complete Setup – Tất Cả Bước (không bỏ sót)

### Tự động (không cần thao tác tay)

- **Bật API Google Cloud (Firebase Installations + FCM):** Deploy script tự gọi `gcloud services enable` khi deploy. Không cần vào Console bật tay.
- **firebaseWebConfig:** Nếu chưa có trong `deployments-secrets.json`, deploy script tự chạy `firebase apps:sdkconfig web --project <projectId>` và ghi vào file (cần đã cài `firebase-tools` và `firebase login` một lần).
- **FCM_VAPID_KEY từ env:** Khi chạy deploy, set `FCM_VAPID_KEY=...` (key từ Firebase Console → Cloud Messaging → Web Push certificates). Script sẽ ghi vào `deployments-secrets.json` cho env đó. Chỉ cần làm một lần.

Làm **đủ thứ tự** dưới đây. Thiếu một bước có thể gây 403, "applicationServerKey is not valid", hoặc register/push lỗi.

| # | Bước | Ở đâu | Ghi chú |
|---|------|--------|--------|
| 1 | **Thêm Web app vào Firebase** | Firebase Console → trang tổng quan project → **Add app** → chọn **Web** (icon `</>`) → Đặt tên → **Register app** | Bắt buộc cho FCM Web. **firebaseConfig** có thể để deploy script tự lấy (Firebase CLI) hoặc copy vào `firebaseWebConfig` trong `deployments-secrets.json` nếu không dùng CLI. |
| 2 | **firebaseWebConfig (nếu không dùng CLI)** | `_deploy-cli-cloudflare-gcp/deployments-secrets.json` → mỗi env thêm `"firebaseWebConfig": { "apiKey": "...", "authDomain": "...", "projectId": "...", "storageBucket": "...", "messagingSenderId": "...", "appId": "..." }` | Chỉ cần nếu **không** chạy Firebase CLI; deploy script sẽ inject vào `fcm-test.html` và `firebase-messaging-sw.js`. |
| 3 | **Bật API** | **Tự động khi deploy** (script gọi gcloud). Nếu deploy chưa chạy, có thể bật tay: Google Cloud Console → APIs & Services → Library → bật **Firebase Installations API** và **Firebase Cloud Messaging API**. | Thiếu → lỗi 403 PERMISSION_DENIED khi lấy token. |
| 4 | **VAPID key** | Firebase Console → Project Settings → Cloud Messaging → **Web Push certificates** → **Generate key pair** → Copy. Set `FCM_VAPID_KEY=...` khi chạy deploy (một lần) hoặc thêm `"FCM_VAPID_KEY": "B..."` vào `deployments-secrets.json`. | Thiếu → lỗi "applicationServerKey is not valid". |
| 5 | **Chạy D1 migration** | Terminal: `npm run db:migrate` (hoặc `wrangler d1 migrations apply <db-name>`) | Tạo bảng `device_tokens`. Thiếu → `/api/device/register` lỗi DB. |
| 6 | **Deploy** | `npm run deploy:ai-office-dev` (hoặc env tương ứng) | Worker + frontend; script tự bật FCM APIs, tự lấy firebaseWebConfig (nếu có Firebase CLI), inject VAPID nếu có trong env hoặc JSON. |
| 7 | **Có profile_id hợp lệ** | Tạo profile trước (app chính hoặc `POST /profiles`) | `POST /api/device/register` cần `profile_id` tồn tại trong bảng `profiles`. |

**Backend không cần config thêm:** Đã dùng `gcp` (projectId, client_email, private_key) và `MOBILE_API_KEY` trong `deployments-secrets.json`.

#### Chi tiết bước 1: Thêm Web app vào Firebase (nếu chưa có)
1. Mở https://console.firebase.google.com → chọn project (ví dụ: `ai-photo-office`).
2. Trang tổng quan (Overview) → bấm **Add app** (hoặc icon **Web** `</>`).
3. **App nickname:** ví dụ "Face Swap Web" → **Register app**.
4. Màn hình hiện **firebaseConfig**. Deploy script có thể tự lấy qua `firebase apps:sdkconfig web --project <projectId>` (cần Firebase CLI đã login); hoặc copy object này vào `firebaseWebConfig` trong `deployments-secrets.json` cho từng env.

---

## Quick Setup (3 Bước)

### Bước 0: Bật API trên Google Cloud (bắt buộc cho Web Push)

**Tự động:** Khi chạy deploy, script gọi `gcloud services enable firebaseinstallations.googleapis.com fcm.googleapis.com` — không cần bật tay.

**Lỗi thường gặp:** `403 PERMISSION_DENIED: Firebase Installations API has not been used in project ... or it is disabled`

Nếu chưa deploy lần nào hoặc gcloud chưa chạy, có thể bật tay (fallback):

**Cách 1 – Link trực tiếp:** Mở (thay `YOUR_PROJECT_ID`):  
- https://console.cloud.google.com/apis/library/firebaseinstallations.googleapis.com?project=YOUR_PROJECT_ID  
- https://console.cloud.google.com/apis/library/fcm.googleapis.com?project=YOUR_PROJECT_ID  
→ Bấm **Enable** trên từng trang.

**Cách 2 – Google Cloud Console:** APIs & Services → Library → tìm **Firebase Installations API** và **Firebase Cloud Messaging API** → Enable.

---

### Bước 1: Chuẩn Bị

#### 1.1 FCM credentials: dùng chung `gcp` hay tạo riêng?

- **Nếu Firebase project = GCP project** (ví dụ cả hai đều `ai-photo-office`): backend dùng luôn `gcp.projectId`, `gcp.client_email`, `gcp.private_key` — **không cần** `FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL` / `FCM_PRIVATE_KEY`.
- **Nếu Firebase project khác GCP project** (ví dụ Firebase `all-aiphoto`, GCP Vertex `ai-photo-office`): cần tạo **một GCP service account riêng trong Firebase project** và điền `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` trong `deployments-secrets.json`. Xem chi tiết bên dưới.

#### 1.2 Tạo và lấy GCP Service Account cho FCM (khi project FCM ≠ project gcp)

Dùng khi **Firebase project** (nơi bạn tạo Web app, VAPID, FCM) **khác** với project trong `gcp` (Vertex AI, Vision). Ví dụ: `firebaseWebConfig.projectId` = `all-aiphoto`, còn `gcp.projectId` = `ai-photo-office`.

**Bước 2.1 – Chọn đúng Google Cloud project (Firebase project)**

1. Mở **Google Cloud Console**: https://console.cloud.google.com  
2. Ở **góc trên trái** chọn project (dropdown). Chọn project **trùng với Firebase** (ví dụ `all-aiphoto`), **không** chọn project Vertex (`ai-photo-office`).  
3. Nếu chưa thấy project Firebase: **Select a project** → **NEW PROJECT** tạo project mới, hoặc dùng project đã link với Firebase (Firebase Console → Project settings → General → Project ID).

**Bước 2.2 – Bật API (cho project Firebase đó)**

1. Menu trái: **APIs & Services** → **Library**.  
2. Tìm và bật:
   - **Firebase Installations API**
   - **Firebase Cloud Messaging API**  
3. (Deploy script cũng có thể tự bật khi deploy đúng project; nếu bật tay thì chắc chắn hơn.)

**Bước 2.3 – Tạo Service Account**

1. Menu trái: **IAM & Admin** → **Service Accounts**.  
2. Chọn **+ CREATE SERVICE ACCOUNT**.  
3. **Service account name**: ví dụ `fcm-sender`.  
4. **Service account ID**: để mặc định (ví dụ `fcm-sender`).  
5. **Create and Continue**.

**Bước 2.4 – Gán quyền (Role)**

1. Ở bước **Grant this service account access to project**:  
2. **Role**: chọn **Firebase Cloud Messaging API Admin** (hoặc **Firebase Admin** nếu có). Nếu không thấy, thử **Editor** (rộng hơn) hoặc tạo custom role có scope `https://www.googleapis.com/auth/firebase.messaging`.  
3. **Continue** → **Done**.

**Bước 2.5 – Tạo JSON key**

1. Trong danh sách Service Accounts, click vào service account vừa tạo (ví dụ `fcm-sender@all-aiphoto.iam.gserviceaccount.com`).  
2. Tab **Keys** → **Add Key** → **Create new key**.  
3. Chọn **JSON** → **Create**. File JSON sẽ tải xuống (chỉ tải được một lần; cất an toàn).

**Bước 2.6 – Map JSON vào deployments-secrets.json**

Mở file JSON vừa tải. Cấu trúc dạng:

```json
{
  "type": "service_account",
  "project_id": "all-aiphoto",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----",
  "client_email": "fcm-sender@all-aiphoto.iam.gserviceaccount.com",
  "client_id": "...",
  ...
}
```

Trong `_deploy-cli-cloudflare-gcp/deployments-secrets.json`, với **đúng environment** (ví dụ `ai-office-dev`), điền **ba key** sau (không đụng tới `gcp`):

| Trong JSON key   | Trong deployments-secrets.json | Ví dụ |
|------------------|---------------------------------|--------|
| `project_id`     | `FCM_PROJECT_ID`                | `"all-aiphoto"` |
| `client_email`   | `FCM_CLIENT_EMAIL`             | `"fcm-sender@all-aiphoto.iam.gserviceaccount.com"` |
| `private_key`    | `FCM_PRIVATE_KEY`               | Nguyên chuỗi `"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"` |

**Lưu ý cho `FCM_PRIVATE_KEY`:**

- Copy **toàn bộ** giá trị `private_key` trong JSON (kể cả `-----BEGIN PRIVATE KEY-----` và `-----END PRIVATE KEY-----`).  
- Trong JSON, xuống dòng thường là `\n`. Giữ nguyên `\n` trong chuỗi (một dòng trong file JSON), ví dụ:  
  `"FCM_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\\nMIIEvgIBA...\\n-----END PRIVATE KEY-----"`  
- Nếu paste nhiều dòng thật vào editor, một số tool có thể tự escape thành `\n`; sau khi deploy, Worker nhận được private key có newline đúng là được.

**Ví dụ đoạn env trong deployments-secrets.json:**

```json
"ai-office-dev": {
  ...
  "gcp": {
    "projectId": "ai-photo-office",
    "client_email": "faceswap-vision-sa@ai-photo-office.iam.gserviceaccount.com",
    "private_key": "..."
  },
  "FCM_PROJECT_ID": "all-aiphoto",
  "FCM_CLIENT_EMAIL": "fcm-sender@all-aiphoto.iam.gserviceaccount.com",
  "FCM_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----",
  "firebaseWebConfig": { "projectId": "all-aiphoto", ... },
  "FCM_VAPID_KEY": "B..."
}
```

**Bước 2.7 – Deploy để đẩy secrets lên Worker**

Sau khi sửa `deployments-secrets.json`, chạy deploy (ví dụ `npm run deploy:ai-office-dev`). Script deploy sẽ đẩy `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` lên Worker; backend sẽ dùng bộ credentials này cho FCM (OAuth + gửi tin), không dùng `gcp` cho FCM.

#### 1.3 Authentication

`/api/push/silent` endpoint sử dụng **MOBILE_API_KEY** đã có (cùng key với các API khác).

**Không cần tạo thêm key nào!**

#### 1.4 iOS APNs (nếu có iOS app)

**Tạo APNs Key:**
1. https://developer.apple.com/account
2. **Certificates, Identifiers & Profiles** → **Keys** → **+**
3. Tên: "FaceSwap APNs Key"
4. Check **"Apple Push Notifications service (APNs)"**
5. Download file `.p8` (**CHỈ TẢI ĐƯỢC 1 LẦN!**)
6. Lưu **Key ID** (10 ký tự) + **Team ID**

**Upload vào Firebase:**
1. Firebase Console → **Cloud Messaging** → **Apple app configuration**
2. Upload file `.p8`, điền Key ID + Team ID

**Xcode:**
1. Target → **Signing & Capabilities** → **+ Capability**
2. Thêm **"Push Notifications"**
3. Thêm **"Background Modes"** → Check **"Remote notifications"**

#### 1.5 Android (nếu có Android app)
1. Firebase Console → **Project Settings** → **General** → **Add app** → Android
2. Điền package name (ví dụ: `com.mycompany.faceswap`)
3. Download `google-services.json` → `android/app/`
4. `android/app/build.gradle`:
```gradle
dependencies {
    implementation platform('com.google.firebase:firebase-bom:32.7.0')
    implementation 'com.google.firebase:firebase-messaging'
}
```

---

### Bước 2: VAPID Key (chỉ cho Web Push)

#### Hướng dẫn lấy VAPID key (tiếng Việt)

1. **Mở Firebase Console**  
   Truy cập: https://console.firebase.google.com

2. **Chọn project**  
   Click vào project của bạn (ví dụ: `ai-photo-office`).

3. **Vào Cài đặt dự án**  
   Click icon **bánh răng** (⚙️) góc trái trên → chọn **Project settings** (Cài đặt dự án).

4. **Mở tab Cloud Messaging**  
   Trong cửa sổ cài đặt, chọn tab **Cloud Messaging**.

5. **Tìm mục Web Push certificates**  
   Kéo trang xuống đến phần **Web Push certificates** (Chứng chỉ Web Push).

6. **Tạo cặp key (nếu chưa có)**  
   Nếu chưa có key:
   - Click nút **Generate key pair** (Tạo cặp khóa).
   - Hệ thống tạo và hiển thị **Key pair** (chuỗi dài, bắt đầu bằng chữ `B`, khoảng 88 ký tự).

7. **Copy Key pair**  
   Click vào ô chứa key hoặc nút copy bên cạnh để copy toàn bộ chuỗi (bắt đầu bằng `B...`).

8. **Dán vào deployments-secrets.json**  
   Mở file `_deploy-cli-cloudflare-gcp/deployments-secrets.json`, tìm environment cần dùng (ví dụ: `ai-office-dev`), thêm hoặc sửa:
   ```json
   "FCM_VAPID_KEY": "Bxxxxxxxx_your_full_key_here"
   ```
   Dán chuỗi key vừa copy thay cho `Bxxxxxxxx_your_full_key_here`.

9. **Deploy lại frontend**  
   Chạy lệnh deploy (ví dụ: `npm run deploy:ai-office-dev`). Script deploy sẽ tự gắn VAPID vào trang Push Test (`fcm-test.html`).

**Lưu ý:** Nếu không set `FCM_VAPID_KEY`, trang Push Test (`/fcm-test.html`) sẽ báo lỗi "applicationServerKey is not valid". API backend (register/push/unregister) vẫn hoạt động bình thường; chỉ trình duyệt Web cần VAPID để lấy FCM token.

---

### Bước 3: Deploy

```bash
# Run migration
npm run db:migrate

# Deploy workers
npm run deploy:ai-office-dev:workers

# Test
open https://your-domain.pages.dev/fcm-test.html
```

**DONE!** FCM ready.

---

## Implementation Checklist

### ✅ Backend (DONE)

- [x] D1 migration: `0006_device_tokens.sql`
- [x] Types: `DeviceToken`, `DeviceRegisterRequest`, `SilentPushRequest`, `FcmSendResult`
- [x] Config: `FCM_CONFIG`
- [x] Services: `getFcmAccessToken()`, `sendFcmSilentPush()`, `sendResultNotification()`
- [x] Routes: `/api/device/register`, `/api/push/silent`, `/api/device/unregister`

### ✅ Frontend (DONE)

- [x] Service worker: `firebase-messaging-sw.js`
- [x] Test UI: `fcm-test.html`

### ⚠️ Auto-Push (MANUAL)

Add `ctx.waitUntil()` after successful operations:

```typescript
// Pattern: After R2 upload success
await R2_BUCKET.put(resultKey, imageBuffer, {...});

// Add this:
ctx.waitUntil(
  sendResultNotification(env, body.profile_id, 'faceswap', {
    success: true,
    resultId: resultId
  })
);
```

**Locations in `index.ts`:**

1. **`/faceswap`** (~line 5800): After `R2_BUCKET.put(resultKey`
2. **`/beauty`** (~line 5200): After R2 upload
3. **`/filter`** (~line 5300): After R2 upload
4. **`/upscaler4k`** (~line 5500): After R2 upload
5. **`/background`** (~line 5400): After R2 upload

**Search pattern:**
```bash
# Find exact line
rg "R2_BUCKET\.put\(resultKey" backend-cloudflare-workers/index.ts -A 5
```

---

## API Endpoints Reference

### POST /api/device/register

**URL:** `POST /api/device/register`  
**Auth:** None (public)

**Request:**
```json
{
  "profile_id": "profile_abc123",
  "platform": "android",
  "token": "fcm-device-token",
  "app_version": "1.0.0"
}
```

**Response (200):**
```json
{
  "data": { "registered": true },
  "status": "success"
}
```

**Errors:** `400` (missing fields), `404` (profile not found), `500` (DB error)

**cURL:**
```bash
curl -X POST https://api.d.shotpix.app/api/device/register \
  -H "Content-Type: application/json" \
  -d '{"profile_id":"test","platform":"web","token":"fcm-token"}'
```

---

### POST /api/push/silent

**URL:** `POST /api/push/silent`  
**Auth:** `X-API-Key` header (= `MOBILE_API_KEY`)

**Request:**
```json
{
  "profile_id": "profile_abc123",
  "data": {
    "type": "balance_sync",
    "amount": "100"
  },
  "exclude_token": "current-device-token"
}
```

**Response (200):**
```json
{
  "data": {
    "sent": 2,
    "failed": 0,
    "cleaned": 1,
    "results": [...]
  },
  "status": "success"
}
```

**Errors:** `401` (invalid API key), `400` (missing fields), `500` (FCM error)

**cURL:**
```bash
curl -X POST https://api.d.shotpix.app/api/push/silent \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_MOBILE_API_KEY" \
  -d '{"profile_id":"test","data":{"type":"test","msg":"hello"}}'
```

---

### DELETE /api/device/unregister

**URL:** `DELETE /api/device/unregister`  
**Auth:** None (public)

**Request:**
```json
{
  "token": "fcm-device-token"
}
```

**Response (200):**
```json
{
  "data": { "unregistered": true },
  "status": "success"
}
```

---

## Mobile/Web Integration

---

### Hướng dẫn Android (từng bước)

**Cần làm:** Thêm app Android vào Firebase → Cấu hình project → Gửi token lên backend → Xử lý tin nhắn data-only.

#### Bước 1: Thêm app Android vào Firebase
1. Mở https://console.firebase.google.com → chọn project (ví dụ: `ai-photo-office`).
2. Trang tổng quan → **Add app** (hoặc **Project Settings** → **General** → **Your apps**) → chọn icon **Android**.
3. Nhập **Android package name** (ví dụ: `com.mycompany.faceswap`) — phải trùng với `applicationId` trong `build.gradle`.
4. (Tùy chọn) Nickname, SHA-1 nếu dùng đăng nhập Google.
5. Bấm **Register app**.

#### Bước 2: Tải và đặt file cấu hình
1. Tải file **google-services.json**.
2. Copy vào thư mục `android/app/` (cùng cấp với `build.gradle` của app).
3. **Không** commit file này lên git nếu project public (có thể thêm vào `.gitignore` tùy chính sách).

#### Bước 3: Thêm Firebase SDK vào project
1. Mở **Project-level** `build.gradle` (root) → đảm bảo có `google-services`:
   ```gradle
   dependencies {
       classpath 'com.google.gms:google-services:4.4.0'
   }
   ```
2. Mở **App-level** `build.gradle` (`android/app/build.gradle`):
   - Cuối file thêm: `apply plugin: 'com.google.gms.google-services'`
   - Trong `dependencies { }` thêm:
   ```gradle
   implementation platform('com.google.firebase:firebase-bom:32.7.0')
   implementation 'com.google.firebase:firebase-messaging'
   ```
3. Sync Gradle.

#### Bước 4: Khai báo Service trong AndroidManifest
1. Mở `android/app/src/main/AndroidManifest.xml`.
2. Trong thẻ `<application>...</application>`, thêm:
   ```xml
   <service
       android:name=".MyFirebaseMessagingService"
       android:exported="false">
       <intent-filter>
           <action android:name="com.google.firebase.MESSAGING_EVENT" />
       </intent-filter>
   </service>
   ```
   (Thay `.MyFirebaseMessagingService` bằng package + tên class của bạn.)

#### Bước 5: Code trong app
- **Lúc mở app:** Lấy FCM token → gọi `POST /api/device/register` với `profile_id`, `platform: "android"`, `token`, (tùy chọn) `app_version`.
- **Nhận tin:** Tạo class kế thừa `FirebaseMessagingService`, override `onMessageReceived` — xử lý `message.data` (data-only = silent, không có `notification`).
- **Token mới:** Override `onNewToken` → gửi lại token lên `/api/device/register`.

Code mẫu chi tiết xem ở mục [Android (Kotlin)](#android-kotlin) bên dưới.

---

### Hướng dẫn iOS (từng bước)

**Cần làm:** Tạo APNs key trên Apple → Upload lên Firebase → Thêm app iOS vào Firebase → Bật Push trong Xcode → Gửi token lên backend → Xử lý silent push.

#### Bước 1: Tạo APNs Key (Apple Developer)
1. Đăng nhập https://developer.apple.com/account.
2. **Certificates, Identifiers & Profiles** → **Keys** → nút **+**.
3. **Key Name:** ví dụ `FaceSwap APNs Key`.
4. Chọn **Apple Push Notifications service (APNs)** → **Continue** → **Register**.
5. Tải file **.p8** (chỉ tải được **một lần** — lưu an toàn).
6. Ghi lại **Key ID** (10 ký tự) và **Team ID** (trong Membership).

#### Bước 2: Upload APNs key lên Firebase
1. Firebase Console → project → **Project Settings** (⚙️) → tab **Cloud Messaging**.
2. Phần **Apple app configuration** → **Upload** (APNs Authentication Key).
3. Chọn file **.p8**, nhập **Key ID** và **Team ID** → **Upload**.

#### Bước 3: Thêm app iOS vào Firebase
1. Firebase Console → **Add app** → chọn icon **iOS**.
2. Nhập **iOS bundle ID** (trùng với Bundle Identifier trong Xcode).
3. (Tùy chọn) App nickname, App Store ID.
4. Tải **GoogleService-Info.plist** → thêm vào Xcode project (kéo vào project, check “Copy items if needed”).

#### Bước 4: Cấu hình Xcode
1. Mở project trong **Xcode** → chọn **target** app.
2. Tab **Signing & Capabilities** → **+ Capability** → thêm **Push Notifications**.
3. **+ Capability** → thêm **Background Modes** → bật **Remote notifications**.
4. Đảm bảo **Signing** đúng Team và Bundle ID trùng với Firebase.

#### Bước 5: Thêm Firebase SDK
1. Thêm Firebase qua Swift Package Manager hoặc CocoaPods (ví dụ: `Firebase/Messaging`).
2. Trong `AppDelegate`: gọi `FirebaseApp.configure()` khi khởi động.

#### Bước 6: Code trong app
- **Lúc mở app:** Sau khi có FCM token (delegate `Messaging.messaging().delegate`), gọi `POST /api/device/register` với `profile_id`, `platform: "ios"`, `token`, (tùy chọn) `app_version`.
- **Nhận silent push:** Implement `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)` — xử lý `userInfo` (ví dụ `type`, `operation_complete`, `result_id`). Gọi `completionHandler(.newData)` hoặc `.noData`/`.failed` khi xong.

Code mẫu chi tiết xem ở mục [iOS (Swift)](#ios-swift) bên dưới.

---

### Web (Firebase SDK v10)

```html
<script type="module">
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js';

const app = initializeApp({
  apiKey: "AIzaSyAmbOxp0Me8ZlPvRCttD8Uy_X70hP9WDLs",
  projectId: "ai-photo-office",
  messagingSenderId: "367853530094",
  appId: "1:367853530094:web:faceswap"
});

const messaging = getMessaging(app);

// 1. Get token
const token = await getToken(messaging, { vapidKey: 'YOUR_VAPID_KEY' });

// 2. Register with backend
await fetch('/api/device/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    profile_id: userProfileId,
    platform: 'web',
    token: token
  })
});

// 3. Listen for messages
onMessage(messaging, (payload) => {
  console.log('Push received:', payload.data);
  const { type, operation, status, result_id } = payload.data;
  
  if (type === 'operation_complete' && status === 'success') {
    // Refresh UI, load new result
    loadResult(result_id);
  }
});
</script>
```

**Service Worker (`firebase-messaging-sw.js`):**
```javascript
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAmbOxp0Me8ZlPvRCttD8Uy_X70hP9WDLs",
  projectId: "ai-photo-office",
  messagingSenderId: "367853530094",
  appId: "1:367853530094:web:faceswap"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('Background message:', payload);
  // Handle silent push (no notification bar)
});
```

---

### Android (Kotlin)

**MainActivity.kt:**
```kotlin
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Register FCM token
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                val token = task.result
                lifecycleScope.launch {
                    ApiService.registerDevice(
                        profileId = UserSession.getProfileId(),
                        platform = "android",
                        token = token,
                        appVersion = BuildConfig.VERSION_NAME
                    )
                }
            }
        }
    }
}
```

**MyFirebaseMessagingService.kt:**
```kotlin
class MyFirebaseMessagingService : FirebaseMessagingService() {
    
    override fun onMessageReceived(message: RemoteMessage) {
        // Data-only message → always called (even in background)
        val data = message.data
        
        when (data["type"]) {
            "operation_complete" -> {
                val operation = data["operation"]
                val status = data["status"]
                val resultId = data["result_id"]
                
                if (status == "success") {
                    // Sync result, update UI
                    ResultRepository.fetchResult(resultId)
                    EventBus.post(OperationCompleteEvent(operation, resultId))
                }
            }
            "balance_sync" -> {
                BalanceRepository.updateBalance(data["amount"] ?: "0")
            }
        }
    }
    
    override fun onNewToken(token: String) {
        // Token refresh
        CoroutineScope(Dispatchers.IO).launch {
            ApiService.registerDevice(
                profileId = UserSession.getProfileId(),
                platform = "android",
                token = token
            )
        }
    }
}
```

**AndroidManifest.xml:**
```xml
<service
    android:name=".MyFirebaseMessagingService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```

---

### iOS (Swift)

**AppDelegate.swift:**
```swift
import Firebase
import FirebaseMessaging

@main
class AppDelegate: UIResponder, UIApplicationDelegate, MessagingDelegate {
    
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        
        FirebaseApp.configure()
        Messaging.messaging().delegate = self
        
        // Request permission
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            print("Permission granted: \(granted)")
        }
        
        application.registerForRemoteNotifications()
        return true
    }
    
    // Get FCM token
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let token = fcmToken else { return }
        
        Task {
            try await ApiService.registerDevice(
                profileId: UserSession.shared.profileId,
                platform: "ios",
                token: token,
                appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
            )
        }
    }
    
    // Handle silent push (content-available: 1)
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        
        guard let type = userInfo["type"] as? String else {
            completionHandler(.noData)
            return
        }
        
        switch type {
        case "operation_complete":
            let status = userInfo["status"] as? String
            let resultId = userInfo["result_id"] as? String
            
            if status == "success", let id = resultId {
                ResultRepository.shared.fetchResult(id: id) { success in
                    completionHandler(success ? .newData : .failed)
                }
            } else {
                completionHandler(.noData)
            }
            
        case "balance_sync":
            let amount = userInfo["amount"] as? String ?? "0"
            BalanceRepository.shared.updateBalance(amount: amount) { success in
                completionHandler(success ? .newData : .failed)
            }
            
        default:
            completionHandler(.noData)
        }
    }
}
```

**Info.plist:**
```xml
<key>UIBackgroundModes</key>
<array>
    <string>remote-notification</string>
</array>
```

---

## Checklist trước khi test (Web Push)

Đảm bảo đã làm đủ trước khi mở trang Push Test (`/fcm-test.html`):

| # | Việc cần làm | Ở đâu |
|---|----------------|--------|
| 1 | Bật **Firebase Installations API** | Google Cloud Console → APIs & Services → Library → Enable |
| 2 | Bật **Firebase Cloud Messaging API** (FCM) | Cùng trang Library → Enable |
| 3 | Lấy **VAPID key** | Firebase Console → Project Settings → Cloud Messaging → Web Push certificates |
| 4 | Thêm **FCM_VAPID_KEY** vào `deployments-secrets.json` | Mỗi environment cần dùng |
| 5 | Deploy frontend (để inject VAPID vào `fcm-test.html`) | `npm run deploy:ai-office-dev` (hoặc env tương ứng) |
| 6 | Có **profile_id** hợp lệ (đã tạo trong app/DB) | Dùng khi Register Device |

Thiếu bước 1 hoặc 2 → lỗi **403 PERMISSION_DENIED** khi lấy token. Thiếu 3–5 → lỗi **applicationServerKey is not valid**.

---

## Testing

### 1. Test UI (Web)

**URL:** `https://your-domain.pages.dev/fcm-test.html`

**Steps:**
1. Click **"🔔 Request Permission"**
2. Fill **Profile ID**: `test-profile-123` (hoặc profile_id đã có trong DB)
3. Click **"✅ Register Device"**
4. Fill **MOBILE_API_KEY** (từ `deployments-secrets.json`) khi gửi push
5. Click **"📤 Send Push"**
6. Check logs for delivery

---

### 2. Verify Database

```bash
wrangler d1 execute faceswap-db-office-dev --command "SELECT * FROM device_tokens"
```

Expected output:
```
token                 | profile_id        | platform | updated_at
fcm-web-token-xyz     | test-profile-123  | web      | 1706900000
```

---

### 3. Manual Push Test

```bash
curl -X POST https://api.d.shotpix.app/api/push/silent \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_FCM_API_KEY" \
  -d '{
    "profile_id": "test-profile-123",
    "data": {
      "type": "test",
      "message": "Hello from backend"
    }
  }'
```

Expected response:
```json
{
  "data": {
    "sent": 1,
    "failed": 0,
    "cleaned": 0
  },
  "status": "success"
}
```

---

### 4. Auto-Push Test

After adding `ctx.waitUntil()` calls:

1. Call `/faceswap` endpoint
2. Check browser console (Web) or logcat (Android) or Xcode console (iOS)
3. Should see push with:
```json
{
  "type": "operation_complete",
  "operation": "faceswap",
  "status": "success",
  "result_id": "result_xyz",
  "timestamp": "1706900000"
}
```

---

## Troubleshooting

### 403 PERMISSION_DENIED – Firebase Installations API

**Lỗi:** `Create Installation request failed ... 403 PERMISSION_DENIED ... CreateInstallation are blocked` hoặc `Firebase Installations API has not been used ... or it is disabled`

**Nguyên nhân (1 trong 2):**
- **A.** API Firebase Installations chưa bật trong project.
- **B.** **API key** (trong firebaseConfig) bị **API restrictions** — không cho gọi Firebase Installations. Đây là nguyên nhân thường gặp khi đã bật API mà vẫn 403.

**Cách xử lý:**

**Bước 1 – Bật API (nếu chưa):**
1. https://console.cloud.google.com/apis/library/firebaseinstallations.googleapis.com?project=ai-photo-office  
2. Bấm **Enable**.

**Bước 2 – Sửa API key (quan trọng):**
1. Mở https://console.cloud.google.com/apis/credentials?project=ai-photo-office  
2. Ở **API keys**, tìm key trùng với **apiKey** trong firebaseConfig (trong `fcm-test.html` / Firebase Console Web app config).  
3. Click tên key → **Edit** (hoặc icon bút).  
4. Kéo xuống **API restrictions**:
   - **Cách 1 (đơn giản):** Chọn **Don't restrict key** → **Save**. (Dùng tạm cho test; sau có thể restrict lại.)
   - **Cách 2 (bảo mật hơn):** Chọn **Restrict key** → trong **API restrictions** chọn **Restrict key** → thêm **Firebase Installations API** và **Firebase Cloud Messaging API** vào danh sách → **Save**.  
5. Nếu key đang **HTTP referrer** restricted: thêm đúng domain (ví dụ `https://your-domain.pages.dev/*`, `http://localhost:*`) hoặc tạm dùng key không restrict referrer cho FCM Web.  
6. Đợi 2–5 phút rồi reload trang Push Test và thử lại.

**Link nhanh:**
- Credentials (sửa API key): https://console.cloud.google.com/apis/credentials?project=ai-photo-office  
- Bật Firebase Installations API: https://console.cloud.google.com/apis/library/firebaseinstallations.googleapis.com?project=ai-photo-office

---

### 400 INVALID_ARGUMENT – Create Installation

**Lỗi:** `Create Installation request failed with error "400 INVALID_ARGUMENT: Request contains an invalid argument."`

**Nguyên nhân:** **firebaseConfig** (đặc biệt **appId**) không khớp với Web app trong Firebase. Thường do:
- Dùng **appId** mẫu/placeholder (ví dụ `1:xxx:web:faceswap`) thay vì appId thật Firebase tạo khi Add app → Web.
- Web app chưa được thêm trong project, hoặc config copy sai.

**Cách xử lý:**
1. Mở **Firebase Console** → project **ai-photo-office** → **Project Settings** (⚙️) → **General**.
2. Kéo xuống **Your apps**. Nếu chưa có app **Web** (icon `</>`): bấm **Add app** → **Web** → đặt tên → **Register app**.
3. Copy **toàn bộ** object **firebaseConfig** (apiKey, authDomain, projectId, storageBucket, messagingSenderId, **appId**). appId đúng dạng do Firebase tạo, ví dụ: `1:367853530094:web:a1b2c3d4e5f67890` (phần sau `web:` là chuỗi do Firebase sinh, không phải chữ như `faceswap`).
4. Mở `frontend-cloudflare-pages/fcm-test.html`, tìm `const firebaseConfig = { ... }`, **thay toàn bộ** bằng config vừa copy.
5. Mở `frontend-cloudflare-pages/firebase-messaging-sw.js`, tìm `firebase.initializeApp({ ... })`, **thay toàn bộ** object bên trong bằng config vừa copy (giữ đúng format).
6. Deploy lại frontend (hoặc test local), xóa cache / hard reload trang rồi thử lại.

**Tóm lại:** Phải dùng đúng **firebaseConfig** (và **appId**) từ Firebase Console → Your apps → Web app, không tự đặt hoặc dùng config mẫu.

---

### iOS không nhận push

**Nguyên nhân:**
- APNs key chưa upload vào Firebase
- Xcode chưa enable Push Notifications
- Info.plist thiếu `UIBackgroundModes`

**Fix:**
1. Firebase Console → Cloud Messaging → Check APNs key
2. Xcode → Capabilities → Push Notifications ✓
3. Xcode → Capabilities → Background Modes → Remote notifications ✓
4. Test: Firebase Console → Cloud Messaging → Send test message

---

### Android hiển thị notification bar

**Nguyên nhân:** Payload có field `notification`

**Fix:** Đảm bảo chỉ gửi `data` field, KHÔNG có `notification`:
```json
{
  "message": {
    "token": "...",
    "data": { "type": "sync" },
    "android": { "priority": "NORMAL" }
  }
}
```

---

### Token invalid (NOT_REGISTERED)

**Nguyên nhân:**
- App uninstalled
- Token expired/rotated
- Bundle ID/Package name sai

**Fix:** Auto-handled! Worker tự động xóa invalid tokens khỏi DB.

---

### OAuth token error

**Nguyên nhân:**
- Service account credentials sai
- Private key corrupt (thiếu `\n`)
- Project ID không khớp

**Fix:**
```bash
# Re-generate từ Firebase Console
# Re-upload secrets
wrangler secret put FIREBASE_SA_EMAIL
wrangler secret put FIREBASE_SA_PRIVATE_KEY
```

---

### Web không nhận push

**Nguyên nhân:** Service worker chưa register hoặc VAPID key sai

**Fix:**
1. Check service worker: DevTools → Application → Service Workers
2. Re-generate VAPID key: Firebase Console → Cloud Messaging → Web Push certificates
3. Update `vapidKey` trong code

---

## Files Summary

**NEW FILES (6):**
- `frontend-cloudflare-pages/fcm-test.html` - Test UI
- `frontend-cloudflare-pages/firebase-messaging-sw.js` - Service worker
- `backend-cloudflare-workers/migrations/0006_device_tokens.sql` - D1 migration

**MODIFIED FILES (5):**
- `backend-cloudflare-workers/types.ts` - 4 interfaces
- `backend-cloudflare-workers/config.ts` - FCM_CONFIG
- `backend-cloudflare-workers/services.ts` - 3 functions
- `backend-cloudflare-workers/index.ts` - 3 routes
- `_deploy-cli-cloudflare-gcp/deployments-secrets.json` - 4 fields
- `frontend-cloudflare-pages/docs/API_TONG_QUAN_VI.md` - FCM section

**COMMANDS:**
```bash
npm run db:migrate
npm run deploy:ai-office-dev:workers
```

**DONE!** 🎉
