-- Migration: Complete results table migration (run after application generates new IDs)
-- This completes the migration started in 004_optimize_storage_remove_urls.sql
-- Run this AFTER the application has populated results_id_mapping and results_new

-- Step 1: Verify data exists in results_new (should be done by application)
-- SELECT COUNT(*) FROM results_new;

-- Step 2: Drop old results table
DROP TABLE IF EXISTS results;

-- Step 3: Drop mapping table
DROP TABLE IF EXISTS results_id_mapping;

-- Step 4: Rename new table
ALTER TABLE results_new RENAME TO results;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_profile_id ON results(profile_id);
