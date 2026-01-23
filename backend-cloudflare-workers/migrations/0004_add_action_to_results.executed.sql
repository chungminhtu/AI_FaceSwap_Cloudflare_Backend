-- backend-cloudflare-workers/migrations/0004_add_action_to_results.sql
-- Add action column to results table
-- Safe to fail if column exists (SQLite doesn't support IF NOT EXISTS for ALTER COLUMN)

ALTER TABLE results ADD COLUMN action TEXT;

CREATE INDEX IF NOT EXISTS idx_results_action ON results(action);
CREATE INDEX IF NOT EXISTS idx_results_action_profile_id ON results(action, profile_id);
