-- Migration 0011: Ensure phone column exists on ALL environments
-- Safe to re-run: SQLite will error "duplicate column" if already exists, which is harmless
ALTER TABLE profiles ADD COLUMN phone TEXT;
