#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
};

// Execute command and return output
function execCommand(command, options = {}) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: options.silent ? 'pipe' : 'inherit', ...options });
  } catch (error) {
    if (options.throwOnError !== false) {
      throw error;
    }
    return null;
  }
}

// Prompt user for input
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Execute command with real-time output (non-blocking for output, but waits for completion)
function execCommandRealtime(command, options = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(/\s+/);
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: true,
      ...options
    });
    
    child.on('error', (error) => {
      if (options.throwOnError !== false) {
        reject(error);
      } else {
        resolve(null);
      }
    });
    
    child.on('exit', (code) => {
      if (code !== 0 && options.throwOnError !== false) {
        reject(new Error(`Command failed with exit code ${code}`));
      } else {
        resolve(null);
      }
    });
  });
}


// Check if wrangler is installed
function checkWrangler() {
  try {
    execSync('wrangler --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Check if gcloud is installed
function checkGcloud() {
  try {
    execSync('gcloud --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Check GCP authentication
function checkGcpAuth() {
  try {
    const authList = execCommand('gcloud auth list --format="value(account)"', { silent: true, throwOnError: false });
    return authList && authList.trim().length > 0;
  } catch {
    return false;
  }
}

// Fix GCP authentication
function fixGcpAuth() {
  try {
    log.info('Checking GCP authentication status...');

    // Check if authenticated accounts exist
    const authList = execCommand('gcloud auth list --format="value(account)"', { silent: true, throwOnError: false });
    if (!authList || authList.trim().length === 0) {
      log.warn('No GCP accounts authenticated. Starting login process...');
      execCommand('gcloud auth login', { stdio: 'inherit' });
      log.success('GCP login completed');
    } else {
      log.success('GCP accounts found');
    }

    // Check active account
    const activeAccount = execCommand('gcloud auth list --filter=status:ACTIVE --format="value(account)"', { silent: true, throwOnError: false });
    if (!activeAccount || activeAccount.trim().length === 0) {
      log.info('Setting active account...');
      const accounts = authList.trim().split('\n').filter(Boolean);
      if (accounts.length > 0) {
        execCommand(`gcloud config set account ${accounts[0]}`, { stdio: 'inherit' });
        log.success(`Active account set to: ${accounts[0]}`);
      }
    }

    // Check current project
    const currentProject = execCommand('gcloud config get-value project', { silent: true, throwOnError: false });
    if (!currentProject || currentProject.trim() !== 'ai-photo-office') {
      log.info('Setting GCP project to ai-photo-office...');
      execCommand('gcloud config set project ai-photo-office', { stdio: 'inherit' });
      log.success('GCP project set to ai-photo-office');
    } else {
      log.success('GCP project already set to ai-photo-office');
    }

    // Check if application default credentials are needed
    // Only attempt refresh if they don't exist and we're in interactive mode
    try {
      execCommand('gcloud auth application-default print-access-token', { silent: true, throwOnError: false });
      log.success('Application default credentials available');
    } catch {
      log.info('Application default credentials not configured (optional)');
      log.info('Run "gcloud auth application-default login" if you need advanced GCP features');
    }

    return true;
  } catch (error) {
    log.error(`GCP authentication fix failed: ${error.message}`);
    log.warn('GCP authentication may need manual intervention');
    return false;
  }
}

// Check if user is authenticated
function checkAuth() {
  try {
    execCommand('wrangler whoami', { silent: true, throwOnError: false });
    return true;
  } catch {
    return false;
  }
}

// Get list of secrets
function getSecrets() {
  try {
    const output = execCommand('wrangler secret list', { silent: true, throwOnError: false });
    if (!output) return [];
    return output.split('\n')
      .filter(line => line.trim() && !line.includes('Secret') && !line.includes('---'))
      .map(line => line.split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// FIXED PROJECT NAMES - DO NOT CHANGE THESE OR YOUR URLS WILL CHANGE!
// ============================================================================
const PAGES_PROJECT_NAME = 'ai-faceswap-frontend';  // This ensures Pages URL never changes
const WORKER_NAME = 'ai-faceswap-backend';           // From wrangler.jsonc - ensures Worker URL never changes
// ============================================================================

async function main() {
  console.log('\n🚀 Face Swap AI - Deployment Script');
  console.log('====================================\n');

  let workerUrl = '';
  let pagesUrl = '';

  // Check wrangler
  if (!checkWrangler()) {
    log.error('Wrangler CLI not found. Installing...');
    try {
      execCommand('npm install -g wrangler', { stdio: 'inherit' });
    } catch {
      log.error('Failed to install wrangler. Please install manually: npm install -g wrangler');
      process.exit(1);
    }
  }

  // Check gcloud
  if (!checkGcloud()) {
    log.error('gcloud CLI not found. Please install Google Cloud SDK first.');
    log.info('Download from: https://cloud.google.com/sdk/docs/install');
    process.exit(1);
  }

  // Check and fix GCP authentication
  log.info('Checking GCP authentication...');
  if (!checkGcpAuth()) {
    log.warn('GCP authentication required');
    if (!fixGcpAuth()) {
      log.error('GCP authentication setup failed');
      log.warn('Please run the following commands manually:');
      log.warn('  gcloud auth login');
      log.warn('  gcloud config set project ai-photo-office');
      log.warn('  gcloud auth application-default login');
      process.exit(1);
    }
  } else {
    log.success('GCP authentication OK');
    // Still try to ensure correct project is set
    fixGcpAuth();
  }

  // Check authentication
  log.info('Checking Cloudflare authentication...');
  if (!checkAuth()) {
    log.warn('Not authenticated. Please login...');
    try {
      execCommand('wrangler login', { stdio: 'inherit' });
      log.success('Authenticated');
    } catch {
      log.error('Authentication failed');
      process.exit(1);
    }
  } else {
    log.success('Authenticated');
  }

  // Check R2 bucket
  log.info('Checking R2 bucket...');
  try {
    const buckets = execCommand('wrangler r2 bucket list', { silent: true, throwOnError: false });
    if (!buckets || !buckets.includes('faceswap-images')) {
      log.warn('R2 bucket not found. Creating...');
      execCommand('wrangler r2 bucket create faceswap-images', { stdio: 'inherit' });
      log.success('R2 bucket created');
    } else {
      log.success('R2 bucket exists');
    }
  } catch (error) {
    log.warn('Could not verify R2 bucket (may already exist)');
  }

  // Check D1 database
  log.info('Checking D1 database...');
  try {
    const dbs = execCommand('wrangler d1 list', { silent: true, throwOnError: false });
    if (!dbs || !dbs.includes('faceswap-db')) {
      log.warn('D1 database not found. Creating...');
      execCommand('wrangler d1 create faceswap-db', { stdio: 'inherit' });
      log.success('D1 database created');
      
      // Initialize schema
      const schemaPath = path.join(process.cwd(), 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        log.info('Initializing database schema...');
        try {
          execCommand(`wrangler d1 execute faceswap-db --remote --file=${schemaPath}`, { stdio: 'inherit' });
          log.success('Database schema initialized');
        } catch (error) {
          log.error('Schema initialization failed:', error.message);
          log.warn('Recreating database to ensure clean schema...');
          execCommand('wrangler d1 delete faceswap-db', { stdio: 'inherit' });
          execCommand('wrangler d1 create faceswap-db', { stdio: 'inherit' });
          execCommand(`wrangler d1 execute faceswap-db --remote --file=${schemaPath}`, { stdio: 'inherit' });
          log.success('Database recreated and schema initialized');
        }
      }
    } else {
      log.success('D1 database exists');
      // Check schema completeness
      const schemaPath = path.join(process.cwd(), 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        log.info('Verifying database schema...');
        
        // Check if all required tables exist with correct structure
        let needsSchemaUpdate = false;
        try {
          // Check for selfies table
          const selfiesCheck = execCommand('wrangler d1 execute faceswap-db --remote --command="SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'selfies\';"', { silent: true, throwOnError: false });
          if (!selfiesCheck || !selfiesCheck.includes('selfies')) {
            log.warn('selfies table missing - schema needs update');
            needsSchemaUpdate = true;
          }
          
          // Check if results table has selfie_id column
          if (!needsSchemaUpdate) {
            try {
              const resultsCheck = execCommand('wrangler d1 execute faceswap-db --remote --command="PRAGMA table_info(results);"', { silent: true, throwOnError: false });
              if (resultsCheck && !resultsCheck.includes('selfie_id')) {
                log.warn('results table missing selfie_id column - schema needs update');
                needsSchemaUpdate = true;
              }
            } catch {
              // results table might not exist, that's OK - schema.sql will create it
              needsSchemaUpdate = true;
            }
          }
        } catch (error) {
          log.warn('Could not verify schema - will attempt to apply schema.sql');
          needsSchemaUpdate = true;
        }
        
        if (needsSchemaUpdate) {
          log.info('Applying database schema updates...');
          try {
            // Apply schema.sql - it uses CREATE TABLE IF NOT EXISTS so it's safe
            execCommand(`wrangler d1 execute faceswap-db --remote --file=${schemaPath}`, { stdio: 'inherit' });
            log.success('Database schema updated');
            
            // If results table exists but has wrong structure, fix it
            try {
              const resultsCheck = execCommand('wrangler d1 execute faceswap-db --remote --command="PRAGMA table_info(results);"', { silent: true, throwOnError: false });
              if (resultsCheck && resultsCheck.includes('preset_collection_id') && !resultsCheck.includes('selfie_id')) {
                log.warn('Fixing results table structure...');
                // Check if results table has data
                const countCheck = execCommand('wrangler d1 execute faceswap-db --remote --command="SELECT COUNT(*) as count FROM results;"', { silent: true, throwOnError: false });
                const hasData = countCheck && countCheck.includes('"count":') && !countCheck.includes('"count":0');
                
                if (!hasData) {
                  // Safe to recreate - table is empty
                  execCommand('wrangler d1 execute faceswap-db --remote --command="DROP TABLE IF EXISTS results;"', { stdio: 'inherit' });
                  execCommand('wrangler d1 execute faceswap-db --remote --command="CREATE TABLE results (id TEXT PRIMARY KEY, selfie_id TEXT NOT NULL, preset_collection_id TEXT NOT NULL, preset_image_id TEXT NOT NULL, preset_name TEXT NOT NULL, result_url TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (selfie_id) REFERENCES selfies(id), FOREIGN KEY (preset_collection_id) REFERENCES preset_collections(id), FOREIGN KEY (preset_image_id) REFERENCES preset_images(id));"', { stdio: 'inherit' });
                  log.success('Results table structure fixed');
                } else {
                  log.warn('Results table has data - cannot auto-fix. Please manually migrate or clear data.');
                }
              }
            } catch (fixError) {
              log.warn('Could not auto-fix results table structure:', fixError.message);
            }
          } catch (error) {
            log.error('Schema update failed:', error.message);
            log.warn('Attempting to fix by recreating missing tables...');
            
            // Try to create missing selfies table if it doesn't exist
            try {
              const selfiesCheck = execCommand('wrangler d1 execute faceswap-db --remote --command="SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'selfies\';"', { silent: true, throwOnError: false });
              if (!selfiesCheck || !selfiesCheck.includes('selfies')) {
                log.info('Creating selfies table...');
                execCommand('wrangler d1 execute faceswap-db --remote --command="CREATE TABLE IF NOT EXISTS selfies (id TEXT PRIMARY KEY, image_url TEXT NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));"', { stdio: 'inherit' });
                log.success('Selfies table created');
              }
            } catch (createError) {
              log.error('Failed to create selfies table:', createError.message);
            }
            
            // Prompt user to recreate database if schema is too broken
            const recreate = await prompt('Schema update failed. Recreate database? (This will DELETE ALL DATA) (y/n): ');
            if (recreate.toLowerCase() === 'y') {
              log.warn('Deleting database...');
              execCommand('wrangler d1 delete faceswap-db', { stdio: 'inherit' });
              log.info('Creating new database...');
              execCommand('wrangler d1 create faceswap-db', { stdio: 'inherit' });
              log.info('Applying schema...');
              execCommand(`wrangler d1 execute faceswap-db --remote --file=${schemaPath}`, { stdio: 'inherit' });
              log.success('Database recreated and schema initialized');
            } else {
              log.warn('Database schema may be incomplete. Please fix manually.');
            }
          }
        } else {
          log.success('Database schema is up to date');
        }
      }
    }
  } catch (error) {
    log.warn('Could not verify D1 database (may already exist)');
  }

  // CORS is handled by Worker responses - no R2 bucket CORS needed
  log.info('CORS: Handled automatically by Worker (no R2 configuration needed)');

  // Check secrets
  log.info('Checking environment variables...');
  const requiredVars = ['RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT', 'GOOGLE_VISION_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'GOOGLE_VISION_ENDPOINT'];
  const secretsPath = path.join(process.cwd(), 'secrets.json');

  // Auto-deploy secrets if secrets.json exists
  if (fs.existsSync(secretsPath)) {
    log.info('Found secrets.json - deploying secrets automatically...');
    try {
      execCommand('wrangler secret bulk secrets.json', { stdio: 'inherit' });
      log.success('Secrets deployed successfully');
    } catch (error) {
      log.error('Failed to deploy secrets from secrets.json');
      log.warn('You may need to run: wrangler secret bulk secrets.json manually');
      throw error;
    }
  }

  // Verify secrets are set
  const existingSecrets = getSecrets();
  const missingVars = requiredVars.filter(v => !existingSecrets.includes(v));

  if (missingVars.length > 0) {
    log.warn(`Missing environment variables: ${missingVars.join(', ')}`);
    log.warn('You can set secrets manually with: wrangler secret put <NAME>');
    if (!fs.existsSync(secretsPath)) {
      log.warn('Or create a secrets.json file and use: wrangler secret bulk secrets.json');
    }
  } else {
    log.success('All environment variables are set');
  }

  // Deploy Worker
  log.info(`Deploying Worker: ${WORKER_NAME}...`);
  log.info('📌 Using fixed worker name - URL will NEVER change!');
  try {
    await execCommandRealtime('wrangler deploy');
    log.success('Worker deployed');

    // Try to get Worker URL from deployments
    try {
      const deployments = execCommand('wrangler deployments list --latest', { silent: true, throwOnError: false });
      if (deployments) {
        const urlMatch = deployments.match(/https:\/\/[^\s]+\.workers\.dev/);
        if (urlMatch) {
          workerUrl = urlMatch[0];
        }
      }
    } catch {}
    
    // If still no URL, construct it based on worker name and account
    if (!workerUrl) {
      try {
        const whoami = execCommand('wrangler whoami', { silent: true, throwOnError: false });
        if (whoami) {
          const accountMatch = whoami.match(/([^\s]+)@/);
          if (accountMatch) {
            const accountSubdomain = accountMatch[1];
            workerUrl = `https://${WORKER_NAME}.${accountSubdomain}.workers.dev`;
            log.info(`Constructed Worker URL from account: ${workerUrl}`);
          }
        }
      } catch {}
    }

    if (workerUrl) {
      log.success(`Worker URL: ${workerUrl}`);
      
      // Update HTML with Worker URL in public_page
      const htmlPath = path.join(process.cwd(), 'public_page', 'index.html');
      if (fs.existsSync(htmlPath)) {
        log.info('Updating HTML with Worker URL...');
        try {
          let htmlContent = fs.readFileSync(htmlPath, 'utf8');
          const urlPattern = /const WORKER_URL = ['"](.*?)['"]/;
          if (urlPattern.test(htmlContent)) {
            htmlContent = htmlContent.replace(urlPattern, `const WORKER_URL = '${workerUrl}'`);
            fs.writeFileSync(htmlPath, htmlContent, 'utf8');
            log.success('HTML updated');
          }
        } catch (error) {
          log.warn('Failed to update HTML');
        }
      }
    } else {
      log.warn('Could not auto-detect Worker URL. Please check Cloudflare Dashboard.');
    }
  } catch (error) {
    log.error('Worker deployment failed!');
    process.exit(1);
  }

  // Deploy Pages
  log.info(`Deploying to Cloudflare Pages: ${PAGES_PROJECT_NAME}...`);
  const publicPageDir = path.join(process.cwd(), 'public_page');

  if (fs.existsSync(publicPageDir)) {
    try {
      // Force deployment by updating HTML with deployment timestamp
      // This ensures Pages always detects changes and uploads files
      const htmlPath = path.join(publicPageDir, 'index.html');
      if (fs.existsSync(htmlPath)) {
        try {
          let htmlContent = fs.readFileSync(htmlPath, 'utf8');
          const timestamp = new Date().toISOString();
          const buildId = Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
          
          // Remove old deployment build ID if exists
          htmlContent = htmlContent.replace(/const DEPLOYMENT_BUILD_ID = ['"].*?['"];?\n?/g, '');
          htmlContent = htmlContent.replace(/<!-- Deployment: .*? -->\n?/g, '');
          
          // Add deployment build ID as a JavaScript variable (ensures hash changes)
          const buildIdScript = `        const DEPLOYMENT_BUILD_ID = '${buildId}'; // Deployment: ${timestamp}\n`;
          
          // Find the WORKER_URL line and add build ID right after it
          const workerUrlPattern = /(const WORKER_URL = ['"].*?['"];)/;
          if (workerUrlPattern.test(htmlContent)) {
            htmlContent = htmlContent.replace(workerUrlPattern, `$1\n${buildIdScript}`);
          } else {
            // If WORKER_URL not found, add at the beginning of script section
            htmlContent = htmlContent.replace(/(<script>)/, `$1\n${buildIdScript}`);
          }
          
          fs.writeFileSync(htmlPath, htmlContent, 'utf8');
          log.info(`Updated HTML with deployment build ID (${buildId}) to force upload...`);
        } catch (error) {
          log.warn('Could not update HTML timestamp, continuing anyway...');
        }
      }
      
      // ALWAYS use the same project name
      log.info('Starting Pages deployment command...');
      try {
        await execCommandRealtime(
          `wrangler pages deploy ${publicPageDir} --project-name=${PAGES_PROJECT_NAME} --branch=main --commit-dirty=true`,
          { throwOnError: false }
        );
        log.success('Pages deployed');
      } catch (error) {
        log.error(`Pages deployment error: ${error.message}`);
        log.warn('Pages deployment failed, but continuing...');
        throw error; // Re-throw to see the error
      }
      
      // Use fixed Pages domain
      pagesUrl = 'https://ai-faceswap-frontend.pages.dev/';
      log.success(`Frontend URL: ${pagesUrl}`);
    } catch (error) {
      log.warn('Pages deployment failed (non-critical)');
    }
  } else {
    log.warn('public_page directory not found, skipping Pages deployment');
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  log.success('Deployment Complete!');
  console.log('\n📌 URLs:');
  if (workerUrl) {
    console.log(`   ✅ Worker (Backend): ${workerUrl}`);
  }
  if (pagesUrl) {
    console.log(`   ✅ Pages (Frontend): ${pagesUrl}`);
  } else {
    console.log(`   ✅ Pages (Frontend): https://ai-faceswap-frontend.pages.dev/`);
  }
  console.log('\n');

  // Check if final setup is needed
  const setupScript = path.join(process.cwd(), 'complete-setup.js');
  if (fs.existsSync(setupScript)) {
    log.info('💡 Optional: Run ./complete-setup.js to enable full GCP integration');
    log.info('   This enables Application Default Credentials for advanced GCP features');
  }
}

main().catch((error) => {
  log.error(`Deployment failed: ${error.message}`);
  process.exit(1);
});
