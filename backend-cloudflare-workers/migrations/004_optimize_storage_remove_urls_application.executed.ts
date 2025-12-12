// Application-level migration script for results table ID conversion
// This must be run after the SQL migration for selfies and presets
// Run this with: wrangler d1 execute <database> --remote --file=004_optimize_storage_remove_urls_application.ts

// This script generates nanoid IDs for existing INTEGER result IDs
// and migrates the data to the new TEXT-based schema

import { nanoid } from 'nanoid';

// Note: This is a TypeScript template - actual execution requires:
// 1. A Worker or script that can access D1
// 2. Reading all results
// 3. Generating nanoid for each
// 4. Creating mapping and migrating data

// Pseudo-code for the migration:
/*
async function migrateResultsIds(DB: D1Database) {
  // Step 1: Get all existing results
  const results = await DB.prepare('SELECT id, ext, profile_id, created_at FROM results').all();
  
  // Step 2: Generate new IDs and create mapping
  const mappings: Array<{ old_id: number; new_id: string }> = [];
  for (const result of results.results) {
    const newId = nanoid();
    mappings.push({ old_id: result.id, new_id: newId });
    
    // Insert mapping
    await DB.prepare('INSERT INTO results_id_mapping (old_id, new_id) VALUES (?, ?)')
      .bind(result.id, newId).run();
  }
  
  // Step 3: Insert into new table
  for (const mapping of mappings) {
    const result = results.results.find(r => r.id === mapping.old_id);
    if (result) {
      await DB.prepare('INSERT INTO results_new (id, ext, profile_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(mapping.new_id, result.ext, result.profile_id, result.created_at).run();
    }
  }
  
  // Step 4: Drop old table and rename (run SQL manually or via script)
  await DB.exec(`
    DROP TABLE IF EXISTS results;
    DROP TABLE IF EXISTS results_id_mapping;
    ALTER TABLE results_new RENAME TO results;
    CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_results_profile_id ON results(profile_id);
  `);
}
*/
