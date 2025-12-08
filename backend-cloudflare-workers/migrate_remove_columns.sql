-- Migration script to remove selfie_id and preset_id from results table
-- Run this with: wrangler d1 execute YOUR_DATABASE_NAME --remote --file=backend-cloudflare-workers/migrate_remove_columns.sql
-- This script is idempotent - it can be run multiple times safely

-- Step 1: Check if results_new table already exists (from previous failed migration) and drop it
DROP TABLE IF EXISTS results_new;

-- Step 2: Create new table with correct structure (without selfie_id and preset_id)
CREATE TABLE results_new (
  id TEXT PRIMARY KEY,
  preset_name TEXT NOT NULL,
  result_url TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 3: Copy data from old table (only copy columns that exist in new structure)
-- This will work even if old table has selfie_id/preset_id or doesn't have them
INSERT INTO results_new (id, preset_name, result_url, profile_id, created_at)
SELECT 
  id, 
  COALESCE(preset_name, 'Unnamed') as preset_name,
  result_url, 
  profile_id, 
  COALESCE(created_at, unixepoch()) as created_at
FROM results;

-- Step 4: Drop old table
DROP TABLE IF EXISTS results;

-- Step 5: Rename new table
ALTER TABLE results_new RENAME TO results;

-- Step 6: Drop old indexes if they exist (ignore errors if they don't exist)
-- Step 7: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_profile_id ON results(profile_id);
