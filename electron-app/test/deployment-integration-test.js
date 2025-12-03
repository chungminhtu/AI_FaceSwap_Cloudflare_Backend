const path = require('path');
const ConfigManager = require('../main/config-manager');
const { deployFromConfig } = require('../../deploy/deploy.js');

async function testDeploymentFlow() {
  console.log('🧪 Testing Electron Deployment Flow\n');

  try {
    // Step 1: Load config
    console.log('Step 1: Loading configuration...');
    const config = ConfigManager.read();
    const deployment = config.deployments.find(d => d.id === 'ai-office');
    
    if (!deployment) {
      throw new Error('Deployment "ai-office" not found');
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

    // Validate critical fields
    console.log('   Validating critical fields...');
    if (!deploymentConfig.workerName) throw new Error('workerName is missing');
    if (!deploymentConfig.pagesProjectName) throw new Error('pagesProjectName is missing');
    if (!deploymentConfig.cloudflare.accountId) throw new Error('Cloudflare accountId is missing');
    if (!deploymentConfig.cloudflare.apiToken) throw new Error('Cloudflare apiToken is missing');
    if (!deploymentConfig.gcp.projectId) throw new Error('GCP projectId is missing');
    if (!deploymentConfig.gcp.serviceAccountKeyJson) throw new Error('GCP serviceAccountKeyJson is missing');
    
    console.log('✅ Deployment config built successfully\n');

    // Step 3: Check codebase path
    console.log('Step 3: Checking codebase path...');
    const codebasePath = config.codebasePath || process.cwd();
    console.log(`   Codebase path: ${codebasePath}`);
    
    // Check if it's the project root (should contain deploy/ and src/ directories)
    const deployDir = path.join(codebasePath, 'deploy');
    const srcDir = path.join(codebasePath, 'src');
    const hasDeployDir = require('fs').existsSync(deployDir);
    const hasSrcDir = require('fs').existsSync(srcDir);
    
    console.log(`   Has deploy/ directory: ${hasDeployDir ? '✅' : '❌'}`);
    console.log(`   Has src/ directory: ${hasSrcDir ? '✅' : '❌'}`);
    
    if (!hasDeployDir || !hasSrcDir) {
      console.warn('⚠️  Warning: Codebase path might be incorrect');
      console.warn(`   Expected project root, but might be pointing to: ${codebasePath}`);
    }
    console.log('');

    // Step 4: Test deployFromConfig call structure
    console.log('Step 4: Testing deployFromConfig call structure...');
    const progressCallback = (step, status, details) => {
      console.log(`   [${status}] ${step}: ${details}`);
    };

    // Check if deployFromConfig can be called (but don't actually deploy)
    if (typeof deployFromConfig !== 'function') {
      throw new Error('deployFromConfig is not a function');
    }
    
    console.log('✅ deployFromConfig is callable\n');

    // Step 5: Validate config matches expected format
    console.log('Step 5: Validating config format...');
    
    // Check required fields for deployWithConfig
    const requiredForDeploy = [
      'workerName',
      'pagesProjectName',
      'databaseName',
      'bucketName',
      'cloudflare',
      'gcp',
      'secrets'
    ];
    
    for (const field of requiredForDeploy) {
      if (!deploymentConfig[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    // Check nested structures
    if (!deploymentConfig.cloudflare.accountId || !deploymentConfig.cloudflare.apiToken) {
      throw new Error('Cloudflare config incomplete');
    }
    
    if (!deploymentConfig.gcp.projectId || !deploymentConfig.gcp.serviceAccountKeyJson) {
      throw new Error('GCP config incomplete');
    }
    
    console.log('✅ Config format is valid\n');

    // Step 6: Check for common issues
    console.log('Step 6: Checking for common issues...');
    const issues = [];
    
    // Check if serviceAccountKeyJson is an object
    if (deploymentConfig.gcp.serviceAccountKeyJson) {
      if (typeof deploymentConfig.gcp.serviceAccountKeyJson !== 'object') {
        issues.push('GCP serviceAccountKeyJson should be an object, not a string');
      } else if (!deploymentConfig.gcp.serviceAccountKeyJson.private_key) {
        issues.push('GCP serviceAccountKeyJson missing private_key');
      }
      if (!deploymentConfig.gcp.serviceAccountKeyJson.client_email) {
        issues.push('GCP serviceAccountKeyJson missing client_email');
      }
    }
    
    // Check if secrets are all strings
    for (const [key, value] of Object.entries(deploymentConfig.secrets)) {
      if (value && typeof value !== 'string') {
        issues.push(`Secret ${key} is not a string (type: ${typeof value})`);
      }
      if (!value || value.trim() === '') {
        issues.push(`Secret ${key} is empty`);
      }
    }
    
    if (issues.length > 0) {
      console.error('❌ Issues found:');
      issues.forEach(issue => console.error(`   - ${issue}`));
      console.log('');
      return false;
    }
    
    console.log('✅ No common issues found\n');

    console.log('✅ All validation tests passed!');
    console.log('\n📋 Ready for deployment:');
    console.log(`   Deployment ID: ai-office`);
    console.log(`   Worker: ${deploymentConfig.workerName}`);
    console.log(`   Pages: ${deploymentConfig.pagesProjectName}`);
    console.log(`   Codebase: ${codebasePath}`);
    console.log(`   Cloudflare Account: ${deploymentConfig.cloudflare.accountId.substring(0, 8)}...`);
    console.log(`   GCP Project: ${deploymentConfig.gcp.projectId}`);
    
    return true;
  } catch (error) {
    console.error(`\n❌ Test failed: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

// Run test
if (require.main === module) {
  testDeploymentFlow()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('❌ Unexpected error:', error);
      process.exit(1);
    });
}

module.exports = { testDeploymentFlow };

