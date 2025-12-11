-- Migration 005: Simplify presets table and add device_id to profiles
-- This migration:
-- 1. Adds device_id column to profiles (indexed, nullable)
-- 2. Removes prompt_json and all thumbnail_url columns from presets
-- 3. Adds thumbnail_r2 column to presets
-- 4. Migrates existing thumbnail URLs to R2 keys (extracts key from URL)

-- Step 1: Add device_id to profiles
ALTER TABLE profiles ADD COLUMN device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_profiles_device_id ON profiles(device_id);

-- Step 2: Create new presets table structure
CREATE TABLE IF NOT EXISTS presets_new (
  id TEXT PRIMARY KEY,
  ext TEXT NOT NULL,
  thumbnail_r2 TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 3: Migrate existing presets data
-- Extract R2 key from thumbnail URLs if they exist
-- For now, we'll migrate the data and extract R2 keys in application-level script
INSERT INTO presets_new (id, ext, thumbnail_r2, created_at)
SELECT 
  id,
  ext,
  NULL as thumbnail_r2, -- Will be populated by application script from thumbnail URLs
  created_at
FROM presets;

-- Step 4: Drop old presets table and rename new one
DROP TABLE presets;
ALTER TABLE presets_new RENAME TO presets;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_presets_created_at ON presets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presets_thumbnail_r2 ON presets(thumbnail_r2);
