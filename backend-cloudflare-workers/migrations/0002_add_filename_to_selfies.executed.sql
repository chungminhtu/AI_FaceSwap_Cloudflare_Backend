-- Add filename column to selfies table for override detection
-- Same (profile_id, filename) = override existing selfie instead of creating new

ALTER TABLE selfies ADD COLUMN filename TEXT;
