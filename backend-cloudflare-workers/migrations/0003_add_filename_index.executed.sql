-- Add index for filename lookup on selfies table

CREATE INDEX IF NOT EXISTS idx_selfies_profile_filename ON selfies(profile_id, filename);
