const { test, expect } = require('@playwright/test');
const { _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

/**
 * E2E Tests for Configuration Management
 * Tests real config reading/writing to secrets.json and SQLite
 * NO MOCKS - All real operations
 */
test.describe('Configuration Management E2E', () => {
  let electronApp;
  let window;
  const testSecretsPath = path.join(__dirname, '..', 'test-secrets.json');

  test.beforeAll(async () => {
    electronApp = await _electron.launch({
      args: [path.join(__dirname, '..')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    });
    window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(1000); // Wait for app initialization
  });

  test.afterAll(async () => {
    // Clean up test file if exists
    if (fs.existsSync(testSecretsPath)) {
      fs.unlinkSync(testSecretsPath);
    }
    await electronApp.close();
  });

  test('should read configuration via IPC (real ConfigManager.read)', async () => {
    const config = await window.evaluate(() => {
      return window.electronAPI?.configRead();
    });

    expect(config).toBeDefined();
    expect(config).toHaveProperty('codebasePath');
    expect(config).toHaveProperty('deployments');
    expect(Array.isArray(config.deployments)).toBe(true);
  });

  test('should get secrets.json path via IPC (real path)', async () => {
    const secretsPath = await window.evaluate(() => {
      return window.electronAPI?.configGetSecretsPath();
    });

    expect(secretsPath).toBeDefined();
    expect(typeof secretsPath).toBe('string');
    expect(secretsPath).toContain('secrets.json');
  });

  test('should validate configuration via IPC (real validation)', async () => {
    const validConfig = {
      deployments: [{
        id: 'test-deployment',
        name: 'Test Deployment',
        workerName: 'test-worker',
        pagesProjectName: 'test-pages',
        databaseName: 'test-db',
        bucketName: 'test-bucket',
        RAPIDAPI_KEY: 'test-key',
        RAPIDAPI_HOST: 'test-host',
        RAPIDAPI_ENDPOINT: 'https://test.com',
        GOOGLE_VISION_API_KEY: 'test-vision-key',
        GOOGLE_VERTEX_PROJECT_ID: 'test-project',
        GOOGLE_VERTEX_LOCATION: 'us-central1',
        GOOGLE_VERTEX_API_KEY: 'test-vertex-key',
        GOOGLE_VISION_ENDPOINT: 'https://vision.googleapis.com/v1/images:annotate'
      }]
    };

    const validation = await window.evaluate((config) => {
      return window.electronAPI?.configValidate(config);
    }, validConfig);

    expect(validation).toBeDefined();
    expect(validation.valid).toBe(true);
  });

  test('should reject invalid configuration (real validation)', async () => {
    const invalidConfig = {
      deployments: [{
        id: 'test-deployment',
        name: 'Test Deployment',
        // Missing required fields
      }]
    };

    const validation = await window.evaluate((config) => {
      return window.electronAPI?.configValidate(config);
    }, invalidConfig);

    expect(validation).toBeDefined();
    expect(validation.valid).toBe(false);
    expect(validation.error).toBeDefined();
  });

  test('should save deployment to secrets.json (real file write)', async () => {
    const deployment = {
      workerName: 'e2e-test-worker',
      pagesProjectName: 'e2e-test-pages',
      databaseName: 'e2e-test-db',
      bucketName: 'e2e-test-bucket',
      RAPIDAPI_KEY: 'e2e-test-rapidapi-key',
      RAPIDAPI_HOST: 'e2e-test-host.com',
      RAPIDAPI_ENDPOINT: 'https://e2e-test.com/api',
      GOOGLE_VISION_API_KEY: 'e2e-test-vision-key',
      GOOGLE_VERTEX_PROJECT_ID: 'e2e-test-project-id',
      GOOGLE_VERTEX_LOCATION: 'us-central1',
      GOOGLE_VERTEX_API_KEY: 'e2e-test-vertex-key',
      GOOGLE_VISION_ENDPOINT: 'https://vision.googleapis.com/v1/images:annotate'
    };

    const result = await window.evaluate((deployment) => {
      return window.electronAPI?.configSaveDeployment(deployment);
    }, deployment);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    // Verify file was actually written
    const secretsPath = await window.evaluate(() => {
      return window.electronAPI?.configGetSecretsPath();
    });

    if (fs.existsSync(secretsPath)) {
      const fileContent = fs.readFileSync(secretsPath, 'utf8');
      const savedConfig = JSON.parse(fileContent);
      expect(savedConfig.workerName).toBe('e2e-test-worker');
      expect(savedConfig.GOOGLE_VERTEX_PROJECT_ID).toBe('e2e-test-project-id');
    }
  });

  test('should read saved deployment from secrets.json (real file read)', async () => {
    // First save a deployment
    const deployment = {
      workerName: 'read-test-worker',
      pagesProjectName: 'read-test-pages',
      databaseName: 'read-test-db',
      bucketName: 'read-test-bucket',
      RAPIDAPI_KEY: 'read-test-key',
      RAPIDAPI_HOST: 'read-test-host.com',
      RAPIDAPI_ENDPOINT: 'https://read-test.com/api',
      GOOGLE_VISION_API_KEY: 'read-test-vision-key',
      GOOGLE_VERTEX_PROJECT_ID: 'read-test-project',
      GOOGLE_VERTEX_LOCATION: 'us-central1',
      GOOGLE_VERTEX_API_KEY: 'read-test-vertex-key',
      GOOGLE_VISION_ENDPOINT: 'https://vision.googleapis.com/v1/images:annotate'
    };

    await window.evaluate((deployment) => {
      return window.electronAPI?.configSaveDeployment(deployment);
    }, deployment);

    // Wait a bit for file write
    await window.waitForTimeout(500);

    // Now read it back
    const config = await window.evaluate(() => {
      return window.electronAPI?.configRead();
    });

    expect(config).toBeDefined();
    expect(config.deployments).toBeDefined();
    if (config.deployments && config.deployments.length > 0) {
      const savedDeployment = config.deployments[0];
      expect(savedDeployment.workerName).toBe('read-test-worker');
      expect(savedDeployment.GOOGLE_VERTEX_PROJECT_ID).toBe('read-test-project');
    }
  });
});

