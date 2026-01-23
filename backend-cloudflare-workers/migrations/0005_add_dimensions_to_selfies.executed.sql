-- backend-cloudflare-workers/migrations/0005_add_dimensions_to_selfies.sql
-- Add dimensions column to selfies table for storing image dimensions
-- Format: "widthxheight" (e.g., "128x340")
-- Nullable for backwards compatibility with existing selfies

ALTER TABLE selfies ADD COLUMN dimensions TEXT;
