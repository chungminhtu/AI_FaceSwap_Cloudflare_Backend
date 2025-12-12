-- Migration 005: Complete Database Migration
-- This migration:
-- 1. Adds device_id to profiles
-- 2. Simplifies presets table (removes prompt_json, thumbnail URLs, adds thumbnail_r2)
-- 3. Migrates existing presets data (thumbnail_r2 will be NULL, can be populated later)

-- Step 1: Add device_id to profiles (if not exists)
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- Error handling for duplicate column is done by the migration runner
ALTER TABLE profiles ADD COLUMN device_id TEXT;

-- Create index for device_id
CREATE INDEX IF NOT EXISTS idx_profiles_device_id ON profiles(device_id);

-- Step 2: Migrate presets table
-- Check if presets table already has the new structure by attempting to select thumbnail_r2
-- If it fails, we need to migrate. Since SQLite doesn't support conditional DDL,
-- we'll create the new table structure and migrate data.

-- Step 2a: Create new presets table structure
CREATE TABLE IF NOT EXISTS presets_new (
  id TEXT PRIMARY KEY,
  ext TEXT NOT NULL,
  thumbnail_r2 TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 2b: Migrate existing presets data
-- Copy data from old presets table to new one
-- This handles both old structure (with thumbnail_url columns) and new structure (with thumbnail_r2)
INSERT INTO presets_new (id, ext, thumbnail_r2, created_at)
SELECT 
  id,
  COALESCE(ext, 'jpg') as ext,
  NULL as thumbnail_r2, -- Will be populated later via application logic if needed (complex URL parsing)
  COALESCE(created_at, unixepoch()) as created_at
FROM presets
WHERE NOT EXISTS (
  SELECT 1 FROM presets_new WHERE presets_new.id = presets.id
);

-- Step 2c: Drop old presets table and rename new one
-- This is safe because we've already copied the data
DROP TABLE presets;
ALTER TABLE presets_new RENAME TO presets;

-- Step 2d: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_presets_created_at ON presets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presets_thumbnail_r2 ON presets(thumbnail_r2);
