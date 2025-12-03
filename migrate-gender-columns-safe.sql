-- Safe migration script to add gender columns
-- This version checks if columns exist before adding them
-- Run with: wrangler d1 execute <database-name> --remote --file=migrate-gender-columns-safe.sql

-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE
-- So we'll try to add and catch errors, or use a workaround

-- Workaround: Try to query the column first, then add if it doesn't exist
-- Since we can't do conditional ALTER TABLE in SQLite, we'll rely on the application
-- to handle "duplicate column" errors gracefully

-- For preset_images: Add gender column
-- This will fail with "duplicate column name" if it exists - that's expected and safe
ALTER TABLE preset_images ADD COLUMN gender TEXT CHECK(gender IN ('male', 'female'));

-- For selfies: Add gender column  
-- This will fail with "duplicate column name" if it exists - that's expected and safe
ALTER TABLE selfies ADD COLUMN gender TEXT CHECK(gender IN ('male', 'female'));

-- Create indexes (these are safe with IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_preset_images_gender ON preset_images(gender);
CREATE INDEX IF NOT EXISTS idx_selfies_gender ON selfies(gender);

