# 6. Thanh toán & Subscription (Google Play Billing)

Hệ thống điểm kép (dual credit):
- **Subscription points** (`sub_point_remaining`): reset mỗi 30 ngày theo chu kỳ subscription, trừ trước
- **Consumable points** (`consumable_point_remaining`): mua thêm, không bao giờ reset, trừ sau khi sub hết

## Luồng tổng quan

```
┌─────────────────────────────────────────────────────────────────┐
│  1. User mua subscription trên Google Play                      │
│  2. App nhận purchaseToken → gọi POST /api/subscription/verify  │
│  3. Backend verify với Google Play API → kích hoạt subscription  │
│  4. Backend gán sub_point_remaining = points_per_cycle           │
│                                                                  │
│  Sau đó (tự động, không cần app gọi):                           │
│  5. Google Play gửi RTDN qua Pub/Sub → POST /webhooks/google    │
│     - RENEWED(2): reset sub points, cycle+1                     │
│     - IN_GRACE(6): status=GRACE, vẫn reset sub points           │
│     - RECOVERED(1): status=ACTIVE, giữ nguyên points            │
│     - EXPIRED(13): chặn hoàn toàn, sub points = 0               │
│  6. Backend gửi FCM silent push → app sync trạng thái mới       │
│                                                                  │
│  Khi user dùng AI feature:                                       │
│  7. Backend lazy-check subscription + trừ sub trước, consumable  │
│     sau (real-time, không cron)                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Cấu hình

- Hệ thống credit **luôn bật** (không cần toggle)
- **Bắt buộc subscription active** để dùng điểm (cả sub + consumable)
- `CREDIT_COST_*`: Chi phí cho từng action (override bằng env var, ví dụ `CREDIT_COST_FACESWAP=10`)
- Chi phí tối thiểu = 1 (không thể set cost = 0 qua env var)
- `PROFILE_TOKEN_SECRET`: Bắt buộc cho production — khi set, mọi endpoint yêu cầu `X-Profile-Token` header

### Chi phí mặc định (Default Credit Costs)

| Category | Action | Endpoint | Cost |
|----------|--------|----------|------|
| **Enhance** | Image Enhance | `/enhance` | 2 |
| | Image Restore | `/restore` | 2 |
| | HD 4K Upscale | `/upscaler4k` | 5 |
| **Portrait** | AI Beautify | `/beauty` | 2 |
| | AI Filter | `/filter` | 3 |
| | AI Avatar | `/faceswap` | 5 |
| | AI Expressions | `/expression` | 1 |
| | AI Hairstyles | `/hair-style` | 1 |
| | AI Aging | `/aging` | 1 |
| **Edit** | Remove Object | `/remove-object` | 1 |
| | AI Background | `/background` | 5 |
| | AI Expand | `/expand` | 2 |
| | AI Replace | `/replace-object` | 2 |
| | AI Remove Text | `/remove-text` | 1 |
| | AI Editor | `/editor` | 5 |

Chi phí được xác định theo pricing tier (tối thiểu 1 điểm/action). Có thể override bằng env var `CREDIT_COST_<ACTION>`.

### Pricing Tiers (Bảng giá theo tier)

Mỗi tier có **bảng giá riêng** cho từng action — cấu hình độc lập, không dùng multiplier.

**Bước 1:** Set env var `PRICING_TIERS` — định nghĩa bảng giá cho mỗi tier:

```json
{
  "high": { "faceswap": 10, "background": 10, "upscaler4k": 10, "enhance": 4, "beauty": 4, "filter": 6, "restore": 4, "aging": 2, "remove_object": 2, "expression": 2, "expand": 4, "editor": 10, "replace_object": 4, "remove_text": 2, "hair_style": 2 },
  "mid":  { "faceswap": 7,  "background": 7,  "upscaler4k": 7,  "enhance": 3, "beauty": 3, "filter": 4, "restore": 3, "aging": 1, "remove_object": 1, "expression": 1, "expand": 3, "editor": 7,  "replace_object": 3, "remove_text": 1, "hair_style": 1 },
  "low":  { "faceswap": 3,  "background": 3,  "upscaler4k": 3,  "enhance": 1, "beauty": 1, "filter": 2, "restore": 1, "aging": 1, "remove_object": 1, "expression": 1, "expand": 1, "editor": 3,  "replace_object": 1, "remove_text": 1, "hair_style": 1 }
}
```

**Bước 2:** Set env var `COUNTRY_TIER_MAP` — map quốc gia vào tier:

```json
{
  "US": "high", "GB": "high", "AU": "high", "CA": "high", "DE": "high", "FR": "high", "NL": "high", "SE": "high", "NO": "high", "DK": "high", "CH": "high", "AT": "high", "IE": "high", "FI": "high", "BE": "high", "LU": "high", "NZ": "high",
  "JP": "mid", "KR": "mid", "TW": "mid", "SG": "mid", "IL": "mid", "AE": "mid", "SA": "mid", "QA": "mid", "KW": "mid", "BH": "mid", "IT": "mid", "ES": "mid",
  "VN": "low", "TH": "low", "ID": "low", "PH": "low", "IN": "low", "MY": "low", "MM": "low", "KH": "low", "LA": "low", "BD": "low", "PK": "low", "LK": "low", "NP": "low", "NG": "low", "KE": "low", "ET": "low"
}
```

Quốc gia từ Cloudflare `CF-IPCountry` header (server-determined, không giả mạo được).

- Quốc gia không nằm trong `COUNTRY_TIER_MAP` = dùng `DEFAULT_CREDIT_COSTS`
- Không set env vars = tất cả dùng default
- Ví dụ: faceswap ở US (tier high) = 10 điểm; ở VN (tier low) = 3 điểm; ở Brazil (không map) = 5 điểm (default)

**API kiểm tra giá:** `GET /api/credit-costs` — trả giá theo quốc gia hiện tại của caller:

```json
{
  "data": {
    "faceswap": { "base": 5, "cost": 3 },
    "background": { "base": 5, "cost": 3 }
  },
  "country": "VN",
  "status": "success"
}
```

## Subscription SKUs

| SKU | Điểm/chu kỳ (30 ngày) | Giá |
|-----|----------------------|-----|
| `sub_monthly` | 1000 | 99,000 VND/tháng |
| `sub_semi_annual` | 1200 | 499,000 VND/6 tháng |
| `sub_annual` | 1500 | 899,000 VND/năm |

## Consumable SKUs

| SKU | Điểm | Giá |
|-----|------|-----|
| `credits_10` | 10 | 22,000 VND |
| `credits_50` | 50 | 99,000 VND |
| `credits_100` | 100 | 176,000 VND |
| `credits_500` | 500 | 770,000 VND |

## Endpoints

### GET `/api/products` - Danh sách sản phẩm

**Auth:** API Key

```json
// Response
{
  "data": [
    {
      "sku": "credits_10",
      "type": "consumable",
      "credits": 10,
      "points_per_cycle": 0,
      "name": "10 Credits",
      "description": "Gói 10 credits",
      "price_micros": 22000000000,
      "currency": "VND"
    },
    {
      "sku": "sub_monthly",
      "type": "subscription",
      "credits": 0,
      "points_per_cycle": 1000,
      "name": "Monthly",
      "description": "Gói tháng - 1000 điểm/chu kỳ",
      "price_micros": 99000000000,
      "currency": "VND"
    }
  ],
  "status": "success",
  "code": 200
}
```

### GET `/api/user/balance?profile_id={id}` - Số dư điểm kép + trạng thái subscription

**Auth:** API Key + Profile Token

```json
// Response
{
  "data": {
    "sub_point_remaining": 800,
    "consumable_point_remaining": 50,
    "total_available": 850,
    "subscription_status": "ACTIVE",
    "total_credits_purchased": 100,
    "total_credits_spent": 50
  },
  "status": "success",
  "code": 200
}
```

`subscription_status`: `ACTIVE` | `GRACE` | `CANCELLED` | `EXPIRED` | `PAUSED` | `NONE`

### POST `/api/deposit` - Nạp consumable points (verify Google Play purchase)

**Auth:** API Key + Profile Token

Mua consumable → điểm vào `consumable_point_remaining` (không bao giờ reset).

```json
// Request
{
  "profile_id": "abc123",
  "sku": "credits_50",
  "purchase_token": "google-play-purchase-token",
  "order_id": "GPA.1234-5678-9012"
}

// Response (success)
{
  "data": {
    "payment_id": "pay_xxx",
    "credits_granted": 50,
    "status": "COMPLETED"
  },
  "status": "success",
  "code": 200
}
```

**Lưu ý:** Idempotent theo `order_id` - gọi lại với cùng order_id sẽ trả kết quả cũ.

### GET `/api/deposit/status/{order_id}` - Kiểm tra trạng thái nạp

**Auth:** API Key

```json
// Response
{
  "data": {
    "id": "pay_xxx",
    "profile_id": "abc123",
    "sku": "credits_50",
    "order_id": "GPA.1234-5678-9012",
    "status": "COMPLETED",
    "credits_granted": 50
  },
  "status": "success",
  "code": 200
}
```

### POST `/api/subscription/verify` - Kích hoạt subscription (app gọi sau khi mua trên Google Play)

**Auth:** API Key + Profile Token

**Luồng:** User mua subscription trên Google Play → app nhận `purchaseToken` → app gọi endpoint này → backend verify với Google Play API → kích hoạt + gán `sub_point_remaining = points_per_cycle`.

```json
// Request
{
  "profile_id": "abc123",
  "sku": "sub_monthly",
  "purchase_token": "google-play-subscription-token"
}

// Response
{
  "data": {
    "subscription_id": "sub_xxx",
    "points_per_cycle": 1000,
    "expires_at": 1742592000,
    "status": "ACTIVE"
  },
  "status": "success",
  "code": 200
}
```

### GET `/api/subscription/status?profile_id={id}` - Trạng thái subscription hiện tại

**Auth:** API Key + Profile Token

```json
// Response
{
  "data": {
    "id": "sub_xxx",
    "sku": "sub_monthly",
    "status": "ACTIVE",
    "auto_renewing": 1,
    "expires_at": 1742592000,
    "last_reset_at": 1740000000,
    "cycle_count_used": 3,
    "points_per_cycle": 1000,
    "cancelled_at": null
  },
  "status": "success",
  "code": 200
}
```

### POST `/webhooks/google` - Google Play RTDN Webhook

**Auth:** Shared secret (`GOOGLE_WEBHOOK_SECRET`)

Nhận thông báo từ Google Play qua Pub/Sub (RTDN). App **KHÔNG** gọi endpoint này — Google gọi tự động.

**Subscription events được xử lý:**

| Type | Event | Hành động |
|------|-------|-----------|
| 2 | RENEWED | status=ACTIVE, reset sub=points_per_cycle, cycle+1 |
| 6 | IN_GRACE_PERIOD | status=GRACE, reset sub=points_per_cycle, cycle+1 |
| 1 | RECOVERED | status=ACTIVE, KHÔNG reset, KHÔNG đổi cycle |
| 3 | CANCELED | status=CANCELLED, auto_renewing=0 |
| 13 | EXPIRED | status=EXPIRED, sub_point_remaining=0 |
| 12 | REVOKED | status=EXPIRED, sub_point_remaining=0 |
| 10 | PAUSED | status=PAUSED |

**One-time product events:**
- Refund (type 2): trừ `consumable_point_remaining` (clamp to 0)

## Trừ điểm trong AI Endpoints (Dual Credit Deduction)

Mỗi AI endpoint tự động trừ điểm theo 6 bước:

1. **Auth check** — verify profile token → fail = reason `4010`
2. **Profile check** — profile tồn tại? bị ban? → fail = reason `4020` / `4030`
3. **Subscription check:**
   - Có sub ON_HOLD → zero sub points
   - Có sub GRACE nhưng hết hạn → mark EXPIRED, zero sub
   - Có sub ACTIVE quá 30 ngày → lazy reset sub = points_per_cycle
   - Không có sub → zero sub points
4. **Subscription required** — **BẮT BUỘC** có subscription ACTIVE hoặc GRACE để dùng điểm. Không có subscription = chặn hoàn toàn (kể cả có consumable points). Fail = reason `4040`/`4050`/`4060`
5. **Fail fast** — sub + consumable < cost → HTTP 402, reason = `4070`
6. **Trừ điểm** — sub trước, hết sub thì trừ consumable (atomic UPDATE với WHERE guard)

Nếu AI xử lý lỗi → hoàn điểm vào `consumable_point_remaining` (saga compensation).

**Quan trọng:** Consumable points CHỈ dùng được khi có subscription active. Mua consumable points mà không có subscription = không dùng được.

### Response khi credit check thất bại (HTTP 402)

```json
{
  "data": null,
  "status": "error",
  "message": "Credit check failed",
  "code": 402,
  "reason": 4070
}
```

### Bảng `reason` codes (numeric)

| reason | Ý nghĩa | App nên làm gì |
|--------|---------|-----------------|
| `4010` | Token xác thực sai | Re-login, lấy lại profile_token |
| `4020` | Profile không tồn tại | Tạo profile mới |
| `4030` | Tài khoản bị cấm | Hiện thông báo ban |
| `4040` | Subscription ON_HOLD (thanh toán bị giữ) | Hiện "Cập nhật thanh toán" |
| `4050` | Grace period hết, subscription expired | Hiện "Gia hạn subscription" |
| `4060` | Không có subscription active | Hiện "Mua subscription" |
| `4070` | Hết điểm (sub + consumable < cost) | Hiện "Mua thêm credits" |
| `4080` | Trùng request (race condition) | Retry 1 lần |

**Lưu ý:** Reason `4040`/`4050`/`4060` = phải có subscription active mới dùng được điểm (kể cả consumable).

## Authentication

### Hai lớp bảo vệ:

| Lớp | Header | Mục đích |
|-----|--------|----------|
| **API Key** | `X-API-Key` hoặc `Authorization: Bearer` | Xác thực app (shared key, nhúng trong APK) |
| **Profile Token** | `X-Profile-Token` | Xác thực quyền sở hữu profile (HMAC-SHA256, mỗi profile khác nhau) |

### Profile Token hoạt động thế nào:

1. App tạo profile → backend trả `profile_token` (HMAC-SHA256 của profile_id với server secret)
2. App lưu `profile_token` cùng `profile_id`
3. Mọi request gửi `X-Profile-Token` header → backend verify
4. Nếu không khớp → HTTP 401

**Khi nào bật:** Tự động bật khi `PROFILE_TOKEN_SECRET` được set (production). Không set = skip check (chỉ dùng lúc setup ban đầu).

**Endpoints yêu cầu Profile Token:**
- Tất cả AI endpoints (`/faceswap`, `/background`, `/enhance`, v.v.)
- `PUT /profiles/{id}` — chỉnh sửa profile
- `GET /api/user/balance` — xem số dư
- `POST /api/deposit` — nạp tiền
- `POST /api/subscription/verify` — kích hoạt subscription
- `GET /api/subscription/status` — xem trạng thái subscription

---
# Sơ Đồ Hệ Thống Điểm & Subscription

> **Nguồn Google Play chính thức:**
> [Integrate Billing Library](https://developer.android.com/google/play/billing/integrate) |
> [Backend Integration](https://developer.android.com/google/play/billing/backend) |
> [RTDN Reference](https://developer.android.com/google/play/billing/rtdn-reference) |
> [Subscription Lifecycle](https://developer.android.com/google/play/billing/lifecycle)

---

## LUỒNG 0: MUA & KÍCH HOẠT (CLIENT → BACKEND → GOOGLE)

> **Theo Google docs:** App nhận `purchaseToken` sau khi user mua → gửi token lên backend để verify.
> Xem: [Integrate - Process purchases](https://developer.android.com/google/play/billing/integrate#process),
> [Backend - Verify purchases](https://developer.android.com/google/play/billing/backend)

```
═══════════════════════════════════════════════════════════════════════════════
  LUỒNG 0A: MUA SUBSCRIPTION
═══════════════════════════════════════════════════════════════════════════════

  ┌──────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────┐
  │  USER    │      │  GOOGLE PLAY │      │   BACKEND    │      │  GOOGLE  │
  │  (App)   │      │  (trên máy)  │      │  (Worker)    │      │  API     │
  └────┬─────┘      └──────┬───────┘      └──────┬───────┘      └────┬─────┘
       │                   │                      │                   │
       │  1. Chọn gói      │                      │                   │
       │  sub_monthly      │                      │                   │
       │──────────────────>│                      │                   │
       │                   │                      │                   │
       │  2. Thanh toán    │                      │                   │
       │  Google xử lý     │                      │                   │
       │<──────────────────│                      │                   │
       │  purchaseToken ←──│                      │                   │
       │                   │                      │                   │
       │  3. POST /api/subscription/verify        │                   │
       │  { profile_id, sku, purchase_token }     │                   │
       │─────────────────────────────────────────>│                   │
       │                                          │                   │
       │                                          │  4. Verify token  │
       │                                          │──────────────────>│
       │                                          │  valid ✓          │
       │                                          │<──────────────────│
       │                                          │                   │
       │                                          │  5. Acknowledge   │
       │                                          │──────────────────>│
       │                                          │                   │
       │                                          │  6. DB update:    │
       │                                          │  subscription:    │
       │                                          │    status=ACTIVE  │
       │                                          │    points_per_    │
       │                                          │    cycle=1000     │
       │                                          │    last_reset=now │
       │                                          │  profile:         │
       │                                          │    sub_point=1000 │
       │                                          │                   │
       │  7. Response: { status: ACTIVE,          │                   │
       │     points_per_cycle: 1000 }             │                   │
       │<─────────────────────────────────────────│                   │
       │                                          │                   │
       │  8. App cập nhật UI                      │                   │
       │                                          │                   │

═══════════════════════════════════════════════════════════════════════════════
  LUỒNG 0B: MUA CONSUMABLE
═══════════════════════════════════════════════════════════════════════════════

  ┌──────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────┐
  │  USER    │      │  GOOGLE PLAY │      │   BACKEND    │      │  GOOGLE  │
  │  (App)   │      │  (trên máy)  │      │  (Worker)    │      │  API     │
  └────┬─────┘      └──────┬───────┘      └──────┬───────┘      └────┬─────┘
       │                   │                      │                   │
       │  1. Mua credits_50│                      │                   │
       │──────────────────>│                      │                   │
       │                   │                      │                   │
       │  2. purchaseToken │                      │                   │
       │<──────────────────│                      │                   │
       │                   │                      │                   │
       │  3. POST /api/deposit                    │                   │
       │  { profile_id, sku, purchase_token,      │                   │
       │    order_id }                            │                   │
       │─────────────────────────────────────────>│                   │
       │                                          │  4. Verify        │
       │                                          │──────────────────>│
       │                                          │  5. Acknowledge   │
       │                                          │──────────────────>│
       │                                          │                   │
       │                                          │  6. DB:           │
       │                                          │  consumable += 50 │
       │                                          │                   │
       │  7. { credits_granted: 50 }              │                   │
       │<─────────────────────────────────────────│                   │
       │                                          │                   │

═══════════════════════════════════════════════════════════════════════════════
  LUỒNG 0C: WEBHOOK RTDN (GOOGLE → BACKEND → APP qua FCM)
  Sau khi subscription đã active, các event tiếp theo Google gửi tự động
═══════════════════════════════════════════════════════════════════════════════

  ┌──────────┐      ┌──────────────┐      ┌──────────────┐
  │  APP     │      │  GOOGLE PLAY │      │   BACKEND    │
  │  (FCM)   │      │  (Pub/Sub)   │      │  (Worker)    │
  └────┬─────┘      └──────┬───────┘      └──────┬───────┘
       │                   │                      │
       │                   │  1. RTDN event       │
       │                   │  (RENEWED/GRACE/     │
       │                   │   EXPIRED/etc)       │
       │                   │─────────────────────>│
       │                   │  POST /webhooks/     │
       │                   │  google              │
       │                   │                      │
       │                   │                      │  2. Cập nhật DB
       │                   │                      │  (status, points,
       │                   │                      │   cycle, etc)
       │                   │                      │
       │  3. FCM silent push                      │
       │  { type: "subscription_update",          │
       │    status: "RENEWED" }                   │
       │<─────────────────────────────────────────│
       │                   │                      │
       │  4. App nhận FCM  │                      │
       │  → gọi GET /api/  │                      │
       │  user/balance để  │                      │
       │  sync UI          │                      │
       │                   │                      │
```

---

## TOÀN BỘ LUỒNG SAU KHI ĐÃ KÍCH HOẠT (ASCII)

```
                        ┌─────────────────────────────┐
                        │   SUBSCRIPTION ĐÃ ACTIVE    │
                        │   (sau luồng 0A ở trên)     │
                        └──────────────┬──────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │            TRẠNG THÁI HIỆN TẠI          │
                  │                                         │
                  │  subscription:                          │
                  │    status = active                      │
                  │    sub_point_remaining = points_per_cycle│
                  │    last_reset_at = now                  │
                  │    end_date = now + 30 ngày             │
                  │    cycle_count_used = 1                 │
                  │                                         │
                  │  profile:                               │
                  │    consumable_point_remaining = 0       │
                  │    (tăng khi mua thêm, không bao giờ   │
                  │     reset, không phụ thuộc subscription)│
                  └──────────────────┬──────────────────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
          ▼                          ▼                          ▼
┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ USER DÙNG ĐIỂM  │   │ GOOGLE PLAY GỬI RTDN │   │ USER MUA CONSUMABLE  │
│ (xem luồng bên  │   │ (xem luồng bên dưới) │   │ (luồng 0B ở trên)   │
│  dưới)           │   │                       │   │ consumable += N      │
└──────────────────┘   └───────────────────────┘   └──────────────────────┘


═══════════════════════════════════════════════════════════════════════════════
  LUỒNG 1: GOOGLE PLAY RTDN → CẬP NHẬT TRẠNG THÁI
═══════════════════════════════════════════════════════════════════════════════

                         Hết chu kỳ 30 ngày
                         Google Play tính phí
                                 │
                    ┌────────────┴────────────┐
                    │                         │
               Tính phí OK              Tính phí LỖI
                    │                         │
                    ▼                         ▼
  ┌──────────────────────────┐  ┌──────────────────────────────┐
  │ (2) SUBSCRIPTION_RENEWED │  │(6) SUBSCRIPTION_IN_GRACE_    │
  │                          │  │    PERIOD                    │
  │ status = active          │  │                              │
  │ end_date += 30 ngày      │  │ status = grace               │
  │ sub = points_per_cycle   │  │ end_date += 30 ngày          │
  │ last_reset_at = now      │  │ sub = points_per_cycle ←RESET│
  │ cycle_count_used += 1    │  │ last_reset_at = now          │
  │                          │  │ cycle_count_used += 1        │
  │ → RESET điểm             │  │                              │
  │ → chu kỳ mới             │  │ → VẪN RESET điểm            │
  │ → tiếp tục bình thường   │  │ → chu kỳ mới (tính đã dùng) │
  └────────────┬─────────────┘  │ → user vẫn dùng được điểm   │
               │                └──────────────┬───────────────┘
               │                               │
               │                    ┌──────────┴──────────┐
               │                    │                     │
               │               Retry OK            Grace hết,
               │               trong grace         vẫn chưa trả
               │                    │                     │
               │                    ▼                     ▼
               │  ┌───────────────────────┐  ┌────────────────────────┐
               │  │(1) SUBSCRIPTION_      │  │(5) SUBSCRIPTION_       │
               │  │    RECOVERED          │  │    ON_HOLD             │
               │  │                       │  │                        │
               │  │ status = active       │  │ status = on_hold       │
               │  │ KHÔNG reset sub       │  │ sub_point = 0 ← MẤT   │
               │  │ KHÔNG đổi last_reset  │  │ user MẤT quyền truy   │
               │  │ KHÔNG đổi cycle       │  │ cập NGAY LẬP TỨC      │
               │  │                       │  │                        │
               │  │ → giữ nguyên điểm     │  │                        │
               │  │ → grace = đã thanh    │  └──────────┬─────────────┘
               │  │   toán                │             │
               │  └───────────┬───────────┘  ┌──────────┴──────────┐
               │              │              │                     │
               │              │         Retry OK trong       60 ngày hết,
               │              │         account hold         vẫn chưa trả
               │              │              │                     │
               │              │              ▼                     ▼
               │              │  ┌───────────────────┐  ┌────────────────────┐
               │              │  │(1) RECOVERED      │  │(13) EXPIRED        │
               │              │  │ từ ON_HOLD        │  │                    │
               │              │  │                   │  │ status = expired   │
               │              │  │ status = active   │  │ CHẶN HOÀN TOÀN    │
               │              │  │ restore sub points│  │ sub_point = 0     │
               │              │  └────────┬──────────┘  └────────────────────┘
               │              │           │
               └──────┬───────┴───────────┘
                      │
                      ▼
              Quay lại đầu chu kỳ
              (chờ 30 ngày tiếp)


═══════════════════════════════════════════════════════════════════════════════
  LUỒNG 2: USER DÙNG N ĐIỂM → XỬ LÝ REAL-TIME (KHÔNG CRON)
═══════════════════════════════════════════════════════════════════════════════

                      User yêu cầu dùng N điểm
                                 │
                                 ▼
                ┌────────────────────────────────┐
                │  BƯỚC 1: Kiểm tra status       │
                └───────────────┬────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                  │
           expired         active              grace
              │                 │                  │
              ▼                 │                  ▼
        ╔═══════════╗          │    ┌──────────────────────────┐
        ║  REJECT   ║          │    │ BƯỚC 2: Grace hết hạn?  │
        ║  hết hạn  ║          │    │ now > end_date ?         │
        ╚═══════════╝          │    └─────────────┬────────────┘
                               │           ┌──────┴──────┐
                               │           │             │
                               │         CÓ (hết)    KHÔNG (còn)
                               │           │             │
                               │           ▼             │
                               │    ╔═══════════╗       │
                               │    ║  REJECT   ║       │
                               │    ║→ expired  ║       │
                               │    ╚═══════════╝       │
                               │                        │
                               └───────────┬────────────┘
                                           │
                                           ▼
                          ┌─────────────────────────────────┐
                          │ BƯỚC 3: Lazy reset chu kỳ       │
                          │ (CHỈ khi status = active)       │
                          │                                 │
                          │ now ≥ last_reset_at + 30 ngày ? │
                          └───────────────┬─────────────────┘
                                   ┌──────┴──────┐
                                   │             │
                                 CÓ           KHÔNG
                                   │             │
                                   ▼             │
                          ┌──────────────────┐   │
                          │ sub = points_per │   │
                          │     _cycle       │   │
                          │ last_reset = now │   │
                          │ cycle += 1       │   │
                          └────────┬─────────┘   │
                                   │             │
                                   └──────┬──────┘
                                          │
                                          ▼
                          ┌────────────────────────────────┐
                          │ BƯỚC 4: FAIL FAST              │
                          │                                │
                          │ total = sub + consumable       │
                          │ total ≥ N ?                    │
                          └───────────────┬────────────────┘
                                   ┌──────┴──────┐
                                   │             │
                               KHÔNG            CÓ
                                   │             │
                                   ▼             ▼
                          ╔═══════════╗  ┌──────────────────────┐
                          ║  REJECT   ║  │ BƯỚC 5: Trừ điểm    │
                          ║ không đủ  ║  │ (sub trước,          │
                          ╚═══════════╝  │  consumable sau)     │
                                         └──────────┬───────────┘
                                              ┌─────┴─────┐
                                              │           │
                                         sub ≥ N      sub < N
                                              │           │
                                              ▼           ▼
                                     ┌────────────┐ ┌─────────────────┐
                                     │ sub -= N   │ │ dư = N - sub    │
                                     │            │ │ sub = 0         │
                                     │            │ │ consumable -= dư│
                                     └─────┬──────┘ └────────┬────────┘
                                           │                 │
                                           └────────┬────────┘
                                                    │
                                                    ▼
                                           ╔═══════════════╗
                                           ║  ACCEPT  ✓    ║
                                           ╚═══════════════╝
```

---

## TOÀN BỘ LUỒNG (MERMAID)

```mermaid
flowchart TD
    SIGNUP(["Người dùng đăng ký subscription"])
    SIGNUP --> PLAN{"Chọn gói?"}
    PLAN -->|"Gói tháng"| INIT["points_per_cycle = 1000"]
    PLAN -->|"Gói 6 tháng"| INIT2["points_per_cycle = 1200"]
    PLAN -->|"Gói năm"| INIT3["points_per_cycle = 1500"]
    INIT --> INITDB
    INIT2 --> INITDB
    INIT3 --> INITDB

    INITDB["Khởi tạo DB:<br>status=active<br>sub=points_per_cycle<br>last_reset=now<br>end_date=now+30d<br>cycle=1<br>consumable=0"]

    INITDB --> LIVE(("HỆ THỐNG<br>ĐANG CHẠY"))

    %% ====== NHÁNH RTDN ======
    LIVE --> RTDN_TRIGGER["Hết chu kỳ 30 ngày<br>Google Play tính phí"]
    LIVE --> USE_TRIGGER["User yêu cầu<br>dùng N điểm"]
    LIVE --> BUY_TRIGGER["User mua consumable"]

    BUY_TRIGGER --> BUY_OK["consumable += N<br>không ảnh hưởng subscription"]
    BUY_OK --> LIVE

    RTDN_TRIGGER --> CHARGE{"Tính phí<br>thành công?"}

    CHARGE -->|"OK"| RENEWED["(2) SUBSCRIPTION_RENEWED<br>─────────────────<br>status = active<br>sub = points_per_cycle ← RESET<br>end_date += 30d<br>last_reset = now<br>cycle += 1"]

    CHARGE -->|"LỖI"| IN_GRACE["(6) SUBSCRIPTION_IN_GRACE_PERIOD<br>─────────────────<br>status = grace<br>sub = points_per_cycle ← VẪN RESET<br>end_date += 30d<br>last_reset = now<br>cycle += 1<br>chu kỳ tính là đã dùng"]

    RENEWED --> LIVE

    IN_GRACE --> GRACE_WAIT{"Trong 30 ngày grace<br>user retry thanh toán?"}

    GRACE_WAIT -->|"Retry OK"| RECOVERED["(1) SUBSCRIPTION_RECOVERED<br>─────────────────<br>status = active<br>KHÔNG reset sub ← GIỮ NGUYÊN<br>KHÔNG đổi last_reset<br>KHÔNG đổi cycle<br>grace = đã thanh toán"]

    GRACE_WAIT -->|"30 ngày hết<br>vẫn chưa trả"| SUB_EXPIRED["(13) SUBSCRIPTION_EXPIRED<br>─────────────────<br>status = expired<br>CHẶN HOÀN TOÀN"]

    RECOVERED --> LIVE

    %% ====== NHÁNH DÙNG ĐIỂM ======
    USE_TRIGGER --> S1{"BƯỚC 1<br>status = ?"}

    S1 -->|"expired"| R1["REJECT: hết hạn"]

    S1 -->|"grace"| S2{"BƯỚC 2<br>Grace hết hạn?<br>now > end_date?"}

    S1 -->|"active"| S3

    S2 -->|"Hết hạn"| R2["REJECT<br>cập nhật → expired"]

    S2 -->|"Còn hạn"| S4

    S3{"BƯỚC 3<br>Lazy reset?<br>now ≥ last_reset+30d?"}

    S3 -->|"Cần reset"| DO_RESET["sub = points_per_cycle<br>last_reset = now<br>cycle += 1"]
    S3 -->|"Chưa cần"| S4

    DO_RESET --> S4

    S4{"BƯỚC 4: FAIL FAST<br>total = sub + consumable<br>total ≥ N ?"}

    S4 -->|"Không đủ"| R3["REJECT: không đủ điểm"]

    S4 -->|"Đủ"| S5{"BƯỚC 5<br>sub ≥ N ?"}

    S5 -->|"Sub đủ"| D1["sub -= N"]
    S5 -->|"Sub không đủ"| D2["dư = N - sub<br>sub = 0<br>consumable -= dư"]

    D1 --> OK["ACCEPT ✓"]
    D2 --> OK
    OK --> LIVE

    %% ====== STYLES ======
    style LIVE fill:#3b82f6,color:#fff,stroke-width:3px
    style RENEWED fill:#22c55e,color:#fff
    style RECOVERED fill:#22c55e,color:#fff
    style IN_GRACE fill:#eab308,color:#000
    style SUB_EXPIRED fill:#ef4444,color:#fff
    style R1 fill:#ef4444,color:#fff
    style R2 fill:#ef4444,color:#fff
    style R3 fill:#ef4444,color:#fff
    style OK fill:#22c55e,color:#fff
    style BUY_OK fill:#a855f7,color:#fff
```
