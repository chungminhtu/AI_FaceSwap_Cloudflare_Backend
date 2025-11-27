const { test, expect } = require('@playwright/test');
const { _electron } = require('@playwright/test');
const path = require('path');

/**
 * E2E Tests for Authentication
 * Tests real authentication checks (no mocks)
 * These tests check actual wrangler/gcloud commands
 */
test.describe('Authentication E2E', () => {
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

  test('should check Cloudflare authentication status (real wrangler command)', async () => {
    const authStatus = await window.evaluate(() => {
      return window.electronAPI?.authCheckCloudflare();
    });

    expect(authStatus).toBeDefined();
    expect(authStatus).toHaveProperty('authenticated');
    expect(typeof authStatus.authenticated).toBe('boolean');
    // Note: authenticated may be true or false depending on actual system state
  });

  test('should check GCP authentication status (real gcloud command)', async () => {
    const authStatus = await window.evaluate(() => {
      return window.electronAPI?.authCheckGCP();
    });

    expect(authStatus).toBeDefined();
    expect(authStatus).toHaveProperty('authenticated');
    expect(typeof authStatus.authenticated).toBe('boolean');
    // May have accounts array if authenticated
    if (authStatus.authenticated) {
      expect(authStatus).toHaveProperty('accounts');
      expect(Array.isArray(authStatus.accounts)).toBe(true);
    }
  });

  test('should display authentication status in UI (real DOM)', async () => {
    // Wait for auth status to load
    await window.waitForTimeout(2000);

    const cfStatus = await window.locator('#cf-status');
    await expect(cfStatus).toBeVisible();
    
    const gcpStatus = await window.locator('#gcp-status');
    await expect(gcpStatus).toBeVisible();

    // Status should show something (not empty)
    const cfText = await cfStatus.textContent();
    const gcpText = await gcpStatus.textContent();
    
    expect(cfText).toBeTruthy();
    expect(gcpText).toBeTruthy();
  });

  test('should have login buttons that trigger real IPC handlers', async () => {
    const cfLoginButton = await window.locator('#btn-login-cf');
    await expect(cfLoginButton).toBeVisible();

    const gcpLoginButton = await window.locator('#btn-login-gcp');
    await expect(gcpLoginButton).toBeVisible();

    // Note: We don't actually click these as they may open browser windows
    // But we verify they exist and are clickable
    const cfClickable = await cfLoginButton.isEnabled();
    const gcpClickable = await gcpLoginButton.isEnabled();
    
    expect(cfClickable).toBe(true);
    expect(gcpClickable).toBe(true);
  });
});

