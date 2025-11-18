const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// Setup Google Cloud Vision API with config parameters
async function setupGoogleCloud(config = {}) {
  const {
    projectId,
    accountEmail,
    skipPrompts = false
  } = config;

  if (!projectId) {
    throw new Error('projectId is required');
  }

  // Check for gcloud CLI
  if (!commandExists('gcloud')) {
    throw new Error('gcloud CLI not found. Please install Google Cloud SDK.');
  }

  // Set project
  try {
    execCommand(`gcloud config set project ${projectId}`, { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Failed to set project: ${error.message}`);
  }

  // Enable Vision API
  try {
    execCommand(`gcloud services enable vision.googleapis.com --project=${projectId}`, { stdio: 'pipe' });
  } catch (error) {
    // API might already be enabled
    if (!error.message.includes('already enabled')) {
      throw new Error(`Failed to enable Vision API: ${error.message}`);
    }
  }

  // Create service account
  const serviceAccountName = 'faceswap-vision-sa';
  const serviceAccountEmail = `${serviceAccountName}@${projectId}.iam.gserviceaccount.com`;
  
  try {
    execCommand(
      `gcloud iam service-accounts create ${serviceAccountName} --display-name="FaceSwap Vision API Service Account" --project=${projectId}`,
      { throwOnError: false, stdio: 'pipe' }
    );
  } catch (error) {
    // Check if it already exists
    const exists = execCommand(
      `gcloud iam service-accounts describe ${serviceAccountEmail} --project=${projectId}`,
      { throwOnError: false, silent: true }
    );
    if (!exists) {
      throw new Error(`Failed to create service account: ${error.message}`);
    }
  }

  // Grant Vision API role
  try {
    execCommand(
      `gcloud projects add-iam-policy-binding ${projectId} --member="serviceAccount:${serviceAccountEmail}" --role="roles/editor"`,
      { stdio: 'pipe' }
    );
  } catch (error) {
    // Check if the role is already granted
    const checkRole = execCommand(
      `gcloud projects get-iam-policy ${projectId} --filter="bindings.members:serviceAccount:${serviceAccountEmail}" --format="value(bindings.role)"`,
      { throwOnError: false, silent: true }
    );
    if (!checkRole || !checkRole.includes('roles/editor')) {
      throw new Error(`Failed to grant permissions: ${error.message}`);
    }
  }

  // Create and download key
  const keyFile = path.join(process.cwd(), 'temp-service-account-key.json');
  try {
    execCommand(
      `gcloud iam service-accounts keys create ${keyFile} --iam-account=${serviceAccountEmail} --project=${projectId}`,
      { stdio: 'pipe' }
    );
  } catch (error) {
    throw new Error(`Failed to create service account key: ${error.message}`);
  }

  // Read and encode key
  let encodedKey;
  try {
    const keyContent = fs.readFileSync(keyFile, 'utf8');
    encodedKey = Buffer.from(keyContent).toString('base64');
  } catch (error) {
    throw new Error(`Failed to read/encode key file: ${error.message}`);
  }

  // Clean up key file
  try {
    fs.unlinkSync(keyFile);
  } catch (error) {
    // Non-fatal
  }

  return {
    success: true,
    projectId,
    serviceAccountEmail,
    encodedKey
  };
}

// If run directly, use original CLI behavior
if (require.main === module) {
  const readline = require('readline');

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

  async function main() {
    console.log('\n🚀 Google Cloud Vision API Setup\n');
    console.log('=====================================\n');

    // Check for gcloud CLI
    if (!commandExists('gcloud')) {
      console.error('gcloud CLI not found!');
      process.exit(1);
    }

    // List projects
    let projects;
    try {
      const projectsOutput = execCommand('gcloud projects list --format="value(projectId)"', { silent: true });
      projects = projectsOutput ? projectsOutput.trim().split('\n').filter(p => p) : [];
    } catch (error) {
      console.error('Failed to list projects');
      process.exit(1);
    }

    let projectId;
    if (projects.length === 0) {
      projectId = await prompt('Enter project ID: ');
    } else {
      console.log('\nAvailable projects:');
      projects.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
      const choice = await prompt(`\nSelect project (1-${projects.length}) or enter new project ID: `);
      const choiceNum = parseInt(choice);
      if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= projects.length) {
        projectId = projects[choiceNum - 1];
      } else {
        projectId = choice;
      }
    }

    try {
      const result = await setupGoogleCloud({ projectId, skipPrompts: false });
      console.log('\n✅ Setup completed successfully!');
      console.log(`Project: ${result.projectId}`);
      console.log(`Service Account: ${result.serviceAccountEmail}`);
    } catch (error) {
      console.error(`\n❌ Setup failed: ${error.message}`);
      process.exit(1);
    }
  }

  main();
}

module.exports = setupGoogleCloud;

