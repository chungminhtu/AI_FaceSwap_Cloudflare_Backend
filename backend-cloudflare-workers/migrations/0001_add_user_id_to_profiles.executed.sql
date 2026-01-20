-- Migration: Add user_id column to profiles table
-- This allows searching profiles by user_id in addition to profile_id and device_id
-- Run with: wrangler d1 execute faceswap-db --file=./migrations/0001_add_user_id_to_profiles.sql

-- Add user_id column (nullable to support existing records)
ALTER TABLE profiles ADD COLUMN user_id TEXT;

-- Create index for fast user_id lookups
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
