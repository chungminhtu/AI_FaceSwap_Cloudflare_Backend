const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ConfigManager = require('./config-manager');
const AuthChecker = require('./auth-checker');
const AccountSwitcher = require('./account-switcher');
const CommandRunner = require('./command-runner');
const R2Manager = require('./r2-manager');
const { deployFromConfig } = require('../../deploy.js');

if (process.argv.includes('--dev')) {
  try {
    const electronPath = require('electron');
    const appRoot = path.join(__dirname, '..');

    require('electron-reload')(appRoot, {
      electron: electronPath,
      hardResetMethod: 'exit',
      chokidar: {
        ignored: /node_modules|\.git|dist/,
        usePolling: true
      }
    });
  } catch (error) {
    // Ignore auto-reload errors
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

ipcMain.handle('config:save-deployment', async (event, deployment) => {
  return ConfigManager.saveDeployment(deployment);
});

ipcMain.handle('config:get-secrets-path', async () => {
  return ConfigManager.getSecretsPath();
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
    return await AuthChecker.loginCloudflare();
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Login failed',
      email: null
    };
  }
});

ipcMain.handle('auth:login-gcp', async () => {
  try {
    return await AuthChecker.loginGCP();
  } catch (error) {
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

    const reportProgress = (step, status, details) => {
      mainWindow.webContents.send('deployment:progress', {
        deploymentId,
        step,
        status,
        details
      });
    };

    const deploymentConfig = {
      name: deployment.name || deployment.id,
      workerName: deployment.workerName,
      pagesProjectName: deployment.pagesProjectName,
      databaseName: deployment.databaseName,
      bucketName: deployment.bucketName,
      cloudflare: {
        accountId: deployment.cloudflare?.accountId || '',
        apiToken: deployment.cloudflare?.apiToken || ''
      },
      gcp: {
        projectId: deployment.gcp?.projectId || '',
        private_key: deployment.gcp?.private_key || '',
        client_email: deployment.gcp?.client_email || ''
      },
      deployPages: deployment.deployPages !== false,
      secrets: {
        RAPIDAPI_KEY: deployment.RAPIDAPI_KEY || deployment.secrets?.RAPIDAPI_KEY || '',
        RAPIDAPI_HOST: deployment.RAPIDAPI_HOST || deployment.secrets?.RAPIDAPI_HOST || '',
        RAPIDAPI_ENDPOINT: deployment.RAPIDAPI_ENDPOINT || deployment.secrets?.RAPIDAPI_ENDPOINT || '',
        GOOGLE_VISION_API_KEY: deployment.GOOGLE_VISION_API_KEY || deployment.secrets?.GOOGLE_VISION_API_KEY || '',
        GOOGLE_VERTEX_PROJECT_ID: deployment.GOOGLE_VERTEX_PROJECT_ID || deployment.secrets?.GOOGLE_VERTEX_PROJECT_ID || '',
        GOOGLE_VERTEX_LOCATION: deployment.GOOGLE_VERTEX_LOCATION || deployment.secrets?.GOOGLE_VERTEX_LOCATION || 'us-central1',
        GOOGLE_VISION_ENDPOINT: deployment.GOOGLE_VISION_ENDPOINT || deployment.secrets?.GOOGLE_VISION_ENDPOINT || '',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: deployment.GOOGLE_SERVICE_ACCOUNT_EMAIL || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: deployment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || ''
      }
    };

    const projectRoot = path.resolve(__dirname, '../../..');
    const codebasePath = projectRoot;
    
    const flags = {
      DEPLOY_SECRETS: true,
      DEPLOY_DB: true,
      DEPLOY_WORKER: true,
      DEPLOY_PAGES: deployment.deployPages !== false,
      DEPLOY_R2: true
    };
    
    const result = await deployFromConfig(deploymentConfig, reportProgress, codebasePath, flags);

    if (result.success) {
      const historyEntry = {
        id: `${deploymentId}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        endTime: new Date().toISOString(),
        status: 'success',
        results: {
          workerUrl: result.workerUrl,
          pagesUrl: result.pagesUrl
        }
      };

      ConfigManager.saveDeploymentHistory(deploymentId, historyEntry);
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  } finally {
    isDeploying = false;
  }
});

ipcMain.handle('deployment:check-status', async () => {
  return { isDeploying };
});

ipcMain.handle('deployment:from-config', async (event, configObject, deploymentId) => {
  if (isDeploying) {
    return { success: false, error: 'Another deployment is already in progress' };
  }

  isDeploying = true;

  try {
    const config = ConfigManager.read();
    const reportProgress = (step, status, details) => {
      mainWindow.webContents.send('deployment:progress', {
        deploymentId: deploymentId || 'direct-deployment',
        step,
        status,
        details
      });
    };

    const projectRoot = path.resolve(__dirname, '../../..');
    const codebasePath = projectRoot;
    
    const flags = {
      DEPLOY_SECRETS: true,
      DEPLOY_DB: true,
      DEPLOY_WORKER: true,
      DEPLOY_PAGES: configObject.deployPages !== false,
      DEPLOY_R2: true
    };
    
    const result = await deployFromConfig(configObject, reportProgress, codebasePath, flags);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message
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
    let whoamiOutput = '';
    
    // Method 1: Try JSON format first (most reliable, available in newer wrangler versions)
    try {
      try {
        // Try JSON format first
        whoamiOutput = execSync('wrangler whoami --format json', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });
      
        try {
          const jsonData = JSON.parse(whoamiOutput);
          if (jsonData.accountId) {
            accountId = jsonData.accountId.toLowerCase();
          } else if (jsonData.account && jsonData.account.id) {
            accountId = jsonData.account.id.toLowerCase();
          }
        } catch (jsonError) {
          // JSON parsing failed, fall through to text parsing
          console.log('[helper:get-cloudflare-info] JSON parsing failed, trying text format');
        }
      } catch (jsonCmdError) {
        // JSON format not available, try regular whoami
        console.log('[helper:get-cloudflare-info] JSON format not available, using text format');
        whoamiOutput = execSync('wrangler whoami', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000
        });
      }
      
      // Method 2: Parse table format from text output
      if (!accountId && whoamiOutput) {
      const lines = whoamiOutput.split('\n');
      for (const line of lines) {
          // Skip header lines and separator lines
          if (line.includes('Account Name') || line.includes('Account ID') || line.trim().match(/^[│\s\-]+$/)) {
            continue;
          }
          
        // Look for table row with Account ID (contains │ and hex string)
        if (line.includes('│') && /[a-f0-9]{32}/i.test(line)) {
          // Split by │ and find the hex string (32 chars)
            // Filter out empty strings and pipe characters
            const parts = line.split('│')
              .map(p => p.trim())
              .filter(p => p && p !== '│' && p.length > 0);
            
          for (const part of parts) {
              // Look for 32-character hex string
            const idMatch = part.match(/([a-f0-9]{32})/i);
            if (idMatch && idMatch[1].length === 32) {
                accountId = idMatch[1].toLowerCase();
              break;
            }
          }
          if (accountId) break;
          }
        }
      }
      
      // Method 3: Fallback - Try simple regex patterns
      if (!accountId && whoamiOutput) {
        // Pattern 1: "Account ID: 72474c350e3f55d96195536a5d39e00d"
        const accountIdMatch1 = whoamiOutput.match(/account\s+id:?\s*([a-f0-9]{32})/i);
        if (accountIdMatch1) {
          accountId = accountIdMatch1[1].toLowerCase();
        }
      }
      
      // Method 4: Fallback - Any 32-char hex string (but filter out common false positives)
      if (!accountId && whoamiOutput) {
        const hexMatches = whoamiOutput.match(/\b([a-f0-9]{32})\b/gi);
        if (hexMatches && hexMatches.length > 0) {
          // Filter out matches that are clearly not account IDs (e.g., in URLs, paths)
          const validMatches = hexMatches.filter(match => {
            const lowerMatch = match.toLowerCase();
            // Account IDs are typically lowercase and not part of URLs
            return !whoamiOutput.toLowerCase().includes(`http://${lowerMatch}`) &&
                   !whoamiOutput.toLowerCase().includes(`https://${lowerMatch}`);
          });
          
          if (validMatches.length > 0) {
          // Use the last match (usually the Account ID)
            accountId = validMatches[validMatches.length - 1].toLowerCase();
          }
        }
      }
    } catch (error) {
      console.log('[helper:get-cloudflare-info] wrangler whoami failed:', error.message);
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
      return { 
        success: false, 
        error: 'Not authenticated with GCP. Please click "Đăng nhập GCP" to authenticate.',
        needsLogin: true
      };
    }

    // Try to use application-default credentials first (works in non-interactive mode)
    // If that fails, fall back to regular auth
    let projectsOutput;
    let useApplicationDefault = false;

    try {
      // First try with application-default credentials (non-interactive)
      projectsOutput = execSync('gcloud projects list --format="json"', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
        env: {
          ...process.env,
          // Try to use application-default credentials
          CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: process.env.GOOGLE_APPLICATION_CREDENTIALS || ''
        }
      });
    } catch (authError) {
      // If auth error, check if it's a reauthentication issue
      const errorMessage = authError.message || authError.stderr?.toString() || '';
      
      if (errorMessage.includes('reauthentication') || 
          errorMessage.includes('auth tokens') ||
          errorMessage.includes('cannot prompt during non-interactive')) {
        
        // Try to refresh tokens using application-default login
        try {
          // Check if application-default credentials exist
          execSync('gcloud auth application-default print-access-token', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000
          });
          
          // If we get here, application-default credentials work, retry with them
          projectsOutput = execSync('gcloud projects list --format="json"', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000
    });
          useApplicationDefault = true;
        } catch (appDefaultError) {
          // Application-default credentials also failed
          return {
            success: false,
            error: 'GCP authentication expired. Please run "gcloud auth login" or "gcloud auth application-default login" in your terminal, then refresh this page.',
            needsLogin: true,
            details: 'Reauthentication failed. Cannot prompt during non-interactive execution.'
          };
        }
      } else {
        // Other error
        throw authError;
      }
    }

    // Parse projects
    let projects;
    try {
      projects = JSON.parse(projectsOutput);
    } catch (parseError) {
      return {
        success: false,
        error: `Failed to parse GCP projects list: ${parseError.message}`,
        details: projectsOutput?.substring(0, 200)
      };
    }

    if (!Array.isArray(projects)) {
      return {
        success: false,
        error: 'Invalid response from GCP projects list',
        details: 'Expected array but got: ' + typeof projects
      };
    }
    
    return {
      success: true,
      projects: projects.map(p => ({
        projectId: p.projectId,
        name: p.name || p.projectId
      })),
      currentAccount: gcpCheck.currentAccount,
      usedApplicationDefault: useApplicationDefault
    };
  } catch (error) {
    const errorMessage = error.message || String(error);
    const errorDetails = error.stderr?.toString() || error.stdout?.toString() || '';
    
    // Check for specific authentication errors
    if (errorMessage.includes('reauthentication') || 
        errorMessage.includes('auth tokens') ||
        errorMessage.includes('cannot prompt during non-interactive')) {
      return {
        success: false,
        error: 'GCP authentication expired. Please run "gcloud auth login" or "gcloud auth application-default login" in your terminal.',
        needsLogin: true,
        details: 'Reauthentication failed. Cannot prompt during non-interactive execution.'
      };
    }
    
    return { 
      success: false, 
      error: errorMessage,
      details: errorDetails.substring(0, 500)
    };
  }
});

// Auto-fetch service account credentials
ipcMain.handle('helper:get-service-account-credentials', async () => {
  try {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    // Check GCP authentication
    const gcpCheck = await AuthChecker.checkGCP();
    if (!gcpCheck.authenticated) {
      return {
        success: false,
        error: 'Not authenticated with GCP. Please login first.',
        needsLogin: true
      };
    }

    // Get current project
    let projectId;
    try {
      projectId = execSync('gcloud config get-value project', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000
      }).trim();
      
      if (!projectId) {
        return {
          success: false,
          error: 'No GCP project set. Please set a project first.',
          needsProject: true
        };
      }
    } catch (error) {
      return {
        success: false,
        error: 'Failed to get GCP project: ' + (error.message || 'Unknown error'),
        needsProject: true
      };
    }

    // List service accounts
    let serviceAccounts;
    try {
      const saOutput = execSync(`gcloud iam service-accounts list --project=${projectId} --format="json"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });
      serviceAccounts = JSON.parse(saOutput);
    } catch (error) {
      return {
        success: false,
        error: 'Failed to list service accounts. You may need to create one manually in GCP Console.',
        details: error.message
      };
    }

    // Find or create a service account for Vertex AI
    let serviceAccount = serviceAccounts.find(sa => 
      sa.email && (
        sa.email.includes('vertex') || 
        sa.email.includes('ai') ||
        sa.displayName?.toLowerCase().includes('vertex') ||
        sa.displayName?.toLowerCase().includes('ai')
      )
    );

    // If no suitable service account found, use the first one or create a new one
    if (!serviceAccount && serviceAccounts.length > 0) {
      serviceAccount = serviceAccounts[0];
    }

    // If still no service account, try to create one
    if (!serviceAccount) {
      try {
        const saName = `vertex-ai-worker-${Date.now().toString().slice(-8)}`;
        const saEmail = `${saName}@${projectId}.iam.gserviceaccount.com`;
        
        execSync(`gcloud iam service-accounts create ${saName} --display-name="Vertex AI Worker" --project=${projectId}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000
        });

        // Grant necessary roles
        try {
          execSync(`gcloud projects add-iam-policy-binding ${projectId} --member="serviceAccount:${saEmail}" --role="roles/aiplatform.user"`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000
          });
        } catch (roleError) {
          console.warn('[ServiceAccount] Could not grant aiplatform.user role:', roleError.message);
        }

        serviceAccount = { email: saEmail, name: saName };
      } catch (createError) {
        return {
          success: false,
          error: 'Failed to create service account. Please create one manually in GCP Console with roles/aiplatform.user.',
          details: createError.message
        };
      }
    }

    const saEmail = serviceAccount.email;
    if (!saEmail) {
      return {
        success: false,
        error: 'Service account email not found.'
      };
    }

    // Create a temporary key file
    const tempKeyFile = path.join(os.tmpdir(), `sa-key-${Date.now()}.json`);
    
    try {
      // Create a new key for the service account
      execSync(`gcloud iam service-accounts keys create "${tempKeyFile}" --iam-account="${saEmail}" --project=${projectId}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000
      });

      // Read the key file
      const keyData = JSON.parse(fs.readFileSync(tempKeyFile, 'utf8'));
      
      // Extract email and private key
      const email = keyData.client_email;
      const privateKey = keyData.private_key;

      // Clean up temp file
      try {
        fs.unlinkSync(tempKeyFile);
      } catch (unlinkError) {
        console.warn('[ServiceAccount] Could not delete temp key file:', unlinkError.message);
      }

      if (!email || !privateKey) {
        return {
          success: false,
          error: 'Failed to extract credentials from service account key.'
        };
      }

      return {
        success: true,
        email: email,
        privateKey: privateKey
      };
    } catch (keyError) {
      // Clean up temp file on error
      try {
        if (fs.existsSync(tempKeyFile)) {
          fs.unlinkSync(tempKeyFile);
        }
      } catch (unlinkError) {
        // Ignore
      }

      return {
        success: false,
        error: 'Failed to create service account key. You may need to create one manually in GCP Console.',
        details: keyError.message
      };
    }
  } catch (error) {
    return {
      success: false,
      error: 'Failed to get service account credentials: ' + (error.message || 'Unknown error'),
      details: error.stack
    };
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

