-- Database schema for Face Swap application

-- Presets table: Store preset images metadata
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Results table: Store face swap results
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  result_url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (preset_id) REFERENCES presets(id)
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_presets_created_at ON presets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_preset_id ON results(preset_id);

