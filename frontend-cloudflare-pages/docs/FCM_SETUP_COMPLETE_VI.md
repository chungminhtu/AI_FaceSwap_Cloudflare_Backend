# FCM Setup Complete – Token Android / iOS / Web

---

## 1. Tổng quan

**Luồng:** Lấy token → `POST /api/device/register` (profile_id, platform, token) → nhận push khi operation xong (faceswap/beauty/filter/…).

**Đặc điểm:**
- **Silent Push:** Không hiển thị notification bar; app xử lý data trong background.
- **Multi-Device:** Một profile có thể có nhiều devices (phone, tablet, web).
- **Profile-Based:** Push gửi đến tất cả devices của profile đó.

---

## 2. Prerequisites (client)

- **Firebase project** với Android / iOS / Web app đã thêm (package name / Bundle ID / Web app trùng với app của bạn).
- **Android:** `google-services.json` từ Firebase Console.
- **iOS:** `GoogleService-Info.plist`; APNs key (.p8) đã upload vào Firebase (Cloud Messaging → Apple app).
- **Web:** HTTPS; **firebaseConfig** và **VAPID** (Firebase Console hoặc deploy inject). Xem mục 6 (Web – Files và config).
- **Profile:** `POST /api/device/register` cần `profile_id` hợp lệ (đã tạo qua API trước đó).

---

## 3. Lấy FCM device token – Android

### 3.1 Điều kiện bắt buộc

- Firebase project đã tạo; đã thêm **Android app** (package name trùng với app).
- **google-services.json** tải từ Firebase Console (Project settings → Your apps → Android) và đặt đúng vị trí (ví dụ `android/app/google-services.json`).
- Gradle: đã apply plugin `com.google.gms.google-services` và thêm dependency Firebase BOM + `firebase-messaging`.

### 3.2 Các bước triển khai

**Bước 1 – Gradle (project-level):**
```gradle
// build.gradle (project)
buildscript {
  dependencies {
    classpath 'com.google.gms:google-services:4.x.x'
  }
}
```

**Bước 2 – Gradle (app-level):**
```gradle
// build.gradle (app)
plugins {
  id 'com.android.application'
  id 'com.google.gms.google-services'
}
dependencies {
  implementation platform('com.google.firebase:firebase-bom:32.x.x')
  implementation 'com.google.firebase:firebase-messaging'
}
```

**Bước 3 – AndroidManifest.xml:**  
Khai báo Service xử lý FCM (bắt buộc để nhận message và onNewToken):

```xml
<service
    android:name=".MyFirebaseMessagingService"
    android:exported="false">
  <intent-filter>
    <action android:name="com.google.firebase.MESSAGING_EVENT" />
  </intent-filter>
</service>
```

**Bước 4 – Lấy token (Kotlin):**
- Gọi `Firebase.messaging.token` (coroutine) hoặc `FirebaseMessaging.getInstance().token.addOnCompleteListener`.
- Token chỉ có sau khi Firebase đã init (sau khi app khởi động, thường ngay sau khi có google-services.json và đã build).

```kotlin
// Kotlin – lấy token (chạy sau khi user đã login / có profile_id)
FirebaseMessaging.getInstance().token
  .addOnCompleteListener { task ->
    if (!task.isSuccessful) return@addOnCompleteListener
    val token = task.result ?: return@addOnCompleteListener
    registerDeviceToBackend(profileId = "profile_xxx", platform = "android", token = token)
  }
```

**Bước 5 – onNewToken (bắt buộc):**  
Token có thể đổi; mỗi khi có token mới gửi lại qua `POST /api/device/register`.

```kotlin
// MyFirebaseMessagingService.kt
class MyFirebaseMessagingService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    super.onNewToken(token)
    registerDeviceToBackend(profileId = currentProfileId, platform = "android", token = token)
  }

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    // Chỉ nhận data payload (silent push). Không có remoteMessage.notification.
    val data = remoteMessage.data
    // Xử lý data: type, operation, result_id, v.v.
  }
}
```

**Lưu ý quan trọng:**  
- Không lấy token trong `Application.onCreate` quá sớm; có thể dùng `Handler().postDelayed` vài trăm ms hoặc lấy sau khi user đã có profile_id.  
- Luôn implement `onNewToken` và gửi token mới lên backend.  
- Data-only message (backend không gửi `notification`) → luôn vào `onMessageReceived`; không hiện notification bar trừ khi app tự hiển thị.

---

## 4. Lấy FCM device token – iOS

### 4.1 Điều kiện bắt buộc

- Firebase project đã thêm **iOS app** (Bundle ID trùng với Xcode).
- **APNs key (.p8)** đã tạo trong Apple Developer (Keys), đã upload vào Firebase (Project settings → Cloud Messaging → Apple app configuration).
- **GoogleService-Info.plist** tải từ Firebase, thêm vào Xcode project.
- Xcode: **Signing & Capabilities** → bật **Push Notifications** và **Background Modes** (chọn **Remote notifications**).
- Firebase SDK (Firebase/Messaging) đã thêm qua SPM hoặc CocoaPods.

### 4.2 Các bước triển khai

**Bước 1 – Capabilities:**  
Target → Signing & Capabilities → + Capability → **Push Notifications**; thêm **Background Modes** → bật **Remote notifications**.

**Bước 2 – AppDelegate / SceneDelegate:**  
Đăng ký remote notification và set delegate cho Messaging để nhận FCM token.

```swift
// AppDelegate
import FirebaseCore
import FirebaseMessaging
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, MessagingDelegate, UNUserNotificationCenterDelegate {

  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    FirebaseApp.configure()
    UNUserNotificationCenter.current().delegate = self
    Messaging.messaging().delegate = self
    application.registerForRemoteNotifications()
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Messaging.messaging().apnsToken = deviceToken
  }

  func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
    guard let token = fcmToken else { return }
    registerDeviceToBackend(profileId: currentProfileId, platform: "ios", token: token)
  }
}
```

**Bước 3 – Lấy token:**  
FCM token xuất hiện trong callback `messaging(_:didReceiveRegistrationToken:)`. Callback này được gọi:
- Sau khi `registerForRemoteNotifications` và APNs token đã được set vào Firebase (`apnsToken`).
- Mỗi lần app mở hoặc khi token đổi.

Nếu cần lấy token chủ động (ví dụ sau khi login):

```swift
Messaging.messaging().token { token, error in
  guard let token = token else { return }
  registerDeviceToBackend(profileId: currentProfileId, platform: "ios", token: token)
}
```

**Bước 4 – Silent push (data-only):**  
Backend gửi không có `notification`, chỉ `data`; cần xử lý trong:

```swift
func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
  // Xử lý userInfo (data payload)
  completionHandler(.newData)
}
```

**Lưu ý quan trọng:**  
- APNs key (.p8) phải được upload đúng trong Firebase (Cloud Messaging → Apple app). Thiếu hoặc sai → không có FCM token.  
- Nếu tắt swizzling (`FirebaseAppDelegateProxyEnabled = NO`), phải tự set `Messaging.messaging().apnsToken = deviceToken` trong `didRegisterForRemoteNotificationsWithDeviceToken`.  
- Simulator không nhận remote notification; cần device thật.  
- Silent push cần Background Modes → Remote notifications và gọi `completionHandler(.newData)`.

---

## 5. Lấy FCM device token – Web

### 5.1 Điều kiện bắt buộc

- **HTTPS** (service worker chỉ chạy trên HTTPS).
- **firebaseConfig** và **VAPID** — mục 6.

### 5.2 Các bước triển khai

**Bước 1 – Thêm Firebase SDK và khởi tạo:**
```html
<script type="module">
  import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.x.x/firebase-app.js';
  import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/10.x.x/firebase-messaging.js';

  const firebaseConfig = { apiKey: "...", authDomain: "...", projectId: "...", storageBucket: "...", messagingSenderId: "...", appId: "..." };
  const app = initializeApp(firebaseConfig);
  const messaging = getMessaging(app);
</script>
```

**Bước 2 – Service worker:**  
Cần **firebase-messaging-sw.js** tại root domain; import Firebase Messaging, `initializeApp(firebaseConfig)`, `onBackgroundMessage`. firebaseConfig và VAPID: mục 6.

```javascript
// firebase-messaging-sw.js (root domain)
importScripts('https://www.gstatic.com/firebasejs/10.x.x/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.x.x/firebase-messaging-compat.js');
firebase.initializeApp(/* firebaseConfig */);
firebase.messaging().onBackgroundMessage((payload) => {});
```

**Bước 3 – Xin quyền và lấy token:**  
`getToken(messaging, { vapidKey })` sau khi user cho phép notification.

```javascript
const permission = await Notification.requestPermission();
if (permission !== 'granted') return null;
const token = await getToken(messaging, { vapidKey: '...' });
if (token) {
  await fetch(API_BASE + '/api/device/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_id: profileId, platform: 'web', token, app_version: '1.0.0' })
  });
}
```

**Bước 4 – Foreground:**  
Nhận message khi tab đang mở bằng `onMessage`:

```javascript
onMessage(messaging, (payload) => {
  console.log('Foreground message', payload);
  const data = payload.data || {};
  // data.type, data.operation, data.result_id, ...
});
```

---

## 6. Web – Files và config cần có

Để tích hợp FCM trên Web cần:

- **Trang có logic FCM** (vd. fcm-test.html): xin quyền notification → nhập profile_id → gọi `POST /api/device/register` với token → (tùy chọn) gửi push.
- **firebase-messaging-sw.js** — Service worker, đặt tại root domain (bắt buộc).
- **firebaseConfig** và **VAPID** — Firebase Console → Cloud Messaging → Web Push certificates, hoặc inject lúc deploy.

---

## 7. API Endpoints

| Method | Path | Auth | Mô tả |
|--------|------|------|--------|
| POST | `/api/device/register` | None | Đăng ký/cập nhật FCM token. |
| POST | `/api/push/silent` | `X-API-Key: MOBILE_API_KEY` | Gửi data-only push theo `profile_id`. |
| DELETE | `/api/device/unregister` | None | Xóa FCM token. |

### 7.1 POST /api/device/register

**Body:** `profile_id` (required), `platform` (android \| ios \| web), `token` (required), `app_version` (optional).

**Request:**
```json
{
  "profile_id": "profile_1234567890",
  "platform": "android",
  "token": "fcm-device-token-here",
  "app_version": "1.0.0"
}
```

**Response 200:** `{ "data": { "registered": true }, "status": "success", "message": "Processing successful", "code": 200 }`

**Ví dụ:**
```bash
curl -X POST https://api.d.shotpix.app/api/device/register \
  -H "Content-Type: application/json" \
  -d '{"profile_id":"profile_abc123","platform":"web","token":"fcm-web-token-xyz","app_version":"1.0.0"}'
```

### 7.2 POST /api/push/silent

**Auth:** `X-API-Key: MOBILE_API_KEY`

**Body:** `profile_id` (required), `data` (object, values string), `exclude_token` (optional).

**Request:**
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

**Response 200:** `{ "data": { "sent", "failed", "cleaned", "results": [...] }, "status": "success", ... }`

**Ví dụ:**
```bash
curl -X POST https://api.d.shotpix.app/api/push/silent \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-mobile-api-key-here" \
  -d '{"profile_id":"profile_abc123","data":{"type":"balance_sync","amount":"100","timestamp":"1706900000"}}'
```

### 7.3 DELETE /api/device/unregister

**Body:** `token` (required).

**Request:** `{ "token": "fcm-device-token-to-remove" }`

**Response 200:** `{ "data": { "unregistered": true }, "status": "success", "message": "Processing successful", "code": 200 }`

**Ví dụ:**
```bash
curl -X DELETE https://api.d.shotpix.app/api/device/unregister \
  -H "Content-Type: application/json" \
  -d '{"token":"fcm-device-token-xyz"}'
```

### 7.4 Auto-Push

Khi thành công, các API sau tự gửi push (payload như 7.2): `/faceswap`, `/beauty`, `/filter`, `/upscaler4k`, `/background`. Payload: `type`, `operation`, `status`, `result_id`, `timestamp`. Lỗi: `status: "error"`, `error`.

---

## 8. Troubleshooting

| Triệu chứng / Lỗi | Nguyên nhân có thể | Hành động |
|-------------------|--------------------|-----------|
| 403 PERMISSION_DENIED (Firebase Installations) | API chưa bật hoặc API key bị restrict | Bật Firebase Installations API + FCM API; Credentials → sửa firebaseConfig.apiKey. |
| 400 INVALID_ARGUMENT (Create Installation) | firebaseConfig/appId sai | Dùng đúng firebaseConfig từ Firebase Console. |
| applicationServerKey is not valid | Thiếu hoặc sai VAPID | Firebase Console → Cloud Messaging → Web Push certificates → lấy key, dùng đúng trong getToken. |
| Web không nhận push | Service worker chưa đăng ký hoặc VAPID sai | DevTools → Application → Service Workers; kiểm tra VAPID và firebaseConfig trong sw. |
| Android hiển thị notification bar | Payload có field `notification` | Chỉ dùng data-only message (không gửi `notification`). |
| Token invalid (NOT_REGISTERED) | App gỡ, token xoay, bundle/package sai | Đăng ký lại token mới qua POST /api/device/register. |
| iOS không có token | APNs chưa cấu hình hoặc thiếu capability | Upload .p8 vào Firebase; bật Push Notifications + Remote notifications; chạy trên device thật. |
