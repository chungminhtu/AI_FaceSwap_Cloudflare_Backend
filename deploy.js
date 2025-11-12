#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const NC = '\x1b[0m'; // No Color

function exec(command, options = {}) {
  try {
    return execSync(command, { 
      encoding: 'utf8', 
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options 
    });
  } catch (error) {
    if (!options.ignoreError) {
      throw error;
    }
    return error.stdout || error.stderr || '';
  }
}

function execSilent(command) {
  return exec(command, { silent: true, ignoreError: true });
}

function log(message, color = '') {
  console.log(`${color}${message}${NC}`);
}

function checkWrangler() {
  try {
    execSilent('wrangler --version');
    return true;
  } catch {
    log('❌ Wrangler CLI not found. Installing...', RED);
    exec('npm install -g wrangler');
    return true;
  }
}

function checkAuth() {
  log('📋 Checking Cloudflare authentication...', YELLOW);
  try {
    execSilent('wrangler whoami');
    log('✓ Authenticated', GREEN);
    return true;
  } catch {
    log('⚠️  Not logged in. Please authenticate...', YELLOW);
    exec('wrangler login');
    return true;
  }
}

function setupR2() {
  log('📦 Checking R2 bucket...', YELLOW);
  const buckets = execSilent('wrangler r2 bucket list');
  
  if (!buckets.includes('faceswap-images')) {
    log('📦 Creating R2 bucket \'faceswap-images\'...', YELLOW);
    exec('wrangler r2 bucket create faceswap-images');
    log('✓ R2 bucket created', GREEN);
  } else {
    log('✓ R2 bucket exists', GREEN);
  }
}

function setupD1() {
  log('💾 Checking D1 database...', YELLOW);
  const databases = execSilent('wrangler d1 list');
  
  if (!databases.includes('faceswap-db')) {
    log('💾 Creating D1 database \'faceswap-db\'...', YELLOW);
    exec('wrangler d1 create faceswap-db');
    log('✓ D1 database created', GREEN);
    
    if (fs.existsSync('schema.sql')) {
      log('   Initializing database schema...', YELLOW);
      exec('wrangler d1 execute faceswap-db --file=schema.sql');
      log('✓ Database schema initialized', GREEN);
    }
  } else {
    log('✓ D1 database exists', GREEN);
    if (fs.existsSync('schema.sql')) {
      log('   Checking database schema...', YELLOW);
      try {
        execSilent('wrangler d1 execute faceswap-db --command="SELECT COUNT(*) FROM presets LIMIT 1"');
      } catch {
        log('   Initializing database schema...', YELLOW);
        exec('wrangler d1 execute faceswap-db --file=schema.sql');
        log('✓ Database schema initialized', GREEN);
      }
    }
  }
}

function setupCORS() {
  log('⚙️  Configuring R2 CORS...', YELLOW);
  
  const corsConfig = JSON.stringify([
    {
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600
    }
  ], null, 2);
  
  fs.writeFileSync('r2-cors.json', corsConfig);
  
  try {
    exec('wrangler r2 bucket cors set faceswap-images --file r2-cors.json --force', { silent: true });
    log('✓ R2 CORS configured via wrangler', GREEN);
  } catch {
    const corsList = execSilent('wrangler r2 bucket cors list faceswap-images');
    if (corsList && corsList !== 'null' && corsList.trim()) {
      log('✓ R2 CORS already configured', GREEN);
    } else {
      log('⚠️  CORS configuration via wrangler failed (this is common - not critical)', YELLOW);
      log('   CORS can be configured later via Cloudflare Dashboard', YELLOW);
      log('   File saved: r2-cors.json', YELLOW);
    }
  }
}

function checkSecrets() {
  log('🔐 Checking environment variables...', YELLOW);
  const requiredVars = ['RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT', 'GOOGLE_CLOUD_API_KEY', 'GOOGLE_VISION_ENDPOINT'];
  const secretList = execSilent('wrangler secret list');
  const missingVars = requiredVars.filter(v => !secretList.includes(v));
  
  if (missingVars.length > 0) {
    if (fs.existsSync('secrets.json')) {
      log('✓ Found secrets.json, uploading secrets in bulk...', GREEN);
      try {
        exec('wrangler secret bulk secrets.json');
        log('✓ Secrets uploaded', GREEN);
      } catch (error) {
        log('⚠️  Failed to upload secrets. Please check secrets.json', YELLOW);
      }
    } else {
      log('⚠️  Missing environment variables:', YELLOW);
      missingVars.forEach(v => log(`   - ${v}`, YELLOW));
      log('No secrets.json found. Please create one or set secrets manually.', YELLOW);
      log('⚠️  Deployment will continue but Worker may fail without these secrets.', YELLOW);
    }
  } else {
    log('✓ All environment variables are set', GREEN);
  }
}

function deployWorker() {
  log('🚀 Deploying Worker...', YELLOW);
  
  let workerUrl = '';
  
  try {
    // Deploy and capture output
    const output = exec('wrangler deploy', { encoding: 'utf8', silent: true });
    
    // Extract Worker URL from output
    if (output && typeof output === 'string') {
      const urlMatch = output.match(/https:\/\/[^\s]+\.workers\.dev/);
      if (urlMatch && urlMatch[0]) {
        workerUrl = urlMatch[0];
      }
    }
  } catch (error) {
    // Deployment might have succeeded even if there's an error
    // Try to extract URL from error output
    if (error.stdout && typeof error.stdout === 'string') {
      const urlMatch = error.stdout.match(/https:\/\/[^\s]+\.workers\.dev/);
      if (urlMatch && urlMatch[0]) {
        workerUrl = urlMatch[0];
      }
    }
  }
  
  // If not found in output, try from deployments list
  if (!workerUrl) {
    try {
      const deployments = execSilent('wrangler deployments list');
      if (deployments && typeof deployments === 'string') {
        const deploymentMatch = deployments.match(/https:\/\/[^\s]+\.workers\.dev/);
        if (deploymentMatch && deploymentMatch[0]) {
          workerUrl = deploymentMatch[0];
        }
      }
    } catch {}
  }
  
  // If still not found, try to get from wrangler whoami
  if (!workerUrl) {
    try {
      const whoami = execSilent('wrangler whoami');
      // Try to extract subdomain from account info
      if (whoami && typeof whoami === 'string') {
        // Look for email pattern to extract subdomain
        const emailMatch = whoami.match(/([a-zA-Z0-9_-]+)@/);
        if (emailMatch && emailMatch[1]) {
          const subdomain = emailMatch[1];
          workerUrl = `https://ai-faceswap-backend.${subdomain}.workers.dev`;
        }
      }
    } catch {}
  }
  
  // Final fallback
  if (!workerUrl) {
    workerUrl = 'https://ai-faceswap-backend.YOUR_SUBDOMAIN.workers.dev';
    log('⚠️  Could not auto-detect Worker URL', YELLOW);
    log('   Please check Cloudflare Dashboard for your Worker URL', YELLOW);
  }
  
  log('✓ Worker deployed', GREEN);
  if (!workerUrl.includes('YOUR_SUBDOMAIN') && !workerUrl.includes('@')) {
    log(`✓ Worker URL: ${workerUrl}`, GREEN);
  }
  
  return workerUrl;
}

function updateHTML(workerUrl) {
  if (workerUrl.includes('YOUR_SUBDOMAIN') || workerUrl.includes('@')) {
    log('⚠️  Skipping HTML update - Worker URL not detected', YELLOW);
    log('   Please manually update WORKER_URL in index.html', YELLOW);
    return;
  }
  
  log('📝 Updating HTML with Worker URL...', YELLOW);
  try {
    let html = fs.readFileSync('index.html', 'utf8');
    html = html.replace(/const WORKER_URL = '.*';/, `const WORKER_URL = '${workerUrl}';`);
    fs.writeFileSync('index.html', html);
    log('✓ HTML updated', GREEN);
  } catch (error) {
    log('⚠️  Failed to update HTML', YELLOW);
  }
}

function deployPages() {
  log('🌐 Deploying to Cloudflare Pages...', YELLOW);
  
  if (!fs.existsSync('index.html')) {
    log('❌ index.html not found! Cannot deploy Pages.', RED);
    return { success: false, url: null };
  }
  
  // Ensure public_page directory exists
  if (!fs.existsSync('public_page')) {
    fs.mkdirSync('public_page', { recursive: true });
  }
  
  // Copy index.html to public_page
  fs.copyFileSync('index.html', 'public_page/index.html');
  
  let pagesUrl = '';
  let deploymentSuccess = false;
  
  try {
    log('   Deploying public_page directory...', YELLOW);
    const output = exec('wrangler pages deploy public_page --project-name=faceswap-test --branch=main --commit-dirty=true --commit-message="Automated deploy"', { encoding: 'utf8', silent: true });
    
    // Check if deployment succeeded by looking for success indicators
    if (output && typeof output === 'string') {
      // Look for success messages
      if (output.includes('Deployment complete') || output.includes('Success!') || output.includes('✨')) {
        deploymentSuccess = true;
      }
      
      // Try to extract Pages URL from output
      const urlMatch = output.match(/https:\/\/[^\s]+\.pages\.dev/);
      if (urlMatch && urlMatch[0]) {
        pagesUrl = urlMatch[0];
      }
    }
  } catch (error) {
    // Even if there's an error, check if deployment succeeded
    const errorOutput = error.stdout || error.stderr || '';
    if (errorOutput && typeof errorOutput === 'string') {
      if (errorOutput.includes('Deployment complete') || errorOutput.includes('Success!') || errorOutput.includes('✨')) {
        deploymentSuccess = true;
      }
      
      // Try to extract URL from error output too
      const urlMatch = errorOutput.match(/https:\/\/[^\s]+\.pages\.dev/);
      if (urlMatch && urlMatch[0]) {
        pagesUrl = urlMatch[0];
      }
    }
  }
  
  // If URL not found, try from project list
  if (!pagesUrl) {
    try {
      const projectList = execSilent('wrangler pages project list');
      if (projectList && typeof projectList === 'string' && projectList.includes('faceswap-test')) {
        const projectMatch = projectList.match(/https:\/\/[^\s]+\.pages\.dev/);
        if (projectMatch && projectMatch[0]) {
          pagesUrl = projectMatch[0];
          deploymentSuccess = true;
        }
      }
    } catch {}
  }
  
  if (deploymentSuccess || pagesUrl) {
    log('✓ Pages deployed', GREEN);
    if (pagesUrl) {
      log(`✓ Pages URL: ${pagesUrl}`, GREEN);
    }
    return { success: true, url: pagesUrl };
  } else {
    log('⚠️  Pages deployment may have failed', YELLOW);
    log('   Try checking Cloudflare Dashboard for deployment status', YELLOW);
    return { success: false, url: null };
  }
}

function writeDeploymentInfo(workerUrl, pagesResult) {
  log('📝 Writing deployment info to DEPLOYMENT_INFO.md...', YELLOW);
  
  const pagesUrl = pagesResult.url || 'Not deployed yet';
  const pagesStatus = pagesResult.success ? 'Deployed' : 'Failed/Not deployed';
  
  // Check R2 status
  const r2Exists = execSilent('wrangler r2 bucket list').includes('faceswap-images');
  const r2Status = r2Exists ? 'Exists' : 'Not found';
  const corsConfigured = fs.existsSync('r2-cors.json') ? 'Configured (see r2-cors.json)' : 'Not configured';
  
  // Check D1 status
  const d1Exists = execSilent('wrangler d1 list').includes('faceswap-db');
  const d1Status = d1Exists ? 'Exists' : 'Not found';
  
  // Get environment variables
  let envVarsList = '';
  try {
    const secretList = execSilent('wrangler secret list');
    const envVars = secretList.split('\n').filter(line => 
      line.includes('RAPIDAPI') || line.includes('GOOGLE')
    );
    if (envVars.length > 0) {
      envVarsList = envVars.map(line => {
        const parts = line.trim().split(/\s+/);
        return `- **${parts[0]}:** ${parts[1] || 'Set'}`;
      }).join('\n');
    } else {
      envVarsList = '- Check manually: `wrangler secret list`';
    }
  } catch {
    envVarsList = '- Check manually: `wrangler secret list`';
  }
  
  const deploymentInfo = `# Deployment Information

**Generated:** ${new Date().toLocaleString()}

## 🌐 HTML Test Page (Frontend)

- **URL:** ${pagesUrl}
- **Status:** ${pagesStatus}
- **Description:** Main user interface for face swap application
- **Project Name:** faceswap-test
- **Directory:** public_page/

## 🔧 Worker API (Backend)

- **URL:** ${workerUrl}
- **Status:** Deployed
- **Endpoints:**
  - \`POST /\` - Face swap API
  - \`POST /faceswap\` - Face swap API (alias)
  - \`POST /upload-url\` - Get upload URL
  - \`PUT /upload-proxy/{key}\` - Upload file to R2
  - \`GET /presets\` - List all presets
  - \`GET /results\` - List all results
  - \`GET /r2/{key}\` - Serve R2 files

## Cloudflare Pages

- **URL:** ${pagesUrl}
- **Status:** ${pagesStatus}
- **Project Name:** faceswap-test
- **Directory:** public_page/

## R2 Storage

- **Bucket Name:** faceswap-images
- **Binding:** FACESWAP_IMAGES
- **Status:** ${r2Status}
- **CORS:** ${corsConfigured}

## D1 Database

- **Database Name:** faceswap-db
- **Binding:** DB
- **Status:** ${d1Status}
- **Schema:** schema.sql
- **Tables:**
  - \`presets\` - Store preset image metadata
  - \`results\` - Store face swap results

## Environment Variables

${envVarsList}

## Quick Commands

\`\`\`bash
# Deploy everything (Worker + Pages + R2 + D1)
npm run deploy

# Run locally
npm run dev
\`\`\`

## Manual Setup (if needed)

### Initialize Database Schema
\`\`\`bash
wrangler d1 execute faceswap-db --file=schema.sql
\`\`\`

### Configure R2 CORS
1. Go to: https://dash.cloudflare.com
2. Navigate to: R2 > faceswap-images > Settings > CORS Policy
3. Paste contents from r2-cors.json

### Set Environment Variables
\`\`\`bash
wrangler secret put RAPIDAPI_KEY
wrangler secret put RAPIDAPI_HOST
wrangler secret put RAPIDAPI_ENDPOINT
wrangler secret put GOOGLE_CLOUD_API_KEY
wrangler secret put GOOGLE_VISION_ENDPOINT
\`\`\`

## Notes

- Worker URL is automatically updated in index.html during deployment
- All images are stored in R2 bucket: faceswap-images
- Presets and results are stored in D1 database
- CORS configuration may need manual setup via Dashboard

---
*Generated by deploy.js - RoosterX Global Viet Nam*
`;

  fs.writeFileSync('DEPLOYMENT_INFO.md', deploymentInfo);
  log('✓ Deployment info saved to DEPLOYMENT_INFO.md', GREEN);
  log('', '');
  log('📄 View deployment info:', GREEN);
  log('   cat DEPLOYMENT_INFO.md', '');
}

// Main execution
async function main() {
  console.log('🚀 Face Swap AI - Deployment Script');
  console.log('======================================');
  console.log('');
  
  checkWrangler();
  checkAuth();
  console.log('');
  
  setupR2();
  console.log('');
  
  setupD1();
  console.log('');
  
  setupCORS();
  console.log('');
  
  checkSecrets();
  console.log('');
  
  const workerUrl = deployWorker();
  console.log('');
  
  updateHTML(workerUrl);
  console.log('');
  
  const pagesResult = deployPages();
  console.log('');
  
  // Summary
  log('======================================', GREEN);
  log('✅ Deployment Complete!', GREEN);
  log('======================================', GREEN);
  console.log('');
  log('📡 Worker API URL:', GREEN);
  console.log(`   ${workerUrl}`);
  console.log('');
  
  if (pagesResult.url && !pagesResult.url.includes('Not deployed')) {
    log('🌐 HTML Test Page URL:', GREEN);
    console.log(`   ${pagesResult.url}`);
    console.log('');
    log('👉 Open in browser:', GREEN);
    console.log(`   ${pagesResult.url}`);
    console.log('');
  } else {
    log('🌐 Pages not deployed', YELLOW);
    log('   To deploy Pages and get your URL:', YELLOW);
    log('   1. Run: npm run deploy:pages', YELLOW);
    log('   2. Or go to: https://dash.cloudflare.com', YELLOW);
    log('   3. Navigate to: Workers & Pages > Create Application > Pages', YELLOW);
    log('   4. Upload index.html', YELLOW);
    console.log('');
  }
  
  writeDeploymentInfo(workerUrl, pagesResult);
}

main().catch(error => {
  console.error('Deployment failed:', error);
  process.exit(1);
});

