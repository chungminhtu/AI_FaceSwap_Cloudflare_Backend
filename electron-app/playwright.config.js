const { defineConfig } = require('@playwright/test');

/**
 * Playwright configuration for Electron app testing
 * 
 * Note: Playwright uses the _electron API for Electron testing.
 * Tests use _electron.launch() directly in test files.
 * 
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: false, // Electron tests should run sequentially
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: 1, // Electron apps should run one at a time
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html'],
    ['list'],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  /* Maximum time one test can run for. */
  timeout: 60 * 1000, // 60 seconds for e2e tests that may take longer
  
  /* Maximum time to wait for expect() assertions. */
  expect: {
    timeout: 5000,
  },
});

