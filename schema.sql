-- Database schema for Face Swap application

-- Presets table: Store preset images (simplified - no collections)
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  filename TEXT NOT NULL,
  preset_name TEXT, -- Optional name for the preset
  prompt_json TEXT, -- JSON prompt for nano banana mode (optional)
  gender TEXT CHECK(gender IN ('male', 'female')), -- Optional gender classification
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Selfies table: Store uploaded selfie images
CREATE TABLE IF NOT EXISTS selfies (
  id TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  filename TEXT NOT NULL,
  gender TEXT CHECK(gender IN ('male', 'female')), -- Optional gender classification
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Results table: Store face swap results
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  selfie_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  result_url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (selfie_id) REFERENCES selfies(id) ON DELETE CASCADE,
  FOREIGN KEY (preset_id) REFERENCES presets(id) ON DELETE CASCADE
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_presets_created_at ON presets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presets_gender ON presets(gender);
CREATE INDEX IF NOT EXISTS idx_presets_preset_name ON presets(preset_name);
CREATE INDEX IF NOT EXISTS idx_selfies_created_at ON selfies(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_selfies_gender ON selfies(gender);
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_selfie_id ON results(selfie_id);
CREATE INDEX IF NOT EXISTS idx_results_preset_id ON results(preset_id);
