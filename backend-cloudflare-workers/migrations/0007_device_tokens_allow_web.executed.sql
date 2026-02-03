-- Allow 'web' platform in device_tokens (SQLite cannot ALTER CHECK; recreate table)
CREATE TABLE IF NOT EXISTS device_tokens_new (
  token TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  app_version TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
INSERT INTO device_tokens_new SELECT * FROM device_tokens;
DROP TABLE device_tokens;
ALTER TABLE device_tokens_new RENAME TO device_tokens;
CREATE INDEX IF NOT EXISTS idx_device_tokens_profile ON device_tokens(profile_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_updated ON device_tokens(updated_at);
