-- Thumbnails table: Store thumbnail metadata (webp and lottie files)
CREATE TABLE IF NOT EXISTS thumbnails (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- filters, face-swap, packs (extensible, uses hyphens)
  sub_category TEXT NOT NULL, -- e.g., wedding, portrait, autumn, etc.
  gender TEXT NOT NULL, -- female, male, others, both, many, pet (extensible)
  position INTEGER NOT NULL, -- Position number from filename
  file_format TEXT NOT NULL CHECK(file_format IN ('webp', 'lottie')),
  resolution TEXT NOT NULL, -- 1x, 1.5x, 2x, 3x, 4x
  file_url TEXT NOT NULL, -- Full URL to the file in R2
  r2_key TEXT NOT NULL, -- R2 storage key
  filename TEXT NOT NULL, -- Original filename
  preset_id TEXT, -- Link to preset (1:1 relationship)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_thumbnails_preset_id ON thumbnails(preset_id);
CREATE INDEX IF NOT EXISTS idx_thumbnails_lookup ON thumbnails(type, sub_category, gender, position);
CREATE INDEX IF NOT EXISTS idx_thumbnails_created_at ON thumbnails(created_at DESC);
