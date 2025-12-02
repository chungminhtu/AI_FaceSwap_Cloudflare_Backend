# Wrangler CLI and GCP Automated Deployment Guide

## Overview

This document extracts the technical implementation details from `deploy/deploy.js` for automated resource creation and deployment using Wrangler CLI and Google Cloud Platform (GCP). It provides a comprehensive reference for implementing similar automated deployment workflows.

## Prerequisites

### CLI Tools Required
- **Wrangler CLI**: `npm install -g wrangler`
- **Google Cloud SDK**: Install from https://cloud.google.com/sdk/docs/install

### Environment Variables
- `DEPLOY_ENV`: Environment selector (defaults to 'production')
- `CLOUDFLARE_API_TOKEN`: API token for Cloudflare authentication
- `CLOUDFLARE_ACCOUNT_ID`: Account ID for Cloudflare operations

## Configuration Structure

### deployments-secrets.json Format
```json
{
  "environments": {
    "production": {
      "name": "production",
      "workerName": "ai-faceswap-backend",
      "pagesProjectName": "ai-faceswap-frontend",
      "databaseName": "faceswap-db",
      "bucketName": "faceswap-images",
      "deployPages": true,
      "cloudflare": {
        "accountId": "your_cloudflare_account_id",
        "apiToken": "your_cloudflare_api_token"
      },
      "gcp": {
        "projectId": "your-gcp-project-id",
        "serviceAccountKeyJson": {
          "type": "service_account",
          "project_id": "your-gcp-project-id",
          "private_key_id": "auto-generated",
          "private_key": "-----BEGIN PRIVATE KEY-----\nPASTE_YOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n",
          "client_email": "your-service-account@project.iam.gserviceaccount.com",
          "client_id": "auto-generated",
          "auth_uri": "https://accounts.google.com/o/oauth2/auth",
          "token_uri": "https://oauth2.googleapis.com/token",
          "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
          "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/your-service-account%40project.iam.gserviceaccount.com"
        }
      },
      "secrets": {
        "RAPIDAPI_KEY": "your_rapidapi_key_here",
        "RAPIDAPI_HOST": "ai-face-swap2.p.rapidapi.com",
        "RAPIDAPI_ENDPOINT": "https://ai-face-swap2.p.rapidapi.com/public/process/urls",
        "GOOGLE_VISION_API_KEY": "your_google_vision_api_key",
        "GOOGLE_VERTEX_PROJECT_ID": "your-gcp-project-id",
        "GOOGLE_VERTEX_LOCATION": "us-central1",
        "GOOGLE_VISION_ENDPOINT": "https://vision.googleapis.com/v1/images:annotate",
        "GOOGLE_SERVICE_ACCOUNT_EMAIL": "your-service-account@project.iam.gserviceaccount.com",
        "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\nPASTE_YOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n"
      }
    }
  }
}
```

## Core Components

### 1. Authentication Management

#### GCP Authentication Workflow
```javascript
async function authenticateGCP(serviceAccountKeyJson, projectId) {
  // Create temporary service account key file
  const keyFilePath = path.join(os.tmpdir(), `gcp-key-${Date.now()}.json`);
  fs.writeFileSync(keyFilePath, JSON.stringify(serviceAccountKeyJson, null, 2));

  // Authenticate using service account key
  execCommand(`gcloud auth activate-service-account --key-file=${keyFilePath}`);

  // Set project
  execCommand(`gcloud config set project ${projectId}`);

  // Verify authentication
  const authList = execCommand('gcloud auth list --format="value(account)"');
  const isAuthenticated = authList && authList.trim().includes(serviceAccountKeyJson.client_email);

  // Cleanup temporary file
  fs.unlinkSync(keyFilePath);

  return isAuthenticated;
}
```

**Key Commands:**
- `gcloud auth activate-service-account --key-file=<key_file>`
- `gcloud config set project <project_id>`
- `gcloud auth list --format="value(account)"`

#### Cloudflare Authentication Workflow
```javascript
async function authenticateCloudflare(apiToken, accountId) {
  // Clear existing environment variables
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CF_API_TOKEN;
  delete process.env.CF_ACCOUNT_ID;

  // Set environment variables for Wrangler
  process.env.CLOUDFLARE_API_TOKEN = apiToken;
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  // Verify authentication
  const whoamiResult = execCommand('wrangler whoami', { silent: true });
  const isAuthenticated = whoamiResult && (whoamiResult.includes(accountId) || whoamiResult.trim().length > 0);

  return isAuthenticated;
}
```

**Key Commands:**
- `wrangler whoami`
- Environment variables: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

### 2. Resource Creation and Management

#### R2 Bucket Management
```javascript
async function ensureR2Bucket(codebasePath, bucketName) {
  // List existing buckets
  const listResult = await executeWithLogs('wrangler r2 bucket list', codebasePath);

  // Create bucket if it doesn't exist
  if (!listResult.stdout.includes(bucketName)) {
    await executeWithLogs(`wrangler r2 bucket create ${bucketName}`, codebasePath);
  }
}
```

**Key Commands:**
- `wrangler r2 bucket list`
- `wrangler r2 bucket create <bucket_name>`

#### D1 Database Management
```javascript
async function ensureD1Database(codebasePath, databaseName) {
  // List existing databases
  const output = execSync('wrangler d1 list', {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10000,
    cwd: codebasePath,
    env: process.env
  });

  // Create database if it doesn't exist
  if (!output.includes(databaseName)) {
    await executeWithLogs(`wrangler d1 create ${databaseName}`, codebasePath);

    // Initialize schema
    const schemaPath = path.join(codebasePath, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      await executeWithLogs(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, codebasePath);
    }
  } else {
    // Check and update schema if needed
    await checkAndUpdateSchema(databaseName, schemaPath);
  }
}
```

**Key Commands:**
- `wrangler d1 list`
- `wrangler d1 create <database_name>`
- `wrangler d1 execute <database_name> --remote --file=<schema_file>`
- `wrangler d1 execute <database_name> --remote --command="<sql_command>"`

#### Schema Management Commands
```sql
-- Check for existing tables
SELECT name FROM sqlite_master WHERE type='table' AND name='selfies';

-- Check table structure
PRAGMA table_info(results);

-- Create tables
CREATE TABLE selfies (
  id TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  selfie_id TEXT NOT NULL,
  preset_collection_id TEXT NOT NULL,
  preset_image_id TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  result_url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (selfie_id) REFERENCES selfies(id)
);
```

### 3. Secrets Management

#### Batch Secrets Deployment
```javascript
async function deploySecrets(secrets, codebasePath, workerName) {
  const tempSecretsFile = path.join(os.tmpdir(), `wrangler-secrets-${Date.now()}.json`);

  try {
    // Create temporary secrets file
    fs.writeFileSync(tempSecretsFile, JSON.stringify(secrets, null, 2));

    // Deploy using batch command
    const command = workerName
      ? `wrangler secret bulk "${tempSecretsFile}" --name ${workerName}`
      : `wrangler secret bulk "${tempSecretsFile}"`;

    const result = await executeWithLogs(command, codebasePath);

    if (!result.success) {
      // Fallback to individual deployment
      await deploySecretsIndividually(secrets, codebasePath, workerName);
    }
  } finally {
    // Cleanup temporary file
    if (fs.existsSync(tempSecretsFile)) {
      fs.unlinkSync(tempSecretsFile);
    }
  }
}
```

**Key Commands:**
- `wrangler secret bulk <secrets_file> --name <worker_name>` (batch)
- `echo "<secret_value>" | wrangler secret put <secret_key> --name <worker_name>` (individual)

### 4. Worker Deployment

#### Wrangler Configuration Generation
```javascript
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
```

#### Worker Deployment Process
```javascript
async function deployWorker(codebasePath, workerName, deploymentConfig) {
  // Generate wrangler.jsonc
  const wranglerConfig = generateWranglerConfig(deploymentConfig);
  fs.writeFileSync(path.join(codebasePath, 'wrangler.jsonc'), JSON.stringify(wranglerConfig, null, 2));

  // Deploy worker
  let result = await executeWithLogs('wrangler deploy', codebasePath);

  // Handle error 10214 (first deployment)
  if (!result.success && result.error.includes('code: 10214')) {
    result = await executeWithLogs('wrangler deploy', codebasePath);
  }

  // Get deployment URL
  const deployments = execSync('wrangler deployments list --latest', {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10000,
    cwd: codebasePath,
    env: process.env
  });

  const urlMatch = deployments.match(/https:\/\/[^\s]+\.workers\.dev/);
  return urlMatch ? urlMatch[0] : '';
}
```

**Key Commands:**
- `wrangler deploy`
- `wrangler deployments list --latest`

### 5. Pages Deployment

#### Pages Project Management
```javascript
async function ensurePagesProject(codebasePath, pagesProjectName) {
  // List existing projects
  const listResult = await executeWithLogs('wrangler pages project list', codebasePath);

  // Create project if it doesn't exist
  if (!listResult.stdout.includes(pagesProjectName)) {
    await executeWithLogs(`wrangler pages project create ${pagesProjectName} --production-branch=main`, codebasePath);
  }
}
```

#### Pages Deployment Process
```javascript
async function deployPages(codebasePath, pagesProjectName) {
  await ensurePagesProject(codebasePath, pagesProjectName);

  const publicPageDir = path.join(codebasePath, 'public_page');
  const absolutePublicPageDir = path.resolve(publicPageDir);

  const command = `wrangler pages deploy "${absolutePublicPageDir}" --project-name=${pagesProjectName} --branch=main --commit-dirty=true`;

  const result = await executeWithLogs(command, codebasePath);

  return `https://${pagesProjectName}.pages.dev/`;
}
```

**Key Commands:**
- `wrangler pages project list`
- `wrangler pages project create <project_name> --production-branch=main`
- `wrangler pages deploy <directory> --project-name=<project_name> --branch=main --commit-dirty=true`

## Error Handling and Auto-Confirmation

### Auto-Confirmation for Interactive Prompts
```javascript
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
```

### Error Code Handling
- **Error 10214**: "Can't edit settings on non-deployed worker" - Retry deployment
- **"already exists"**: Resource creation succeeded (non-fatal)
- **"no such table"**: Database operation succeeded (non-fatal)

## Caching System

### Authentication Cache
```javascript
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

function loadCache() {
  const cacheFile = path.join(os.homedir(), '.ai-faceswap-deploy', 'auth-cache.json');
  // Load and validate cache
}

function saveCache(cache) {
  cache.timestamp = Date.now();
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}
```

Cache keys:
- `gcpAuth_${projectId}`
- `cloudflareAuth_${accountId}`
- `r2Bucket_${bucketName}`
- `d1Database_${databaseName}`

## Execution Flow

### Main Deployment Sequence
1. Load configuration from `deploy/deployments-secrets.json`
2. Verify CLI tools (`wrangler`, `gcloud`)
3. Authenticate with GCP using service account key
4. Authenticate with Cloudflare using API token
5. Create/verify R2 bucket
6. Create/verify D1 database and schema
7. Deploy secrets (batch preferred, individual fallback)
8. Deploy Cloudflare Worker
9. Deploy Cloudflare Pages (if enabled)
10. Return deployment URLs

### Environment Variable Management
- Clear existing Cloudflare env vars before setting new ones
- Use temporary env vars during deployment operations
- Restore original env vars after operations complete
- Never persist credentials in environment permanently

## Command Execution Patterns

### Synchronous Execution
```javascript
function execCommand(command, options = {}) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: options.silent ? 'pipe' : 'inherit',
    env: process.env,
    ...options
  });
}
```

### Asynchronous Execution with Logging
```javascript
async function executeWithLogs(command, cwd, stepName) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      cwd: cwd || process.cwd(),
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });

    // Handle stdout, stderr, and completion
  });
}
```

## Security Considerations

1. **Temporary Files**: Create service account keys in temp directory and cleanup immediately
2. **Environment Variables**: Clear sensitive env vars after use
3. **API Tokens**: Never log or expose API tokens in output
4. **File Permissions**: Use restrictive permissions for temporary credential files

## Logging and Output Filtering

### Log Levels
- `log.info()`: General information
- `log.success()`: Successful operations
- `log.warn()`: Non-critical issues
- `log.error()`: Critical errors

### Output Filtering for Wrangler Commands
- Skip telemetry messages
- Skip update available warnings
- Show only relevant deployment status messages
- Filter Pages deployment output for important updates

## URL Construction and Discovery

### Worker URL Discovery
1. Extract from `wrangler deployments list --latest` output
2. Fallback: Construct from `wrangler whoami` account subdomain
3. Pattern: `https://{worker-name}.{account-subdomain}.workers.dev`

### Pages URL Construction
- Always: `https://{pagesProjectName}.pages.dev/`

This comprehensive guide provides all the technical details needed to implement automated deployment workflows using Wrangler CLI and GCP service accounts.
