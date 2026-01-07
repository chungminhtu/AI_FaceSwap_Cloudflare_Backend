#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

// Old thumbnail folders to delete (in root, not in preset_thumb)
const oldThumbnailFolders = [
  'lottie_1x',
  'lottie_1.5x',
  'lottie_2x',
  'lottie_3x',
  'lottie_4x',
  'lottie_avif_1x',
  'lottie_avif_1.5x',
  'lottie_avif_2x',
  'lottie_avif_3x',
  'lottie_avif_4x',
  'webp_1x',
  'webp_1.5x',
  'webp_2x',
  'webp_3x',
  'webp_4x',
];

function getWranglerConfig(env) {
  const configPath = path.join(__dirname, '..', '_deploy-cli-cloudflare-gcp', 'wrangler-configs', `wrangler.${env}.jsonc`);
  
  if (!fs.existsSync(configPath)) {
    console.error(`${colors.red}Error: Wrangler config not found for environment: ${env}${colors.reset}`);
    console.error(`Expected path: ${configPath}`);
    process.exit(1);
  }
  
  const configContent = fs.readFileSync(configPath, 'utf-8');
  const jsonContent = configContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const config = JSON.parse(jsonContent);
  
  return config;
}

function getBucketName(env) {
  const config = getWranglerConfig(env);
  const r2Bucket = config.r2_buckets?.[0];
  
  if (!r2Bucket || !r2Bucket.bucket_name) {
    console.error(`${colors.red}Error: R2 bucket not found in config for environment: ${env}${colors.reset}`);
    process.exit(1);
  }
  
  return r2Bucket.bucket_name;
}

function getCloudflareCredentials(env) {
  const secretsPath = path.join(__dirname, '..', '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
  
  if (!fs.existsSync(secretsPath)) {
    throw new Error('deployments-secrets.json not found');
  }
  
  const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
  const envSecrets = secrets.environments?.[env];
  
  if (!envSecrets?.cloudflare) {
    throw new Error(`No Cloudflare config found for environment: ${env}`);
  }
  
  const { apiToken, accountId } = envSecrets.cloudflare;
  if (!apiToken || !accountId) {
    throw new Error(`Missing API token or account ID for environment: ${env}`);
  }
  
  return { apiToken, accountId };
}

async function listObjects(apiToken, accountId, bucketName, prefix, cursor = null, retries = 3) {
  let url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects`;
  const params = [];
  if (prefix) params.push(`prefix=${encodeURIComponent(prefix)}`);
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  if (params.length > 0) url += `?${params.join('&')}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { errors: [{ message: errorText }] };
        }

        // Check if it's a rate limit error
        const isRateLimit = response.status === 429 ||
          errorData.errors?.some(e => e.code === 7010 ||
            e.message?.includes('rate limit') ||
            e.message?.includes('unavailable') ||
            response.status === 503);

        if (isRateLimit && attempt < retries - 1) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
          console.log(`  ${colors.yellow}Rate limited, retrying in ${delay/1000}s... (attempt ${attempt + 1}/${retries})${colors.reset}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`Failed to list objects (${response.status}): ${JSON.stringify(errorData.errors)}`);
      }

      const data = await response.json();
      if (!data.success) {
        // Check if it's a rate limit error
        const isRateLimit = data.errors?.some(e => e.code === 7010 || e.message?.includes('rate limit') || e.message?.includes('unavailable'));
        if (isRateLimit && attempt < retries - 1) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
          console.log(`  ${colors.yellow}Rate limited, retrying in ${delay/1000}s... (attempt ${attempt + 1}/${retries})${colors.reset}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`Failed to list objects: ${JSON.stringify(data.errors)}`);
      }

      // Cloudflare R2 API returns objects array directly in result, with pagination info
      const resultData = data.result || {};

      // If result is an array, it's the objects directly
      if (Array.isArray(resultData)) {
        return {
          objects: resultData,
          truncated: data.result_info?.truncated === true || false,
          cursor: data.result_info?.cursor || null
        };
      }

      // Otherwise, result should have objects, truncated, cursor properties
      return resultData;
    } catch (error) {
      if (attempt === retries - 1) throw error;
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`  ${colors.yellow}Error, retrying in ${delay/1000}s... (attempt ${attempt + 1}/${retries})${colors.reset}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function listAllObjects(apiToken, accountId, bucketName, prefix, verbose = false) {
  const allObjects = [];
  let cursor = null;
  let pageCount = 0;
  const maxPages = 10000; // Safety limit to prevent infinite loops

  // Start with the first page
  if (verbose) {
    console.log(`  ${colors.cyan}Fetching page 1${colors.reset}`);
  }

  const firstResult = await listObjects(apiToken, accountId, bucketName, prefix, null);
  pageCount++;

  let objects = [];
  if (Array.isArray(firstResult)) {
    objects = firstResult;
  } else if (Array.isArray(firstResult.objects)) {
    objects = firstResult.objects;
    cursor = firstResult.cursor || null;
  }

  if (objects.length > 0) {
    allObjects.push(...objects);
    if (verbose) {
      console.log(`  ${colors.green}Found ${objects.length} objects on page 1 (total so far: ${allObjects.length})${colors.reset}`);
    }
  }

  // If no more pages, return
  if (!cursor) {
    if (verbose) {
      console.log(`  ${colors.cyan}Total objects fetched: ${allObjects.length}${colors.reset}`);
    }
    return allObjects;
  }

  // Now fetch remaining pages with limited parallelism
  const concurrentLimit = 3; // Process up to 3 pages concurrently
  const activePromises = new Map();

  while (cursor && pageCount < maxPages) {
    // Start new requests up to the concurrency limit
    while (activePromises.size < concurrentLimit && cursor) {
      const currentCursor = cursor;
      const currentPage = ++pageCount;

      if (verbose) {
        console.log(`  ${colors.cyan}Fetching page ${currentPage} (concurrent)${colors.reset}`);
      }

      const promise = listObjects(apiToken, accountId, bucketName, prefix, currentCursor)
        .then(result => {
          let pageObjects = [];
          let nextCursor = null;

          if (Array.isArray(result)) {
            pageObjects = result;
          } else if (Array.isArray(result.objects)) {
            pageObjects = result.objects;
            nextCursor = result.cursor || null;
          }

          return { pageObjects, nextCursor, pageNum: currentPage };
        })
        .catch(error => {
          console.log(`  ${colors.red}Error fetching page ${currentPage}: ${error.message}${colors.reset}`);
          return { pageObjects: [], nextCursor: null, pageNum: currentPage };
        });

      activePromises.set(currentPage, promise);

      // Get the next cursor for the next iteration
      try {
        const nextResult = await listObjects(apiToken, accountId, bucketName, prefix, cursor);
        if (Array.isArray(nextResult)) {
          cursor = null;
        } else if (Array.isArray(nextResult.objects)) {
          cursor = nextResult.cursor || null;
        } else {
          cursor = null;
        }
      } catch (error) {
        console.log(`  ${colors.yellow}Error getting next cursor: ${error.message}${colors.reset}`);
        cursor = null;
        break;
      }

      // Small delay between cursor requests to avoid rate limiting
      if (cursor) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }

    // Wait for the first promise to complete
    if (activePromises.size > 0) {
      const completedPromises = await Promise.race(
        Array.from(activePromises.entries()).map(([pageNum, promise]) =>
          promise.then(result => ({ pageNum, result }))
        )
      );

      const { pageNum, result } = completedPromises;
      activePromises.delete(pageNum);

      // Process the completed result
      const { pageObjects } = result;
      if (pageObjects.length > 0) {
        allObjects.push(...pageObjects);
        if (verbose) {
          console.log(`  ${colors.green}Found ${pageObjects.length} objects on page ${pageNum} (total so far: ${allObjects.length})${colors.reset}`);
        }
      }
    }
  }

  // Wait for any remaining promises to complete
  if (activePromises.size > 0) {
    const remainingResults = await Promise.all(activePromises.values());
    for (const { pageObjects } of remainingResults) {
      if (pageObjects.length > 0) {
        allObjects.push(...pageObjects);
      }
    }
  }

  if (pageCount >= maxPages) {
    console.log(`  ${colors.red}Warning: Reached maximum page limit (${maxPages}), stopping${colors.reset}`);
  }

  if (verbose) {
    console.log(`  ${colors.cyan}Total objects fetched: ${allObjects.length}${colors.reset}`);
  }

  return allObjects;
}

async function deleteObject(apiToken, accountId, bucketName, objectKey) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects/${encodeURIComponent(objectKey)}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete object (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.success;
}

async function deleteObjectsBatch(apiToken, accountId, bucketName, objectKeys, concurrency = 10, onProgress = null) {
  let deleted = 0;
  let failed = 0;
  const errors = [];

  // Process objects in batches with concurrency control
  for (let i = 0; i < objectKeys.length; i += concurrency) {
    const batch = objectKeys.slice(i, i + concurrency);
    const promises = batch.map(async (key) => {
      try {
        const success = await deleteObject(apiToken, accountId, bucketName, key);
        if (success) {
          deleted++;
        } else {
          failed++;
          errors.push(`Failed to delete ${key}: API returned false`);
        }
      } catch (error) {
        failed++;
        errors.push(`Failed to delete ${key}: ${error.message}`);
      }
    });

    await Promise.all(promises);

    // Report progress
    if (onProgress) {
      onProgress(deleted + failed, objectKeys.length, deleted, failed);
    }

    // Small delay between batches to avoid overwhelming the API
    if (i + concurrency < objectKeys.length) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  return { deleted, failed, errors };
}

async function cleanupDuplicateFolders(env, dryRun = false) {
  console.log(`${colors.cyan}=== CLEANING UP duplicate preset_thumb folders ===${colors.reset}`);
  console.log(`Environment: ${colors.yellow}${env}${colors.reset}`);
  console.log(`Mode: ${dryRun ? colors.yellow + 'DRY RUN' : colors.red + 'FORCE DELETE' + colors.reset}${colors.reset}`);
  console.log('');
  
  const bucketName = getBucketName(env);
  const { apiToken, accountId } = getCloudflareCredentials(env);
  
  console.log(`Bucket: ${colors.cyan}${bucketName}${colors.reset}`);
  console.log(`Account ID: ${colors.cyan}${accountId}${colors.reset}`);
  console.log('');
  
  const prefix = 'preset_thumb/';
  let totalDeleted = 0;
  let totalFailed = 0;
  
  try {
    console.log(`${colors.cyan}Scanning for duplicate folders...${colors.reset}`);
    const allObjects = await listAllObjects(apiToken, accountId, bucketName, prefix);
    
    const duplicatePatterns = new Set();
    
    for (const obj of allObjects) {
      const key = obj.key || obj;
      const match = key.match(/^preset_thumb\/([^\/]+)\/\1\//);
      if (match) {
        const folderName = match[1];
        duplicatePatterns.add(`preset_thumb/${folderName}/${folderName}/`);
      }
    }
    
    if (duplicatePatterns.size === 0) {
      console.log(`  ${colors.yellow}No duplicate folders found${colors.reset}`);
      return { deleted: 0, failed: 0 };
    }
    
    console.log(`  ${colors.cyan}Found ${duplicatePatterns.size} duplicate folder pattern(s)${colors.reset}`);
    console.log('');
    
    for (const duplicatePrefix of Array.from(duplicatePatterns).sort()) {
      console.log(`${colors.cyan}Processing: ${duplicatePrefix}${colors.reset}`);
      
      try {
        const objects = await listAllObjects(apiToken, accountId, bucketName, duplicatePrefix);
        
        if (objects.length === 0) {
          console.log(`  ${colors.yellow}No objects found${colors.reset}`);
        } else {
          if (dryRun) {
            console.log(`  ${colors.yellow}[DRY RUN] Would delete ${objects.length} object(s)${colors.reset}`);
            objects.slice(0, 5).forEach(obj => {
              const key = obj.key || obj;
              console.log(`    - ${key}`);
            });
            if (objects.length > 5) {
              console.log(`    ... and ${objects.length - 5} more`);
            }
            totalDeleted += objects.length;
          } else {
            const objectKeys = objects.map(obj => obj.key || obj);
            console.log(`  ${colors.cyan}Deleting ${objectKeys.length} object(s) in batches...${colors.reset}`);

            const result = await deleteObjectsBatch(
              apiToken, accountId, bucketName, objectKeys, 10,
              (processed, total, deleted, failed) => {
                if (processed % 50 === 0 || processed === total) {
                  console.log(`  ${colors.cyan}Progress: ${processed}/${total} processed (${deleted} deleted, ${failed} failed)...${colors.reset}`);
                }
              }
            );

            totalDeleted += result.deleted;
            totalFailed += result.failed;

            if (result.failed > 0) {
              console.log(`  ${colors.red}✗ Failed to delete ${result.failed} object(s)${colors.reset}`);
              result.errors.slice(0, 3).forEach(error => {
                console.log(`    ${colors.red}${error}${colors.reset}`);
              });
              if (result.errors.length > 3) {
                console.log(`    ${colors.red}... and ${result.errors.length - 3} more errors${colors.reset}`);
              }
            }
          }
        }
      } catch (error) {
        console.log(`  ${colors.red}✗ Error: ${error.message}${colors.reset}`);
        totalFailed++;
      }
      
      console.log('');
    }
  } catch (error) {
    console.log(`  ${colors.red}✗ Error scanning: ${error.message}${colors.reset}`);
    totalFailed++;
  }
  
  console.log(`${colors.cyan}=== Summary ===${colors.reset}`);
  console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${colors.green}${totalDeleted}${colors.reset} object(s)`);
  if (totalFailed > 0) {
    console.log(`Failed: ${colors.red}${totalFailed}${colors.reset} object(s)`);
  }
  
  if (dryRun && totalDeleted > 0) {
    console.log(`\n${colors.yellow}This was a dry run. Run without --dry-run to actually delete.${colors.reset}`);
  }
  
  return { deleted: totalDeleted, failed: totalFailed };
}

async function deleteFolder(env, folderName, dryRun = false) {
  const startTime = Date.now();

  console.log(`${colors.cyan}=== DELETING folder: ${folderName} ===${colors.reset}`);
  console.log(`Environment: ${colors.yellow}${env}${colors.reset}`);
  console.log(`Mode: ${dryRun ? colors.yellow + 'DRY RUN' : colors.red + 'FORCE DELETE' + colors.reset}${colors.reset}`);
  console.log('');

  const bucketName = getBucketName(env);
  const { apiToken, accountId } = getCloudflareCredentials(env);

  console.log(`Bucket: ${colors.cyan}${bucketName}${colors.reset}`);
  console.log(`Account ID: ${colors.cyan}${accountId}${colors.reset}`);
  console.log(`Folder: ${colors.cyan}${folderName}/${colors.reset}`);
  console.log('');

  const prefix = folderName.endsWith('/') ? folderName : `${folderName}/`;
  let totalDeleted = 0;
  let totalFailed = 0;
  
  try {
    console.log(`${colors.cyan}Scanning for objects in ${prefix}...${colors.reset}`);
    const objects = await listAllObjects(apiToken, accountId, bucketName, prefix, true);
    
    console.log(`  ${colors.cyan}Found ${objects.length} object(s) in ${prefix}${colors.reset}`);
    
    if (objects.length === 0) {
      console.log(`  ${colors.yellow}No objects found in ${prefix}${colors.reset}`);
    } else {
      if (dryRun) {
        console.log(`  ${colors.yellow}[DRY RUN] Would delete ${objects.length} object(s)${colors.reset}`);
        objects.slice(0, 10).forEach(obj => {
          const key = obj.key || obj;
          console.log(`    - ${key}`);
        });
        if (objects.length > 10) {
          console.log(`    ... and ${objects.length - 10} more`);
        }
        totalDeleted = objects.length;
      } else {
        const objectKeys = objects.map(obj => obj.key || obj);
        console.log(`  ${colors.cyan}Deleting ${objectKeys.length} object(s) in batches...${colors.reset}`);

        const result = await deleteObjectsBatch(
          apiToken, accountId, bucketName, objectKeys, 15, // Higher concurrency for folder deletion
          (processed, total, deleted, failed) => {
            if (processed % 100 === 0 || processed === total) {
              console.log(`  ${colors.cyan}Progress: ${processed}/${total} processed (${deleted} deleted, ${failed} failed)...${colors.reset}`);
            }
          }
        );

        totalDeleted = result.deleted;
        totalFailed = result.failed;

        if (result.failed > 0) {
          console.log(`  ${colors.red}✗ Failed to delete ${result.failed} object(s)${colors.reset}`);
          result.errors.slice(0, 3).forEach(error => {
            console.log(`    ${colors.red}${error}${colors.reset}`);
          });
          if (result.errors.length > 3) {
            console.log(`    ${colors.red}... and ${result.errors.length - 3} more errors${colors.reset}`);
          }
        }
      }
    }
  } catch (error) {
    console.log(`  ${colors.red}✗ Error: ${error.message}${colors.reset}`);
    totalFailed++;
  }
  
  const duration = (Date.now() - startTime) / 1000;
  console.log('');
  console.log(`${colors.cyan}=== Summary ===${colors.reset}`);
  console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${colors.green}${totalDeleted}${colors.reset} object(s)`);
  if (totalFailed > 0) {
    console.log(`Failed: ${colors.red}${totalFailed}${colors.reset} object(s)`);
  }
  console.log(`Duration: ${colors.cyan}${duration.toFixed(2)}s${colors.reset}`);

  if (dryRun && totalDeleted > 0) {
    console.log(`\n${colors.yellow}This was a dry run. Run without --dry-run to actually delete.${colors.reset}`);
  }

  return { deleted: totalDeleted, failed: totalFailed, duration };
}

async function cleanupOldThumbnails(env, dryRun = false) {
  const startTime = Date.now();

  console.log(`${colors.cyan}=== FORCE DELETING old thumbnail folders ===${colors.reset}`);
  console.log(`Environment: ${colors.yellow}${env}${colors.reset}`);
  console.log(`Mode: ${dryRun ? colors.yellow + 'DRY RUN' : colors.red + 'FORCE DELETE' + colors.reset}${colors.reset}`);
  console.log(`Folders to process: ${colors.cyan}${oldThumbnailFolders.length}${colors.reset}`);
  console.log('');

  const bucketName = getBucketName(env);
  const { apiToken, accountId } = getCloudflareCredentials(env);

  console.log(`Bucket: ${colors.cyan}${bucketName}${colors.reset}`);
  console.log(`Account ID: ${colors.cyan}${accountId}${colors.reset}`);
  console.log('');

  let totalDeleted = 0;
  let totalFailed = 0;
  
  // Process folders concurrently with controlled parallelism
  const folderConcurrency = 3; // Process 3 folders at a time
  for (let i = 0; i < oldThumbnailFolders.length; i += folderConcurrency) {
    const folderBatch = oldThumbnailFolders.slice(i, i + folderConcurrency);
    console.log(`${colors.cyan}Processing folders ${i + 1}-${Math.min(i + folderConcurrency, oldThumbnailFolders.length)} of ${oldThumbnailFolders.length}${colors.reset}`);

    const folderPromises = folderBatch.map(async (folder) => {
      console.log(`  ${colors.cyan}Processing: ${folder}/${colors.reset}`);

      const prefix = `${folder}/`;
      let folderDeleted = 0;
      let folderFailed = 0;

      try {
        const objects = await listAllObjects(apiToken, accountId, bucketName, prefix);

        if (objects.length === 0) {
          console.log(`    ${colors.yellow}No objects found${colors.reset}`);
        } else {
          if (dryRun) {
            console.log(`    ${colors.yellow}[DRY RUN] Would delete ${objects.length} object(s)${colors.reset}`);
            folderDeleted = objects.length;
          } else {
            const objectKeys = objects.map(obj => obj.key || obj);

            const result = await deleteObjectsBatch(apiToken, accountId, bucketName, objectKeys, 8); // Slightly lower concurrency per folder

            folderDeleted = result.deleted;
            folderFailed = result.failed;

            if (result.failed > 0) {
              console.log(`    ${colors.red}✗ Failed to delete ${result.failed} object(s)${colors.reset}`);
            }
          }
        }
      } catch (error) {
        console.log(`    ${colors.red}✗ Error: ${error.message}${colors.reset}`);
        folderFailed++;
      }

      return { folderDeleted, folderFailed };
    });

    const results = await Promise.all(folderPromises);

    // Aggregate results
    for (const result of results) {
      totalDeleted += result.folderDeleted;
      totalFailed += result.folderFailed;
    }

    console.log('');
  }
  
  const duration = (Date.now() - startTime) / 1000;
  console.log(`${colors.cyan}=== Summary ===${colors.reset}`);
  console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${colors.green}${totalDeleted}${colors.reset} object(s)`);
  if (totalFailed > 0) {
    console.log(`Failed: ${colors.red}${totalFailed}${colors.reset} object(s)`);
  }
  console.log(`Duration: ${colors.cyan}${duration.toFixed(2)}s${colors.reset}`);

  if (dryRun && totalDeleted > 0) {
    console.log(`\n${colors.yellow}This was a dry run. Run without --dry-run to actually delete.${colors.reset}`);
  }

  return { deleted: totalDeleted, failed: totalFailed, duration };
}

async function listR2Objects(env, prefix = '') {
  const bucketName = getBucketName(env);
  const { apiToken, accountId } = getCloudflareCredentials(env);
  
  console.log(`${colors.cyan}=== Listing R2 Objects ===${colors.reset}`);
  console.log(`Environment: ${colors.yellow}${env}${colors.reset}`);
  console.log(`Bucket: ${colors.cyan}${bucketName}${colors.reset}`);
  if (prefix) {
    console.log(`Prefix: ${colors.cyan}${prefix}${colors.reset}`);
  }
  console.log('');
  
  try {
    const objects = await listAllObjects(apiToken, accountId, bucketName, prefix);
    
    if (objects.length === 0) {
      console.log(`${colors.yellow}No objects found${colors.reset}`);
    } else {
      console.log(`${colors.green}Found ${objects.length} object(s):${colors.reset}`);
      console.log('');
      objects.forEach((obj, index) => {
        const key = obj.key || obj;
        const size = obj.size ? ` (${(obj.size / 1024).toFixed(2)} KB)` : '';
        console.log(`  ${index + 1}. ${key}${size}`);
      });
    }
    
    console.log('');
    console.log(JSON.stringify({ objects: objects.map(obj => ({ key: obj.key || obj, size: obj.size, etag: obj.etag })) }, null, 2));
  } catch (error) {
    console.error(`${colors.red}Error: ${error.message}${colors.reset}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Main execution
const env = process.env.DEPLOY_ENV || 
            process.argv.find(arg => arg.startsWith('--env='))?.split('=')[1] ||
            'ai-office-dev'; // Default to dev environment

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');
const listMode = process.argv.includes('--list') || process.argv.includes('-l');
const duplicateOnly = process.argv.includes('--duplicates') || process.argv.includes('--dup');
const folderArg = process.argv.find(arg => arg.startsWith('--folder='))?.split('=')[1] ||
                  process.argv.find(arg => arg.startsWith('-f='))?.split('=')[1] ||
                  (process.argv.includes('--folder') && process.argv[process.argv.indexOf('--folder') + 1]) ||
                  (process.argv.includes('-f') && process.argv[process.argv.indexOf('-f') + 1]);

if (listMode) {
  const prefix = process.argv.find(arg => arg.startsWith('--prefix='))?.split('=')[1] || '';
  listR2Objects(env, prefix)
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(`\n${colors.red}Error: ${error.message}${colors.reset}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    });
} else if (folderArg) {
  deleteFolder(env, folderArg, dryRun)
    .then(() => {
      console.log(`\n${colors.green}Folder deletion completed!${colors.reset}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`\n${colors.red}Error: ${error.message}${colors.reset}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    });
} else if (duplicateOnly) {
  cleanupDuplicateFolders(env, dryRun)
    .then(() => {
      console.log(`\n${colors.green}Duplicate cleanup completed!${colors.reset}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`\n${colors.red}Error: ${error.message}${colors.reset}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    });
} else {
  Promise.all([
    cleanupOldThumbnails(env, dryRun),
    cleanupDuplicateFolders(env, dryRun)
  ])
    .then(() => {
      console.log(`\n${colors.green}Cleanup completed!${colors.reset}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`\n${colors.red}Error: ${error.message}${colors.reset}`);
      if (error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    });
}
