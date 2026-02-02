-- FCM Device Token Storage for Silent Push Notifications
-- profile_id references profiles.id (existing table)

CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  app_version TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Index for efficient lookup by profile (main query pattern)
CREATE INDEX IF NOT EXISTS idx_device_tokens_profile ON device_tokens(profile_id);

-- Index for stale token cleanup jobs
CREATE INDEX IF NOT EXISTS idx_device_tokens_updated ON device_tokens(updated_at);
