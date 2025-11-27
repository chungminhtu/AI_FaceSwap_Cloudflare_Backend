// Main dashboard controller
let currentConfig = null;
let isDeploying = false;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await refreshAuthStatus();
  setupEventListeners();
});

// Load configuration
async function loadConfig() {
  if (window.loading && window.loading.withLoading) {
    return await window.loading.withLoading(async () => {
      try {
        currentConfig = await window.electronAPI.configRead();
        updateCodebasePath();
        window.deploymentList.render(currentConfig.deployments || []);
      } catch (error) {
        console.error('Failed to load config:', error);
        showError('Không thể tải cấu hình', error.message);
      }
    }, 'Đang tải cấu hình...');
  } else {
    // Fallback if loading is not available
    try {
      currentConfig = await window.electronAPI.configRead();
      updateCodebasePath();
      window.deploymentList.render(currentConfig.deployments || []);
    } catch (error) {
      console.error('Failed to load config:', error);
      showError('Không thể tải cấu hình', error.message);
    }
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

  // Import deployment button (from list)
  const btnImportDeploymentList = document.getElementById('btn-import-deployment-list');
  if (btnImportDeploymentList) {
    btnImportDeploymentList.addEventListener('click', () => {
      if (window.deploymentForm && typeof window.deploymentForm.showImportDeploymentModal === 'function') {
        window.deploymentForm.showImportDeploymentModal();
      } else {
        window.toast?.error('Deployment form not loaded. Please refresh the page.');
      }
    });
  }

  // Add deployment button
  const btnAddDeployment = document.getElementById('btn-add-deployment');
  if (btnAddDeployment) {
    btnAddDeployment.addEventListener('click', () => {
      // Wait a bit for scripts to load if needed
      if (!window.deploymentForm) {
        // Try waiting a bit more
        setTimeout(() => {
          if (window.deploymentForm && typeof window.deploymentForm.show === 'function') {
            window.deploymentForm.show(null);
          } else {
            console.error('deploymentForm not available after wait');
            window.toast?.error('Deployment form not loaded. Please refresh the page.');
          }
        }, 100);
      } else if (typeof window.deploymentForm.show === 'function') {
        window.deploymentForm.show(null);
      } else {
        console.error('deploymentForm.show is not a function');
        window.toast?.error('Deployment form not properly initialized. Please refresh the page.');
      }
    });
  }

  // Setup guide button
  const btnSetupGuide = document.getElementById('btn-setup-guide');
  if (btnSetupGuide) {
    btnSetupGuide.addEventListener('click', () => {
      window.setupWizard.show();
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
            GOOGLE_VERTEX_PROJECT_ID: deployment.GOOGLE_VERTEX_PROJECT_ID || deployment.secrets?.GOOGLE_VERTEX_PROJECT_ID,
            GOOGLE_VERTEX_LOCATION: deployment.GOOGLE_VERTEX_LOCATION || deployment.secrets?.GOOGLE_VERTEX_LOCATION || 'us-central1',
            GOOGLE_VERTEX_API_KEY: deployment.GOOGLE_VERTEX_API_KEY || deployment.secrets?.GOOGLE_VERTEX_API_KEY,
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
            GOOGLE_VERTEX_PROJECT_ID: deployment.GOOGLE_VERTEX_PROJECT_ID || deployment.secrets?.GOOGLE_VERTEX_PROJECT_ID,
            GOOGLE_VERTEX_LOCATION: deployment.GOOGLE_VERTEX_LOCATION || deployment.secrets?.GOOGLE_VERTEX_LOCATION || 'us-central1',
            GOOGLE_VERTEX_API_KEY: deployment.GOOGLE_VERTEX_API_KEY || deployment.secrets?.GOOGLE_VERTEX_API_KEY,
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
  const saveFn = async () => {
    try {
      console.log('[saveConfig] Calling configWrite, deployments count:', currentConfig?.deployments?.length || 0);
      const result = await window.electronAPI.configWrite(currentConfig);
      console.log('[saveConfig] Result:', result);
      if (!result || !result.success) {
        const errorMsg = result?.error || 'Failed to save config';
        console.error('[saveConfig] Save failed:', errorMsg);
        throw new Error(errorMsg);
      }
      console.log('[saveConfig] Save successful');
      return result;
    } catch (error) {
      console.error('[saveConfig] Exception:', error);
      throw error;
    }
  };
  
  if (window.loading && window.loading.withLoading) {
    return await window.loading.withLoading(saveFn, 'Đang lưu cấu hình...');
  } else {
    return await saveFn();
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
  const importFn = async () => {
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
  };
  
  if (window.loading && window.loading.withLoading) {
    return await window.loading.withLoading(importFn, 'Đang nhập cấu hình...');
  } else {
    return await importFn();
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

