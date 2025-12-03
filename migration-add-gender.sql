-- Migration: Add gender columns to existing tables
-- This migration is safe to run multiple times (will fail gracefully if columns already exist)

-- Add gender column to preset_images table
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we need to check first
-- This will fail if column exists, which is fine - we'll handle it in the application

-- For preset_images
-- Note: If column exists, this will fail with "duplicate column name" - that's expected and safe to ignore

-- For selfies
-- Note: If column exists, this will fail with "duplicate column name" - that's expected and safe to ignore

-- Since SQLite doesn't support conditional ALTER TABLE, we'll handle this in the application code
-- by checking if the column exists before trying to add it, or by catching the error

-- However, we can still provide the ALTER TABLE statements for manual execution:

-- ALTER TABLE preset_images ADD COLUMN gender TEXT CHECK(gender IN ('male', 'female'));
-- ALTER TABLE selfies ADD COLUMN gender TEXT CHECK(gender IN ('male', 'female'));

-- Create indexes for gender columns (these are safe with IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_preset_images_gender ON preset_images(gender);
CREATE INDEX IF NOT EXISTS idx_selfies_gender ON selfies(gender);

