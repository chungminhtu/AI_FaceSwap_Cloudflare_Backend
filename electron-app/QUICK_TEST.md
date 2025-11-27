# Quick Test Guide (pnpm)

## Installation ✅ (Already Done)

```bash
cd electron-app
pnpm add -D @playwright/test
pnpm exec playwright install
```

## Run Tests

```bash
# Run all tests
pnpm test

# Interactive UI mode (best for development)
pnpm run test:ui

# See the app while testing
pnpm run test:headed

# Debug mode (step through tests)
pnpm run test:debug

# Run specific test file
pnpm exec playwright test electron.spec.js

# List all tests
pnpm exec playwright test --list
```

## Test Files

- `tests/electron.spec.js` - 15+ tests covering main functionality
- `tests/example.spec.js` - Example patterns

## Quick Test Run

```bash
cd electron-app
pnpm test
```

That's it! 🚀

