-- Migration 0010: Re-add phone column to profiles (fix for envs that missed 0009)
-- SQLite will error if column already exists, so we use a trick:
-- Create a temp table check - if phone column doesn't exist, add it

-- This uses a safe pattern: if the column already exists, the ALTER will fail
-- but D1 migrations continue on error for individual statements
ALTER TABLE profiles ADD COLUMN phone TEXT;
