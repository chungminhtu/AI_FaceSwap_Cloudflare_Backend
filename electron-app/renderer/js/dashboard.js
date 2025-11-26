// Main dashboard controller
let currentConfig = null;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  setupEventListeners();
  await refreshAuthStatus();
});

// Load configuration
async function loadConfig() {
  try {
    currentConfig = await window.electronAPI.configRead();
    updateCodebasePath();
  } catch (error) {
    console.error('Failed to load config:', error);
    showError('Không thể tải cấu hình', error.message);
  }
}

// Update codebase path display
function updateCodebasePath() {
  const pathInput = document.getElementById('codebase-path');
  if (pathInput && currentConfig) {
    pathInput.value = currentConfig.codebasePath || '';
  }
}

// Setup event listeners
function setupEventListeners() {
  // Codebase path selector
  const btnSelectCodebase = document.getElementById('btn-select-codebase');
  if (btnSelectCodebase) {
    btnSelectCodebase.addEventListener('click', async () => {
      const path = await window.electronAPI.dialogSelectDirectory();
      if (path) {
        currentConfig.codebasePath = path;
        await saveConfig();
        updateCodebasePath();
      }
    });
  }

  // Deploy from secrets.json button
  const btnDeployFromSecrets = document.getElementById('btn-add-deployment');
  if (btnDeployFromSecrets) {
    btnDeployFromSecrets.addEventListener('click', async () => {
      try {
        // Check if codebase path is set
        const codebasePath = currentConfig?.codebasePath;
        if (!codebasePath) {
          window.toast?.error('Please set a codebase path in the sidebar first');
          return;
        }

        // Start deployment directly from secrets.json
        window.toast?.info('🚀 Starting deployment from secrets.json...');

        // Switch to deployment status view
        const statusSection = document.getElementById('deployment-status-section');
        const listSection = document.getElementById('deployment-section');

        if (statusSection) statusSection.classList.remove('hidden');
        if (listSection) listSection.classList.add('hidden');

        const statusTitle = document.getElementById('status-header-title');
        if (statusTitle) {
          statusTitle.textContent = 'Deployment from secrets.json';
        }

        // Generate deployment ID
        const deploymentId = `secrets-deployment-${Date.now()}`;

        // Start deployment
        const result = await window.electronAPI.deploymentStart(deploymentId);

        if (result.success) {
          window.toast?.success('✅ Deployment completed successfully!');
        } else {
          window.toast?.error(`❌ Deployment failed: ${result.error}`);
        }

      } catch (error) {
        window.toast?.error(`❌ Error: ${error.message}`);
      }
    });
  }

  // Setup auth buttons
  const btnLoginCf = document.getElementById('btn-login-cf');
  if (btnLoginCf) {
    btnLoginCf.addEventListener('click', async () => {
      try {
        const result = await window.electronAPI.authLoginCloudflare();
        if (result.success) {
          window.toast?.success('Cloudflare authentication successful');
          await refreshAuthStatus();
        } else {
          window.toast?.error(`Cloudflare authentication failed: ${result.error}`);
        }
      } catch (error) {
        window.toast?.error(`Authentication error: ${error.message}`);
      }
    });
  }

  const btnLoginGcp = document.getElementById('btn-login-gcp');
  if (btnLoginGcp) {
    btnLoginGcp.addEventListener('click', async () => {
      try {
        const result = await window.electronAPI.authLoginGCP();
        if (result.success) {
          window.toast?.success('GCP authentication successful');
          await refreshAuthStatus();
        } else {
          window.toast?.error(`GCP authentication failed: ${result.error}`);
        }
      } catch (error) {
        window.toast?.error(`Authentication error: ${error.message}`);
      }
    });
  }

  // Export config button
  const btnExportConfig = document.getElementById('btn-export-config');
  if (btnExportConfig) {
    btnExportConfig.addEventListener('click', async () => {
      try {
        const deploymentCount = currentConfig?.deployments?.length || 0;

        if (deploymentCount === 0) {
          window.toast?.warning('Không có deployment nào để xuất');
          return;
        }

        // Export in flat format compatible with CLI secrets.json
        let exportData;
        if (deploymentCount === 1) {
          // Single deployment - export as flat object
          const deployment = currentConfig.deployments[0];
          exportData = {
            workerName: deployment.workerName,
            pagesProjectName: deployment.pagesProjectName,
            databaseName: deployment.databaseName,
            bucketName: deployment.bucketName,
            RAPIDAPI_KEY: deployment.RAPIDAPI_KEY || deployment.secrets?.RAPIDAPI_KEY,
            RAPIDAPI_HOST: deployment.RAPIDAPI_HOST || deployment.secrets?.RAPIDAPI_HOST,
            RAPIDAPI_ENDPOINT: deployment.RAPIDAPI_ENDPOINT || deployment.secrets?.RAPIDAPI_ENDPOINT,
            GOOGLE_VISION_API_KEY: deployment.GOOGLE_VISION_API_KEY || deployment.secrets?.GOOGLE_VISION_API_KEY,
            GOOGLE_GEMINI_API_KEY: deployment.GOOGLE_GEMINI_API_KEY || deployment.secrets?.GOOGLE_GEMINI_API_KEY,
            GOOGLE_PROJECT_ID: deployment.GOOGLE_PROJECT_ID || deployment.secrets?.GOOGLE_PROJECT_ID,
            GOOGLE_GEMINI_ENDPOINT: deployment.GOOGLE_GEMINI_ENDPOINT || deployment.secrets?.GOOGLE_GEMINI_ENDPOINT,
            GOOGLE_SERVICE_ACCOUNT_EMAIL: deployment.GOOGLE_SERVICE_ACCOUNT_EMAIL || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: deployment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
            GOOGLE_VISION_ENDPOINT: deployment.GOOGLE_VISION_ENDPOINT || deployment.secrets?.GOOGLE_VISION_ENDPOINT
          };
        } else {
          // Multiple deployments - export as array
          exportData = currentConfig.deployments.map(deployment => ({
            name: deployment.name,
            workerName: deployment.workerName,
            pagesProjectName: deployment.pagesProjectName,
            databaseName: deployment.databaseName,
            bucketName: deployment.bucketName,
            RAPIDAPI_KEY: deployment.RAPIDAPI_KEY || deployment.secrets?.RAPIDAPI_KEY,
            RAPIDAPI_HOST: deployment.RAPIDAPI_HOST || deployment.secrets?.RAPIDAPI_HOST,
            RAPIDAPI_ENDPOINT: deployment.RAPIDAPI_ENDPOINT || deployment.secrets?.RAPIDAPI_ENDPOINT,
            GOOGLE_VISION_API_KEY: deployment.GOOGLE_VISION_API_KEY || deployment.secrets?.GOOGLE_VISION_API_KEY,
            GOOGLE_GEMINI_API_KEY: deployment.GOOGLE_GEMINI_API_KEY || deployment.secrets?.GOOGLE_GEMINI_API_KEY,
            GOOGLE_PROJECT_ID: deployment.GOOGLE_PROJECT_ID || deployment.secrets?.GOOGLE_PROJECT_ID,
            GOOGLE_GEMINI_ENDPOINT: deployment.GOOGLE_GEMINI_ENDPOINT || deployment.secrets?.GOOGLE_GEMINI_ENDPOINT,
            GOOGLE_SERVICE_ACCOUNT_EMAIL: deployment.GOOGLE_SERVICE_ACCOUNT_EMAIL || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: deployment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || deployment.secrets?.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
            GOOGLE_VISION_ENDPOINT: deployment.GOOGLE_VISION_ENDPOINT || deployment.secrets?.GOOGLE_VISION_ENDPOINT
          }));
        }

        const configJson = JSON.stringify(exportData, null, 2);
        const result = await window.electronAPI.dialogSaveConfig(configJson);
        if (result.success) {
          window.toast?.success(`Đã xuất ${deploymentCount} deployment(s) thành công!`);
        }
      } catch (error) {
        window.toast?.error(`Không thể xuất cấu hình: ${error.message}`);
      }
    });
  }

  // Note: Import config functionality has been moved to individual deployment forms
  // Users can now import secrets directly when creating/editing a deployment

  // Deployment progress listener
  window.electronAPI.deploymentProgress((event, data) => {
    window.deploymentStatus.updateProgress(data);
  });
}

// Save configuration
async function saveConfig() {
  try {
    await window.electronAPI.configWrite(currentConfig);
  } catch (error) {
    console.error('Failed to save config:', error);
    showError('Không thể lưu cấu hình', error.message);
  }
}

// Show error message
function showError(title, message) {
  const errorModal = document.getElementById('error-modal');
  const errorTitle = document.getElementById('error-title');
  const errorMessage = document.getElementById('error-message');

  if (errorTitle) errorTitle.textContent = title;
  if (errorMessage) errorMessage.textContent = message;
  if (errorModal) errorModal.classList.remove('hidden');
}

// Refresh auth status
async function refreshAuthStatus() {
  try {
    const cfAuth = await window.electronAPI.authCheckCloudflare();
    const gcpAuth = await window.electronAPI.authCheckGCP();

    updateAuthStatus('cf', cfAuth);
    updateAuthStatus('gcp', gcpAuth);
  } catch (error) {
    console.error('Failed to refresh auth status:', error);
  }
}

// Update auth status display
function updateAuthStatus(provider, authData) {
  const statusElement = document.getElementById(`${provider}-status`);
  const loginButton = document.getElementById(`btn-login-${provider}`);

  if (!statusElement) return;

  if (authData.authenticated) {
    statusElement.textContent = authData.email || 'Authenticated';
    statusElement.className = 'status-indicator status-success';
    if (loginButton) loginButton.style.display = 'none';
  } else {
    statusElement.textContent = 'Not authenticated';
    statusElement.className = 'status-indicator status-error';
    if (loginButton) loginButton.style.display = 'inline-block';
  }
}

// Export functions for use by other modules
window.dashboard = {
  getCurrentConfig: () => currentConfig,
  saveConfig,
  refreshAuthStatus,
  updateAuthStatus
};

// Save configuration
async function saveConfig() {
  try {
    const result = await window.electronAPI.configWrite(currentConfig);
    if (!result.success) {
      throw new Error(result.error || 'Failed to save config');
    }
  } catch (error) {
    console.error('Failed to save config:', error);
    throw error;
  }
}

// Refresh auth status
async function refreshAuthStatus() {
  await window.authStatus.refresh();
}

// Show error message
function showError(title, message) {
  // Simple alert for now - can be enhanced with a toast notification
  alert(`${title}: ${message}`);
}

// Show success message
function showSuccess(message) {
  // Simple alert for now - can be enhanced with a toast notification
  alert(message);
}

// Import Config Modal
function showImportConfigModal() {
  const modal = document.getElementById('import-config-modal');
  if (modal) {
    modal.classList.remove('hidden');
    document.getElementById('import-json-textarea').value = '';
    document.getElementById('import-preview').classList.add('hidden');
    document.getElementById('file-preview').classList.add('hidden');
    window.pendingFileConfig = null;
    switchImportTab('json');
  }
}

function hideImportConfigModal() {
  const modal = document.getElementById('import-config-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function switchImportTab(tab) {
  // Update tabs
  document.querySelectorAll('.import-tab').forEach(t => {
    t.classList.remove('active');
    if (t.dataset.tab === tab) t.classList.add('active');
  });
  
  // Update content
  document.querySelectorAll('.import-tab-content').forEach(c => {
    c.classList.remove('active');
  });
  
  if (tab === 'json') {
    document.getElementById('import-json-tab').classList.add('active');
  } else {
    document.getElementById('import-file-tab').classList.add('active');
  }
}

function setupImportConfigModal() {
  // Tab switching
  document.querySelectorAll('.import-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchImportTab(tab.dataset.tab);
    });
  });

  // Close buttons
  const btnClose = document.getElementById('btn-close-import');
  const btnCancel = document.getElementById('btn-cancel-import');
  if (btnClose) btnClose.addEventListener('click', hideImportConfigModal);
  if (btnCancel) btnCancel.addEventListener('click', hideImportConfigModal);

  // File selection
  const btnSelectFile = document.getElementById('btn-select-config-file');
  if (btnSelectFile) {
    btnSelectFile.addEventListener('click', async () => {
      try {
        const result = await window.electronAPI.dialogLoadConfig();
        if (result.success) {
          // Show preview instead of importing immediately
          showConfigPreview(result.config, 'file-preview', 'file-preview-content');
          // Store config for later import
          window.pendingFileConfig = result.config;
        }
      } catch (error) {
        showError('Không thể đọc file', error.message);
      }
    });
  }

  // Preview JSON button
  const btnPreview = document.getElementById('btn-preview-json');
  if (btnPreview) {
    btnPreview.addEventListener('click', () => {
      const jsonText = document.getElementById('import-json-textarea').value.trim();
      if (!jsonText) {
        showError('Lỗi', 'Vui lòng nhập nội dung JSON trước');
        return;
      }
      
      try {
        const config = JSON.parse(jsonText);
        showConfigPreview(config, 'import-preview', 'import-preview-content');
      } catch (error) {
        showError('Lỗi JSON', 'Nội dung JSON không hợp lệ: ' + error.message);
      }
    });
  }

  // Validate JSON button
  const btnValidate = document.getElementById('btn-validate-json');
  if (btnValidate) {
    btnValidate.addEventListener('click', () => {
      const jsonText = document.getElementById('import-json-textarea').value.trim();
      if (!jsonText) {
        showError('Lỗi', 'Vui lòng nhập nội dung JSON trước');
        return;
      }
      
      try {
        const config = JSON.parse(jsonText);
        const validation = validateConfigStructure(config);
        if (validation.valid) {
          showSuccess('✓ JSON hợp lệ! Cấu hình có thể được nhập.');
          showConfigPreview(config, 'import-preview', 'import-preview-content');
        } else {
          showError('Cấu hình không hợp lệ', validation.error);
        }
      } catch (error) {
        showError('Lỗi JSON', 'Nội dung JSON không hợp lệ: ' + error.message);
      }
    });
  }

  // Close preview buttons
  const btnClosePreview = document.getElementById('btn-close-preview');
  const btnCloseFilePreview = document.getElementById('btn-close-file-preview');
  if (btnClosePreview) {
    btnClosePreview.addEventListener('click', () => {
      document.getElementById('import-preview').classList.add('hidden');
    });
  }
  if (btnCloseFilePreview) {
    btnCloseFilePreview.addEventListener('click', () => {
      document.getElementById('file-preview').classList.add('hidden');
    });
  }

  // Confirm import
  const btnConfirm = document.getElementById('btn-confirm-import');
  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      const activeTab = document.querySelector('.import-tab.active').dataset.tab;
      
      if (activeTab === 'json') {
        const jsonText = document.getElementById('import-json-textarea').value.trim();
        if (!jsonText) {
          showError('Lỗi', 'Vui lòng nhập nội dung JSON');
          return;
        }
        
        try {
          const importedConfig = JSON.parse(jsonText);
          await importConfig(importedConfig);
        } catch (error) {
          showError('Lỗi JSON', 'Nội dung JSON không hợp lệ: ' + error.message);
        }
      } else if (activeTab === 'file') {
        if (window.pendingFileConfig) {
          await importConfig(window.pendingFileConfig);
          window.pendingFileConfig = null;
        } else {
          showError('Lỗi', 'Vui lòng chọn file cấu hình trước');
        }
      }
    });
  }
}

function validateConfigStructure(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Cấu hình phải là một object' };
  }
  
  if (config.deployments && !Array.isArray(config.deployments)) {
    return { valid: false, error: 'deployments phải là một array' };
  }
  
  return { valid: true };
}

function showConfigPreview(config, containerId, contentId) {
  const container = document.getElementById(containerId);
  const content = document.getElementById(contentId);
  
  if (!container || !content) return;
  
  container.classList.remove('hidden');
  
  // Format and display config
  let html = '<div class="config-preview-section">';
  
  // Show codebase path if exists
  if (config.codebasePath) {
    html += `
      <div class="config-preview-item">
        <div class="config-preview-label">Đường dẫn Codebase:</div>
        <div class="config-preview-value code-value">${escapeHtml(config.codebasePath)}</div>
      </div>
    `;
  }
  
  // Show deployments
  if (config.deployments && config.deployments.length > 0) {
    html += `
      <div class="config-preview-item">
        <div class="config-preview-label">Số lượng Deploy:</div>
        <div class="config-preview-value">${config.deployments.length}</div>
      </div>
      <div class="config-preview-deployments">
        <h4>Danh sách Deploy:</h4>
    `;
    
    config.deployments.forEach((deployment, index) => {
      html += `
        <div class="config-deployment-card">
          <div class="config-deployment-header">
            <strong>${index + 1}. ${escapeHtml(deployment.name || deployment.id || 'Unnamed')}</strong>
            <span class="config-deployment-id">ID: ${escapeHtml(deployment.id)}</span>
          </div>
          <div class="config-deployment-details">
            ${deployment.gcp?.projectId ? `<div><span class="detail-label">GCP Project:</span> ${escapeHtml(deployment.gcp.projectId)}</div>` : ''}
            ${deployment.cloudflare?.accountId ? `<div><span class="detail-label">CF Account:</span> ${escapeHtml(deployment.cloudflare.accountId)}</div>` : ''}
            ${deployment.workerName ? `<div><span class="detail-label">Worker:</span> ${escapeHtml(deployment.workerName)}</div>` : ''}
            ${deployment.secrets ? `<div><span class="detail-label">Secrets:</span> ${Object.keys(deployment.secrets).length} keys</div>` : ''}
          </div>
        </div>
      `;
    });
    
    html += '</div>';
  }
  
  // Show raw JSON in collapsible section
  html += `
    <div class="config-raw-section">
      <button class="btn-toggle-raw btn btn-secondary btn-small" onclick="toggleRawJson('${contentId}')">
        📄 Xem JSON đầy đủ
      </button>
      <div id="${contentId}-raw" class="config-raw-json hidden">
        <pre class="code-textarea">${escapeHtml(JSON.stringify(config, null, 2))}</pre>
      </div>
    </div>
  `;
  
  html += '</div>';
  content.innerHTML = html;
}

function toggleRawJson(contentId) {
  const rawSection = document.getElementById(contentId + '-raw');
  const btn = document.querySelector(`#${contentId}-raw`).previousElementSibling;
  if (rawSection) {
    rawSection.classList.toggle('hidden');
    if (rawSection.classList.contains('hidden')) {
      btn.textContent = '📄 Xem JSON đầy đủ';
    } else {
      btn.textContent = '📄 Ẩn JSON';
    }
  }
}

window.toggleRawJson = toggleRawJson;

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function importConfig(importedConfig) {
  try {
    // If imported config has deployments array, merge it
    if (importedConfig.deployments && Array.isArray(importedConfig.deployments)) {
      if (!currentConfig.deployments) {
        currentConfig.deployments = [];
      }
      
      // Merge deployments (avoid duplicates by ID)
      importedConfig.deployments.forEach(imported => {
        const existingIndex = currentConfig.deployments.findIndex(d => d.id === imported.id);
        if (existingIndex >= 0) {
          currentConfig.deployments[existingIndex] = imported;
        } else {
          currentConfig.deployments.push(imported);
        }
      });
    }
    
    // Merge other config properties
    Object.keys(importedConfig).forEach(key => {
      if (key !== 'deployments') {
        currentConfig[key] = importedConfig[key];
      }
    });
    
    await saveConfig();
    await loadConfig();
    hideImportConfigModal();
    showSuccess('Đã nhập cấu hình thành công!');
  } catch (error) {
    showError('Không thể nhập cấu hình', error.message);
  }
}

// Export functions for other modules
window.dashboard = {
  loadConfig,
  saveConfig,
  refreshAuthStatus,
  getCurrentConfig: () => currentConfig,
  setIsDeploying: (value) => {
    isDeploying = value;
    updateDeployButtonStates();
  },
  isDeploying: () => isDeploying
};

// Update deploy button states
function updateDeployButtonStates() {
  const deployButtons = document.querySelectorAll('.btn-deploy');
  deployButtons.forEach(btn => {
    btn.disabled = isDeploying;
  });
}

