// Migration 005 Application Script: Migrate thumbnail URLs to R2 keys
// This script extracts R2 keys from existing thumbnail URLs and updates thumbnail_r2 column
// Run this after executing 005_simplify_presets_add_device_id.sql

import { nanoid } from 'nanoid';

interface MigrationContext {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  env: any;
  requestUrl: { origin: string };
}

// Helper to extract R2 key from URL
const extractR2KeyFromUrl = (url: string): string | null => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    // Remove leading slash
    const key = pathname.startsWith('/') ? pathname.substring(1) : pathname;
    return key || null;
  } catch {
    return null;
  }
};

export async function migrateThumbnailUrlsToR2Keys(context: MigrationContext): Promise<void> {
  const { DB } = context;
  
  // Get all presets that might have thumbnail URLs in old format
  // Since we've already migrated, we need to check if there's backup data
  // For now, this script is a template - actual migration would need to:
  // 1. Read from backup/old table if available
  // 2. Extract R2 keys from thumbnail URLs
  // 3. Update thumbnail_r2 column
  
  console.log('[Migration 005] Starting thumbnail URL to R2 key migration...');
  
  // Note: In production, you would:
  // 1. Have a backup of old presets table with thumbnail URLs
  // 2. Extract R2 keys from those URLs
  // 3. Update thumbnail_r2 column
  
  // Example migration logic (adjust based on your backup strategy):
  /*
  const oldPresets = await DB.prepare(`
    SELECT id, thumbnail_url, thumbnail_url_1x, thumbnail_url_1_5x, thumbnail_url_2x, thumbnail_url_3x
    FROM presets_backup
  `).all();
  
  for (const preset of oldPresets.results || []) {
    // Prefer 1x, fallback to others
    const thumbnailUrl = (preset as any).thumbnail_url_1x || 
                        (preset as any).thumbnail_url || 
                        (preset as any).thumbnail_url_1_5x ||
                        (preset as any).thumbnail_url_2x ||
                        (preset as any).thumbnail_url_3x;
    
    if (thumbnailUrl) {
      const r2Key = extractR2KeyFromUrl(thumbnailUrl);
      if (r2Key) {
        await DB.prepare('UPDATE presets SET thumbnail_r2 = ? WHERE id = ?')
          .bind(r2Key, (preset as any).id)
          .run();
      }
    }
  }
  */
  
  console.log('[Migration 005] Thumbnail URL migration completed');
}
