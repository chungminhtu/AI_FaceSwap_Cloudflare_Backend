// Configuration schema validation
function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Config must be an object' };
  }

  if (typeof config.codebasePath !== 'string') {
    return { valid: false, error: 'codebasePath must be a string' };
  }

  if (!Array.isArray(config.deployments)) {
    return { valid: false, error: 'deployments must be an array' };
  }

  for (let i = 0; i < config.deployments.length; i++) {
    const deployment = config.deployments[i];
    const validation = validateDeployment(deployment, i);
    if (!validation.valid) {
      return validation;
    }
  }

  return { valid: true };
}

function validateDeployment(deployment, index) {
  const prefix = `Deployment ${index >= 0 ? `#${index + 1}` : ''}`;

  if (!deployment.id || typeof deployment.id !== 'string') {
    return { valid: false, error: `${prefix}: id is required and must be a string` };
  }

  if (!deployment.name || typeof deployment.name !== 'string') {
    return { valid: false, error: `${prefix}: name is required and must be a string` };
  }

  if (deployment.gcp) {
    if (!deployment.gcp.projectId || typeof deployment.gcp.projectId !== 'string') {
      return { valid: false, error: `${prefix}: gcp.projectId is required and must be a string` };
    }
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
      if (value === undefined || value === null || value === '' || typeof value !== 'string') {
        return { valid: false, error: `${prefix}: Missing or invalid secret: ${secret}` };
      }
    }
  }

  return { valid: true };
}

module.exports = {
  validateConfig,
  validateDeployment
};

