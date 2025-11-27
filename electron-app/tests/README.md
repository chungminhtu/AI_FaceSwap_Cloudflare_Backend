# Electron App Testing with Playwright

This directory contains automated tests for the Electron deployment app using Playwright.

## Setup

1. Install dependencies:
```bash
cd electron-app
pnpm install
```

2. Install Playwright browsers (if needed):
```bash
pnpm exec playwright install
```

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in UI mode (interactive)
```bash
npm run test:ui
```

### Run tests in headed mode (see browser)
```bash
npm run test:headed
```

### Run tests in debug mode
```bash
npm run test:debug
```

### Run specific test file
```bash
pnpm exec playwright test electron.spec.js
```

## Test Structure

- `electron.spec.js` - Main test suite for Electron app functionality
- `example.spec.js` - Example tests showing testing patterns

## Writing Tests

### Basic Test Structure

```javascript
const { test, expect } = require('@playwright/test');
const { _electron } = require('@playwright/test');
const path = require('path');

test('my test', async () => {
  // Launch Electron app
  const electronApp = await _electron.launch({
    args: [path.join(__dirname, '..')],
  });
  
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  
  // Your test code here
  const button = await window.locator('#my-button');
  await button.click();
  
  await electronApp.close();
});
```

### Testing IPC Communication

```javascript
// Test IPC handlers
const result = await window.evaluate(() => {
  return window.electronAPI?.configRead();
});
```

### Testing UI Elements

```javascript
// Check visibility
await expect(window.locator('#my-element')).toBeVisible();

// Check text content
await expect(window.locator('#my-element')).toContainText('Expected Text');

// Fill form fields
await window.locator('#form-field').fill('value');

// Click buttons
await window.locator('#my-button').click();
```

## Best Practices

1. **Use beforeAll/afterAll** for expensive setup (launching Electron)
2. **Use beforeEach/afterEach** for test isolation
3. **Wait for elements** - Use `waitForLoadState` and `waitForTimeout` when needed
4. **Clean up** - Always close Electron app in afterAll/afterEach
5. **Test user flows** - Test complete workflows, not just individual components

## Debugging

1. Use `test.only()` to run a single test
2. Use `test.debug()` to pause execution
3. Use `--headed` flag to see the browser
4. Use `--ui` flag for interactive debugging
5. Check `test-results/` for screenshots and traces

## CI/CD Integration

Tests can be run in CI/CD pipelines. Make sure to:
- Set `CI=true` environment variable
- Install dependencies with `pnpm install`
- Run `pnpm exec playwright install --with-deps`

Example GitHub Actions:
```yaml
- name: Install Playwright
  run: npx playwright install --with-deps

- name: Run tests
  run: npm test
```

