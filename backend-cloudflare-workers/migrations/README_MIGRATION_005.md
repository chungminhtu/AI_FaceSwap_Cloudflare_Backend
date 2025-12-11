# Migration 005: Simplify Presets and Add Device ID

This migration simplifies the presets table structure and adds device_id to profiles.

## Changes

### Presets Table
- **Removed**: `prompt_json` (moved to R2 metadata only)
- **Removed**: `thumbnail_url`, `thumbnail_url_1x`, `thumbnail_url_1_5x`, `thumbnail_url_2x`, `thumbnail_url_3x`
- **Added**: `thumbnail_r2` (stores R2 key for thumbnail)

### Profiles Table
- **Changed**: `id` generation from custom format to `nanoid(16)` (16 characters, no hyphens)
- **Added**: `device_id` column (indexed, nullable, searchable)

### All Tables
- **Changed**: All ID generation from `nanoid()` (21 chars) to `nanoid(16)` (16 chars)

## Migration Steps

### Step 1: SQL Migration
```bash
wrangler d1 execute faceswap-db --remote --file=migrations/005_simplify_presets_add_device_id.sql
```

This will:
1. Add `device_id` column to profiles
2. Create new presets table structure
3. Migrate existing presets data (thumbnail_r2 will be NULL initially)

### Step 2: Application-Level Migrations (Optional)

#### 2a. Migrate Thumbnail URLs to R2 Keys
If you have existing thumbnail URLs that need to be migrated to R2 keys, run:
```typescript
// This requires a backup of old presets table with thumbnail URLs
// See migrations/005_migrate_thumbnail_urls_to_r2_keys.ts for implementation
```

#### 2b. Migrate Profile IDs to nanoid(16)
If you have existing profiles with old ID format, run:
```typescript
import { migrateProfileIdsToNanoid } from './migrations/005_migrate_profile_ids_to_nanoid';

await migrateProfileIdsToNanoid({ DB });
```

**Warning**: This will change all profile IDs and update foreign keys in `selfies` and `results` tables. Make sure to:
- Backup your database first
- Update any external references to profile IDs
- Test thoroughly before running in production

## Backward Compatibility

### API Compatibility
- **Presets API**: Still returns `thumbnail_url` (reconstructed from `thumbnail_r2`)
- **Profiles API**: Returns `device_id` (may be null for existing profiles)
- **Profile Creation**: Accepts `device_id` in request body or `x-device-id` header

### Frontend Compatibility
- Frontend automatically generates and sends `device_id` on profile creation
- Frontend handles single `thumbnail_url` field (backward compatible)

## Rollback

If you need to rollback:

1. Restore from database backup
2. Revert code changes
3. Run previous migration scripts

## Notes

- `prompt_json` is now **only** stored in R2 object metadata, not in D1
- Thumbnail URLs are reconstructed from R2 keys on-the-fly
- Profile IDs are now consistently 16 characters (nanoid)
- `device_id` allows searching/filtering profiles by device
