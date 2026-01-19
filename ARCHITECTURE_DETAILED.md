# KIẾN TRÚC CHI TIẾT - AI FaceSwap Backend

## Mục lục
1. [Mermaid Diagram](#mermaid-diagram)
2. [Database Schema](#database-schema)
3. [API Specifications](#api-specifications)
4. [Device Management & Push Notifications](#device-management-endpoints-multi-device-push-sync)
5. [Authentication](#authentication)
6. [Error Codes](#error-codes)
7. [KV Cache Keys](#kv-cache-keys)
8. [R2 Storage Structure](#r2-storage-structure)
9. [Environment Variables](#environment-variables)
10. [Android Client Implementation](#android-client-implementation-notes)

---

## Mermaid Diagram

```mermaid
---
config:
    maxEdges: 44000
    theme: forest
---
%%{init: { "sequence": { "messageAlign": "left", "noteAlign": "left", "actorMargin": 50, "mirrorActors": false } } }%%
sequenceDiagram
title KIẾN TRÚC GỐC + MỞ RỘNG WEBHOOKS, STORAGE & PUSH NOTIFICATIONS
autonumber

participant Client as Android App
participant Play as Google Play Console
participant GCP as Google Cloud Pub/Sub
participant Worker as Cloudflare Worker
participant KV as Cloudflare KV (Cache)
participant D1 as Cloudflare D1 (SQL Ledger)
participant R2 as Cloudflare R2 (Archive)
participant AI as Vertex AI (Gemini)
participant FCM as Firebase Cloud Messaging
participant Cron as Cloudflare Cron

rect rgb(220, 220, 220)
    Note over Client, AI: ─── GIỮ NGUYÊN CẤU TRÚC GỐC CỦA BẠN ───
    Note right of D1: 📊 DATABASE SCHEMA (D1 SQLite)<br/>──────────────────────────<br/>1. TABLE users<br/>   • uid TEXT PK (Firebase UID)<br/>   • email TEXT UNIQUE<br/>   • credits INTEGER DEFAULT 0<br/>   • tier TEXT DEFAULT 'free'<br/>   • created_at INTEGER (Unix)<br/>   • updated_at INTEGER (Unix)<br/>──────────────────────────<br/>2. TABLE logs<br/>   • req_id TEXT PK (UUID)<br/>   • uid TEXT FK → users<br/>   • action TEXT ('generate')<br/>   • cost INTEGER (credits used)<br/>   • status TEXT ('PENDING'/'COMPLETED'/'REFUNDED')<br/>   • ai_model TEXT<br/>   • input_hash TEXT<br/>   • output_url TEXT<br/>   • error_msg TEXT<br/>   • created_at INTEGER<br/>   • completed_at INTEGER<br/>──────────────────────────<br/>3. TABLE payments<br/>   • order_id TEXT PK (Google)<br/>   • uid TEXT FK → users<br/>   • token TEXT UNIQUE<br/>   • sku_id TEXT<br/>   • amount INTEGER (credits)<br/>   • price_cents INTEGER<br/>   • currency TEXT<br/>   • status TEXT ('COMPLETED'/'REFUNDED')<br/>   • acknowledged INTEGER (0/1)<br/>   • created_at INTEGER<br/>   • updated_at INTEGER<br/>──────────────────────────<br/>INDEX idx_users_email ON users(email)<br/>INDEX idx_logs_uid ON logs(uid)<br/>INDEX idx_logs_status ON logs(status)<br/>INDEX idx_payments_uid ON payments(uid)<br/>INDEX idx_payments_token ON payments(token)<br/>──────────────────────────<br/>4. TABLE device_tokens (MULTI-DEVICE)<br/>   • id INTEGER PK AUTOINCREMENT<br/>   • uid TEXT FK → users<br/>   • device_id TEXT UNIQUE<br/>   • fcm_token TEXT NOT NULL<br/>   • device_name TEXT<br/>   • device_model TEXT<br/>   • os_version TEXT<br/>   • app_version TEXT<br/>   • is_active INTEGER DEFAULT 1<br/>   • last_seen_at INTEGER<br/>   • created_at INTEGER<br/>   • updated_at INTEGER<br/>──────────────────────────<br/>INDEX idx_device_uid ON device_tokens(uid)<br/>INDEX idx_device_fcm ON device_tokens(fcm_token)
end

%% ─── PHẦN 1: MUA TÍN DỤNG (GIỮ NGUYÊN) ───
rect rgb(230, 240, 255)
    Note over Client, D1: 🟢 PHẦN 1 NẠP CREDIT (DEPOSIT FLOW)

    Client->>Play: Thực hiện Mua (In-App Purchase)
    Play-->>Client: Trả về "purchaseToken" & "orderId"

    Note right of Client: 📤 REQUEST<br/>──────────────────────────<br/>POST /api/deposit<br/>Headers:<br/>  Authorization: Bearer {firebase_jwt}<br/>  Content-Type: application/json<br/>  X-App-Version: 1.0.0<br/>  X-Device-ID: {device_uuid}<br/>Body:<br/>{<br/>  "token": "purchaseToken...",<br/>  "sku_id": "credits_100",<br/>  "order_id": "GPA.1234-5678"<br/>}
    Client->>Worker: POST /api/deposit<br/>Body { token, sku_id, orderId }

    Note right of Worker: 🔐 AUTH CHECK<br/>──────────────────────────<br/>1. Extract JWT from Authorization header<br/>2. Verify Firebase JWT signature<br/>   • iss: https://securetoken.google.com/{project}<br/>   • aud: {firebase_project_id}<br/>   • exp: not expired<br/>3. Extract uid from JWT payload<br/>4. Check user exists in D1<br/>──────────────────────────<br/>If invalid → 401 Unauthorized<br/>{ "error": "AUTH_INVALID_TOKEN" }

    Worker->>KV: Lấy Google Access Token (Cached)
    Note right of KV: 🗄️ KV KEYS<br/>──────────────────────────<br/>Key: google_access_token<br/>Value: { "token": "ya29...", "expires": 1234567890 }<br/>TTL: 3300 seconds (55 min)
    alt Token không có hoặc hết hạn
        Note right of Worker: 🔑 Service Account JWT<br/>──────────────────────────<br/>Header: { "alg": "RS256", "typ": "JWT" }<br/>Payload:<br/>{<br/>  "iss": "sa@project.iam.gserviceaccount.com",<br/>  "scope": "https://www.googleapis.com/auth/androidpublisher",<br/>  "aud": "https://oauth2.googleapis.com/token",<br/>  "iat": 1234567890,<br/>  "exp": 1234571490<br/>}
        Worker->>Play: Sign JWT -> Xin Access Token Mới
        Worker->>KV: Lưu Token (TTL 55 phút)
    end

    Note right of Worker: 📡 GOOGLE API CALL<br/>──────────────────────────<br/>GET https://androidpublisher.googleapis.com<br/>/androidpublisher/v3/applications<br/>/{packageName}/purchases/products<br/>/{productId}/tokens/{token}<br/>Headers:<br/>  Authorization: Bearer {google_token}
    Worker->>Play: GET /androidpublisher/.../purchases/products/{token}
    Note right of Play: 📥 GOOGLE RESPONSE<br/>──────────────────────────<br/>{<br/>  "purchaseState": 0,<br/>  "consumptionState": 0,<br/>  "orderId": "GPA.1234-5678",<br/>  "purchaseTimeMillis": "1234567890000",<br/>  "regionCode": "VN",<br/>  "kind": "androidpublisher#productPurchase"<br/>}<br/>──────────────────────────<br/>purchaseState:<br/>  0 = Purchased<br/>  1 = Canceled<br/>  2 = Pending<br/>consumptionState:<br/>  0 = Not consumed<br/>  1 = Consumed
    Play-->>Worker: { purchaseState 0, consumptionState 0 }

    alt Purchase Hợp lệ & Chưa sử dụng
        Note right of Worker: 💾 ATOMIC TRANSACTION (SQL BATCH)<br/>──────────────────────────<br/>BEGIN TRANSACTION⁏<br/><br/>INSERT INTO payments (<br/>  order_id, uid, token, sku_id,<br/>  amount, price_cents, currency,<br/>  status, acknowledged, created_at<br/>) VALUES (<br/>  'GPA.1234', 'user123', 'token...',<br/>  'credits_100', 100, 99, 'USD',<br/>  'COMPLETED', 0, 1234567890<br/>)⁏<br/><br/>UPDATE users<br/>SET credits = credits + 100,<br/>    updated_at = 1234567890<br/>WHERE uid = 'user123'⁏<br/><br/>COMMIT⁏
        Worker->>D1: Thực thi Batch SQL

        alt Lỗi Unique Constraint
            Note right of Worker: ⚠️ ERROR RESPONSE<br/>──────────────────────────<br/>HTTP 409 Conflict<br/>{<br/>  "error": "DEPOSIT_DUPLICATE",<br/>  "message": "Order already processed",<br/>  "order_id": "GPA.1234-5678"<br/>}
            Worker-->>Client: 409 Conflict (Đã cộng rồi)
        else Thành công
            D1-->>Worker: OK (Rows Affected 1)

            Note right of Worker: 📡 ACKNOWLEDGE API<br/>──────────────────────────<br/>POST https://androidpublisher.googleapis.com<br/>/androidpublisher/v3/applications<br/>/{packageName}/purchases/products<br/>/{productId}/tokens/{token}:acknowledge<br/>Headers:<br/>  Authorization: Bearer {google_token}<br/>  Content-Type: application/json<br/>Body: {}
            Worker->>Play: POST /acknowledge
            Note right of Worker: ✅ SUCCESS RESPONSE<br/>──────────────────────────<br/>HTTP 200 OK<br/>{<br/>  "success": true,<br/>  "message": "Credits added",<br/>  "data": {<br/>    "order_id": "GPA.1234-5678",<br/>    "credits_added": 100,<br/>    "new_balance": 150,<br/>    "sku_id": "credits_100"<br/>  }<br/>}
            Worker-->>Client: 200 OK (Số dư 150)

            Note right of Worker: 📲 PUSH TO OTHER DEVICES<br/>──────────────────────────<br/>-- Get all devices except current<br/>SELECT fcm_token, device_id<br/>FROM device_tokens<br/>WHERE uid = 'user123'<br/>  AND device_id != 'current_device'<br/>  AND is_active = 1⁏
            Worker->>D1: Query other device tokens
            D1-->>Worker: [{fcm_token, device_id}, ...]
            Note right of Worker: 🔔 FCM HTTP v1 API<br/>──────────────────────────<br/>POST https://fcm.googleapis.com<br/>/v1/projects/{project}/messages:send<br/>Headers:<br/>  Authorization: Bearer {gcp_token}<br/>  Content-Type: application/json<br/>Body:<br/>{<br/>  "message": {<br/>    "token": "device_fcm_token",<br/>    "data": {<br/>      "type": "BALANCE_SYNC",<br/>      "new_balance": "150",<br/>      "change": "+100",<br/>      "event": "DEPOSIT",<br/>      "order_id": "GPA.1234"<br/>    },<br/>    "android": {<br/>      "priority": "high",<br/>      "ttl": "86400s"<br/>    }<br/>  }<br/>}<br/>──────────────────────────<br/>Send to ALL tokens in parallel<br/>using Promise.all()
            Worker->>FCM: POST /messages:send (batch)
            FCM-->>Worker: 200 OK (message_id)
            Note right of FCM: 📱 FCM delivers to all devices<br/>──────────────────────────<br/>Device A (purchased): Already updated<br/>Device B (tablet): Receives push<br/>Device C (old phone): Receives push<br/>──────────────────────────<br/>Client handles data message:<br/>• Update local balance cache<br/>• Refresh UI immediately<br/>• No notification shown (silent)

            Note right of Client: 📱 CLIENT CLEANUP<br/>──────────────────────────<br/>Call BillingClient.consumeAsync()<br/>to finalize the purchase
            Client->>Client: finishTransaction(consumable)
        end
    else Purchase Lỗi / Hết hạn
        Note right of Worker: ❌ ERROR RESPONSE<br/>──────────────────────────<br/>HTTP 400 Bad Request<br/>{<br/>  "error": "DEPOSIT_INVALID_PURCHASE",<br/>  "message": "Purchase invalid or expired",<br/>  "purchase_state": 1<br/>}
        Worker-->>Client: 400 Bad Request
    end
end

%% ─── PHẦN 2: SỬ DỤNG AI (GIỮ NGUYÊN) ───
rect rgb(255, 250, 240)
    Note over Client, AI: 🟠 PHẦN 2 TRỪ TIỀN & GỌI AI (SPENDING FLOW)

    Note right of Client: 📤 REQUEST<br/>──────────────────────────<br/>POST /api/generate<br/>Headers:<br/>  Authorization: Bearer {firebase_jwt}<br/>  Content-Type: application/json<br/>  X-Request-ID: req_vn_999 (UUID)<br/>  X-Idempotency-Key: req_vn_999<br/>Body:<br/>{<br/>  "action": "face_swap",<br/>  "source_image": "https://r2.../source.jpg",<br/>  "target_image": "https://r2.../target.jpg",<br/>  "options": {<br/>    "quality": "high",<br/>    "format": "png"<br/>  }<br/>}
    Client->>Worker: POST /api/generate<br/>Headers X-Request-ID req_vn_999

    Note right of Worker: 🔐 AUTH + VALIDATION<br/>──────────────────────────<br/>1. Verify Firebase JWT<br/>2. Validate X-Request-ID format (UUID)<br/>3. Validate request body schema<br/>4. Check rate limit (KV)<br/>──────────────────────────<br/>Rate Limit Key: rate:{uid}:{minute}<br/>Limit: 10 requests/minute

    Note right of Worker: 💾 SQL DEBIT TRANSACTION<br/>──────────────────────────<br/>BEGIN TRANSACTION⁏<br/><br/>-- Insert log first (catches duplicates)<br/>INSERT INTO logs (<br/>  req_id, uid, action, cost,<br/>  status, ai_model, input_hash,<br/>  created_at<br/>) VALUES (<br/>  'req_vn_999', 'user123', 'face_swap',<br/>  10, 'PENDING', 'gemini-pro',<br/>  'sha256:abc123', 1234567890<br/>)⁏<br/><br/>-- Debit credits atomically<br/>UPDATE users<br/>SET credits = credits - 10,<br/>    updated_at = 1234567890<br/>WHERE uid = 'user123'<br/>  AND credits >= 10⁏<br/><br/>-- Check rows affected<br/>-- If 0 → insufficient funds<br/><br/>COMMIT⁏
    Worker->>D1: BATCH EXECUTE<br/>1. INSERT INTO logs (req_id, status PENDING)<br/>2. UPDATE users SET credits-10 WHERE credits >= 10

    alt Lỗi Request ID đã tồn tại
        D1-->>Worker: Error Unique Constraint
        Note right of Worker: 🔄 IDEMPOTENCY RESPONSE<br/>──────────────────────────<br/>HTTP 200 OK<br/>{<br/>  "success": true,<br/>  "cached": true,<br/>  "data": {<br/>    "req_id": "req_vn_999",<br/>    "output_url": "https://r2.../result.png",<br/>    "status": "COMPLETED"<br/>  }<br/>}
        Worker-->>Client: 200 OK (Trả lại cache cũ)
    else Lỗi Không đủ tiền
        Note right of Worker: 💸 INSUFFICIENT FUNDS<br/>──────────────────────────<br/>HTTP 402 Payment Required<br/>{<br/>  "error": "GENERATE_INSUFFICIENT_CREDITS",<br/>  "message": "Not enough credits",<br/>  "required": 10,<br/>  "available": 5,<br/>  "purchase_options": [<br/>    { "sku_id": "credits_100", "price": "$0.99" },<br/>    { "sku_id": "credits_500", "price": "$3.99" }<br/>  ]<br/>}
        Worker-->>Client: 402 Payment Required
    else Thành công Đã trừ tiền
        Note right of Worker: 🤖 VERTEX AI REQUEST<br/>──────────────────────────<br/>POST https://{region}-aiplatform.googleapis.com<br/>/v1/projects/{project}/locations/{region}<br/>/publishers/google/models/gemini-pro:generateContent<br/>Headers:<br/>  Authorization: Bearer {gcp_token}<br/>  Content-Type: application/json<br/>Body:<br/>{<br/>  "contents": [{<br/>    "role": "user",<br/>    "parts": [<br/>      { "text": "Face swap prompt..." },<br/>      { "inlineData": {<br/>          "mimeType": "image/jpeg",<br/>          "data": "base64..."<br/>      }}<br/>    ]<br/>  }],<br/>  "generationConfig": {<br/>    "temperature": 0.4,<br/>    "maxOutputTokens": 8192<br/>  }<br/>}
        Worker->>AI: Gọi Vertex AI (Gemini Pro)

        alt AI Thất bại / Timeout
            Note right of Worker: 🔙 SAGA COMPENSATION<br/>──────────────────────────<br/>UPDATE users<br/>SET credits = credits + 10,<br/>    updated_at = 1234567890<br/>WHERE uid = 'user123'⁏<br/><br/>UPDATE logs<br/>SET status = 'REFUNDED',<br/>    error_msg = 'AI_TIMEOUT',<br/>    completed_at = 1234567890<br/>WHERE req_id = 'req_vn_999'⁏
            Worker->>D1: UPDATE users credits+10, logs status REFUNDED
            Note right of Worker: ❌ AI ERROR RESPONSE<br/>──────────────────────────<br/>HTTP 500 Internal Server Error<br/>{<br/>  "error": "GENERATE_AI_FAILED",<br/>  "message": "AI service unavailable",<br/>  "req_id": "req_vn_999",<br/>  "credits_refunded": 10,<br/>  "retry_after": 30<br/>}
            Worker-->>Client: 500 Server Error

            Note right of Worker: 📲 SYNC REFUND TO OTHER DEVICES<br/>──────────────────────────<br/>Push data message to other devices<br/>type: BALANCE_SYNC<br/>event: GENERATE_REFUNDED<br/>change: +10 (refunded)<br/>new_balance: 100
            Worker->>FCM: POST /messages:send (silent push)
        else AI Thành công
            Note right of Worker: ✅ SUCCESS UPDATE<br/>──────────────────────────<br/>-- Upload result to R2<br/>PUT https://r2.../results/req_vn_999.png<br/><br/>-- Update log<br/>UPDATE logs<br/>SET status = 'COMPLETED',<br/>    output_url = 'https://r2.../result.png',<br/>    completed_at = 1234567890<br/>WHERE req_id = 'req_vn_999'⁏
            Worker->>D1: UPDATE logs status COMPLETED
            Note right of Worker: ✅ SUCCESS RESPONSE<br/>──────────────────────────<br/>HTTP 200 OK<br/>{<br/>  "success": true,<br/>  "data": {<br/>    "req_id": "req_vn_999",<br/>    "output_url": "https://r2.../result.png",<br/>    "format": "png",<br/>    "credits_used": 10,<br/>    "remaining_credits": 90,<br/>    "processing_time_ms": 2500<br/>  }<br/>}
            Worker-->>Client: 200 OK + Nội dung AI

            Note right of Worker: 📲 SYNC BALANCE TO OTHER DEVICES<br/>──────────────────────────<br/>Push data message to other devices<br/>type: BALANCE_SYNC<br/>event: GENERATE_COMPLETED<br/>change: -10<br/>new_balance: 90
            Worker->>FCM: POST /messages:send (silent push)
        end
    end
end

%% ─── PHẦN MỚI: WEBHOOKS (BỔ SUNG VÀO) ───
rect rgb(255, 230, 230)
    Note over Play, D1: 🟣 PHẦN 3 (MỚI) XỬ LÝ REFUND TỰ ĐỘNG (RTDN)

    Note right of Play: 🔔 RTDN CONFIGURATION<br/>──────────────────────────<br/>Google Play Console:<br/>  Monetization → Monetization Setup<br/>  → Real-time Developer Notifications<br/>──────────────────────────<br/>Topic: projects/{project}/topics/play-billing<br/>Subscription: play-billing-sub
    Play->>GCP: Sự kiện User đòi lại tiền (Refund)

    Note right of GCP: ☁️ PUB/SUB CONFIGURATION<br/>──────────────────────────<br/>Push Subscription Settings:<br/>  Endpoint: https://api.site.com/webhooks/google<br/>  Acknowledgement deadline: 60s<br/>  Retry policy: Exponential backoff<br/>──────────────────────────<br/>IAM: Allow Pub/Sub to push
    Note right of GCP: 📦 PUB/SUB MESSAGE<br/>──────────────────────────<br/>{<br/>  "message": {<br/>    "data": "base64_encoded_json",<br/>    "messageId": "123456789",<br/>    "publishTime": "2024-01-01T00:00:00Z"<br/>  },<br/>  "subscription": "projects/.../subscriptions/..."<br/>}
    GCP->>Worker: POST /webhooks/google (Push)<br/>Body Base64 Encoded Data

    Note right of Worker: 🔐 WEBHOOK AUTH<br/>──────────────────────────<br/>1. Verify Pub/Sub JWT signature<br/>   Header: Authorization: Bearer {jwt}<br/>2. Validate audience claim<br/>3. Check message expiry<br/>──────────────────────────<br/>If invalid → 401 (Pub/Sub will retry)
    Worker->>Worker: Giải mã Base64 -> JSON
    Note right of Worker: 📥 DECODED NOTIFICATION<br/>──────────────────────────<br/>{<br/>  "version": "1.0",<br/>  "packageName": "com.app.faceswap",<br/>  "eventTimeMillis": "1234567890000",<br/>  "oneTimeProductNotification": {<br/>    "version": "1.0",<br/>    "notificationType": 2,<br/>    "purchaseToken": "token...",<br/>    "sku": "credits_100"<br/>  }<br/>}<br/>──────────────────────────<br/>notificationType:<br/>  1 = ONE_TIME_PRODUCT_PURCHASED<br/>  2 = ONE_TIME_PRODUCT_CANCELED<br/><br/>subscriptionNotification.notificationType:<br/>  1 = RECOVERED<br/>  2 = RENEWED<br/>  3 = CANCELED<br/>  4 = PURCHASED<br/>  5 = ON_HOLD<br/>  12 = REVOKED<br/>  13 = EXPIRED

    Worker->>D1: Tìm giao dịch theo Token
    Note right of Worker: 🔍 LOOKUP QUERY<br/>──────────────────────────<br/>SELECT p.*, u.credits<br/>FROM payments p<br/>JOIN users u ON p.uid = u.uid<br/>WHERE p.token = 'purchaseToken...'<br/>  AND p.status = 'COMPLETED'⁏
    alt Tìm thấy
        Note right of Worker: ⚠️ FRAUD HANDLING<br/>──────────────────────────<br/>BEGIN TRANSACTION⁏<br/><br/>-- Deduct credits (may go negative)<br/>UPDATE users<br/>SET credits = credits - 100,<br/>    updated_at = 1234567890<br/>WHERE uid = 'user123'⁏<br/><br/>-- Mark payment as refunded<br/>UPDATE payments<br/>SET status = 'REFUNDED',<br/>    updated_at = 1234567890<br/>WHERE order_id = 'GPA.1234-5678'⁏<br/><br/>-- Log the refund event<br/>INSERT INTO audit_log (<br/>  event_type, uid, details, created_at<br/>) VALUES (<br/>  'GOOGLE_REFUND', 'user123',<br/>  '{"order_id":"GPA.1234","amount":100}',<br/>  1234567890<br/>)⁏<br/><br/>COMMIT⁏
        Worker->>D1: UPDATE users SET credits = credits - amount<br/>UPDATE payments SET status REFUNDED

        Note right of Worker: 📲 NOTIFY ALL USER DEVICES<br/>──────────────────────────<br/>Push to ALL devices of this user<br/>type: BALANCE_SYNC<br/>event: GOOGLE_REFUND<br/>change: -100 (deducted)<br/>new_balance: (may be negative)<br/>──────────────────────────<br/>Show notification: "Hoàn tiền đã xử lý"
        Worker->>D1: SELECT fcm_token FROM device_tokens WHERE uid
        Worker->>FCM: POST /messages:send (to all devices)
    end
    Note right of Worker: ✅ ACK RESPONSE<br/>──────────────────────────<br/>HTTP 200 OK<br/>(Empty body - just acknowledge)<br/>──────────────────────────<br/>If non-200 → Pub/Sub retries<br/>with exponential backoff
    Worker-->>GCP: 200 OK (Xác nhận đã nhận tin)
end

%% ─── PHẦN MỚI: STORAGE & CRON (BỔ SUNG VÀO) ───
rect rgb(230, 230, 250)
    Note over Cron, R2: 🔵 PHẦN 4 (MỚI) TỐI ƯU DỮ LIỆU & SỬA LỖI

    Note right of Cron: ⏰ CRON CONFIGURATION<br/>──────────────────────────<br/>wrangler.toml:<br/>[triggers]<br/>crons = ["*/5 * * * *"]<br/>──────────────────────────<br/>Worker export:<br/>export default {<br/>  async scheduled(event, env, ctx) {<br/>    // Handle cron<br/>  }<br/>}
    Cron->>Worker: Trigger Cron Job

    Note right of Worker: 🔧 TASK 1: GHOST DEBIT FIX<br/>──────────────────────────<br/>-- Find stuck transactions<br/>SELECT req_id, uid, cost<br/>FROM logs<br/>WHERE status = 'PENDING'<br/>  AND created_at < (NOW - 300)⁏<br/>──────────────────────────<br/>-- Auto-refund each<br/>FOR EACH stuck_log:<br/>  BEGIN TRANSACTION⁏<br/>  UPDATE users SET credits = credits + cost<br/>  WHERE uid = stuck_log.uid⁏<br/>  UPDATE logs SET status = 'REFUNDED',<br/>    error_msg = 'AUTO_TIMEOUT_REFUND'<br/>  WHERE req_id = stuck_log.req_id⁏<br/>  COMMIT⁏
    Worker->>D1: Quét logs PENDING > 5 phút
    Worker->>D1: Tự động Hoàn tiền (+10 Credits)

    Note right of Worker: 📲 NOTIFY AFFECTED USERS<br/>──────────────────────────<br/>For each auto-refunded user:<br/>Push to ALL their devices<br/>type: BALANCE_SYNC<br/>event: AUTO_REFUND<br/>change: +10 (recovered)
    Worker->>FCM: Batch push to affected users

    Note right of Worker: 📦 TASK 2: ARCHIVE OLD DATA<br/>──────────────────────────<br/>-- Select old completed logs<br/>SELECT * FROM logs<br/>WHERE status IN ('COMPLETED', 'REFUNDED')<br/>  AND created_at < (NOW - 604800)<br/>LIMIT 1000⁏<br/>──────────────────────────<br/>-- Archive format (per day)<br/>R2 Path: archive/logs/2024/01/01.json<br/>{<br/>  "archived_at": "2024-01-08T00:00:00Z",<br/>  "count": 150,<br/>  "logs": [...]<br/>}
    Worker->>D1: Lấy logs cũ > 7 ngày
    Note right of R2: 🗄️ R2 STORAGE STRUCTURE<br/>──────────────────────────<br/>Bucket: faceswap-storage<br/>├── uploads/<br/>│   └── {uid}/{timestamp}_{filename}<br/>├── results/<br/>│   └── {req_id}.{format}<br/>├── archive/<br/>│   └── logs/{year}/{month}/{day}.json<br/>└── temp/<br/>    └── {uuid} (auto-delete 24h)
    Worker->>R2: Lưu file JSON sang R2 (Giá rẻ)
    Note right of Worker: 🧹 CLEANUP QUERY<br/>──────────────────────────<br/>DELETE FROM logs<br/>WHERE req_id IN (<br/>  SELECT req_id FROM archived_batch<br/>)⁏
    Worker->>D1: Xóa logs cũ để D1 không bị đầy
end

%% ─── PHẦN 5: API ENDPOINTS SUMMARY ───
rect rgb(240, 255, 240)
    Note over Client, Worker: 📋 PHẦN 5 API ENDPOINTS REFERENCE

    Note right of Worker: 🌐 PUBLIC ENDPOINTS<br/>──────────────────────────<br/>Base URL: https://api.faceswap.com<br/>──────────────────────────<br/>POST /api/auth/register<br/>POST /api/auth/login<br/>POST /api/auth/refresh<br/>──────────────────────────<br/>GET  /api/user/profile<br/>GET  /api/user/balance<br/>GET  /api/user/history<br/>──────────────────────────<br/>POST /api/deposit<br/>GET  /api/deposit/status/{order_id}<br/>GET  /api/products (SKU list)<br/>──────────────────────────<br/>POST /api/generate<br/>GET  /api/generate/status/{req_id}<br/>GET  /api/generate/result/{req_id}<br/>──────────────────────────<br/>POST /api/upload (get presigned URL)<br/>──────────────────────────<br/>📱 DEVICE MANAGEMENT ENDPOINTS<br/>POST /api/device/register<br/>PUT  /api/device/update-token<br/>DELETE /api/device/{device_id}<br/>GET  /api/device/list<br/>──────────────────────────<br/>🔒 WEBHOOK ENDPOINTS<br/>POST /webhooks/google

    Note right of Worker: 📊 RATE LIMITS<br/>──────────────────────────<br/>/api/auth/*: 5 req/min<br/>/api/user/*: 30 req/min<br/>/api/deposit: 10 req/min<br/>/api/generate: 10 req/min<br/>/api/upload: 20 req/min<br/>/api/device/*: 10 req/min<br/>──────────────────────────<br/>Headers returned:<br/>X-RateLimit-Limit: 10<br/>X-RateLimit-Remaining: 8<br/>X-RateLimit-Reset: 1234567890
end

%% ─── PHẦN 6: PUSH NOTIFICATIONS & DEVICE MANAGEMENT ───
rect rgb(255, 245, 230)
    Note over Client, FCM: 📲 PHẦN 6 (MỚI) MULTI-DEVICE SYNC VIA FCM

    Note right of Client: 📱 DEVICE REGISTRATION FLOW<br/>──────────────────────────<br/>When app starts or token refreshes:<br/>1. Get FCM token from FirebaseMessaging<br/>2. Generate unique device_id (or use existing)<br/>3. Call /api/device/register

    Note right of Client: 📤 REGISTER DEVICE REQUEST<br/>──────────────────────────<br/>POST /api/device/register<br/>Headers:<br/>  Authorization: Bearer {firebase_jwt}<br/>Body:<br/>{<br/>  "device_id": "uuid-device-123",<br/>  "fcm_token": "fcm_token_from_firebase",<br/>  "device_name": "Samsung Galaxy S24",<br/>  "device_model": "SM-S928B",<br/>  "os_version": "Android 14",<br/>  "app_version": "1.2.0"<br/>}
    Client->>Worker: POST /api/device/register

    Note right of Worker: 💾 UPSERT DEVICE TOKEN<br/>──────────────────────────<br/>INSERT INTO device_tokens (<br/>  uid, device_id, fcm_token,<br/>  device_name, device_model,<br/>  os_version, app_version,<br/>  is_active, last_seen_at,<br/>  created_at, updated_at<br/>) VALUES (...)<br/>ON CONFLICT(device_id) DO UPDATE<br/>SET fcm_token = excluded.fcm_token,<br/>    last_seen_at = NOW(),<br/>    updated_at = NOW()⁏
    Worker->>D1: Upsert device token
    D1-->>Worker: OK

    Note right of Worker: ✅ REGISTER RESPONSE<br/>──────────────────────────<br/>HTTP 200 OK<br/>{<br/>  "success": true,<br/>  "data": {<br/>    "device_id": "uuid-device-123",<br/>    "registered": true,<br/>    "active_devices": 3<br/>  }<br/>}
    Worker-->>Client: 200 OK

    Note over Worker, FCM: 🔔 BALANCE CHANGE PUSH FLOW

    Note right of Worker: 📲 WHEN BALANCE CHANGES<br/>──────────────────────────<br/>Triggers:<br/>1. Deposit completed (+credits)<br/>2. AI generation (-credits)<br/>3. AI failure refund (+credits)<br/>4. Google refund (-credits)<br/>5. Cron auto-refund (+credits)<br/>──────────────────────────<br/>Get all OTHER devices for this user<br/>(exclude current device if known)

    Worker->>D1: SELECT fcm_token FROM device_tokens<br/>WHERE uid = ? AND device_id != ? AND is_active = 1
    D1-->>Worker: [token1, token2, token3]

    Note right of Worker: 🔔 FCM HTTP v1 API<br/>──────────────────────────<br/>Endpoint:<br/>POST https://fcm.googleapis.com<br/>/v1/projects/{project_id}/messages:send<br/>──────────────────────────<br/>Auth: OAuth2 Bearer token<br/>Scope: https://www.googleapis.com<br/>/auth/firebase.messaging

    Note right of Worker: 📦 FCM MESSAGE PAYLOAD<br/>──────────────────────────<br/>{<br/>  "message": {<br/>    "token": "device_fcm_token",<br/>    "data": {<br/>      "type": "BALANCE_SYNC",<br/>      "new_balance": "150",<br/>      "change": "+100",<br/>      "event": "DEPOSIT",<br/>      "event_id": "GPA.1234",<br/>      "timestamp": "1704067200"<br/>    },<br/>    "android": {<br/>      "priority": "high",<br/>      "ttl": "86400s",<br/>      "direct_boot_ok": true<br/>    }<br/>  }<br/>}<br/>──────────────────────────<br/>Note: Using "data" only (not "notification")<br/>for silent background sync

    Worker->>FCM: POST /messages:send (Promise.all)
    FCM-->>Worker: { "name": "projects/.../messages/..." }

    Note right of FCM: 📱 FCM DELIVERY<br/>──────────────────────────<br/>FCM delivers to each device:<br/>──────────────────────────<br/>Device A: (initiated action)<br/>  → Already updated via API response<br/>Device B: (tablet, background)<br/>  → Receives data message<br/>  → FirebaseMessagingService.onMessageReceived()<br/>  → Update local cache<br/>  → Refresh UI if visible<br/>Device C: (old phone, offline)<br/>  → Message queued in FCM<br/>  → Delivered when online (up to 28 days)
    FCM->>Client: Data message (silent push)

    Note right of Client: 📱 CLIENT HANDLING<br/>──────────────────────────<br/>In FirebaseMessagingService:<br/>──────────────────────────<br/>override fun onMessageReceived(msg) {<br/>  val data = msg.data<br/>  if (data["type"] == "BALANCE_SYNC") {<br/>    val newBalance = data["new_balance"]<br/>    // Update local cache<br/>    BalanceCache.update(newBalance)<br/>    // Notify UI observers<br/>    EventBus.post(BalanceChangedEvent(...))<br/>    // Optional: Show local notification<br/>    if (data["event"] == "DEPOSIT") {<br/>      showNotification("Credits added!")<br/>    }<br/>  }<br/>}

    Note over Client, Worker: 📱 TOKEN REFRESH HANDLING

    Note right of Client: 🔄 FCM TOKEN REFRESH<br/>──────────────────────────<br/>When FCM token changes:<br/>FirebaseMessaging.getInstance()<br/>  .token.addOnSuccessListener { newToken -><br/>    // Update server with new token<br/>    api.updateDeviceToken(deviceId, newToken)<br/>  }
    Client->>Worker: PUT /api/device/update-token<br/>{ device_id, new_fcm_token }
    Worker->>D1: UPDATE device_tokens SET fcm_token = ?
    Worker-->>Client: 200 OK

    Note over Worker, FCM: 🧹 CLEANUP STALE TOKENS

    Note right of Worker: 🧹 HANDLE FCM ERRORS<br/>──────────────────────────<br/>When FCM returns error:<br/>• NOT_REGISTERED<br/>• INVALID_REGISTRATION<br/>• UNREGISTERED<br/>──────────────────────────<br/>Mark device as inactive:<br/>UPDATE device_tokens<br/>SET is_active = 0<br/>WHERE fcm_token = ?
end
```

---

## Database Schema

### Bảng `users` - Quản lý người dùng

```sql
CREATE TABLE users (
    uid TEXT PRIMARY KEY,              -- Firebase UID
    email TEXT UNIQUE NOT NULL,        -- Email đăng ký
    display_name TEXT,                 -- Tên hiển thị
    avatar_url TEXT,                   -- URL ảnh đại diện
    credits INTEGER DEFAULT 0,         -- Số credit hiện tại
    total_credits_purchased INTEGER DEFAULT 0,  -- Tổng credit đã mua
    total_credits_spent INTEGER DEFAULT 0,      -- Tổng credit đã dùng
    tier TEXT DEFAULT 'free',          -- Gói: free/pro/premium
    tier_expires_at INTEGER,           -- Thời hạn gói (Unix timestamp)
    is_banned INTEGER DEFAULT 0,       -- Trạng thái cấm
    ban_reason TEXT,                   -- Lý do cấm
    device_ids TEXT,                   -- JSON array device IDs
    fcm_token TEXT,                    -- Firebase Cloud Messaging token
    last_active_at INTEGER,            -- Lần hoạt động cuối
    created_at INTEGER NOT NULL,       -- Thời điểm tạo
    updated_at INTEGER NOT NULL        -- Thời điểm cập nhật
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_tier ON users(tier);
CREATE INDEX idx_users_created_at ON users(created_at);
```

### Bảng `payments` - Lịch sử giao dịch nạp tiền

```sql
CREATE TABLE payments (
    order_id TEXT PRIMARY KEY,         -- Google Play Order ID
    uid TEXT NOT NULL,                 -- FK → users.uid
    token TEXT UNIQUE NOT NULL,        -- Google Purchase Token
    sku_id TEXT NOT NULL,              -- Product SKU (credits_100, etc.)
    product_type TEXT NOT NULL,        -- 'consumable' | 'subscription'
    amount INTEGER NOT NULL,           -- Số credit được cộng
    price_micros INTEGER NOT NULL,     -- Giá (micros) từ Google
    currency TEXT NOT NULL,            -- Mã tiền tệ (USD, VND)
    region_code TEXT,                  -- Mã quốc gia (VN, US)
    status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING/COMPLETED/REFUNDED/FAILED
    acknowledged INTEGER DEFAULT 0,    -- Đã acknowledge với Google chưa
    google_response TEXT,              -- JSON response từ Google API
    error_message TEXT,                -- Lỗi nếu có
    refund_reason TEXT,                -- Lý do refund nếu có
    refunded_at INTEGER,               -- Thời điểm refund
    created_at INTEGER NOT NULL,       -- Thời điểm tạo
    updated_at INTEGER NOT NULL,       -- Thời điểm cập nhật

    FOREIGN KEY (uid) REFERENCES users(uid)
);

CREATE INDEX idx_payments_uid ON payments(uid);
CREATE INDEX idx_payments_token ON payments(token);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_created_at ON payments(created_at);
```

### Bảng `logs` - Lịch sử sử dụng AI

```sql
CREATE TABLE logs (
    req_id TEXT PRIMARY KEY,           -- UUID từ client (idempotency key)
    uid TEXT NOT NULL,                 -- FK → users.uid
    action TEXT NOT NULL,              -- Loại action: face_swap, enhance, etc.
    cost INTEGER NOT NULL,             -- Số credit đã trừ
    status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING/PROCESSING/COMPLETED/FAILED/REFUNDED

    -- Input details
    ai_model TEXT NOT NULL,            -- Model AI sử dụng
    input_hash TEXT,                   -- SHA256 hash của input (dedup)
    input_params TEXT,                 -- JSON params gửi đi
    source_url TEXT,                   -- URL ảnh source
    target_url TEXT,                   -- URL ảnh target

    -- Output details
    output_url TEXT,                   -- URL kết quả
    output_format TEXT,                -- Format output: png, jpg, webp
    output_size_bytes INTEGER,         -- Kích thước file output

    -- Processing metrics
    queue_time_ms INTEGER,             -- Thời gian chờ queue
    processing_time_ms INTEGER,        -- Thời gian xử lý AI
    total_time_ms INTEGER,             -- Tổng thời gian

    -- Error handling
    error_code TEXT,                   -- Mã lỗi nếu có
    error_message TEXT,                -- Chi tiết lỗi
    retry_count INTEGER DEFAULT 0,     -- Số lần retry

    -- Timestamps
    created_at INTEGER NOT NULL,       -- Thời điểm nhận request
    started_at INTEGER,                -- Thời điểm bắt đầu xử lý
    completed_at INTEGER,              -- Thời điểm hoàn thành

    FOREIGN KEY (uid) REFERENCES users(uid)
);

CREATE INDEX idx_logs_uid ON logs(uid);
CREATE INDEX idx_logs_status ON logs(status);
CREATE INDEX idx_logs_action ON logs(action);
CREATE INDEX idx_logs_created_at ON logs(created_at);
CREATE INDEX idx_logs_input_hash ON logs(input_hash);
```

### Bảng `products` - Danh sách sản phẩm IAP

```sql
CREATE TABLE products (
    sku_id TEXT PRIMARY KEY,           -- Google Play SKU ID
    name TEXT NOT NULL,                -- Tên sản phẩm
    description TEXT,                  -- Mô tả
    product_type TEXT NOT NULL,        -- 'consumable' | 'subscription'
    credits INTEGER NOT NULL,          -- Số credit được cộng
    price_usd_cents INTEGER NOT NULL,  -- Giá USD (cents)
    bonus_credits INTEGER DEFAULT 0,   -- Credit bonus
    is_active INTEGER DEFAULT 1,       -- Còn bán không
    sort_order INTEGER DEFAULT 0,      -- Thứ tự hiển thị
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

### Bảng `device_tokens` - Quản lý thiết bị (Multi-device Push)

```sql
CREATE TABLE device_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,                 -- FK → users.uid
    device_id TEXT UNIQUE NOT NULL,    -- UUID thiết bị (persist trên device)
    fcm_token TEXT NOT NULL,           -- Firebase Cloud Messaging token
    device_name TEXT,                  -- Tên thiết bị (Samsung Galaxy S24)
    device_model TEXT,                 -- Model (SM-S928B)
    os_version TEXT,                   -- Phiên bản OS (Android 14)
    app_version TEXT,                  -- Phiên bản app (1.2.0)
    is_active INTEGER DEFAULT 1,       -- Còn hoạt động không (0 nếu FCM error)
    last_seen_at INTEGER,              -- Lần cuối app mở
    created_at INTEGER NOT NULL,       -- Thời điểm đăng ký
    updated_at INTEGER NOT NULL,       -- Thời điểm cập nhật

    FOREIGN KEY (uid) REFERENCES users(uid)
);

CREATE INDEX idx_device_uid ON device_tokens(uid);
CREATE INDEX idx_device_fcm ON device_tokens(fcm_token);
CREATE INDEX idx_device_active ON device_tokens(uid, is_active);
```

### Bảng `push_log` - Lịch sử push notification

```sql
CREATE TABLE push_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,                 -- FK → users.uid
    event_type TEXT NOT NULL,          -- BALANCE_SYNC, DEPOSIT, GENERATE, REFUND
    event_id TEXT,                     -- Related order_id or req_id
    devices_count INTEGER NOT NULL,    -- Số thiết bị được gửi
    success_count INTEGER DEFAULT 0,   -- Số thiết bị thành công
    failed_count INTEGER DEFAULT 0,    -- Số thiết bị thất bại
    payload TEXT,                      -- JSON payload đã gửi
    created_at INTEGER NOT NULL,

    FOREIGN KEY (uid) REFERENCES users(uid)
);

CREATE INDEX idx_push_uid ON push_log(uid);
CREATE INDEX idx_push_created ON push_log(created_at);
```

### Bảng `audit_log` - Nhật ký hệ thống

```sql
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,          -- GOOGLE_REFUND, ADMIN_BAN, CRON_CLEANUP, etc.
    uid TEXT,                          -- User liên quan (nullable)
    admin_uid TEXT,                    -- Admin thực hiện (nullable)
    ip_address TEXT,                   -- IP address
    user_agent TEXT,                   -- User agent
    details TEXT,                      -- JSON chi tiết
    created_at INTEGER NOT NULL,

    FOREIGN KEY (uid) REFERENCES users(uid)
);

CREATE INDEX idx_audit_event_type ON audit_log(event_type);
CREATE INDEX idx_audit_uid ON audit_log(uid);
CREATE INDEX idx_audit_created_at ON audit_log(created_at);
```

---

## API Specifications

### Authentication Endpoints

#### `POST /api/auth/register`
Đăng ký tài khoản mới (sau khi đã auth Firebase)

**Request:**
```http
POST /api/auth/register
Content-Type: application/json
Authorization: Bearer {firebase_id_token}

{
    "display_name": "Nguyen Van A",
    "device_id": "uuid-device-123",
    "fcm_token": "fcm_token_string"
}
```

**Response Success (201):**
```json
{
    "success": true,
    "data": {
        "uid": "firebase_uid_123",
        "email": "user@example.com",
        "display_name": "Nguyen Van A",
        "credits": 10,
        "tier": "free",
        "created_at": 1704067200
    }
}
```

**Response Error (409 - Already exists):**
```json
{
    "success": false,
    "error": {
        "code": "AUTH_USER_EXISTS",
        "message": "User already registered"
    }
}
```

---

#### `GET /api/user/profile`
Lấy thông tin profile

**Request:**
```http
GET /api/user/profile
Authorization: Bearer {firebase_id_token}
```

**Response (200):**
```json
{
    "success": true,
    "data": {
        "uid": "firebase_uid_123",
        "email": "user@example.com",
        "display_name": "Nguyen Van A",
        "avatar_url": "https://r2.../avatar.jpg",
        "credits": 150,
        "tier": "pro",
        "tier_expires_at": 1735689600,
        "total_credits_purchased": 500,
        "total_credits_spent": 350,
        "created_at": 1704067200
    }
}
```

---

#### `GET /api/user/balance`
Lấy số dư credit (lightweight)

**Request:**
```http
GET /api/user/balance
Authorization: Bearer {firebase_id_token}
```

**Response (200):**
```json
{
    "success": true,
    "data": {
        "credits": 150,
        "tier": "pro"
    }
}
```

---

### Payment Endpoints

#### `POST /api/deposit`
Nạp credit từ Google Play purchase

**Request:**
```http
POST /api/deposit
Content-Type: application/json
Authorization: Bearer {firebase_id_token}
X-Device-ID: uuid-device-123
X-App-Version: 1.2.0

{
    "token": "google_purchase_token_string",
    "sku_id": "credits_100",
    "order_id": "GPA.1234-5678-9012-34567"
}
```

**Response Success (200):**
```json
{
    "success": true,
    "data": {
        "order_id": "GPA.1234-5678-9012-34567",
        "sku_id": "credits_100",
        "credits_added": 100,
        "bonus_credits": 10,
        "new_balance": 260,
        "acknowledged": true
    }
}
```

**Response Errors:**

*400 - Invalid Purchase:*
```json
{
    "success": false,
    "error": {
        "code": "DEPOSIT_INVALID_PURCHASE",
        "message": "Purchase is invalid or already consumed",
        "details": {
            "purchase_state": 1,
            "consumption_state": 1
        }
    }
}
```

*409 - Duplicate:*
```json
{
    "success": false,
    "error": {
        "code": "DEPOSIT_DUPLICATE",
        "message": "This purchase has already been processed",
        "order_id": "GPA.1234-5678-9012-34567"
    }
}
```

---

#### `GET /api/products`
Danh sách sản phẩm IAP

**Request:**
```http
GET /api/products
Authorization: Bearer {firebase_id_token}
```

**Response (200):**
```json
{
    "success": true,
    "data": {
        "products": [
            {
                "sku_id": "credits_100",
                "name": "100 Credits",
                "description": "Get 100 credits for AI generation",
                "credits": 100,
                "bonus_credits": 0,
                "price_usd_cents": 99
            },
            {
                "sku_id": "credits_500",
                "name": "500 Credits",
                "description": "Get 500 credits + 50 bonus",
                "credits": 500,
                "bonus_credits": 50,
                "price_usd_cents": 399
            },
            {
                "sku_id": "credits_1000",
                "name": "1000 Credits",
                "description": "Get 1000 credits + 150 bonus",
                "credits": 1000,
                "bonus_credits": 150,
                "price_usd_cents": 699
            }
        ]
    }
}
```

---

### Generation Endpoints

#### `POST /api/generate`
Tạo AI generation (face swap, enhance, etc.)

**Request:**
```http
POST /api/generate
Content-Type: application/json
Authorization: Bearer {firebase_id_token}
X-Request-ID: req_550e8400-e29b-41d4-a716-446655440000
X-Idempotency-Key: req_550e8400-e29b-41d4-a716-446655440000

{
    "action": "face_swap",
    "source_image": "https://r2.../uploads/user123/source.jpg",
    "target_image": "https://r2.../uploads/user123/target.jpg",
    "options": {
        "quality": "high",
        "output_format": "png",
        "enhance_face": true
    }
}
```

**Response Success (200):**
```json
{
    "success": true,
    "data": {
        "req_id": "req_550e8400-e29b-41d4-a716-446655440000",
        "status": "COMPLETED",
        "output_url": "https://r2.../results/req_550e8400.png",
        "output_format": "png",
        "credits_used": 10,
        "remaining_credits": 140,
        "processing_time_ms": 2847
    }
}
```

**Response Errors:**

*402 - Insufficient Credits:*
```json
{
    "success": false,
    "error": {
        "code": "GENERATE_INSUFFICIENT_CREDITS",
        "message": "Not enough credits for this operation",
        "details": {
            "required": 10,
            "available": 5,
            "action": "face_swap"
        }
    },
    "purchase_options": [
        {"sku_id": "credits_100", "credits": 100, "price": "$0.99"}
    ]
}
```

*429 - Rate Limited:*
```json
{
    "success": false,
    "error": {
        "code": "RATE_LIMIT_EXCEEDED",
        "message": "Too many requests",
        "details": {
            "limit": 10,
            "window": "1 minute",
            "retry_after": 45
        }
    }
}
```

*500 - AI Failed (with refund):*
```json
{
    "success": false,
    "error": {
        "code": "GENERATE_AI_FAILED",
        "message": "AI service temporarily unavailable",
        "details": {
            "req_id": "req_550e8400-e29b-41d4-a716-446655440000",
            "credits_refunded": 10,
            "retry_after": 30
        }
    }
}
```

---

#### `GET /api/generate/status/{req_id}`
Kiểm tra trạng thái generation

**Request:**
```http
GET /api/generate/status/req_550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer {firebase_id_token}
```

**Response (200):**
```json
{
    "success": true,
    "data": {
        "req_id": "req_550e8400-e29b-41d4-a716-446655440000",
        "status": "PROCESSING",
        "progress": 65,
        "estimated_time_remaining_ms": 1200,
        "created_at": 1704067200,
        "started_at": 1704067201
    }
}
```

---

#### `GET /api/user/history`
Lịch sử generation

**Request:**
```http
GET /api/user/history?page=1&limit=20&status=COMPLETED
Authorization: Bearer {firebase_id_token}
```

**Response (200):**
```json
{
    "success": true,
    "data": {
        "items": [
            {
                "req_id": "req_550e8400",
                "action": "face_swap",
                "status": "COMPLETED",
                "cost": 10,
                "output_url": "https://r2.../results/req_550e8400.png",
                "processing_time_ms": 2847,
                "created_at": 1704067200
            }
        ],
        "pagination": {
            "page": 1,
            "limit": 20,
            "total": 45,
            "total_pages": 3
        }
    }
}
```

---

### Upload Endpoints

#### `POST /api/upload`
Lấy presigned URL để upload ảnh

**Request:**
```http
POST /api/upload
Content-Type: application/json
Authorization: Bearer {firebase_id_token}

{
    "filename": "source.jpg",
    "content_type": "image/jpeg",
    "size_bytes": 1048576
}
```

**Response (200):**
```json
{
    "success": true,
    "data": {
        "upload_url": "https://r2.../uploads/user123/1704067200_source.jpg?X-Amz-...",
        "file_url": "https://r2.../uploads/user123/1704067200_source.jpg",
        "expires_in": 3600,
        "max_size_bytes": 10485760
    }
}
```

---

### Device Management Endpoints (Multi-device Push Sync)

#### `POST /api/device/register`
Đăng ký thiết bị để nhận push notifications

**Request:**
```http
POST /api/device/register
Content-Type: application/json
Authorization: Bearer {firebase_id_token}

{
    "device_id": "uuid-device-123",
    "fcm_token": "fcm_token_from_firebase_messaging",
    "device_name": "Samsung Galaxy S24",
    "device_model": "SM-S928B",
    "os_version": "Android 14",
    "app_version": "1.2.0"
}
```

**Response Success (200):**
```json
{
    "success": true,
    "data": {
        "device_id": "uuid-device-123",
        "registered": true,
        "active_devices": 3,
        "devices": [
            {
                "device_id": "uuid-device-123",
                "device_name": "Samsung Galaxy S24",
                "is_current": true,
                "last_seen_at": 1704067200
            },
            {
                "device_id": "uuid-device-456",
                "device_name": "Samsung Galaxy Tab S9",
                "is_current": false,
                "last_seen_at": 1704060000
            }
        ]
    }
}
```

---

#### `PUT /api/device/update-token`
Cập nhật FCM token khi token thay đổi

**Request:**
```http
PUT /api/device/update-token
Content-Type: application/json
Authorization: Bearer {firebase_id_token}

{
    "device_id": "uuid-device-123",
    "new_fcm_token": "new_fcm_token_after_refresh"
}
```

**Response (200):**
```json
{
    "success": true,
    "data": {
        "device_id": "uuid-device-123",
        "token_updated": true
    }
}
```

---

#### `GET /api/device/list`
Lấy danh sách tất cả thiết bị của user

**Request:**
```http
GET /api/device/list
Authorization: Bearer {firebase_id_token}
```

**Response (200):**
```json
{
    "success": true,
    "data": {
        "devices": [
            {
                "device_id": "uuid-device-123",
                "device_name": "Samsung Galaxy S24",
                "device_model": "SM-S928B",
                "os_version": "Android 14",
                "app_version": "1.2.0",
                "is_active": true,
                "last_seen_at": 1704067200,
                "created_at": 1703980800
            },
            {
                "device_id": "uuid-device-456",
                "device_name": "Samsung Galaxy Tab S9",
                "device_model": "SM-X910",
                "os_version": "Android 14",
                "app_version": "1.1.0",
                "is_active": true,
                "last_seen_at": 1704060000,
                "created_at": 1703894400
            }
        ],
        "total": 2
    }
}
```

---

#### `DELETE /api/device/{device_id}`
Xóa thiết bị (logout từ thiết bị đó)

**Request:**
```http
DELETE /api/device/uuid-device-456
Authorization: Bearer {firebase_id_token}
```

**Response (200):**
```json
{
    "success": true,
    "data": {
        "device_id": "uuid-device-456",
        "deleted": true,
        "remaining_devices": 1
    }
}
```

---

### Push Notification Payload Formats

#### Balance Sync (Silent Data Message)
```json
{
    "message": {
        "token": "device_fcm_token",
        "data": {
            "type": "BALANCE_SYNC",
            "new_balance": "150",
            "change": "+100",
            "event": "DEPOSIT",
            "event_id": "GPA.1234-5678",
            "timestamp": "1704067200",
            "message": "100 credits added to your account"
        },
        "android": {
            "priority": "high",
            "ttl": "86400s",
            "direct_boot_ok": true
        }
    }
}
```

#### Event Types

| Event | Change | Description |
|-------|--------|-------------|
| `DEPOSIT` | + | Credits purchased successfully |
| `GENERATE_COMPLETED` | - | AI generation completed |
| `GENERATE_REFUNDED` | + | AI failed, credits refunded |
| `GOOGLE_REFUND` | - | Google Play refund processed |
| `AUTO_REFUND` | + | System auto-refund (timeout) |
| `ADMIN_ADJUSTMENT` | ± | Manual admin adjustment |

---

### Webhook Endpoints

#### `POST /webhooks/google`
Nhận Google Play RTDN notifications

**Request (from Google Pub/Sub):**
```http
POST /webhooks/google
Content-Type: application/json
Authorization: Bearer {pubsub_jwt_token}

{
    "message": {
        "data": "eyJ2ZXJzaW9uIjoiMS4wIiwicGFja2FnZU5hbWUiOi4uLn0=",
        "messageId": "1234567890",
        "publishTime": "2024-01-01T12:00:00.000Z"
    },
    "subscription": "projects/my-project/subscriptions/play-billing-sub"
}
```

**Decoded data:**
```json
{
    "version": "1.0",
    "packageName": "com.app.faceswap",
    "eventTimeMillis": "1704110400000",
    "oneTimeProductNotification": {
        "version": "1.0",
        "notificationType": 2,
        "purchaseToken": "token...",
        "sku": "credits_100"
    }
}
```

**Response (200):**
Empty body - just acknowledge receipt

---

## Authentication

### Firebase JWT Verification

Mọi request đều phải có header:
```
Authorization: Bearer {firebase_id_token}
```

**Worker verification flow:**

```javascript
async function verifyFirebaseToken(token, env) {
    // 1. Decode header to get kid
    const [headerB64] = token.split('.');
    const header = JSON.parse(atob(headerB64));
    const kid = header.kid;

    // 2. Get Google public keys (cached in KV)
    let keys = await env.KV.get('firebase_public_keys', 'json');
    if (!keys) {
        const resp = await fetch(
            'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
        );
        keys = await resp.json();
        await env.KV.put('firebase_public_keys', JSON.stringify(keys), {
            expirationTtl: 3600
        });
    }

    // 3. Verify signature with matching key
    const publicKey = keys[kid];
    const isValid = await verifyJWT(token, publicKey);

    // 4. Verify claims
    const payload = JSON.parse(atob(token.split('.')[1]));
    const now = Math.floor(Date.now() / 1000);

    if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) {
        throw new Error('Invalid issuer');
    }
    if (payload.aud !== env.FIREBASE_PROJECT_ID) {
        throw new Error('Invalid audience');
    }
    if (payload.exp < now) {
        throw new Error('Token expired');
    }

    return payload; // Contains uid, email, etc.
}
```

### Google Service Account JWT

Để gọi Google Play API:

```javascript
async function getGoogleAccessToken(env) {
    // Check cache first
    const cached = await env.KV.get('google_access_token', 'json');
    if (cached && cached.expires > Date.now()) {
        return cached.token;
    }

    // Create service account JWT
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJWT({
        header: { alg: 'RS256', typ: 'JWT' },
        payload: {
            iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            scope: 'https://www.googleapis.com/auth/androidpublisher',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600
        },
        privateKey: env.GOOGLE_PRIVATE_KEY
    });

    // Exchange for access token
    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        })
    });

    const data = await resp.json();

    // Cache for 55 minutes
    await env.KV.put('google_access_token', JSON.stringify({
        token: data.access_token,
        expires: Date.now() + 55 * 60 * 1000
    }));

    return data.access_token;
}
```

### Firebase Cloud Messaging (FCM) Authentication

Để gửi push notifications qua FCM HTTP v1 API:

```javascript
async function getFCMAccessToken(env) {
    // FCM uses same OAuth2 as other Google APIs
    // but with different scope

    // Check cache first
    const cached = await env.KV.get('fcm_access_token', 'json');
    if (cached && cached.expires > Date.now()) {
        return cached.token;
    }

    // Create service account JWT with FCM scope
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJWT({
        header: { alg: 'RS256', typ: 'JWT' },
        payload: {
            iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            scope: 'https://www.googleapis.com/auth/firebase.messaging',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600
        },
        privateKey: env.GOOGLE_PRIVATE_KEY
    });

    // Exchange for access token
    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        })
    });

    const data = await resp.json();

    // Cache for 55 minutes
    await env.KV.put('fcm_access_token', JSON.stringify({
        token: data.access_token,
        expires: Date.now() + 55 * 60 * 1000
    }));

    return data.access_token;
}

// Send push notification to device
async function sendFCMPush(env, fcmToken, payload) {
    const accessToken = await getFCMAccessToken(env);

    const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: {
                    token: fcmToken,
                    data: payload,
                    android: {
                        priority: 'high',
                        ttl: '86400s',
                        direct_boot_ok: true
                    }
                }
            })
        }
    );

    if (!response.ok) {
        const error = await response.json();
        // Handle invalid tokens
        if (error.error?.details?.[0]?.errorCode === 'UNREGISTERED') {
            // Mark device as inactive
            await markDeviceInactive(env, fcmToken);
        }
        throw new Error(`FCM error: ${error.error?.message}`);
    }

    return await response.json();
}

// Send to multiple devices in parallel
async function broadcastBalanceChange(env, uid, excludeDeviceId, payload) {
    // Get all active devices except the one that triggered the change
    const devices = await env.D1.prepare(`
        SELECT fcm_token, device_id
        FROM device_tokens
        WHERE uid = ? AND device_id != ? AND is_active = 1
    `).bind(uid, excludeDeviceId || '').all();

    if (!devices.results || devices.results.length === 0) {
        return { sent: 0, failed: 0 };
    }

    // Send to all devices in parallel
    const results = await Promise.allSettled(
        devices.results.map(device =>
            sendFCMPush(env, device.fcm_token, payload)
        )
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    // Log push attempt
    await env.D1.prepare(`
        INSERT INTO push_log (uid, event_type, event_id, devices_count, success_count, failed_count, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        uid,
        payload.event,
        payload.event_id,
        devices.results.length,
        sent,
        failed,
        JSON.stringify(payload),
        Date.now()
    ).run();

    return { sent, failed };
}
```

---

## Error Codes

### HTTP Status Codes

| Code | Meaning | Usage |
|------|---------|-------|
| 200 | OK | Thành công |
| 201 | Created | Tạo mới thành công |
| 400 | Bad Request | Request không hợp lệ |
| 401 | Unauthorized | Token không hợp lệ/hết hạn |
| 402 | Payment Required | Không đủ credit |
| 403 | Forbidden | Không có quyền |
| 404 | Not Found | Resource không tồn tại |
| 409 | Conflict | Duplicate/đã xử lý |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Server Error | Lỗi server/AI |

### Application Error Codes

| Code | Description |
|------|-------------|
| `AUTH_INVALID_TOKEN` | Firebase token không hợp lệ |
| `AUTH_TOKEN_EXPIRED` | Token đã hết hạn |
| `AUTH_USER_NOT_FOUND` | User chưa đăng ký |
| `AUTH_USER_BANNED` | User bị cấm |
| `AUTH_USER_EXISTS` | User đã tồn tại |
| `DEPOSIT_INVALID_PURCHASE` | Purchase không hợp lệ |
| `DEPOSIT_ALREADY_CONSUMED` | Purchase đã được sử dụng |
| `DEPOSIT_DUPLICATE` | Order đã được xử lý |
| `DEPOSIT_VERIFICATION_FAILED` | Không verify được với Google |
| `GENERATE_INSUFFICIENT_CREDITS` | Không đủ credit |
| `GENERATE_INVALID_INPUT` | Input không hợp lệ |
| `GENERATE_AI_FAILED` | AI service lỗi |
| `GENERATE_AI_TIMEOUT` | AI timeout |
| `GENERATE_DUPLICATE_REQUEST` | Request ID đã tồn tại |
| `UPLOAD_FILE_TOO_LARGE` | File quá lớn |
| `UPLOAD_INVALID_TYPE` | Loại file không hỗ trợ |
| `RATE_LIMIT_EXCEEDED` | Vượt quá rate limit |
| `DEVICE_NOT_FOUND` | Device ID không tồn tại |
| `DEVICE_INVALID_TOKEN` | FCM token không hợp lệ |
| `DEVICE_ALREADY_REGISTERED` | Device đã được đăng ký |
| `PUSH_SEND_FAILED` | Không thể gửi push notification |
| `INTERNAL_ERROR` | Lỗi hệ thống |

---

## KV Cache Keys

| Key Pattern | Value | TTL |
|-------------|-------|-----|
| `firebase_public_keys` | Google public keys JSON | 1 hour |
| `google_access_token` | `{token, expires}` | 55 min |
| `fcm_access_token` | `{token, expires}` | 55 min |
| `rate:{uid}:{minute}` | Request count | 1 min |
| `user:{uid}:balance` | Credit balance | 30 sec |
| `user:{uid}:devices` | Device list cache | 5 min |
| `product:list` | Products JSON | 5 min |

---

## R2 Storage Structure

```
faceswap-storage/
├── uploads/                    # User uploads
│   └── {uid}/
│       └── {timestamp}_{uuid}_{filename}
│
├── results/                    # AI generation results
│   └── {req_id}.{format}
│
├── archive/                    # Archived logs
│   └── logs/
│       └── {year}/{month}/{day}.json.gz
│
├── temp/                       # Temporary files (auto-delete)
│   └── {uuid}
│
└── presets/                    # System presets/templates
    └── {category}/
        └── {preset_id}.{format}
```

---

## Environment Variables

```toml
# wrangler.toml

[vars]
FIREBASE_PROJECT_ID = "your-firebase-project"
GOOGLE_PACKAGE_NAME = "com.app.faceswap"
AI_COST_PER_REQUEST = 10
MAX_FILE_SIZE_MB = 10
MAX_DEVICES_PER_USER = 10                    # Limit devices per user
FCM_PUSH_ENABLED = true                       # Enable/disable push notifications

# Secrets (wrangler secret put)
# GOOGLE_SERVICE_ACCOUNT_EMAIL               # Service account email for Google APIs
# GOOGLE_PRIVATE_KEY                         # Private key (PEM format)
# FIREBASE_API_KEY                           # Firebase Web API key

[triggers]
crons = ["*/5 * * * *"]                       # Run every 5 minutes

[[kv_namespaces]]
binding = "KV"
id = "xxx"

[[d1_databases]]
binding = "D1"
database_id = "xxx"

[[r2_buckets]]
binding = "R2"
bucket_name = "faceswap-storage"
```

### Service Account Setup for FCM

Để gửi push notifications qua FCM HTTP v1 API, cần setup Service Account với quyền Firebase Cloud Messaging:

1. **Google Cloud Console** → IAM & Admin → Service Accounts
2. Tạo hoặc chọn Service Account
3. **Add Roles:**
   - `Firebase Cloud Messaging API Admin` hoặc
   - `Firebase Admin SDK Administrator Service Agent`
4. **Create Key** → JSON → Download
5. Extract `client_email` và `private_key` từ JSON file
6. Set secrets trong Cloudflare:
   ```bash
   wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
   wrangler secret put GOOGLE_PRIVATE_KEY
   ```

### OAuth Scopes Required

| API | Scope |
|-----|-------|
| Google Play API | `https://www.googleapis.com/auth/androidpublisher` |
| Firebase Cloud Messaging | `https://www.googleapis.com/auth/firebase.messaging` |
| Vertex AI | `https://www.googleapis.com/auth/cloud-platform` |

---

## Android Client Implementation Notes

### FCM Token Management

```kotlin
// Get initial token
FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
    if (task.isSuccessful) {
        val token = task.result
        // Register with backend
        apiClient.registerDevice(deviceId, token)
    }
}

// Handle token refresh
class MyFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // Update token on server
        apiClient.updateDeviceToken(deviceId, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        when (data["type"]) {
            "BALANCE_SYNC" -> {
                // Update local balance cache
                val newBalance = data["new_balance"]?.toIntOrNull()
                val change = data["change"]
                val event = data["event"]

                // Update local storage
                BalanceRepository.updateBalance(newBalance)

                // Notify UI (if app is visible)
                EventBus.post(BalanceChangedEvent(newBalance, change, event))

                // Optional: Show notification for deposits
                if (event == "DEPOSIT" && change?.startsWith("+") == true) {
                    showNotification(
                        title = "Credits Added!",
                        body = "$change credits have been added to your account"
                    )
                }
            }
        }
    }
}
```

### Device ID Generation

```kotlin
// Generate or retrieve persistent device ID
fun getOrCreateDeviceId(context: Context): String {
    val prefs = context.getSharedPreferences("device", Context.MODE_PRIVATE)
    var deviceId = prefs.getString("device_id", null)

    if (deviceId == null) {
        deviceId = UUID.randomUUID().toString()
        prefs.edit().putString("device_id", deviceId).apply()
    }

    return deviceId
}
```
