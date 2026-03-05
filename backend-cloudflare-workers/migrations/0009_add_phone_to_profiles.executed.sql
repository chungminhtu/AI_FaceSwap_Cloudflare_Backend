-- Migration 0009: Add phone column to profiles table
-- Required for secure profile deletion (profile_id + user_id + email/phone verification)

ALTER TABLE profiles ADD COLUMN phone TEXT;
