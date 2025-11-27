const { test, expect } = require('@playwright/test');
const { _electron } = require('@playwright/test');
const path = require('path');

test.describe('Electron App Tests', () => {
  let electronApp;
  let window;

  test.beforeAll(async () => {
    // Launch Electron app
    electronApp = await _electron.launch({
      args: [path.join(__dirname, '..')],
      env: {
        ...process.env,
        // Disable auto-reload in tests
        NODE_ENV: 'test',
      },
    });

    // Get the first window
    window = await electronApp.firstWindow();
    
    // Wait for the window to be ready
    await window.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('should launch Electron app successfully', async () => {
    expect(electronApp).toBeTruthy();
    expect(window).toBeTruthy();
  });

  test('should display the main window with correct title', async () => {
    const title = await window.title();
    expect(title).toContain('RoosterX AI');
  });

  test('should load dashboard elements', async () => {
    // Check for main sections
    const header = await window.locator('.app-header h1');
    await expect(header).toBeVisible();
    await expect(header).toContainText('RoosterX AI');

    // Check for sidebar
    const sidebar = await window.locator('.sidebar');
    await expect(sidebar).toBeVisible();

    // Check for deployment list section
    const deploymentList = await window.locator('#deployment-list-section');
    await expect(deploymentList).toBeVisible();
  });

  test('should show authentication status section', async () => {
    const authSection = await window.locator('.auth-status-section');
    await expect(authSection).toBeVisible();

    // Check for Cloudflare status
    const cfStatus = await window.locator('#cf-status');
    await expect(cfStatus).toBeVisible();

    // Check for GCP status
    const gcpStatus = await window.locator('#gcp-status');
    await expect(gcpStatus).toBeVisible();
  });

  test('should have "Add Deployment" button', async () => {
    const addButton = await window.locator('#btn-add-deployment');
    await expect(addButton).toBeVisible();
    await expect(addButton).toContainText('Deploy store mới');
  });

  test('should open deployment form when clicking Add button', async () => {
    const addButton = await window.locator('#btn-add-deployment');
    await addButton.click();

    // Wait for form to appear
    const formSection = await window.locator('#deployment-form-section');
    await expect(formSection).toBeVisible({ timeout: 5000 });
    await expect(formSection).not.toHaveClass(/hidden/);

    // Check form title
    const formTitle = await window.locator('#form-title');
    await expect(formTitle).toBeVisible();
  });

  test('should have deployment form fields', async () => {
    // Open form first
    const addButton = await window.locator('#btn-add-deployment');
    await addButton.click();

    await window.waitForTimeout(500); // Wait for form to render

    // Check for required form fields
    const formName = await window.locator('#form-name');
    await expect(formName).toBeVisible();

    const workerName = await window.locator('#form-worker-name');
    await expect(workerName).toBeVisible();

    const pagesName = await window.locator('#form-pages-name');
    await expect(pagesName).toBeVisible();

    const databaseName = await window.locator('#form-database-name');
    await expect(databaseName).toBeVisible();

    const bucketName = await window.locator('#form-bucket-name');
    await expect(bucketName).toBeVisible();
  });

  test('should have Vertex AI configuration fields', async () => {
    // Open form first
    const addButton = await window.locator('#btn-add-deployment');
    await addButton.click();

    await window.waitForTimeout(500); // Wait for form to render

    // Check for Vertex AI fields
    const vertexProjectId = await window.locator('#form-secret-google-vertex-project-id');
    await expect(vertexProjectId).toBeVisible();

    const vertexLocation = await window.locator('#form-secret-google-vertex-location');
    await expect(vertexLocation).toBeVisible();

    const vertexApiKey = await window.locator('#form-secret-google-vertex-key');
    await expect(vertexApiKey).toBeVisible();
  });

  test('should close form when clicking cancel', async () => {
    // Open form first
    const addButton = await window.locator('#btn-add-deployment');
    await addButton.click();

    await window.waitForTimeout(500);

    // Click cancel
    const cancelButton = await window.locator('#btn-cancel-form');
    await cancelButton.click();

    // Form should be hidden
    const formSection = await window.locator('#deployment-form-section');
    await expect(formSection).toHaveClass(/hidden/);

    // List should be visible
    const listSection = await window.locator('#deployment-list-section');
    await expect(listSection).toBeVisible();
    await expect(listSection).not.toHaveClass(/hidden/);
  });

  test('should have codebase path selector', async () => {
    const codebasePathInput = await window.locator('#codebase-path');
    await expect(codebasePathInput).toBeVisible();

    const selectButton = await window.locator('#btn-select-codebase');
    await expect(selectButton).toBeVisible();
  });

  test('should have export config button', async () => {
    const exportButton = await window.locator('#btn-export-config');
    await expect(exportButton).toBeVisible();
    await expect(exportButton).toContainText('Xuất Tất cả Config');
  });

  test('should have setup guide button', async () => {
    const setupButton = await window.locator('#btn-setup-guide');
    await expect(setupButton).toBeVisible();
    await expect(setupButton).toContainText('Hướng dẫn Thiết lập');
  });

  test('should display toast notifications', async () => {
    // Trigger a toast (if window.toast is available)
    await window.evaluate(() => {
      if (window.toast) {
        window.toast.info('Test notification');
      }
    });

    // Check if toast container exists
    const toastContainer = await window.locator('#toast-container');
    await expect(toastContainer).toBeVisible();
  });

  test('should have authentication login buttons', async () => {
    const cfLoginButton = await window.locator('#btn-login-cf');
    await expect(cfLoginButton).toBeVisible();
    await expect(cfLoginButton).toContainText('Đăng nhập Cloudflare');

    const gcpLoginButton = await window.locator('#btn-login-gcp');
    await expect(gcpLoginButton).toBeVisible();
    await expect(gcpLoginButton).toContainText('Đăng nhập GCP');
  });
});

test.describe('Deployment Form Tests', () => {
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
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('should fill form with test data', async () => {
    // Open form
    const addButton = await window.locator('#btn-add-deployment');
    await addButton.click();
    await window.waitForTimeout(500);

    // Fill form fields
    await window.locator('#form-name').fill('Test Deployment');
    await window.locator('#form-worker-name').fill('test-worker');
    await window.locator('#form-pages-name').fill('test-pages');
    await window.locator('#form-database-name').fill('test-db');
    await window.locator('#form-bucket-name').fill('test-bucket');

    // Verify values
    const nameValue = await window.locator('#form-name').inputValue();
    expect(nameValue).toBe('Test Deployment');

    const workerValue = await window.locator('#form-worker-name').inputValue();
    expect(workerValue).toBe('test-worker');
  });

  test('should validate required fields', async () => {
    // Open form
    const addButton = await window.locator('#btn-add-deployment');
    await addButton.click();
    await window.waitForTimeout(500);

    // Check that required fields are marked
    const nameField = await window.locator('#form-name');
    const isRequired = await nameField.getAttribute('required');
    expect(isRequired).not.toBeNull();
  });
});

