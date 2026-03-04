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

- `ENABLE_CREDIT_SYSTEM`: `"true"` để bật hệ thống credit (mặc định `"false"`)
- `CREDIT_COST_*`: Chi phí cho từng action (FACESWAP, BACKGROUND, ENHANCE, BEAUTY, FILTER, RESTORE, AGING, UPSCALER4K)
- `TIER_MULTIPLIER_*`: Hệ số theo tier (FREE=1.0, SUBSCRIBER=0.8)

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

**Auth:** API Key

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

**Auth:** API Key

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

**Auth:** API Key

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

**Auth:** API Key

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

Khi `ENABLE_CREDIT_SYSTEM=true`, mỗi AI endpoint tự động trừ điểm theo 5 bước:

1. **Check subscription** — expired → REJECT
2. **Grace hết hạn?** — now > expires_at → mark expired → REJECT
3. **Lazy reset** — (chỉ ACTIVE) nếu now ≥ last_reset_at + 30 ngày → reset sub = points_per_cycle
4. **Fail fast** — sub + consumable < cost → REJECT (HTTP 402)
5. **Trừ điểm** — sub trước, hết sub thì trừ consumable

Nếu AI xử lý lỗi → hoàn điểm vào `consumable_point_remaining` (saga compensation).

Chi phí = `CREDIT_COST_*` × `TIER_MULTIPLIER_*`

## Tiers

| Tier | Multiplier mặc định | Mô tả |
|------|---------------------|-------|
| free | 1.0 | Không có subscription |
| subscriber | 0.8 | Có subscription đang active/grace |

---
