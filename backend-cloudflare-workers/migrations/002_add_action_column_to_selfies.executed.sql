-- Migration: Add action column to selfies table
-- Date: 2024
-- Description: Adds action column to track the type of action for each selfie
--              This allows different retention policies based on action type
--
-- Note: SQLite/D1 doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN.
-- If a column already exists, the command will fail with "duplicate column name" error.
-- The deployment script should handle this gracefully by catching and ignoring such errors.

-- Add action column
ALTER TABLE selfies ADD COLUMN action TEXT;

-- Create index for better query performance when filtering by action
CREATE INDEX IF NOT EXISTS idx_selfies_action ON selfies(action);

-- Create index for action and profile_id combination for efficient queries
CREATE INDEX IF NOT EXISTS idx_selfies_action_profile_id ON selfies(action, profile_id);
