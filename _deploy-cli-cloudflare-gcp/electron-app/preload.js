const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Config management
  configRead: () => ipcRenderer.invoke('config:read'),
  configWrite: (config) => ipcRenderer.invoke('config:write', config),
  configValidate: (config) => ipcRenderer.invoke('config:validate', config),
  configSaveDeployment: (deployment) => ipcRenderer.invoke('config:save-deployment', deployment),
  configGetSecretsPath: () => ipcRenderer.invoke('config:get-secrets-path'),

  // Authentication
  authCheckCloudflare: () => ipcRenderer.invoke('auth:check-cloudflare'),
  authCheckGCP: () => ipcRenderer.invoke('auth:check-gcp'),
  authLoginCloudflare: () => ipcRenderer.invoke('auth:login-cloudflare'),
  authLoginGCP: () => ipcRenderer.invoke('auth:login-gcp'),

  // Account switching
  accountSwitchGCPProject: (projectId) => ipcRenderer.invoke('account:switch-gcp-project', projectId),
  accountSwitchGCPAccount: (email) => ipcRenderer.invoke('account:switch-gcp-account', email),
  accountSwitchCloudflare: (accountConfig) => ipcRenderer.invoke('account:switch-cloudflare', accountConfig),

  // Deployment
  deploymentStart: (deploymentId) => ipcRenderer.invoke('deployment:start', deploymentId),
  deploymentFromConfig: (configObject, deploymentId) => ipcRenderer.invoke('deployment:from-config', configObject, deploymentId),
  deploymentCheckStatus: () => ipcRenderer.invoke('deployment:check-status'),
  deploymentProgress: (callback) => {
    ipcRenderer.on('deployment:progress', (event, data) => {
      callback(event, data);
    });
  },
  deploymentRemoveListener: () => {
    ipcRenderer.removeAllListeners('deployment:progress');
  },

  // File dialogs
  dialogSelectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  dialogSaveConfig: (configJson) => ipcRenderer.invoke('dialog:save-config', configJson),
  dialogLoadConfig: () => ipcRenderer.invoke('dialog:load-config'),

  // Command execution
  executeCommand: (command, cwd) => ipcRenderer.invoke('command:execute', command, cwd),

  // Helper functions
  helperGetCloudflareInfo: () => ipcRenderer.invoke('helper:get-cloudflare-info'),
  helperGetGCPProjects: () => ipcRenderer.invoke('helper:get-gcp-projects'),
  helperGetServiceAccountCredentials: () => ipcRenderer.invoke('helper:get-service-account-credentials'),

  // R2 File Manager
  r2List: (deploymentId, folderPath) => ipcRenderer.invoke('r2:list', deploymentId, folderPath),
  r2Count: (deploymentId, folderPath) => ipcRenderer.invoke('r2:count', deploymentId, folderPath),
  r2DeleteFiles: (deploymentId, filePaths) => ipcRenderer.invoke('r2:delete-files', deploymentId, filePaths),
  r2DeleteFolders: (deploymentId, folderPaths) => ipcRenderer.invoke('r2:delete-folders', deploymentId, folderPaths),
  r2DeleteWildcard: (deploymentId, pattern) => ipcRenderer.invoke('r2:delete-wildcard', deploymentId, pattern),
  r2Move: (deploymentId, sourcePath, destPath) => ipcRenderer.invoke('r2:move', deploymentId, sourcePath, destPath),
  r2Copy: (deploymentId, sourcePath, destPath) => ipcRenderer.invoke('r2:copy', deploymentId, sourcePath, destPath),
  r2Rename: (deploymentId, oldPath, newPath) => ipcRenderer.invoke('r2:rename', deploymentId, oldPath, newPath),
  r2GetFileContent: (deploymentId, filePath) => ipcRenderer.invoke('r2:get-file-content', deploymentId, filePath),
  r2GetFileUrl: (deploymentId, filePath) => ipcRenderer.invoke('r2:get-file-url', deploymentId, filePath)
});

