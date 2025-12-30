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

async function listObjects(apiToken, accountId, bucketName, prefix, cursor = null) {
  let url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects`;
  const params = [];
  if (prefix) params.push(`prefix=${encodeURIComponent(prefix)}`);
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  if (params.length > 0) url += `?${params.join('&')}`;
  
  const result = execSync(
    `curl -s -X GET "${url}" -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json"`,
    { encoding: 'utf8' }
  );
  const data = JSON.parse(result);
  if (!data.success) {
    throw new Error(`Failed to list objects: ${JSON.stringify(data.errors)}`);
  }
  return data.result || { objects: [], truncated: false };
}

async function listAllObjects(apiToken, accountId, bucketName, prefix) {
  const allObjects = [];
  let cursor = null;
  let truncated = true;
  
  while (truncated) {
    const result = await listObjects(apiToken, accountId, bucketName, prefix, cursor);
    const objects = result.objects || result;
    if (Array.isArray(objects)) {
      allObjects.push(...objects);
      truncated = result.truncated || false;
      cursor = result.cursor || null;
    } else {
      allObjects.push(...(result.objects || []));
      truncated = result.truncated || false;
      cursor = result.cursor || null;
    }
    if (!truncated || !cursor) break;
  }
  
  return allObjects;
}

async function deleteObject(apiToken, accountId, bucketName, objectKey) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects/${encodeURIComponent(objectKey)}`;
  const result = execSync(
    `curl -s -X DELETE "${url}" -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json"`,
    { encoding: 'utf8' }
  );
  const data = JSON.parse(result);
  return data.success;
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
            let deleted = 0;
            let failed = 0;
            
            for (const obj of objects) {
              const key = obj.key || obj;
              try {
                const success = await deleteObject(apiToken, accountId, bucketName, key);
                if (success) {
                  deleted++;
                } else {
                  failed++;
                }
              } catch (error) {
                console.log(`  ${colors.red}✗ Failed to delete ${key}: ${error.message}${colors.reset}`);
                failed++;
              }
            }
            
            if (deleted > 0) {
              console.log(`  ${colors.green}✓ Deleted ${deleted} object(s)${colors.reset}`);
              totalDeleted += deleted;
            }
            if (failed > 0) {
              console.log(`  ${colors.red}✗ Failed to delete ${failed} object(s)${colors.reset}`);
              totalFailed += failed;
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

async function cleanupOldThumbnails(env, dryRun = false) {
  console.log(`${colors.cyan}=== FORCE DELETING old thumbnail folders ===${colors.reset}`);
  console.log(`Environment: ${colors.yellow}${env}${colors.reset}`);
  console.log(`Mode: ${dryRun ? colors.yellow + 'DRY RUN' : colors.red + 'FORCE DELETE' + colors.reset}${colors.reset}`);
  console.log('');
  
  const bucketName = getBucketName(env);
  const { apiToken, accountId } = getCloudflareCredentials(env);
  
  console.log(`Bucket: ${colors.cyan}${bucketName}${colors.reset}`);
  console.log(`Account ID: ${colors.cyan}${accountId}${colors.reset}`);
  console.log('');
  
  let totalDeleted = 0;
  let totalFailed = 0;
  
  for (const folder of oldThumbnailFolders) {
    console.log(`${colors.cyan}Processing: ${folder}/${colors.reset}`);
    
    const prefix = `${folder}/`;
    
    try {
      const objects = await listAllObjects(apiToken, accountId, bucketName, prefix);
      
      if (objects.length === 0) {
        console.log(`  ${colors.yellow}No objects found${colors.reset}`);
      } else {
        if (dryRun) {
          console.log(`  ${colors.yellow}[DRY RUN] Would delete ${objects.length} object(s)${colors.reset}`);
          totalDeleted += objects.length;
        } else {
          let deleted = 0;
          let failed = 0;
          
          for (const obj of objects) {
            const key = obj.key || obj;
            try {
              const success = await deleteObject(apiToken, accountId, bucketName, key);
              if (success) {
                deleted++;
              } else {
                failed++;
              }
            } catch (error) {
              console.log(`  ${colors.red}✗ Failed to delete ${key}: ${error.message}${colors.reset}`);
              failed++;
            }
          }
          
          if (deleted > 0) {
            console.log(`  ${colors.green}✓ Deleted ${deleted} object(s)${colors.reset}`);
            totalDeleted += deleted;
          }
          if (failed > 0) {
            console.log(`  ${colors.red}✗ Failed to delete ${failed} object(s)${colors.reset}`);
            totalFailed += failed;
          }
        }
      }
    } catch (error) {
      console.log(`  ${colors.red}✗ Error: ${error.message}${colors.reset}`);
      totalFailed++;
    }
    
    console.log('');
  }
  
  console.log(`${colors.cyan}=== Summary ===${colors.reset}`);
  console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${colors.green}${totalDeleted}${colors.reset} object(s)`);
  if (totalFailed > 0) {
    console.log(`Failed: ${colors.red}${totalFailed}${colors.reset} object(s)`);
  }
  
  if (dryRun && totalDeleted > 0) {
    console.log(`\n${colors.yellow}This was a dry run. Run without --dry-run to actually delete.${colors.reset}`);
  }
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
