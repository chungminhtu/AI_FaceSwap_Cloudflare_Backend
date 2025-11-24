#!/usr/bin/env node

const { execSync } = require('child_process');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
};

async function main() {
  console.log('\n🔧 Complete Setup - Final Step');
  console.log('================================\n');

  log.info('Setting up Application Default Credentials...');
  log.warn('This will open your browser for authentication');
  log.warn('Complete the authentication in your browser');

  try {
    execSync('gcloud auth application-default login', {
      stdio: 'inherit',
      timeout: 300000 // 5 minutes timeout
    });

    log.success('Application Default Credentials configured!');
    log.success('🎉 Setup complete! Your deployment system should now work fully automatically.');

  } catch (error) {
    log.warn('Application Default Credentials setup was cancelled or failed');
    log.info('You can run this manually later: gcloud auth application-default login');
    log.info('The deployment will still work, but some GCP features may require manual auth');
  }
}

main().catch((error) => {
  log.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
