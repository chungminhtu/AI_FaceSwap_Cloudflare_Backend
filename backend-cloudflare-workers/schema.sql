-- Database schema for Face Swap application

-- Profiles table: Store user profiles
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  device_id TEXT, -- Device identifier for searchable indexing
  user_id TEXT, -- External user ID for searchable indexing
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  preferences TEXT, -- JSON string for preferences
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Presets table: Store preset images with optional thumbnails
-- Metadata (type, sub_category, gender, position) is stored in R2 bucket path, not in DB
-- prompt_json is stored in R2 object metadata, not in D1
-- thumbnail_r2 stores JSON array of all thumbnail URLs by resolution
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  ext TEXT NOT NULL, -- File extension (e.g., 'jpg', 'png', etc.)
  thumbnail_r2 TEXT, -- JSON array of thumbnail URLs: {"webp_1x": "url", "lottie_2x": "url", ...}
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_presets_created_at ON presets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presets_thumbnail_r2 ON presets(thumbnail_r2);
CREATE INDEX IF NOT EXISTS idx_profiles_device_id ON profiles(device_id);
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);

-- Selfies table: Store uploaded selfie images
CREATE TABLE IF NOT EXISTS selfies (
  id TEXT PRIMARY KEY,
  ext TEXT NOT NULL, -- File extension (e.g., 'jpg', 'png', etc.)
  profile_id TEXT NOT NULL, -- Profile that owns this selfie
  action TEXT, -- Action type (e.g., "faceswap", "default", etc.) - determines retention policy
  filename TEXT, -- Original filename for override detection (same profile_id + filename = override)
  dimensions TEXT, -- Image dimensions in "widthxheight" format (e.g., "128x340") for WaveSpeed API
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_selfies_created_at ON selfies(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_selfies_profile_id ON selfies(profile_id);
CREATE INDEX IF NOT EXISTS idx_selfies_action ON selfies(action);
CREATE INDEX IF NOT EXISTS idx_selfies_action_profile_id ON selfies(action, profile_id);
CREATE INDEX IF NOT EXISTS idx_selfies_profile_filename ON selfies(profile_id, filename);

-- Results table: Store face swap results
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  ext TEXT NOT NULL, -- File extension (e.g., 'jpg', 'png', etc.)
  profile_id TEXT NOT NULL, -- Profile that owns this result
  action TEXT, -- Action type (e.g., "faceswap", "background", "upscaler4k", "enhance", "beauty", "filter", "restore", "aging")
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_profile_id ON results(profile_id);
CREATE INDEX IF NOT EXISTS idx_results_action ON results(action);
CREATE INDEX IF NOT EXISTS idx_results_action_profile_id ON results(action, profile_id);
