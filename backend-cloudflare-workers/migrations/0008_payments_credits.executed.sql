-- Migration 0008: Payment & Dual Credit System
-- Subscription points (reset every 30 days) + Consumable points (never reset)
-- Real-time lazy evaluation (no cron), grace period handling

-- ============================================================
-- 1. ALTER profiles: dual credit columns (no tier columns - use subscription table)
-- ============================================================
ALTER TABLE profiles ADD COLUMN sub_point_remaining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN consumable_point_remaining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN total_credits_purchased INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN total_credits_spent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- 2. products: SKU catalog (seeded with initial data)
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('consumable', 'subscription')),
  credits INTEGER NOT NULL DEFAULT 0,
  points_per_cycle INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price_micros INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'VND',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Seed: consumable credit packs
INSERT INTO products (sku, type, credits, name, description, price_micros, currency) VALUES
  ('credits_10', 'consumable', 10, '10 Credits', 'Gói 10 credits', 22000000000, 'VND'),
  ('credits_50', 'consumable', 50, '50 Credits', 'Gói 50 credits - tiết kiệm 10%', 99000000000, 'VND'),
  ('credits_100', 'consumable', 100, '100 Credits', 'Gói 100 credits - tiết kiệm 20%', 176000000000, 'VND'),
  ('credits_500', 'consumable', 500, '500 Credits', 'Gói 500 credits - tiết kiệm 30%', 770000000000, 'VND');

-- Seed: subscription tiers (1 tier "subscriber", 3 packages differ by points_per_cycle)
INSERT INTO products (sku, type, points_per_cycle, name, description, price_micros, currency) VALUES
  ('sub_monthly', 'subscription', 1000, 'Monthly', 'Gói tháng - 1000 điểm/chu kỳ', 99000000000, 'VND'),
  ('sub_semi_annual', 'subscription', 1200, 'Semi-Annual', 'Gói 6 tháng - 1200 điểm/chu kỳ', 499000000000, 'VND'),
  ('sub_annual', 'subscription', 1500, 'Annual', 'Gói năm - 1500 điểm/chu kỳ', 899000000000, 'VND');

-- ============================================================
-- 3. payments: order tracking with idempotency
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  order_id TEXT NOT NULL,
  purchase_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED')),
  credits_granted INTEGER NOT NULL DEFAULT 0,
  amount_micros INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'VND',
  platform TEXT NOT NULL DEFAULT 'android',
  raw_response TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (profile_id) REFERENCES profiles(id),
  FOREIGN KEY (sku) REFERENCES products(sku)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_profile_id ON payments(profile_id);
CREATE INDEX IF NOT EXISTS idx_payments_purchase_token ON payments(purchase_token);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ============================================================
-- 4. subscriptions: active subscription tracking with cycle info
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  purchase_token TEXT NOT NULL,
  points_per_cycle INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'GRACE', 'ON_HOLD', 'CANCELLED', 'EXPIRED', 'PAUSED')),
  auto_renewing INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  last_reset_at INTEGER NOT NULL DEFAULT (unixepoch()),
  cycle_count_used INTEGER NOT NULL DEFAULT 1,
  cancelled_at INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (profile_id) REFERENCES profiles(id),
  FOREIGN KEY (sku) REFERENCES products(sku)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_purchase_token ON subscriptions(purchase_token);
CREATE INDEX IF NOT EXISTS idx_subscriptions_profile_id ON subscriptions(profile_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at ON subscriptions(expires_at);

-- ============================================================
-- 5. audit_log: payment & credit activity tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT DEFAULT NULL,
  ip_address TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_audit_log_profile_id ON audit_log(profile_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
