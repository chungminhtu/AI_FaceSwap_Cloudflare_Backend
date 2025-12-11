-- Migration: Update results table structure
-- Date: 2024
-- Description: 
--   1. Remove columns: preset_name, preset_id, selfie_id
--   2. Change id from TEXT to INTEGER PRIMARY KEY (auto-increment)
--   3. result_url will store only bucket key (not full URL)
--
-- Note: SQLite/D1 doesn't support DROP COLUMN directly, so we recreate the table.
-- Old data is copied as-is; backend code will handle URL extraction when reading.

-- Step 1: Create new results table with correct structure
CREATE TABLE IF NOT EXISTS results_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_url TEXT NOT NULL, -- R2 bucket key (e.g., "results/filename.jpg"), not full URL
  profile_id TEXT NOT NULL, -- Profile that owns this result
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 2: Copy data from old table (keep URLs as-is, backend will extract keys when reading)
INSERT INTO results_new (result_url, profile_id, created_at)
SELECT result_url, profile_id, created_at
FROM results;

-- Step 3: Drop old table
DROP TABLE IF EXISTS results;

-- Step 4: Rename new table
ALTER TABLE results_new RENAME TO results;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_profile_id ON results(profile_id);
