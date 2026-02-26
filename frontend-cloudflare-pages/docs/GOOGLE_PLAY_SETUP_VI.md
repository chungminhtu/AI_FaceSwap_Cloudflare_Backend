# Hướng dẫn thiết lập Google Play Billing

## Các bước cần thực hiện thủ công (one-time setup)

### 1. Bật Google Play Android Developer API

1. Truy cập [Google Cloud Console](https://console.cloud.google.com/)
2. Chọn project: `gen-lang-client-0149764456`
3. Vào **APIs & Services** > **Library**
4. Tìm "**Google Play Android Developer API**"
5. Click **Enable**

### 2. Cấp quyền Service Account trong Google Play Console

1. Truy cập [Google Play Console](https://play.google.com/console)
2. Vào **Settings** > **API access**
3. Click **Link** để liên kết project GCP (`gen-lang-client-0149764456`)
4. Tìm service account: `uppixaiphoto@gen-lang-client-0149764456.iam.gserviceaccount.com`
5. Click **Grant access** và cấp quyền:
   - **Financial data**: Xem doanh thu, đơn hàng
   - **Manage orders and subscriptions**: Quản lý đơn hàng
6. Click **Invite user** > **Send invitation**
7. Chờ invitation được accept (tự động nếu đã link project)

### 3. Thiết lập Pub/Sub cho RTDN (Real-Time Developer Notifications)

1. Trong **Google Cloud Console** > **Pub/Sub**
2. Tạo Topic mới: `play-billing-notifications`
3. Tạo Subscription:
   - **Type**: Push
   - **Endpoint URL**: `https://api.d.shotpix.app/webhooks/google`
   - **Authentication**: Thêm header `Authorization: Bearer YOUR_WEBHOOK_SECRET`
4. Trong **Google Play Console** > **Monetization setup** > **Real-time developer notifications**:
   - **Topic name**: `projects/gen-lang-client-0149764456/topics/play-billing-notifications`
   - Click **Save**

### 4. Tạo In-App Products & Subscriptions trong Google Play Console

1. Vào **Monetization** > **Products** > **In-app products**
2. Tạo consumable products với các SKU:
   - `credits_10` - 22,000 VND
   - `credits_50` - 99,000 VND
   - `credits_100` - 176,000 VND
   - `credits_500` - 770,000 VND
3. Vào **Monetization** > **Products** > **Subscriptions**
4. Tạo subscriptions:
   - `sub_pro_monthly` - 99,000 VND/tháng
   - `sub_pro_yearly` - 990,000 VND/năm
   - `sub_premium_monthly` - 199,000 VND/tháng
   - `sub_premium_yearly` - 1,990,000 VND/năm

### 5. Cập nhật Environment Variables

Sau khi hoàn thành các bước trên, cập nhật trong `deployments-secrets.json`:

```json
{
  "GOOGLE_PLAY_PACKAGE_NAME": "com.your.app.package",
  "GOOGLE_WEBHOOK_SECRET": "your-random-secret-string",
  "ENABLE_CREDIT_SYSTEM": "true"
}
```

Sau đó deploy lại: `npm run deploy:parallel:test`

### 6. Chạy Database Migration

Migration file: `backend-cloudflare-workers/migrations/0008_payments_credits.sql`

Chạy migration: `npm run db:migrate`

---

## Kiểm tra

1. Gọi `GET /api/products` - Phải trả về danh sách SKU
2. Gọi `GET /api/user/balance?profile_id=xxx` - Phải trả về credits=0, tier=free
3. Test purchase flow trên Android app với test account
4. Kiểm tra webhook nhận notifications từ Google Play
