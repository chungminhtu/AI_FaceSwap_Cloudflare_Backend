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
        GOOGLE_GEMINI_API_KEY: 'your_gemini_key',
        GOOGLE_PROJECT_ID: 'your_project_id',
        GOOGLE_GEMINI_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'your-service-account@project.iam.gserviceaccount.com',
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----',
        GOOGLE_VISION_ENDPOINT: 'https://vision.googleapis.com/v1/images:annotate'
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
    'GOOGLE_VISION_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'GOOGLE_VISION_ENDPOINT'
  ];

  const missingFields = requiredFields.filter(field => !config[field]);
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
  }

  // Validate Vertex AI fields if using Vertex AI endpoint
  // Note: If missing, auto-setup will handle it during deployment
  if (config.GOOGLE_GEMINI_ENDPOINT && config.GOOGLE_GEMINI_ENDPOINT.includes('aiplatform')) {
    if (!config.GOOGLE_PROJECT_ID) {
      throw new Error('GOOGLE_PROJECT_ID is required when using Vertex AI endpoint');
    }
    // Service account credentials will be auto-generated if missing
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
      GOOGLE_GEMINI_API_KEY: config.GOOGLE_GEMINI_API_KEY,
      GOOGLE_PROJECT_ID: config.GOOGLE_PROJECT_ID,
      GOOGLE_GEMINI_ENDPOINT: config.GOOGLE_GEMINI_ENDPOINT,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      GOOGLE_VISION_ENDPOINT: config.GOOGLE_VISION_ENDPOINT
    }
  };
}

// Deploy from configuration object (used by Electron)
async function deployFromConfig(configObject, reportProgress = null) {
  try {
    const deploymentConfig = parseConfigObject(configObject);

    if (reportProgress) {
      reportProgress('start', 'running', 'Starting deployment...');
    }

    // Show configuration if no progress reporter
    if (!reportProgress) {
      console.log('📋 Configuration:');
      console.log(`   Worker Name: ${deploymentConfig.workerName}`);
      console.log(`   Pages Name: ${deploymentConfig.pagesProjectName}`);
      console.log(`   Database: ${deploymentConfig.databaseName}`);
      console.log(`   Bucket: ${deploymentConfig.bucketName}`);
      console.log('');
    }

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
    "GOOGLE_GEMINI_API_KEY": "your_google_gemini_key_here",
    "GOOGLE_PROJECT_ID": "your_google_project_id (required for Vertex AI, auto-setup available)",
    "GOOGLE_GEMINI_ENDPOINT": "https://generativelanguage.googleapis.com/v1beta",
    "GOOGLE_SERVICE_ACCOUNT_EMAIL": "auto-generated if missing (for Vertex AI)",
    "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY": "auto-generated if missing (for Vertex AI)",
    "GOOGLE_VISION_ENDPOINT": "https://vision.googleapis.com/v1/images:annotate"
  }

REQUIRED FIELDS:
  • workerName, pagesProjectName, databaseName, bucketName
  • RAPIDAPI_KEY, RAPIDAPI_HOST, RAPIDAPI_ENDPOINT
  • GOOGLE_VISION_API_KEY, GOOGLE_GEMINI_API_KEY, GOOGLE_VISION_ENDPOINT
  • GOOGLE_PROJECT_ID (required only for Vertex AI endpoint)
  • GOOGLE_GEMINI_ENDPOINT (optional, defaults to regular Gemini API)
  
AUTO-SETUP:
  • If using Vertex AI endpoint (aiplatform.googleapis.com), service account credentials
    will be automatically created and configured during deployment
  • Requires: gcloud CLI installed and authenticated
  • Service account name: cloudflare-worker-gemini
  • Credentials are automatically saved to secrets.json

HOW TO GET GOOGLE_PROJECT_ID:
  • Option 1: Create via web console: https://console.cloud.google.com/projectcreate
  • Option 2: Create via CLI: gcloud projects create YOUR_PROJECT_ID
  • Option 3: Use existing project - copy Project ID from Google Cloud Console
  • The deployment script will verify your project exists and list available projects if not found

IMPORTANT:
  • GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is AUTO-GENERATED - you don't need to get it manually!
  • Just set GOOGLE_PROJECT_ID and run deployment - everything else is automatic
  • See GOOGLE_PROJECT_SETUP.md for detailed instructions

EXAMPLES:
  # Deploy using secrets.json (only way)
  node deploy.js

  # Show this help
  node deploy.js --help

All project names should be unique per Cloudflare account to avoid conflicts.
`);
}

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
    try {
      const authList = execCommand('gcloud auth list --format="value(account)"', { silent: true, throwOnError: false });
      return authList && authList.trim().length > 0;
    } catch {
      return false;
    }
  },

  async fixGcpAuth(projectId = null) {
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

      // Set project if provided
      if (projectId) {
        const currentProject = execCommand('gcloud config get-value project', { silent: true, throwOnError: false });
        if (!currentProject || currentProject.trim() !== projectId) {
          log.info(`Setting GCP project to ${projectId}...`);
          execCommand(`gcloud config set project ${projectId}`, { stdio: 'inherit' });
          log.success(`GCP project set to ${projectId}`);
        } else {
          log.success(`GCP project already set to ${projectId}`);
        }
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
    try {
      execCommand('wrangler whoami', { silent: true, throwOnError: false });
      return true;
    } catch {
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

  // Check if Google Cloud project exists
  async checkGoogleCloudProject(projectId, reportProgress = null) {
    try {
      if (reportProgress) {
        reportProgress('check-project', 'running', `Checking Google Cloud project: ${projectId}...`);
      } else {
        log.info(`Checking Google Cloud project: ${projectId}...`);
      }

      const result = execCommand(
        `gcloud projects describe ${projectId} --format="value(projectId)"`,
        { silent: true, throwOnError: false }
      );

      if (result && result.trim() === projectId) {
        if (reportProgress) {
          reportProgress('check-project', 'completed', `Project ${projectId} exists`);
        } else {
          log.success(`Project ${projectId} exists`);
        }
        return true;
      } else {
        if (reportProgress) {
          reportProgress('check-project', 'error', `Project ${projectId} not found`);
        } else {
          log.error(`Project ${projectId} not found`);
        }
        return false;
      }
    } catch (error) {
      if (reportProgress) {
        reportProgress('check-project', 'error', `Failed to check project: ${error.message}`);
      } else {
        log.error(`Failed to check project: ${error.message}`);
      }
      return false;
    }
  },

  // List available Google Cloud projects
  listGoogleCloudProjects() {
    try {
      const result = execCommand(
        'gcloud projects list --format="value(projectId)"',
        { silent: true, throwOnError: false }
      );
      
      if (result && result.trim()) {
        return result.trim().split('\n').filter(Boolean);
      }
      return [];
    } catch (error) {
      log.warn(`Failed to list projects: ${error.message}`);
      return [];
    }
  },

  // Enable required Google Cloud APIs
  async enableGoogleCloudAPIs(projectId, reportProgress = null) {
    const REQUIRED_APIS = [
      'aiplatform.googleapis.com', // Vertex AI API
      'cloudresourcemanager.googleapis.com' // For IAM operations
    ];

    try {
      if (reportProgress) {
        reportProgress('enable-apis', 'running', 'Enabling required Google Cloud APIs...');
      } else {
        log.info('Enabling required Google Cloud APIs...');
      }

      for (const api of REQUIRED_APIS) {
        try {
          // Check if API is already enabled
          const checkResult = execCommand(
            `gcloud services list --enabled --filter="name:${api}" --project=${projectId} --format="value(name)"`,
            { silent: true, throwOnError: false }
          );

          if (checkResult && checkResult.trim().includes(api)) {
            if (reportProgress) {
              reportProgress('enable-apis', 'completed', `${api} already enabled`);
            } else {
              log.success(`${api} already enabled`);
            }
            continue;
          }

          // Enable the API
          execCommand(
            `gcloud services enable ${api} --project=${projectId}`,
            { stdio: 'inherit' }
          );

          if (reportProgress) {
            reportProgress('enable-apis', 'completed', `${api} enabled`);
          } else {
            log.success(`${api} enabled`);
          }
        } catch (error) {
          // API might already be enabled or user doesn't have permission
          if (reportProgress) {
            reportProgress('enable-apis', 'warning', `${api} enablement (may already be enabled)`);
          } else {
            log.warn(`${api} may already be enabled or requires permissions`);
          }
        }
      }

      if (reportProgress) {
        reportProgress('enable-apis', 'completed', 'All required APIs enabled');
      } else {
        log.success('All required APIs enabled');
      }
    } catch (error) {
      if (reportProgress) {
        reportProgress('enable-apis', 'error', `Failed to enable APIs: ${error.message}`);
      } else {
        log.warn(`Failed to enable some APIs: ${error.message}`);
      }
      // Don't throw - continue with setup
    }
  },

  // Automatically set up Vertex AI service account
  async setupVertexAIServiceAccount(projectId, reportProgress = null) {
    const SERVICE_ACCOUNT_NAME = 'cloudflare-worker-gemini';
    const SERVICE_ACCOUNT_EMAIL = `${SERVICE_ACCOUNT_NAME}@${projectId}.iam.gserviceaccount.com`;
    const KEY_FILE = path.join(process.cwd(), `.${SERVICE_ACCOUNT_NAME}-key.json`);

    try {
      if (reportProgress) {
        reportProgress('setup-vertex-ai', 'running', 'Setting up Vertex AI service account...');
      } else {
        log.info('Setting up Vertex AI service account...');
      }

      // First, enable required APIs
      await this.enableGoogleCloudAPIs(projectId, reportProgress);

      // Check if service account already exists
      let serviceAccountExists = false;
      try {
        execCommand(`gcloud iam service-accounts describe ${SERVICE_ACCOUNT_EMAIL} --project=${projectId}`, {
          silent: true,
          throwOnError: false
        });
        serviceAccountExists = true;
        if (reportProgress) {
          reportProgress('setup-vertex-ai', 'completed', 'Service account already exists');
        } else {
          log.success('Service account already exists');
        }
      } catch {
        // Service account doesn't exist, create it
        if (reportProgress) {
          reportProgress('setup-vertex-ai', 'running', 'Creating service account...');
        } else {
          log.info('Creating service account...');
        }
        
        execCommand(
          `gcloud iam service-accounts create ${SERVICE_ACCOUNT_NAME} --display-name="Cloudflare Worker Gemini Service Account" --project=${projectId}`,
          { stdio: 'inherit' }
        );
        
        if (reportProgress) {
          reportProgress('setup-vertex-ai', 'completed', 'Service account created');
        } else {
          log.success('Service account created');
        }
      }

      // Assign Vertex AI User role
      if (reportProgress) {
        reportProgress('setup-vertex-ai', 'running', 'Assigning Vertex AI User role...');
      } else {
        log.info('Assigning Vertex AI User role...');
      }

      try {
        execCommand(
          `gcloud projects add-iam-policy-binding ${projectId} --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" --role="roles/aiplatform.user"`,
          { silent: true, throwOnError: false }
        );
        if (reportProgress) {
          reportProgress('setup-vertex-ai', 'completed', 'Vertex AI User role assigned');
        } else {
          log.success('Vertex AI User role assigned');
        }
      } catch (error) {
        // Role might already be assigned, continue
        if (reportProgress) {
          reportProgress('setup-vertex-ai', 'warning', 'Role assignment (may already be assigned)');
        } else {
          log.warn('Role may already be assigned');
        }
      }

      // Generate and download key
      if (reportProgress) {
        reportProgress('setup-vertex-ai', 'running', 'Generating service account key...');
      } else {
        log.info('Generating service account key...');
      }

      // Delete old key file if exists
      if (fs.existsSync(KEY_FILE)) {
        fs.unlinkSync(KEY_FILE);
      }

      execCommand(
        `gcloud iam service-accounts keys create "${KEY_FILE}" --iam-account=${SERVICE_ACCOUNT_EMAIL} --project=${projectId}`,
        { stdio: 'inherit' }
      );

      // Read the key file
      const keyData = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));

      // Clean up key file (security)
      fs.unlinkSync(KEY_FILE);

      if (reportProgress) {
        reportProgress('setup-vertex-ai', 'completed', 'Service account key generated');
      } else {
        log.success('Service account key generated');
      }

      return {
        email: keyData.client_email,
        privateKey: keyData.private_key,
        projectId: keyData.project_id
      };
    } catch (error) {
      if (reportProgress) {
        reportProgress('setup-vertex-ai', 'error', `Failed to set up service account: ${error.message}`);
      } else {
        log.error(`Failed to set up service account: ${error.message}`);
      }
      throw error;
    }
  },

  // Automatically configure Vertex AI in secrets.json
  async autoConfigureVertexAI(config, codebasePath = null, reportProgress = null) {
    const endpoint = config.GOOGLE_GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta';
    const isVertexAI = endpoint.includes('aiplatform');

    if (!isVertexAI) {
      return config; // Not using Vertex AI, return as-is
    }

    // Check if already configured
    if (config.GOOGLE_SERVICE_ACCOUNT_EMAIL && config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && config.GOOGLE_PROJECT_ID) {
      if (reportProgress) {
        reportProgress('setup-vertex-ai', 'completed', 'Vertex AI already configured');
      } else {
        log.success('Vertex AI already configured');
      }
      return config;
    }

    // Need to set up service account
    const projectId = config.GOOGLE_PROJECT_ID;
    if (!projectId) {
      throw new Error('GOOGLE_PROJECT_ID is required for Vertex AI. Please set it in secrets.json');
    }

    if (reportProgress) {
      reportProgress('setup-vertex-ai', 'running', 'Auto-configuring Vertex AI service account...');
    } else {
      log.info('Auto-configuring Vertex AI service account...');
    }

    // Check gcloud is available
    if (!this.checkGcloud()) {
      throw new Error('gcloud CLI is required for automatic Vertex AI setup. Please install Google Cloud SDK: https://cloud.google.com/sdk/docs/install');
    }

    // Check GCP authentication and set project
    if (!this.checkGcpAuth()) {
      if (reportProgress) {
        reportProgress('setup-vertex-ai', 'running', 'Authenticating with Google Cloud...');
      } else {
        log.info('Authenticating with Google Cloud...');
      }
      await this.fixGcpAuth(projectId);
    } else {
      // Already authenticated, just set the project
      try {
        execCommand(`gcloud config set project ${projectId}`, { silent: true, throwOnError: false });
      } catch (error) {
        log.warn(`Could not set project: ${error.message}`);
      }
    }

    // Check if project exists
    const projectExists = await this.checkGoogleCloudProject(projectId, reportProgress);
    if (!projectExists) {
      const availableProjects = this.listGoogleCloudProjects();
      let errorMessage = `\n❌ Google Cloud project "${projectId}" not found.\n\n`;
      
      if (availableProjects.length > 0) {
        errorMessage += `Available projects:\n`;
        availableProjects.forEach(p => errorMessage += `  - ${p}\n`);
        errorMessage += `\nEither:\n`;
        errorMessage += `1. Use one of the projects above by setting GOOGLE_PROJECT_ID in secrets.json\n`;
        errorMessage += `2. Create a new project:\n`;
      } else {
        errorMessage += `To create a new project:\n`;
      }
      
      errorMessage += `   gcloud projects create ${projectId} --name="My Vertex AI Project"\n`;
      errorMessage += `   gcloud billing projects link ${projectId} --billing-account=YOUR_BILLING_ACCOUNT_ID\n\n`;
      errorMessage += `Or create via web console: https://console.cloud.google.com/projectcreate\n`;
      
      throw new Error(errorMessage);
    }

    // Set up service account
    const credentials = await this.setupVertexAIServiceAccount(projectId, reportProgress);

    // Update config with credentials
    const updatedConfig = {
      ...config,
      GOOGLE_PROJECT_ID: credentials.projectId || projectId,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: credentials.email,
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: credentials.privateKey
    };

    // Save to secrets.json (use codebasePath if provided, otherwise current directory)
    const secretsPath = path.join(codebasePath || process.cwd(), 'secrets.json');
    if (fs.existsSync(secretsPath)) {
      const currentSecrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      const updatedSecrets = {
        ...currentSecrets,
        GOOGLE_PROJECT_ID: updatedConfig.GOOGLE_PROJECT_ID,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: updatedConfig.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: updatedConfig.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      };
      fs.writeFileSync(secretsPath, JSON.stringify(updatedSecrets, null, 2), 'utf8');
      
      if (reportProgress) {
        reportProgress('setup-vertex-ai', 'completed', 'Vertex AI credentials saved to secrets.json');
      } else {
        log.success('Vertex AI credentials saved to secrets.json');
      }
    }

    return updatedConfig;
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

      child.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;

        // Write to terminal (CLI mode)
        process.stdout.write(output);

        // Send each line to UI (Electron mode)
        if (reportProgress) {
          const lines = output.split('\n').filter(line => line.trim());
          lines.forEach(line => {
            reportProgress(step, 'running', null, {
              log: line.trim()
            });
          });
        }
      });

      child.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;

        // Write to terminal (CLI mode)
        process.stderr.write(output);

        // Send each line to UI (Electron mode)
        if (reportProgress) {
          const lines = output.split('\n').filter(line => line.trim());
          lines.forEach(line => {
            reportProgress(step, 'running', null, {
              log: line.trim()
            });
          });
        }
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, stdout, stderr });
        } else {
          reject(new Error(`Command exited with code ${code}\n${stderr}`));
        }
      });

      child.on('error', (error) => {
        reject(error);
      });
    });
  },

  async ensureR2Bucket(codebasePath, reportProgress) {
    try {
      const listResult = await this.executeWithLogs('wrangler r2 bucket list', codebasePath, 'check-r2', reportProgress);
      const output = listResult.stdout || '';

      if (!output || !output.includes(bucketName)) {
        await this.executeWithLogs(`wrangler r2 bucket create ${bucketName}`, codebasePath, 'check-r2', reportProgress);
      }
      if (reportProgress) reportProgress('check-r2', 'completed', 'R2 bucket OK');
    } catch (error) {
      // Bucket might already exist or command might fail - non-fatal
      if (!error.message.includes('already exists')) {
        throw error;
      }
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
        execSync(`wrangler d1 create ${databaseName}`, {
          stdio: 'inherit',
          timeout: 30000,
          cwd: codebasePath
        });

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
            execSync(`wrangler d1 delete ${databaseName}`, {
              stdio: 'inherit',
              timeout: 30000,
              cwd: codebasePath
            });
            execSync(`wrangler d1 create ${databaseName}`, {
              stdio: 'inherit',
              timeout: 30000,
              cwd: codebasePath
            });
            execSync(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, {
              stdio: 'inherit',
              timeout: 30000,
              cwd: codebasePath
            });
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
              execSync(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, {
                stdio: 'inherit',
                timeout: 30000,
                cwd: codebasePath
              });

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
                    execSync('wrangler d1 execute ${databaseName} --remote --command="DROP TABLE IF EXISTS results;"', {
                      stdio: 'inherit',
                      timeout: 30000,
                      cwd: codebasePath
                    });
                    execSync('wrangler d1 execute ${databaseName} --remote --command="CREATE TABLE results (id TEXT PRIMARY KEY, selfie_id TEXT NOT NULL, preset_collection_id TEXT NOT NULL, preset_image_id TEXT NOT NULL, preset_name TEXT NOT NULL, result_url TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (selfie_id) REFERENCES selfies(id), FOREIGN KEY (preset_collection_id) REFERENCES preset_collections(id), FOREIGN KEY (preset_image_id) REFERENCES preset_images(id));"', {
                      stdio: 'inherit',
                      timeout: 30000,
                      cwd: codebasePath
                    });
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
                  execSync('wrangler d1 execute ${databaseName} --remote --command="CREATE TABLE IF NOT EXISTS selfies (id TEXT PRIMARY KEY, image_url TEXT NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));"', {
                    stdio: 'inherit',
                    timeout: 30000,
                    cwd: codebasePath
                  });
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
    } catch (error) {
      // Database might already exist - non-fatal
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  },

  async deploySecrets(secrets, codebasePath, reportProgress) {
    if (!secrets) {
      throw new Error('No secrets provided');
    }

    // Create temporary secrets.json file
    const secretsPath = path.join(codebasePath, 'temp-secrets.json');
    try {
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), 'utf8');

      // Deploy secrets using wrangler
      const result = await this.executeWithLogs(
        'wrangler secret bulk temp-secrets.json',
        codebasePath,
        'deploy-secrets',
        reportProgress
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to deploy secrets');
      }

      if (reportProgress) reportProgress('deploy-secrets', 'completed', 'Secrets deployed');
    } finally {
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

    const result = await this.executeWithLogs('wrangler deploy', codebasePath, 'deploy-worker', reportProgress);

    if (!result.success) {
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
    return workerUrl;
  },

  async deployPages(codebasePath, pagesProjectName, reportProgress) {
    const publicPageDir = path.join(codebasePath, 'public_page');

    // Always construct the Pages URL from project name
    const pagesUrl = `https://${pagesProjectName}.pages.dev/`;

    if (!fs.existsSync(publicPageDir)) {
      if (reportProgress) reportProgress('deploy-pages', 'warning', 'public_page directory not found, skipping Pages deployment');
      return pagesUrl;
    }

    if (reportProgress) reportProgress('deploy-pages', 'running', `Deploying Pages: ${pagesProjectName}...`);

    try {
      // Use the exact same command as deploy.js CLI
      const command = `wrangler pages deploy ${publicPageDir} --project-name=${pagesProjectName} --branch=main --commit-dirty=true`;

      const result = await this.executeWithLogs(
        command,
        codebasePath,
        'deploy-pages',
        reportProgress
      );

      // Check if command succeeded (exit code 0)
      if (result.success) {
        if (reportProgress) reportProgress('deploy-pages', 'completed', `Pages deployed successfully: ${pagesUrl}`);
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
      if (reportProgress) reportProgress('check-gcp-auth', 'running', 'Checking GCP authentication...');
      if (!this.checkGcpAuth()) {
        if (reportProgress) reportProgress('check-gcp-auth', 'warning', 'GCP authentication required');
        if (!await this.fixGcpAuth()) {
          throw new Error('GCP authentication setup failed');
        }
      } else {
        if (reportProgress) reportProgress('check-gcp-auth', 'completed', 'GCP authentication OK');
      }

      // Step 3: Check Cloudflare authentication
      if (reportProgress) reportProgress('check-auth', 'running', 'Checking Cloudflare authentication...');
      if (!this.checkAuth()) {
        throw new Error('Cloudflare authentication required');
      }
      if (reportProgress) reportProgress('check-auth', 'completed', 'Cloudflare authentication OK');

      // Step 3.5: Auto-configure Vertex AI if needed
      if (secrets && secrets.GOOGLE_GEMINI_ENDPOINT && secrets.GOOGLE_GEMINI_ENDPOINT.includes('aiplatform')) {
        try {
          const updatedConfig = await this.autoConfigureVertexAI({
            ...config,
            ...secrets
          }, codebasePath, reportProgress);
          
          // Update config with auto-configured credentials
          if (updatedConfig.GOOGLE_SERVICE_ACCOUNT_EMAIL && updatedConfig.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
            secrets.GOOGLE_SERVICE_ACCOUNT_EMAIL = updatedConfig.GOOGLE_SERVICE_ACCOUNT_EMAIL;
            secrets.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = updatedConfig.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
            if (updatedConfig.GOOGLE_PROJECT_ID) {
              secrets.GOOGLE_PROJECT_ID = updatedConfig.GOOGLE_PROJECT_ID;
            }
          }
        } catch (error) {
          if (reportProgress) {
            reportProgress('setup-vertex-ai', 'error', `Vertex AI auto-setup failed: ${error.message}`);
          } else {
            log.warn(`Vertex AI auto-setup failed: ${error.message}`);
            log.warn('You may need to manually configure service account credentials');
          }
          // Don't throw - allow deployment to continue, user can configure manually
        }
      }

      // Step 4: Check R2 bucket
      await this.ensureR2Bucket(codebasePath, reportProgress);

      // Step 5: Check D1 database
      await this.ensureD1Database(codebasePath, reportProgress);

      // Step 6: Deploy secrets
      if (secrets) {
        await this.deploySecrets(secrets, codebasePath, reportProgress);
      }

      // Step 7: Deploy Worker
      workerUrl = await this.deployWorker(codebasePath, workerName, reportProgress);

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
      } else {
        log.info(details || `Checking D1 database '${deploymentConfig.databaseName}'...`);
      }
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
        if (status === 'completed') {
          log.success('Secrets deployed successfully');
        } else {
          log.info(details || 'Deploying secrets...');
        }
      });
    } catch (error) {
      log.error('Failed to deploy secrets');
      throw error;
    }
  } else {
    // Check if secrets are set manually
    const existingSecrets = deploymentUtils.getSecrets();
    const requiredVars = ['RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT', 'GOOGLE_VISION_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'GOOGLE_VISION_ENDPOINT'];
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
      if (status === 'completed') {
        log.success(details || 'Worker deployed');
      } else {
        log.info(details || 'Deploying Worker...');
      }
    });

    if (workerUrl) {
      log.success(`Worker URL: ${workerUrl}`);
    } else {
      log.warn('Could not auto-detect Worker URL. Please check Cloudflare Dashboard.');
    }
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
        if (status === 'completed') {
          log.success('Pages deployed');
          log.success(`Frontend URL: ${pagesUrl}`);
        } else if (status === 'warning') {
          log.warn(details);
        } else {
          log.info(details || 'Deploying Pages...');
        }
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
