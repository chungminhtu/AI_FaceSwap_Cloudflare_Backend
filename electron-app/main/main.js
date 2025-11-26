const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ConfigManager = require('./config-manager');
const AuthChecker = require('./auth-checker');
const AccountSwitcher = require('./account-switcher');
// Import unified deployment utilities
const { deployFromConfig } = require('../../deploy.js');

// Auto-reload in development
if (process.argv.includes('--dev')) {
  try {
    const electronPath = require('electron');
    const appRoot = path.join(__dirname, '..');
    
    require('electron-reload')(appRoot, {
      electron: electronPath,
      hardResetMethod: 'exit',
      // Watch all files in electron-app directory
      chokidar: {
        ignored: /node_modules|\.git|dist/,
        usePolling: true
      }
    });
    
    console.log('[DEV] Auto-reload enabled for:', appRoot);
  } catch (error) {
    console.warn('[DEV] Failed to enable auto-reload:', error.message);
  }
}

let mainWindow;
let isDeploying = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'RoosterX AI - Face Swap Deployment Tool',
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

app.on('before-quit', () => {
  // Close database connection before quitting
  if (ConfigManager && typeof ConfigManager.close === 'function') {
    ConfigManager.close();
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
  try {
    console.log('[main] Starting Cloudflare login...');
    const result = await AuthChecker.loginCloudflare();
    console.log('[main] Cloudflare login completed:', result);
    return result;
  } catch (error) {
    console.error('[main] Cloudflare login error:', error);
    return {
      success: false,
      error: error.message || 'Login failed',
      email: null
    };
  }
});

ipcMain.handle('auth:login-gcp', async () => {
  try {
    console.log('[main] Starting GCP login...');
    const result = await AuthChecker.loginGCP();
    console.log('[main] GCP login completed:', result);
    return result;
  } catch (error) {
    console.error('[main] GCP login error:', error);
    return {
      success: false,
      error: error.message || 'Login failed',
      accounts: [],
      currentAccount: null
    };
  }
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

// Deployment from secrets.json
ipcMain.handle('deployment:start', async (event, deploymentId) => {
  if (isDeploying) {
    return { success: false, error: 'Another deployment is already in progress' };
  }

  isDeploying = true;
  
  try {
    // Set up progress reporting
    const reportProgress = (step, status, details, data) => {
      const progressData = {
        deploymentId: deploymentId || 'secrets-deployment',
        step,
        status,
        details
      };
      
      // Pass log data if available
      if (data && data.log) {
        progressData.log = data.log;
      }
      
      mainWindow.webContents.send('deployment:progress', progressData);
    };

    // Get codebase path from config
      const config = ConfigManager.read();
    const codebasePath = config.codebasePath || process.cwd();

    // Load and deploy from secrets.json directly
    const result = await deployFromConfig(null, reportProgress);
    
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

// Deploy from JSON configuration (same as CLI)
ipcMain.handle('deployment:from-config', async (event, configObject, deploymentId) => {
  if (isDeploying) {
    return { success: false, error: 'Another deployment is already in progress' };
  }

  isDeploying = true;

  try {
    // Set up progress reporting
    const reportProgress = (step, status, details, data) => {
      const progressData = {
        deploymentId: deploymentId || 'direct-deployment',
        step,
        status,
        details
      };

      if (data && data.log) {
        progressData.log = data.log;
      }

      mainWindow.webContents.send('deployment:progress', progressData);
    };

    const result = await deployFromConfig(configObject, reportProgress);

    return {
      success: true,
      result
    };
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

// Helper functions to fetch account info
ipcMain.handle('helper:get-cloudflare-info', async () => {
  try {
    const cfCheck = await AuthChecker.checkCloudflare();
    if (!cfCheck.authenticated) {
      return { success: false, error: 'Not authenticated with Cloudflare' };
    }

    const { execSync } = require('child_process');
    const os = require('os');
    let accountId = null;
    
    // Method 1: Try to get account ID from wrangler whoami output
    try {
      const whoamiOutput = execSync('wrangler whoami', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });
      
      // Try to extract account ID from output
      const accountIdMatch = whoamiOutput.match(/account ID:?\s*([a-f0-9]{32})/i);
      if (accountIdMatch) {
        accountId = accountIdMatch[1];
      }
    } catch (error) {
      // Ignore
    }
    
    // Method 2: Try to get from wrangler.jsonc or wrangler.toml in codebase
    if (!accountId) {
      try {
        const config = ConfigManager.read();
        const codebasePath = config?.codebasePath || process.cwd();
        
        const wranglerPaths = [
          require('path').join(codebasePath, 'wrangler.jsonc'),
          require('path').join(codebasePath, 'wrangler.toml'),
          require('path').join(codebasePath, 'wrangler.json')
        ];
        
        for (const wranglerPath of wranglerPaths) {
          if (fs.existsSync(wranglerPath)) {
            const wranglerContent = fs.readFileSync(wranglerPath, 'utf8');
            // Try JSON format
            let accountIdMatch = wranglerContent.match(/"account_id"\s*:\s*"([^"]+)"/);
            if (!accountIdMatch) {
              // Try TOML format
              accountIdMatch = wranglerContent.match(/account_id\s*=\s*"([^"]+)"/);
            }
            if (accountIdMatch) {
              accountId = accountIdMatch[1];
              break;
            }
          }
        }
      } catch (e) {
        // Ignore
      }
    }
    
    // Method 3: Try to get from wrangler config directory (where OAuth token is stored)
    if (!accountId) {
      try {
        const os = require('os');
        const homedir = os.homedir();
        const wranglerConfigPath = require('path').join(
          homedir,
          '.wrangler',
          'config',
          'default.toml'
        );
        
        if (fs.existsSync(wranglerConfigPath)) {
          const configContent = fs.readFileSync(wranglerConfigPath, 'utf8');
          const accountIdMatch = configContent.match(/account_id\s*=\s*"([^"]+)"/);
          if (accountIdMatch) {
            accountId = accountIdMatch[1];
          }
        }
      } catch (e) {
        // Ignore
      }
    }
    
    // Method 4: Use Cloudflare API with wrangler's OAuth token
    if (!accountId) {
      try {
        const os = require('os');
        const homedir = os.homedir();
        const wranglerConfigPath = require('path').join(
          homedir,
          '.wrangler',
          'config',
          'default.toml'
        );
        
        if (fs.existsSync(wranglerConfigPath)) {
          const configContent = fs.readFileSync(wranglerConfigPath, 'utf8');
          // Try to extract API token or OAuth token
          let apiToken = null;
          const tokenMatch = configContent.match(/api_token\s*=\s*"([^"]+)"/);
          if (tokenMatch) {
            apiToken = tokenMatch[1];
          }
          
          // If we have a token, try Cloudflare API
          if (apiToken) {
            try {
              const https = require('https');
              const url = require('url');
              
              const apiUrl = 'https://api.cloudflare.com/client/v4/accounts';
              const parsedUrl = url.parse(apiUrl);
              
              // Use execSync with curl first (more reliable)
              try {
                const curlOutput = execSync(
                  `curl -s -X GET "${apiUrl}" -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json"`,
                  {
                    encoding: 'utf8',
                    stdio: ['pipe', 'pipe', 'pipe'],
                    timeout: 10000
                  }
                );
                
                const apiResponse = JSON.parse(curlOutput);
                if (apiResponse.success && apiResponse.result && apiResponse.result.length > 0) {
                  accountId = apiResponse.result[0].id;
                }
              } catch (curlError) {
                // curl might not be available, try node https
                console.log('curl not available, trying node https');
                
                // Fallback: Use Node.js https module
                const options = {
                  hostname: parsedUrl.hostname,
                  path: parsedUrl.path,
                  method: 'GET',
                  headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                  },
                  timeout: 10000
                };
                
                await new Promise((resolve, reject) => {
                  const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                      data += chunk;
                    });
                    res.on('end', () => {
                      try {
                        const apiResponse = JSON.parse(data);
                        if (apiResponse.success && apiResponse.result && apiResponse.result.length > 0) {
                          accountId = apiResponse.result[0].id;
                        }
                        resolve();
                      } catch (parseError) {
                        reject(parseError);
                      }
                    });
                  });
                  
                  req.on('error', reject);
                  req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                  });
                  
                  req.end();
                });
              }
            } catch (apiError) {
              console.log('API call failed:', apiError.message);
            }
          }
          
          // Also check for OAuth token in wrangler config (different format)
          if (!accountId) {
            try {
              const oauthTokenMatch = configContent.match(/oauth_token\s*=\s*"([^"]+)"/);
              if (oauthTokenMatch) {
                const oauthToken = oauthTokenMatch[1];
                // Try API with OAuth token
                try {
                  const curlOutput = execSync(
                    `curl -s -X GET "https://api.cloudflare.com/client/v4/accounts" -H "Authorization: Bearer ${oauthToken}" -H "Content-Type: application/json"`,
                    {
                      encoding: 'utf8',
                      stdio: ['pipe', 'pipe', 'pipe'],
                      timeout: 10000,
                      throwOnError: false
                    }
                  );
                  
                  const apiResponse = JSON.parse(curlOutput);
                  if (apiResponse.success && apiResponse.result && apiResponse.result.length > 0) {
                    accountId = apiResponse.result[0].id;
                  }
                } catch (e) {
                  // Ignore
                }
              }
            } catch (e) {
              // Ignore
            }
          }
        }
      } catch (e) {
        // Ignore
      }
    }
    
    // Method 5: Try wrangler pages project list (might show account info)
    if (!accountId) {
      try {
        const pagesOutput = execSync('wrangler pages project list', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
          throwOnError: false
        });
        
        // Pages output might contain account ID in some format
        const accountIdMatch = pagesOutput.match(/([a-f0-9]{32})/i);
        if (accountIdMatch) {
          accountId = accountIdMatch[1];
        }
      } catch (error) {
        // Ignore
      }
    }

    return {
      success: true,
      email: cfCheck.email,
      accountId: accountId,
      message: accountId 
        ? 'Found account info automatically' 
        : 'Email found, but account ID not detected. You can find it in Cloudflare Dashboard > Workers & Pages > Overview'
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('helper:get-gcp-projects', async () => {
  try {
    const { execSync } = require('child_process');
    const gcpCheck = await AuthChecker.checkGCP();
    
    if (!gcpCheck.authenticated) {
      return { success: false, error: 'Not authenticated with GCP' };
    }

    // Get list of projects
    const projectsOutput = execSync('gcloud projects list --format="json"', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000
    });

    const projects = JSON.parse(projectsOutput);
    
    return {
      success: true,
      projects: projects.map(p => ({
        projectId: p.projectId,
        name: p.name || p.projectId
      })),
      currentAccount: gcpCheck.currentAccount
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


