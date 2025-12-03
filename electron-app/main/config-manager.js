const fs = require('fs');
const path = require('path');

class ConfigManager {
  constructor() {
    const projectRoot = path.resolve(__dirname, '../..');
    this.secretsPath = path.join(projectRoot, 'deploy', 'deployments-secrets.json');
    this.projectRoot = projectRoot;
  }

  getDefaultConfig() {
    return {
      codebasePath: this.projectRoot,
      deployments: []
    };
  }

  readSecretsFile() {
    try {
      if (!fs.existsSync(this.secretsPath)) {
        return { environments: {} };
      }
      const content = fs.readFileSync(this.secretsPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return { environments: {} };
    }
  }

  writeSecretsFile(data) {
    try {
      const dir = path.dirname(this.secretsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.secretsPath, JSON.stringify(data, null, 2), 'utf8');
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }


  read() {
    try {
      const secretsData = this.readSecretsFile();

      const deployments = [];
      if (secretsData.environments) {
        for (const [envName, envConfig] of Object.entries(secretsData.environments)) {
          const serviceAccountEmail = envConfig.GOOGLE_SERVICE_ACCOUNT_EMAIL || 
                                     envConfig.gcp?.serviceAccountKeyJson?.client_email || '';
          const serviceAccountKey = envConfig.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || 
                                   envConfig.gcp?.serviceAccountKeyJson?.private_key || '';

          const deployment = {
            id: envName,
            name: envConfig.name || envName,
            status: 'idle',
            workerName: envConfig.workerName || '',
            pagesProjectName: envConfig.pagesProjectName || '',
            databaseName: envConfig.databaseName || '',
            bucketName: envConfig.bucketName || '',
            gcp: {
              projectId: envConfig.gcp?.projectId || '',
              accountEmail: envConfig.gcp?.accountEmail || '',
              serviceAccountKeyJson: envConfig.gcp?.serviceAccountKeyJson || null
            },
            cloudflare: {
              accountId: envConfig.cloudflare?.accountId || '',
              email: envConfig.cloudflare?.email || '',
              apiToken: envConfig.cloudflare?.apiToken || ''
            },
            secrets: {
              RAPIDAPI_KEY: envConfig.RAPIDAPI_KEY || '',
              RAPIDAPI_HOST: envConfig.RAPIDAPI_HOST || '',
              RAPIDAPI_ENDPOINT: envConfig.RAPIDAPI_ENDPOINT || '',
              GOOGLE_VISION_API_KEY: envConfig.GOOGLE_VISION_API_KEY || '',
              GOOGLE_VERTEX_PROJECT_ID: envConfig.GOOGLE_VERTEX_PROJECT_ID || '',
              GOOGLE_VERTEX_LOCATION: envConfig.GOOGLE_VERTEX_LOCATION || 'us-central1',
              GOOGLE_VISION_ENDPOINT: envConfig.GOOGLE_VISION_ENDPOINT || '',
              GOOGLE_SERVICE_ACCOUNT_EMAIL: serviceAccountEmail,
              GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: serviceAccountKey
            },
            RAPIDAPI_KEY: envConfig.RAPIDAPI_KEY || '',
            RAPIDAPI_HOST: envConfig.RAPIDAPI_HOST || '',
            RAPIDAPI_ENDPOINT: envConfig.RAPIDAPI_ENDPOINT || '',
            GOOGLE_VISION_API_KEY: envConfig.GOOGLE_VISION_API_KEY || '',
            GOOGLE_VERTEX_PROJECT_ID: envConfig.GOOGLE_VERTEX_PROJECT_ID || '',
            GOOGLE_VERTEX_LOCATION: envConfig.GOOGLE_VERTEX_LOCATION || 'us-central1',
            GOOGLE_VISION_ENDPOINT: envConfig.GOOGLE_VISION_ENDPOINT || '',
            GOOGLE_SERVICE_ACCOUNT_EMAIL: serviceAccountEmail,
            GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: serviceAccountKey,
            history: []
          };
          deployments.push(deployment);
        }
      }

      // Always use project root as codebase path
      const codebasePath = this.projectRoot;

      return {
        codebasePath,
        deployments,
        formDraft: null
      };
    } catch (error) {
      return this.getDefaultConfig();
    }
  }

  write(config) {
    try {
      const validation = this.validate(config);
      if (!validation.valid) {
        throw new Error(`Invalid config: ${validation.error}`);
      }

      // No need to save UI state - just save deployments

      const existingSecrets = this.readSecretsFile();
      const secretsData = { environments: {} };
      
      if (config.deployments && config.deployments.length > 0) {
        for (const deployment of config.deployments) {
          const envName = deployment.id;
          const existingEnv = existingSecrets.environments?.[envName];
          
          let serviceAccountKeyJson = deployment.gcp?.serviceAccountKeyJson;
          if (!serviceAccountKeyJson && existingEnv?.gcp?.serviceAccountKeyJson) {
            serviceAccountKeyJson = existingEnv.gcp.serviceAccountKeyJson;
          }
          
          secretsData.environments[envName] = {
            name: deployment.name,
            workerName: deployment.workerName,
            pagesProjectName: deployment.pagesProjectName,
            databaseName: deployment.databaseName,
            bucketName: deployment.bucketName,
            cloudflare: {
              accountId: deployment.cloudflare?.accountId || '',
              apiToken: deployment.cloudflare?.apiToken || '',
              email: deployment.cloudflare?.email || ''
            },
            gcp: {
              projectId: deployment.gcp?.projectId || '',
              accountEmail: deployment.gcp?.accountEmail || '',
              serviceAccountKeyJson: serviceAccountKeyJson || null
            },
            RAPIDAPI_KEY: deployment.RAPIDAPI_KEY || deployment.secrets?.RAPIDAPI_KEY || '',
            RAPIDAPI_HOST: deployment.RAPIDAPI_HOST || deployment.secrets?.RAPIDAPI_HOST || '',
            RAPIDAPI_ENDPOINT: deployment.RAPIDAPI_ENDPOINT || deployment.secrets?.RAPIDAPI_ENDPOINT || '',
            GOOGLE_VISION_API_KEY: deployment.GOOGLE_VISION_API_KEY || deployment.secrets?.GOOGLE_VISION_API_KEY || '',
            GOOGLE_VERTEX_PROJECT_ID: deployment.GOOGLE_VERTEX_PROJECT_ID || deployment.secrets?.GOOGLE_VERTEX_PROJECT_ID || '',
            GOOGLE_VERTEX_LOCATION: deployment.GOOGLE_VERTEX_LOCATION || deployment.secrets?.GOOGLE_VERTEX_LOCATION || 'us-central1',
            GOOGLE_VISION_ENDPOINT: deployment.GOOGLE_VISION_ENDPOINT || deployment.secrets?.GOOGLE_VISION_ENDPOINT || '',
            GOOGLE_SERVICE_ACCOUNT_EMAIL: deployment.GOOGLE_SERVICE_ACCOUNT_EMAIL || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
            GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: deployment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || ''
          };
        }
      }

      this.writeSecretsFile(secretsData);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  saveDeployment(deployment) {
    try {
      const validation = this.validateDeployment(deployment);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const secretsData = this.readSecretsFile();
      const envName = deployment.id || deployment.name;
      const existingEnv = secretsData.environments?.[envName];
      
      let serviceAccountKeyJson = deployment.gcp?.serviceAccountKeyJson;
      if (!serviceAccountKeyJson && existingEnv?.gcp?.serviceAccountKeyJson) {
        serviceAccountKeyJson = existingEnv.gcp.serviceAccountKeyJson;
      }

      secretsData.environments[envName] = {
        name: deployment.name,
        workerName: deployment.workerName,
        pagesProjectName: deployment.pagesProjectName,
        databaseName: deployment.databaseName,
        bucketName: deployment.bucketName,
        cloudflare: {
          accountId: deployment.cloudflare?.accountId || '',
          apiToken: deployment.cloudflare?.apiToken || '',
          email: deployment.cloudflare?.email || ''
        },
        gcp: {
          projectId: deployment.gcp?.projectId || '',
          accountEmail: deployment.gcp?.accountEmail || '',
          serviceAccountKeyJson: serviceAccountKeyJson || null
        },
        RAPIDAPI_KEY: deployment.RAPIDAPI_KEY || deployment.secrets?.RAPIDAPI_KEY || '',
        RAPIDAPI_HOST: deployment.RAPIDAPI_HOST || deployment.secrets?.RAPIDAPI_HOST || '',
        RAPIDAPI_ENDPOINT: deployment.RAPIDAPI_ENDPOINT || deployment.secrets?.RAPIDAPI_ENDPOINT || '',
        GOOGLE_VISION_API_KEY: deployment.GOOGLE_VISION_API_KEY || deployment.secrets?.GOOGLE_VISION_API_KEY || '',
        GOOGLE_VERTEX_PROJECT_ID: deployment.GOOGLE_VERTEX_PROJECT_ID || deployment.secrets?.GOOGLE_VERTEX_PROJECT_ID || '',
        GOOGLE_VERTEX_LOCATION: deployment.GOOGLE_VERTEX_LOCATION || deployment.secrets?.GOOGLE_VERTEX_LOCATION || 'us-central1',
        GOOGLE_VISION_ENDPOINT: deployment.GOOGLE_VISION_ENDPOINT || deployment.secrets?.GOOGLE_VISION_ENDPOINT || '',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: deployment.GOOGLE_SERVICE_ACCOUNT_EMAIL || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: deployment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || ''
      };

      return this.writeSecretsFile(secretsData);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  saveDeploymentHistory(deploymentId, historyItem) {
    // History is not stored in deployments-secrets.json
    // Can be stored in a separate file if needed, but for now we skip it
  }

  validate(config) {
    if (!config || typeof config !== 'object') {
      return { valid: false, error: 'Config must be an object' };
    }

    if (!Array.isArray(config.deployments)) {
      config.deployments = [];
    }

    for (let i = 0; i < config.deployments.length; i++) {
      const deployment = config.deployments[i];
      
      if (!deployment || typeof deployment !== 'object') {
        continue;
      }
      
      if (!deployment.id || typeof deployment.id !== 'string' || deployment.id.trim() === '') {
        return { valid: false, error: `Deployment ${i}: Missing or invalid id` };
      }
      if (!deployment.name || typeof deployment.name !== 'string' || deployment.name.trim() === '') {
        return { valid: false, error: `Deployment ${i}: Missing or invalid name` };
      }
    }

    return { valid: true };
  }

  validateDeployment(deployment) {
    const requiredFields = [
      'workerName', 'pagesProjectName', 'databaseName', 'bucketName',
      'RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT',
      'GOOGLE_VISION_API_KEY', 'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_VISION_ENDPOINT',
      'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'
    ];

    const secrets = deployment.secrets || deployment;
    
    for (const field of requiredFields) {
      const value = deployment[field] || secrets[field];
      if (value === undefined || value === null || value === '') {
        return { valid: false, error: `Missing required field: ${field}` };
      }
      if (typeof value !== 'string') {
        return { valid: false, error: `Field ${field} must be a string` };
      }
    }

    return { valid: true };
  }

  getConfigPath() {
    return null; // No config file
  }

  getSecretsPath() {
    return this.secretsPath;
  }

  close() {
    // No database to close
  }
}

module.exports = new ConfigManager();
