# Migration 004: Optimize Storage - Remove URL Columns

This migration optimizes D1 storage by removing redundant URL columns and using ID + extension pattern.

## Migration Steps

### Step 1: Run SQL Migration (Selfies & Presets)
```bash
wrangler d1 execute <database-name> --remote --file=migrations/004_optimize_storage_remove_urls.sql
```

This will:
- Add `ext` column to all tables
- Extract extensions from existing URLs
- Remove `selfie_url` and `preset_url` columns
- Keep `results` table with ext column added (ID migration comes next)

### Step 2: Run Application Migration for Results (Optional)
If you have existing results with INTEGER IDs, you need to migrate them to TEXT (nanoid).

Create a temporary migration script or use the Worker to:
1. Read all results from old table
2. Generate nanoid for each
3. Insert into `results_id_mapping` and `results_new`

Example migration code:
```typescript
const results = await DB.prepare('SELECT id, ext, profile_id, created_at FROM results').all();
for (const result of results.results) {
  const newId = nanoid();
  await DB.prepare('INSERT INTO results_id_mapping (old_id, new_id) VALUES (?, ?)')
    .bind(result.id, newId).run();
  await DB.prepare('INSERT INTO results_new (id, ext, profile_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(newId, result.ext, result.profile_id, result.created_at).run();
}
```

### Step 3: Complete Results Migration
```bash
wrangler d1 execute <database-name> --remote --file=migrations/004_optimize_storage_remove_urls_complete.sql
```

This will:
- Drop old `results` table
- Rename `results_new` to `results`
- Recreate indexes

## Backward Compatibility

The new code supports both old and new formats:
- If `ext` column exists, use new format
- If URL columns exist, extract extension from URL
- New uploads always use nanoid + ext format

## Rollback

If you need to rollback:
1. Restore from backup
2. Or manually add back URL columns and repopulate from R2 keys

## Notes

- Selfies and presets migration is straightforward (just column changes)
- Results migration requires ID conversion (INTEGER → TEXT)
- For new databases, just run the schema.sql file directly
- For existing databases, run migrations in order
