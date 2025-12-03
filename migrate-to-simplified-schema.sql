-- Migration: Simplify database schema
-- This migration:
-- 1. Removes preset_collections table
-- 2. Renames preset_images to presets
-- 3. Removes collection_id, adds preset_name and filename
-- 4. Updates results table to use preset_id instead of preset_collection_id and preset_image_id
-- 5. Removes Electron app tables

-- Step 1: Create new presets table with simplified structure
CREATE TABLE IF NOT EXISTS presets_new (
  id TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  filename TEXT NOT NULL,
  preset_name TEXT,
  prompt_json TEXT,
  gender TEXT CHECK(gender IN ('male', 'female')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 2: Migrate data from preset_images to presets_new
-- Extract filename from image_url or use a default
INSERT INTO presets_new (id, image_url, filename, preset_name, prompt_json, gender, created_at)
SELECT 
  i.id,
  i.image_url,
  SUBSTR(i.image_url, LENGTH(i.image_url) - INSTR(REVERSE(i.image_url), '/') + 2) as filename,
  COALESCE(c.name, 'Preset') as preset_name,
  i.prompt_json,
  i.gender,
  i.created_at
FROM preset_images i
LEFT JOIN preset_collections c ON i.collection_id = c.id;

-- Step 3: Drop old tables
DROP TABLE IF EXISTS preset_images;
DROP TABLE IF EXISTS preset_collections;

-- Step 4: Rename new table
ALTER TABLE presets_new RENAME TO presets;

-- Step 5: Update results table
-- First, create new results table structure
CREATE TABLE IF NOT EXISTS results_new (
  id TEXT PRIMARY KEY,
  selfie_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  result_url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (selfie_id) REFERENCES selfies(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_id) REFERENCES presets(id) ON DELETE CASCADE
);

-- Migrate results data
INSERT INTO results_new (id, selfie_id, preset_id, preset_name, result_url, created_at)
SELECT 
  r.id,
  r.selfie_id,
  r.preset_image_id as preset_id,
  r.preset_name,
  r.result_url,
  r.created_at
FROM results r;

-- Drop old results table
DROP TABLE IF EXISTS results;

-- Rename new results table
ALTER TABLE results_new RENAME TO results;

-- Step 6: Remove Electron app tables (if they exist)
DROP TABLE IF EXISTS electron_config;
DROP TABLE IF EXISTS deployment_secrets;
DROP TABLE IF EXISTS deployment_history;
DROP TABLE IF EXISTS deployments;

-- Step 7: Create indexes
CREATE INDEX IF NOT EXISTS idx_presets_created_at ON presets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presets_gender ON presets(gender);
CREATE INDEX IF NOT EXISTS idx_presets_preset_name ON presets(preset_name);
CREATE INDEX IF NOT EXISTS idx_results_preset_id ON results(preset_id);

