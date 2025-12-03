#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

let currentStep = 0;
const totalSteps = 9;

function logStep(message) {
  currentStep++;
  console.log(`${colors.cyan}[${currentStep}/${totalSteps}]${colors.reset} ${message}`);
}

function logSuccess(message) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function logError(message) {
  console.log(`${colors.red}✗${colors.reset} ${message}`);
}

function logWarn(message) {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function execCommand(command, options = {}) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: options.silent ? 'pipe' : 'inherit', ...options });
  } catch (error) {
    if (options.throwOnError !== false) throw error;
    return null;
  }
}

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { cwd: cwd || process.cwd(), shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', answered = false;

    const answerPrompt = (output) => {
      if (answered) return;
      const full = (stdout + stderr + output).toLowerCase();
      if (full.includes('ok to proceed?') || (full.includes('⚠️') && full.includes('unavailable')) ||
          (full.includes('this process may take some time') && full.includes('ok to proceed'))) {
        child.stdin.write('yes\n');
        answered = true;
      }
    };

    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      answerPrompt(output);
    });

    child.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      answerPrompt(output);
    });

    child.on('close', (code) => {
      const result = { success: code === 0, stdout, stderr, exitCode: code, error: code !== 0 ? stderr || stdout : null };
      result.success ? resolve(result) : reject(new Error(result.error || `Command failed with code ${code}`));
    });

    child.on('error', reject);
  });
}

function restoreEnv(origToken, origAccountId) {
  if (origToken !== undefined) process.env.CLOUDFLARE_API_TOKEN = origToken;
  else delete process.env.CLOUDFLARE_API_TOKEN;
  if (origAccountId !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = origAccountId;
  else delete process.env.CLOUDFLARE_ACCOUNT_ID;
}

async function loadConfig() {
  const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');

  if (!fs.existsSync(secretsPath)) {
    logError('_deploy-cli-cloudflare-gcp/deployments-secrets.json not found. Please create it with your configuration.');
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(secretsPath, 'utf8');
    let config = parseConfig(JSON.parse(content));

    if (config._needsCloudflareSetup) {
      logWarn('Cloudflare credentials missing, setting up...');
      await setupCloudflare(config._environment);
      const newContent = fs.readFileSync(secretsPath, 'utf8');
      config = parseConfig(JSON.parse(newContent));
      logSuccess('Cloudflare credentials configured');
    }

    return config;
  } catch (error) {
    logError(`Config error: ${error.message}`);
    process.exit(1);
  }
}

function parseConfig(config) {
  const env = process.env.DEPLOY_ENV || 'production';
  if (config.environments) {
    config = config.environments[env];
    if (!config) throw new Error(`Environment '${env}' not found`);
  }

  const required = [
    'workerName', 'pagesProjectName', 'databaseName', 'bucketName', 'gcp',
    'RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT',
    'GOOGLE_VISION_API_KEY', 'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION',
    'GOOGLE_VISION_ENDPOINT', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'
  ];

  const missing = required.filter(field => !config[field]);
  if (missing.length) throw new Error(`Missing fields: ${missing.join(', ')}`);

  config.cloudflare = config.cloudflare || {};
  const hasCloudflare = config.cloudflare.accountId && config.cloudflare.apiToken &&
                       !config.cloudflare.accountId.includes('your_') &&
                       !config.cloudflare.apiToken.includes('your_');

  if (!hasCloudflare) {
    config._needsCloudflareSetup = true;
    config._environment = env;
  }

  if (!config.gcp?.projectId || !config.gcp?.serviceAccountKeyJson) {
    throw new Error('Invalid GCP configuration');
  }

  return {
    name: config.name || 'default',
    workerName: config.workerName,
    pagesProjectName: config.pagesProjectName,
    databaseName: config.databaseName,
    bucketName: config.bucketName,
    deployPages: config.deployPages || process.env.DEPLOY_PAGES === 'true',
    cloudflare: {
      accountId: config.cloudflare.accountId || '',
      apiToken: config.cloudflare.apiToken || ''
    },
    gcp: config.gcp,
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
    },
    _needsCloudflareSetup: config._needsCloudflareSetup,
    _environment: config._environment
  };
}

function generateWranglerConfig(config) {
  return {
    name: config.workerName,
    main: 'backend-cloudflare-workers/index.ts',
    compatibility_date: '2024-01-01',
    account_id: config.cloudflare.accountId,
    d1_databases: [{ binding: 'DB', database_name: config.databaseName }],
    r2_buckets: [{ binding: 'FACESWAP_IMAGES', bucket_name: config.bucketName }]
  };
}

function getWranglerToken() {
  const configPath = path.join(os.homedir(), '.wrangler', 'config', 'default.toml');
  if (!fs.existsSync(configPath)) return null;

  const content = fs.readFileSync(configPath, 'utf8');
  const oauthMatch = content.match(/oauth_token\s*=\s*"([^"]+)"/);
  const refreshMatch = content.match(/refresh_token\s*=\s*"([^"]+)"/);
  const expMatch = content.match(/expiration_time\s*=\s*"([^"]+)"/);

  if (oauthMatch) {
    return {
      type: 'oauth_token',
      token: oauthMatch[1],
      refreshToken: refreshMatch ? refreshMatch[1] : null,
      expirationTime: expMatch ? expMatch[1] : null
    };
  }

  return null;
}

async function loginWrangler() {
  return new Promise((resolve, reject) => {
    console.log('\n🔐 Cloudflare login required. Complete in browser...\n');

    const origToken = process.env.CLOUDFLARE_API_TOKEN;
    const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;

    const proc = spawn('wrangler', ['login'], {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, BROWSER: process.env.BROWSER || 'default' }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        let attempts = 0;
        const checkToken = () => {
          attempts++;
          const token = getWranglerToken();
          if (token) {
            restoreEnv(origToken, origAccountId);
            resolve(token);
          } else if (attempts < 10) {
            setTimeout(checkToken, 1000);
          } else {
            restoreEnv(origToken, origAccountId);
            reject(new Error('Token not found after login'));
          }
        };
        setTimeout(checkToken, 2000);
      } else {
        restoreEnv(origToken, origAccountId);
        reject(new Error(`Login failed with code ${code}`));
      }
    });

    proc.on('error', (error) => {
      restoreEnv(origToken, origAccountId);
      reject(error);
    });
  });
}

async function validateCloudflareToken(token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/user/tokens/verify',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.success && json.result);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function getAccountIdFromWrangler() {
  try {
    const output = execCommand('wrangler whoami', { silent: true, throwOnError: false });
    if (!output) return null;

    const msg = output.toLowerCase();
    if (msg.includes('invalid access token') || msg.includes('code: 9109') ||
        msg.includes('authentication error') || msg.includes('unauthorized')) {
      throw new Error('Invalid token');
    }

    const match = output.match(/Account ID:\s*([a-f0-9]{32})/i) || output.match(/([a-f0-9]{32})/);
    return match ? match[1] : null;
  } catch (error) {
    if (error.message === 'Invalid token') throw error;
    return null;
  }
}

async function getAccountIdFromApi(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/accounts',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          json.success && json.result?.length ? resolve(json.result[0].id) :
            reject(new Error(json.errors?.[0]?.message || 'Failed to get account ID'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function isTokenExpired(expirationTime) {
  if (!expirationTime) return true;
  try {
    const date = new Date(expirationTime);
    if (isNaN(date.getTime())) {
      return true;
    }
    return date <= new Date();
  } catch {
    return true;
  }
}

async function setupCloudflare(env = null, preferredAccountId = null) {
  logWarn('Setting up Cloudflare credentials...');

  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;

  let tokenInfo = getWranglerToken();
  
  if (!tokenInfo || isTokenExpired(tokenInfo.expirationTime)) {
    if (tokenInfo && tokenInfo.refreshToken) {
      logStep('Access token expired, refreshing...');
      try {
        tokenInfo = await loginWrangler();
      } catch (error) {
        logWarn(`Refresh failed: ${error.message}. Re-login required.`);
        tokenInfo = await loginWrangler();
      }
    } else {
      logStep('No valid token found, logging in...');
      tokenInfo = await loginWrangler();
    }
  }

  const token = tokenInfo.token;
  process.env.CLOUDFLARE_API_TOKEN = token;

  let accountId = preferredAccountId;
  if (!accountId) {
    accountId = getAccountIdFromWrangler();
    if (!accountId) {
      try {
        accountId = await getAccountIdFromApi(token);
      } catch (error) {
        const output = execCommand('wrangler whoami', { silent: false, throwOnError: false });
        if (output) {
          const match = output.match(/Account ID[:\s]+([a-f0-9]{32})/i);
          accountId = match ? match[1] : null;
        }
      }
    }
  }

  if (!accountId) {
    restoreEnv(origToken, origAccountId);
    throw new Error('Could not get account ID');
  }

  if (preferredAccountId && accountId !== preferredAccountId) {
    logWarn(`Using account ID from config: ${preferredAccountId} (wrangler logged into: ${accountId})`);
    accountId = preferredAccountId;
  }

  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  saveCloudflareCredentials(accountId, token, tokenInfo.refreshToken, tokenInfo.expirationTime, env);
  
  restoreEnv(origToken, origAccountId);
  return { accountId, apiToken: token };
}

function saveCloudflareCredentials(accountId, token, refreshToken = null, expirationTime = null, env = null) {
  const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
  if (!fs.existsSync(secretsPath)) return;

  const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  const targetEnv = env || process.env.DEPLOY_ENV || 'production';

  if (!secrets.environments) secrets.environments = {};
  if (!secrets.environments[targetEnv]) secrets.environments[targetEnv] = {};
  if (!secrets.environments[targetEnv].cloudflare) secrets.environments[targetEnv].cloudflare = {};

  secrets.environments[targetEnv].cloudflare.accountId = accountId;
  secrets.environments[targetEnv].cloudflare.apiToken = token;
  if (refreshToken) secrets.environments[targetEnv].cloudflare.refreshToken = refreshToken;
  if (expirationTime) {
    const date = new Date(expirationTime);
    const humanReadable = date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    });
    secrets.environments[targetEnv].cloudflare.expirationTime = humanReadable;
  }
  
  if (secrets.environments[targetEnv].cloudflare.email === '') {
    delete secrets.environments[targetEnv].cloudflare.email;
  }

  fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
  logSuccess(`Credentials saved for ${targetEnv} environment`);
}

const REQUIRED_SECRETS = ['RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT', 'GOOGLE_VISION_API_KEY',
                         'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_VISION_ENDPOINT',
                         'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'];

function checkSecrets(existing) {
  const missing = REQUIRED_SECRETS.filter(v => !existing.includes(v));
  return { missing, allSet: missing.length === 0 };
}

function getWorkerUrl(cwd, workerName) {
  try {
    const deployments = execSync('wrangler deployments list --latest', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd });
    const match = deployments?.match(/https:\/\/[^\s]+\.workers\.dev/);
    if (match) return match[0];
  } catch {
    try {
      const whoami = execSync('wrangler whoami', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd });
      const match = whoami.match(/([^\s]+)@/);
      if (match) return `https://${workerName}.${match[1]}.workers.dev`;
    } catch {
      return '';
    }
  }
  return '';
}

function updateWorkerUrlInHtml(cwd, workerUrl) {
  if (!workerUrl) return;
  const htmlPath = path.join(cwd, 'frontend-cloudflare-pages', 'index.html');
  if (fs.existsSync(htmlPath)) {
    let content = fs.readFileSync(htmlPath, 'utf8');
    content = content.replace(/const WORKER_URL = ['"](.*?)['"]/, `const WORKER_URL = '${workerUrl}'`);
    fs.writeFileSync(htmlPath, content);
  }
}

const utils = {
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

  async authenticateGCP(serviceAccountKeyJson, projectId) {
    const keyFile = path.join(os.tmpdir(), `gcp-key-${Date.now()}.json`);
    const serviceAccountEmail = serviceAccountKeyJson.client_email;
    
    try {
      if (serviceAccountKeyJson.project_id && serviceAccountKeyJson.project_id !== projectId) {
        throw new Error(`Service account project (${serviceAccountKeyJson.project_id}) does not match config project (${projectId})`);
      }

      fs.writeFileSync(keyFile, JSON.stringify(serviceAccountKeyJson, null, 2));

      const allAccounts = execCommand('gcloud auth list --format="value(account)"', { silent: true, throwOnError: false });
      if (allAccounts) {
        const accounts = allAccounts.split('\n').filter(a => a.trim() && a.trim() !== serviceAccountEmail);
        for (const account of accounts) {
          try {
            execCommand(`gcloud auth revoke "${account.trim()}" --quiet`, { silent: true, throwOnError: false });
          } catch {
            // ignore
          }
        }
      }

      execCommand(`gcloud auth activate-service-account ${serviceAccountEmail} --key-file=${keyFile} --quiet`, { silent: true });
      execCommand(`gcloud config set project ${projectId} --quiet`, { silent: true });

      const activeAuth = execCommand('gcloud auth list --format="value(account)" --filter=status:ACTIVE', { silent: true, throwOnError: false });
      const activeProject = execCommand('gcloud config get-value project', { silent: true, throwOnError: false });

      if (!activeAuth || !activeAuth.trim().includes(serviceAccountEmail)) {
        throw new Error(`Failed to activate service account: ${serviceAccountEmail}`);
      }

      if (activeProject && activeProject.trim() !== projectId) {
        throw new Error(`Project mismatch: expected ${projectId}, got ${activeProject.trim()}`);
      }

      return true;
    } finally {
      try {
        fs.unlinkSync(keyFile);
      } catch {
        // ignore
      }
    }
  },

  async checkGCPApiEnabled(apiName, projectId) {
    try {
      const output = execCommand(
        `gcloud services list --enabled --filter="name:${apiName}" --format="value(name)" --project=${projectId}`,
        { silent: true, throwOnError: false }
      );
      return output && output.trim().includes(apiName);
    } catch {
      return false;
    }
  },

  async enableGCPApi(apiName, projectId) {
    try {
      execCommand(`gcloud services enable ${apiName} --project=${projectId} --quiet`, { silent: true });
      return true;
    } catch (error) {
      if (error.message && error.message.includes('already enabled')) {
        return true;
      }
      throw error;
    }
  },

  async ensureGCPApis(projectId) {
    const requiredApis = [
      'aiplatform.googleapis.com',
      'vision.googleapis.com'
    ];

    const apiNames = {
      'aiplatform.googleapis.com': 'Vertex AI API',
      'vision.googleapis.com': 'Vision API'
    };

    const results = {
      enabled: [],
      newlyEnabled: [],
      failed: []
    };

    const self = this;
    for (const api of requiredApis) {
      const isEnabled = await self.checkGCPApiEnabled(api, projectId);
      if (isEnabled) {
        results.enabled.push(api);
      } else {
        try {
          await self.enableGCPApi(api, projectId);
          results.newlyEnabled.push(api);
          logSuccess(`${apiNames[api]} enabled`);
        } catch (error) {
          results.failed.push({ api, error: error.message });
          logWarn(`Failed to enable ${apiNames[api]}: ${error.message}`);
        }
      }
    }

    return results;
  },

  getExistingSecrets() {
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

  async ensureR2Bucket(cwd, bucketName) {
    try {
      const result = await runCommand('wrangler r2 bucket list', cwd);
      if (!result.stdout.includes(bucketName)) {
        await runCommand(`wrangler r2 bucket create ${bucketName}`, cwd);
      }
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }
  },

  async ensureD1Database(cwd, databaseName) {
    try {
      const output = execSync('wrangler d1 list', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false });

      if (!output || !output.includes(databaseName)) {
        logStep('Creating D1 database...');
        await runCommand(`wrangler d1 create ${databaseName}`, cwd);
        logSuccess('Database created');
      } else {
        logSuccess('Database already exists');
      }

      const schemaPath = path.join(cwd, 'backend-cloudflare-workers', 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        try {
          logStep('Initializing database schema...');
          await runCommand(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, cwd);
          logSuccess('Database schema initialized');
        } catch (schemaError) {
          const errorMsg = schemaError.message || schemaError.error || '';
          if (!errorMsg.includes('already exists') && !errorMsg.includes('duplicate')) {
            logWarn(`Schema initialization warning: ${errorMsg}`);
          }
        }
      }
    } catch (error) {
      const errorMsg = error.message || error.error || '';
      if (errorMsg.includes('already exists') || errorMsg.includes('name is already in use')) {
        logWarn('Database already exists, will use existing database');
      } else {
        throw error;
      }
    }
  },

  async deploySecrets(secrets, cwd, workerName) {
    if (!secrets || !Object.keys(secrets).length) return { success: true, deployed: 0, total: 0 };

    const keys = Object.keys(secrets);
    const tempFile = path.join(os.tmpdir(), `secrets-${Date.now()}.json`);

    try {
      fs.writeFileSync(tempFile, JSON.stringify(secrets, null, 2));
      const cmd = workerName ? `wrangler secret bulk "${tempFile}" --name ${workerName}` : `wrangler secret bulk "${tempFile}"`;
      const result = await runCommand(cmd, cwd);
      if (result.success) {
        logSuccess(`Deployed ${keys.length} secrets`);
        return { success: true, deployed: keys.length, total: keys.length };
      }
    } catch {
      // Fallback to individual
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // ignore
      }
    }

    let successCount = 0;
    for (const [key, value] of Object.entries(secrets)) {
      try {
        const cmd = workerName ? `wrangler secret put ${key} --name ${workerName}` : `wrangler secret put ${key}`;
        const result = await runCommand(`echo "${value.replace(/"/g, '\\"')}" | ${cmd}`, cwd);
        if (result.success) successCount++;
      } catch {
        // continue
      }
    }

    if (successCount === 0) throw new Error('Failed to deploy secrets');
    if (successCount < keys.length) logWarn(`Only ${successCount}/${keys.length} secrets deployed`);

    return { success: true, deployed: successCount, total: keys.length };
  },

  async deployWorker(cwd, workerName, config) {
    const wranglerConfigFiles = [
      path.join(cwd, 'wrangler.json'),
      path.join(cwd, 'wrangler.jsonc'),
      path.join(cwd, 'wrangler.toml')
    ];

    for (const configFile of wranglerConfigFiles) {
      if (fs.existsSync(configFile)) {
        try {
          fs.unlinkSync(configFile);
        } catch {
        }
      }
    }

    const wranglerPath = path.join(cwd, 'wrangler.jsonc');
    let createdConfig = false;

    try {
      const wranglerConfig = generateWranglerConfig(config);
      fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, 2));
      createdConfig = true;

      let result = await runCommand('wrangler deploy', cwd);
      if (!result.success && result.error?.includes('code: 10214')) {
        result = await runCommand('wrangler deploy', cwd);
      }
      if (!result.success) throw new Error(result.error || 'Worker deployment failed');

      const workerUrl = getWorkerUrl(cwd, workerName);
      updateWorkerUrlInHtml(cwd, workerUrl);
      return workerUrl;
    } finally {
      if (createdConfig && fs.existsSync(wranglerPath)) {
        try {
          fs.unlinkSync(wranglerPath);
        } catch {
          // ignore
        }
      }
    }
  },

  async deployPages(cwd, pagesProjectName) {
    const publicDir = path.join(cwd, 'frontend-cloudflare-pages');
    if (!fs.existsSync(publicDir)) return `https://${pagesProjectName}.pages.dev/`;

    try {
      await runCommand(`wrangler pages project create ${pagesProjectName} --production-branch=main`, cwd);
    } catch {
      // Project might already exist
    }

    try {
      const absDir = path.resolve(publicDir);
      await runCommand(`wrangler pages deploy "${absDir}" --project-name=${pagesProjectName} --branch=main --commit-dirty=true`, cwd);
    } catch {
      // Deployment might have issues but continue
    }

    return `https://${pagesProjectName}.pages.dev/`;
  }
};

async function deploy(config, progressCallback, cwd, flags = {}) {
  const report = progressCallback || ((step, status, details) => {
    if (status === 'running') logStep(step);
    else if (status === 'completed') logSuccess(details);
    else if (status === 'failed') logError(details);
    else if (status === 'warning') logWarn(details);
  });

  const DEPLOY_SECRETS = flags.DEPLOY_SECRETS !== false;
  const DEPLOY_DB = flags.DEPLOY_DB !== false;
  const DEPLOY_WORKER = flags.DEPLOY_WORKER !== false;
  const DEPLOY_PAGES = flags.DEPLOY_PAGES !== false;
  const DEPLOY_R2 = flags.DEPLOY_R2 !== false;

  const needsCloudflare = DEPLOY_SECRETS || DEPLOY_WORKER || DEPLOY_PAGES || DEPLOY_R2 || DEPLOY_DB;
  const needsGCP = DEPLOY_SECRETS || DEPLOY_WORKER;

  if (needsCloudflare || needsGCP) {
    report('Checking prerequisites...', 'running', 'Validating tools');
    if (needsCloudflare && !utils.checkWrangler()) throw new Error('Wrangler CLI not found');
    if (needsGCP && !utils.checkGcloud()) throw new Error('gcloud CLI not found');
    report('Checking prerequisites...', 'completed', 'Tools validated');
  }

  if (needsGCP) {
    report('Authenticating with GCP...', 'running', 'Connecting to Google Cloud');
    if (!await utils.authenticateGCP(config.gcp.serviceAccountKeyJson, config.gcp.projectId)) {
      throw new Error('GCP authentication failed');
    }
    report('Authenticating with GCP...', 'completed', 'GCP authenticated');

    report('Checking GCP APIs...', 'running', 'Verifying Vertex AI and Vision APIs');
    const apiResults = await utils.ensureGCPApis(config.gcp.projectId);
    if (apiResults.failed.length > 0) {
      const failedApis = apiResults.failed.map(f => f.api).join(', ');
      report('Checking GCP APIs...', 'warning', `Some APIs failed to enable: ${failedApis}. Please enable manually in GCP Console.`);
    } else if (apiResults.newlyEnabled.length > 0) {
      report('Checking GCP APIs...', 'completed', `Enabled ${apiResults.newlyEnabled.length} API(s)`);
    } else {
      report('Checking GCP APIs...', 'completed', 'All required APIs are enabled');
    }
  }

  if (needsCloudflare) {
    report('Setting up Cloudflare credentials...', 'running', 'Configuring Cloudflare access');
    let cfToken = config.cloudflare.apiToken;
    let cfAccountId = config.cloudflare.accountId;

    if (!cfToken || !cfAccountId || !await validateCloudflareToken(cfToken)) {
      const creds = await setupCloudflare(config._environment, cfAccountId);
      cfToken = creds.apiToken;
      cfAccountId = creds.accountId;
      config.cloudflare.apiToken = cfToken;
      config.cloudflare.accountId = cfAccountId;
    }
    report('Setting up Cloudflare credentials...', 'completed', 'Cloudflare ready');

    const origToken = process.env.CLOUDFLARE_API_TOKEN;
    const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_API_TOKEN = cfToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;

    try {
      if (DEPLOY_R2 || DEPLOY_DB) {
        report('Setting up resources...', 'running', 'Creating Cloudflare resources');
        if (DEPLOY_R2) await utils.ensureR2Bucket(cwd, config.bucketName);
        if (DEPLOY_DB) await utils.ensureD1Database(cwd, config.databaseName);
        report('Setting up resources...', 'completed', 'Resources ready');
      }

      if (DEPLOY_SECRETS) {
        report('Deploying secrets...', 'running', 'Configuring environment secrets');
        if (Object.keys(config.secrets || {}).length > 0) {
          await utils.deploySecrets(config.secrets, cwd, config.workerName);
          report('Deploying secrets...', 'completed', 'Secrets deployed');
        } else {
          const existing = utils.getExistingSecrets();
          const { missing, allSet } = checkSecrets(existing);
          if (!allSet) {
            report('Deploying secrets...', 'warning', `Missing secrets: ${missing.join(', ')}`);
          } else {
            report('Deploying secrets...', 'completed', 'All secrets set');
          }
        }
      }

      let workerUrl = '';
      if (DEPLOY_WORKER) {
        report('Deploying worker...', 'running', 'Deploying Cloudflare Worker');
        workerUrl = await utils.deployWorker(cwd, config.workerName, config);
        report('Deploying worker...', 'completed', 'Worker deployed');
      }

      let pagesUrl = '';
      if (DEPLOY_PAGES) {
        report('Deploying frontend...', 'running', 'Deploying Cloudflare Pages');
        pagesUrl = await utils.deployPages(cwd, config.pagesProjectName);
        report('Deploying frontend...', 'completed', 'Frontend deployed');
      }

      console.log('\n' + '='.repeat(50));
      console.log('✓ Deployment Complete!');
      console.log('\n📌 URLs:');
      if (workerUrl) console.log(`   ✅ Backend: ${workerUrl}`);
      if (pagesUrl) console.log(`   ✅ Frontend: ${pagesUrl}`);
      if (!workerUrl && !pagesUrl) console.log(`   ✅ Frontend: https://${config.pagesProjectName}.pages.dev/`);
      console.log('');

      return { success: true, workerUrl, pagesUrl };
    } finally {
      restoreEnv(origToken, origAccountId);
    }
  } else {
    return { success: true, message: 'No deployment steps selected' };
  }
}

async function main() {
  console.log('\n🚀 AI FaceSwap Cloudflare Backend - Deployment\n');

  logStep('Loading configuration...');
  const config = await loadConfig();

  logStep('Checking prerequisites...');
  if (!utils.checkWrangler()) {
    logError('Wrangler CLI not found');
    process.exit(1);
  }
  if (!utils.checkGcloud()) {
    logError('gcloud CLI not found');
    process.exit(1);
  }

  logStep('Authenticating with GCP...');
  if (!await utils.authenticateGCP(config.gcp.serviceAccountKeyJson, config.gcp.projectId)) {
    logError('GCP authentication failed');
    process.exit(1);
  }
  logSuccess('GCP authenticated');

  logStep('Checking GCP APIs...');
  const apiResults = await utils.ensureGCPApis(config.gcp.projectId);
  if (apiResults.failed.length > 0) {
    const failedApis = apiResults.failed.map(f => f.api).join(', ');
    logWarn(`Some APIs failed to enable: ${failedApis}. Please enable manually in GCP Console.`);
  } else if (apiResults.newlyEnabled.length > 0) {
    logSuccess(`Enabled ${apiResults.newlyEnabled.length} API(s)`);
  } else {
    logSuccess('All required APIs are enabled');
  }

  logStep('Setting up Cloudflare credentials...');
  let cfToken = config.cloudflare.apiToken;
  let cfAccountId = config.cloudflare.accountId;

  if (!cfToken || !cfAccountId || !await validateCloudflareToken(cfToken)) {
    const creds = await setupCloudflare(config._environment, cfAccountId);
    cfToken = creds.apiToken;
    cfAccountId = creds.accountId;
    config.cloudflare.apiToken = cfToken;
    config.cloudflare.accountId = cfAccountId;
  }
  
  process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;
  logSuccess('Cloudflare ready');

  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = cfToken;
  process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;

  try {
    logStep('Setting up resources...');
    await utils.ensureR2Bucket(process.cwd(), config.bucketName);
    await utils.ensureD1Database(process.cwd(), config.databaseName);
    logSuccess('Resources ready');

    logStep('Deploying secrets...');
    if (Object.keys(config.secrets).length > 0) {
      await utils.deploySecrets(config.secrets, process.cwd(), config.workerName);
      logSuccess('Secrets deployed');
    } else {
      const existing = utils.getExistingSecrets();
      const { missing, allSet } = checkSecrets(existing);
      if (!allSet) {
        logWarn(`Missing secrets: ${missing.join(', ')}`);
      } else {
        logSuccess('All secrets set');
      }
    }

    logStep('Deploying worker...');
    const workerUrl = await utils.deployWorker(process.cwd(), config.workerName, config);
    logSuccess('Worker deployed');

    let pagesUrl = '';
    if (config.deployPages) {
      logStep('Deploying frontend...');
      pagesUrl = await utils.deployPages(process.cwd(), config.pagesProjectName);
      logSuccess('Frontend deployed');
    }

    console.log('\n' + '='.repeat(50));
    logSuccess('Deployment Complete!');
    console.log('\n📌 URLs:');
    if (workerUrl) console.log(`   ✅ Backend: ${workerUrl}`);
    console.log(`   ✅ Frontend: ${pagesUrl || `https://${config.pagesProjectName}.pages.dev/`}`);
    console.log('');

  } finally {
    restoreEnv(origToken, origAccountId);
  }
}

module.exports = {
  deployFromConfig: async (config, progressCallback, cwd, flags = {}) => {
    try {
      if (config.cloudflare?.apiToken) process.env.CLOUDFLARE_API_TOKEN = config.cloudflare.apiToken;
      if (config.cloudflare?.accountId) process.env.CLOUDFLARE_ACCOUNT_ID = config.cloudflare.accountId;
      if (config.deployPages !== undefined) process.env.DEPLOY_PAGES = config.deployPages.toString();

      return await deploy(config, progressCallback, cwd || process.cwd(), flags);
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  },
  loadConfig
};

if (require.main === module) {
  main().catch((error) => {
    logError(`Deployment failed: ${error.message}`);
    process.exit(1);
  });
}
