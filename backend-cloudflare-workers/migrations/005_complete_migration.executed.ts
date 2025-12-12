// Migration 005: Complete Database Migration
// This script handles all database migrations:
// 1. Adds device_id to profiles
// 2. Simplifies presets table (removes prompt_json, thumbnail URLs, adds thumbnail_r2)
// 3. Optionally migrates profile IDs to nanoid(16)
// 4. Optionally migrates thumbnail URLs to R2 keys

import { nanoid } from 'nanoid';

interface MigrationContext {
  DB: D1Database;
  R2_BUCKET?: R2Bucket;
  env?: any;
}

// Helper to extract R2 key from URL
const extractR2KeyFromUrl = (url: string): string | null => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const key = pathname.startsWith('/') ? pathname.substring(1) : pathname;
    return key || null;
  } catch {
    return null;
  }
};

export async function runCompleteMigration(context: MigrationContext): Promise<void> {
  const { DB, R2_BUCKET, env } = context;
  
  console.log('[Migration 005] Starting complete database migration...');
  
  try {
    // Step 1: Add device_id to profiles (if not exists)
    console.log('[Migration 005] Step 1: Adding device_id column to profiles...');
    try {
      await DB.prepare('ALTER TABLE profiles ADD COLUMN device_id TEXT').run();
      console.log('[Migration 005] ✓ device_id column added to profiles');
    } catch (error: any) {
      if (error?.message?.includes('duplicate column name') || error?.message?.includes('already exists')) {
        console.log('[Migration 005] ✓ device_id column already exists');
      } else {
        throw error;
      }
    }
    
    // Create index for device_id
    try {
      await DB.prepare('CREATE INDEX IF NOT EXISTS idx_profiles_device_id ON profiles(device_id)').run();
      console.log('[Migration 005] ✓ device_id index created');
    } catch (error: any) {
      console.warn('[Migration 005] Warning: Could not create device_id index:', error?.message);
    }
    
    // Step 2: Check if presets table needs migration
    console.log('[Migration 005] Step 2: Checking presets table structure...');
    const presetsTableInfo = await DB.prepare("PRAGMA table_info(presets)").all();
    const presetsColumns = (presetsTableInfo.results || []).map((row: any) => row.name);
    
    const hasThumbnailR2 = presetsColumns.includes('thumbnail_r2');
    const hasOldThumbnailColumns = presetsColumns.some(col => 
      ['thumbnail_url', 'thumbnail_url_1x', 'thumbnail_url_1_5x', 'thumbnail_url_2x', 'thumbnail_url_3x'].includes(col)
    );
    const hasPromptJson = presetsColumns.includes('prompt_json');
    
    if (!hasThumbnailR2 || hasOldThumbnailColumns || hasPromptJson) {
      console.log('[Migration 005] Step 2: Migrating presets table...');
      
      // Step 2a: Create new presets table
      await DB.prepare(`
        CREATE TABLE IF NOT EXISTS presets_new (
          id TEXT PRIMARY KEY,
          ext TEXT NOT NULL,
          thumbnail_r2 TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `).run();
      
      // Step 2b: Migrate existing data
      // Try to extract thumbnail_r2 from existing thumbnail URLs
      const existingPresets = await DB.prepare(`
        SELECT id, ext, 
               thumbnail_url, thumbnail_url_1x, thumbnail_url_1_5x, thumbnail_url_2x, thumbnail_url_3x,
               created_at
        FROM presets
      `).all();
      
      console.log(`[Migration 005] Migrating ${existingPresets.results?.length || 0} presets...`);
      
      for (const preset of existingPresets.results || []) {
        const row = preset as any;
        
        // Extract thumbnail_r2 from existing thumbnail URLs (prefer 1x, fallback to others)
        let thumbnailR2: string | null = null;
        const thumbnailUrl = row.thumbnail_url_1x || row.thumbnail_url || 
                            row.thumbnail_url_1_5x || row.thumbnail_url_2x || 
                            row.thumbnail_url_3x;
        
        if (thumbnailUrl) {
          thumbnailR2 = extractR2KeyFromUrl(thumbnailUrl);
        }
        
        // Insert into new table
        await DB.prepare(`
          INSERT INTO presets_new (id, ext, thumbnail_r2, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(
          row.id,
          row.ext || 'jpg',
          thumbnailR2,
          row.created_at || Math.floor(Date.now() / 1000)
        ).run();
      }
      
      // Step 2c: Replace old table
      await DB.prepare('DROP TABLE presets').run();
      await DB.prepare('ALTER TABLE presets_new RENAME TO presets').run();
      
      // Step 2d: Recreate indexes
      await DB.prepare('CREATE INDEX IF NOT EXISTS idx_presets_created_at ON presets(created_at DESC)').run();
      await DB.prepare('CREATE INDEX IF NOT EXISTS idx_presets_thumbnail_r2 ON presets(thumbnail_r2)').run();
      
      console.log('[Migration 005] ✓ Presets table migrated successfully');
    } else {
      console.log('[Migration 005] ✓ Presets table already migrated');
    }
    
    // Step 3: Optionally migrate profile IDs to nanoid(16)
    console.log('[Migration 005] Step 3: Checking profile IDs...');
    const profiles = await DB.prepare('SELECT id FROM profiles LIMIT 10').all();
    
    if (profiles.results && profiles.results.length > 0) {
      const sampleProfile = profiles.results[0] as any;
      const sampleId = sampleProfile.id;
      
      // Check if IDs need migration (not 16 chars or contains non-alphanumeric)
      const needsMigration = sampleId.length !== 16 || /[^a-zA-Z0-9]/.test(sampleId);
      
      if (needsMigration) {
        console.log('[Migration 005] Step 3: Migrating profile IDs to nanoid(16)...');
        console.log('[Migration 005] WARNING: This will change all profile IDs. Make sure you have a backup!');
        
        // Get all profiles
        const allProfiles = await DB.prepare('SELECT id, device_id, name, email, avatar_url, preferences, created_at, updated_at FROM profiles').all();
        
        // Create mapping
        const idMappings: Array<{ oldId: string; newId: string }> = [];
        for (const profile of allProfiles.results || []) {
          const oldId = (profile as any).id;
          if (oldId.length !== 16 || /[^a-zA-Z0-9]/.test(oldId)) {
            const newId = nanoid(16);
            idMappings.push({ oldId, newId });
          }
        }
        
        if (idMappings.length > 0) {
          console.log(`[Migration 005] Migrating ${idMappings.length} profile IDs...`);
          
          // Update foreign keys in selfies
          for (const mapping of idMappings) {
            await DB.prepare('UPDATE selfies SET profile_id = ? WHERE profile_id = ?')
              .bind(mapping.newId, mapping.oldId)
              .run();
          }
          
          // Update foreign keys in results
          for (const mapping of idMappings) {
            await DB.prepare('UPDATE results SET profile_id = ? WHERE profile_id = ?')
              .bind(mapping.newId, mapping.oldId)
              .run();
          }
          
          // Create new profiles table
          await DB.prepare(`
            CREATE TABLE IF NOT EXISTS profiles_new (
              id TEXT PRIMARY KEY,
              device_id TEXT,
              name TEXT,
              email TEXT,
              avatar_url TEXT,
              preferences TEXT,
              created_at INTEGER NOT NULL DEFAULT (unixepoch()),
              updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
          `).run();
          
          // Migrate profiles with new IDs
          for (const profile of allProfiles.results || []) {
            const row = profile as any;
            const mapping = idMappings.find(m => m.oldId === row.id);
            const newId = mapping ? mapping.newId : row.id;
            
            await DB.prepare(`
              INSERT INTO profiles_new (id, device_id, name, email, avatar_url, preferences, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              newId,
              row.device_id,
              row.name,
              row.email,
              row.avatar_url,
              row.preferences,
              row.created_at,
              row.updated_at
            ).run();
          }
          
          // Replace old table
          await DB.prepare('DROP TABLE profiles').run();
          await DB.prepare('ALTER TABLE profiles_new RENAME TO profiles').run();
          
          // Recreate indexes
          await DB.prepare('CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at DESC)').run();
          await DB.prepare('CREATE INDEX IF NOT EXISTS idx_profiles_device_id ON profiles(device_id)').run();
          
          console.log(`[Migration 005] ✓ Migrated ${idMappings.length} profile IDs to nanoid(16)`);
        } else {
          console.log('[Migration 005] ✓ All profile IDs are already in nanoid(16) format');
        }
      } else {
        console.log('[Migration 005] ✓ Profile IDs are already in nanoid(16) format');
      }
    } else {
      console.log('[Migration 005] ✓ No profiles to migrate');
    }
    
    console.log('[Migration 005] ✓ Complete migration finished successfully!');
    
  } catch (error) {
    console.error('[Migration 005] ✗ Migration failed:', error);
    throw error;
  }
}

// This migration can be run via the /migrate endpoint in the worker
// Or directly via wrangler d1 execute with a wrapper script
