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
    // Remove trailing slash for purge - rclone purge works on folder path without trailing slash
    const folderPathClean = folderPath.replace(/\/$/, '');
    const remotePath = `${remoteName}:${bucketName}/${folderPathClean}`;
    
    try {
      // Check if this is actually a file (has extension) - if so, skip it
      const lastSegment = folderPathClean.split('/').pop() || '';
      if (lastSegment.includes('.') && /\.(webp|png|json|jpg|jpeg|gif|pdf|txt|zip)$/i.test(lastSegment)) {
        // This is a file, not a folder - skip deletion
        if (!dryRun) {
          console.log(`  ${colors.yellow}Skipping ${folderPathClean} - this is a file, not a folder${colors.reset}`);
        }
        resolve(true);
        return;
      }
      
      // Verify this is actually a folder with nested files before deleting
      const folderPathWithSlash = `${folderPathClean}/`;
      const remotePathCheck = `${remoteName}:${bucketName}/${folderPathWithSlash}`;
      const lsArgs = [...baseArgs, 'ls', '--max-depth', '1', remotePathCheck];
      
      const hasNestedFiles = await new Promise((checkResolve) => {
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
          if (code === 0 && stdout.trim().length > 0) {
            const lines = stdout.trim().split('\n').filter(line => line.trim().length > 0);
            const hasFiles = lines.some(line => {
              const trimmed = line.trim();
              return trimmed.length > 0 && !trimmed.endsWith('/');
            });
            checkResolve(hasFiles);
          } else if (stderr.includes('is a file not a directory')) {
            checkResolve(false);
          } else {
            checkResolve(false);
          }
        });
        
        rclone.on('error', () => {
          checkResolve(false);
        });
      });
      
      if (!hasNestedFiles) {
        // This is not a folder with nested files - skip deletion
        if (!dryRun) {
          console.log(`  ${colors.yellow}Skipping ${folderPathClean} - no nested files found (not a folder)${colors.reset}`);
        }
        resolve(true);
        return;
      }
      
      // Step 1: Delete all files inside the folder using pattern
      const remotePathPattern = `${remoteName}:${bucketName}/${folderPathWithSlash}*`;
      
      const deleteArgs = [...baseArgs, 'delete', remotePathPattern];
      if (dryRun) {
        deleteArgs.push('--dry-run');
      }
      
      await new Promise((deleteResolve, deleteReject) => {
        const rclone = spawn('rclone', deleteArgs, {
          stdio: 'pipe',
          env: process.env
        });
        
        let stderr = '';
        rclone.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        rclone.on('close', (code) => {
          if (code === 0) {
            deleteResolve();
          } else if (stderr.includes('No files found') || stderr.includes('no matching objects')) {
            // No files to delete - that's OK
            deleteResolve();
          } else if (stderr.includes('is a file not a directory')) {
            // This path is a file, not a folder - skip it
            deleteResolve();
          } else {
            deleteReject(new Error(`rclone delete failed with code ${code}: ${stderr.substring(0, 200)}`));
          }
        });
        
        rclone.on('error', deleteReject);
      });
      
      // Step 2: Purge the folder itself to remove directory structure
      const purgeArgs = [...baseArgs, 'purge', '-P', remotePath];
      if (dryRun) {
        purgeArgs.splice(purgeArgs.indexOf('purge') + 1, 0, '--dry-run');
      }
      
      await new Promise((purgeResolve) => {
        const rclone = spawn('rclone', purgeArgs, {
          stdio: 'pipe',
          env: process.env
        });
        
        let stderr = '';
        rclone.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        rclone.on('close', () => {
          // Purge may fail if it's not a directory - that's OK, files are already deleted
          purgeResolve();
        });
        
        rclone.on('error', () => {
          purgeResolve();
        });
      });
      
      // Step 2: Remove empty directory markers
      if (!dryRun) {
        const rmdirsArgs = [...baseArgs, 'rmdirs', '-P', remotePath];
        await new Promise((rmdirsResolve) => {
          const rclone = spawn('rclone', rmdirsArgs, {
            stdio: 'pipe',
            env: process.env
          });
          
          rclone.on('close', () => {
            rmdirsResolve();
          });
          
          rclone.on('error', () => {
            rmdirsResolve();
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


async function deleteFolder(env, folderName, dryRun = false, foldersOnly = false, quiet = false) {
  const startTime = Date.now();
  const parsed = parseFolderPath(folderName);
  const isWildcard = parsed.isWildcard;

  if (!quiet) {
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
  }

  const bucketName = getBucketName(env);
  const { apiToken, accountId, r2AccessKeyId, r2SecretAccessKey } = getCloudflareCredentials(env);

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
  
  if (!quiet) {
    console.log(`${colors.cyan}Using rclone for ${rcloneMethod}...${colors.reset}\n`);
  }
  
  try {
    if (foldersOnly) {
      await deleteFoldersOnlyWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun);
    } else if (isWildcard) {
      await deleteFilesOnlyWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun);
    } else {
      await deleteFolderWithRclone(bucketName, folderName, accountId, r2AccessKeyId, r2SecretAccessKey, env, dryRun);
    }
    const duration = (Date.now() - startTime) / 1000;
    if (!quiet) {
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
    }
    return { deleted: 1, failed: 0, duration };
  } catch (error) {
    throw new Error(`rclone deletion failed: ${error.message}`);
  }
}


async function verifyFolderHasNestedFiles(bucketName, folderPath, accountId, r2AccessKeyId, r2SecretAccessKey) {
  return new Promise((resolve) => {
    let remoteInfo;
    try {
      remoteInfo = getRcloneRemote(bucketName, accountId, r2AccessKeyId, r2SecretAccessKey);
    } catch (error) {
      resolve(false);
      return;
    }
    
    const { remoteName, tempConfigPath, baseArgs } = remoteInfo;
    const folderPathClean = folderPath.replace(/\/$/, '');
    const folderPathWithSlash = `${folderPathClean}/`;
    const remotePath = `${remoteName}:${bucketName}/${folderPathWithSlash}`;
    
    // Use rclone ls to check if there are files inside this folder
    const lsArgs = [...baseArgs, 'ls', '--max-depth', '1', remotePath];
    
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
      
      // If we get output, there are files inside - it's a real folder
      // If no output or error about file not directory, it's not a folder
      if (code === 0 && stdout.trim().length > 0) {
        // Check if output contains actual file paths (not just directory markers)
        const lines = stdout.trim().split('\n').filter(line => line.trim().length > 0);
        // If there are lines that don't end with /, they are files
        const hasFiles = lines.some(line => {
          const trimmed = line.trim();
          return trimmed.length > 0 && !trimmed.endsWith('/');
        });
        resolve(hasFiles);
      } else if (stderr.includes('is a file not a directory')) {
        resolve(false);
      } else {
        resolve(false);
      }
    });
    
    rclone.on('error', () => {
      if (tempConfigPath && fs.existsSync(tempConfigPath)) {
        try {
          fs.unlinkSync(tempConfigPath);
        } catch {
          // Ignore cleanup errors
        }
      }
      resolve(false);
    });
  });
}

async function discoverFolders(env, baseFolder) {
  const bucketName = getBucketName(env);
  const { apiToken, accountId, r2AccessKeyId, r2SecretAccessKey } = getCloudflareCredentials(env);
  
  const prefix = baseFolder.endsWith('/') ? baseFolder : `${baseFolder}/`;
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
    const remotePath = `${remoteName}:${bucketName}/${baseFolder}`;
    
    // Use rclone lsf --dirs-only to list only directories
    const lsfArgs = [...baseArgs, 'lsf', '--dirs-only', '-R', remotePath];
    
    return new Promise((resolve, reject) => {
      const rclone = spawn('rclone', lsfArgs, {
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
      
      rclone.on('close', async (code) => {
        if (tempConfigPath && fs.existsSync(tempConfigPath)) {
          try {
            fs.unlinkSync(tempConfigPath);
          } catch {
            // Ignore cleanup errors
          }
        }
        
        if (code !== 0) {
          // If no directories found, rclone may return non-zero - that's OK
          if (stderr.includes('no directories found') || stderr.includes('directory not found')) {
            console.log(`  ${colors.yellow}No folders found${colors.reset}`);
            resolve([]);
            return;
          }
          reject(new Error(`rclone lsf failed: ${stderr.substring(0, 200)}`));
          return;
        }
        
        // Parse output - each line is a directory path
        // Filter out paths that look like files (have extensions in the last segment)
        const candidateFolders = stdout
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .map(line => {
            // rclone lsf returns paths relative to the remote path
            // Ensure proper path construction with slashes
            let fullPath;
            if (line.startsWith(baseFolder)) {
              fullPath = line;
            } else {
              // Add slash between baseFolder and line if needed
              const baseFolderNormalized = baseFolder.endsWith('/') ? baseFolder.slice(0, -1) : baseFolder;
              const lineNormalized = line.startsWith('/') ? line.slice(1) : line;
              fullPath = `${baseFolderNormalized}/${lineNormalized}`;
            }
            return fullPath;
          })
          .filter(folder => {
            // Remove trailing slash for checking
            const folderWithoutSlash = folder.replace(/\/$/, '');
            // Get the last segment (the folder name itself)
            const lastSegment = folderWithoutSlash.split('/').pop() || '';
            // Skip if last segment has a file extension - these are files, not folders
            // Real folders shouldn't have extensions like .webp, .png, etc.
            if (lastSegment.includes('.') && /\.(webp|png|json|jpg|jpeg|gif|pdf|txt|zip)$/i.test(lastSegment)) {
              return false; // This looks like a file, not a folder
            }
            return true;
          })
          .filter(folder => folder.startsWith(baseFolder) || folder.startsWith(baseFolder.replace(/\/$/, '')))
          .sort();
        
        // Verify each candidate folder actually contains nested files
        console.log(`  ${colors.cyan}Verifying ${candidateFolders.length} candidate folder(s) contain files...${colors.reset}`);
        const verifiedFolders = [];
        
        for (const folder of candidateFolders) {
          const hasFiles = await verifyFolderHasNestedFiles(bucketName, folder, accountId, r2AccessKeyId, r2SecretAccessKey);
          if (hasFiles) {
            verifiedFolders.push(folder);
          }
        }
        
        console.log(`  ${colors.green}Found ${verifiedFolders.length} verified folder(s) with nested files${colors.reset}`);
        if (verifiedFolders.length > 0 && verifiedFolders.length <= 20) {
          verifiedFolders.forEach((folder, index) => {
            console.log(`  ${index + 1}. ${folder}`);
          });
        } else if (verifiedFolders.length > 20) {
          verifiedFolders.slice(0, 20).forEach((folder, index) => {
            console.log(`  ${index + 1}. ${folder}`);
          });
          console.log(`  ... and ${verifiedFolders.length - 20} more`);
        }
        console.log('');
        
        resolve(verifiedFolders);
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
} else if (folderArgs.length > 0 || process.env.DEFAULT_FOLDER) {
  // If no folders specified but DEFAULT_FOLDER env var is set, use it
  if (folderArgs.length === 0 && process.env.DEFAULT_FOLDER) {
    folderArgs.push(...process.env.DEFAULT_FOLDER.split(',').map(f => f.trim()).filter(f => f));
  }
  
  // Check for ** pattern - means discover all folders
  const hasWildcardAll = folderArgs.some(f => f === '**' || f.includes('**'));
  
  // Process folders function - sequential processing
  function processFolders(foldersToProcess) {
    if (foldersToProcess.length > 0) {
      // Process folders sequentially
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
  
  // Handle ** pattern or auto-discover
  if (hasWildcardAll && foldersOnly) {
    // Extract base folder from pattern
    // Handle: "**", "preset/**", or any folder with **
    let baseFolder = 'preset'; // default
    const wildcardArg = folderArgs.find(f => f === '**' || f.includes('**'));
    if (wildcardArg) {
      if (wildcardArg === '**') {
        baseFolder = 'preset'; // default to preset
      } else {
        // Extract base folder from pattern like "preset/**"
        baseFolder = wildcardArg.replace(/\*\*/g, '').replace(/\/$/, '').trim();
        if (!baseFolder) {
          baseFolder = 'preset';
        }
      }
    }
    console.log(`${colors.cyan}=== Discovering all folders in ${baseFolder} ===${colors.reset}\n`);
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
  } else if (autoDiscover && foldersOnly) {
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
  console.error(`Usage: node cleanup-old-thumbnails.js --folder=<folder-name> [--dry-run] [--folders-only]`);
  console.error(`Examples:`);
  console.error(`  # Delete all folders (using ** pattern - must quote in zsh):`);
  console.error(`  node backend-cloudflare-workers/cleanup-old-thumbnails.js --folder="**" --folders-only`);
  console.error(`  # Delete all folders in specific base folder:`);
  console.error(`  node backend-cloudflare-workers/cleanup-old-thumbnails.js --folder="preset/**" --folders-only`);
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
