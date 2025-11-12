-- Database schema for Face Swap application

-- Preset collections table: Store preset collection metadata
CREATE TABLE IF NOT EXISTS preset_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Preset images table: Store individual images within collections
CREATE TABLE IF NOT EXISTS preset_images (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (collection_id) REFERENCES preset_collections(id) ON DELETE CASCADE
);

-- Results table: Store face swap results
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  preset_collection_id TEXT NOT NULL,
  preset_image_id TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  result_url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (preset_collection_id) REFERENCES preset_collections(id),
  FOREIGN KEY (preset_image_id) REFERENCES preset_images(id)
);

-- Migration: Move existing data from presets table to new structure
INSERT OR IGNORE INTO preset_collections (id, name, created_at)
SELECT
  'collection_' || id as id,
  name,
  created_at
FROM presets;

INSERT OR IGNORE INTO preset_images (id, collection_id, image_url, created_at)
SELECT
  'image_' || id as id,
  'collection_' || id as collection_id,
  image_url,
  created_at
FROM presets;

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_preset_collections_created_at ON preset_collections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_preset_images_collection_id ON preset_images(collection_id);
CREATE INDEX IF NOT EXISTS idx_preset_images_created_at ON preset_images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_preset_collection_id ON results(preset_collection_id);

