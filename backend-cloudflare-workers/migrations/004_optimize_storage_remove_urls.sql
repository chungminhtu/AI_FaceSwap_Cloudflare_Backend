-- Migration: Optimize storage by removing URL columns and using ID + ext
-- Date: 2024
-- Description:
--   1. Add ext column to selfies, presets, and results tables
--   2. Extract file extension from existing URL columns
--   3. Change results.id from INTEGER to TEXT (nanoid)
--   4. Remove selfie_url, preset_url, result_url columns
--
-- Note: This migration requires careful handling of existing data

-- ============================================
-- SELFIES TABLE MIGRATION
-- ============================================

-- Step 1: Add ext column to selfies
ALTER TABLE selfies ADD COLUMN ext TEXT;

-- Step 2: Extract extension from selfie_url and populate ext
-- Extract extension from patterns like "selfie/filename.jpg" or "selfie_123.jpg"
UPDATE selfies
SET ext = CASE
  WHEN selfie_url LIKE '%.jpg' OR selfie_url LIKE '%.JPG' THEN 'jpg'
  WHEN selfie_url LIKE '%.jpeg' OR selfie_url LIKE '%.JPEG' THEN 'jpg'
  WHEN selfie_url LIKE '%.png' OR selfie_url LIKE '%.PNG' THEN 'png'
  WHEN selfie_url LIKE '%.webp' OR selfie_url LIKE '%.WEBP' THEN 'webp'
  WHEN selfie_url LIKE '%.gif' OR selfie_url LIKE '%.GIF' THEN 'gif'
  ELSE 'jpg'
END
WHERE ext IS NULL;

-- Step 3: Set default for any remaining NULL values
UPDATE selfies SET ext = 'jpg' WHERE ext IS NULL;

-- Step 4: Make ext NOT NULL (after populating)
-- SQLite doesn't support ALTER COLUMN, so we'll recreate the table
CREATE TABLE IF NOT EXISTS selfies_new (
  id TEXT PRIMARY KEY,
  ext TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  action TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Step 5: Copy data to new table
INSERT INTO selfies_new (id, ext, profile_id, action, created_at)
SELECT id, ext, profile_id, action, created_at
FROM selfies;

-- Step 6: Drop old table and rename
DROP TABLE IF EXISTS selfies;
ALTER TABLE selfies_new RENAME TO selfies;

-- Step 7: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_selfies_created_at ON selfies(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_selfies_profile_id ON selfies(profile_id);
CREATE INDEX IF NOT EXISTS idx_selfies_action ON selfies(action);
CREATE INDEX IF NOT EXISTS idx_selfies_action_profile_id ON selfies(action, profile_id);

-- ============================================
-- PRESETS TABLE MIGRATION
-- ============================================

-- Step 1: Add ext column to presets
ALTER TABLE presets ADD COLUMN ext TEXT;

-- Step 2: Extract extension from preset_url
UPDATE presets
SET ext = CASE
  WHEN preset_url LIKE '%.jpg' OR preset_url LIKE '%.JPG' THEN 'jpg'
  WHEN preset_url LIKE '%.jpeg' OR preset_url LIKE '%.JPEG' THEN 'jpg'
  WHEN preset_url LIKE '%.png' OR preset_url LIKE '%.PNG' THEN 'png'
  WHEN preset_url LIKE '%.webp' OR preset_url LIKE '%.WEBP' THEN 'webp'
  WHEN preset_url LIKE '%.gif' OR preset_url LIKE '%.GIF' THEN 'gif'
  ELSE 'jpg'
END
WHERE ext IS NULL;

-- Step 3: Set default for any remaining NULL values
UPDATE presets SET ext = 'jpg' WHERE ext IS NULL;

-- Step 4: Recreate table without preset_url
CREATE TABLE IF NOT EXISTS presets_new (
  id TEXT PRIMARY KEY,
  ext TEXT NOT NULL,
  prompt_json TEXT,
  thumbnail_url TEXT,
  thumbnail_url_1x TEXT,
  thumbnail_url_1_5x TEXT,
  thumbnail_url_2x TEXT,
  thumbnail_url_3x TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 5: Copy data to new table
INSERT INTO presets_new (id, ext, prompt_json, thumbnail_url, thumbnail_url_1x, thumbnail_url_1_5x, thumbnail_url_2x, thumbnail_url_3x, created_at)
SELECT id, ext, prompt_json, thumbnail_url, thumbnail_url_1x, thumbnail_url_1_5x, thumbnail_url_2x, thumbnail_url_3x, created_at
FROM presets;

-- Step 6: Drop old table and rename
DROP TABLE IF EXISTS presets;
ALTER TABLE presets_new RENAME TO presets;

-- Step 7: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_presets_created_at ON presets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presets_has_thumbnail ON presets(thumbnail_url);

-- ============================================
-- RESULTS TABLE MIGRATION
-- ============================================
-- NOTE: Results table migration is complex because we're changing ID from INTEGER to TEXT
-- This requires generating new nanoid IDs. The migration is split into parts:
-- 1. SQL migration (this file) - adds ext column and prepares structure
-- 2. Application migration - generates nanoid IDs and migrates data
-- 3. Complete migration - finalizes the table structure

-- Step 1: Add ext column to results
ALTER TABLE results ADD COLUMN ext TEXT;

-- Step 2: Extract extension from result_url
UPDATE results
SET ext = CASE
  WHEN result_url LIKE '%.jpg' OR result_url LIKE '%.JPG' THEN 'jpg'
  WHEN result_url LIKE '%.jpeg' OR result_url LIKE '%.JPEG' THEN 'jpg'
  WHEN result_url LIKE '%.png' OR result_url LIKE '%.PNG' THEN 'png'
  WHEN result_url LIKE '%.webp' OR result_url LIKE '%.WEBP' THEN 'webp'
  WHEN result_url LIKE '%.gif' OR result_url LIKE '%.GIF' THEN 'gif'
  ELSE 'jpg'
END
WHERE ext IS NULL;

-- Step 3: Set default for any remaining NULL values
UPDATE results SET ext = 'jpg' WHERE ext IS NULL;

-- Step 4: Create mapping table for ID conversion
CREATE TABLE IF NOT EXISTS results_id_mapping (
  old_id INTEGER PRIMARY KEY,
  new_id TEXT NOT NULL UNIQUE
);

-- Step 5: Create new results table structure (will be populated by application)
CREATE TABLE IF NOT EXISTS results_new (
  id TEXT PRIMARY KEY,
  ext TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================
-- NEXT STEPS (Application-level):
-- 1. Run migration script to generate nanoid IDs and populate results_new
-- 2. Run 004_optimize_storage_remove_urls_complete.sql to finalize
-- ============================================
