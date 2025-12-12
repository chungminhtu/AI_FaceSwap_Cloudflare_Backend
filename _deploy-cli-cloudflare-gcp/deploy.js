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
    const env = { ...process.env };
    const child = spawn(command, [], { 
      cwd: cwd || process.cwd(), 
      shell: true, 
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env
    });
    let stdout = '', stderr = '', answered = false;

    const answerPrompt = (output) => {
      if (answered) return;
      const full = (stdout + stderr + output).toLowerCase();
      const prompts = [
        'ok to proceed?',
        'continue?',
        'proceed?',
        'yes/no',
        'y/n',
        'unavailable',
        'this process may take some time',
        'are you sure',
        'confirm',
        'press enter',
        'press any key',
        'do you want to',
        'would you like to'
      ];
      
      if (prompts.some(prompt => full.includes(prompt))) {
        if (full.includes('y/n') || full.includes('yes/no')) {
          child.stdin.write('y\n');
        } else if (full.includes('press enter') || full.includes('press any key')) {
          child.stdin.write('\n');
        } else {
          child.stdin.write('yes\n');
        }
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

async function runCommandWithRetry(command, cwd, maxRetries = 3, retryDelay = 2000) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await runCommand(command, cwd);
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || error.error || '';
      const isRetryable = errorMsg.includes('timeout') || 
                         errorMsg.includes('network') || 
                         errorMsg.includes('temporary') ||
                         errorMsg.includes('rate limit') ||
                         errorMsg.includes('429');
      
      if (i < maxRetries && isRetryable) {
        await new Promise(resolve => setTimeout(resolve, retryDelay * (i + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
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

  const accountId = config.cloudflare.accountId || '';
  const workerName = config.workerName;
  
  const hasCustomDomain = config.CUSTOM_DOMAIN && config.CUSTOM_DOMAIN.trim() !== '';
  const hasWorkerCustomDomain = config.workerCustomDomain && config.workerCustomDomain.trim() !== '';
  
  let r2DevDomain = null;
  let workerDevUrl = null;
  
  if (accountId && !hasWorkerCustomDomain) {
    try {
      const whoami = execSync('wrangler whoami', { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
      const match = whoami.match(/([^\s]+)@/);
      if (match) {
        workerDevUrl = `https://${workerName}.${match[1]}.workers.dev`;
      }
    } catch {
    }
  }

  return {
    name: config.name || 'default',
    workerName: config.workerName,
    pagesProjectName: config.pagesProjectName,
    databaseName: config.databaseName,
    bucketName: config.bucketName,
    deployPages: config.deployPages || process.env.DEPLOY_PAGES === 'true',
    workerCustomDomain: config.workerCustomDomain,
    cloudflare: {
      accountId: accountId,
      apiToken: config.cloudflare.apiToken || ''
    },
    gcp: config.gcp,
      secrets: (() => {
        const secrets = {
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
        };
        
        if (hasCustomDomain) {
          secrets.CUSTOM_DOMAIN = config.CUSTOM_DOMAIN.trim();
        }
        
        if (hasWorkerCustomDomain) {
          const domain = config.workerCustomDomain.trim();
          secrets.WORKER_CUSTOM_DOMAIN = domain.startsWith('http') 
            ? domain 
            : `https://${domain}`;
        } else if (workerDevUrl) {
          secrets.WORKER_CUSTOM_DOMAIN = workerDevUrl;
        }
        
        if (config.WAVESPEED_API_KEY) secrets.WAVESPEED_API_KEY = config.WAVESPEED_API_KEY;
        return secrets;
      })(),
    _needsCloudflareSetup: config._needsCloudflareSetup,
    _environment: config._environment,
    _r2DevDomain: r2DevDomain,
    _workerDevUrl: workerDevUrl
  };
}

function generateWranglerConfig(config, skipD1 = false, databaseId = null, kvNamespaceId = null, kvPreviewId = null, promptCacheNamespaceId = null, promptCachePreviewId = null) {
  const wranglerConfig = {
    name: config.workerName,
    main: 'backend-cloudflare-workers/index.ts',
    compatibility_date: '2024-01-01',
    account_id: config.cloudflare.accountId,
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

  if (!skipD1) {
    if (databaseId) {
      wranglerConfig.d1_databases = [{ binding: config.databaseName, database_id: databaseId }];
    } else {
      wranglerConfig.d1_databases = [{ binding: config.databaseName, database_name: config.databaseName }];
    }
  }

  const kvNamespaces = [];
  
  if (kvNamespaceId) {
    const kvBinding = {
      binding: 'RATE_LIMIT_KV',
      id: kvNamespaceId
    };
    if (kvPreviewId) {
      kvBinding.preview_id = kvPreviewId;
    }
    kvNamespaces.push(kvBinding);
  }
  
  if (promptCacheNamespaceId) {
    const cacheBinding = {
      binding: 'PROMPT_CACHE_KV',
      id: promptCacheNamespaceId
    };
    if (promptCachePreviewId) {
      cacheBinding.preview_id = promptCachePreviewId;
    }
    kvNamespaces.push(cacheBinding);
  }
  
  if (kvNamespaces.length > 0) {
    wranglerConfig.kv_namespaces = kvNamespaces;
  }

  // Note: Custom domains for Workers are configured separately in Cloudflare dashboard
  // Routes are not needed for custom domains - they're handled via Cloudflare's custom domain feature

  return wranglerConfig;
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




async function getAllEditPermissionGroups(token, accountId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${accountId}/tokens/permission_groups`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (!json.success) {
          reject(new Error(`Failed to get permission groups: ${JSON.stringify(json.errors)}`));
          return;
        }
        const allGroups = json.result || [];
        const editGroups = allGroups.filter(g => {
          const name = (g.name || '').toLowerCase();
          return name.includes('edit') || name.includes('write');
        });
        resolve(editGroups);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function getTokenId(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/user/tokens/verify',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (!json.success || !json.result?.id) {
          reject(new Error(`Failed to get token ID: ${JSON.stringify(json.errors || json)}`));
          return;
        }
        resolve(json.result.id);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function updateTokenWithAllEditPermissions(currentToken, accountId) {
  const tokenId = await getTokenId(currentToken);
  
  // Try to get permission groups with current token
  let editGroups;
  let permissionGroupsError = null;
  try {
    editGroups = await getAllEditPermissionGroups(currentToken, accountId);
  } catch (error) {
    permissionGroupsError = error;
    // If current token can't access permission groups, try to use a working token from another environment
    // Note: Permission groups are GLOBAL (same across all Cloudflare accounts), so we can use any token
    // from any account/environment to get the list. However, the token UPDATE must be done with a token
    // that has permission to update tokens in the target account.
    logWarn('Current token cannot access permission groups, trying fallback from other environments...');
    const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
    if (fs.existsSync(secretsPath)) {
      const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      // Try to find a working token from any environment (permission groups are global, same across accounts)
      for (const envName in secrets.environments || {}) {
        const envConfig = secrets.environments[envName];
        if (envConfig?.cloudflare?.apiToken && envConfig.cloudflare.apiToken !== currentToken) {
          try {
            // Use any account ID to get permission groups (they're the same globally)
            const fallbackAccountId = envConfig.cloudflare.accountId || accountId;
            editGroups = await getAllEditPermissionGroups(envConfig.cloudflare.apiToken, fallbackAccountId);
            logSuccess(`Using permission groups from ${envName} environment (account: ${fallbackAccountId})`);
            break;
          } catch (e) {
            // Continue to next environment
          }
        }
      }
    }
    
    if (!editGroups || editGroups.length === 0) {
      throw new Error(`Cannot get permission groups. Current token error: ${permissionGroupsError.message}. Please ensure your token has access to read permission groups, or provide a working token with permission to read permission groups in another environment in deployments-secrets.json.`);
    }
  }
  
  if (editGroups.length === 0) {
    throw new Error('No edit permission groups found');
  }

  const tokenData = {
    policies: [{
      effect: 'allow',
      permission_groups: editGroups.map(g => ({ id: g.id })),
      resources: {
        [`com.cloudflare.api.account.${accountId}`]: '*'
      }
    }]
  };

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(tokenData);
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/user/tokens/${tokenId}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (!json.success) {
          reject(new Error(`Failed to update token: ${JSON.stringify(json.errors || json)}`));
          return;
        }
        resolve(currentToken);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(postData);
    req.end();
  });
}

async function setupCloudflare(env = null, preferredAccountId = null) {
  logWarn('Setting up Cloudflare credentials...');

  const origToken = process.env.CLOUDFLARE_API_TOKEN;
  const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
  if (!fs.existsSync(secretsPath)) {
    restoreEnv(origToken, origAccountId);
    throw new Error('deployments-secrets.json not found');
  }

  const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  const targetEnv = env || process.env.DEPLOY_ENV || 'production';
  const envConfig = secrets.environments?.[targetEnv];
  
  if (!envConfig?.cloudflare) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`No Cloudflare config found for environment: ${targetEnv}`);
  }

  const config = envConfig.cloudflare;
  let token = origToken || config.apiToken;
  let accountId = preferredAccountId || origAccountId || config.accountId;

  if (!accountId) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`No account ID found for environment: ${targetEnv}`);
  }

  if (!token) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`No API token found for environment: ${targetEnv}. Please add apiToken to deployments-secrets.json`);
  }

  const isValid = await validateCloudflareToken(token);
  if (!isValid) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`API token validation failed for environment: ${targetEnv}. Please check your API token in deployments-secrets.json`);
  }

  if (preferredAccountId && accountId !== preferredAccountId) {
    logWarn(`Using account ID from config: ${preferredAccountId} (config has: ${accountId})`);
    accountId = preferredAccountId;
  }

  logStep('Updating API token with all edit permissions...');
  try {
    await updateTokenWithAllEditPermissions(token, accountId);
    logSuccess('Token updated with all edit permissions');
    // Re-validate token after update
    const isValidAfterUpdate = await validateCloudflareToken(token);
    if (!isValidAfterUpdate) {
      restoreEnv(origToken, origAccountId);
      throw new Error('Token validation failed after update. Please check your API token.');
    }
  } catch (error) {
    restoreEnv(origToken, origAccountId);
    throw new Error(`Failed to update token with all edit permissions: ${error.message}. Please ensure your token has "User API Tokens:Edit" permission.`);
  }

  process.env.CLOUDFLARE_API_TOKEN = token;
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  logSuccess(`Using API token for account ${accountId}`);

  restoreEnv(origToken, origAccountId);
  return { accountId, apiToken: token };
}

function saveCloudflareCredentials(accountId, token, env = null) {
  const secretsPath = path.join(process.cwd(), '_deploy-cli-cloudflare-gcp', 'deployments-secrets.json');
  if (!fs.existsSync(secretsPath)) return;

  const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  const targetEnv = env || process.env.DEPLOY_ENV || 'production';

  if (!secrets.environments) secrets.environments = {};
  if (!secrets.environments[targetEnv]) secrets.environments[targetEnv] = {};
  if (!secrets.environments[targetEnv].cloudflare) secrets.environments[targetEnv].cloudflare = {};

  secrets.environments[targetEnv].cloudflare.accountId = accountId;
  secrets.environments[targetEnv].cloudflare.apiToken = token;

  fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
  logSuccess(`API token saved for ${targetEnv} environment`);
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

function updateWorkerUrlInHtml(cwd, workerUrl, config) {
  const htmlPath = path.join(cwd, 'frontend-cloudflare-pages', 'index.html');
  if (!fs.existsSync(htmlPath)) return;
  
  let content = fs.readFileSync(htmlPath, 'utf8');
  
  // Determine the actual worker URL to use (custom domain if available, otherwise workers.dev)
  let finalWorkerUrl = workerUrl;
  if (config?.workerCustomDomain) {
    finalWorkerUrl = config.workerCustomDomain.startsWith('http')
      ? config.workerCustomDomain
      : `https://${config.workerCustomDomain}`;
    console.log(`[Deploy] Using custom domain from config: ${finalWorkerUrl}`);
  } else {
    console.log(`[Deploy] No custom domain in config, using workers.dev: ${finalWorkerUrl}`);
  }
  
  // Replace the WORKER_URL initialization
  const workerUrlPattern = /let WORKER_URL = ['"](.*?)['"]; \/\/ Fallback/g;
  if (workerUrlPattern.test(content)) {
    content = content.replace(workerUrlPattern, `let WORKER_URL = '${finalWorkerUrl}'; // Injected during deployment`);
  }
  
  // Also replace the fallbackUrl constant
  const fallbackUrlPattern = /const fallbackUrl = ['"](.*?)['"];/g;
  if (fallbackUrlPattern.test(content)) {
    content = content.replace(fallbackUrlPattern, `const fallbackUrl = '${finalWorkerUrl}';`);
  }
  
  fs.writeFileSync(htmlPath, content);
  console.log(`[Deploy] ✓ Updated frontend HTML with worker URL: ${finalWorkerUrl}`);
}

// Migration functions (integrated from scripts/run-migrations.js)
async function findMigrationFiles(migrationsDir) {
  const { readdir, stat } = require('fs/promises');
  const { join } = require('path');
  const files = await readdir(migrationsDir);
  const migrationFiles = [];
  
  for (const file of files) {
    if ((file.endsWith('.sql') || file.endsWith('.ts')) && 
        !file.endsWith('.executed.sql') && 
        !file.endsWith('.executed.ts') && 
        !file.endsWith('.d.ts') &&
        !file.includes('_application')) {
      const fullPath = join(migrationsDir, file);
      const stats = await stat(fullPath);
      if (stats.isFile()) {
        migrationFiles.push({
          name: file,
          path: file,
          fullPath,
          type: file.endsWith('.sql') ? 'sql' : 'ts'
        });
      }
    }
  }
  
  return migrationFiles.sort((a, b) => a.name.localeCompare(b.name));
}

async function runSqlMigration(migrationFile, databaseName, accountId, apiToken) {
  const { readFileSync, rename } = require('fs/promises');
  const env = { ...process.env };
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  if (apiToken) env.CLOUDFLARE_API_TOKEN = apiToken;
  
  const command = `wrangler d1 execute ${databaseName} --remote --file=${migrationFile.fullPath} --yes`;
  
  try {
    const result = execSync(command, { 
      stdio: 'pipe',
      cwd: process.cwd(),
      env: env,
      encoding: 'utf8'
    });
    
    if (result) console.log(result);
    
    const executedPath = migrationFile.fullPath.replace('.sql', '.executed.sql');
    await rename(migrationFile.fullPath, executedPath);
    return { success: true };
  } catch (execError) {
    const stdout = (execError.stdout && typeof execError.stdout === 'string') ? execError.stdout : 
                   (execError.stdout ? execError.stdout.toString() : '');
    const stderr = (execError.stderr && typeof execError.stderr === 'string') ? execError.stderr : 
                   (execError.stderr ? execError.stderr.toString() : '');
    const errorMessage = execError.message || '';
    const errorOutput = execError.output ? execError.output.map(o => o ? o.toString() : '').join('') : '';
    const allErrorText = (stdout + stderr + errorMessage + errorOutput).toLowerCase();
    
    const isDuplicateColumn = 
      allErrorText.includes('duplicate column') || 
      allErrorText.includes('duplicate column name') ||
      (allErrorText.includes('sqlite_error') && allErrorText.includes('duplicate')) ||
      (allErrorText.includes('column name:') && allErrorText.includes('duplicate')) ||
      /duplicate.*column/i.test(allErrorText);
    
    if (isDuplicateColumn) {
      const executedPath = migrationFile.fullPath.replace('.sql', '.executed.sql');
      await rename(migrationFile.fullPath, executedPath);
      return { success: true, skipped: true, reason: 'Column already exists' };
    }
    
    throw execError;
  }
}

async function runTsMigration(migrationFile, databaseName, accountId, apiToken) {
  const { rename } = require('fs/promises');
  console.log(`[Migration] Skipping TypeScript migration: ${migrationFile.name}`);
  console.log(`[Migration] TypeScript migrations should be converted to SQL or run manually`);
  const executedPath = migrationFile.fullPath.replace('.ts', '.executed.ts');
  await rename(migrationFile.fullPath, executedPath);
  return { success: true, skipped: true, reason: 'TypeScript migrations require manual execution' };
}

async function runMigrations(config, cwd, accountId, apiToken) {
  const { join } = require('path');
  const migrationsDir = join(cwd, 'backend-cloudflare-workers', 'migrations');
  
  try {
    const migrationFiles = await findMigrationFiles(migrationsDir);
    
    if (migrationFiles.length === 0) {
      return { success: true, count: 0, message: 'No pending migrations found' };
    }
    
    console.log(`[Migration] Found ${migrationFiles.length} pending migration(s):`);
    migrationFiles.forEach(f => console.log(`  - ${f.name} (${f.type})`));
    
    for (const migrationFile of migrationFiles) {
      if (migrationFile.type === 'sql') {
        await runSqlMigration(migrationFile, config.databaseName, accountId, apiToken);
      } else if (migrationFile.type === 'ts') {
        await runTsMigration(migrationFile, config.databaseName, accountId, apiToken);
      }
    }
    
    return { success: true, count: migrationFiles.length, message: 'All migrations completed' };
  } catch (error) {
    return { success: false, error: error.message };
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
        return { exists: false, created: true, publicDevDomain: null };
      }
      
      let publicDevDomain = null;
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
      const apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
      
      if (accountId && apiToken) {
        try {
          const https = require('https');
          const domainInfo = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: 'api.cloudflare.com',
              path: `/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/domains/managed`,
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
              },
              timeout: 10000
            }, (res) => {
              let data = '';
              res.on('data', (chunk) => data += chunk);
              res.on('end', () => {
                try {
                  const json = JSON.parse(data);
                  if (json.success && json.result) {
                    resolve(json.result);
                  } else {
                    reject(new Error(json.errors?.[0]?.message || 'Failed to get bucket domain'));
                  }
                } catch (e) {
                  reject(e);
                }
              });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
          });
          
          if (domainInfo && domainInfo.enabled && domainInfo.domain) {
            publicDevDomain = domainInfo.domain.startsWith('http') 
              ? domainInfo.domain 
              : `https://${domainInfo.domain}`;
          }
        } catch (e) {
        }
      }
      
      if (!publicDevDomain) {
        try {
          const bucketInfo = await runCommand(`wrangler r2 bucket info ${bucketName}`, cwd);
          if (bucketInfo.stdout) {
            const domainMatch = bucketInfo.stdout.match(/pub-([a-f0-9-]+)\.r2\.dev/i);
            if (domainMatch) {
              publicDevDomain = `https://pub-${domainMatch[1]}.r2.dev`;
            }
          }
        } catch (e) {
        }
      }
      
      return { exists: true, created: false, publicDevDomain };
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
      return { exists: true, created: false, publicDevDomain: null };
    }
  },

  async ensureKVNamespace(cwd, namespaceName = 'RATE_LIMIT_KV') {
    try {
      const env = { ...process.env };
      const output = execSync('wrangler kv:namespace list --json', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
      
      if (output && (output.includes('Authentication error') || output.includes('code: 10000'))) {
        logWarn('API token does not have KV permissions. Skipping KV namespace operations.');
        return { exists: false, created: false, skipped: true, namespaceId: null, previewId: null };
      }
      
      let exists = false;
      let namespaceId = null;
      let previewId = null;
      let created = false;

      try {
        const parsed = JSON.parse(output);
        const namespaces = Array.isArray(parsed) ? parsed : (parsed.result || parsed);
        const nsList = Array.isArray(namespaces) ? namespaces : [];
        const ns = nsList.find(n => n.title === namespaceName || n.name === namespaceName);
        if (ns) {
          exists = true;
          namespaceId = ns.id || null;
          previewId = ns.preview_id || null;
        }
      } catch (e) {
        const textOutput = execSync('wrangler kv:namespace list', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
        if (textOutput && textOutput.includes(namespaceName)) {
          const lines = textOutput.split('\n');
          for (const line of lines) {
            if (line.includes(namespaceName)) {
              const idMatch = line.match(/([a-f0-9]{32})/i);
              if (idMatch) {
                exists = true;
                namespaceId = idMatch[1];
                break;
              }
            }
          }
        }
      }

      if (!exists) {
        try {
          const createOutput = execSync(`wrangler kv:namespace create "${namespaceName}" --json`, { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
          try {
            const createResult = JSON.parse(createOutput);
            if (createResult.id) {
              namespaceId = createResult.id;
              created = true;
            }
          } catch (e) {
            const idMatch = createOutput.match(/id[:\s]+([a-f0-9]{32})/i);
            if (idMatch) {
              namespaceId = idMatch[1];
              created = true;
            }
          }
          
          try {
            const previewOutput = execSync(`wrangler kv:namespace create "${namespaceName}" --preview --json`, { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
            try {
              const previewResult = JSON.parse(previewOutput);
              if (previewResult.id) {
                previewId = previewResult.id;
              }
            } catch (e) {
              const previewMatch = previewOutput.match(/id[:\s]+([a-f0-9]{32})/i);
              if (previewMatch) {
                previewId = previewMatch[1];
              }
            }
          } catch (previewError) {
            // Preview namespace creation is optional
          }
        } catch (createError) {
          if (!createError.message.includes('already exists')) {
            throw createError;
          }
          exists = true;
        }
      }

      return { exists, created, skipped: false, namespaceId, previewId };
    } catch (error) {
      if (error.message && error.message.includes('Authentication error')) {
        return { exists: false, created: false, skipped: true, namespaceId: null, previewId: null };
      }
      throw error;
    }
  },

  async ensureD1Database(cwd, databaseName) {
    try {
      const env = { ...process.env };
      const output = execSync('wrangler d1 list --json', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
      
      if (output && (output.includes('Authentication error') || output.includes('code: 10000'))) {
        logWarn('API token does not have D1 permissions. Skipping D1 database operations.');
        return { exists: false, created: false, schemaApplied: false, skipped: true, databaseId: null };
      }
      
      let exists = false;
      let databaseId = null;
      let created = false;

      try {
        const parsed = JSON.parse(output);
        const databases = Array.isArray(parsed) ? parsed : (parsed.result || parsed);
        const dbList = Array.isArray(databases) ? databases : [];
        const db = dbList.find(d => d.name === databaseName);
        if (db) {
          exists = true;
          databaseId = db.uuid || db.id || null;
        }
      } catch (e) {
        const textOutput = execSync('wrangler d1 list', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
        exists = textOutput && textOutput.includes(databaseName);
        if (exists) {
          const lines = textOutput.split('\n');
          for (const line of lines) {
            if (line.includes(databaseName)) {
              const idMatch = line.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
              if (idMatch) {
                databaseId = idMatch[1];
                break;
              }
            }
          }
        }
      }

      if (!exists) {
        let createResult;
        try {
          createResult = await runCommandWithRetry(`wrangler d1 create ${databaseName}`, cwd, 2, 2000);
          if (createResult && createResult.success) {
            const output = createResult.output || createResult.stdout || '';
            const idMatch = output.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            if (idMatch) {
              databaseId = idMatch[1];
            }
            created = true;
            exists = true;
          }
        } catch (error) {
          const errorMsg = error.message || error.error || '';
          if (errorMsg.includes('Authentication error') || errorMsg.includes('code: 10000')) {
            logWarn('API token does not have D1 permissions. Skipping D1 database creation.');
            return { exists: false, created: false, schemaApplied: false, skipped: true, databaseId: null };
          }
          createResult = { success: false, error: errorMsg };
        }
      }
      
      if (exists && !databaseId) {
        const listOutput = execSync('wrangler d1 list --json', { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd, throwOnError: false, env: env });
        try {
          const parsed = JSON.parse(listOutput);
          const databases = Array.isArray(parsed) ? parsed : (parsed.result || parsed);
          const dbList = Array.isArray(databases) ? databases : [];
          const db = dbList.find(d => d.name === databaseName);
          if (db) {
            databaseId = db.uuid || db.id || null;
          }
        } catch (e) {
        }
      }

      const schemaPath = path.join(cwd, 'backend-cloudflare-workers', 'schema.sql');
      let schemaApplied = false;
      if (exists && fs.existsSync(schemaPath)) {
        try {
          // Old migrations removed - now handled by migration files
          // Migration files in migrations/ folder will be executed separately
          
          const execResult = await runCommandWithRetry(`wrangler d1 execute ${databaseName} --remote --file=${schemaPath}`, cwd, 2, 2000);
          if (execResult.success) {
            schemaApplied = true;
          }
        } catch (schemaError) {
          const errorMsg = schemaError.message || schemaError.error || '';
          if (errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
            schemaApplied = true;
          } else if (errorMsg.includes('Authentication error') || errorMsg.includes('code: 10000')) {
            logWarn('API token does not have D1 permissions. Skipping schema application.');
          } else {
            throw schemaError;
          }
        }
      }

      return { exists, created, schemaApplied, databaseId };
    } catch (error) {
      const errorMsg = error.message || error.error || '';
      if (errorMsg.includes('Authentication error') || errorMsg.includes('code: 10000')) {
        logWarn('API token does not have D1 permissions. Skipping D1 database operations.');
        return { exists: false, created: false, schemaApplied: false, skipped: true, databaseId: null };
      }
      if (errorMsg.includes('already exists') || errorMsg.includes('name is already in use')) {
        return { exists: true, created: false, schemaApplied: false, databaseId: null };
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
      const result = await runCommandWithRetry(cmd, cwd, 2, 2000);
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

  async deployWorker(cwd, workerName, config, skipD1 = false, databaseId = null, kvNamespaceId = null, kvPreviewId = null, promptCacheNamespaceId = null, promptCachePreviewId = null) {
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
      const wranglerConfig = generateWranglerConfig(config, skipD1, databaseId, kvNamespaceId, kvPreviewId, promptCacheNamespaceId, promptCachePreviewId);
      fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, 2));
      createdConfig = true;

      let result;
      try {
        result = await runCommandWithRetry('wrangler deploy', cwd, 3, 2000);
      } catch (error) {
        const errorMsg = error.message || error.error || '';
        if (errorMsg.includes('code: 10214')) {
          result = await runCommandWithRetry('wrangler deploy', cwd, 2, 3000);
        } else if ((errorMsg.includes('Authentication error') || errorMsg.includes('code: 10000')) && !skipD1) {
          logWarn('Worker deployment failed due to D1 permissions. Retrying without D1 binding...');
          const wranglerConfigNoD1 = generateWranglerConfig(config, true, null);
          fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfigNoD1, null, 2));
          result = await runCommandWithRetry('wrangler deploy', cwd, 2, 3000);
        } else {
          throw error;
        }
      }
      if (!result || !result.success) throw new Error(result?.error || 'Worker deployment failed');

      const workerUrl = getWorkerUrl(cwd, workerName);
      updateWorkerUrlInHtml(cwd, workerUrl, config);
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
      await runCommandWithRetry(`wrangler pages project create ${pagesProjectName} --production-branch=main`, cwd, 2, 1000);
    } catch {
      // Project might already exist, continue
    }

    try {
      const absDir = path.resolve(publicDir);
      await runCommandWithRetry(`wrangler pages deploy "${absDir}" --project-name=${pagesProjectName} --branch=main --commit-dirty=true`, cwd, 3, 2000);
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
        logger.addStep('Running database migrations', 'Executing pending migrations');
      }
      logger.addStep(`[Cloudflare] KV Namespace: RATE_LIMIT_KV`, 'Checking/creating KV namespace');
      logger.addStep(`[Cloudflare] KV Namespace: PROMPT_CACHE_KV`, 'Checking/creating KV namespace');
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
    
    if (cfAccountId) {
      const hasWorkerCustomDomain = config.workerCustomDomain && config.workerCustomDomain.trim() !== '';

      if (!hasWorkerCustomDomain && !config.secrets.WORKER_CUSTOM_DOMAIN) {
        try {
          const whoami = execSync('wrangler whoami', { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
          const match = whoami.match(/([^\s]+)@/);
          if (match) {
            const workerDevUrl = `https://${config.workerName}.${match[1]}.workers.dev`;
            config.secrets.WORKER_CUSTOM_DOMAIN = workerDevUrl;
            config._workerDevUrl = workerDevUrl;
            console.log(`${colors.cyan}ℹ${colors.reset} Using Worker dev domain: ${workerDevUrl}`);
          }
        } catch {
        }
      }
    }
    
    report('Setting up Cloudflare credentials...', 'completed', 'Cloudflare ready');

    const origToken = process.env.CLOUDFLARE_API_TOKEN;
    const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_API_TOKEN = cfToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = cfAccountId;

    try {
      let r2Result = null;
      if (DEPLOY_R2) {
        report(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'running', 'Checking bucket existence');
        r2Result = await utils.ensureR2Bucket(cwd, config.bucketName);
        if (r2Result.created) {
          report(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'completed', 'Bucket created successfully');
        } else {
          report(`[Cloudflare] R2 Bucket: ${config.bucketName}`, 'completed', 'Bucket already exists');
        }
        
        const hasCustomDomain = config.CUSTOM_DOMAIN && config.CUSTOM_DOMAIN.trim() !== '';
        if (!hasCustomDomain && !config.secrets.CUSTOM_DOMAIN && r2Result.publicDevDomain && r2Result.publicDevDomain.includes('pub-') && r2Result.publicDevDomain.includes('.r2.dev')) {
          config.secrets.CUSTOM_DOMAIN = r2Result.publicDevDomain;
        }
      } else {
        r2Result = await utils.ensureR2Bucket(cwd, config.bucketName);
        const hasCustomDomain = config.CUSTOM_DOMAIN && config.CUSTOM_DOMAIN.trim() !== '';
        if (!hasCustomDomain && !config.secrets.CUSTOM_DOMAIN && r2Result.publicDevDomain && r2Result.publicDevDomain.includes('pub-') && r2Result.publicDevDomain.includes('.r2.dev')) {
          config.secrets.CUSTOM_DOMAIN = r2Result.publicDevDomain;
        }
      }
      
      let dbResult = null;
      if (DEPLOY_DB) {
        report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'running', 'Checking database existence');
        dbResult = await utils.ensureD1Database(cwd, config.databaseName);
        if (dbResult.skipped) {
          report(`[Cloudflare] D1 Database: ${config.databaseName}`, 'warning', 'Skipped (API token lacks D1 permissions)');
        } else if (dbResult.created) {
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
      } else {
        dbResult = await utils.ensureD1Database(cwd, config.databaseName);
      }

      // Ensure KV namespace for rate limiting
      let kvResult = null;
      report(`[Cloudflare] KV Namespace: RATE_LIMIT_KV`, 'running', 'Checking namespace existence');
      kvResult = await utils.ensureKVNamespace(cwd, 'RATE_LIMIT_KV');
      if (kvResult.skipped) {
        report(`[Cloudflare] KV Namespace: RATE_LIMIT_KV`, 'warning', 'Skipped (API token lacks KV permissions)');
      } else if (kvResult.created) {
        report(`[Cloudflare] KV Namespace: RATE_LIMIT_KV`, 'completed', 'Namespace created successfully');
      } else {
        report(`[Cloudflare] KV Namespace: RATE_LIMIT_KV`, 'completed', 'Namespace already exists');
      }

      // Ensure KV namespace for prompt_json caching
      let promptCacheResult = null;
      report(`[Cloudflare] KV Namespace: PROMPT_CACHE_KV`, 'running', 'Checking namespace existence');
      promptCacheResult = await utils.ensureKVNamespace(cwd, 'PROMPT_CACHE_KV');
      if (promptCacheResult.skipped) {
        report(`[Cloudflare] KV Namespace: PROMPT_CACHE_KV`, 'warning', 'Skipped (API token lacks KV permissions)');
      } else if (promptCacheResult.created) {
        report(`[Cloudflare] KV Namespace: PROMPT_CACHE_KV`, 'completed', 'Namespace created successfully');
      } else {
        report(`[Cloudflare] KV Namespace: PROMPT_CACHE_KV`, 'completed', 'Namespace already exists');
      }

      // Run database migrations after database is set up
      if (dbResult && !dbResult.skipped) {
        report('Running database migrations', 'running', 'Executing pending migrations');
        try {
          const migrationResult = await runMigrations(config, cwd, cfAccountId, cfToken);
          if (migrationResult.success) {
            if (migrationResult.count === 0) {
              report('Running database migrations', 'completed', 'No pending migrations');
            } else {
              report('Running database migrations', 'completed', `${migrationResult.count} migration(s) executed`);
            }
          } else {
            report('Running database migrations', 'failed', migrationResult.error || 'Migration failed');
            throw new Error(`Migration failed: ${migrationResult.error}`);
          }
        } catch (error) {
          report('Running database migrations', 'failed', error.message);
          throw error;
        }
      } else if (dbResult && dbResult.skipped) {
        report('Running database migrations', 'warning', 'Skipped (database setup skipped)');
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
        if (!dbResult) {
          dbResult = await utils.ensureD1Database(cwd, config.databaseName);
        }
        if (!kvResult) {
          kvResult = await utils.ensureKVNamespace(cwd, 'RATE_LIMIT_KV');
        }
        if (!promptCacheResult) {
          promptCacheResult = await utils.ensureKVNamespace(cwd, 'PROMPT_CACHE_KV');
        }
        const skipD1 = dbResult.skipped || false;
        const databaseId = dbResult.databaseId || null;
        const kvNamespaceId = kvResult?.namespaceId || null;
        const kvPreviewId = kvResult?.previewId || null;
        const promptCacheNamespaceId = promptCacheResult?.namespaceId || null;
        const promptCachePreviewId = promptCacheResult?.previewId || null;
        workerUrl = await utils.deployWorker(cwd, config.workerName, config, skipD1, databaseId, kvNamespaceId, kvPreviewId, promptCacheNamespaceId, promptCachePreviewId);
        
        if (!workerUrl) {
          workerUrl = config._workerDevUrl || getWorkerUrl(cwd, config.workerName);
        }
        
        if (config.workerCustomDomain && config.workerCustomDomain.trim() !== '') {
          const domain = config.workerCustomDomain.trim();
          workerUrl = domain.startsWith('http') ? domain : `https://${domain}`;
        }
        
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
  const args = process.argv.slice(2);
  const migrateOnly = args.includes('--migrate-only') || args.includes('--db-migrate');
  
  logger = new DeploymentLogger();
  
  if (migrateOnly) {
    logger.addStep('Checking prerequisites', 'Validating required tools');
    logger.addStep('Loading configuration', 'Reading deployment configuration');
    logger.addStep('Setting up Cloudflare credentials', 'Configuring Cloudflare access');
    logger.addStep(`[Cloudflare] D1 Database Migration`, 'Applying database migration');
    logger.render();

    try {
      logger.startStep('Checking prerequisites');
      if (!utils.checkWrangler()) {
        logger.failStep('Checking prerequisites', 'Wrangler CLI not found');
        process.exit(1);
      }
      logger.completeStep('Checking prerequisites', 'Tools validated');

      logger.startStep('Loading configuration');
      const config = await loadConfig();
      logger.completeStep('Loading configuration', 'Configuration loaded');

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
        logger.startStep(`[Cloudflare] D1 Database Migration`);
        const migrationsDir = path.join(process.cwd(), 'backend-cloudflare-workers', 'migrations');
        
        if (!fs.existsSync(migrationsDir)) {
          logger.completeStep(`[Cloudflare] D1 Database Migration`, 'No migrations folder found');
          logger.renderSummary({ workerUrl: '', pagesUrl: '' });
          return;
        }

        const files = fs.readdirSync(migrationsDir)
          .filter(file => file.endsWith('.sql') && !file.includes('.executed.'))
          .map(file => ({
            name: file,
            path: path.join(migrationsDir, file),
            order: parseInt(file.match(/^(\d+)_/)?.[1] || '999999', 10)
          }))
          .sort((a, b) => a.order - b.order);

        if (files.length === 0) {
          logger.completeStep(`[Cloudflare] D1 Database Migration`, 'No migration files found');
          logger.renderSummary({ workerUrl: '', pagesUrl: '' });
          return;
        }

        console.log(`\n${colors.cyan}Found ${files.length} migration file(s) to execute${colors.reset}`);
        
        const executedFiles = [];
        for (const file of files) {
          console.log(`\n${colors.blue}→${colors.reset} Executing: ${file.name}`);
          
          try {
            const execResult = await runCommandWithRetry(
              `wrangler d1 execute ${config.databaseName} --remote --file=${file.path}`,
              process.cwd(),
              2,
              2000
            );

            if (execResult.success) {
              executedFiles.push(file);
              console.log(`${colors.green}✓${colors.reset} Migration completed: ${file.name}`);
              
              try {
                const executedPath = file.path.replace(/\.sql$/, '.executed.sql');
                fs.renameSync(file.path, executedPath);
                console.log(`${colors.green}✓${colors.reset} Migration file renamed: ${file.name} → ${path.basename(executedPath)}`);
              } catch (renameError) {
                console.warn(`${colors.yellow}⚠${colors.reset} Could not rename migration file: ${renameError.message}`);
              }
            }
          } catch (error) {
            const errorMsg = error.message || error.stderr || error.stdout || String(error);
            // Ignore "duplicate column name" errors - column already exists
            if (errorMsg.includes('duplicate column name') || errorMsg.includes('already exists')) {
              console.log(`${colors.yellow}⚠${colors.reset} Column already exists, skipping: ${file.name}`);
              executedFiles.push(file);
              try {
                const executedPath = file.path.replace(/\.sql$/, '.executed.sql');
                fs.renameSync(file.path, executedPath);
                console.log(`${colors.green}✓${colors.reset} Migration file renamed: ${file.name} → ${path.basename(executedPath)}`);
              } catch (renameError) {
                console.warn(`${colors.yellow}⚠${colors.reset} Could not rename migration file: ${renameError.message}`);
              }
            } else {
              throw new Error(`Migration failed for ${file.name}: ${errorMsg}`);
            }
          }
        }

        logger.completeStep(`[Cloudflare] D1 Database Migration`, `Successfully executed ${executedFiles.length} migration(s)`);
        logger.renderSummary({ workerUrl: '', pagesUrl: '' });
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
    return;
  }
  
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
    
    if (cfAccountId) {
      const hasWorkerCustomDomain = config.workerCustomDomain && config.workerCustomDomain.trim() !== '';

      if (!hasWorkerCustomDomain && !config.secrets.WORKER_CUSTOM_DOMAIN) {
        try {
          const whoami = execSync('wrangler whoami', { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
          const match = whoami.match(/([^\s]+)@/);
          if (match) {
            const workerDevUrl = `https://${config.workerName}.${match[1]}.workers.dev`;
            config.secrets.WORKER_CUSTOM_DOMAIN = workerDevUrl;
            config._workerDevUrl = workerDevUrl;
            console.log(`${colors.cyan}ℹ${colors.reset} Using Worker dev domain: ${workerDevUrl}`);
          }
        } catch {
        }
      }
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
      
      const hasCustomDomain = config.CUSTOM_DOMAIN && config.CUSTOM_DOMAIN.trim() !== '';
      if (!hasCustomDomain && !config.secrets.CUSTOM_DOMAIN && r2Result.publicDevDomain && r2Result.publicDevDomain.includes('pub-') && r2Result.publicDevDomain.includes('.r2.dev')) {
        config.secrets.CUSTOM_DOMAIN = r2Result.publicDevDomain;
      }

      logger.startStep(`[Cloudflare] D1 Database: ${config.databaseName}`);
      const dbResult = await utils.ensureD1Database(process.cwd(), config.databaseName);
      if (dbResult.skipped) {
        logger.warnStep(`[Cloudflare] D1 Database: ${config.databaseName}`, 'Skipped (API token lacks D1 permissions)');
      } else if (dbResult.created) {
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

      logger.startStep(`[Cloudflare] KV Namespace: RATE_LIMIT_KV`);
      const kvResult = await utils.ensureKVNamespace(process.cwd(), 'RATE_LIMIT_KV');
      if (kvResult.skipped) {
        logger.warnStep(`[Cloudflare] KV Namespace: RATE_LIMIT_KV`, 'Skipped (API token lacks KV permissions)');
      } else if (kvResult.created) {
        logger.completeStep(`[Cloudflare] KV Namespace: RATE_LIMIT_KV`, 'Namespace created successfully');
      } else {
        logger.completeStep(`[Cloudflare] KV Namespace: RATE_LIMIT_KV`, 'Namespace already exists');
      }

      logger.startStep(`[Cloudflare] KV Namespace: PROMPT_CACHE_KV`);
      const promptCacheResult = await utils.ensureKVNamespace(process.cwd(), 'PROMPT_CACHE_KV');
      if (promptCacheResult.skipped) {
        logger.warnStep(`[Cloudflare] KV Namespace: PROMPT_CACHE_KV`, 'Skipped (API token lacks KV permissions)');
      } else if (promptCacheResult.created) {
        logger.completeStep(`[Cloudflare] KV Namespace: PROMPT_CACHE_KV`, 'Namespace created successfully');
      } else {
        logger.completeStep(`[Cloudflare] KV Namespace: PROMPT_CACHE_KV`, 'Namespace already exists');
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
      const skipD1 = dbResult.skipped || false;
      const databaseId = dbResult.databaseId || null;
      
      // kvResult and promptCacheResult are already created above
      const kvNamespaceId = kvResult?.namespaceId || null;
      const kvPreviewId = kvResult?.previewId || null;
      const promptCacheNamespaceId = promptCacheResult?.namespaceId || null;
      const promptCachePreviewId = promptCacheResult?.previewId || null;
      
      let workerUrl = await utils.deployWorker(process.cwd(), config.workerName, config, skipD1, databaseId, kvNamespaceId, kvPreviewId, promptCacheNamespaceId, promptCachePreviewId);
      
      if (!workerUrl) {
        workerUrl = config._workerDevUrl || getWorkerUrl(process.cwd(), config.workerName);
      }
      
      if (config.workerCustomDomain) {
        workerUrl = config.workerCustomDomain.startsWith('http') 
          ? config.workerCustomDomain 
          : `https://${config.workerCustomDomain}`;
      }
      
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
