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

// Check if command exists
function commandExists(command) {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${whichCmd} ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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

// Get installation instructions for gcloud
function getGcloudInstallInstructions() {
  const platform = process.platform;
  if (platform === 'darwin') {
    return `
Install Google Cloud SDK on macOS:
  brew install --cask google-cloud-sdk

Or download from: https://cloud.google.com/sdk/docs/install
`;
  } else if (platform === 'win32') {
    return `
Install Google Cloud SDK on Windows:
  Download and run installer from: https://cloud.google.com/sdk/docs/install
`;
  } else {
    return `
Install Google Cloud SDK on Linux:
  curl https://sdk.cloud.google.com | bash
  exec -l $SHELL

Or see: https://cloud.google.com/sdk/docs/install
`;
  }
}

async function main() {
  console.log('\n🚀 Google Cloud Vision API Setup\n');
  console.log('=====================================\n');

  // Check for gcloud CLI
  log.info('Checking for gcloud CLI...');
  if (!commandExists('gcloud')) {
    log.error('gcloud CLI not found!');
    console.log(getGcloudInstallInstructions());
    process.exit(1);
  }
  log.success('gcloud CLI found');

  // Check authentication
  log.info('Checking authentication...');
  try {
    const accounts = execCommand('gcloud auth list --filter=status:ACTIVE --format="value(account)"', { silent: true });
    if (!accounts || accounts.trim() === '') {
      log.warn('Not authenticated. Please login...');
      execCommand('gcloud auth login', { stdio: 'inherit' });
    } else {
      log.success(`Authenticated as: ${accounts.trim()}`);
    }
  } catch (error) {
    log.error('Authentication check failed');
    process.exit(1);
  }

  // List projects
  log.info('Fetching Google Cloud projects...');
  let projects;
  try {
    const projectsOutput = execCommand('gcloud projects list --format="value(projectId)"', { silent: true });
    projects = projectsOutput ? projectsOutput.trim().split('\n').filter(p => p) : [];
  } catch (error) {
    log.error('Failed to list projects');
    process.exit(1);
  }

  let projectId;
  if (projects.length === 0) {
    log.warn('No projects found.');
    const create = await prompt('Create a new project? (y/n): ');
    if (create.toLowerCase() !== 'y') {
      log.error('Project is required. Exiting.');
      process.exit(1);
    }
    projectId = await prompt('Enter project ID (lowercase, hyphens only): ');
    if (!projectId) {
      log.error('Project ID is required');
      process.exit(1);
    }
    log.info(`Creating project: ${projectId}...`);
    try {
      execCommand(`gcloud projects create ${projectId}`, { stdio: 'inherit' });
      log.success('Project created');
    } catch (error) {
      log.error('Failed to create project');
      process.exit(1);
    }
  } else {
    console.log('\nAvailable projects:');
    projects.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
    const choice = await prompt(`\nSelect project (1-${projects.length}) or enter new project ID: `);
    const choiceNum = parseInt(choice);
    if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= projects.length) {
      projectId = projects[choiceNum - 1];
    } else {
      projectId = choice;
      // Check if it exists, if not offer to create
      if (!projects.includes(projectId)) {
        const create = await prompt(`Project "${projectId}" doesn't exist. Create it? (y/n): `);
        if (create.toLowerCase() === 'y') {
          log.info(`Creating project: ${projectId}...`);
          try {
            execCommand(`gcloud projects create ${projectId}`, { stdio: 'inherit' });
            log.success('Project created');
          } catch (error) {
            log.error('Failed to create project');
            process.exit(1);
          }
        } else {
          log.error('Project is required. Exiting.');
          process.exit(1);
        }
      }
    }
  }

  log.success(`Using project: ${projectId}`);

  // Enable Vision API
  log.info('Enabling Cloud Vision API...');
  try {
    execCommand(`gcloud services enable vision.googleapis.com --project=${projectId}`, { stdio: 'inherit' });
    log.success('Cloud Vision API enabled');
  } catch (error) {
    log.error('Failed to enable Vision API');
    process.exit(1);
  }

  // Create service account
  const serviceAccountName = 'faceswap-vision-sa';
  const serviceAccountEmail = `${serviceAccountName}@${projectId}.iam.gserviceaccount.com`;
  
  log.info('Creating service account...');
  try {
    execCommand(
      `gcloud iam service-accounts create ${serviceAccountName} --display-name="FaceSwap Vision API Service Account" --project=${projectId}`,
      { throwOnError: false, stdio: 'inherit' }
    );
    log.success('Service account created');
  } catch (error) {
    // Check if it already exists
    const exists = execCommand(
      `gcloud iam service-accounts describe ${serviceAccountEmail} --project=${projectId}`,
      { throwOnError: false, silent: true }
    );
    if (exists) {
      log.warn('Service account already exists, using existing one');
    } else {
      log.error('Failed to create service account');
      process.exit(1);
    }
  }

  // Grant Vision API role
  log.info('Granting Vision API permissions...');
  try {
    execCommand(
      `gcloud projects add-iam-policy-binding ${projectId} --member="serviceAccount:${serviceAccountEmail}" --role="roles/cloud-vision-api.user"`,
      { stdio: 'inherit' }
    );
    log.success('Permissions granted');
  } catch (error) {
    log.error('Failed to grant permissions');
    process.exit(1);
  }

  // Create and download key
  const keyFile = path.join(process.cwd(), 'temp-service-account-key.json');
  log.info('Creating service account key...');
  try {
    execCommand(
      `gcloud iam service-accounts keys create ${keyFile} --iam-account=${serviceAccountEmail} --project=${projectId}`,
      { stdio: 'inherit' }
    );
    log.success('Service account key created');
  } catch (error) {
    log.error('Failed to create service account key');
    process.exit(1);
  }

  // Read and encode key
  log.info('Encoding service account key...');
  let encodedKey;
  try {
    const keyContent = fs.readFileSync(keyFile, 'utf8');
    encodedKey = Buffer.from(keyContent).toString('base64');
    log.success('Key encoded');
  } catch (error) {
    log.error('Failed to read/encode key file');
    process.exit(1);
  }

  // Set Cloudflare Workers secret
  log.info('Setting Cloudflare Workers secret...');
  try {
    const wranglerProcess = spawn('wrangler', ['secret', 'put', 'GOOGLE_SERVICE_ACCOUNT_KEY'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    
    wranglerProcess.stdin.write(encodedKey);
    wranglerProcess.stdin.end();
    
    await new Promise((resolve, reject) => {
      wranglerProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`wrangler exited with code ${code}`));
        }
      });
      wranglerProcess.on('error', reject);
    });
    
    log.success('Cloudflare secret set');
  } catch (error) {
    log.warn('Failed to set Cloudflare secret automatically');
    log.warn('You can set it manually with: wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY');
    log.warn(`Then paste this value: ${encodedKey.substring(0, 50)}...`);
  }

  // Clean up key file
  try {
    fs.unlinkSync(keyFile);
    log.success('Temporary key file cleaned up');
  } catch (error) {
    log.warn('Failed to clean up temporary key file. Please delete it manually for security.');
  }

  // Get project name
  let projectName = projectId;
  try {
    const projectInfo = execCommand(`gcloud projects describe ${projectId} --format="value(name)"`, { silent: true });
    if (projectInfo && projectInfo.trim()) {
      projectName = projectInfo.trim();
    }
  } catch (error) {
    // Use projectId as fallback
  }

  // Create documentation file
  const docPath = path.join(process.cwd(), 'google-cloud-setup.md');
  const timestamp = new Date().toISOString();
  const docContent = `# Google Cloud Vision API Setup Information

**Generated:** ${timestamp}

## Setup Summary

✅ Google Cloud Vision API setup completed successfully

## Project Information

- **Project ID:** \`${projectId}\`
- **Project Name:** \`${projectName}\`
- **Service Account Email:** \`${serviceAccountEmail}\`
- **Service Account Display Name:** FaceSwap Vision API Service Account

## Configuration Details

### IAM Role
- **Role:** \`roles/cloud-vision-api.user\`
- **Member:** \`serviceAccount:${serviceAccountEmail}\`

### API Status
- **Cloud Vision API:** ✅ Enabled

### Cloudflare Integration
- **Secret Name:** \`GOOGLE_SERVICE_ACCOUNT_KEY\`
- **Status:** ✅ Set (Base64-encoded service account JSON)

## Security Notes

⚠️ **Important Security Reminders:**

1. The service account key has been Base64-encoded and stored as a Cloudflare Workers secret
2. The temporary key file has been deleted from your local system
3. Never commit the service account key to version control
4. The key provides access to Google Cloud Vision API - keep it secure
5. If the key is compromised, delete it immediately in Google Cloud Console and create a new one

## Next Steps

1. **Deploy your Worker:**
   \`\`\`bash
   npm run deploy
   # or
   node deploy.js
   \`\`\`

2. **Test the setup:**
   - Make a face swap request to your Worker
   - The Worker will automatically use the service account to authenticate with Vision API

## Troubleshooting

### Error: "GOOGLE_SERVICE_ACCOUNT_KEY not set"
- Run: \`wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY\`
- Paste the Base64-encoded key (if you have it saved)

### Error: "OAuth2 token exchange failed"
- Verify the service account key is valid
- Check that Vision API is enabled in the project
- Ensure the service account has the correct IAM role

### Error: "Permission denied"
- Verify the service account has \`roles/cloud-vision-api.user\` role
- Check project billing is enabled (required for Vision API)

### Recreate Service Account Key
If you need to recreate the key:
\`\`\`bash
gcloud iam service-accounts keys create key.json \\
  --iam-account=${serviceAccountEmail} \\
  --project=${projectId}
base64 -i key.json  # macOS
base64 key.json     # Linux
# Then set as Cloudflare secret
wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
\`\`\`

## Quick Reference

- **Google Cloud Console:** https://console.cloud.google.com/iam-admin/serviceaccounts?project=${projectId}
- **Vision API Dashboard:** https://console.cloud.google.com/apis/api/vision.googleapis.com/overview?project=${projectId}
- **IAM & Admin:** https://console.cloud.google.com/iam-admin/iam?project=${projectId}

## Support

For issues with:
- **Google Cloud:** See [Google Cloud Documentation](https://cloud.google.com/vision/docs)
- **Cloudflare Workers:** See [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
`;

  try {
    fs.writeFileSync(docPath, docContent, 'utf8');
    log.success(`Documentation written to: ${docPath}`);
  } catch (error) {
    log.warn('Failed to write documentation file');
  }

  console.log('\n' + '='.repeat(50));
  log.success('Setup completed successfully!');
  console.log('\n📄 Setup information saved to: google-cloud-setup.md');
  console.log('\nNext step: Run `npm run deploy` to deploy your Worker\n');
}

main().catch((error) => {
  log.error(`Setup failed: ${error.message}`);
  process.exit(1);
});

