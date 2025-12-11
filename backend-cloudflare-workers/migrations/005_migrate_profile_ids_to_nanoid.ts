// Migration 005 Application Script: Migrate profile IDs to nanoid(16)
// This script migrates existing profile IDs from old format to nanoid(16)
// Run this after executing 005_simplify_presets_add_device_id.sql

import { nanoid } from 'nanoid';

interface MigrationContext {
  DB: D1Database;
}

interface ProfileMapping {
  oldId: string;
  newId: string;
}

export async function migrateProfileIdsToNanoid(context: MigrationContext): Promise<void> {
  const { DB } = context;
  
  console.log('[Migration 005] Starting profile ID migration to nanoid(16)...');
  
  // Step 1: Get all existing profiles
  const profiles = await DB.prepare('SELECT id FROM profiles').all();
  
  if (!profiles.results || profiles.results.length === 0) {
    console.log('[Migration 005] No profiles to migrate');
    return;
  }
  
  // Step 2: Create mapping of old IDs to new nanoid(16) IDs
  const idMappings: ProfileMapping[] = [];
  for (const profile of profiles.results) {
    const oldId = (profile as any).id;
    // Only migrate if ID doesn't look like nanoid(16) already
    // nanoid(16) is 16 chars, alphanumeric, no hyphens
    if (oldId.length !== 16 || /[^a-zA-Z0-9]/.test(oldId)) {
      const newId = nanoid(16);
      idMappings.push({ oldId, newId });
    }
  }
  
  if (idMappings.length === 0) {
    console.log('[Migration 005] All profile IDs are already in nanoid(16) format');
    return;
  }
  
  console.log(`[Migration 005] Migrating ${idMappings.length} profile IDs...`);
  
  // Step 3: Create temporary mapping table
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS profile_id_mapping (
      old_id TEXT PRIMARY KEY,
      new_id TEXT NOT NULL
    )
  `).run();
  
  // Step 4: Insert mappings
  for (const mapping of idMappings) {
    await DB.prepare('INSERT INTO profile_id_mapping (old_id, new_id) VALUES (?, ?)')
      .bind(mapping.oldId, mapping.newId)
      .run();
  }
  
  // Step 5: Update foreign key references in selfies and results tables
  // Note: SQLite doesn't support ALTER TABLE to modify foreign keys easily
  // We'll need to recreate tables with new IDs
  
  // Update selfies table
  for (const mapping of idMappings) {
    await DB.prepare('UPDATE selfies SET profile_id = ? WHERE profile_id = ?')
      .bind(mapping.newId, mapping.oldId)
      .run();
  }
  
  // Update results table
  for (const mapping of idMappings) {
    await DB.prepare('UPDATE results SET profile_id = ? WHERE profile_id = ?')
      .bind(mapping.newId, mapping.oldId)
      .run();
  }
  
  // Step 6: Update profiles table IDs
  // Create new profiles table with new IDs
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
  const allProfiles = await DB.prepare(`
    SELECT id, device_id, name, email, avatar_url, preferences, created_at, updated_at
    FROM profiles
  `).all();
  
  for (const profile of allProfiles.results || []) {
    const oldId = (profile as any).id;
    const mapping = idMappings.find(m => m.oldId === oldId);
    const newId = mapping ? mapping.newId : oldId;
    
    await DB.prepare(`
      INSERT INTO profiles_new (id, device_id, name, email, avatar_url, preferences, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId,
      (profile as any).device_id,
      (profile as any).name,
      (profile as any).email,
      (profile as any).avatar_url,
      (profile as any).preferences,
      (profile as any).created_at,
      (profile as any).updated_at
    ).run();
  }
  
  // Step 7: Replace old table
  await DB.prepare('DROP TABLE profiles').run();
  await DB.prepare('ALTER TABLE profiles_new RENAME TO profiles').run();
  
  // Step 8: Recreate indexes
  await DB.prepare('CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at DESC)').run();
  await DB.prepare('CREATE INDEX IF NOT EXISTS idx_profiles_device_id ON profiles(device_id)').run();
  
  // Step 9: Clean up mapping table
  await DB.prepare('DROP TABLE profile_id_mapping').run();
  
  console.log(`[Migration 005] Successfully migrated ${idMappings.length} profile IDs to nanoid(16)`);
}
