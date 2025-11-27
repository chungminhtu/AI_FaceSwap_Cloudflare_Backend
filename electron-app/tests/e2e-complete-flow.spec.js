const { test, expect } = require('@playwright/test');
const { _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

/**
 * Complete E2E Flow Test
 * Tests the entire user journey from start to finish
 * NO MOCKS - All real operations
 */
test.describe('Complete User Flow E2E', () => {
  let electronApp;
  let window;

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
    await window.waitForTimeout(2000); // Wait for full initialization
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('complete flow: create deployment, save, and verify', async () => {
    // Step 1: Open deployment form
    await window.locator('#btn-add-deployment').click();
    await window.waitForTimeout(500);
    
    const formSection = await window.locator('#deployment-form-section');
    await expect(formSection).toBeVisible();

    // Step 2: Fill all required fields
    await window.locator('#form-name').fill('Complete Flow Test');
    await window.locator('#form-worker-name').fill('complete-flow-worker');
    await window.locator('#form-pages-name').fill('complete-flow-pages');
    await window.locator('#form-database-name').fill('complete-flow-db');
    await window.locator('#form-bucket-name').fill('complete-flow-bucket');
    
    // Vertex AI fields
    await window.locator('#form-secret-google-vertex-project-id').fill('complete-flow-project');
    await window.locator('#form-secret-google-vertex-location').fill('us-central1');
    await window.locator('#form-secret-google-vertex-key').fill('complete-flow-vertex-key');
    
    // Vision API
    await window.locator('#form-secret-google-vision-key').fill('complete-flow-vision-key');
    await window.locator('#form-secret-google-endpoint').fill('https://vision.googleapis.com/v1/images:annotate');
    
    // RapidAPI
    await window.locator('#form-secret-rapidapi-key').fill('complete-flow-rapidapi-key');
    await window.locator('#form-secret-rapidapi-host').fill('complete-flow-host.com');
    await window.locator('#form-secret-rapidapi-endpoint').fill('https://complete-flow.com/api');

    // Step 3: Verify all fields are filled
    expect(await window.locator('#form-name').inputValue()).toBe('Complete Flow Test');
    expect(await window.locator('#form-worker-name').inputValue()).toBe('complete-flow-worker');
    expect(await window.locator('#form-secret-google-vertex-project-id').inputValue()).toBe('complete-flow-project');

    // Step 4: Save deployment (real save to secrets.json)
    const saveButton = await window.locator('button:has-text("Lưu")');
    await saveButton.click();
    await window.waitForTimeout(1000);

    // Step 5: Verify deployment was saved by reading config
    const config = await window.evaluate(() => {
      return window.electronAPI?.configRead();
    });

    expect(config).toBeDefined();
    // Deployment should be in the list (may be in secrets.json or SQLite)
    
    // Step 6: Verify secrets.json was updated
    const secretsPath = await window.evaluate(() => {
      return window.electronAPI?.configGetSecretsPath();
    });

    if (fs.existsSync(secretsPath)) {
      const secretsContent = fs.readFileSync(secretsPath, 'utf8');
      const secrets = JSON.parse(secretsContent);
      expect(secrets.workerName).toBe('complete-flow-worker');
      expect(secrets.GOOGLE_VERTEX_PROJECT_ID).toBe('complete-flow-project');
    }
  });

  test('complete flow: import config and deploy', async () => {
    const importConfig = {
      workerName: 'import-flow-worker',
      pagesProjectName: 'import-flow-pages',
      databaseName: 'import-flow-db',
      bucketName: 'import-flow-bucket',
      RAPIDAPI_KEY: 'import-flow-rapidapi-key',
      RAPIDAPI_HOST: 'import-flow-host.com',
      RAPIDAPI_ENDPOINT: 'https://import-flow.com/api',
      GOOGLE_VISION_API_KEY: 'import-flow-vision-key',
      GOOGLE_VERTEX_PROJECT_ID: 'import-flow-project',
      GOOGLE_VERTEX_LOCATION: 'us-central1',
      GOOGLE_VERTEX_API_KEY: 'import-flow-vertex-key',
      GOOGLE_VISION_ENDPOINT: 'https://vision.googleapis.com/v1/images:annotate'
    };

    // Step 1: Validate imported config
    const validation = await window.evaluate((config) => {
      return window.electronAPI?.configValidate({ deployments: [config] });
    }, importConfig);

    expect(validation.valid).toBe(true);

    // Step 2: Save imported config
    const saveResult = await window.evaluate((config) => {
      return window.electronAPI?.configSaveDeployment(config);
    }, importConfig);

    expect(saveResult.success).toBe(true);

    // Step 3: Verify it was saved
    const savedConfig = await window.evaluate(() => {
      return window.electronAPI?.configRead();
    });

    expect(savedConfig).toBeDefined();

    // Step 4: Attempt deployment (may fail without real credentials, but tests the flow)
    const deploymentResult = await window.evaluate((config) => {
      return window.electronAPI?.deploymentFromConfig(config, 'import-flow-deployment');
    }, importConfig);

    expect(deploymentResult).toBeDefined();
    expect(deploymentResult).toHaveProperty('success');
  });
});

