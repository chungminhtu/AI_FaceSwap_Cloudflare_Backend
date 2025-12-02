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
// NO DEFAULT VALUES - All values MUST come from deployments-secrets.json
// This prevents configuration mismatches and vulnerabilities
// ============================================================================

// Parse command line arguments for CLI usage
function parseCliArgs() {
  const args = process.argv.slice(2);

  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.length === 0) {
    console.error('Error: Command or environment name is required.');
    console.error('Usage: node deploy.js <env-name>');
    console.error('       node deploy.js setup');
    console.error('Run "node deploy.js --help" for usage information.');
    process.exit(1);
  }

  if (args[0] === 'setup') {
    return { command: 'setup' };
  }

  if (args.length > 1) {
    console.error('Error: Only one argument is allowed.');
    console.error('Usage: node deploy.js <env-name>');
    process.exit(1);
  }

  return { envName: args[0] };
}

// Load configuration from deployments-secrets.json with environment support
function loadDeploymentConfig(envName) {
  const configPath = path.join(process.cwd(), 'deploy', 'deployments-secrets.json');

  try {
    if (!fs.existsSync(configPath)) {
      console.error(`deployments-secrets.json not found. Please create it with your configuration.`);
      console.log('Expected path: deployments-secrets.json');
      process.exit(1);
    }

    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);

    if (!config.environments || !config.environments[envName]) {
      console.error(`Error: Environment "${envName}" not found in deployments-secrets.json`);
      console.error(`Available environments: ${Object.keys(config.environments || {}).join(', ')}`);
      process.exit(1);
    }

    const envConfig = config.environments[envName];
    const parsedConfig = parseConfigObject(envConfig);

    const savedCredentials = loadCredentials();
    if (savedCredentials) {
      if (savedCredentials.cloudflare) {
        if (!parsedConfig.cloudflare.accountId && savedCredentials.cloudflare.accountId) {
          parsedConfig.cloudflare.accountId = savedCredentials.cloudflare.accountId;
        }
        if (!parsedConfig.cloudflare.apiToken && savedCredentials.cloudflare.apiToken) {
          parsedConfig.cloudflare.apiToken = savedCredentials.cloudflare.apiToken;
        }
        if (!parsedConfig.cloudflare.email && savedCredentials.cloudflare.email) {
          parsedConfig.cloudflare.email = savedCredentials.cloudflare.email;
        }
      }
      if (savedCredentials.gcp) {
        if (!parsedConfig.gcp.projectId && savedCredentials.gcp.projectId) {
          parsedConfig.gcp.projectId = savedCredentials.gcp.projectId;
        }
        if (!parsedConfig.gcp.accountEmail && savedCredentials.gcp.accountEmail) {
          parsedConfig.gcp.accountEmail = savedCredentials.gcp.accountEmail;
        }
      }
    }

    return parsedConfig;
  } catch (error) {
    console.error(`Error loading deployments-secrets.json:`, error.message);
    process.exit(1);
  }
}

// Setup command - interactive login and save credentials
async function runSetup() {
  console.log('\n🔧 Setup - Interactive Login and Credential Extraction');
  console.log('='.repeat(60));
  console.log('');

  if (!deploymentUtils.checkWrangler()) {
    log.error('Wrangler CLI not found. Please install it first:');
    log.info('  npm install -g wrangler');
    process.exit(1);
  }

  if (!deploymentUtils.checkGcloud()) {
    log.error('gcloud CLI not found. Please install Google Cloud SDK first.');
    log.info('Download from: https://cloud.google.com/sdk/docs/install');
    process.exit(1);
  }

  const credentials = {
    cloudflare: {},
    gcp: {}
  };

  console.log('📋 Step 1: Cloudflare Authentication');
  console.log('-----------------------------------');
  log.info('Please login to Cloudflare in the browser that will open...');
  
  try {
    execCommand('wrangler login', { stdio: 'inherit' });
    log.success('Cloudflare login completed');
    
    const cloudflareCreds = await extractCloudflareCredentials();
    credentials.cloudflare = cloudflareCreds;
    log.success(`Extracted Cloudflare credentials for: ${cloudflareCreds.email}`);
    log.success(`Account ID: ${cloudflareCreds.accountId}`);
  } catch (error) {
    log.error(`Cloudflare setup failed: ${error.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('📋 Step 2: GCP Authentication');
  console.log('-----------------------------------');
  log.info('Please login to GCP in the browser that will open...');
  
  try {
    execCommand('gcloud auth login', { stdio: 'inherit' });
    log.success('GCP login completed');
    
    const gcpCreds = await extractGcpCredentials();
    credentials.gcp = gcpCreds;
    log.success(`Extracted GCP credentials`);
    log.success(`Project ID: ${gcpCreds.projectId}`);
    if (gcpCreds.accountEmail) {
      log.success(`Account Email: ${gcpCreds.accountEmail}`);
    }
  } catch (error) {
    log.error(`GCP setup failed: ${error.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('💾 Saving credentials...');
  if (saveCredentials(credentials)) {
    log.success('Credentials saved successfully!');
    console.log('');
    console.log('✅ Setup complete!');
    console.log('');
    console.log('You can now deploy using:');
    console.log(`  node deploy.js <env-name>`);
    console.log('');
    console.log('The saved credentials will be used automatically.');
  } else {
    log.error('Failed to save credentials');
    process.exit(1);
  }
}

// Parse and validate configuration object
function parseConfigObject(config) {
  // STRICT VALIDATION - ALL FIELDS REQUIRED, NO DEFAULTS
  const requiredFields = [
    'workerName', 'pagesProjectName', 'databaseName', 'bucketName',
    'RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT',
    'GOOGLE_VISION_API_KEY', 'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_VISION_ENDPOINT',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'
  ];

  const missingFields = requiredFields.filter(field => {
    const value = config[field];
    return value === undefined || value === null || value === '';
  });
  
  if (missingFields.length > 0) {
    throw new Error(`ERROR: Missing required fields in deployments-secrets.json: ${missingFields.join(', ')}. Cannot proceed - this prevents configuration mismatches and vulnerabilities.`);
  }

  // Validate cloudflare config
  if (!config.cloudflare || typeof config.cloudflare !== 'object') {
    throw new Error('ERROR: cloudflare configuration is required in deployments-secrets.json');
  }
  if (!config.cloudflare.accountId) {
    throw new Error('ERROR: cloudflare.accountId is required in deployments-secrets.json');
  }
  if (!config.cloudflare.apiToken) {
    throw new Error('ERROR: cloudflare.apiToken is required in deployments-secrets.json');
  }
  
  // Validate gcp config
  if (!config.gcp || typeof config.gcp !== 'object') {
    throw new Error('ERROR: gcp configuration is required in deployments-secrets.json');
  }
  if (!config.gcp.projectId) {
    throw new Error('ERROR: gcp.projectId is required in deployments-secrets.json');
  }
  if (!config.gcp.serviceAccountKeyJson) {
    throw new Error('ERROR: gcp.serviceAccountKeyJson is required in deployments-secrets.json');
  }

  return {
    workerName: config.workerName,
    pagesProjectName: config.pagesProjectName,
    databaseName: config.databaseName,
    bucketName: config.bucketName,
    cloudflare: config.cloudflare,
    gcp: config.gcp,
    secrets: {
      RAPIDAPI_KEY: config.RAPIDAPI_KEY,
      RAPIDAPI_HOST: config.RAPIDAPI_HOST,
      RAPIDAPI_ENDPOINT: config.RAPIDAPI_ENDPOINT,
      GOOGLE_VISION_API_KEY: config.GOOGLE_VISION_API_KEY,
      GOOGLE_VERTEX_PROJECT_ID: config.GOOGLE_VERTEX_PROJECT_ID,
      GOOGLE_VERTEX_LOCATION: config.GOOGLE_VERTEX_LOCATION,
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
  node deploy.js setup          # First-time setup: interactive login and save credentials
  node deploy.js <env-name>      # Deploy using saved credentials

DESCRIPTION:
  Deploys to Cloudflare Workers and Pages using environment-specific configuration.
  All credentials and settings are stored in a single deployments-secrets.json file.

DIRECTORY STRUCTURE:
  deployments-secrets.json     # All environment configurations and credentials

FIRST-TIME SETUP:
  1. Run: node deploy.js setup
  2. Login to Cloudflare in the browser
  3. Login to GCP in the browser
  4. Credentials will be automatically extracted and saved

DEPLOYMENTS-CONFIG.JSON FORMAT:
  {
    "environments": {
      "ai-office": {
        "name": "ai-office",
        "workerName": "ai-faceswap-backend-office",
        "pagesProjectName": "ai-faceswap-frontend-office",
        "databaseName": "faceswap-db-office",
        "bucketName": "faceswap-images-office",
        "cloudflare": {
          "accountId": "your_cloudflare_account_id_here",
          "apiToken": "your_cloudflare_api_token_here"
        },
        "gcp": {
          "projectId": "ai-photo-office",
          "serviceAccountKeyJson": "PASTE_YOUR_ENTIRE_SERVICE_ACCOUNT_JSON_HERE"
        },
        "RAPIDAPI_KEY": "",
        "RAPIDAPI_HOST": "ai-face-swap2.p.rapidapi.com",
        "RAPIDAPI_ENDPOINT": "https://ai-face-swap2.p.rapidapi.com/public/process/urls",
        "GOOGLE_VISION_API_KEY": "",
        "GOOGLE_VERTEX_PROJECT_ID": "",
        "GOOGLE_VERTEX_LOCATION": "us-central1",
        "GOOGLE_VISION_ENDPOINT": "https://vision.googleapis.com/v1/images:annotate",
        "GOOGLE_SERVICE_ACCOUNT_EMAIL": "",
        "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY": ""
      }
    }
  }

EXAMPLES:
  # First-time setup (interactive login)
  node deploy.js setup

  # Deploy to ai-office environment
  node deploy.js ai-office

  # Show this help
  node deploy.js --help

All project names should be unique per Cloudflare account to avoid conflicts.
`);
}

// Credentials file for storing authentication credentials
const getCredentialsFile = () => {
  const credentialsDir = path.join(process.cwd(), '.deploy-credentials');
  if (!fs.existsSync(credentialsDir)) {
    fs.mkdirSync(credentialsDir, { recursive: true });
  }
  return path.join(credentialsDir, 'credentials.json');
};


// Load saved credentials
function loadCredentials() {
  try {
    const credentialsPath = getCredentialsFile();
    if (fs.existsSync(credentialsPath)) {
      const content = fs.readFileSync(credentialsPath, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    // Ignore errors
  }
  return null;
}

// Save credentials
function saveCredentials(credentials) {
  try {
    const credentialsPath = getCredentialsFile();
    fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), 'utf8');
    fs.chmodSync(credentialsPath, 0o600);
    return true;
  } catch (error) {
    log.error(`Failed to save credentials: ${error.message}`);
    return false;
  }
}

// Extract Cloudflare credentials after login
async function extractCloudflareCredentials() {
  try {
    log.info('Extracting Cloudflare credentials...');
    
    let accountId = null;
    let email = null;
    
    const whoamiJsonOutput = execCommand('wrangler whoami --format json', { silent: true, throwOnError: false });
    if (whoamiJsonOutput) {
      try {
        const whoamiData = JSON.parse(whoamiJsonOutput);
        if (whoamiData) {
          if (whoamiData.accounts && whoamiData.accounts.length > 0) {
            accountId = whoamiData.accounts[0].id;
          }
          if (whoamiData.email) {
            email = whoamiData.email;
          }
        }
      } catch (e) {
        // JSON parse failed, try text format
      }
    }
    
    if (!accountId) {
      const whoamiOutput = execCommand('wrangler whoami', { silent: true, throwOnError: false });
      if (!whoamiOutput) {
        throw new Error('Not authenticated to Cloudflare. Please run "wrangler login" first.');
      }
      
      const accountIdMatch = whoamiOutput.match(/Account ID:\s*([a-f0-9]{32})/i);
      if (accountIdMatch) {
        accountId = accountIdMatch[1].trim();
      }
      
      const emailMatch = whoamiOutput.match(/You are logged in as (.+)/);
      if (emailMatch) {
        email = emailMatch[1].trim();
      }
    }

    if (!accountId) {
      log.warn('Could not automatically extract account ID from wrangler whoami.');
      accountId = await prompt('Enter your Cloudflare Account ID: ');
      if (!accountId || accountId.trim() === '') {
        throw new Error('Account ID is required');
      }
    }

    let apiToken = null;
    
    const possibleConfigPaths = [
      path.join(os.homedir(), '.wrangler', 'config', 'default.toml'),
      path.join(os.homedir(), '.wrangler', 'config', 'default.json'),
      path.join(process.cwd(), '.wrangler', 'config', 'default.toml'),
      path.join(process.cwd(), '.wrangler', 'config', 'default.json')
    ];
    
    for (const configPath of possibleConfigPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const configContent = fs.readFileSync(configPath, 'utf8');
          
          if (configPath.endsWith('.toml')) {
            const tokenMatch = configContent.match(/api_token\s*=\s*["']([^"']+)["']/);
            if (tokenMatch) {
              apiToken = tokenMatch[1];
              break;
            }
          } else if (configPath.endsWith('.json')) {
            const configData = JSON.parse(configContent);
            if (configData.api_token) {
              apiToken = configData.api_token;
              break;
            }
          }
        } catch (e) {
          // Continue to next path
        }
      }
    }
    
    if (!apiToken) {
      log.warn('API token not found in config files.');
      log.info('After wrangler login, the API token should be stored in ~/.wrangler/config/default.toml');
      log.info('If not found, you can create an API token at: https://dash.cloudflare.com/profile/api-tokens');
      apiToken = await prompt('Enter your Cloudflare API Token (required for auto-login): ');
      if (!apiToken || apiToken.trim() === '') {
        throw new Error('API token is required for non-interactive authentication');
      }
    }

    return {
      email: email || null,
      accountId: accountId.trim(),
      apiToken: apiToken.trim()
    };
  } catch (error) {
    log.error(`Failed to extract Cloudflare credentials: ${error.message}`);
    throw error;
  }
}

// Extract GCP credentials after login
async function extractGcpCredentials() {
  try {
    log.info('Extracting GCP credentials...');
    
    const projectId = execCommand('gcloud config get-value project', { silent: true, throwOnError: false });
    if (!projectId || !projectId.trim()) {
      log.warn('No GCP project set. Please set one:');
      const manualProjectId = await prompt('Enter your GCP Project ID: ');
      if (!manualProjectId || manualProjectId.trim() === '') {
        throw new Error('GCP Project ID is required');
      }
      execCommand(`gcloud config set project ${manualProjectId.trim()}`, { silent: true });
      return { projectId: manualProjectId.trim() };
    }

    const accountEmail = execCommand('gcloud config get-value account', { silent: true, throwOnError: false });
    
    return {
      projectId: projectId.trim(),
      accountEmail: accountEmail ? accountEmail.trim() : null
    };
  } catch (error) {
    log.error(`Failed to extract GCP credentials: ${error.message}`);
    throw error;
  }
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

  async setupCloudflareAuth(cloudflareConfig) {
    try {
      // Check config file credentials (only source now)
      const accountId = cloudflareConfig?.accountId && cloudflareConfig.accountId !== 'your_cloudflare_account_id_here' ? cloudflareConfig.accountId : null;
      const apiToken = cloudflareConfig?.apiToken && cloudflareConfig.apiToken !== 'your_cloudflare_api_token_here' ? cloudflareConfig.apiToken : null;
      const email = cloudflareConfig?.email;
      const apiKey = cloudflareConfig?.apiKey;

      if (!accountId) {
        throw new Error('Cloudflare accountId is required. Add it to deployments-secrets.json under cloudflare.accountId');
      }

      if (apiToken) {
        process.env.CLOUDFLARE_API_TOKEN = apiToken;
        process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
        
        const wranglerConfigDir = path.join(os.homedir(), '.wrangler', 'config');
        const wranglerConfigPath = path.join(wranglerConfigDir, 'default.toml');
        
        try {
          if (!fs.existsSync(wranglerConfigDir)) {
            fs.mkdirSync(wranglerConfigDir, { recursive: true });
          }
          
          let configContent = '';
          if (fs.existsSync(wranglerConfigPath)) {
            configContent = fs.readFileSync(wranglerConfigPath, 'utf8');
          }
          
          if (!configContent.includes('api_token')) {
            configContent += `\napi_token = "${apiToken}"\n`;
          } else {
            configContent = configContent.replace(/api_token\s*=\s*["'][^"']*["']/, `api_token = "${apiToken}"`);
          }
          
          fs.writeFileSync(wranglerConfigPath, configContent, 'utf8');
        } catch (configError) {
          log.warn(`Could not write API token to wrangler config: ${configError.message}`);
        }
        
        log.success('Using Cloudflare API token from config file');
        return true;
      } else if (email && apiKey) {
        process.env.CLOUDFLARE_EMAIL = email;
        process.env.CLOUDFLARE_API_KEY = apiKey;
        process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
        log.success('Using Cloudflare email and API key from config file');
        return true;
      } else {
        throw new Error('Cloudflare credentials (apiToken or email+apiKey) are required. Add them to deployments-secrets.json');
      }
    } catch (error) {
      log.error(`Cloudflare authentication setup failed: ${error.message}`);
      throw error;
    }
  },

  async setupGcpAuth(gcpConfig) {
    try {
      // Check config file credentials (only source now)
      const projectId = gcpConfig?.projectId;
      const serviceAccountKeyJson = gcpConfig?.serviceAccountKeyJson;
      const accountEmail = gcpConfig?.accountEmail;

      if (!projectId) {
        throw new Error('GCP projectId is required. Add it to deployments-secrets.json under gcp.projectId');
      }

      if (serviceAccountKeyJson && (typeof serviceAccountKeyJson === 'string' ? serviceAccountKeyJson.trim() !== '' : serviceAccountKeyJson)) {
        // Create temporary file with the JSON key content
        const tempKeyPath = path.join(os.tmpdir(), `gcp-key-${Date.now()}.json`);
        const keyContent = typeof serviceAccountKeyJson === 'object' ? JSON.stringify(serviceAccountKeyJson, null, 2) : serviceAccountKeyJson;
        fs.writeFileSync(tempKeyPath, keyContent, 'utf8');

        process.env.GOOGLE_APPLICATION_CREDENTIALS = tempKeyPath;
        execCommand(`gcloud auth activate-service-account --key-file="${tempKeyPath}"`, { silent: true });
        execCommand(`gcloud config set project ${projectId}`, { silent: true });

        // Clean up temp file after a short delay to ensure gcloud has read it
        setTimeout(() => {
          try {
            if (fs.existsSync(tempKeyPath)) {
              fs.unlinkSync(tempKeyPath);
            }
          } catch (cleanupError) {
            // Ignore cleanup errors
          }
        }, 5000);

        log.success('GCP authenticated using service account JSON from config file');
        return true;
      } else if (accountEmail) {
        execCommand(`gcloud config set project ${projectId}`, { silent: true });
        log.success(`GCP project set to: ${projectId}`);
        log.info('Using existing GCP authentication');
        return true;
      } else {
        execCommand(`gcloud config set project ${projectId}`, { silent: true });
        log.success(`GCP project set to: ${projectId} from config file`);
        log.info('Using existing GCP authentication');
        return true;
      }
    } catch (error) {
      log.error(`GCP authentication setup failed: ${error.message}`);
      throw error;
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
      let lastPromptTime = 0;

      child.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;

        // Auto-answer any interactive prompts immediately
        const lowerOutput = output.toLowerCase();
        const now = Date.now();
        if ((lowerOutput.includes('ok to proceed') || 
             lowerOutput.includes('proceed?') ||
             lowerOutput.includes('continue?') ||
             lowerOutput.includes('(y/n)') ||
             lowerOutput.includes('[y/n]') ||
             lowerOutput.includes('yes/no') ||
             lowerOutput.includes('unavailable to serve queries')) && (now - lastPromptTime > 1000)) {
          // Auto-answer with 'y' for (Y/n) prompts, 'yes' for yes/no
          console.log('✓ Auto-confirming prompt...');
          if (lowerOutput.includes('(y/n)') || lowerOutput.includes('[y/n]')) {
            child.stdin.write('y\n');
          } else {
            child.stdin.write('yes\n');
          }
          promptAnswered = true;
          lastPromptTime = now;
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

        // Auto-answer any interactive prompts in stderr as well
        const lowerOutput = output.toLowerCase();
        const now = Date.now();
        if ((lowerOutput.includes('ok to proceed') || 
             lowerOutput.includes('proceed?') ||
             lowerOutput.includes('continue?') ||
             lowerOutput.includes('(y/n)') ||
             lowerOutput.includes('[y/n]') ||
             lowerOutput.includes('yes/no') ||
             lowerOutput.includes('unavailable to serve queries')) && (now - lastPromptTime > 1000)) {
          // Auto-answer with 'y' for (Y/n) prompts, 'yes' for yes/no
          console.log('✓ Auto-confirming prompt...');
          if (lowerOutput.includes('(y/n)') || lowerOutput.includes('[y/n]')) {
            child.stdin.write('y\n');
          } else {
            child.stdin.write('yes\n');
          }
          promptAnswered = true;
          lastPromptTime = now;
        }

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
        const combinedOutput = (stdout + stderr).toLowerCase();
        const hasDuplicateColumnError = combinedOutput.includes('duplicate column');
        
        const result = {
          success: code === 0 || hasDuplicateColumnError,
          stdout: stdout,
          stderr: stderr,
          exitCode: code,
          error: (code !== 0 && !hasDuplicateColumnError) ? stderr || stdout : null
        };

        if (reportProgress) {
          reportProgress(step, result.success ? 'completed' : 'error',
            result.success ? 'Completed successfully' : `Failed with code ${code}`);
        }

        if (result.success) {
          if (hasDuplicateColumnError && code !== 0) {
            // Duplicate column errors are expected for existing databases - treat as success
            console.log('ℹ Some columns already exist (expected for existing databases)');
          }
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

  async ensureR2Bucket(codebasePath, reportProgress, bucketName) {
    if (!bucketName) {
      throw new Error('bucketName is required. It must be specified in deployments-secrets.json');
    }
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

  async ensureD1Database(codebasePath, reportProgress, databaseName) {
    if (!databaseName) {
      throw new Error('databaseName is required. It must be specified in deployments-secrets.json');
    }
    // Check cache first
    const cache = loadCache();
    const cacheKey = `d1Database_${databaseName}`;
    if (cache.checks && cache.checks[cacheKey] === true) {
      if (reportProgress) reportProgress('check-d1', 'completed', `D1 database '${databaseName}' exists`);
      return;
    }
    
    try {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      if (accountId) {
        this.updateWranglerAccountId(codebasePath, accountId);
      }
      
      const listResult = await this.executeWithLogs('wrangler d1 list', codebasePath, 'check-d1', reportProgress);
      const output = listResult.stdout || '';
      const databaseExists = output && output.includes(databaseName);

      if (!databaseExists) {
        // Use executeWithLogs to auto-answer prompts
        await this.executeWithLogs(`wrangler d1 create ${databaseName}`, codebasePath, 'check-d1', reportProgress);

        // Initialize schema
        const schemaPath = path.join(codebasePath, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
          try {
            const schemaResult = await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath} -y`, codebasePath, 'check-d1', reportProgress);
            const output = (schemaResult.stdout || '') + (schemaResult.stderr || '');
            if (output.includes('duplicate column')) {
              console.log('ℹ Some columns already exist (expected for existing databases)');
            }
          } catch (error) {
            const errorMessage = error.message || error.toString();
            // If error is due to duplicate column, it's not fatal - columns already exist
            if (errorMessage.includes('duplicate column')) {
              console.log('ℹ Some columns already exist (expected for existing databases)');
            } else {
              // If schema fails for other reasons, recreate database
              await this.executeWithLogs(`wrangler d1 delete ${databaseName} --skip-confirmation`, codebasePath, 'check-d1', reportProgress);
              await this.executeWithLogs(`wrangler d1 create ${databaseName}`, codebasePath, 'check-d1', reportProgress);
              await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath} -y`, codebasePath, 'check-d1', reportProgress);
            }
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
              cwd: codebasePath,
              env: process.env
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
                  cwd: codebasePath,
                  env: process.env
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
              // Duplicate column errors from ALTER TABLE are expected and will be ignored
              const schemaResult = await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath} -y`, codebasePath, 'check-d1', reportProgress);
              
              // Check if there were duplicate column errors (non-fatal)
              const output = (schemaResult.stdout || '') + (schemaResult.stderr || '');
              if (output.includes('duplicate column')) {
                // Duplicate column errors are expected for existing databases - columns already exist
                // This is not a fatal error, schema is still valid
                console.log('ℹ Some columns already exist (expected for existing databases)');
              }

              // If results table exists but has wrong structure, fix it
              try {
                const resultsCheck = execSync(`wrangler d1 execute ${databaseName} --remote --command="PRAGMA table_info(results);"`, {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath,
                  env: process.env
                });

                if (resultsCheck && resultsCheck.includes('preset_collection_id') && !resultsCheck.includes('selfie_id')) {
                  // Check if results table has data
                  const countCheck = execSync(`wrangler d1 execute ${databaseName} --remote --command="SELECT COUNT(*) as count FROM results;"`, {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 10000,
                    cwd: codebasePath,
                    env: process.env
                  });

                  const hasData = countCheck && countCheck.includes('"count":') && !countCheck.includes('"count":0');

                  if (!hasData) {
                    // Safe to recreate - table is empty
                    await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --command="DROP TABLE IF EXISTS results;" -y`, codebasePath, 'check-d1', reportProgress);
                    await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --command="CREATE TABLE results (id TEXT PRIMARY KEY, selfie_id TEXT NOT NULL, preset_collection_id TEXT NOT NULL, preset_image_id TEXT NOT NULL, preset_name TEXT NOT NULL, result_url TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (selfie_id) REFERENCES selfies(id), FOREIGN KEY (preset_collection_id) REFERENCES preset_collections(id), FOREIGN KEY (preset_image_id) REFERENCES preset_images(id));" -y`, codebasePath, 'check-d1', reportProgress);
                  }
                }
              } catch (fixError) {
                // Could not auto-fix results table structure - non-fatal
              }
            } catch (error) {
              const errorMessage = error.message || error.toString();
              // Duplicate column errors are expected for existing databases - columns already exist
              if (errorMessage.includes('duplicate column')) {
                console.log('ℹ Some columns already exist (expected for existing databases)');
                // This is not a fatal error, schema is still valid
                return;
              }
              
              // Try to create missing selfies table if it doesn't exist
              try {
                const selfiesCheck = execSync(`wrangler d1 execute ${databaseName} --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='selfies';"`, {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath,
                  env: process.env
                });

                if (!selfiesCheck || !selfiesCheck.includes('selfies')) {
                  await this.executeWithLogs(`wrangler d1 execute ${databaseName} --remote --command="CREATE TABLE IF NOT EXISTS selfies (id TEXT PRIMARY KEY, image_url TEXT NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));" -y`, codebasePath, 'check-d1', reportProgress);
                }
              } catch (createError) {
                // Failed to create selfies table - non-fatal, will be caught below
              }

              // Re-throw if it's a critical error
              if (!errorMessage.includes('already exists') && !errorMessage.includes('no such table')) {
                throw error;
              }
            }
          }
        }
      }
      
      // Always update wrangler.jsonc with the correct database binding
      // This ensures the binding matches even if database already existed
      console.log(`[Deploy] Updating wrangler.jsonc with D1 database binding for: ${databaseName}`);
      const d1UpdateResult = this.updateWranglerD1Database(codebasePath, databaseName);
      if (d1UpdateResult !== null) {
        wranglerD1Updated = true;
        wranglerD1UpdateContent = d1UpdateResult;
        console.log(`[Deploy] Successfully updated wrangler.jsonc with D1 database binding`);
      } else {
        console.warn(`[Deploy] Failed to update wrangler.jsonc with D1 database binding - deployment may fail`);
      }
      
      if (reportProgress) reportProgress('check-d1', 'completed', 'D1 database OK');
      // Cache the result
      cache.checks = cache.checks || {};
      cache.checks[cacheKey] = true;
      saveCache(cache);
    } catch (error) {
      // Database might already exist - non-fatal
      // Still cache as OK if it's a non-critical error
      const errorMessage = error.message || error.toString() || '';
      if (errorMessage.includes('already exists') || errorMessage.includes('no such table')) {
        const cacheAfter = loadCache();
        cacheAfter.checks = cacheAfter.checks || {};
        cacheAfter.checks[cacheKey] = true;
        saveCache(cacheAfter);
      }
      if (!errorMessage.includes('already exists')) {
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
          // Preserve account_id if it exists
          const preservedAccountId = config.account_id;
          if (config.pages_build_output_dir || config.site) {
            if (config.pages_build_output_dir) {
              delete config.pages_build_output_dir;
            }
            if (config.site) {
              delete config.site;
            }
            if (preservedAccountId) {
              config.account_id = preservedAccountId;
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

    // Verify D1 database binding exists before deployment
    const wranglerPath = path.join(codebasePath, 'wrangler.jsonc');
    if (fs.existsSync(wranglerPath)) {
      try {
        const configContent = fs.readFileSync(wranglerPath, 'utf8');
        const jsonContent = configContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const wranglerConfig = JSON.parse(jsonContent);
        
        if (wranglerConfig.d1_databases && wranglerConfig.d1_databases.length > 0) {
          for (const db of wranglerConfig.d1_databases) {
            if (!db.database_id) {
              throw new Error(`D1 database binding '${db.binding}' is missing database_id in wrangler.jsonc. This will cause deployment to fail.`);
            }
            if (!db.database_name) {
              throw new Error(`D1 database binding '${db.binding}' is missing database_name in wrangler.jsonc. This will cause deployment to fail.`);
            }
            // Verify database exists
            const dbInfo = execCommand(`wrangler d1 info ${db.database_name}`, { silent: true, throwOnError: false });
            if (!dbInfo || !dbInfo.includes(db.database_id)) {
              console.warn(`[Deploy] WARNING: Database '${db.database_name}' (${db.database_id}) may not exist or ID mismatch`);
              console.warn(`[Deploy] This may cause deployment error 10021. Verifying...`);
            } else {
              console.log(`[Deploy] Verified D1 database binding: ${db.binding} -> ${db.database_name} (${db.database_id})`);
            }
          }
        }
      } catch (error) {
        if (error.message.includes('missing database_id') || error.message.includes('missing database_name')) {
          throw error;
        }
        console.warn(`[Deploy] Could not verify D1 binding: ${error.message}`);
      }
    }

    // Temporarily remove pages_build_output_dir from wrangler.jsonc to avoid Pages project detection
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
        // Preserve account_id if it exists
        const preservedAccountId = wranglerConfig.account_id;
        if (wranglerConfig.pages_build_output_dir || wranglerConfig.site) {
          if (wranglerConfig.pages_build_output_dir) {
            delete wranglerConfig.pages_build_output_dir;
          }
          if (wranglerConfig.site) {
            delete wranglerConfig.site;
          }
          if (preservedAccountId) {
            wranglerConfig.account_id = preservedAccountId;
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

    // If not found, check in project root (where deploy folder is located)
    if (!fs.existsSync(publicPageDir)) {
      const projectRoot = path.resolve(__dirname, '..');
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

  updateWranglerAccountId(codebasePath, accountId) {
    if (!accountId) return null;
    
    const wranglerPath = path.join(codebasePath, 'wrangler.jsonc');
    if (!fs.existsSync(wranglerPath)) {
      console.warn('[Deploy] wrangler.jsonc not found, cannot set account_id');
      return null;
    }
    
    try {
      const originalContent = fs.readFileSync(wranglerPath, 'utf8');
      const jsonContent = originalContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const config = JSON.parse(jsonContent);
      
      if (config.account_id === accountId) {
        return null;
      }
      
      config.account_id = accountId;
      fs.writeFileSync(wranglerPath, JSON.stringify(config, null, '\t'), 'utf8');
      console.log(`[Deploy] Set account_id in wrangler.jsonc: ${accountId}`);
      return originalContent;
    } catch (error) {
      console.warn('[Deploy] Could not update wrangler.jsonc with account_id:', error.message);
      return null;
    }
  },

  updateWranglerD1Database(codebasePath, databaseName) {
    if (!databaseName) {
      console.warn('[Deploy] Database name not provided for wrangler.jsonc update');
      return null;
    }
    
    const wranglerPath = path.join(codebasePath, 'wrangler.jsonc');
    if (!fs.existsSync(wranglerPath)) {
      console.warn('[Deploy] wrangler.jsonc not found, cannot update D1 database binding');
      return null;
    }
    
    try {
      // Get database ID using wrangler d1 info (most reliable method)
      let databaseId = null;
      
      // Method 1: Use wrangler d1 info command (most direct)
      const infoOutput = execCommand(`wrangler d1 info ${databaseName}`, { silent: true, throwOnError: false });
      if (infoOutput) {
        // Extract database_id from info output
        const idMatch = infoOutput.match(/database_id["\s:]+([a-f0-9-]{36})/i) || 
                       infoOutput.match(/id["\s:]+([a-f0-9-]{36})/i) ||
                       infoOutput.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (idMatch) {
          databaseId = idMatch[1];
        }
      }
      
      // Method 2: Try JSON format from list
      if (!databaseId) {
        const jsonOutput = execCommand('wrangler d1 list --json', { silent: true, throwOnError: false });
        if (jsonOutput) {
          try {
            const databases = JSON.parse(jsonOutput);
            if (Array.isArray(databases)) {
              const database = databases.find(db => 
                db.name === databaseName || 
                db.database_name === databaseName ||
                (db.name && db.name.toLowerCase() === databaseName.toLowerCase())
              );
              if (database) {
                databaseId = database.uuid || database.database_id || database.id || database.database_uuid;
              }
            } else if (databases && databases.result && Array.isArray(databases.result)) {
              // Some versions return { result: [...] }
              const database = databases.result.find(db => 
                db.name === databaseName || 
                db.database_name === databaseName ||
                (db.name && db.name.toLowerCase() === databaseName.toLowerCase())
              );
              if (database) {
                databaseId = database.uuid || database.database_id || database.id || database.database_uuid;
              }
            }
          } catch (e) {
            // JSON parse failed, try text format
          }
        }
      }
      
      // Method 3: Try text format from list
      if (!databaseId) {
        const textOutput = execCommand('wrangler d1 list', { silent: true, throwOnError: false });
        if (textOutput) {
          // Look for database name and extract ID from nearby lines
          const lines = textOutput.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(databaseName)) {
              // Look for UUID pattern in current or next few lines
              for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 3); j++) {
                const idMatch = lines[j].match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
                if (idMatch) {
                  databaseId = idMatch[1];
                  break;
                }
              }
              if (databaseId) break;
            }
          }
        }
      }
      
      if (!databaseId) {
        console.error(`[Deploy] ERROR: Could not find database_id for '${databaseName}'`);
        console.error('[Deploy] Attempted methods: wrangler d1 info, wrangler d1 list --json, wrangler d1 list');
        console.error('[Deploy] This will cause deployment error 10021. The database must exist and be accessible.');
        console.error('[Deploy] Please verify:');
        console.error(`[Deploy]   1. Database '${databaseName}' exists in Cloudflare dashboard`);
        console.error(`[Deploy]   2. You have access to the correct Cloudflare account`);
        console.error(`[Deploy]   3. Run: wrangler d1 list (to see all databases)`);
        throw new Error(`Database '${databaseName}' not found. Cannot update wrangler.jsonc binding.`);
      }
      
      console.log(`[Deploy] ✓ Found database_id for '${databaseName}': ${databaseId}`);
      
      const originalContent = fs.readFileSync(wranglerPath, 'utf8');
      const jsonContent = originalContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const config = JSON.parse(jsonContent);
      
      // Update or create d1_databases array
      if (!config.d1_databases) {
        config.d1_databases = [];
      }
      
      // Find existing DB binding or create new one
      let dbBinding = config.d1_databases.find(db => db.binding === 'DB');
      if (!dbBinding) {
        dbBinding = { binding: 'DB' };
        config.d1_databases.push(dbBinding);
      }
      
      // Always update database name and ID to ensure they match
      const oldName = dbBinding.database_name;
      const oldId = dbBinding.database_id;
      dbBinding.database_name = databaseName;
      dbBinding.database_id = databaseId;
      
      // Write the updated config
      fs.writeFileSync(wranglerPath, JSON.stringify(config, null, '\t'), 'utf8');
      
      if (oldName !== databaseName || oldId !== databaseId) {
        console.log(`[Deploy] Updated D1 database binding in wrangler.jsonc:`);
        console.log(`[Deploy]   Old: ${oldName || 'N/A'} (${oldId || 'N/A'})`);
        console.log(`[Deploy]   New: ${databaseName} (${databaseId})`);
        return originalContent;
      } else {
        console.log(`[Deploy] D1 database binding already correct: ${databaseName} (${databaseId})`);
        return null;
      }
    } catch (error) {
      console.warn('[Deploy] Could not update wrangler.jsonc with D1 database:', error.message);
      return null;
    }
  },

  async performDeployment(config = {}, reportProgress) {
    // STRICT VALIDATION - NO DEFAULTS ALLOWED
    // All values MUST come from deployments-secrets.json to prevent configuration mismatches
    
    if (!config.workerName) {
      throw new Error('ERROR: workerName is required in deployments-secrets.json. Cannot proceed without it.');
    }
    if (!config.pagesProjectName) {
      throw new Error('ERROR: pagesProjectName is required in deployments-secrets.json. Cannot proceed without it.');
    }
    if (!config.databaseName) {
      throw new Error('ERROR: databaseName is required in deployments-secrets.json. Cannot proceed without it.');
    }
    if (!config.bucketName) {
      throw new Error('ERROR: bucketName is required in deployments-secrets.json. Cannot proceed without it.');
    }
    
    const codebasePath = config.codebasePath || process.cwd();
    const workerName = config.workerName;
    const pagesProjectName = config.pagesProjectName;
    const databaseName = config.databaseName;
    const bucketName = config.bucketName;
    const secrets = config.secrets;
    
    const savedCredentials = loadCredentials();
    const savedAccountId = savedCredentials?.cloudflare?.accountId;
    const accountId = config.cloudflare?.accountId || savedAccountId;

    let workerUrl = '';
    let pagesUrl = '';
    let originalWranglerContent = null;
    let wranglerD1Updated = false;

    try {
      // Step 0: Set account_id in wrangler.jsonc and environment variable if provided
      if (accountId) {
        originalWranglerContent = this.updateWranglerAccountId(codebasePath, accountId);
        process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
        console.log(`[Deploy] Set CLOUDFLARE_ACCOUNT_ID environment variable: ${accountId}`);
      }

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
      const cache = loadCache();
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
      
      // Verify wrangler.jsonc has correct D1 binding before deployment
      const wranglerPath = path.join(codebasePath, 'wrangler.jsonc');
      if (fs.existsSync(wranglerPath)) {
        try {
          const configContent = fs.readFileSync(wranglerPath, 'utf8');
          const jsonContent = configContent.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
          const config = JSON.parse(jsonContent);
          if (config.d1_databases && config.d1_databases.length > 0) {
            const dbBinding = config.d1_databases.find(db => db.binding === 'DB');
            if (dbBinding) {
              if (dbBinding.database_name !== databaseName) {
                console.warn(`[Deploy] WARNING: wrangler.jsonc database_name (${dbBinding.database_name}) doesn't match expected (${databaseName})`);
              }
              if (!dbBinding.database_id) {
                console.warn(`[Deploy] WARNING: wrangler.jsonc missing database_id for D1 binding`);
              } else {
                console.log(`[Deploy] Verified D1 binding in wrangler.jsonc: ${dbBinding.database_name} (${dbBinding.database_id})`);
              }
            }
          }
        } catch (e) {
          console.warn(`[Deploy] Could not verify wrangler.jsonc D1 binding: ${e.message}`);
        }
      }

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
    } finally {
      // Only restore wrangler.jsonc if D1 database wasn't updated
      // D1 database binding updates should persist
      if (originalWranglerContent && !wranglerD1Updated) {
        try {
          const wranglerPath = path.join(codebasePath, 'wrangler.jsonc');
          fs.writeFileSync(wranglerPath, originalWranglerContent, 'utf8');
          console.log('[Deploy] Restored original wrangler.jsonc');
        } catch (restoreError) {
          console.warn('[Deploy] Could not restore wrangler.jsonc:', restoreError.message);
        }
      } else if (wranglerD1Updated) {
        console.log('[Deploy] Keeping D1 database binding update in wrangler.jsonc');
      }
    }
  }
};

// Export functions for use by Electron
module.exports = {
  ...deploymentUtils,
  deployFromConfig,
  loadDeploymentConfig,
  parseConfigObject
};

// CLI main function
// CLI main function - runs when file is executed directly
async function main() {
  const cliArgs = parseCliArgs();

  if (cliArgs.command === 'setup') {
    await runSetup();
    return;
  }

  const envName = cliArgs.envName;

  console.log(`📄 Loading configuration for environment: ${envName}...`);
  const deploymentConfig = loadDeploymentConfig(envName);

  console.log('\n🚀 Face Swap AI - Deployment Script');
  console.log('====================================\n');

  console.log('📋 Configuration:');
  console.log(`   Environment: ${envName}`);
  console.log(`   Worker Name: ${deploymentConfig.workerName}`);
  console.log(`   Pages Name: ${deploymentConfig.pagesProjectName}`);
  console.log(`   Database: ${deploymentConfig.databaseName}`);
  console.log(`   Bucket: ${deploymentConfig.bucketName}`);
  if (deploymentConfig.cloudflare?.accountId) {
    console.log(`   Cloudflare Account ID: ${deploymentConfig.cloudflare.accountId}`);
  }
  if (deploymentConfig.gcp?.projectId) {
    console.log(`   GCP Project ID: ${deploymentConfig.gcp.projectId}`);
  }
  console.log('');

  let workerUrl = '';
  let pagesUrl = '';

  if (!deploymentUtils.checkWrangler()) {
    log.error('Wrangler CLI not found. Installing...');
    try {
      execCommand('npm install -g wrangler', { stdio: 'inherit' });
    } catch {
      log.error('Failed to install wrangler. Please install manually: npm install -g wrangler');
      process.exit(1);
    }
  }

  if (!deploymentUtils.checkGcloud()) {
    log.error('gcloud CLI not found. Please install Google Cloud SDK first.');
    log.info('Download from: https://cloud.google.com/sdk/docs/install');
    process.exit(1);
  }

  log.info('Setting up Cloudflare authentication...');
  try {
    await deploymentUtils.setupCloudflareAuth(deploymentConfig.cloudflare);
    log.success('Cloudflare authentication configured');
  } catch (error) {
    log.error(`Cloudflare authentication failed: ${error.message}`);
    process.exit(1);
  }

  log.info('Setting up GCP authentication...');
  try {
    await deploymentUtils.setupGcpAuth(deploymentConfig.gcp);
    log.success('GCP authentication configured');
  } catch (error) {
    log.error(`GCP authentication failed: ${error.message}`);
    process.exit(1);
  }

  if (!deploymentUtils.checkAuth()) {
    log.error('Cloudflare authentication verification failed');
    process.exit(1);
  } else {
    log.success('Cloudflare authentication verified');
  }

  const result = await deploymentUtils.performDeployment(deploymentConfig, null);

  if (!result.success) {
    log.error(`Deployment failed: ${result.error}`);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(50));
  log.success('Deployment Complete!');
  console.log('\n📌 URLs:');
  if (result.workerUrl) {
    console.log(`   ✅ Worker (Backend): ${result.workerUrl}`);
  }
  if (result.pagesUrl) {
    console.log(`   ✅ Pages (Frontend): ${result.pagesUrl}`);
  } else {
    console.log(`   ✅ Pages (Frontend): https://${deploymentConfig.pagesProjectName}.pages.dev/`);
  }
  console.log('\n');
}

// Run CLI if this file is executed directly
if (require.main === module) {
main().catch((error) => {
  log.error(`Deployment failed: ${error.message}`);
  process.exit(1);
});
}
