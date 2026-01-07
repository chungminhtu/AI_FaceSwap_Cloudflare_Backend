#!/usr/bin/env node
/**
 * Script to extract a zip file and upload all contents to Cloudflare R2
 * Maintains exact folder structure from the zip file
 * Overwrites existing files in R2
 * Uses parallel uploads for maximum speed (default: 100 concurrent uploads)
 * 
 * Usage:
 *   node upload-zip-to-r2.js <zip-file-path> [environment] [bucket-name] [prefix] [concurrency]
 * 
 * Examples:
 *   node upload-zip-to-r2.js ./files.zip ai-office
 *   node upload-zip-to-r2.js ./files.zip ai-office-dev faceswap-images-office-dev
 *   node upload-zip-to-r2.js ./files.zip ai-office faceswap-images preset/
 *   node upload-zip-to-r2.js ./files.zip ai-office faceswap-images "" 150
 * 
 * Concurrency: Number of parallel uploads (default: 100, max: 200)
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const JSZip = require('jszip');
const os = require('os');

// Parse command line arguments
const zipFilePath = process.argv[2];
const environment = process.argv[3] || 'ai-office';
const bucketName = process.argv[4] || null; // Will be read from config if not provided
// Handle prefix and concurrency - if 5th arg is a number, it's concurrency (no prefix)
// Otherwise, 5th is prefix and 6th is concurrency
let prefix = '';
let concurrencyArg;
if (process.argv[5] && !isNaN(parseInt(process.argv[5], 10))) {
  // 5th arg is a number, so it's concurrency (no prefix)
  concurrencyArg = process.argv[5];
} else {
  // 5th arg is prefix (or empty), 6th is concurrency
  prefix = process.argv[5] || '';
  concurrencyArg = process.argv[6];
}
const concurrency = concurrencyArg ? parseInt(concurrencyArg, 10) : 100; // Default to 100 parallel uploads

if (!zipFilePath) {
  console.error('Usage: node upload-zip-to-r2.js <zip-file-path> [environment] [bucket-name] [prefix] [concurrency]');
  console.error('  concurrency: Number of parallel uploads (default: 100, max: 200)');
  process.exit(1);
}

if (isNaN(concurrency) || concurrency < 1 || concurrency > 200) {
  console.error('Error: Concurrency must be a number between 1 and 200');
  process.exit(1);
}

// Check if zip file exists
if (!fs.existsSync(zipFilePath)) {
  console.error(`Error: Zip file not found: ${zipFilePath}`);
  process.exit(1);
}

// Load deployment secrets
const secretsPath = path.join(__dirname, 'deployments-secrets.json');
if (!fs.existsSync(secretsPath)) {
  console.error(`Error: Deployment secrets not found: ${secretsPath}`);
  process.exit(1);
}

const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
const envConfig = secrets.environments?.[environment];

if (!envConfig?.cloudflare) {
  console.error(`Error: No Cloudflare config found for environment: ${environment}`);
  process.exit(1);
}

const { apiToken, accountId, r2AccessKeyId, r2SecretAccessKey } = envConfig.cloudflare;
if (!apiToken || !accountId) {
  console.error(`Error: Missing API token or account ID for environment: ${environment}`);
  process.exit(1);
}

// Use bucket name from config if not provided
const targetBucket = bucketName || envConfig.bucketName;
if (!targetBucket) {
  console.error(`Error: Bucket name not specified and not found in config for environment: ${environment}`);
  process.exit(1);
}

// Set environment variables for wrangler
process.env.CLOUDFLARE_API_TOKEN = apiToken;
process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

// Create temporary directory for extraction
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-upload-'));

console.log(`\n📦 Extracting zip file: ${zipFilePath}`);
console.log(`📁 Temporary directory: ${tempDir}`);
console.log(`☁️  Target R2 bucket: ${targetBucket}`);
console.log(`🌍 Environment: ${environment}`);
if (prefix) {
  console.log(`📂 Prefix: ${prefix}`);
}
console.log(`⚡ Concurrency: ${concurrency} parallel uploads`);
console.log('');

async function extractZip(zipPath, extractTo) {
  try {
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);
    
    const files = [];
    const extractPromises = [];
    
    // Extract all files
    for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) {
        // Create directory
        const dirPath = path.join(extractTo, relativePath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
      } else {
        // Extract file
        const filePath = path.join(extractTo, relativePath);
        const dirPath = path.dirname(filePath);
        
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        
        extractPromises.push(
          zipEntry.async('nodebuffer').then(buffer => {
            fs.writeFileSync(filePath, buffer);
            files.push({
              localPath: filePath,
              r2Key: relativePath.replace(/\\/g, '/'), // Normalize path separators
              size: buffer.length
            });
          })
        );
      }
    }
    
    await Promise.all(extractPromises);
    return files;
  } catch (error) {
    throw new Error(`Failed to extract zip: ${error.message}`);
  }
}

async function uploadFileToR2WithWrangler(localPath, r2Key, bucket, prefix, maxRetries = 5) {
  return new Promise((resolve, reject) => {
    // Construct the full R2 key with prefix
    const fullKey = prefix ? `${prefix.replace(/\/$/, '')}/${r2Key}` : r2Key;
    
    // Wrangler command: wrangler r2 object put "bucket/key" --file "local-path"
    const objectPath = `${bucket}/${fullKey}`;
    const args = ['r2', 'object', 'put', objectPath, '--file', localPath];
    
    const env = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: accountId
    };
    
    let attempt = 0;
    
    const tryUpload = () => {
      attempt++;
      const wrangler = spawn('wrangler', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      wrangler.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      wrangler.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      wrangler.on('close', (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          const errorMsg = stderr || stdout || 'Unknown error';
          
          // Check if it's a retryable error
          const isRetryable = 
            errorMsg.includes('rate limit') || 
            errorMsg.includes('Rate limited') || 
            errorMsg.includes('429') ||
            errorMsg.includes('500') ||
            errorMsg.includes('response.statusCode = 500') ||
            errorMsg.includes('Network connection lost') ||
            errorMsg.includes('connection lost') ||
            errorMsg.includes('timeout') ||
            errorMsg.includes('ECONNRESET') ||
            errorMsg.includes('ETIMEDOUT') ||
            errorMsg.includes('Unspecified error');
          
          if (isRetryable && attempt < maxRetries) {
            // Exponential backoff: wait 1s, 2s, 4s, 8s
            const waitTime = Math.pow(2, attempt - 1) * 1000;
            setTimeout(() => {
              tryUpload();
            }, waitTime);
            return;
          }
          
          reject(new Error(errorMsg.substring(0, 200)));
        }
      });
      
      wrangler.on('error', (error) => {
        // Network errors are retryable
        if (attempt < maxRetries) {
          const waitTime = Math.pow(2, attempt - 1) * 1000;
          setTimeout(() => {
            tryUpload();
          }, waitTime);
        } else {
          reject(error);
        }
      });
    };
    
    tryUpload();
  });
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

async function uploadFolderWithRclone(tempDir, bucket, prefix, accountId, r2AccessKeyId, r2SecretAccessKey) {
  return new Promise((resolve, reject) => {
    const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    
    console.log('🚀 Using rclone for fast folder upload...\n');
    
    const sourcePath = tempDir;
    let remoteName;
    let args;
    let tempConfigPath = null;
    
    // Try to use pre-configured remote first
    const preConfiguredRemote = getRcloneRemoteName();
    
    if (preConfiguredRemote) {
      remoteName = preConfiguredRemote;
      const destPath = prefix 
        ? `${remoteName}:${bucket}/${prefix.replace(/\/$/, '')}/` 
        : `${remoteName}:${bucket}/`;
      args = [
        'copy',
        sourcePath,
        destPath,
        '--transfers', '50',  // 50 parallel file transfers
        '--checkers', '50',   // 50 parallel checks
        '--progress',
        '--stats', '1s'       // Show stats every second
      ];
      console.log(`  Using pre-configured rclone remote: ${remoteName}\n`);
    } else if (r2AccessKeyId && r2SecretAccessKey) {
      // Create temporary rclone config file
      const tempConfigDir = os.tmpdir();
      tempConfigPath = path.join(tempConfigDir, `rclone-upload-${Date.now()}.conf`);
      const configContent = `[r2]
type = s3
provider = Cloudflare
access_key_id = ${r2AccessKeyId}
secret_access_key = ${r2SecretAccessKey}
endpoint = ${endpoint}
`;
      fs.writeFileSync(tempConfigPath, configContent);
      remoteName = 'r2';
      const destPath = prefix 
        ? `${remoteName}:${bucket}/${prefix.replace(/\/$/, '')}/` 
        : `${remoteName}:${bucket}/`;
      args = [
        '--config', tempConfigPath,
        'copy',
        sourcePath,
        destPath,
        '--transfers', '50',  // 50 parallel file transfers
        '--checkers', '50',   // 50 parallel checks
        '--progress',
        '--stats', '1s'       // Show stats every second
      ];
      console.log(`  Using temporary rclone config with R2 credentials\n`);
    } else {
      reject(new Error('No rclone remote configured and R2 access keys not provided. Either run "rclone config" or add r2AccessKeyId and r2SecretAccessKey to deployments-secrets.json'));
      return;
    }
    
    const rclone = spawn('rclone', args, {
      env: process.env,
      stdio: 'inherit'
    });
    
    rclone.on('close', (code) => {
      // Clean up temporary config file
      if (tempConfigPath && fs.existsSync(tempConfigPath)) {
        try {
          fs.unlinkSync(tempConfigPath);
        } catch {
          // Ignore cleanup errors
        }
      }
      
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(`rclone upload failed with code ${code}`));
      }
    });
    
    rclone.on('error', (error) => {
      // Clean up temporary config file
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
}

async function uploadBatch(files, bucket, prefix, concurrency = 20) {
  let successCount = 0;
  let failCount = 0;
  const failedFiles = [];
  let completed = 0;
  
  // Process files with concurrency limit using a queue
  const queue = [...files];
  const active = new Set();
  
  const processNext = async () => {
    if (queue.length === 0 && active.size === 0) {
      return;
    }
    
    if (queue.length === 0 || active.size >= concurrency) {
      return;
    }
    
    const file = queue.shift();
    active.add(file);
    
    const uploadPromise = (async () => {
      try {
        await uploadFileToR2WithWrangler(file.localPath, file.r2Key, bucket, prefix);
        completed++;
        const progress = `[${completed}/${files.length}]`;
        console.log(`${progress} ✅ ${file.r2Key} (${(file.size / 1024).toFixed(2)} KB)`);
        successCount++;
      } catch (error) {
        completed++;
        const progress = `[${completed}/${files.length}]`;
        console.error(`${progress} ❌ ${file.r2Key}: ${error.message}`);
        failCount++;
        failedFiles.push({ key: file.r2Key, error: error.message });
      } finally {
        active.delete(file);
        // Process next file
        await processNext();
      }
    })();
    
    // Process next file immediately if we have capacity
    if (active.size < concurrency) {
      processNext();
    }
  };
  
  // Start initial batch
  const initialBatch = Math.min(concurrency, files.length);
  for (let i = 0; i < initialBatch; i++) {
    processNext();
  }
  
  // Wait for all uploads to complete
  while (active.size > 0 || queue.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return { successCount, failCount, failedFiles };
}

async function main() {
  try {
    // Extract zip file
    const files = await extractZip(zipFilePath, tempDir);
    
    console.log(`✅ Extracted ${files.length} files\n`);
    
    const startTime = Date.now();
    let successCount, failCount, failedFiles;
    
    // Try to use rclone for folder upload (much faster)
    // rclone can be used if:
    // 1. rclone is installed AND
    // 2. Either rclone is pre-configured OR r2AccessKeyId/r2SecretAccessKey are in secrets
    const rcloneAvailable = checkRcloneAvailable();
    const hasAccessKeys = r2AccessKeyId && r2SecretAccessKey;
    const hasPreConfiguredRemote = getRcloneRemoteName() !== null;
    const useRclone = rcloneAvailable && (hasAccessKeys || hasPreConfiguredRemote);
    
    if (useRclone) {
      try {
        console.log('📤 Uploading folder to R2 using rclone (fast batch upload)...\n');
        await uploadFolderWithRclone(tempDir, targetBucket, prefix, accountId, r2AccessKeyId, r2SecretAccessKey);
        successCount = files.length;
        failCount = 0;
        failedFiles = [];
        console.log(`\n✅ Successfully uploaded ${files.length} files using rclone\n`);
      } catch (rcloneError) {
        console.log(`\n⚠️  rclone upload failed: ${rcloneError.message}`);
        console.log('📤 Falling back to wrangler (file-by-file upload)...\n');
        console.log(`⚡ Using ${concurrency} concurrent uploads\n`);
        
        const result = await uploadBatch(
          files, 
          targetBucket, 
          prefix,
          concurrency
        );
        successCount = result.successCount;
        failCount = result.failCount;
        failedFiles = result.failedFiles;
      }
    } else {
      // Use wrangler (file-by-file)
      console.log('📤 Uploading files to R2 in parallel batches (using wrangler)...\n');
      console.log(`⚡ Using ${concurrency} concurrent uploads for maximum speed\n`);
      if (rcloneAvailable && !hasAccessKeys && !hasPreConfiguredRemote) {
        console.log('💡 Tip: Add r2AccessKeyId and r2SecretAccessKey to deployments-secrets.json to use rclone for faster folder uploads\n');
      } else if (!rcloneAvailable) {
        console.log('💡 Tip: Install rclone (brew install rclone) for faster folder uploads\n');
      }
      
      const result = await uploadBatch(
        files, 
        targetBucket, 
        prefix,
        concurrency
      );
      successCount = result.successCount;
      failCount = result.failCount;
      failedFiles = result.failedFiles;
    }
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    // Cleanup temporary directory
    console.log('\n🧹 Cleaning up temporary files...');
    fs.rmSync(tempDir, { recursive: true, force: true });
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Upload Summary:');
    console.log(`   ✅ Success: ${successCount} files`);
    console.log(`   ❌ Failed: ${failCount} files`);
    console.log(`   📦 Total: ${files.length} files`);
    console.log(`   ⏱️  Duration: ${duration} seconds`);
    console.log(`   🚀 Speed: ${(files.length / parseFloat(duration)).toFixed(2)} files/second`);
    console.log('='.repeat(60));
    
    if (failedFiles.length > 0) {
      console.log('\n❌ Failed files (first 10):');
      failedFiles.slice(0, 10).forEach(({ key, error }) => {
        console.log(`   - ${key}: ${error}`);
      });
      if (failedFiles.length > 10) {
        console.log(`   ... and ${failedFiles.length - 10} more failed files`);
      }
      process.exit(1);
    } else {
      console.log('\n🎉 All files uploaded successfully!');
    }
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    console.error(error.stack);
    
    // Cleanup on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    
    process.exit(1);
  }
}

// Run the script
main();


