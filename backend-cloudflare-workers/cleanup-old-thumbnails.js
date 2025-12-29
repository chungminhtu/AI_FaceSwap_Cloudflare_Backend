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

async function listObjects(apiToken, accountId, bucketName, prefix) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects?prefix=${encodeURIComponent(prefix)}`;
  const result = execSync(
    `curl -s -X GET "${url}" -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json"`,
    { encoding: 'utf8' }
  );
  const data = JSON.parse(result);
  if (!data.success) {
    throw new Error(`Failed to list objects: ${JSON.stringify(data.errors)}`);
  }
  return data.result || [];
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
      const objects = await listObjects(apiToken, accountId, bucketName, prefix);
      
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
            try {
              const success = await deleteObject(apiToken, accountId, bucketName, obj.key);
              if (success) {
                deleted++;
              } else {
                failed++;
              }
            } catch (error) {
              console.log(`  ${colors.red}✗ Failed to delete ${obj.key}: ${error.message}${colors.reset}`);
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

// Main execution
const env = process.env.DEPLOY_ENV || 
            process.argv.find(arg => arg.startsWith('--env='))?.split('=')[1] ||
            'ai-office-dev'; // Default to dev environment

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');

cleanupOldThumbnails(env, dryRun)
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
