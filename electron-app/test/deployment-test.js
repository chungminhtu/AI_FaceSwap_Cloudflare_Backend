const path = require('path');
const ConfigManager = require('../main/config-manager');
const { deployFromConfig } = require('../../deploy/deploy.js');

// Mock Electron IPC for testing
const mockProgressCallback = (step, status, details) => {
  console.log(`[${status.toUpperCase()}] ${step}: ${details}`);
};

async function testDeploymentConfig() {
  console.log('🧪 Testing Electron Deployment Configuration\n');

  // Test 1: Load config
  console.log('Test 1: Loading configuration...');
  const config = ConfigManager.read();
  console.log(`✅ Config loaded: ${config.deployments.length} deployments`);
  console.log(`   Codebase path: ${config.codebasePath}\n`);

  // Test 2: Find ai-office deployment
  console.log('Test 2: Finding ai-office deployment...');
  const deployment = config.deployments.find(d => d.id === 'ai-office');
  if (!deployment) {
    console.error('❌ Deployment "ai-office" not found');
    console.log('Available deployments:', config.deployments.map(d => d.id).join(', '));
    return false;
  }
  console.log(`✅ Found deployment: ${deployment.name}`);
  console.log(`   ID: ${deployment.id}`);
  console.log(`   Worker: ${deployment.workerName}`);
  console.log(`   Pages: ${deployment.pagesProjectName}\n`);

  // Test 3: Validate deployment structure
  console.log('Test 3: Validating deployment structure...');
  const requiredFields = [
    'workerName', 'pagesProjectName', 'databaseName', 'bucketName',
    'cloudflare', 'gcp'
  ];
  const missingFields = requiredFields.filter(field => {
    if (field === 'cloudflare') {
      return !deployment.cloudflare || !deployment.cloudflare.accountId || !deployment.cloudflare.apiToken;
    }
    if (field === 'gcp') {
      return !deployment.gcp || !deployment.gcp.projectId;
    }
    return !deployment[field];
  });

  if (missingFields.length > 0) {
    console.error(`❌ Missing required fields: ${missingFields.join(', ')}`);
    return false;
  }
  console.log('✅ All required fields present\n');

  // Test 4: Build deployment config (same as main.js)
  console.log('Test 4: Building deployment config...');
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

  // Validate config structure
  console.log('   Worker Name:', deploymentConfig.workerName);
  console.log('   Pages Project:', deploymentConfig.pagesProjectName);
  console.log('   Database:', deploymentConfig.databaseName);
  console.log('   Bucket:', deploymentConfig.bucketName);
  console.log('   Cloudflare Account ID:', deploymentConfig.cloudflare.accountId ? '✅ Set' : '❌ Missing');
  console.log('   Cloudflare API Token:', deploymentConfig.cloudflare.apiToken ? '✅ Set' : '❌ Missing');
  console.log('   GCP Project ID:', deploymentConfig.gcp.projectId ? '✅ Set' : '❌ Missing');
  console.log('   GCP Service Account:', deploymentConfig.gcp.serviceAccountKeyJson ? '✅ Set' : '❌ Missing');
  console.log('   Secrets count:', Object.keys(deploymentConfig.secrets).filter(k => deploymentConfig.secrets[k]).length, '/', Object.keys(deploymentConfig.secrets).length);
  
  // Check for issues
  const issues = [];
  if (!deploymentConfig.cloudflare.accountId) issues.push('Cloudflare account ID missing');
  if (!deploymentConfig.cloudflare.apiToken) issues.push('Cloudflare API token missing');
  if (!deploymentConfig.gcp.projectId) issues.push('GCP project ID missing');
  if (!deploymentConfig.gcp.serviceAccountKeyJson) issues.push('GCP service account key JSON missing');
  
  const missingSecrets = Object.entries(deploymentConfig.secrets)
    .filter(([key, value]) => !value)
    .map(([key]) => key);
  if (missingSecrets.length > 0) {
    issues.push(`Missing secrets: ${missingSecrets.join(', ')}`);
  }

  if (issues.length > 0) {
    console.error(`\n❌ Issues found:\n   - ${issues.join('\n   - ')}\n`);
    return false;
  }

  console.log('\n✅ Deployment config is valid\n');

  // Test 5: Validate deployFromConfig can accept the config
  console.log('Test 5: Validating deployFromConfig compatibility...');
  try {
    // Just validate structure, don't actually deploy
    if (typeof deployFromConfig !== 'function') {
      throw new Error('deployFromConfig is not a function');
    }
    console.log('✅ deployFromConfig function available');
    
    // Check if config structure matches expected format
    if (!deploymentConfig.workerName || !deploymentConfig.pagesProjectName) {
      throw new Error('Missing workerName or pagesProjectName');
    }
    if (!deploymentConfig.cloudflare || !deploymentConfig.cloudflare.accountId) {
      throw new Error('Missing Cloudflare account ID');
    }
    if (!deploymentConfig.gcp || !deploymentConfig.gcp.serviceAccountKeyJson) {
      throw new Error('Missing GCP service account key JSON');
    }
    console.log('✅ Config structure matches deployFromConfig requirements\n');
  } catch (error) {
    console.error(`❌ Validation failed: ${error.message}\n`);
    return false;
  }

  console.log('✅ All tests passed!');
  console.log('\n📋 Deployment Config Summary:');
  console.log(JSON.stringify({
    workerName: deploymentConfig.workerName,
    pagesProjectName: deploymentConfig.pagesProjectName,
    databaseName: deploymentConfig.databaseName,
    bucketName: deploymentConfig.bucketName,
    hasCloudflare: !!deploymentConfig.cloudflare.accountId,
    hasGCP: !!deploymentConfig.gcp.serviceAccountKeyJson,
    secretsCount: Object.keys(deploymentConfig.secrets).filter(k => deploymentConfig.secrets[k]).length
  }, null, 2));

  return true;
}

// Run tests
if (require.main === module) {
  testDeploymentConfig()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('❌ Test failed with error:', error);
      console.error(error.stack);
      process.exit(1);
    });
}

module.exports = { testDeploymentConfig };

