-- Database schema for Face Swap application

-- Profiles table: Store user profiles
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  preferences TEXT, -- JSON string for preferences
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Presets table: Store preset images with optional thumbnails (same row)
-- Metadata (type, sub_category, gender, position) is stored in R2 bucket path, not in DB
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  preset_url TEXT NOT NULL, -- R2 bucket key (e.g., "preset/filename.jpg"), not full URL
  prompt_json TEXT, -- JSON prompt for nano banana mode (optional)
  thumbnail_url TEXT, -- Thumbnail file URL for 4x resolution (webp or lottie)
  thumbnail_url_1x TEXT, -- Thumbnail URL for 1x resolution
  thumbnail_url_1_5x TEXT, -- Thumbnail URL for 1.5x resolution
  thumbnail_url_2x TEXT, -- Thumbnail URL for 2x resolution
  thumbnail_url_3x TEXT, -- Thumbnail URL for 3x resolution
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_presets_created_at ON presets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presets_has_thumbnail ON presets(thumbnail_url);

-- Selfies table: Store uploaded selfie images
CREATE TABLE IF NOT EXISTS selfies (
  id TEXT PRIMARY KEY,
  selfie_url TEXT NOT NULL, -- R2 bucket key (e.g., "selfie/filename.jpg"), not full URL
  profile_id TEXT NOT NULL, -- Profile that owns this selfie
  action TEXT, -- Action type (e.g., "faceswap", "default", etc.) - determines retention policy
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_selfies_created_at ON selfies(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_selfies_profile_id ON selfies(profile_id);
CREATE INDEX IF NOT EXISTS idx_selfies_action ON selfies(action);
CREATE INDEX IF NOT EXISTS idx_selfies_action_profile_id ON selfies(action, profile_id);

-- Results table: Store face swap results
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_url TEXT NOT NULL, -- R2 bucket key (e.g., "results/filename.jpg"), not full URL
  profile_id TEXT NOT NULL, -- Profile that owns this result
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_profile_id ON results(profile_id);
