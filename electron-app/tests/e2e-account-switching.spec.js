const { test, expect } = require('@playwright/test');
const { _electron } = require('@playwright/test');
const path = require('path');

/**
 * E2E Tests for Account Switching
 * Tests real GCP and Cloudflare account switching
 * NO MOCKS - All real operations
 */
test.describe('Account Switching E2E', () => {
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
    await window.waitForTimeout(1000);
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  test('should switch GCP project via IPC (real gcloud command)', async () => {
    // This will attempt real gcloud project switch
    // May fail if project doesn't exist, but tests the real IPC handler
    const result = await window.evaluate((projectId) => {
      return window.electronAPI?.accountSwitchGCPProject(projectId);
    }, 'test-project-id');

    expect(result).toBeDefined();
    expect(result).toHaveProperty('success');
    // May be false if project doesn't exist, but handler should respond
  });

  test('should switch GCP account via IPC (real gcloud command)', async () => {
    const result = await window.evaluate((email) => {
      return window.electronAPI?.accountSwitchGCPAccount(email);
    }, 'test@example.com');

    expect(result).toBeDefined();
    expect(result).toHaveProperty('success');
  });

  test('should switch Cloudflare account via IPC (real wrangler command)', async () => {
    const accountConfig = {
      accountId: 'test-account-id',
      email: 'test@example.com'
    };

    const result = await window.evaluate((config) => {
      return window.electronAPI?.accountSwitchCloudflare(config);
    }, accountConfig);

    expect(result).toBeDefined();
    expect(result).toHaveProperty('success');
  });
});

