#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
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

async function main() {
  console.log('\n🔧 GCP Authentication Fix');
  console.log('=========================\n');

  try {
    // Check current auth status
    log.info('Checking current GCP authentication...');
    const authList = execSync('gcloud auth list --format="value(account)"', {
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim().split('\n').filter(Boolean);

    if (authList.length > 0) {
      log.success(`Found authenticated accounts: ${authList.join(', ')}`);

      // Check active account
      const activeAccount = execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();

      if (activeAccount) {
        log.success(`Active account: ${activeAccount}`);

        // Check current project
        const currentProject = execSync('gcloud config get-value project', {
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim();

        if (currentProject) {
          log.success(`Current project: ${currentProject}`);

          if (currentProject === 'ai-photo-office') {
            log.success('GCP is properly configured!');

            // Try to refresh tokens
            log.info('Refreshing authentication tokens...');
            try {
              execSync('gcloud auth application-default login --no-launch-browser --quiet', {
                stdio: 'inherit',
                timeout: 30000
              });
              log.success('Authentication tokens refreshed!');
              return;
            } catch (refreshError) {
              log.warn('Token refresh failed - trying alternative method...');
            }
          } else {
            // Set project
            log.info('Setting project to ai-photo-office...');
            execSync('gcloud config set project ai-photo-office', {
              stdio: 'inherit'
            });
            log.success('Project set to ai-photo-office');
          }
        } else {
          log.info('Setting project to ai-photo-office...');
          execSync('gcloud config set project ai-photo-office', {
            stdio: 'inherit'
          });
          log.success('Project set to ai-photo-office');
        }
      } else {
        // Set active account
        log.info('Setting active account...');
        execSync(`gcloud config set account ${authList[0]}`, {
          stdio: 'inherit'
        });
        log.success(`Active account set to: ${authList[0]}`);

        // Set project
        execSync('gcloud config set project ai-photo-office', {
          stdio: 'inherit'
        });
        log.success('Project set to ai-photo-office');
      }
    } else {
      log.warn('No authenticated accounts found. Starting login process...');

      // Start interactive login
      const gcloudProcess = spawn('gcloud', ['auth', 'login'], {
        stdio: 'inherit'
      });

      return new Promise((resolve, reject) => {
        gcloudProcess.on('close', (code) => {
          if (code === 0) {
            log.success('GCP login successful!');

            // Set project after login
            execSync('gcloud config set project ai-photo-office', {
              stdio: 'inherit'
            });
            log.success('Project set to ai-photo-office');
            resolve();
          } else {
            reject(new Error(`GCP login failed with code ${code}`));
          }
        });

        gcloudProcess.on('error', (error) => {
          reject(new Error(`Failed to start GCP login: ${error.message}`));
        });
      });
    }

  } catch (error) {
    log.error(`GCP authentication fix failed: ${error.message}`);
    log.info('Please run: gcloud auth login');
    log.info('Then run: gcloud config set project ai-photo-office');
    process.exit(1);
  }
}

main().catch((error) => {
  log.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
