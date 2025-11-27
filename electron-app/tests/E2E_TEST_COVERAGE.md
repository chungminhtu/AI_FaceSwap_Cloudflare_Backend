# E2E Test Coverage

## Overview

All tests are **100% E2E** - NO MOCKS, NO FAKES. Every test uses real:
- IPC communication
- File operations (secrets.json, SQLite)
- Command execution (wrangler, gcloud)
- UI interactions
- DOM manipulations
- Form validations

## Test Files

### 1. `e2e-config.spec.js` - Configuration Management
**Tests:**
- ✅ Real `ConfigManager.read()` via IPC
- ✅ Real `ConfigManager.saveDeployment()` to secrets.json
- ✅ Real file read/write operations
- ✅ Real configuration validation
- ✅ Real secrets.json path retrieval

**Coverage:** 6 tests

### 2. `e2e-auth.spec.js` - Authentication
**Tests:**
- ✅ Real `wrangler whoami` command execution
- ✅ Real `gcloud auth list` command execution
- ✅ Real authentication status checks
- ✅ Real UI status display
- ✅ Real login button handlers

**Coverage:** 4 tests

### 3. `e2e-deployment-form.spec.js` - Deployment Form
**Tests:**
- ✅ Real form opening/closing
- ✅ Real form field filling
- ✅ Real HTML5 validation
- ✅ Real save to secrets.json
- ✅ Real SQLite draft loading
- ✅ Real form cancel functionality

**Coverage:** 6 tests

### 4. `e2e-import-export.spec.js` - Import/Export
**Tests:**
- ✅ Real JSON parsing
- ✅ Real configuration validation
- ✅ Real export functionality
- ✅ Real import validation

**Coverage:** 4 tests

### 5. `e2e-deployment-flow.spec.js` - Deployment Operations
**Tests:**
- ✅ Real deployment status checks
- ✅ Real `deployFromConfig()` execution
- ✅ Real deployment progress events
- ✅ Real IPC event handling

**Coverage:** 3 tests

### 6. `e2e-account-switching.spec.js` - Account Switching
**Tests:**
- ✅ Real GCP project switching (gcloud commands)
- ✅ Real GCP account switching
- ✅ Real Cloudflare account switching (wrangler commands)

**Coverage:** 3 tests

### 7. `e2e-ui-interactions.spec.js` - UI Interactions
**Tests:**
- ✅ Real toast notification system
- ✅ Real modal system
- ✅ Real file dialog triggers
- ✅ Real form auto-save (SQLite)
- ✅ Real keyboard navigation
- ✅ Real DOM interactions

**Coverage:** 6 tests

### 8. `e2e-complete-flow.spec.js` - Complete User Flows
**Tests:**
- ✅ Complete flow: Create → Fill → Save → Verify
- ✅ Complete flow: Import → Validate → Deploy

**Coverage:** 2 tests

## Total Coverage

**34+ E2E Tests** covering:
- ✅ All IPC handlers
- ✅ All file operations
- ✅ All command executions
- ✅ All UI interactions
- ✅ All form operations
- ✅ All validation logic
- ✅ Complete user workflows

## Running Tests

```bash
# Run all e2e tests
pnpm test

# Run specific test file
pnpm exec playwright test e2e-config.spec.js

# Run in UI mode (recommended)
pnpm run test:ui

# Run in headed mode (see the app)
pnpm run test:headed
```

## What's Tested (Real Operations)

### Configuration Management
- Reading from SQLite database
- Writing to SQLite database
- Reading from secrets.json
- Writing to secrets.json
- Configuration validation
- Deployment saving

### Authentication
- Cloudflare authentication check (real wrangler)
- GCP authentication check (real gcloud)
- Authentication status display
- Login button functionality

### Deployment Form
- Form rendering
- Field filling
- HTML5 validation
- Auto-save to SQLite
- Auto-load from SQLite
- Save to secrets.json
- Form cancellation

### Import/Export
- JSON parsing
- Configuration validation
- Export functionality
- Import functionality

### Deployment Operations
- Deployment status checking
- Deployment execution (real deployFromConfig)
- Progress event handling
- Error handling

### Account Switching
- GCP project switching (real gcloud)
- GCP account switching (real gcloud)
- Cloudflare account switching (real wrangler)

### UI Interactions
- Toast notifications
- Modal dialogs
- File dialogs
- Keyboard navigation
- Form interactions
- DOM manipulations

## Important Notes

1. **No Mocks**: All tests use real implementations
2. **Real Commands**: Tests execute real `wrangler` and `gcloud` commands
3. **Real Files**: Tests read/write real `secrets.json` and SQLite files
4. **Real IPC**: All IPC communication is real, not mocked
5. **Real UI**: All UI interactions are real DOM manipulations

## Test Environment

Tests run with:
- Real Electron app instance
- Real file system operations
- Real command execution
- Real IPC communication
- Real database operations

No test doubles, mocks, or fakes are used anywhere.

