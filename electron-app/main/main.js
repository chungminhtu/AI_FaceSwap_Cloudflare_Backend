const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ConfigManager = require('./config-manager');
const AuthChecker = require('./auth-checker');
const AccountSwitcher = require('./account-switcher');
const DeploymentEngine = require('./deployment-engine');
const CommandRunner = require('./command-runner');

let mainWindow;
let isDeploying = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload.js')
    }
  });

  const rendererPath = path.join(__dirname, '../renderer/index.html');
  mainWindow.loadFile(rendererPath);

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers

// Config Management
ipcMain.handle('config:read', async () => {
  return ConfigManager.read();
});

ipcMain.handle('config:write', async (event, config) => {
  return ConfigManager.write(config);
});

ipcMain.handle('config:validate', async (event, config) => {
  return ConfigManager.validate(config);
});

// Authentication
ipcMain.handle('auth:check-cloudflare', async () => {
  return await AuthChecker.checkCloudflare();
});

ipcMain.handle('auth:check-gcp', async () => {
  return await AuthChecker.checkGCP();
});

ipcMain.handle('auth:login-cloudflare', async () => {
  return await AuthChecker.loginCloudflare();
});

ipcMain.handle('auth:login-gcp', async () => {
  return await AuthChecker.loginGCP();
});

// Account Switching
ipcMain.handle('account:switch-gcp-project', async (event, projectId) => {
  return await AccountSwitcher.switchGCPProject(projectId);
});

ipcMain.handle('account:switch-gcp-account', async (event, email) => {
  return await AccountSwitcher.switchGCPAccount(email);
});

ipcMain.handle('account:switch-cloudflare', async (event, accountConfig) => {
  return await AccountSwitcher.switchCloudflare(accountConfig);
});

// Deployment
ipcMain.handle('deployment:start', async (event, deploymentId) => {
  if (isDeploying) {
    return { success: false, error: 'Another deployment is already in progress' };
  }

  isDeploying = true;
  
  try {
    const config = ConfigManager.read();
    const deployment = config.deployments.find(d => d.id === deploymentId);
    
    if (!deployment) {
      throw new Error('Deployment not found');
    }

    // Set up progress reporting
    const reportProgress = (step, status, details) => {
      mainWindow.webContents.send('deployment:progress', {
        deploymentId,
        step,
        status,
        details
      });
    };

    const result = await DeploymentEngine.deploy(deployment, config, reportProgress);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  } finally {
    isDeploying = false;
  }
});

ipcMain.handle('deployment:check-status', async () => {
  return { isDeploying };
});

// File dialogs
ipcMain.handle('dialog:select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  
  if (result.canceled) {
    return null;
  }
  
  return result.filePaths[0];
});

ipcMain.handle('dialog:save-config', async (event, configJson) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'JSON', extensions: ['json'] }
    ],
    defaultPath: 'deployments-config-backup.json'
  });
  
  if (result.canceled) {
    return { success: false };
  }
  
  try {
    fs.writeFileSync(result.filePath, configJson, 'utf8');
    return { success: true, path: result.filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dialog:load-config', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'JSON', extensions: ['json'] }
    ],
    properties: ['openFile']
  });
  
  if (result.canceled) {
    return { success: false };
  }
  
  try {
    const content = fs.readFileSync(result.filePaths[0], 'utf8');
    const config = JSON.parse(content);
    return { success: true, config };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Command Execution
const commandRunner = new CommandRunner();

ipcMain.handle('command:execute', async (event, command, cwd) => {
  try {
    const result = await commandRunner.execute(command, {
      cwd: cwd || process.cwd(),
      silent: false,
      throwOnError: false,
      timeout: 120000 // 2 minutes
    });
    
    return {
      success: result.success,
      output: result.output || '',
      error: result.error || null
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Command execution failed',
      output: ''
    };
  }
});

