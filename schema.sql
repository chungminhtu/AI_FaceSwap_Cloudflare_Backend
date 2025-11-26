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

-- Electron app configuration tables
CREATE TABLE IF NOT EXISTS electron_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gcp_project_id TEXT,
  gcp_account_email TEXT,
  cf_account_id TEXT,
  cf_email TEXT,
  worker_name TEXT,
  pages_project_name TEXT,
  status TEXT DEFAULT 'idle',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS deployment_secrets (
  deployment_id TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  secret_value TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (deployment_id, secret_key),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployment_history (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  end_time INTEGER,
  status TEXT NOT NULL,
  error_message TEXT,
  worker_url TEXT,
  pages_url TEXT,
  history_data TEXT, -- JSON data of the full deployment history
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

-- Indexes for electron app tables
CREATE INDEX IF NOT EXISTS idx_electron_config_key ON electron_config(key);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_deployments_created_at ON deployments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_secrets_deployment_id ON deployment_secrets(deployment_id);
CREATE INDEX IF NOT EXISTS idx_deployment_history_deployment_id ON deployment_history(deployment_id);
CREATE INDEX IF NOT EXISTS idx_deployment_history_timestamp ON deployment_history(timestamp DESC);

