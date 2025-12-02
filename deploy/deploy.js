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
function executeWithLogs(command, cwd, stepName) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      cwd: cwd || process.cwd(),
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let promptAnswered = false;

    const checkAndAnswerPrompt = (output) => {
      if (promptAnswered) return;
      
      const fullOutput = (stdout + stderr + output).toLowerCase();
      if (fullOutput.includes('ok to proceed?') || 
          (fullOutput.includes('⚠️') && fullOutput.includes('unavailable')) ||
          (fullOutput.includes('this process may take some time') && fullOutput.includes('ok to proceed'))) {
        console.log('✓ Auto-confirming D1 database operation...');
        child.stdin.write('yes\n');
        promptAnswered = true;
      }
    };

    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      checkAndAnswerPrompt(output);

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
        } else if (trimmed.includes('Error') || trimmed.includes('✘')) {
          console.log(`✗ ${stepName}: ${trimmed}`);
        } else if (stepName === 'deploy-pages') {
          // For Pages deployment, show all important output
          // Skip empty lines, warnings about wrangler.json, telemetry messages, and OAuth scope warnings
          if (trimmed &&
              !trimmed.includes('telemetry') &&
              !trimmed.includes('update available') &&
              !trimmed.includes('─────────────────') &&
              !trimmed.startsWith('⛅️ wrangler') &&
              !trimmed.includes('Wrangler is missing some expected Oauth scopes') &&
              !trimmed.includes('missing scopes are:') &&
              !trimmed.match(/^-\s+\w+:\w+$/)) {
            // Show all non-empty, non-telemetry lines for Pages
            console.log(`ℹ ${stepName}: ${trimmed}`);
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      checkAndAnswerPrompt(output);

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
    console.error('No command line arguments allowed. Configuration must be in deploy/deployments-secrets.json');
    console.error('Run "node deploy/deploy.js --help" for usage information.');
    process.exit(1);
  }

  return {};
}

// Load configuration from deploy/deployments-secrets.json
async function loadSecretsConfig() {
  const secretsPath = path.join(process.cwd(), 'deploy', 'deployments-secrets.json');

  try {
    if (!fs.existsSync(secretsPath)) {
      console.error('deploy/deployments-secrets.json not found. Please create deploy/deployments-secrets.json with your configuration.');
      console.log('Example deploy/deployments-secrets.json:');
      console.log(JSON.stringify({
        environments: {
          production: {
            name: 'production',
            workerName: 'my-store-backend',
            pagesProjectName: 'my-store-frontend',
            databaseName: 'my-store-db',
            bucketName: 'my-store-images',
            cloudflare: {
              accountId: 'your_cloudflare_account_id',
              apiToken: 'your_cloudflare_api_token'
            },
            gcp: {
              projectId: 'your-gcp-project-id',
              serviceAccountKeyJson: {
                type: 'service_account',
                project_id: 'your-gcp-project-id',
                private_key_id: 'auto-generated',
                private_key: '-----BEGIN PRIVATE KEY-----\nPASTE_YOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n',
                client_email: 'your-service-account@project.iam.gserviceaccount.com',
                client_id: 'auto-generated',
                auth_uri: 'https://accounts.google.com/o/oauth2/auth',
                token_uri: 'https://oauth2.googleapis.com/token',
                auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
                client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/your-service-account%40project.iam.gserviceaccount.com'
              }
            },
            RAPIDAPI_KEY: 'your_rapidapi_key_here',
            RAPIDAPI_HOST: 'ai-face-swap2.p.rapidapi.com',
            RAPIDAPI_ENDPOINT: 'https://ai-face-swap2.p.rapidapi.com/public/process/urls',
            GOOGLE_VISION_API_KEY: 'your_google_vision_api_key',
            GOOGLE_VERTEX_PROJECT_ID: 'your-gcp-project-id',
            GOOGLE_VERTEX_LOCATION: 'us-central1',
            GOOGLE_VISION_ENDPOINT: 'https://vision.googleapis.com/v1/images:annotate',
            GOOGLE_SERVICE_ACCOUNT_EMAIL: 'your-service-account@project.iam.gserviceaccount.com',
            GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nPASTE_YOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n'
          }
        }
      }, null, 2));
      process.exit(1);
    }

    let content = fs.readFileSync(secretsPath, 'utf8');
    let config = parseConfigObject(JSON.parse(content));
    
    if (config._needsCloudflareSetup) {
      log.warn('Cloudflare credentials not configured in secrets.json');
      log.info('Attempting to extract from wrangler login...');
      
      try {
        await setupCloudflareFromWrangler(config._environment);
        log.info('Reloading configuration from file...');
        content = fs.readFileSync(secretsPath, 'utf8');
        config = parseConfigObject(JSON.parse(content));
        log.success('Cloudflare credentials extracted and saved');
      } catch (error) {
        log.error(`Failed to setup Cloudflare from wrangler: ${error.message}`);
        log.error('Please either:');
        log.error('  1. Run "wrangler login" and run this script again');
        log.error('  2. Or configure cloudflare.apiToken and cloudflare.accountId in deploy/deployments-secrets.json');
        throw error;
      }
    }
    
    return config;
  } catch (error) {
    console.error(`Error loading secrets.json:`, error.message);
    process.exit(1);
  }
}

// Parse and validate configuration object
function parseConfigObject(config, skipCloudflareValidation = false) {
  // Check if it's the new nested structure with environments
  let environment = null;
  if (config.environments) {
    // Default to production environment if not specified
    environment = process.env.DEPLOY_ENV || 'production';
    const envConfig = config.environments[environment];

    if (!envConfig) {
      throw new Error(`Environment '${environment}' not found in secrets.json. Available environments: ${Object.keys(config.environments).join(', ')}`);
    }

    config = envConfig;
  }

  // Validate required fields
  const requiredFields = [
    'workerName', 'pagesProjectName', 'databaseName', 'bucketName',
    'gcp',
    'RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT',
    'GOOGLE_VISION_API_KEY', 'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_VISION_ENDPOINT',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'
  ];

  const missingFields = requiredFields.filter(field => !config[field]);
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
  }

  // Validate Cloudflare config (allow empty - will be auto-filled from wrangler)
  if (!config.cloudflare) {
    config.cloudflare = { accountId: '', apiToken: '' };
  }
  if (!config.cloudflare.accountId) {
    config.cloudflare.accountId = '';
  }
  if (!config.cloudflare.apiToken) {
    config.cloudflare.apiToken = '';
  }

  // Only validate Cloudflare if not skipping (will be auto-filled)
  if (!skipCloudflareValidation) {
    const accountId = (config.cloudflare.accountId || '').trim();
    const apiToken = (config.cloudflare.apiToken || '').trim();
    const hasCloudflare = accountId && apiToken && 
                          accountId !== 'your_cloudflare_account_id' &&
                          apiToken !== 'your_cloudflare_api_token';
    if (!hasCloudflare) {
      config._needsCloudflareSetup = true;
      config._environment = environment;
    }
  }

  // Validate GCP config
  if (!config.gcp.projectId || !config.gcp.serviceAccountKeyJson) {
    throw new Error('Missing GCP projectId or serviceAccountKeyJson in configuration');
  }

  const deployPages = config.deployPages !== undefined 
    ? config.deployPages 
    : (process.env.DEPLOY_PAGES === 'true');

  const result = {
    name: config.name || 'default',
    workerName: config.workerName,
    pagesProjectName: config.pagesProjectName,
    databaseName: config.databaseName,
    bucketName: config.bucketName,
    deployPages: deployPages,
    cloudflare: {
      accountId: config.cloudflare.accountId,
      apiToken: config.cloudflare.apiToken
    },
    gcp: {
      projectId: config.gcp.projectId,
      serviceAccountKeyJson: config.gcp.serviceAccountKeyJson
    },
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
  
  if (config._needsCloudflareSetup) {
    result._needsCloudflareSetup = true;
    result._environment = config._environment;
  }
  
  return result;
}


function showHelp() {
  console.log(`
🚀 Face Swap AI - Deployment Script

USAGE:
  node deploy/deploy.js

DESCRIPTION:
  Automatically reads configuration from deploy/deployments-secrets.json and authenticates with Cloudflare and GCP.
  Uses API tokens for authentication - no manual login required.
  No command line arguments are allowed - all configuration must be in deploy/deployments-secrets.json.

DEPLOYMENTS-SECRETS.JSON FORMAT:
  Create a deploy/deployments-secrets.json file with environments structure:

  {
    "environments": {
      "production": {
        "name": "production",
        "workerName": "my-store-backend",
        "pagesProjectName": "my-store-frontend",
        "databaseName": "my-store-db",
        "bucketName": "my-store-images",
        "cloudflare": {
          "accountId": "your_cloudflare_account_id",
          "apiToken": "your_cloudflare_api_token"
        },
        "gcp": {
          "projectId": "your-gcp-project-id",
          "serviceAccountKeyJson": { ... }
        },
        "RAPIDAPI_KEY": "your_rapidapi_key_here",
        "RAPIDAPI_HOST": "ai-face-swap2.p.rapidapi.com",
        "RAPIDAPI_ENDPOINT": "https://ai-face-swap2.p.rapidapi.com/public/process/urls",
        "GOOGLE_VISION_API_KEY": "your_google_vision_key_here",
        "GOOGLE_VERTEX_PROJECT_ID": "your-gcp-project-id",
        "GOOGLE_VERTEX_LOCATION": "us-central1",
        "GOOGLE_VISION_ENDPOINT": "https://vision.googleapis.com/v1/images:annotate",
        "GOOGLE_SERVICE_ACCOUNT_EMAIL": "your-service-account@project.iam.gserviceaccount.com",
        "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
      }
    }
  }

REQUIRED FIELDS:
  • workerName, pagesProjectName, databaseName, bucketName
  • cloudflare.accountId, cloudflare.apiToken
  • gcp.projectId, gcp.serviceAccountKeyJson
  • RAPIDAPI_KEY, RAPIDAPI_HOST, RAPIDAPI_ENDPOINT
  • GOOGLE_VISION_API_KEY, GOOGLE_VERTEX_PROJECT_ID, GOOGLE_VERTEX_LOCATION, GOOGLE_VISION_ENDPOINT
  • GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY

ENVIRONMENT VARIABLES:
  • DEPLOY_ENV=staging (optional, defaults to production)

EXAMPLES:
  # Deploy to production (default)
  node deploy/deploy.js

  # Deploy to staging environment
  DEPLOY_ENV=staging node deploy/deploy.js

  # Show this help
  node deploy/deploy.js --help

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

// Generate wrangler.jsonc dynamically from deployment config
function generateWranglerConfig(config) {
  return {
    name: config.workerName,
    main: 'src/index.ts',
    compatibility_date: '2024-01-01',
    account_id: config.cloudflare.accountId,
    d1_databases: [
      {
        binding: 'DB',
        database_name: config.databaseName
      }
    ],
    r2_buckets: [
      {
        binding: 'FACESWAP_IMAGES',
        bucket_name: config.bucketName
      }
    ]
  };
}

// Get wrangler config path
function getWranglerConfigPath() {
  const homedir = os.homedir();
  return path.join(homedir, '.wrangler', 'config', 'default.toml');
}

// Extract token from wrangler config
function extractTokenFromWrangler() {
  const configPath = getWranglerConfigPath();
  
  if (!fs.existsSync(configPath)) {
    return null;
  }
  
  const configContent = fs.readFileSync(configPath, 'utf8');
  
  const apiTokenMatch = configContent.match(/api_token\s*=\s*"([^"]+)"/);
  if (apiTokenMatch) {
    return { type: 'api_token', token: apiTokenMatch[1] };
  }
  
  const oauthTokenMatch = configContent.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (oauthTokenMatch) {
    return { type: 'oauth_token', token: oauthTokenMatch[1] };
  }
  
  return null;
}

// Login to wrangler and extract token
async function loginWranglerAndExtractToken() {
  return new Promise((resolve, reject) => {
    console.log('\n' + '='.repeat(60));
    log.info('🔐 Starting automatic Cloudflare login...');
    log.info('📱 A browser window will open for authentication');
    log.info('⏳ Please complete the login in your browser...');
    console.log('='.repeat(60) + '\n');
    
    const originalEnvToken = process.env.CLOUDFLARE_API_TOKEN;
    const originalEnvAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    
    const wranglerProcess = spawn('wrangler', ['login'], {
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        BROWSER: process.env.BROWSER || 'default'
      }
    });
    
    wranglerProcess.on('close', (code) => {
      if (code === 0) {
        log.info('Waiting for token to be saved...');
        let attempts = 0;
        const maxAttempts = 10;
        
        const checkToken = () => {
          attempts++;
          const tokenInfo = extractTokenFromWrangler();
          if (tokenInfo) {
            console.log('\n' + '='.repeat(60));
            log.success('✅ Wrangler login completed successfully!');
            console.log('='.repeat(60) + '\n');
            
            if (originalEnvToken !== undefined) {
              process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
            }
            if (originalEnvAccountId !== undefined) {
              process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
            }
            
            resolve(tokenInfo);
          } else if (attempts < maxAttempts) {
            setTimeout(checkToken, 1000);
          } else {
            if (originalEnvToken !== undefined) {
              process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
            }
            if (originalEnvAccountId !== undefined) {
              process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
            }
            reject(new Error('Token not found in wrangler config after login. Please try running "wrangler login" manually.'));
          }
        };
        
        setTimeout(checkToken, 2000);
      } else {
        if (originalEnvToken !== undefined) {
          process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
        }
        if (originalEnvAccountId !== undefined) {
          process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
        }
        reject(new Error(`Wrangler login failed with code ${code}`));
      }
    });
    
    wranglerProcess.on('error', (error) => {
      if (originalEnvToken !== undefined) {
        process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
      }
      if (originalEnvAccountId !== undefined) {
        process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
      }
      reject(error);
    });
  });
}

// Check if token is invalid
function isInvalidTokenError(error) {
  const errorMsg = error.message || error.toString() || '';
  return errorMsg.includes('Invalid access token') ||
         errorMsg.includes('code: 9109') ||
         errorMsg.includes('Authentication error') ||
         errorMsg.includes('Unauthorized') ||
         errorMsg.includes('Invalid API Token');
}

// Get account ID from wrangler whoami (preferred method)
// Note: This function should be called when CLOUDFLARE_API_TOKEN is already set temporarily
// Returns null if not found, throws error if token is invalid
function getAccountIdFromWrangler() {
  try {
    const whoamiOutput = execCommand('wrangler whoami', { silent: true, throwOnError: false });
    if (whoamiOutput) {
      if (whoamiOutput.includes('Invalid access token') || 
          whoamiOutput.includes('code: 9109') ||
          whoamiOutput.includes('Authentication error') ||
          whoamiOutput.includes('Unauthorized')) {
        throw new Error('Invalid access token');
      }
      
      const accountIdMatch = whoamiOutput.match(/Account ID:\s*([a-f0-9]{32})/i);
      if (accountIdMatch) {
        return accountIdMatch[1];
      }
      const idMatch = whoamiOutput.match(/([a-f0-9]{32})/);
      if (idMatch) {
        return idMatch[1];
      }
    }
  } catch (error) {
    if (isInvalidTokenError(error)) {
      throw error;
    }
  }
  return null;
}

// Get account ID from token using Cloudflare API (fallback)
async function getAccountIdFromToken(token) {
  const https = require('https');
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.cloudflare.com',
      path: '/client/v4/accounts',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success && json.result && json.result.length > 0) {
            resolve(json.result[0].id);
          } else {
            reject(new Error(json.errors?.[0]?.message || 'Failed to get account ID'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// Setup Cloudflare token from wrangler login and save to file (DO NOT set ENV)
// This function ONLY checks deployments-secrets.json file, never ENV or wrangler config
async function setupCloudflareFromWrangler(environment = null) {
  console.log('\n' + '='.repeat(60));
  log.info('🔧 Setting up Cloudflare authentication from wrangler...');
  console.log('='.repeat(60) + '\n');
  
  const originalEnvToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalEnvAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  
  log.info('Credentials are empty in deployments-secrets.json');
  log.info('Starting automatic login process...');
  
  const tokenInfo = await loginWranglerAndExtractToken();
  const token = tokenInfo.token;
  
  process.env.CLOUDFLARE_API_TOKEN = token;
  
  log.info('Getting account ID...');
  
  let accountId = null;
  
  try {
    accountId = getAccountIdFromWrangler();
    if (accountId) {
      log.success(`Account ID found via wrangler: ${accountId}`);
    }
  } catch (error) {
    log.warn('Could not get account ID from wrangler, trying API...');
  }
  
  if (!accountId) {
    try {
      log.info('Fetching account ID from Cloudflare API...');
      accountId = await getAccountIdFromToken(token);
      log.success(`Account ID: ${accountId}`);
    } catch (error) {
      log.error(`Failed to get account ID: ${error.message}`);
      log.info('Trying alternative method...');
      
      try {
        const whoamiOutput = execCommand('wrangler whoami', { silent: false, throwOnError: false });
        if (whoamiOutput) {
          log.info('Wrangler whoami output:');
          console.log(whoamiOutput);
          const accountIdMatch = whoamiOutput.match(/Account ID[:\s]+([a-f0-9]{32})/i);
          if (accountIdMatch) {
            accountId = accountIdMatch[1];
            log.success(`Account ID extracted: ${accountId}`);
          }
        }
      } catch (whoamiError) {
        // Ignore
      }
    }
  }
  
  if (!accountId) {
    process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
    throw new Error('Could not determine account ID. Please check your Cloudflare connection.');
  }
  
  const secretsPath = path.join(process.cwd(), 'deploy', 'deployments-secrets.json');
  if (fs.existsSync(secretsPath)) {
    try {
      const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      const env = environment || process.env.DEPLOY_ENV || 'production';
      
      if (!secrets.environments) {
        secrets.environments = {};
      }
      if (!secrets.environments[env]) {
        secrets.environments[env] = {};
      }
      if (!secrets.environments[env].cloudflare) {
        secrets.environments[env].cloudflare = {};
      }
      
      secrets.environments[env].cloudflare.accountId = accountId;
      secrets.environments[env].cloudflare.apiToken = token;
      
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
      console.log('\n' + '='.repeat(60));
      log.success(`✅ Saved token to deploy/deployments-secrets.json (${env} environment)`);
      console.log('='.repeat(60) + '\n');
    } catch (error) {
      process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
      process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
      log.warn(`Could not save token to secrets file: ${error.message}`);
      throw error;
    }
  }
  
  process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
  process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
  
  return { accountId, apiToken: token };
}

// Deployment functions for CLI only
const deploymentUtils = {
  executeWithLogs(command, cwd, stepName) {
    return executeWithLogs(command, cwd, stepName);
  },

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

  async authenticateCloudflare(apiToken, accountId) {
    // Check cache first
    const cache = loadCache();
    const cacheKey = `cloudflareAuth_${accountId}`;
    if (cache.checks && cache.checks[cacheKey] === true) {
      return true;
    }

    try {
      // Set Cloudflare API token as environment variable (Wrangler v2+ uses this)
      process.env.CLOUDFLARE_API_TOKEN = apiToken;
      process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

      // Verify authentication
      const whoamiResult = execCommand('wrangler whoami', { silent: true, throwOnError: false });
      if (whoamiResult && (whoamiResult.includes(accountId) || whoamiResult.trim().length > 0)) {
        // Cache the result
        cache.checks = cache.checks || {};
        cache.checks[cacheKey] = true;
        saveCache(cache);
        return true;
      }

      return false;
    } catch (error) {
      cache.checks = cache.checks || {};
      cache.checks[cacheKey] = false;
      saveCache(cache);
      return false;
    }
  },

  async authenticateGCP(serviceAccountKeyJson, projectId) {
    // Check cache first
    const cache = loadCache();
    const cacheKey = `gcpAuth_${projectId}`;
    if (cache.checks && cache.checks[cacheKey] === true) {
      return true;
    }

    try {
      // Create temporary service account key file
      const keyFilePath = path.join(os.tmpdir(), `gcp-key-${Date.now()}.json`);
      fs.writeFileSync(keyFilePath, JSON.stringify(serviceAccountKeyJson, null, 2));

      // Authenticate using service account key
      execCommand(`gcloud auth activate-service-account --key-file=${keyFilePath}`, { silent: true, throwOnError: false });

      // Set project
      execCommand(`gcloud config set project ${projectId}`, { silent: true, throwOnError: false });

      // Verify authentication
      const authList = execCommand('gcloud auth list --format="value(account)"', { silent: true, throwOnError: false });
      if (authList && authList.trim().includes(serviceAccountKeyJson.client_email)) {
        // Cache the result
        cache.checks = cache.checks || {};
        cache.checks[cacheKey] = true;
        saveCache(cache);

        // Clean up temporary file
        try {
          fs.unlinkSync(keyFilePath);
        } catch {
          // Ignore cleanup errors
        }

        return true;
      }

      // Clean up temporary file on failure
      try {
        fs.unlinkSync(keyFilePath);
      } catch {
        // Ignore cleanup errors
      }

      return false;
    } catch (error) {
      cache.checks = cache.checks || {};
      cache.checks[cacheKey] = false;
      saveCache(cache);
      return false;
    }
  },

  checkAuth() {
    // This is now handled by authenticateCloudflare
    return true;
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

  async ensureR2Bucket(codebasePath, bucketName = DEFAULT_R2_BUCKET_NAME) {
    // Check cache first
    const cache = loadCache();
    const cacheKey = `r2Bucket_${bucketName}`;
    if (cache.checks && cache.checks[cacheKey] === true) {
      return;
    }

    try {
      const listResult = await this.executeWithLogs('wrangler r2 bucket list', codebasePath, 'check-r2');
      const output = listResult.stdout || '';

      if (!output || !output.includes(bucketName)) {
        await this.executeWithLogs(`wrangler r2 bucket create ${bucketName}`, codebasePath, 'check-r2');
      }
      // Cache the result
      const cacheAfter = loadCache();
      cacheAfter.checks = cacheAfter.checks || {};
      cacheAfter.checks[cacheKey] = true;
      saveCache(cacheAfter);
    } catch (error) {
      // Bucket might already exist or command might fail - non-fatal
      if (error.message && (error.message.includes('already exists') || error.message.includes('no such table'))) {
        const cacheAfter = loadCache();
        cacheAfter.checks = cacheAfter.checks || {};
        cacheAfter.checks[cacheKey] = true;
        saveCache(cacheAfter);
      }
    }
  },

  async ensureD1Database(codebasePath, databaseName = DEFAULT_D1_DATABASE_NAME) {
    try {
      const output = execSync('wrangler d1 list', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
        cwd: codebasePath
      });

      if (!output || !output.includes(databaseName)) {
        // Use executeWithLogs to auto-answer prompts
        await this.executeWithLogs(`wrangler d1 create ${databaseName}`, codebasePath, 'check-d1');

        // Initialize schema
        const schemaPath = path.join(codebasePath, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
          try {
            await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, codebasePath, 'check-d1');
          } catch (error) {
            // If schema fails, recreate database
            await this.executeWithLogs(`wrangler d1 delete ${databaseName}`, codebasePath, 'check-d1');
            await this.executeWithLogs(`wrangler d1 create ${databaseName}`, codebasePath, 'check-d1');
            await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, codebasePath, 'check-d1');
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
                const resultsCheck = execSync(`wrangler d1 execute ${databaseName} --remote --command="PRAGMA table_info(results);"`, {
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
              await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, codebasePath, 'check-d1');

              // If results table exists but has wrong structure, fix it
              try {
                const resultsCheck = execSync(`wrangler d1 execute ${databaseName} --remote --command="PRAGMA table_info(results);"`, {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath
                });

                if (resultsCheck && resultsCheck.includes('preset_collection_id') && !resultsCheck.includes('selfie_id')) {
                  // Check if results table has data
                  const countCheck = execSync(`wrangler d1 execute ${databaseName} --remote --command="SELECT COUNT(*) as count FROM results;"`, {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 10000,
                    cwd: codebasePath
                  });

                  const hasData = countCheck && countCheck.includes('"count":') && !countCheck.includes('"count":0');

                  if (!hasData) {
                    // Safe to recreate - table is empty
                    await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --command="DROP TABLE IF EXISTS results;"`, codebasePath, 'check-d1');
                    await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --command="CREATE TABLE results (id TEXT PRIMARY KEY, selfie_id TEXT NOT NULL, preset_collection_id TEXT NOT NULL, preset_image_id TEXT NOT NULL, preset_name TEXT NOT NULL, result_url TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (selfie_id) REFERENCES selfies(id), FOREIGN KEY (preset_collection_id) REFERENCES preset_collections(id), FOREIGN KEY (preset_image_id) REFERENCES preset_images(id));"`, codebasePath, 'check-d1');
                  }
                }
              } catch (fixError) {
                // Could not auto-fix results table structure - non-fatal
              }
            } catch (error) {
              // Try to create missing selfies table if it doesn't exist
              try {
                const selfiesCheck = execSync(`wrangler d1 execute ${databaseName} --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='selfies';"`, {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath
                });

                if (!selfiesCheck || !selfiesCheck.includes('selfies')) {
                  await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --command="CREATE TABLE IF NOT EXISTS selfies (id TEXT PRIMARY KEY, image_url TEXT NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));"`, codebasePath, 'check-d1');
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
      // Cache the result
      const cacheAfter = loadCache();
      cacheAfter.checks = cacheAfter.checks || {};
      cacheAfter.checks[`d1Database_${databaseName}`] = true;
      saveCache(cacheAfter);
    } catch (error) {
      // Database might already exist - non-fatal
      // Still cache as OK if it's a non-critical error
      if (error.message && (error.message.includes('already exists') || error.message.includes('no such table'))) {
        const cacheAfter = loadCache();
        cacheAfter.checks = cacheAfter.checks || {};
        cacheAfter.checks[`d1Database_${databaseName}`] = true;
        saveCache(cacheAfter);
      }
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  },

  async deploySecrets(secrets, codebasePath, workerName) {
    if (!secrets) {
      throw new Error('No secrets provided');
    }

    const secretKeys = Object.keys(secrets);
    if (secretKeys.length === 0) {
      return { success: true, deployed: 0, total: 0 };
    }

    log.info(`Deploying ${secretKeys.length} secrets in batch...`);

    const tempSecretsFile = path.join(os.tmpdir(), `wrangler-secrets-${Date.now()}.json`);
    
    try {
      const secretsJson = {};
      for (const key of secretKeys) {
        secretsJson[key] = secrets[key];
      }
      
      fs.writeFileSync(tempSecretsFile, JSON.stringify(secretsJson, null, 2), 'utf8');

      let command;
      if (workerName) {
        command = `wrangler secret bulk "${tempSecretsFile}" --name ${workerName}`;
      } else {
        command = `wrangler secret bulk "${tempSecretsFile}"`;
      }

      const result = await this.executeWithLogs(
        command,
        codebasePath,
        'deploy-secrets-batch'
      );

      if (result.success) {
        log.success(`Successfully deployed ${secretKeys.length} secrets in batch`);
        return { success: true, deployed: secretKeys.length, total: secretKeys.length };
      } else {
        log.warn('Batch upload failed, falling back to individual uploads...');
        
        let successCount = 0;
        for (const key of secretKeys) {
          const value = secrets[key];
          const individualCommand = workerName
            ? `wrangler secret put ${key} --name ${workerName}`
            : `wrangler secret put ${key}`;

          console.log(`[Deploy] Setting secret: ${key}`);

          const fullCommand = `echo "${value.replace(/"/g, '\\"')}" | ${individualCommand}`;

          const individualResult = await this.executeWithLogs(
            fullCommand,
            codebasePath,
            'deploy-secrets'
          );

          if (individualResult.success) {
            successCount++;
          } else {
            console.error(`[Deploy] Failed to set secret: ${key}`);
          }
        }

        if (successCount === 0) {
          throw new Error('Failed to deploy any secrets');
        }

        if (successCount < secretKeys.length) {
          console.warn(`[Deploy] Only ${successCount}/${secretKeys.length} secrets were deployed successfully`);
        }

        return { success: true, deployed: successCount, total: secretKeys.length };
      }
    } catch (error) {
      log.warn(`Batch upload error: ${error.message}, falling back to individual uploads...`);
      
      let successCount = 0;
      for (const key of secretKeys) {
        const value = secrets[key];
        const individualCommand = workerName
          ? `wrangler secret put ${key} --name ${workerName}`
          : `wrangler secret put ${key}`;

        console.log(`[Deploy] Setting secret: ${key}`);

        const fullCommand = `echo "${value.replace(/"/g, '\\"')}" | ${individualCommand}`;

        try {
          const individualResult = await this.executeWithLogs(
            fullCommand,
            codebasePath,
            'deploy-secrets'
          );

          if (individualResult.success) {
            successCount++;
          } else {
            console.error(`[Deploy] Failed to set secret: ${key}`);
          }
        } catch (individualError) {
          console.error(`[Deploy] Failed to set secret: ${key} - ${individualError.message}`);
        }
      }

      if (successCount === 0) {
        throw new Error('Failed to deploy any secrets');
      }

      if (successCount < secretKeys.length) {
        console.warn(`[Deploy] Only ${successCount}/${secretKeys.length} secrets were deployed successfully`);
      }

      return { success: true, deployed: successCount, total: secretKeys.length };
    } finally {
      if (fs.existsSync(tempSecretsFile)) {
        try {
          fs.unlinkSync(tempSecretsFile);
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }
  },

  async deployWorker(codebasePath, workerName, deploymentConfig) {
    const wranglerPath = path.join(codebasePath, 'wrangler.jsonc');
    let wranglerConfigGenerated = false;

    try {
      // Generate wrangler.jsonc dynamically from deployment config
      const wranglerConfig = generateWranglerConfig(deploymentConfig);
      fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, 2), 'utf8');
      wranglerConfigGenerated = true;
      console.log('[Deploy] Generated wrangler.jsonc from deployment config');

      let result = await this.executeWithLogs('wrangler deploy', codebasePath, 'deploy-worker');

      // Handle error 10214: Can't edit settings on non-deployed worker
      if (!result.success && result.error && result.error.includes('code: 10214')) {
        console.log('[Deploy] Error 10214 detected - worker not deployed yet. Retrying...');
        const retryResult = await this.executeWithLogs('wrangler deploy', codebasePath, 'deploy-worker');

        if (!retryResult.success && !result.success) {
          throw new Error(retryResult.error || result.error || 'Worker deployment failed');
        }

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

      return workerUrl;
    } finally {
      // Delete generated wrangler.jsonc to prevent wrong environment deployments
      if (wranglerConfigGenerated && fs.existsSync(wranglerPath)) {
        try {
          fs.unlinkSync(wranglerPath);
          console.log('[Deploy] Deleted wrangler.jsonc after deployment to prevent wrong environment deployments');
        } catch (error) {
          console.warn('[Deploy] Could not delete wrangler.jsonc:', error.message);
        }
      }
    }
  },

  async ensurePagesProject(codebasePath, pagesProjectName) {
    try {
      const listResult = await this.executeWithLogs('wrangler pages project list', codebasePath, 'check-pages');
      const output = listResult.stdout || '';

      if (!output || !output.includes(pagesProjectName)) {
        log.info(`Pages project '${pagesProjectName}' not found, creating...`);
        await this.executeWithLogs(`wrangler pages project create ${pagesProjectName} --production-branch=main`, codebasePath, 'create-pages');
        log.success(`Pages project '${pagesProjectName}' created`);
      } else {
        log.success(`Pages project '${pagesProjectName}' already exists`);
      }
    } catch (error) {
      if (error.message && (error.message.includes('Project not found') || error.message.includes('Must specify a production branch'))) {
        log.info(`Pages project '${pagesProjectName}' not found, creating...`);
        try {
          await this.executeWithLogs(`wrangler pages project create ${pagesProjectName} --production-branch=main`, codebasePath, 'create-pages');
          log.success(`Pages project '${pagesProjectName}' created`);
        } catch (createError) {
          log.warn(`Could not create Pages project: ${createError.message}`);
        }
      } else {
        log.warn(`Could not check Pages projects: ${error.message}`);
      }
    }
  },

  async deployPages(codebasePath, pagesProjectName) {
    await this.ensurePagesProject(codebasePath, pagesProjectName);

    let publicPageDir = path.join(codebasePath, 'public_page');

    if (!fs.existsSync(publicPageDir)) {
      const projectRoot = path.resolve(__dirname);
      const rootPublicPageDir = path.join(projectRoot, 'public_page');
      if (fs.existsSync(rootPublicPageDir)) {
        publicPageDir = rootPublicPageDir;
      }
    }

    const pagesUrl = `https://${pagesProjectName}.pages.dev/`;

    if (!fs.existsSync(publicPageDir)) {
      log.warn('public_page directory not found in codebasePath or project root, skipping Pages deployment');
      return pagesUrl;
    }

    const absolutePublicPageDir = path.resolve(publicPageDir);

    try {
      const command = `wrangler pages deploy "${absolutePublicPageDir}" --project-name=${pagesProjectName} --branch=main --commit-dirty=true`;

      const result = await this.executeWithLogs(
        command,
        codebasePath,
        'deploy-pages'
      );

      if (result.success) {
        return pagesUrl;
      } else {
        if (result.error && result.error.includes('Project not found')) {
          log.warn('Project not found, attempting to create and retry...');
          await this.ensurePagesProject(codebasePath, pagesProjectName);
          const retryResult = await this.executeWithLogs(
            command,
            codebasePath,
            'deploy-pages-retry'
          );
          if (retryResult.success) {
            return pagesUrl;
          }
        }
        return pagesUrl;
      }
    } catch (error) {
      if (error.message && error.message.includes('Project not found')) {
        log.warn('Project not found, attempting to create and retry...');
        try {
          await this.ensurePagesProject(codebasePath, pagesProjectName);
          const command = `wrangler pages deploy "${absolutePublicPageDir}" --project-name=${pagesProjectName} --branch=main --commit-dirty=true`;
          const retryResult = await this.executeWithLogs(
            command,
            codebasePath,
            'deploy-pages-retry'
          );
          if (retryResult.success) {
            return pagesUrl;
          }
        } catch (retryError) {
          log.warn(`Pages deployment error: ${retryError.message}. URL: ${pagesUrl}`);
        }
      } else {
        log.warn(`Pages deployment error: ${error.message}. URL: ${pagesUrl}`);
      }
      return pagesUrl;
    }
  }
};


// CLI main function
// CLI main function - runs when file is executed directly
async function main() {
  // Parse command line arguments (only allows --help)
  parseCliArgs();

  // Load configuration from deploy/deployments-secrets.json
  console.log('📄 Loading configuration from deploy/deployments-secrets.json...');
  const deploymentConfig = await loadSecretsConfig();

  console.log('\n🚀 Face Swap AI - Deployment Script');
  console.log('====================================\n');

  // Show configuration
  console.log('📋 Configuration:');
  console.log(`   Worker Name: ${deploymentConfig.workerName}`);
  console.log(`   Pages Name: ${deploymentConfig.pagesProjectName}`);
  console.log(`   Deploy Pages: ${deploymentConfig.deployPages ? 'Yes' : 'No (disabled)'}`);
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

  // Authenticate with GCP automatically
  log.info('Authenticating with GCP...');
  if (!await deploymentUtils.authenticateGCP(deploymentConfig.gcp.serviceAccountKeyJson, deploymentConfig.gcp.projectId)) {
    log.error('GCP authentication failed');
    log.error('Please check your service account credentials in secrets.json');
    process.exit(1);
  } else {
    log.success('GCP authenticated successfully');
  }

  // Authenticate with Cloudflare - set ENV from file ONLY for deployment
  // IMPORTANT: We use deployments-secrets.json as single source of truth
  // ENV variables are set temporarily during deployment and cleared afterward
  // This prevents conflicts when deploying to multiple Cloudflare accounts on same machine
  log.info('Authenticating with Cloudflare...');
  
  const cloudflareToken = deploymentConfig.cloudflare.apiToken;
  const cloudflareAccountId = deploymentConfig.cloudflare.accountId;
  
  if (!cloudflareToken || !cloudflareAccountId || 
      cloudflareToken.trim() === '' || cloudflareAccountId.trim() === '') {
    log.error('Cloudflare credentials are empty in deployments-secrets.json');
    log.error('This should have been auto-filled. Please check the file.');
    process.exit(1);
  }
  
  // Save original ENV values to restore later
  const originalEnvToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalEnvAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  
  // Set ENV from file (temporary, only for this deployment)
  process.env.CLOUDFLARE_API_TOKEN = cloudflareToken;
  process.env.CLOUDFLARE_ACCOUNT_ID = cloudflareAccountId;
  
  try {
    if (!await deploymentUtils.authenticateCloudflare(cloudflareToken, cloudflareAccountId)) {
      process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
      process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
      log.error('Cloudflare authentication failed');
      log.error('Please check your API token and account ID in secrets.json');
      process.exit(1);
    } else {
      log.success('Cloudflare authenticated successfully');
    }
  } catch (error) {
    process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
    throw error;
  }

  // Check R2 bucket
  await deploymentUtils.ensureR2Bucket(process.cwd(), deploymentConfig.bucketName);

  // Check D1 database
  await deploymentUtils.ensureD1Database(process.cwd(), deploymentConfig.databaseName);

  // Deploy secrets if provided
  if (Object.keys(deploymentConfig.secrets).length > 0) {
    log.info('Deploying secrets...');
    try {
      await deploymentUtils.deploySecrets(deploymentConfig.secrets, process.cwd(), deploymentConfig.workerName);
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
    workerUrl = await deploymentUtils.deployWorker(process.cwd(), deploymentConfig.workerName, deploymentConfig);
  } catch (error) {
    log.error('Worker deployment failed!');
    process.exit(1);
  }

  // Deploy Pages (if enabled)
  if (deploymentConfig.deployPages) {
    log.info(`Deploying to Cloudflare Pages: ${deploymentConfig.pagesProjectName}...`);
    const publicPageDir = path.join(process.cwd(), 'public_page');

    if (fs.existsSync(publicPageDir)) {
      try {
        pagesUrl = await deploymentUtils.deployPages(process.cwd(), deploymentConfig.pagesProjectName);
      } catch (error) {
        log.warn('Pages deployment failed (non-critical)');
      }
    } else {
      log.warn('public_page directory not found, skipping Pages deployment');
    }
  } else {
    log.info('Pages deployment is disabled by default. Set DEPLOY_PAGES=true to enable.');
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

  // Cleanup: Clear Cloudflare ENV variables after deployment
  if (originalEnvToken !== undefined) {
    if (originalEnvToken) {
      process.env.CLOUDFLARE_API_TOKEN = originalEnvToken;
    } else {
      delete process.env.CLOUDFLARE_API_TOKEN;
    }
  } else {
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
  
  if (originalEnvAccountId !== undefined) {
    if (originalEnvAccountId) {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalEnvAccountId;
    } else {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    }
  } else {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  }
  
  log.info('Cleared Cloudflare environment variables (credentials remain in deployments-secrets.json)');

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
 