const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ConfigManager {
  constructor() {
    // Store config in user's app data directory
    const userDataPath = app.getPath('userData');
    this.configPath = path.join(userDataPath, 'deployments-config.json');
  }

  getDefaultConfig() {
    return {
      codebasePath: process.cwd(),
      deployments: []
    };
  }

  read() {
    try {
      if (!fs.existsSync(this.configPath)) {
        const defaultConfig = this.getDefaultConfig();
        this.write(defaultConfig);
        return defaultConfig;
      }

      const content = fs.readFileSync(this.configPath, 'utf8');
      const config = JSON.parse(content);
      
      // Ensure required fields exist
      if (!config.deployments) {
        config.deployments = [];
      }
      if (!config.codebasePath) {
        config.codebasePath = process.cwd();
      }

      return config;
    } catch (error) {
      console.error('Error reading config:', error);
      const defaultConfig = this.getDefaultConfig();
      this.write(defaultConfig);
      return defaultConfig;
    }
  }

  write(config) {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Validate before writing
      const validation = this.validate(config);
      if (!validation.valid) {
        throw new Error(`Invalid config: ${validation.error}`);
      }

      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
      return { success: true };
    } catch (error) {
      console.error('Error writing config:', error);
      return { success: false, error: error.message };
    }
  }

  validate(config) {
    if (!config || typeof config !== 'object') {
      return { valid: false, error: 'Config must be an object' };
    }

    if (!Array.isArray(config.deployments)) {
      return { valid: false, error: 'deployments must be an array' };
    }

    // Validate each deployment
    for (let i = 0; i < config.deployments.length; i++) {
      const deployment = config.deployments[i];
      const validation = this.validateDeployment(deployment);
      if (!validation.valid) {
        return { valid: false, error: `Deployment ${i}: ${validation.error}` };
      }
    }

    return { valid: true };
  }

  validateDeployment(deployment) {
    if (!deployment.id) {
      return { valid: false, error: 'Deployment must have an id' };
    }

    if (!deployment.name) {
      return { valid: false, error: 'Deployment must have a name' };
    }

    if (deployment.gcp && !deployment.gcp.projectId) {
      return { valid: false, error: 'GCP deployment must have projectId' };
    }

    if (deployment.secrets) {
      const requiredSecrets = [
        'RAPIDAPI_KEY',
        'RAPIDAPI_HOST',
        'RAPIDAPI_ENDPOINT',
        'GOOGLE_VISION_API_KEY',
        'GOOGLE_GEMINI_API_KEY',
        'GOOGLE_VISION_ENDPOINT'
      ];

      for (const secret of requiredSecrets) {
        const value = deployment.secrets[secret];
        if (value === undefined || value === null || value === '') {
          return { valid: false, error: `Missing required secret: ${secret}` };
        }
        if (typeof value !== 'string') {
          return { valid: false, error: `Secret ${secret} must be a string` };
        }
      }
    }

    return { valid: true };
  }

  getConfigPath() {
    return this.configPath;
  }
}

module.exports = new ConfigManager();

