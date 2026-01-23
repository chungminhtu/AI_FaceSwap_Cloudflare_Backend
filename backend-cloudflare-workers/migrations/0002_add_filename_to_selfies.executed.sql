-- backend-cloudflare-workers/migrations/0002_add_filename_to_selfies.sql
-- Add filename column to selfies table for override detection
-- Safe to fail if column exists (SQLite doesn't support IF NOT EXISTS for ALTER COLUMN)

ALTER TABLE selfies ADD COLUMN filename TEXT;
