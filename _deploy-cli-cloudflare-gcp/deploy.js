#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgCyan: '\x1b[46m',
};

class DeploymentLogger {
  constructor() {
    this.steps = [];
    this.currentStepIndex = -1;
    this.startTime = Date.now();
    this.lastRenderTime = 0;
    this.renderThrottle = 100;
  }

  addStep(name, description = '') {
    const step = {
      name,
      description,
      status: 'pending',
      message: '',
      startTime: null,
      endTime: null,
      duration: null
    };
    this.steps.push(step);
    return this.steps.length - 1;
  }

  findStep(name) {
    return this.steps.findIndex(s => s.name === name);
  }

  startStep(nameOrIndex, message = '') {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      this.steps[index].status = 'running';
      this.steps[index].message = message;
      this.steps[index].startTime = Date.now();
      this.currentStepIndex = index;
      this.render();
    }
  }

  completeStep(nameOrIndex, message = '') {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      this.steps[index].status = 'completed';
      this.steps[index].message = message || this.steps[index].message;
      this.steps[index].endTime = Date.now();
      if (this.steps[index].startTime) {
        this.steps[index].duration = this.steps[index].endTime - this.steps[index].startTime;
      }
      this.render();
    }
  }

  failStep(nameOrIndex, message = '') {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      this.steps[index].status = 'failed';
      this.steps[index].message = message || this.steps[index].message;
      this.steps[index].endTime = Date.now();
      if (this.steps[index].startTime) {
        this.steps[index].duration = this.steps[index].endTime - this.steps[index].startTime;
      }
      this.render();
    }
  }

  warnStep(nameOrIndex, message = '') {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      if (this.steps[index].status === 'pending') {
        this.steps[index].status = 'running';
      }
      this.steps[index].message = message || this.steps[index].message;
      this.render();
    }
  }

  skipStep(nameOrIndex, message = '') {
    const index = typeof nameOrIndex === 'number' ? nameOrIndex : this.findStep(nameOrIndex);
    if (index >= 0 && index < this.steps.length) {
      this.steps[index].status = 'skipped';
      this.steps[index].message = message || 'Skipped';
      this.render();
    }
  }

  getStatusIcon(status) {
    switch (status) {
      case 'completed': return `${colors.green}${colors.bright}✓${colors.reset}`;
      case 'failed': return `${colors.red}${colors.bright}✗${colors.reset}`;
      case 'running': return `${colors.cyan}${colors.bright}⟳${colors.reset}`;
      case 'warning': return `${colors.yellow}${colors.bright}⚠${colors.reset}`;
      case 'skipped': return `${colors.dim}⊘${colors.reset}`;
      case 'pending': return `${colors.dim}○${colors.reset}`;
      default: return ' ';
    }
  }

  getStatusText(status) {
    switch (status) {
      case 'completed': return `${colors.green}${colors.bright}COMPLETED${colors.reset}`;
      case 'failed': return `${colors.red}${colors.bright}FAILED${colors.reset}`;
      case 'running': return `${colors.cyan}${colors.bright}RUNNING${colors.reset}`;
      case 'warning': return `${colors.yellow}${colors.bright}WARNING${colors.reset}`;
      case 'skipped': return `${colors.dim}SKIPPED${colors.reset}`;
      case 'pending': return `${colors.dim}PENDING${colors.reset}`;
      default: return '';
    }
  }

  formatDuration(ms) {
    if (!ms) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  render() {
    const now = Date.now();
    if (now - this.lastRenderTime < this.renderThrottle && this.steps.some(s => s.status === 'running')) {
      return;
    }
    this.lastRenderTime = now;

    process.stdout.write('\x1b[2J\x1b[0f');
    
    const headerWidth = 100;
    const title = '🚀 AI FaceSwap Cloudflare Backend - Deployment';
    const titlePadding = Math.max(0, headerWidth - title.length - 4);
    const header = `${colors.bright}${colors.cyan}╔${'═'.repeat(headerWidth - 2)}╗${colors.reset}\n` +
                   `${colors.bright}${colors.cyan}║${colors.reset} ${colors.bright}${colors.white}${title}${colors.reset}${' '.repeat(titlePadding)}${colors.bright}${colors.cyan}║${colors.reset}\n` +
                   `${colors.bright}${colors.cyan}╚${'═'.repeat(headerWidth - 2)}╝${colors.reset}\n`;

    process.stdout.write(header);

    const tableWidth = 100;
    const col1Width = 6;
    const col2Width = 42;
    const col3Width = 12;
    const col4Width = 10;
    const col5Width = 28;

    const separator = `${colors.dim}${'─'.repeat(col1Width)}${'┬'}${'─'.repeat(col2Width)}${'┬'}${'─'.repeat(col3Width)}${'┬'}${'─'.repeat(col4Width)}${'┬'}${'─'.repeat(col5Width)}${colors.reset}\n`;
    const headerRow = `${colors.bright}${'#'.padEnd(col1Width)}${colors.reset}${colors.dim}│${colors.reset} ${colors.bright}${'STEP'.padEnd(col2Width - 1)}${colors.reset}${colors.dim}│${colors.reset} ${colors.bright}${'STATUS'.padEnd(col3Width - 1)}${colors.reset}${colors.dim}│${colors.reset} ${colors.bright}${'TIME'.padEnd(col4Width - 1)}${colors.reset}${colors.dim}│${colors.reset} ${colors.bright}${'DETAILS'.padEnd(col5Width - 1)}${colors.reset}\n`;

    process.stdout.write(separator);
    process.stdout.write(headerRow);
    process.stdout.write(separator);

    this.steps.forEach((step, index) => {
      const stepNum = `${(index + 1).toString().padStart(2, '0')}`;
      const icon = this.getStatusIcon(step.status);
      const statusText = this.getStatusText(step.status);
      const duration = step.duration ? this.formatDuration(step.duration) : (step.status === 'running' ? '...' : '');
      
      let nameDisplay = step.name;
      if (nameDisplay.length > col2Width - 3) {
        nameDisplay = nameDisplay.substring(0, col2Width - 6) + '...';
      }
      
      let messageDisplay = step.message || '';
      if (messageDisplay.length > col5Width - 1) {
        messageDisplay = messageDisplay.substring(0, col5Width - 4) + '...';
      }
      
      const row = `${stepNum.padEnd(col1Width)}${colors.dim}│${colors.reset} ${icon} ${nameDisplay.padEnd(col2Width - 3)}${colors.dim}│${colors.reset} ${statusText.padEnd(col3Width - 1)}${colors.dim}│${colors.reset} ${duration.padEnd(col4Width - 1)}${colors.dim}│${colors.reset} ${messageDisplay.padEnd(col5Width - 1)}${colors.reset}\n`;
      process.stdout.write(row);
    });

    process.stdout.write(separator);

    const completed = this.steps.filter(s => s.status === 'completed').length;
    const failed = this.steps.filter(s => s.status === 'failed').length;
    const running = this.steps.filter(s => s.status === 'running').length;
    const skipped = this.steps.filter(s => s.status === 'skipped').length;
    const warning = this.steps.filter(s => s.status === 'warning').length;
    const total = this.steps.length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    const progressBar = this.renderProgressBar(progress);
    const summary = `${colors.bright}Progress:${colors.reset} ${progressBar} ${colors.bright}${progress}%${colors.reset}\n` +
                    `${colors.bright}Summary:${colors.reset} ${colors.green}${completed}✓${colors.reset} ` +
                    `${colors.red}${failed}✗${colors.reset} ` +
                    `${colors.yellow}${warning}⚠${colors.reset} ` +
                    `${colors.cyan}${running}⟳${colors.reset} ` +
                    `${colors.dim}${skipped}⊘${colors.reset} ` +
                    `| ${total} total\n`;
    
    const elapsed = Date.now() - this.startTime;
    const elapsedText = `${colors.bright}Elapsed:${colors.reset} ${this.formatDuration(elapsed)}\n`;
    
    process.stdout.write(summary);
    process.stdout.write(elapsedText);
    process.stdout.write('\n');
  }

  renderProgressBar(percentage) {
    const width = 40;
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    return `${colors.green}${'█'.repeat(filled)}${colors.reset}${colors.dim}${'░'.repeat(empty)}${colors.reset}`;
  }

  renderSummary(results = {}) {
    const allCompleted = this.steps.every(s => s.status === 'completed' || s.status === 'skipped' || s.status === 'warning');
    const hasFailures = this.steps.some(s => s.status === 'failed');

    process.stdout.write('\n');
    const summaryWidth = 100;
    const summaryTitle = '📊 Deployment Summary';
    const summaryPadding = Math.max(0, summaryWidth - summaryTitle.length - 4);
    process.stdout.write(`${colors.bright}${colors.cyan}╔${'═'.repeat(summaryWidth - 2)}╗${colors.reset}\n`);
    process.stdout.write(`${colors.bright}${colors.cyan}║${colors.reset} ${colors.bright}${colors.white}${summaryTitle}${colors.reset}${' '.repeat(summaryPadding)}${colors.bright}${colors.cyan}║${colors.reset}\n`);
    process.stdout.write(`${colors.bright}${colors.cyan}╚${'═'.repeat(summaryWidth - 2)}╝${colors.reset}\n`);
    process.stdout.write('\n');

    if (allCompleted && !hasFailures) {
      process.stdout.write(`${colors.green}${colors.bright}✓ Deployment completed successfully!${colors.reset}\n\n`);
      
      if (results.workerUrl) {
        process.stdout.write(`${colors.bright}Backend Worker:${colors.reset} ${colors.cyan}${results.workerUrl}${colors.reset}\n`);
      }
      if (results.pagesUrl) {
        process.stdout.write(`${colors.bright}Frontend Pages:${colors.reset} ${colors.cyan}${results.pagesUrl}${colors.reset}\n`);
      }
    } else if (hasFailures) {
      process.stdout.write(`${colors.red}${colors.bright}✗ Deployment failed!${colors.reset}\n\n`);
      const failedSteps = this.steps.filter(s => s.status === 'failed');
      failedSteps.forEach(step => {
        process.stdout.write(`${colors.red}  ✗ ${step.name}: ${step.message}${colors.reset}\n`);
      });
    }

    process.stdout.write('\n');
  }
}

let logger = null;

function initLogger() {
  logger = new DeploymentLogger();
  return logger;
}

function logStep(message) {
  if (logger) {
    const index = logger.addStep(message);
    logger.startStep(index);
  } else {
    console.log(`${colors.cyan}[STEP]${colors.reset} ${message}`);
  }
}

function logSuccess(message) {
  if (logger && logger.currentStepIndex >= 0) {
    logger.completeStep(logger.currentStepIndex, message);
  } else {
    console.log(`${colors.green}✓${colors.reset} ${message}`);
  }
}

function logError(message) {
  if (logger && logger.currentStepIndex >= 0) {
    logger.failStep(logger.currentStepIndex, message);
  } else {
    console.log(`${colors.red}✗${colors.reset} ${message}`);
  }
}

function logWarn(message) {
  if (logger && logger.currentStepIndex >= 0) {
    logger.warnStep(logger.currentStepIndex, message);
  } else {
    console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
  }
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
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
        R2_BUCKET_BINDING: config.bucketName,
        D1_DATABASE_BINDING: config.databaseName
      },
    _needsCloudflareSetup: config._needsCloudflareSetup,
    _environment: config._environment
  };
}

function generateWranglerConfig(config) {
  const wranglerConfig = {
    name: config.workerName,
    main: 'backend-cloudflare-workers/index.ts',
    compatibility_date: '2024-01-01',
    account_id: config.cloudflare.accountId,
    d1_databases: [{ binding: config.databaseName, database_name: config.databaseName }],
    r2_buckets: [{ binding: config.bucketName, bucket_name: config.bucketName }],
    observability: {
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: true,
        persist: true
      },
      traces: {
        enabled: false,
        head_sampling_rate: 1,
        persist: true
      }
    },
    placement: {
      mode: 'smart'
    }
  };

  // Add custom domain routes if configured
  if (config.workerCustomDomain) {
    const domains = Array.isArray(config.workerCustomDomain) 
      ? config.workerCustomDomain 
      : [config.workerCustomDomain];
    
    wranglerConfig.routes = domains.map(domain => ({
      pattern: domain,
      custom_domain: true
    }));
  }

  return wranglerConfig;
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
    return isNaN(date.getTime()) || date <= new Date();
  } catch {
    return true;
  }
}

async function setupCloudflare(env = null, preferredAccountId = null) {
  logWarn('Setting up Cloudflare credentials...');

  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  let token = origToken;
  let accountId = preferredAccountId || origAccountId;

  if (!token || !accountId) {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;

    const tokenInfo = getWranglerToken();
    
    if (!tokenInfo || isTokenExpired(tokenInfo.expirationTime)) {
      logStep('Token expired or missing, logging in...');
      const newTokenInfo = await loginWrangler();
      token = newTokenInfo.token;
    } else {
      const isValid = await validateCloudflareToken(tokenInfo.token);
      if (!isValid) {
        logStep('Token invalid, logging in...');
        const newTokenInfo = await loginWrangler();
        token = newTokenInfo.token;
      } else {
        token = tokenInfo.token;
      }
    }

    process.env.CLOUDFLARE_API_TOKEN = token;

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

  const tokenInfo = getWranglerToken();
  saveCloudflareCredentials(accountId, token, tokenInfo?.refreshToken || null, tokenInfo?.expirationTime || null, env);
  
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
        return { exists: false, created: true };
      }
      return { exists: true, created: false };
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
      return { exists: true, created: false };
    }
  },

  async ensureD1Database(cwd, databaseName) {
    try {
      const output = execSync('wrangler d1 list', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false });
      let exists = output && output.includes(databaseName);
      let created = false;

      if (!exists) {
        await runCommand(`wrangler d1 create ${databaseName}`, cwd);
        created = true;
        exists = true;
      }

      const schemaPath = path.join(cwd, 'backend-cloudflare-workers', 'schema.sql');
      let schemaApplied = false;
      if (fs.existsSync(schemaPath)) {
        try {
          await runCommand(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, cwd);
          schemaApplied = true;
        } catch (schemaError) {
          const errorMsg = schemaError.message || schemaError.error || '';
          if (!errorMsg.includes('already exists') && !errorMsg.includes('duplicate')) {
            throw schemaError;
          }
          schemaApplied = true;
        }
      }

      return { exists, created, schemaApplied };
    } catch (error) {
      const errorMsg = error.message || error.error || '';
      if (errorMsg.includes('already exists') || errorMsg.includes('name is already in use')) {
        return { exists: true, created: false, schemaApplied: false };
      }
      throw error;
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
  const useLogger = !progressCallback;
  if (useLogger) {
    logger = new DeploymentLogger();
    
    const DEPLOY_SECRETS = flags.DEPLOY_SECRETS !== false;
    const DEPLOY_DB = flags.DEPLOY_DB !== false;
    const DEPLOY_WORKER = flags.DEPLOY_WORKER !== false;
    const DEPLOY_PAGES = flags.DEPLOY_PAGES !== false;
    const DEPLOY_R2 = flags.DEPLOY_R2 !== false;
    const needsCloudflare = DEPLOY_SECRETS || DEPLOY_WORKER || DEPLOY_PAGES || DEPLOY_R2 || DEPLOY_DB;
    const needsGCP = DEPLOY_SECRETS || DEPLOY_WORKER;

    if (needsCloudflare || needsGCP) {
      logger.addStep('Checking prerequisites', 'Validating required tools');
    }
    if (needsGCP) {
      logger.addStep('Authenticating with GCP', 'Connecting to Google Cloud');
      logger.addStep('Checking GCP APIs', 'Verifying Vertex AI and Vision APIs');
    }
    if (needsCloudflare) {
      logger.addStep('Setting up Cloudflare credentials', 'Configuring Cloudflare access');
      if (DEPLOY_R2) {
        logger.addStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'Checking/creating R2 storage bucket');
      }
      if (DEPLOY_DB) {
        logger.addStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Checking/creating D1 database');
      }
      if (DEPLOY_SECRETS) {
        logger.addStep('Deploying secrets', 'Configuring environment secrets');
      }
      if (DEPLOY_WORKER) {
        logger.addStep('Deploying worker', 'Deploying Cloudflare Worker');
      }
      if (DEPLOY_PAGES) {
        logger.addStep('Deploying frontend', 'Deploying Cloudflare Pages');
      }
    }
    logger.render();
  }

  const report = progressCallback || ((step, status, details) => {
    if (!logger) return;
    const stepIndex = logger.findStep(step);
    if (stepIndex >= 0) {
      if (status === 'running') logger.startStep(stepIndex, details);
      else if (status === 'completed') logger.completeStep(stepIndex, details);
      else if (status === 'failed') logger.failStep(stepIndex, details);
      else if (status === 'warning') logger.warnStep(stepIndex, details);
    }
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
      if (DEPLOY_R2) {
        report(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'running', 'Checking bucket existence');
        const r2Result = await utils.ensureR2Bucket(cwd, config.bucketName);
        if (r2Result.created) {
          report(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'completed', 'Bucket created successfully');
        } else {
          report(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'completed', 'Bucket already exists');
        }
      }
      
      if (DEPLOY_DB) {
        report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'running', 'Checking database existence');
        const dbResult = await utils.ensureD1Database(cwd, config.databaseName);
        if (dbResult.created) {
          report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'running', 'Database created, applying schema');
          if (dbResult.schemaApplied) {
            report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'completed', 'Database created & schema applied');
          } else {
            report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'completed', 'Database created');
          }
        } else {
          if (dbResult.schemaApplied) {
            report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'completed', 'Database exists, schema verified');
          } else {
            report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'completed', 'Database already exists');
          }
        }
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

      if (useLogger && logger) {
        logger.renderSummary({ workerUrl, pagesUrl });
      } else {
        console.log('\n' + '='.repeat(50));
        console.log('✓ Deployment Complete!');
        console.log('\n📌 URLs:');
        if (workerUrl) console.log(`   ✅ Backend: ${workerUrl}`);
        if (pagesUrl) console.log(`   ✅ Frontend: ${pagesUrl}`);
        if (!workerUrl && !pagesUrl) console.log(`   ✅ Frontend: https://${config.pagesProjectName}.pages.dev/`);
        console.log('');
      }

      return { success: true, workerUrl, pagesUrl };
    } finally {
      restoreEnv(origToken, origAccountId);
    }
  } else {
    return { success: true, message: 'No deployment steps selected' };
  }
}

async function main() {
  logger = new DeploymentLogger();
  
  logger.addStep('Loading configuration', 'Reading deployment configuration');
  logger.render();

  try {
    logger.startStep('Loading configuration');
    const config = await loadConfig();
    logger.completeStep('Loading configuration', 'Configuration loaded');

    logger.addStep('Checking prerequisites', 'Validating required tools');
    logger.addStep('Authenticating with GCP', 'Connecting to Google Cloud');
    logger.addStep('Checking GCP APIs', 'Verifying Vertex AI and Vision APIs');
    logger.addStep('Setting up Cloudflare credentials', 'Configuring Cloudflare access');
    logger.addStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'Checking/creating R2 storage bucket');
    logger.addStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Checking/creating D1 database');
    logger.addStep('Deploying secrets', 'Configuring environment secrets');
    logger.addStep('Deploying worker', 'Deploying Cloudflare Worker');
    if (config.deployPages) {
      logger.addStep('Deploying frontend', 'Deploying Cloudflare Pages');
    }
    logger.render();

    logger.startStep('Checking prerequisites');
    if (!utils.checkWrangler()) {
      logger.failStep('Checking prerequisites', 'Wrangler CLI not found');
      process.exit(1);
    }
    if (!utils.checkGcloud()) {
      logger.failStep('Checking prerequisites', 'gcloud CLI not found');
      process.exit(1);
    }
    logger.completeStep('Checking prerequisites', 'Tools validated');

    logger.startStep('Authenticating with GCP');
    if (!await utils.authenticateGCP(config.gcp.serviceAccountKeyJson, config.gcp.projectId)) {
      logger.failStep('Authenticating with GCP', 'GCP authentication failed');
      process.exit(1);
    }
    logger.completeStep('Authenticating with GCP', 'GCP authenticated');

    logger.startStep('Checking GCP APIs');
    const apiResults = await utils.ensureGCPApis(config.gcp.projectId);
    if (apiResults.failed.length > 0) {
      const failedApis = apiResults.failed.map(f => f.api).join(', ');
      logger.warnStep('Checking GCP APIs', `Some APIs failed: ${failedApis}`);
    } else if (apiResults.newlyEnabled.length > 0) {
      logger.completeStep('Checking GCP APIs', `Enabled ${apiResults.newlyEnabled.length} API(s)`);
    } else {
      logger.completeStep('Checking GCP APIs', 'All required APIs are enabled');
    }

    logger.startStep('Setting up Cloudflare credentials');
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
    logger.completeStep('Setting up Cloudflare credentials', 'Cloudflare ready');

    const origToken = process.env.CLOUDFLARE_API_TOKEN;
    const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_API_TOKEN = cfToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;

    try {
      logger.startStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`);
      const r2Result = await utils.ensureR2Bucket(process.cwd(), config.bucketName);
      if (r2Result.created) {
        logger.completeStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'Bucket created successfully');
      } else {
        logger.completeStep(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'Bucket already exists');
      }

      logger.startStep(`[Cloudflare] D1 Database: ${config.databaseName}`);
      const dbResult = await utils.ensureD1Database(process.cwd(), config.databaseName);
      if (dbResult.created) {
        if (dbResult.schemaApplied) {
          logger.completeStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Database created & schema applied');
        } else {
          logger.completeStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Database created');
        }
      } else {
        if (dbResult.schemaApplied) {
          logger.completeStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Database exists, schema verified');
        } else {
          logger.completeStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Database already exists');
        }
      }

      logger.startStep('Deploying secrets');
      if (Object.keys(config.secrets).length > 0) {
        await utils.deploySecrets(config.secrets, process.cwd(), config.workerName);
        logger.completeStep('Deploying secrets', 'Secrets deployed');
      } else {
        const existing = utils.getExistingSecrets();
        const { missing, allSet } = checkSecrets(existing);
        if (!allSet) {
          logger.warnStep('Deploying secrets', `Missing secrets: ${missing.join(', ')}`);
        } else {
          logger.completeStep('Deploying secrets', 'All secrets set');
        }
      }

      logger.startStep('Deploying worker');
      const workerUrl = await utils.deployWorker(process.cwd(), config.workerName, config);
      logger.completeStep('Deploying worker', 'Worker deployed');

      let pagesUrl = '';
      if (config.deployPages) {
        logger.startStep('Deploying frontend');
        pagesUrl = await utils.deployPages(process.cwd(), config.pagesProjectName);
        logger.completeStep('Deploying frontend', 'Frontend deployed');
      } else {
        logger.skipStep('Deploying frontend', 'Skipped (deployPages disabled)');
      }

      logger.renderSummary({ workerUrl, pagesUrl: pagesUrl || `https://${config.pagesProjectName}.pages.dev/` });

    } finally {
      restoreEnv(origToken, origAccountId);
    }
  } catch (error) {
    if (logger && logger.currentStepIndex >= 0) {
      logger.failStep(logger.currentStepIndex, error.message);
    }
    if (logger) logger.renderSummary();
    process.exit(1);
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
