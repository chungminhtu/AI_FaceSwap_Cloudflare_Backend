-- Safe migration script to add gender columns
-- Run this with: wrangler d1 execute <database-name> --remote --file=migrate-gender-columns.sql
-- Note: If columns already exist, you'll get "duplicate column" errors - that's fine, just ignore them

-- Add gender to preset_images (will fail if exists - that's OK)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we try and ignore errors
ALTER TABLE preset_images ADD COLUMN gender TEXT CHECK(gender IN ('male', 'female'));

-- Add gender to selfies (will fail if exists - that's OK)
ALTER TABLE selfies ADD COLUMN gender TEXT CHECK(gender IN ('male', 'female'));

-- Create indexes (safe with IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_preset_images_gender ON preset_images(gender);
CREATE INDEX IF NOT EXISTS idx_selfies_gender ON selfies(gender);

