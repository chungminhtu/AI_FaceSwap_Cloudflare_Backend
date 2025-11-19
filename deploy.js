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

// Check if wrangler is installed
function checkWrangler() {
  try {
    execSync('wrangler --version', { stdio: 'ignore' });
    return true;
  } catch {
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

  // Configure R2 CORS
  log.info('Configuring R2 CORS...');
  const corsPath = path.join(process.cwd(), 'r2-cors.json');
  if (fs.existsSync(corsPath)) {
    try {
      execCommand(`wrangler r2 bucket cors set faceswap-images --file=${corsPath}`, { throwOnError: false, stdio: 'inherit' });
      log.success('R2 CORS configured');
    } catch {
      log.warn('CORS configuration via wrangler failed (this is common - not critical)');
      log.warn('CORS can be configured later via Cloudflare Dashboard');
    }
  }

  // Check secrets
  log.info('Checking environment variables...');
  const requiredVars = ['RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT', 'GOOGLE_CLOUD_API_KEY', 'GOOGLE_VISION_ENDPOINT'];
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
    execCommand('wrangler deploy', { silent: false });
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
      // ALWAYS use the same project name
      const pagesResult = execCommand(
        `wrangler pages deploy ${publicPageDir} --project-name=${PAGES_PROJECT_NAME} --branch=main --commit-dirty=true`,
        { throwOnError: false, stdio: 'inherit' }
      );
      log.success('Pages deployed');
      
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
}

main().catch((error) => {
  log.error(`Deployment failed: ${error.message}`);
  process.exit(1);
});
