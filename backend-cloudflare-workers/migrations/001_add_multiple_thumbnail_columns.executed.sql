-- Migration: Add multiple thumbnail resolution columns to presets table
-- Date: 2024
-- Description: Adds thumbnail_url_1x, thumbnail_url_1_5x, thumbnail_url_2x, thumbnail_url_3x, thumbnail_url_4x columns
--              to support multiple resolution thumbnails for presets
--
-- Note: SQLite/D1 doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN.
-- If a column already exists, the command will fail with "duplicate column name" error.
-- The deployment script should handle this gracefully by catching and ignoring such errors.

-- Add thumbnail_url_1x column
ALTER TABLE presets ADD COLUMN thumbnail_url_1x TEXT;

-- Add thumbnail_url_1_5x column  
ALTER TABLE presets ADD COLUMN thumbnail_url_1_5x TEXT;

-- Add thumbnail_url_2x column
ALTER TABLE presets ADD COLUMN thumbnail_url_2x TEXT;

-- Add thumbnail_url_3x column
ALTER TABLE presets ADD COLUMN thumbnail_url_3x TEXT;

-- Add thumbnail_url_4x column
ALTER TABLE presets ADD COLUMN thumbnail_url_4x TEXT;

-- Migrate existing thumbnail_url to thumbnail_url_1x for backward compatibility
-- This is safe to run multiple times (idempotent)
UPDATE presets SET thumbnail_url_1x = thumbnail_url WHERE thumbnail_url IS NOT NULL AND (thumbnail_url_1x IS NULL OR thumbnail_url_1x = '');
