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
  prompt_json TEXT, -- JSON prompt for nano banana mode (optional)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (collection_id) REFERENCES preset_collections(id) ON DELETE CASCADE
);

-- Selfies table: Store uploaded selfie images
CREATE TABLE IF NOT EXISTS selfies (
  id TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Results table: Store face swap results
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  selfie_id TEXT NOT NULL,
  preset_collection_id TEXT NOT NULL,
  preset_image_id TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  result_url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (selfie_id) REFERENCES selfies(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_collection_id) REFERENCES preset_collections(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_image_id) REFERENCES preset_images(id) ON DELETE CASCADE
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_preset_collections_created_at ON preset_collections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_preset_images_collection_id ON preset_images(collection_id);
CREATE INDEX IF NOT EXISTS idx_preset_images_created_at ON preset_images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_selfies_created_at ON selfies(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_selfie_id ON results(selfie_id);
CREATE INDEX IF NOT EXISTS idx_results_preset_collection_id ON results(preset_collection_id);

