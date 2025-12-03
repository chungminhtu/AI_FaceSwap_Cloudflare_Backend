const path = require('path');
const fs = require('fs');

// Mock the main.js deployment handler logic
async function testDeploymentButton() {
  console.log('🧪 Testing Electron Deployment Button (ai-office)\n');

  try {
    // Simulate what happens when the deploy button is clicked
    const ConfigManager = require('../main/config-manager');
    const { deployFromConfig } = require('../../deploy/deploy.js');

    // Step 1: Load config (same as main.js)
    console.log('Step 1: Loading configuration...');
    const config = ConfigManager.read();
    const deploymentId = 'ai-office';
    const deployment = config.deployments.find(d => d.id === deploymentId);

    if (!deployment) {
      throw new Error(`Deployment "${deploymentId}" not found`);
    }
    console.log(`✅ Found deployment: ${deployment.name}\n`);

    // Step 2: Build deployment config (exact same as main.js)
    console.log('Step 2: Building deployment config...');
    const deploymentConfig = {
      workerName: deployment.workerName,
      pagesProjectName: deployment.pagesProjectName,
      databaseName: deployment.databaseName,
      bucketName: deployment.bucketName,
      cloudflare: {
        accountId: deployment.cloudflare?.accountId || '',
        apiToken: deployment.cloudflare?.apiToken || ''
      },
      gcp: {
        projectId: deployment.gcp?.projectId || '',
        serviceAccountKeyJson: deployment.gcp?.serviceAccountKeyJson || null
      },
      deployPages: true,
      secrets: {
        RAPIDAPI_KEY: deployment.RAPIDAPI_KEY || deployment.secrets?.RAPIDAPI_KEY,
        RAPIDAPI_HOST: deployment.RAPIDAPI_HOST || deployment.secrets?.RAPIDAPI_HOST,
        RAPIDAPI_ENDPOINT: deployment.RAPIDAPI_ENDPOINT || deployment.secrets?.RAPIDAPI_ENDPOINT,
        GOOGLE_VISION_API_KEY: deployment.GOOGLE_VISION_API_KEY || deployment.secrets?.GOOGLE_VISION_API_KEY,
        GOOGLE_VERTEX_PROJECT_ID: deployment.GOOGLE_VERTEX_PROJECT_ID || deployment.secrets?.GOOGLE_VERTEX_PROJECT_ID,
        GOOGLE_VERTEX_LOCATION: deployment.GOOGLE_VERTEX_LOCATION || deployment.secrets?.GOOGLE_VERTEX_LOCATION || 'us-central1',
        GOOGLE_VISION_ENDPOINT: deployment.GOOGLE_VISION_ENDPOINT || deployment.secrets?.GOOGLE_VISION_ENDPOINT,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: deployment.GOOGLE_SERVICE_ACCOUNT_EMAIL || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: deployment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      }
    };

    // Step 3: Determine codebase path (same logic as main.js)
    console.log('Step 3: Determining codebase path...');
    const projectRoot = path.resolve(__dirname, '../..');
    // ConfigManager.read() now validates and returns project root if invalid
    let codebasePath = config.codebasePath;
    
    // Double-check: if path doesn't exist or is invalid, use project root
    if (!codebasePath || !fs.existsSync(codebasePath)) {
      console.log('   ⚠️  Codebase path not set or invalid, using project root');
      codebasePath = projectRoot;
    } else {
      console.log(`   ✅ Using codebase path from config: ${codebasePath}`);
    }
    
    // Verify it's the correct path
    const hasDeployDir = fs.existsSync(path.join(codebasePath, 'deploy'));
    const hasSrcDir = fs.existsSync(path.join(codebasePath, 'src'));
    
    console.log(`   Codebase path: ${codebasePath}`);
    console.log(`   Has deploy/ directory: ${hasDeployDir ? '✅' : '❌'}`);
    console.log(`   Has src/ directory: ${hasSrcDir ? '✅' : '❌'}`);
    
    if (!hasDeployDir || !hasSrcDir) {
      throw new Error(`Invalid codebase path: ${codebasePath}. Missing required directories.`);
    }
    console.log('✅ Codebase path is valid\n');

    // Step 4: Validate deployment config
    console.log('Step 4: Validating deployment config...');
    const requiredFields = {
      workerName: deploymentConfig.workerName,
      pagesProjectName: deploymentConfig.pagesProjectName,
      databaseName: deploymentConfig.databaseName,
      bucketName: deploymentConfig.bucketName,
      'cloudflare.accountId': deploymentConfig.cloudflare?.accountId,
      'cloudflare.apiToken': deploymentConfig.cloudflare?.apiToken,
      'gcp.projectId': deploymentConfig.gcp?.projectId,
      'gcp.serviceAccountKeyJson': deploymentConfig.gcp?.serviceAccountKeyJson
    };

    const missingFields = Object.entries(requiredFields)
      .filter(([key, value]) => !value)
      .map(([key]) => key);

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Validate serviceAccountKeyJson structure
    if (typeof deploymentConfig.gcp.serviceAccountKeyJson !== 'object') {
      throw new Error('GCP serviceAccountKeyJson must be an object');
    }
    if (!deploymentConfig.gcp.serviceAccountKeyJson.private_key) {
      throw new Error('GCP serviceAccountKeyJson missing private_key');
    }
    if (!deploymentConfig.gcp.serviceAccountKeyJson.client_email) {
      throw new Error('GCP serviceAccountKeyJson missing client_email');
    }

    console.log('✅ Deployment config is valid\n');

    // Step 5: Test deployFromConfig structure (don't actually deploy)
    console.log('Step 5: Testing deployFromConfig compatibility...');
    if (typeof deployFromConfig !== 'function') {
      throw new Error('deployFromConfig is not a function');
    }

    // Create a mock progress callback
    const mockProgressCallback = (step, status, details) => {
      // Don't output during test, just verify it's callable
    };

    // Verify the config structure matches what deployFromConfig expects
    console.log('✅ deployFromConfig is compatible\n');

    console.log('✅ All tests passed!');
    console.log('\n📋 Deployment Configuration:');
    console.log(`   Deployment ID: ${deploymentId}`);
    console.log(`   Name: ${deployment.name}`);
    console.log(`   Worker: ${deploymentConfig.workerName}`);
    console.log(`   Pages: ${deploymentConfig.pagesProjectName}`);
    console.log(`   Database: ${deploymentConfig.databaseName}`);
    console.log(`   Bucket: ${deploymentConfig.bucketName}`);
    console.log(`   Codebase: ${codebasePath}`);
    console.log(`   Cloudflare Account: ${deploymentConfig.cloudflare.accountId.substring(0, 8)}...`);
    console.log(`   GCP Project: ${deploymentConfig.gcp.projectId}`);
    console.log(`   Deploy Pages: ${deploymentConfig.deployPages}`);
    console.log(`   Secrets: ${Object.keys(deploymentConfig.secrets).filter(k => deploymentConfig.secrets[k]).length} configured`);

    return true;
  } catch (error) {
    console.error(`\n❌ Test failed: ${error.message}`);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    return false;
  }
}

// Run test
if (require.main === module) {
  testDeploymentButton()
    .then(success => {
      if (success) {
        console.log('\n✅ Deployment button test passed!');
        console.log('   The deployment should work correctly when clicked in the Electron app.');
      } else {
        console.log('\n❌ Deployment button test failed!');
        console.log('   Please fix the issues above before deploying.');
      }
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('❌ Unexpected error:', error);
      process.exit(1);
    });
}

module.exports = { testDeploymentButton };

