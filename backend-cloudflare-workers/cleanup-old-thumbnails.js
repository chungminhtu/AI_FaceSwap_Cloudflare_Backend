#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};


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
  
  const { apiToken, accountId, r2AccessKeyId, r2SecretAccessKey } = envSecrets.cloudflare;
  if (!apiToken || !accountId) {
    throw new Error(`Missing API token or account ID for environment: ${env}`);
  }
  
  return { apiToken, accountId, r2AccessKeyId, r2SecretAccessKey };
}

function checkRcloneAvailable() {
  try {
    execSync('which rclone', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getRcloneRemoteName() {
  try {
    // Check if rclone has any configured remotes
    const remotes = execSync('rclone listremotes', { encoding: 'utf-8', stdio: 'pipe' }).trim().split('\n').filter(r => r.trim());
    // Look for common R2 remote names (r2, cloudflare, etc.)
    const r2Remotes = remotes.filter(r => {
      const name = r.replace(':', '').toLowerCase();
      return name.includes('r2') || name.includes('cloudflare');
    });
    if (r2Remotes.length > 0) {
      return r2Remotes[0].replace(':', ''); // Remove the colon
    }
    // If no R2-specific remote found, use the first remote
    if (remotes.length > 0) {
      return remotes[0].replace(':', '');
    }
  } catch {
    // Ignore errors
  }
  return null;
}

function parseFolderPath(folderName) {
  const hasWildcard = folderName.includes('*');
  
  if (hasWildcard) {
    const parts = folderName.split('*');
    const basePath = parts[0].replace(/\/$/, ''); // Remove trailing slash
    return {
      isWildcard: true,
      basePath: basePath,
      original: folderName
    };
  }
  
  return {
    isWildcard: false,
    basePath: folderName.replace(/\/$/, ''),
    original: folderName
  };
}

function getRcloneRemote(bucketName, accountId, r2AccessKeyId, r2SecretAccessKey) {
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  let remoteName = getRcloneRemoteName();
  let tempConfigPath = null;
  
  if (!remoteName && r2AccessKeyId && r2SecretAccessKey) {
    const tempDir = os.tmpdir();
    tempConfigPath = path.join(tempDir, `rclone-${Date.now()}.conf`);
    const configContent = `[r2]
type = s3
provider = Cloudflare
access_key_id = ${r2AccessKeyId}
secret_access_key = ${r2SecretAccessKey}
endpoint = ${endpoint}
`;
    fs.writeFileSync(tempConfigPath, configContent);
    remoteName = 'r2';
    console.log(`  ${colors.cyan}Using temporary rclone config with R2 credentials${colors.reset}`);
  } else if (remoteName) {
    console.log(`  ${colors.cyan}Using pre-configured rclone remote: ${remoteName}${colors.reset}`);
  } else {
    throw new Error('No rclone remote configured and R2 access keys not provided. Either run "rclone config" or add r2AccessKeyId and r2SecretAccessKey to deployments-secrets.json');
  }
  
  return { remoteName, tempConfigPath, baseArgs: tempConfigPath ? ['--config', tempConfigPath] : [] };
}

async function deleteFilesOnlyWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun = false) {
  return new Promise(async (resolve, reject) => {
    const parsed = parseFolderPath(folderName);
    const basePath = parsed.basePath;
    let remoteInfo;
    
    try {
      remoteInfo = getRcloneRemote(bucketName, accountId, r2AccessKeyId, r2SecretAccessKey);
    } catch (error) {
      reject(error);
      return;
    }
    
    const { remoteName, tempConfigPath, baseArgs } = remoteInfo;
    const remotePath = `${remoteName}:${bucketName}/${basePath}`;
    
    try {
      console.log(`  ${colors.cyan}Deleting files only (preserving folders and subfolders)...${colors.reset}`);
      // --max-depth 1: Limits operation to immediate directory level only (no recursion into subdirectories)
      // --exclude "*/": Excludes all directories, ensuring only files are deleted
      // Reference: https://rclone.org/commands/rclone_delete/
      const deleteArgs = [...baseArgs, 'delete', remotePath, '--max-depth', '1', '--exclude', '*/'];
      if (dryRun) {
        deleteArgs.push('--dry-run');
      }
      
      await new Promise((deleteResolve, deleteReject) => {
        const rclone = spawn('rclone', deleteArgs, {
          stdio: 'inherit',
          env: process.env
        });
        
        rclone.on('close', (code) => {
          if (code === 0) {
            deleteResolve();
          } else {
            deleteReject(new Error(`rclone delete failed with code ${code}`));
          }
        });
        
        rclone.on('error', deleteReject);
      });
      
      if (tempConfigPath && fs.existsSync(tempConfigPath)) {
        try {
          fs.unlinkSync(tempConfigPath);
        } catch {
          // Ignore cleanup errors
        }
      }
      
      resolve(true);
    } catch (error) {
      if (tempConfigPath && fs.existsSync(tempConfigPath)) {
        try {
          fs.unlinkSync(tempConfigPath);
        } catch {
          // Ignore cleanup errors
        }
      }
      reject(error);
    }
  });
}

async function deleteFoldersOnlyWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun = false) {
  // Reuse existing deleteFolderWithRclone - it already uses purge to delete folders
  return deleteFolderWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun);
}

async function deleteFolderWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun = false) {
  return new Promise(async (resolve, reject) => {
    const parsed = parseFolderPath(folderName);
    const folderPath = parsed.basePath;
    let remoteInfo;
    
    try {
      remoteInfo = getRcloneRemote(bucketName, accountId, r2AccessKeyId, r2SecretAccessKey);
    } catch (error) {
      reject(error);
      return;
    }
    
    const { remoteName, tempConfigPath, baseArgs } = remoteInfo;
    const remotePath = `${remoteName}:${bucketName}/${folderPath}`;
    
    try {
      console.log(`  ${colors.cyan}Step 1: Purging folder and all contents...${colors.reset}`);
      const purgeArgs = [...baseArgs, 'purge', '-P', remotePath];
      if (dryRun) {
        purgeArgs.splice(purgeArgs.indexOf('purge') + 1, 0, '--dry-run');
      }
      
      await new Promise((purgeResolve, purgeReject) => {
        const rclone = spawn('rclone', purgeArgs, {
          stdio: 'inherit',
          env: process.env
        });
        
        rclone.on('close', (code) => {
          if (code === 0) {
            purgeResolve();
          } else {
            purgeReject(new Error(`rclone purge failed with code ${code}`));
          }
        });
        
        rclone.on('error', purgeReject);
      });
      
      if (!dryRun) {
        console.log(`  ${colors.cyan}Step 2: Removing empty directory markers...${colors.reset}`);
        const rmdirsArgs = [...baseArgs, 'rmdirs', '-P', remotePath];
        
        await new Promise((rmdirsResolve) => {
          const rclone = spawn('rclone', rmdirsArgs, {
            stdio: 'inherit',
            env: process.env
          });
          
          rclone.on('close', () => {
            rmdirsResolve();
          });
          
          rclone.on('error', () => {
            rmdirsResolve();
          });
        });
        
        console.log(`  ${colors.cyan}Step 3: Removing folder marker object via R2 API...${colors.reset}`);
        const folderMarkerKey = `${folderPath}/`;
        
        try {
          const credentials = getCloudflareCredentials(env);
          if (credentials.apiToken && credentials.accountId) {
            const markerUrl = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/r2/buckets/${bucketName}/objects/${encodeURIComponent(folderMarkerKey)}`;
            const response = await fetch(markerUrl, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${credentials.apiToken}`,
                'Content-Type': 'application/json'
              }
            });
            
            if (response.ok || response.status === 404) {
              console.log(`  ${colors.green}✓ Folder marker removed or didn't exist${colors.reset}`);
            } else {
              const errorText = await response.text();
              console.log(`  ${colors.yellow}⚠ Could not delete folder marker: ${response.status} - ${errorText}${colors.reset}`);
            }
          }
        } catch (error) {
          console.log(`  ${colors.yellow}⚠ Could not delete folder marker via API: ${error.message}${colors.reset}`);
        }
        
        console.log(`  ${colors.cyan}Step 4: Trying rclone delete as backup...${colors.reset}`);
        const folderMarkerPath = `${remotePath}/`;
        const deleteArgs = [...baseArgs, 'delete', folderMarkerPath];
        
        await new Promise((deleteResolve) => {
          const rclone = spawn('rclone', deleteArgs, {
            stdio: 'pipe',
            env: process.env
          });
          
          rclone.on('close', () => {
            deleteResolve();
          });
          
          rclone.on('error', () => {
            deleteResolve();
          });
        });
      }
      
      if (tempConfigPath && fs.existsSync(tempConfigPath)) {
        try {
          fs.unlinkSync(tempConfigPath);
        } catch {
          // Ignore cleanup errors
        }
      }
      
      resolve(true);
    } catch (error) {
      if (tempConfigPath && fs.existsSync(tempConfigPath)) {
        try {
          fs.unlinkSync(tempConfigPath);
        } catch {
          // Ignore cleanup errors
        }
      }
      reject(error);
    }
  });
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


async function deleteFolder(env, folderName, dryRun = false, foldersOnly = false) {
  const startTime = Date.now();
  const parsed = parseFolderPath(folderName);
  const isWildcard = parsed.isWildcard;

  let operationType;
  if (foldersOnly) {
    operationType = 'DELETING FOLDERS ONLY';
  } else if (isWildcard) {
    operationType = 'DELETING FILES (wildcard)';
  } else {
    operationType = 'DELETING FOLDER';
  }
  console.log(`${colors.cyan}=== ${operationType}: ${folderName} ===${colors.reset}`);
  console.log(`Environment: ${colors.yellow}${env}${colors.reset}`);
  console.log(`Mode: ${dryRun ? colors.yellow + 'DRY RUN' : colors.red + 'FORCE DELETE' + colors.reset}${colors.reset}`);
  console.log('');

  const bucketName = getBucketName(env);
  const { apiToken, accountId, r2AccessKeyId, r2SecretAccessKey } = getCloudflareCredentials(env);

  console.log(`Bucket: ${colors.cyan}${bucketName}${colors.reset}`);
  console.log(`Account ID: ${colors.cyan}${accountId}${colors.reset}`);
  console.log(`Path: ${colors.cyan}${folderName}${colors.reset}`);
  if (foldersOnly) {
    console.log(`  ${colors.yellow}Folders-only mode: Will delete folders only, preserving files${colors.reset}`);
  } else if (isWildcard) {
    console.log(`  ${colors.yellow}Wildcard mode: Will delete files only, preserving folders${colors.reset}`);
  }
  console.log('');

  // Check if rclone is available (required)
  const useRclone = checkRcloneAvailable();
  if (!useRclone) {
    throw new Error('rclone is required but not installed. Install with: brew install rclone, then configure with: rclone config');
  }
  
  let rcloneMethod;
  if (foldersOnly) {
    rcloneMethod = 'folders-only deletion';
  } else if (isWildcard) {
    rcloneMethod = 'files-only deletion';
  } else {
    rcloneMethod = 'recursive deletion';
  }
  
  console.log(`${colors.cyan}Using rclone for ${rcloneMethod}...${colors.reset}\n`);
  
  try {
    if (foldersOnly) {
      await deleteFoldersOnlyWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun);
    } else if (isWildcard) {
      await deleteFilesOnlyWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun);
    } else {
      await deleteFolderWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun);
    }
    const duration = (Date.now() - startTime) / 1000;
    console.log('');
    console.log(`${colors.cyan}=== Summary ===${colors.reset}`);
    if (foldersOnly) {
      console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${colors.green}Folders only (files preserved)${colors.reset}`);
    } else if (isWildcard) {
      console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${colors.green}Files only (folders preserved)${colors.reset}`);
    } else {
      console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${colors.green}Folder and all contents${colors.reset}`);
    }
    console.log(`Duration: ${colors.cyan}${duration.toFixed(2)}s${colors.reset}`);
    if (dryRun) {
      console.log(`\n${colors.yellow}This was a dry run. Run without --dry-run to actually delete.${colors.reset}`);
    }
    return { deleted: 1, failed: 0, duration };
  } catch (error) {
    throw new Error(`rclone deletion failed: ${error.message}`);
  }
}


async function discoverFolders(env, baseFolder) {
  const bucketName = getBucketName(env);
  const { apiToken, accountId, r2AccessKeyId, r2SecretAccessKey } = getCloudflareCredentials(env);
  
  // Normalize baseFolder - ensure it doesn't have trailing slash for rclone
  const normalizedBaseFolder = baseFolder.endsWith('/') ? baseFolder.slice(0, -1) : baseFolder;
  const prefix = `${normalizedBaseFolder}/`;
  console.log(`${colors.cyan}Discovering folders in ${prefix} using rclone...${colors.reset}`);
  
  try {
    // Use rclone to detect folders - it has native directory detection
    let remoteInfo;
    try {
      remoteInfo = getRcloneRemote(bucketName, accountId, r2AccessKeyId, r2SecretAccessKey);
    } catch (error) {
      throw new Error(`Failed to get rclone remote: ${error.message}`);
    }
    
    const { remoteName, tempConfigPath, baseArgs } = remoteInfo;
    const remotePath = `${remoteName}:${bucketName}/${normalizedBaseFolder}`;
    
    // Use rclone ls to list all objects, then parse to find folders
    // This works better with R2 than lsd/lsf commands
    const lsArgs = [...baseArgs, 'ls', '-R', remotePath];
    
    return new Promise((resolve, reject) => {
      const rclone = spawn('rclone', lsArgs, {
        stdio: 'pipe',
        env: process.env
      });
      
      let stdout = '';
      let stderr = '';
      
      rclone.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      rclone.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      rclone.on('close', (code) => {
        if (tempConfigPath && fs.existsSync(tempConfigPath)) {
          try {
            fs.unlinkSync(tempConfigPath);
          } catch {
            // Ignore cleanup errors
          }
        }
        
        if (code !== 0) {
          // If no files found, that's OK - might mean no folders
          if (stderr.includes('directory not found') || stderr.includes('Couldn\'t find directory')) {
            console.log(`  ${colors.yellow}No folders found${colors.reset}`);
            resolve([]);
            return;
          }
          reject(new Error(`rclone ls failed: ${stderr.substring(0, 200)}`));
          return;
        }
        
        // Parse output - rclone ls returns file paths
        // Find folders by detecting nested paths
        const prefix = `${normalizedBaseFolder}/`;
        const folderSet = new Set();
        
        stdout.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (!trimmed) return;
          
          // rclone ls format: "size path" or just "path"
          // Extract path (last part after spaces)
          const parts = trimmed.split(/\s+/);
          const fullPath = parts[parts.length - 1];
          
          // Check if path is under our base folder
          if (!fullPath.startsWith(prefix)) return;
          
          const relativePath = fullPath.replace(prefix, '');
          if (!relativePath) return;
          
          // Only identify folders if there's a nested path (file inside a folder)
          if (relativePath.includes('/')) {
            const pathParts = relativePath.split('/');
            // Build folder path - everything before the last segment
            let currentPath = prefix;
            for (let i = 0; i < pathParts.length - 1; i++) {
              const segment = pathParts[i];
              // Skip segments that look like files (have extensions)
              if (segment.includes('.') && /\.(webp|png|json|jpg|jpeg|gif|pdf|txt|zip)$/i.test(segment)) {
                break; // This is a file, not a folder
              }
              currentPath += segment;
              folderSet.add(currentPath.slice(0, -1)); // Remove trailing /
              currentPath += '/';
            }
          }
        });
        
        const folders = Array.from(folderSet)
          .filter(folder => folder.startsWith(normalizedBaseFolder))
          .sort();
        
        console.log(`  ${colors.green}Found ${folders.length} folder(s)${colors.reset}`);
        if (folders.length > 0 && folders.length <= 20) {
          folders.forEach((folder, index) => {
            console.log(`  ${index + 1}. ${folder}`);
          });
        } else if (folders.length > 20) {
          folders.slice(0, 20).forEach((folder, index) => {
            console.log(`  ${index + 1}. ${folder}`);
          });
          console.log(`  ... and ${folders.length - 20} more`);
        }
        console.log('');
        
        resolve(folders);
      });
      
      rclone.on('error', (error) => {
        if (tempConfigPath && fs.existsSync(tempConfigPath)) {
          try {
            fs.unlinkSync(tempConfigPath);
          } catch {
            // Ignore cleanup errors
          }
        }
        reject(error);
      });
    });
  } catch (error) {
    console.error(`${colors.red}Error discovering folders: ${error.message}${colors.reset}`);
    throw error;
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
const foldersOnly = process.argv.includes('--folders-only') || process.argv.includes('--folders');
const autoDiscover = process.argv.includes('--auto-discover') || process.argv.includes('--auto');
const listFoldersOnly = process.argv.includes('--list-folders') || process.argv.includes('--list-folder');

// Support multiple folders: --folder=folder1,folder2 or --folder=folder1 --folder=folder2
const folderArgs = [];
// Get all --folder= arguments
process.argv.forEach(arg => {
  if (arg.startsWith('--folder=')) {
    const folders = arg.split('=')[1].split(',').map(f => f.trim()).filter(f => f);
    folderArgs.push(...folders);
  } else if (arg.startsWith('-f=')) {
    const folders = arg.split('=')[1].split(',').map(f => f.trim()).filter(f => f);
    folderArgs.push(...folders);
  }
});
// Get --folder without = (space-separated)
if (process.argv.includes('--folder')) {
  const folderIndex = process.argv.indexOf('--folder');
  if (folderIndex + 1 < process.argv.length && !process.argv[folderIndex + 1].startsWith('--')) {
    const folders = process.argv[folderIndex + 1].split(',').map(f => f.trim()).filter(f => f);
    folderArgs.push(...folders);
  }
}
// Get -f without = (space-separated)
if (process.argv.includes('-f')) {
  const folderIndex = process.argv.indexOf('-f');
  if (folderIndex + 1 < process.argv.length && !process.argv[folderIndex + 1].startsWith('-')) {
    const folders = process.argv[folderIndex + 1].split(',').map(f => f.trim()).filter(f => f);
    folderArgs.push(...folders);
  }
}

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
} else if (listFoldersOnly || (autoDiscover && !foldersOnly)) {
  // List folders only mode - discover and list all folders without deleting
  const baseFolder = folderArgs.length > 0 ? folderArgs[0] : 'preset';
  console.log(`${colors.cyan}=== Listing folders in ${baseFolder} ===${colors.reset}\n`);
  discoverFolders(env, baseFolder)
    .then(folders => {
      if (folders.length === 0) {
        console.log(`${colors.yellow}No folders found in ${baseFolder}${colors.reset}`);
        process.exit(0);
      }
      console.log(`\n${colors.green}=== Found ${folders.length} folder(s) ===${colors.reset}`);
      console.log(`${colors.cyan}Folder list (one per line):${colors.reset}\n`);
      folders.forEach(folder => {
        console.log(folder);
      });
      console.log(`\n${colors.cyan}To delete these folders, use:${colors.reset}`);
      console.log(`${colors.yellow}node backend-cloudflare-workers/cleanup-old-thumbnails.js --folders-only --auto-discover${colors.reset}`);
      process.exit(0);
    })
    .catch(error => {
      console.error(`\n${colors.red}Error discovering folders: ${error.message}${colors.reset}`);
      process.exit(1);
    });
} else if (folderArgs.length > 0 || process.env.DEFAULT_FOLDER || (autoDiscover && foldersOnly)) {
  // If no folders specified but DEFAULT_FOLDER env var is set, use it
  if (folderArgs.length === 0 && process.env.DEFAULT_FOLDER) {
    folderArgs.push(...process.env.DEFAULT_FOLDER.split(',').map(f => f.trim()).filter(f => f));
  }
  
  // Process folders function
  function processFolders(foldersToProcess) {
    if (foldersToProcess.length > 0) {
      // Process multiple folders sequentially
      (async () => {
        let totalDeleted = 0;
        let totalFailed = 0;
        const startTime = Date.now();
        
        console.log(`${colors.cyan}=== DELETING ${foldersToProcess.length} folder(s) ===${colors.reset}\n`);
        
        for (let i = 0; i < foldersToProcess.length; i++) {
          const folder = foldersToProcess[i];
          console.log(`\n${colors.cyan}[${i + 1}/${foldersToProcess.length}] Processing folder: ${folder}${colors.reset}`);
          console.log('─'.repeat(60));
          
          try {
            const result = await deleteFolder(env, folder, dryRun, foldersOnly);
            totalDeleted += result.deleted;
            totalFailed += result.failed;
          } catch (error) {
            console.error(`\n${colors.red}Error deleting ${folder}: ${error.message}${colors.reset}`);
            totalFailed++;
          }
          
          if (i < foldersToProcess.length - 1) {
            console.log(''); // Add spacing between folders
          }
        }
        
        const duration = (Date.now() - startTime) / 1000;
        console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
        console.log(`${colors.cyan}=== Overall Summary ===${colors.reset}`);
        console.log(`Folders processed: ${colors.cyan}${foldersToProcess.length}${colors.reset}`);
        console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${colors.green}${totalDeleted}${colors.reset} object(s)`);
        if (totalFailed > 0) {
          console.log(`Failed: ${colors.red}${totalFailed}${colors.reset} object(s)`);
        }
        console.log(`Total duration: ${colors.cyan}${duration.toFixed(2)}s${colors.reset}`);
        console.log(`${colors.green}All folders processed!${colors.reset}`);
        
        process.exit(totalFailed > 0 ? 1 : 0);
      })();
    } else {
      console.error(`${colors.red}Error: No folders specified${colors.reset}`);
      process.exit(1);
    }
  }
  
  // Auto-discover folders if enabled
  if (autoDiscover && foldersOnly) {
    const baseFolder = folderArgs.length > 0 ? folderArgs[0] : 'preset';
    console.log(`${colors.cyan}=== Auto-discovering folders in ${baseFolder} ===${colors.reset}\n`);
    discoverFolders(env, baseFolder)
      .then(discoveredFolders => {
        if (discoveredFolders.length === 0) {
          console.log(`${colors.yellow}No folders found in ${baseFolder}${colors.reset}`);
          process.exit(0);
        }
        processFolders(discoveredFolders);
      })
      .catch(error => {
        console.error(`\n${colors.red}Error discovering folders: ${error.message}${colors.reset}`);
        process.exit(1);
      });
  } else {
    processFolders(folderArgs);
  }
} else {
  console.error(`${colors.red}Error: --folder argument is required (unless using --auto-discover with --folders-only or --list-folders)${colors.reset}`);
  console.error(`Usage: node cleanup-old-thumbnails.js --folder=<folder-name> [--folder=<folder2>] [--dry-run] [--folders-only] [--auto-discover] [--list-folders]`);
  console.error(`Examples:`);
  console.error(`  # List all folders in preset (no deletion):`);
  console.error(`  node cleanup-old-thumbnails.js --list-folders`);
  console.error(`  # List folders in specific folder:`);
  console.error(`  node cleanup-old-thumbnails.js --list-folders --folder=preset`);
  console.error(`  # Auto-discover and delete all folders:`);
  console.error(`  node cleanup-old-thumbnails.js --folders-only --auto-discover`);
  console.error(`  # Delete folders in specific folder:`);
  console.error(`  node cleanup-old-thumbnails.js --folder=preset --folders-only --auto-discover`);
  console.error(`  # Delete folder and all contents:`);
  console.error(`  node cleanup-old-thumbnails.js --folder=preset_thumb/preset`);
  console.error(`  # Delete files only (preserve folders):`);
  console.error(`  node cleanup-old-thumbnails.js --folder=preset_thumb/*`);
  console.error(`  # Delete folders only (preserve files) inside preset:`);
  console.error(`  node cleanup-old-thumbnails.js --folder=preset --folders-only`);
  console.error(`  # Multiple folders:`);
  console.error(`  node cleanup-old-thumbnails.js --folder=preset_thumb --folder=folder2`);
  console.error(`  node cleanup-old-thumbnails.js --folder=preset_thumb/*,folder2/*`);
  process.exit(1);
}
