#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

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

// Execute command with logs but reduced verbosity
function executeWithLogs(command, cwd, stepName, reportProgress) {
  return new Promise((resolve, reject) => {
    const isProduction = process.env.NODE_ENV === 'production';

    const child = spawn(command, [], {
      cwd: cwd || process.cwd(),
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let lastProgressUpdate = Date.now();
    let commandStarted = false;

    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;

      // Only log important status messages, not every line
      const lines = output.split('\n').filter(line => line.trim());
      for (const line of lines) {
        const trimmed = line.trim();

        // Log important status updates only
        if (trimmed.includes('Uploaded') && trimmed.includes('sec')) {
          console.log(`✓ ${stepName}: ${trimmed}`);
        } else if (trimmed.includes('Deployed') && trimmed.includes('sec')) {
          console.log(`✓ ${stepName}: ${trimmed}`);
        } else if (trimmed.includes('Success! Uploaded')) {
          console.log(`✓ ${stepName}: ${trimmed}`);
        } else if (trimmed.includes('Deployment complete!')) {
          console.log(`✓ ${stepName}: ${trimmed}`);
        } else if (trimmed.includes('✨ Successfully created secret')) {
          console.log(`✓ ${trimmed}`);
        } else if (trimmed.includes('Finished processing secrets file')) {
          console.log(`✓ Secrets upload completed`);
        } else if (trimmed.startsWith('?') && trimmed.includes('Ok to proceed?')) {
          // Handle D1 database confirmation automatically
          console.log('✓ Confirming D1 database operation...');
          child.stdin.write('y\n');
        } else if (trimmed.includes('Error') || trimmed.includes('✘')) {
          console.log(`✗ ${stepName}: ${trimmed}`);
        } else if (stepName === 'deploy-pages') {
          // For Pages deployment, show all important output
          // Skip empty lines, warnings about wrangler.json, and telemetry messages
          if (trimmed && 
              !trimmed.includes('telemetry') && 
              !trimmed.includes('update available') &&
              !trimmed.includes('─────────────────') &&
              !trimmed.startsWith('⛅️ wrangler')) {
            // Show all non-empty, non-telemetry lines for Pages
            console.log(`ℹ ${stepName}: ${trimmed}`);
          }
        }

        // Send progress updates less frequently
        const now = Date.now();
        if (now - lastProgressUpdate > 2000) { // Update every 2 seconds
          if (reportProgress && !commandStarted) {
            reportProgress(stepName, 'running', trimmed);
            commandStarted = true;
          }
          lastProgressUpdate = now;
        }
      }
    });

    child.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;

      // Log errors immediately
      const lines = output.split('\n').filter(line => line.trim());
      for (const line of lines) {
        if (line.trim()) {
          console.log(`✗ ${stepName}: ${line.trim()}`);
        }
      }
    });

    child.on('close', (code) => {
      const result = {
        success: code === 0,
        stdout: stdout,
        stderr: stderr,
        exitCode: code,
        error: code !== 0 ? stderr || stdout : null
      };

      if (reportProgress) {
        reportProgress(stepName, result.success ? 'completed' : 'error',
          result.success ? 'Completed successfully' : `Failed with code ${code}`);
      }

      if (result.success) {
        resolve(result);
      } else {
        reject(new Error(result.error || `Command failed with code ${code}`));
      }
    });

    child.on('error', (error) => {
      console.log(`✗ ${stepName}: Process error - ${error.message}`);
      reject(error);
    });
  });
}

// ============================================================================
// DEFAULT PROJECT NAMES - Can be overridden via config or CLI args
// ============================================================================
const DEFAULT_PAGES_PROJECT_NAME = 'ai-faceswap-frontend';
const DEFAULT_WORKER_NAME = 'ai-faceswap-backend';
const DEFAULT_D1_DATABASE_NAME = 'faceswap-db';
const DEFAULT_R2_BUCKET_NAME = 'faceswap-images';
// ============================================================================

// Parse command line arguments for CLI usage
function parseCliArgs() {
  const args = process.argv.slice(2);

  // Only allow help flag
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    showHelp();
    process.exit(0);
  }

  // No other arguments allowed
  if (args.length > 0) {
    console.error('No command line arguments allowed. Configuration must be in secrets.json');
    console.error('Run "node deploy.js --help" for usage information.');
    process.exit(1);
  }

  return {};
}

// Load configuration from secrets.json (flat structure)
function loadSecretsConfig() {
  const secretsPath = path.join(process.cwd(), 'secrets.json');

  try {
    if (!fs.existsSync(secretsPath)) {
      console.error('secrets.json not found. Please create secrets.json with your configuration.');
      console.log('Example secrets.json:');
      console.log(JSON.stringify({
        workerName: 'my-store-backend',
        pagesProjectName: 'my-store-frontend',
        databaseName: 'my-store-db',
        bucketName: 'my-store-images',
        RAPIDAPI_KEY: 'your_key_here',
        RAPIDAPI_HOST: 'ai-face-swap2.p.rapidapi.com',
        RAPIDAPI_ENDPOINT: 'https://ai-face-swap2.p.rapidapi.com/public/process/urls',
        GOOGLE_VISION_API_KEY: 'your_vision_key',
        GOOGLE_VERTEX_PROJECT_ID: 'your-gcp-project-id',
        GOOGLE_VERTEX_LOCATION: 'us-central1',
        GOOGLE_VISION_ENDPOINT: 'https://vision.googleapis.com/v1/images:annotate',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'your-service-account@project.iam.gserviceaccount.com',
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n'
      }, null, 2));
      process.exit(1);
    }

    const content = fs.readFileSync(secretsPath, 'utf8');
    return parseConfigObject(JSON.parse(content));
  } catch (error) {
    console.error(`Error loading secrets.json:`, error.message);
    process.exit(1);
  }
}

// Parse and validate configuration object
function parseConfigObject(config) {
  // Validate required fields
  const requiredFields = [
    'workerName', 'pagesProjectName', 'databaseName', 'bucketName',
    'RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT',
    'GOOGLE_VISION_API_KEY', 'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_VISION_ENDPOINT',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'
  ];

  const missingFields = requiredFields.filter(field => !config[field]);
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
  }

  return {
    workerName: config.workerName,
    pagesProjectName: config.pagesProjectName,
    databaseName: config.databaseName,
    bucketName: config.bucketName,
    secrets: {
      RAPIDAPI_KEY: config.RAPIDAPI_KEY,
      RAPIDAPI_HOST: config.RAPIDAPI_HOST,
      RAPIDAPI_ENDPOINT: config.RAPIDAPI_ENDPOINT,
      GOOGLE_VISION_API_KEY: config.GOOGLE_VISION_API_KEY,
      GOOGLE_VERTEX_PROJECT_ID: config.GOOGLE_VERTEX_PROJECT_ID,
      GOOGLE_VERTEX_LOCATION: config.GOOGLE_VERTEX_LOCATION || 'us-central1',
      GOOGLE_VISION_ENDPOINT: config.GOOGLE_VISION_ENDPOINT,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
    }
  };
}

// Deploy from configuration object (used by Electron)
async function deployFromConfig(configObject, reportProgress = null, codebasePath = null) {
  try {
    const deploymentConfig = parseConfigObject(configObject);
    
    // Add codebasePath if provided
    if (codebasePath) {
      deploymentConfig.codebasePath = codebasePath;
    }

    if (reportProgress) {
      reportProgress('start', 'running', 'Starting deployment...');
    }

    // Show configuration always (both CLI and Electron)
      console.log('📋 Configuration:');
      console.log(`   Worker Name: ${deploymentConfig.workerName}`);
      console.log(`   Pages Name: ${deploymentConfig.pagesProjectName}`);
      console.log(`   Database: ${deploymentConfig.databaseName}`);
      console.log(`   Bucket: ${deploymentConfig.bucketName}`);
      console.log('');

    return await deploymentUtils.performDeployment(deploymentConfig, reportProgress);
  } catch (error) {
    if (reportProgress) {
      reportProgress('error', 'error', error.message);
    }
    throw error;
  }
}

function showHelp() {
  console.log(`
🚀 Face Swap AI - Deployment Script

USAGE:
  node deploy.js

DESCRIPTION:
  Automatically reads configuration from secrets.json in the current directory.
  No command line arguments are allowed - all configuration must be in secrets.json.

SECRETS.JSON FORMAT:
  Create a secrets.json file in the project root with this flat structure:

  {
    "workerName": "my-store-backend",
    "pagesProjectName": "my-store-frontend",
    "databaseName": "my-store-db",
    "bucketName": "my-store-images",
    "RAPIDAPI_KEY": "your_rapidapi_key_here",
    "RAPIDAPI_HOST": "ai-face-swap2.p.rapidapi.com",
    "RAPIDAPI_ENDPOINT": "https://ai-face-swap2.p.rapidapi.com/public/process/urls",
    "GOOGLE_VISION_API_KEY": "your_google_vision_key_here",
    "GOOGLE_VERTEX_PROJECT_ID": "your-gcp-project-id",
    "GOOGLE_VERTEX_LOCATION": "us-central1",
    "GOOGLE_VISION_ENDPOINT": "https://vision.googleapis.com/v1/images:annotate"
  }

REQUIRED FIELDS:
  • workerName, pagesProjectName, databaseName, bucketName
  • RAPIDAPI_KEY, RAPIDAPI_HOST, RAPIDAPI_ENDPOINT
  • GOOGLE_VISION_API_KEY, GOOGLE_VERTEX_PROJECT_ID, GOOGLE_VERTEX_LOCATION, GOOGLE_VISION_ENDPOINT

EXAMPLES:
  # Deploy using secrets.json (only way)
  node deploy.js

  # Show this help
  node deploy.js --help

All project names should be unique per Cloudflare account to avoid conflicts.
`);
}

// Cache file for storing authentication check results
const getCacheFile = () => {
  const cacheDir = path.join(os.homedir(), '.ai-faceswap-deploy');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return path.join(cacheDir, 'auth-cache.json');
};

// Load cache
const loadCache = () => {
  try {
    const cacheFile = getCacheFile();
    if (fs.existsSync(cacheFile)) {
      const data = fs.readFileSync(cacheFile, 'utf8');
      const cache = JSON.parse(data);
      // Check if cache is still valid (24 hours)
      const now = Date.now();
      const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
      if (cache.timestamp && (now - cache.timestamp < CACHE_DURATION)) {
        return cache;
      }
    }
  } catch (error) {
    // Ignore cache errors
  }
  return { timestamp: 0, checks: {} };
};

// Save cache
const saveCache = (cache) => {
  try {
    const cacheFile = getCacheFile();
    cache.timestamp = Date.now();
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch (error) {
    // Ignore cache errors
  }
};

// Deployment functions that can be used by both CLI and Electron
const deploymentUtils = {
  checkWrangler() {
  try {
    execSync('wrangler --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
  },

  checkGcloud() {
  try {
    execSync('gcloud --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
  },

  checkGcpAuth() {
  // Check cache first
  const cache = loadCache();
  if (cache.checks && cache.checks.gcpAuth === true) {
    return true;
  }
  
  try {
    const authList = execCommand('gcloud auth list --format="value(account)"', { silent: true, throwOnError: false });
    const result = authList && authList.trim().length > 0;
    // Cache the result
    cache.checks = cache.checks || {};
    cache.checks.gcpAuth = result;
    saveCache(cache);
    return result;
  } catch {
    cache.checks = cache.checks || {};
    cache.checks.gcpAuth = false;
    saveCache(cache);
    return false;
  }
  },

  async fixGcpAuth() {
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
  },

  checkAuth() {
  // Check cache first
  const cache = loadCache();
  if (cache.checks && cache.checks.cloudflareAuth === true) {
    return true;
  }
  
  try {
    execCommand('wrangler whoami', { silent: true, throwOnError: false });
    // Cache the result
    cache.checks = cache.checks || {};
    cache.checks.cloudflareAuth = true;
    saveCache(cache);
    return true;
  } catch {
    cache.checks = cache.checks || {};
    cache.checks.cloudflareAuth = false;
    saveCache(cache);
    return false;
  }
  },

  getSecrets() {
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
  },

  async executeWithLogs(command, cwd, step, reportProgress) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [], {
        shell: true,
        cwd: cwd,
        env: process.env
      });

      let stdout = '';
      let stderr = '';

      let lastProgressUpdate = Date.now();
      let promptAnswered = false;

      child.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;

        // Auto-answer any interactive prompts immediately
        const lowerOutput = output.toLowerCase();
        if ((lowerOutput.includes('ok to proceed') || 
             lowerOutput.includes('proceed?') ||
             lowerOutput.includes('continue?') ||
             lowerOutput.includes('(y/n)') ||
             lowerOutput.includes('[y/n]') ||
             lowerOutput.includes('yes/no')) && !promptAnswered) {
          // Auto-answer with 'yes' or 'y'
          console.log('✓ Auto-confirming prompt...');
          child.stdin.write('yes\n');
          promptAnswered = true;
        }

          const lines = output.split('\n').filter(line => line.trim());
        for (const line of lines) {
          const trimmed = line.trim();

          // For Electron UI: Send ALL log lines to reportProgress
          if (reportProgress) {
            // Send every log line to Electron UI for display
            reportProgress(step, 'running', null, {
              log: trimmed
            });
          }

          // For CLI: Only show important messages (filter verbose output)
          if (!reportProgress) {
            // Suppress duplicate D1 database check messages
            if (step === 'check-d1' && trimmed.includes('Checking D1 database')) {
              // Don't log these - they're logged once at the start
              return;
            }
            
            // For Pages deployment, show more output
            if (step === 'deploy-pages') {
              // Show all important output for Pages, skip telemetry and separator lines
              if (trimmed && 
                  !trimmed.includes('telemetry') && 
                  !trimmed.includes('update available') &&
                  !trimmed.includes('─────────────────') &&
                  !trimmed.startsWith('⛅️ wrangler')) {
                console.log(`ℹ ${step}: ${trimmed}`);
              }
            } else {
              // For other steps, only show these specific important messages
              if ((trimmed.includes('Uploaded') && trimmed.includes('sec')) ||
                  (trimmed.includes('Deployed') && trimmed.includes('sec')) ||
                  trimmed.includes('Success! Uploaded') ||
                  trimmed.includes('Deployment complete!') ||
                  trimmed.includes('✨ Successfully created secret') ||
                  trimmed.includes('Finished processing secrets file') ||
                  (trimmed.startsWith('?') && trimmed.includes('Ok to proceed?')) ||
                  (trimmed.includes('Error') || trimmed.includes('✘'))) {

                if (trimmed.includes('Uploaded') && trimmed.includes('sec')) {
                  console.log(`✓ ${step}: ${trimmed}`);
                } else if (trimmed.includes('Deployed') && trimmed.includes('sec')) {
                  console.log(`✓ ${step}: ${trimmed}`);
                } else if (trimmed.includes('Success! Uploaded')) {
                  console.log(`✓ ${step}: ${trimmed}`);
                } else if (trimmed.includes('Deployment complete!')) {
                  console.log(`✓ ${step}: ${trimmed}`);
                } else if (trimmed.includes('✨ Successfully created secret')) {
                  console.log(`✓ ${trimmed}`);
                } else if (trimmed.includes('Finished processing secrets file')) {
                  console.log(`✓ Secrets upload completed`);
                } else if (trimmed.startsWith('?') && trimmed.includes('Ok to proceed?')) {
                  // Already handled above, just log
                  console.log('✓ Confirming D1 database operation...');
                } else if (trimmed.includes('Error') || trimmed.includes('✘')) {
                  console.log(`✗ ${step}: ${trimmed}`);
                }
              }
            }
          }
        }
      });

      child.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;

          const lines = output.split('\n').filter(line => line.trim());
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            // For Electron UI: Send ALL error log lines
            if (reportProgress) {
            reportProgress(step, 'running', null, {
                log: trimmed
            });
            }
            
            // For CLI: Log errors immediately
            if (!reportProgress) {
              console.log(`✗ ${step}: ${trimmed}`);
            }
          }
        }
      });

      child.on('close', (code) => {
        const result = {
          success: code === 0,
          stdout: stdout,
          stderr: stderr,
          exitCode: code,
          error: code !== 0 ? stderr || stdout : null
        };

        if (reportProgress) {
          reportProgress(step, result.success ? 'completed' : 'error',
            result.success ? 'Completed successfully' : `Failed with code ${code}`);
        }

        if (result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error || `Command failed with code ${code}`));
        }
      });

      child.on('error', (error) => {
        console.log(`✗ ${step}: Process error - ${error.message}`);
        reject(error);
      });
    });
  },

  async ensureR2Bucket(codebasePath, reportProgress, bucketName = DEFAULT_R2_BUCKET_NAME) {
    // Check cache first
    const cache = loadCache();
    const cacheKey = `r2Bucket_${bucketName}`;
    if (cache.checks && cache.checks[cacheKey] === true) {
      if (reportProgress) reportProgress('check-r2', 'completed', `R2 bucket '${bucketName}' exists`);
      return;
    }
    
    try {
      const listResult = await this.executeWithLogs('wrangler r2 bucket list', codebasePath, 'check-r2', reportProgress);
      const output = listResult.stdout || '';

      if (!output || !output.includes(bucketName)) {
        await this.executeWithLogs(`wrangler r2 bucket create ${bucketName}`, codebasePath, 'check-r2', reportProgress);
      }
      if (reportProgress) reportProgress('check-r2', 'completed', 'R2 bucket OK');
      // Cache the result
      const cacheAfter = loadCache();
      cacheAfter.checks = cacheAfter.checks || {};
      cacheAfter.checks[cacheKey] = true;
      saveCache(cacheAfter);
    } catch (error) {
      // Bucket might already exist or command might fail - non-fatal
      if (!error.message.includes('already exists')) {
        throw error;
      }
      // Still cache as OK if it already exists
      const cacheAfter = loadCache();
      cacheAfter.checks = cacheAfter.checks || {};
      cacheAfter.checks[cacheKey] = true;
      saveCache(cacheAfter);
    }
  },

  async ensureD1Database(codebasePath, reportProgress, databaseName = DEFAULT_D1_DATABASE_NAME) {
    try {
      const output = execSync('wrangler d1 list', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
        cwd: codebasePath
      });

      if (!output || !output.includes(databaseName)) {
        // Use executeWithLogs to auto-answer prompts
        await this.executeWithLogs(`wrangler d1 create ${databaseName}`, codebasePath, 'check-d1', reportProgress);

        // Initialize schema
        const schemaPath = path.join(codebasePath, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
          try {
            execSync(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, {
              stdio: 'inherit',
              timeout: 30000,
              cwd: codebasePath
            });
          } catch (error) {
            // If schema fails, recreate database
            await this.executeWithLogs(`wrangler d1 delete ${databaseName}`, codebasePath, 'check-d1', reportProgress);
            await this.executeWithLogs(`wrangler d1 create ${databaseName}`, codebasePath, 'check-d1', reportProgress);
            await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, codebasePath, 'check-d1', reportProgress);
          }
        }
      } else {
        // Check schema completeness
        const schemaPath = path.join(codebasePath, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
          let needsSchemaUpdate = false;

          try {
            // Check for selfies table
            const selfiesCheck = execSync(`wrangler d1 execute ${databaseName} --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='selfies';"`, {
              encoding: 'utf8',
              stdio: 'pipe',
              timeout: 10000,
              cwd: codebasePath
            });

            if (!selfiesCheck || !selfiesCheck.includes('selfies')) {
              needsSchemaUpdate = true;
            } else {
              // Check if results table has selfie_id column
              try {
                const resultsCheck = execSync('wrangler d1 execute ${databaseName} --remote --command="PRAGMA table_info(results);"', {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath
                });

                if (resultsCheck && !resultsCheck.includes('selfie_id')) {
                  needsSchemaUpdate = true;
                }
              } catch {
                // results table might not exist, that's OK - schema.sql will create it
                needsSchemaUpdate = true;
              }
            }
          } catch (error) {
            // Could not verify schema - will attempt to apply schema.sql
            needsSchemaUpdate = true;
          }

          if (needsSchemaUpdate) {
            try {
              // Apply schema.sql - it uses CREATE TABLE IF NOT EXISTS so it's safe
              await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, codebasePath, 'check-d1', reportProgress);

              // If results table exists but has wrong structure, fix it
              try {
                const resultsCheck = execSync('wrangler d1 execute ${databaseName} --remote --command="PRAGMA table_info(results);"', {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath
                });

                if (resultsCheck && resultsCheck.includes('preset_collection_id') && !resultsCheck.includes('selfie_id')) {
                  // Check if results table has data
                  const countCheck = execSync('wrangler d1 execute ${databaseName} --remote --command="SELECT COUNT(*) as count FROM results;"', {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 10000,
                    cwd: codebasePath
                  });

                  const hasData = countCheck && countCheck.includes('"count":') && !countCheck.includes('"count":0');

                  if (!hasData) {
                    // Safe to recreate - table is empty
                    await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --command="DROP TABLE IF EXISTS results;"`, codebasePath, 'check-d1', reportProgress);
                    await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --command="CREATE TABLE results (id TEXT PRIMARY KEY, selfie_id TEXT NOT NULL, preset_collection_id TEXT NOT NULL, preset_image_id TEXT NOT NULL, preset_name TEXT NOT NULL, result_url TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (selfie_id) REFERENCES selfies(id), FOREIGN KEY (preset_collection_id) REFERENCES preset_collections(id), FOREIGN KEY (preset_image_id) REFERENCES preset_images(id));"`, codebasePath, 'check-d1', reportProgress);
                  }
                }
              } catch (fixError) {
                // Could not auto-fix results table structure - non-fatal
              }
            } catch (error) {
              // Try to create missing selfies table if it doesn't exist
              try {
                const selfiesCheck = execSync('wrangler d1 execute ${databaseName} --remote --command="SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'selfies\';"', {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath
                });

                if (!selfiesCheck || !selfiesCheck.includes('selfies')) {
                  await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --command="CREATE TABLE IF NOT EXISTS selfies (id TEXT PRIMARY KEY, image_url TEXT NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));"`, codebasePath, 'check-d1', reportProgress);
                }
              } catch (createError) {
                // Failed to create selfies table - non-fatal, will be caught below
              }

              // Re-throw if it's a critical error
              if (!error.message.includes('already exists') && !error.message.includes('no such table')) {
                throw error;
              }
            }
          }
        }
      }
      if (reportProgress) reportProgress('check-d1', 'completed', 'D1 database OK');
      // Cache the result
      cache.checks = cache.checks || {};
      cache.checks[cacheKey] = true;
      saveCache(cache);
    } catch (error) {
      // Database might already exist - non-fatal
      // Still cache as OK if it's a non-critical error
      if (error.message && (error.message.includes('already exists') || error.message.includes('no such table'))) {
        cache.checks = cache.checks || {};
        cache.checks[cacheKey] = true;
        saveCache(cache);
      }
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  },

  async deploySecrets(secrets, codebasePath, reportProgress, workerName) {
    if (!secrets) {
      throw new Error('No secrets provided');
    }

    // Create temporary secrets.json file
    const secretsPath = path.join(codebasePath, 'temp-secrets.json');
    const wranglerConfigPath = path.join(codebasePath, 'wrangler.jsonc');
    let originalConfigContent = null;
    let configModified = false;
    
    try {
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), 'utf8');

      // Temporarily remove pages_build_output_dir from wrangler.jsonc to avoid Pages project detection
      // This allows wrangler secret bulk to target the Worker instead of Pages
      if (fs.existsSync(wranglerConfigPath)) {
        try {
          originalConfigContent = fs.readFileSync(wranglerConfigPath, 'utf8');
          // Parse JSONC (remove comments)
          const jsonContent = originalConfigContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
          const config = JSON.parse(jsonContent);
          
          // Remove both pages_build_output_dir and site fields to prevent Pages project detection
          // Wrangler detects Pages projects by either of these fields
          if (config.pages_build_output_dir || config.site) {
            if (config.pages_build_output_dir) {
              delete config.pages_build_output_dir;
            }
            if (config.site) {
              delete config.site;
            }
            fs.writeFileSync(wranglerConfigPath, JSON.stringify(config, null, '\t'), 'utf8');
            configModified = true;
            console.log('[Deploy] Temporarily removed pages_build_output_dir and site fields for secret deployment');
          }
        } catch (configError) {
          console.warn('[Deploy] Could not modify wrangler.jsonc:', configError.message);
        }
      }

      // Deploy secrets using wrangler - explicitly specify worker name to avoid Pages project detection
      // Use --name flag to ensure we're deploying to the Worker, not Pages
      const command = workerName 
        ? `wrangler secret bulk --name ${workerName} temp-secrets.json`
        : 'wrangler secret bulk temp-secrets.json';
      
      const result = await this.executeWithLogs(
        command,
        codebasePath,
        'deploy-secrets',
        reportProgress
      );

      // Handle error 10214: Can't edit settings on non-deployed worker
      // This shouldn't happen if worker is deployed first, but handle it gracefully
      if (!result.success && result.error && result.error.includes('code: 10214')) {
        console.warn('[Deploy] Error 10214 during secrets deployment - worker may not exist yet');
        throw new Error('Worker must be deployed before secrets can be set. Please deploy the worker first.');
      }

      if (!result.success) {
        throw new Error(result.error || 'Failed to deploy secrets');
      }

      if (reportProgress) reportProgress('deploy-secrets', 'completed', 'Secrets deployed');
      
      return result;
    } finally {
      // Restore original wrangler.jsonc if we modified it
      if (configModified && originalConfigContent) {
        try {
          fs.writeFileSync(wranglerConfigPath, originalConfigContent, 'utf8');
          console.log('[Deploy] Restored pages_build_output_dir and site fields in wrangler.jsonc');
        } catch (restoreError) {
          console.warn('[Deploy] Could not restore wrangler.jsonc:', restoreError.message);
        }
      }
      
      // Clean up temporary file
      if (fs.existsSync(secretsPath)) {
        try {
          fs.unlinkSync(secretsPath);
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }
  },

  async deployWorker(codebasePath, workerName, reportProgress) {
    if (reportProgress) reportProgress('deploy-worker', 'running', `Deploying Worker: ${workerName}...`);

    // Temporarily remove pages_build_output_dir from wrangler.jsonc to avoid Pages project detection
    const wranglerPath = path.join(codebasePath, 'wrangler.jsonc');
    let originalConfigContent = null;
    let configModified = false;
    
    if (fs.existsSync(wranglerPath)) {
      try {
        originalConfigContent = fs.readFileSync(wranglerPath, 'utf8');
        // Parse JSONC (remove comments)
        const jsonContent = originalConfigContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const wranglerConfig = JSON.parse(jsonContent);
        
        // Remove both pages_build_output_dir and site fields to prevent Pages project detection
        // Wrangler detects Pages projects by either of these fields
        if (wranglerConfig.pages_build_output_dir || wranglerConfig.site) {
          if (wranglerConfig.pages_build_output_dir) {
            delete wranglerConfig.pages_build_output_dir;
          }
          if (wranglerConfig.site) {
            delete wranglerConfig.site;
          }
          fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, '\t'), 'utf8');
          configModified = true;
          console.log('[Deploy] Temporarily removed pages_build_output_dir and site fields for worker deployment');
        }
      } catch (configError) {
        console.warn('[Deploy] Could not modify wrangler.jsonc:', configError.message);
      }
    }

    try {
      let result = await this.executeWithLogs('wrangler deploy', codebasePath, 'deploy-worker', reportProgress);

      // Handle error 10214: Can't edit settings on non-deployed worker
      // This happens when observability settings are applied to a worker that doesn't exist yet
      if (!result.success && result.error && result.error.includes('code: 10214')) {
        console.log('[Deploy] Error 10214 detected - worker not deployed yet. Retrying without observability settings...');
        
        // Temporarily remove observability from wrangler.jsonc (pages_build_output_dir already removed)
        let observabilityConfig = null;
        
        if (fs.existsSync(wranglerPath)) {
          try {
            const currentContent = fs.readFileSync(wranglerPath, 'utf8');
            // Parse JSONC (remove comments)
            const jsonContent = currentContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const wranglerConfig = JSON.parse(jsonContent);
            
            if (wranglerConfig.observability) {
              observabilityConfig = JSON.parse(JSON.stringify(wranglerConfig.observability)); // Deep copy
              delete wranglerConfig.observability;
              // Write back as JSON (wrangler accepts both JSON and JSONC)
              fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, '\t'), 'utf8');
              console.log('[Deploy] Temporarily removed observability settings for initial deployment');
            }
          } catch (error) {
            console.warn('[Deploy] Could not modify wrangler.jsonc:', error.message);
          }
        }
        
        // Retry deployment without observability
        const retryResult = await this.executeWithLogs('wrangler deploy', codebasePath, 'deploy-worker', reportProgress);
        
        // Restore observability settings if we removed them
        if (observabilityConfig) {
          try {
            // Re-read the current config (may have been modified)
            const currentContent = fs.readFileSync(wranglerPath, 'utf8');
            const jsonContent = currentContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const wranglerConfig = JSON.parse(jsonContent);
            wranglerConfig.observability = observabilityConfig;
            fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, '\t'), 'utf8');
            console.log('[Deploy] Restored observability settings');
            
            // Now deploy again with observability (worker exists now)
            if (retryResult.success) {
              console.log('[Deploy] Deploying again with observability settings...');
              const finalResult = await this.executeWithLogs('wrangler deploy', codebasePath, 'deploy-worker', reportProgress);
              if (finalResult.success) {
                // Use the final result
                result = finalResult;
              } else {
                console.warn('[Deploy] Failed to deploy with observability settings, but worker is deployed');
              }
            }
          } catch (error) {
            console.warn('[Deploy] Could not restore observability settings:', error.message);
          }
        }
        
        if (!retryResult.success && !result.success) {
          throw new Error(retryResult.error || result.error || 'Worker deployment failed');
        }
        
        // If retry succeeded, use retry result
        if (retryResult.success && !result.success) {
          result = retryResult;
        }
      } else if (!result.success) {
      throw new Error(result.error || 'Worker deployment failed');
    }

    // Try to get Worker URL
    let workerUrl = '';
    try {
      const deployments = execSync('wrangler deployments list --latest', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
        cwd: codebasePath
      });

      if (deployments) {
        const urlMatch = deployments.match(/https:\/\/[^\s]+\.workers\.dev/);
        if (urlMatch) {
          workerUrl = urlMatch[0];
        }
      }
    } catch (error) {
      // Try to construct URL from whoami
      try {
        const whoami = execSync('wrangler whoami', {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 10000,
          cwd: codebasePath
        });

        const accountMatch = whoami.match(/([^\s]+)@/);
        if (accountMatch) {
          const accountSubdomain = accountMatch[1];
          workerUrl = `https://${workerName}.${accountSubdomain}.workers.dev`;
        }
      } catch (error) {
        // Could not determine URL
      }
    }

    // Update HTML with Worker URL if found
    if (workerUrl) {
      const htmlPath = path.join(codebasePath, 'public_page', 'index.html');
      if (fs.existsSync(htmlPath)) {
        try {
          let htmlContent = fs.readFileSync(htmlPath, 'utf8');
          const urlPattern = /const WORKER_URL = ['"](.*?)['"]/;
          if (urlPattern.test(htmlContent)) {
            htmlContent = htmlContent.replace(urlPattern, `const WORKER_URL = '${workerUrl}'`);
            fs.writeFileSync(htmlPath, htmlContent, 'utf8');
          }
        } catch (error) {
          // Non-fatal
        }
      }
    }

    if (reportProgress) reportProgress('deploy-worker', 'completed', `Worker deployed: ${workerUrl}`);
      // Don't log here - already logged in executeWithLogs
    return workerUrl;
    } finally {
      // Restore original wrangler.jsonc if we modified it
      if (configModified && originalConfigContent) {
        try {
          fs.writeFileSync(wranglerPath, originalConfigContent, 'utf8');
          console.log('[Deploy] Restored pages_build_output_dir in wrangler.jsonc after worker deployment');
        } catch (restoreError) {
          console.warn('[Deploy] Could not restore wrangler.jsonc:', restoreError.message);
        }
      }
    }
  },

  async deployPages(codebasePath, pagesProjectName, reportProgress) {
    // Check for public_page in codebasePath first
    let publicPageDir = path.join(codebasePath, 'public_page');

    // If not found, check in project root (where deploy.js is located)
    if (!fs.existsSync(publicPageDir)) {
      const projectRoot = path.resolve(__dirname);
      const rootPublicPageDir = path.join(projectRoot, 'public_page');
      if (fs.existsSync(rootPublicPageDir)) {
        publicPageDir = rootPublicPageDir;
        if (reportProgress) reportProgress('deploy-pages', 'running', `Found public_page in project root, deploying...`);
      }
    }

    // Always construct the Pages URL from project name
    const pagesUrl = `https://${pagesProjectName}.pages.dev/`;

    if (!fs.existsSync(publicPageDir)) {
      if (reportProgress) reportProgress('deploy-pages', 'warning', 'public_page directory not found in codebasePath or project root, skipping Pages deployment');
      return pagesUrl;
    }

    // Ensure we use absolute path for the public_page directory
    const absolutePublicPageDir = path.resolve(publicPageDir);

    if (reportProgress) reportProgress('deploy-pages', 'running', `Deploying Pages: ${pagesProjectName}...`);

    // Temporarily modify wrangler.jsonc for Pages deployment
    // Pages deployment doesn't support Worker fields like "main", "observability", "site"
    const wranglerPath = path.join(codebasePath, 'wrangler.jsonc');
    let originalConfigContent = null;
    let configModified = false;

    if (fs.existsSync(wranglerPath)) {
      try {
        originalConfigContent = fs.readFileSync(wranglerPath, 'utf8');
        // Parse JSONC (remove comments)
        const jsonContent = originalConfigContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const wranglerConfig = JSON.parse(jsonContent);

        // Remove Worker-specific fields that Pages doesn't support
        const workerFields = ['main', 'observability', 'site', 'r2_buckets', 'd1_databases'];
        let removedFields = false;
        for (const field of workerFields) {
          if (wranglerConfig[field]) {
            delete wranglerConfig[field];
            removedFields = true;
          }
        }

        if (removedFields) {
          fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, '\t'), 'utf8');
          configModified = true;
          console.log('[Deploy] Temporarily removed Worker fields for Pages deployment');
        }
      } catch (configError) {
        console.warn('[Deploy] Could not modify wrangler.jsonc for Pages:', configError.message);
      }
    }

    try {
      // Use the exact same command as deploy.js CLI
      // Use absolute path to ensure it works regardless of working directory
      const command = `wrangler pages deploy "${absolutePublicPageDir}" --project-name=${pagesProjectName} --branch=main --commit-dirty=true`;

      const result = await this.executeWithLogs(
        command,
        codebasePath,
        'deploy-pages',
        reportProgress
      );

      // Check if command succeeded (exit code 0)
      if (result.success) {
        if (reportProgress) reportProgress('deploy-pages', 'completed', `Pages deployed successfully: ${pagesUrl}`);
      // Don't log here - already logged in executeWithLogs
        return pagesUrl;
      } else {
        // Command failed but we still return the URL (deployment might have partially succeeded)
        if (reportProgress) reportProgress('deploy-pages', 'warning', `Pages deployment may have issues, but URL is: ${pagesUrl}`);
        return pagesUrl;
      }
    } catch (error) {
      // Pages deployment failed, but return URL anyway (non-critical)
      if (reportProgress) reportProgress('deploy-pages', 'warning', `Pages deployment error: ${error.message}. URL: ${pagesUrl}`);
      // Still return the URL as Pages deployment is non-critical
      return pagesUrl;
    } finally {
      // Restore original wrangler.jsonc if we modified it
      if (configModified && originalConfigContent) {
        try {
          fs.writeFileSync(wranglerPath, originalConfigContent, 'utf8');
          console.log('[Deploy] Restored Worker fields in wrangler.jsonc after Pages deployment');
        } catch (restoreError) {
          console.warn('[Deploy] Could not restore wrangler.jsonc:', restoreError.message);
        }
      }
    }
  },

  async performDeployment(config = {}, reportProgress) {
    const codebasePath = config.codebasePath || process.cwd();
    const workerName = config.workerName || DEFAULT_WORKER_NAME;
    const pagesProjectName = config.pagesProjectName || DEFAULT_PAGES_PROJECT_NAME;
    const databaseName = config.databaseName || DEFAULT_D1_DATABASE_NAME;
    const bucketName = config.bucketName || DEFAULT_R2_BUCKET_NAME;
    const secrets = config.secrets;

    let workerUrl = '';
    let pagesUrl = '';

    try {
      // Step 1: Check prerequisites
      if (reportProgress) reportProgress('check-prerequisites', 'running', 'Checking prerequisites...');
      const prerequisites = {
        wrangler: this.checkWrangler(),
        gcloud: this.checkGcloud()
      };
      if (!prerequisites.wrangler || !prerequisites.gcloud) {
        throw new Error(`Missing prerequisites: ${JSON.stringify(prerequisites)}`);
      }
      if (reportProgress) reportProgress('check-prerequisites', 'completed', 'Prerequisites OK');

      // Step 2: Check and fix GCP authentication
      // Note: In Electron mode, account switching is handled in main.js before calling deployFromConfig
      // This step only checks auth status, doesn't switch accounts/projects
      if (reportProgress) reportProgress('check-gcp-auth', 'running', 'Checking GCP authentication...');
      if (!this.checkGcpAuth()) {
        if (reportProgress) reportProgress('check-gcp-auth', 'warning', 'GCP authentication required');
        // Only try to fix auth in CLI mode (when no reportProgress means CLI)
        // In Electron mode, account switching is handled separately in main.js
        if (!reportProgress) {
          // CLI mode - try to fix auth
          if (!await this.fixGcpAuth()) {
            throw new Error('GCP authentication setup failed');
          }
        } else {
          // Electron mode - just report warning, don't try to fix (account switching already done in main.js)
          reportProgress('check-gcp-auth', 'warning', 'GCP authentication may need manual setup');
        }
      } else {
        if (reportProgress) reportProgress('check-gcp-auth', 'completed', 'GCP authentication OK');
      }

      // Step 2.5: Enable Vertex AI API automatically
      if (secrets && secrets.GOOGLE_VERTEX_PROJECT_ID) {
        if (reportProgress) reportProgress('enable-vertex-api', 'running', 'Enabling Vertex AI API...');
        try {
          const projectId = secrets.GOOGLE_VERTEX_PROJECT_ID;
          // Set project
          execCommand(`gcloud config set project ${projectId}`, { silent: true, throwOnError: false });
          // Enable Vertex AI API
          execCommand(`gcloud services enable aiplatform.googleapis.com --project=${projectId}`, { silent: true, throwOnError: false });
          if (reportProgress) reportProgress('enable-vertex-api', 'completed', 'Vertex AI API enabled');
        } catch (error) {
          if (reportProgress) reportProgress('enable-vertex-api', 'warning', `Vertex AI API enablement: ${error.message}`);
          // Non-critical, continue
        }
      }

      // Step 3: Check Cloudflare authentication
      // Skip check if cached
      if (!cache.checks || cache.checks.cloudflareAuth !== true) {
      if (reportProgress) reportProgress('check-auth', 'running', 'Checking Cloudflare authentication...');
      if (!this.checkAuth()) {
        throw new Error('Cloudflare authentication required');
      }
      if (reportProgress) reportProgress('check-auth', 'completed', 'Cloudflare authentication OK');
      } else {
        // Cached - skip check
        if (reportProgress) reportProgress('check-auth', 'completed', 'Cloudflare authentication OK (cached)');
      }

      // Step 4: Check R2 bucket
      await this.ensureR2Bucket(codebasePath, reportProgress, bucketName);

      // Step 5: Check D1 database
      await this.ensureD1Database(codebasePath, reportProgress, databaseName);

      // Step 6: Deploy Worker first (creates the worker if it doesn't exist)
      // This must happen before secrets deployment to avoid error 10214
      workerUrl = await this.deployWorker(codebasePath, workerName, reportProgress);

      // Step 7: Deploy secrets (now that worker exists)
      if (secrets) {
        await this.deploySecrets(secrets, codebasePath, reportProgress, workerName);
      }

      // Step 8: Deploy Pages
      pagesUrl = await this.deployPages(codebasePath, pagesProjectName, reportProgress);

      return {
        success: true,
        workerUrl,
        pagesUrl
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        workerUrl,
        pagesUrl
      };
    }
  }
};

// Export functions for use by Electron
module.exports = {
  ...deploymentUtils,
  deployFromConfig,
  loadSecretsConfig,
  parseConfigObject
};

// CLI main function
// CLI main function - runs when file is executed directly
async function main() {
  // Parse command line arguments (only allows --help)
  parseCliArgs();

  // Load configuration from secrets.json
  console.log('📄 Loading configuration from secrets.json...');
  const deploymentConfig = loadSecretsConfig();

  console.log('\n🚀 Face Swap AI - Deployment Script');
  console.log('====================================\n');

  // Show configuration
  console.log('📋 Configuration:');
  console.log(`   Worker Name: ${deploymentConfig.workerName}`);
  console.log(`   Pages Name: ${deploymentConfig.pagesProjectName}`);
  console.log(`   Database: ${deploymentConfig.databaseName}`);
  console.log(`   Bucket: ${deploymentConfig.bucketName}`);
  console.log('');

  let workerUrl = '';
  let pagesUrl = '';

  // Check wrangler
  if (!deploymentUtils.checkWrangler()) {
    log.error('Wrangler CLI not found. Installing...');
    try {
      execCommand('npm install -g wrangler', { stdio: 'inherit' });
    } catch {
      log.error('Failed to install wrangler. Please install manually: npm install -g wrangler');
      process.exit(1);
    }
  }

  // Check gcloud
  if (!deploymentUtils.checkGcloud()) {
    log.error('gcloud CLI not found. Please install Google Cloud SDK first.');
    log.info('Download from: https://cloud.google.com/sdk/docs/install');
    process.exit(1);
  }

  // Check and fix GCP authentication
  log.info('Checking GCP authentication...');
  if (!deploymentUtils.checkGcpAuth()) {
    log.warn('GCP authentication required');
    if (!await deploymentUtils.fixGcpAuth()) {
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
    await deploymentUtils.fixGcpAuth();
  }

  // Check authentication
  log.info('Checking Cloudflare authentication...');
  if (!deploymentUtils.checkAuth()) {
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
  log.info(`Checking R2 bucket: ${deploymentConfig.bucketName}...`);
  try {
    const buckets = execCommand('wrangler r2 bucket list', { silent: true, throwOnError: false });
    if (!buckets || !buckets.includes(deploymentConfig.bucketName)) {
      log.warn(`R2 bucket '${deploymentConfig.bucketName}' not found. Creating...`);
      execCommand(`wrangler r2 bucket create ${deploymentConfig.bucketName}`, { stdio: 'inherit' });
      log.success(`R2 bucket '${deploymentConfig.bucketName}' created`);
    } else {
      log.success(`R2 bucket '${deploymentConfig.bucketName}' exists`);
    }
  } catch (error) {
    log.warn('Could not verify R2 bucket (may already exist)');
  }

  // Check D1 database
  log.info(`Checking D1 database: ${deploymentConfig.databaseName}...`);
  try {
    await deploymentUtils.ensureD1Database(process.cwd(), (step, status, details) => {
      if (status === 'completed') {
        log.success(details || `D1 database '${deploymentConfig.databaseName}' OK`);
      } else if (status === 'warning') {
        log.warn(details);
                }
      // Don't log 'info' status for D1 checks - they're too verbose
    }, deploymentConfig.databaseName);
    log.success(`D1 database '${deploymentConfig.databaseName}' OK`);
  } catch (error) {
    log.warn('Could not verify D1 database (may already exist)');
  }

  // CORS is handled by Worker responses - no R2 bucket CORS needed
  log.info('CORS: Handled automatically by Worker (no R2 configuration needed)');

  // Deploy secrets if provided
  if (Object.keys(deploymentConfig.secrets).length > 0) {
    log.info('Deploying secrets...');
    try {
      await deploymentUtils.deploySecrets(deploymentConfig.secrets, process.cwd(), (step, status, details) => {
        // Don't log here - executeWithLogs already handles logging
        // Only report progress for Electron mode
      }, deploymentConfig.workerName);
    } catch (error) {
      log.error('Failed to deploy secrets');
      throw error;
    }
  } else {
    // Check if secrets are set manually
    const existingSecrets = deploymentUtils.getSecrets();
    const requiredVars = ['RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT', 'GOOGLE_VISION_API_KEY', 'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_VISION_ENDPOINT', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'];
  const missingVars = requiredVars.filter(v => !existingSecrets.includes(v));

  if (missingVars.length > 0) {
    log.warn(`Missing environment variables: ${missingVars.join(', ')}`);
    log.warn('You can set secrets manually with: wrangler secret put <NAME>');
      log.warn('Or provide them in your config file under the "secrets" key');
  } else {
    log.success('All environment variables are set');
    }
  }

  // Deploy Worker
  log.info(`Deploying Worker: ${deploymentConfig.workerName}...`);
  try {
    workerUrl = await deploymentUtils.deployWorker(process.cwd(), deploymentConfig.workerName, (step, status, details) => {
      // Don't log here - executeWithLogs already handles logging
      // Only report progress for Electron mode
    });
  } catch (error) {
    log.error('Worker deployment failed!');
    process.exit(1);
  }

  // Deploy Pages
  log.info(`Deploying to Cloudflare Pages: ${deploymentConfig.pagesProjectName}...`);
  const publicPageDir = path.join(process.cwd(), 'public_page');

  if (fs.existsSync(publicPageDir)) {
    try {
      pagesUrl = await deploymentUtils.deployPages(process.cwd(), deploymentConfig.pagesProjectName, (step, status, details) => {
        // Don't log here - executeWithLogs already handles logging
        // Only report progress for Electron mode
      });
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
    console.log(`   ✅ Pages (Frontend): https://${deploymentConfig.pagesProjectName}.pages.dev/`);
  }
  console.log('\n');

  // Check if final setup is needed
  const setupScript = path.join(process.cwd(), 'complete-setup.js');
  if (fs.existsSync(setupScript)) {
    log.info('💡 Optional: Run ./complete-setup.js to enable full GCP integration');
    log.info('   This enables Application Default Credentials for advanced GCP features');
  }
}

// Run CLI if this file is executed directly
if (require.main === module) {
main().catch((error) => {
  log.error(`Deployment failed: ${error.message}`);
  process.exit(1);
});
}
 