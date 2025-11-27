# Playwright Testing Setup for Electron App

## Installation

Install Playwright using pnpm:

```bash
cd electron-app
pnpm add -D @playwright/test
```

Then install Playwright browsers:
```bash
pnpm exec playwright install
```

## Running Tests

### Basic Commands

```bash
# Run all tests
npm test

# Run tests in UI mode (interactive)
npm run test:ui

# Run tests in headed mode (see the app)
npm run test:headed

# Run tests in debug mode
npm run test:debug

# Run specific test file
pnpm exec playwright test electron.spec.js

# Run with specific browser (if needed)
pnpm exec playwright test --project=electron
```

## Test Files

- `tests/electron.spec.js` - Main test suite covering:
  - App launch and window creation
  - UI element visibility
  - Form interactions
  - Button clicks
  - Vertex AI configuration fields
  
- `tests/example.spec.js` - Example patterns for:
  - Window properties
  - IPC communication
  - DOM manipulation

## Writing New Tests

### Basic Test Structure

```javascript
const { test, expect } = require('@playwright/test');
const { _electron } = require('@playwright/test');
const path = require('path');

test('my test', async () => {
  // Launch Electron app
  const electronApp = await _electron.launch({
    args: [path.join(__dirname, '..')],
    env: { NODE_ENV: 'test' },
  });
  
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  
  // Your test code
  const button = await window.locator('#my-button');
  await button.click();
  
  await electronApp.close();
});
```

### Testing IPC

```javascript
// Test IPC handlers
const result = await window.evaluate(() => {
  return window.electronAPI?.configRead();
});
```

### Testing Forms

```javascript
// Fill form fields
await window.locator('#form-name').fill('Test Value');

// Check values
const value = await window.locator('#form-name').inputValue();
expect(value).toBe('Test Value');
```

## Debugging

1. **Use test.only()** to run a single test:
   ```javascript
   test.only('my test', async () => { ... });
   ```

2. **Use --debug flag**:
   ```bash
   npm run test:debug
   ```

3. **Use --ui flag** for interactive mode:
   ```bash
   npm run test:ui
   ```

4. **Check screenshots** in `test-results/` folder

5. **View traces** in Playwright trace viewer:
   ```bash
   pnpm exec playwright show-trace test-results/trace.zip
   ```

## CI/CD Integration

For GitHub Actions or other CI:

```yaml
- name: Install pnpm
  uses: pnpm/action-setup@v2
  with:
    version: 8

- name: Install dependencies
  run: |
    cd electron-app
    pnpm install

- name: Install Playwright
  run: |
    cd electron-app
    pnpm exec playwright install --with-deps

- name: Run tests
  run: |
    cd electron-app
    pnpm test
```

## Troubleshooting

### Electron app doesn't launch
- Check that Electron is installed: `npm list electron`
- Verify the main entry point in package.json matches your file structure

### Tests timeout
- Increase timeout in `playwright.config.js`:
  ```javascript
  timeout: 60 * 1000, // 60 seconds
  ```

### Elements not found
- Add wait times: `await window.waitForTimeout(1000)`
- Use `waitForLoadState`: `await window.waitForLoadState('networkidle')`

### IPC not working
- Ensure preload.js is properly configured
- Check that contextBridge is exposing the API correctly

## Best Practices

1. **Isolate tests** - Each test should be independent
2. **Clean up** - Always close Electron app in afterAll/afterEach
3. **Wait for elements** - Don't assume immediate availability
4. **Use meaningful selectors** - Prefer IDs over complex CSS selectors
5. **Test user flows** - Test complete workflows, not just components

