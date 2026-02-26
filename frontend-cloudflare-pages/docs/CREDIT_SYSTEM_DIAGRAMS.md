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
