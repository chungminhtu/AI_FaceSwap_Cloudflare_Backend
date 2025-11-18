// Deployment form management
window.deploymentForm = {
  show(deployment) {
    const formSection = document.getElementById('deployment-form-section');
    const listSection = document.getElementById('deployment-list-section');
    
    if (formSection) formSection.classList.remove('hidden');
    if (listSection) listSection.classList.add('hidden');

    const formTitle = document.getElementById('form-title');
    if (formTitle) {
      formTitle.textContent = deployment ? 'Chỉnh sửa Triển khai' : 'Thêm Triển khai Mới';
    }

    this.renderForm(deployment);
    this.setupFormListeners(deployment);
  },

  hide() {
    const formSection = document.getElementById('deployment-form-section');
    const listSection = document.getElementById('deployment-list-section');
    
    if (formSection) formSection.classList.add('hidden');
    if (listSection) listSection.classList.remove('hidden');
  },

  renderForm(deployment) {
    const formContainer = document.getElementById('deployment-form');
    if (!formContainer) return;

    const isEdit = !!deployment;
    
    // Auto-fill from existing deployments if creating new
    let deploymentData = deployment;
    if (!deployment) {
      const config = window.dashboard?.getCurrentConfig();
      const existingDeployments = config?.deployments || [];
      
      // Get secrets from last deployment or use defaults
      const lastDeployment = existingDeployments[existingDeployments.length - 1];
      
      deploymentData = {
        id: `deployment-${Date.now()}`,
        name: '',
        gcp: {
          projectId: lastDeployment?.gcp?.projectId || '',
          accountEmail: lastDeployment?.gcp?.accountEmail || ''
        },
        cloudflare: {
          accountId: lastDeployment?.cloudflare?.accountId || '',
          email: lastDeployment?.cloudflare?.email || ''
        },
        secrets: {
          RAPIDAPI_KEY: lastDeployment?.secrets?.RAPIDAPI_KEY || '',
          RAPIDAPI_HOST: lastDeployment?.secrets?.RAPIDAPI_HOST || '',
          RAPIDAPI_ENDPOINT: lastDeployment?.secrets?.RAPIDAPI_ENDPOINT || '',
          GOOGLE_CLOUD_API_KEY: lastDeployment?.secrets?.GOOGLE_CLOUD_API_KEY || '',
          GOOGLE_VISION_ENDPOINT: lastDeployment?.secrets?.GOOGLE_VISION_ENDPOINT || ''
        },
        workerName: lastDeployment?.workerName || 'ai-faceswap-backend',
        pagesProjectName: lastDeployment?.pagesProjectName || 'ai-faceswap-frontend'
      };
    }

    formContainer.innerHTML = `
      <form id="deployment-form-form">
        <div class="form-group">
          <label class="form-label">Tên Triển khai *</label>
          <input type="text" class="form-input" id="form-name" value="${this.escapeHtml(deploymentData.name)}" required>
        </div>

        <div class="form-group">
          <label class="form-label">ID Triển khai *</label>
          <input type="text" class="form-input" id="form-id" value="${this.escapeHtml(deploymentData.id)}" required ${isEdit ? 'readonly' : ''}>
        </div>

        <div class="form-group">
          <label class="form-label">GCP Project ID *</label>
          <input type="text" class="form-input" id="form-gcp-project" value="${this.escapeHtml(deploymentData.gcp?.projectId || '')}" required>
        </div>

        <div class="form-group">
          <label class="form-label">GCP Account Email</label>
          <input type="email" class="form-input" id="form-gcp-email" value="${this.escapeHtml(deploymentData.gcp?.accountEmail || '')}">
        </div>

        <div class="form-group">
          <label class="form-label">Cloudflare Account ID</label>
          <input type="text" class="form-input" id="form-cf-account-id" value="${this.escapeHtml(deploymentData.cloudflare?.accountId || '')}">
        </div>

        <div class="form-group">
          <label class="form-label">Cloudflare Email</label>
          <input type="email" class="form-input" id="form-cf-email" value="${this.escapeHtml(deploymentData.cloudflare?.email || '')}">
        </div>

        <div class="form-group">
          <label class="form-label">Worker Name</label>
          <input type="text" class="form-input" id="form-worker-name" value="${this.escapeHtml(deploymentData.workerName || 'ai-faceswap-backend')}">
        </div>

        <div class="form-group">
          <label class="form-label">Pages Project Name</label>
          <input type="text" class="form-input" id="form-pages-name" value="${this.escapeHtml(deploymentData.pagesProjectName || 'ai-faceswap-frontend')}">
        </div>

        <div class="form-group full-width" style="display: flex; justify-content: space-between; align-items: center;">
          <h3 style="margin: 0;">Secrets</h3>
          <button type="button" id="btn-import-deployment" class="btn btn-secondary btn-small">📥 Nhập từ JSON</button>
        </div>

        <div class="form-group">
          <label class="form-label">RAPIDAPI_KEY *</label>
          <input type="password" class="form-input" id="form-secret-rapidapi-key" value="${this.escapeHtml(deploymentData.secrets?.RAPIDAPI_KEY || '')}" required>
        </div>

        <div class="form-group">
          <label class="form-label">RAPIDAPI_HOST *</label>
          <input type="text" class="form-input" id="form-secret-rapidapi-host" value="${this.escapeHtml(deploymentData.secrets?.RAPIDAPI_HOST || '')}" required>
        </div>

        <div class="form-group">
          <label class="form-label">RAPIDAPI_ENDPOINT *</label>
          <input type="text" class="form-input" id="form-secret-rapidapi-endpoint" value="${this.escapeHtml(deploymentData.secrets?.RAPIDAPI_ENDPOINT || '')}" required>
        </div>

        <div class="form-group">
          <label class="form-label">GOOGLE_CLOUD_API_KEY *</label>
          <input type="password" class="form-input" id="form-secret-google-key" value="${this.escapeHtml(deploymentData.secrets?.GOOGLE_CLOUD_API_KEY || '')}" required>
        </div>

        <div class="form-group">
          <label class="form-label">GOOGLE_VISION_ENDPOINT *</label>
          <input type="text" class="form-input" id="form-secret-google-endpoint" value="${this.escapeHtml(deploymentData.secrets?.GOOGLE_VISION_ENDPOINT || '')}" required>
        </div>

        <div class="form-actions">
          <button type="button" id="btn-cancel-form" class="btn btn-secondary">Hủy</button>
          <button type="submit" class="btn btn-primary">Lưu</button>
        </div>
      </form>
    `;
  },

  setupFormListeners(deployment) {
    // Cancel button
    const btnCancel = document.getElementById('btn-cancel-form');
    if (btnCancel) {
      btnCancel.addEventListener('click', () => {
        this.hide();
      });
    }

    // Import deployment button
    const btnImport = document.getElementById('btn-import-deployment');
    if (btnImport) {
      btnImport.addEventListener('click', () => {
        this.showImportDeploymentModal();
      });
    }

    // Form submit
    const form = document.getElementById('deployment-form-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.saveDeployment(deployment);
      });
    }
  },

  showImportDeploymentModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'import-deployment-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 700px;">
        <div class="modal-header">
          <h2>Nhập Cấu hình Triển khai</h2>
          <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
        </div>
        <div class="modal-body">
          <div class="import-config-tabs">
            <button class="import-tab active" data-tab="json">Dán JSON</button>
            <button class="import-tab" data-tab="file">Chọn File</button>
          </div>
          <div id="deployment-import-json-tab" class="import-tab-content active">
            <label class="form-label">Dán JSON cấu hình triển khai:</label>
            <textarea id="deployment-import-json-textarea" class="form-textarea code-textarea" placeholder='{"id": "...", "name": "...", "secrets": {...}}' style="min-height: 200px;"></textarea>
            <div style="margin-top: var(--spacing-sm);">
              <button id="btn-preview-deployment" class="btn btn-secondary btn-small">👁️ Xem Trước</button>
            </div>
            <div id="deployment-import-preview" class="import-preview hidden" style="margin-top: var(--spacing-md);">
              <div class="import-preview-header">
                <h3>Xem Trước</h3>
                <button class="btn-close-small" onclick="document.getElementById('deployment-import-preview').classList.add('hidden')">&times;</button>
              </div>
              <div id="deployment-import-preview-content" class="import-preview-content"></div>
            </div>
          </div>
          <div id="deployment-import-file-tab" class="import-tab-content">
            <div class="file-import-zone">
              <button id="btn-select-deployment-file" class="btn btn-primary">Chọn File JSON</button>
              <p class="file-import-hint">Chọn file JSON chứa cấu hình triển khai</p>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">Hủy</button>
          <button id="btn-confirm-deployment-import" class="btn btn-primary">Nhập vào Form</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Setup tab switching
    modal.querySelectorAll('.import-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        modal.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
        modal.querySelectorAll('.import-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        modal.querySelector(`#deployment-import-${tabName}-tab`).classList.add('active');
      });
    });
    
    // Preview button
    const btnPreview = modal.querySelector('#btn-preview-deployment');
    if (btnPreview) {
      btnPreview.addEventListener('click', () => {
        const jsonText = modal.querySelector('#deployment-import-json-textarea').value.trim();
        if (!jsonText) {
          alert('Vui lòng nhập JSON trước');
          return;
        }
        try {
          const deployment = JSON.parse(jsonText);
          this.showDeploymentPreview(deployment, modal);
        } catch (error) {
          alert('JSON không hợp lệ: ' + error.message);
        }
      });
    }
    
    // File selection
    const btnSelectFile = modal.querySelector('#btn-select-deployment-file');
    if (btnSelectFile) {
      btnSelectFile.addEventListener('click', async () => {
        try {
          const result = await window.electronAPI.dialogLoadConfig();
          if (result.success) {
            // Check if it's a single deployment or full config
            let deployment = result.config;
            if (result.config.deployments && result.config.deployments.length > 0) {
              deployment = result.config.deployments[0];
            }
            this.fillFormFromDeployment(deployment);
            modal.remove();
          }
        } catch (error) {
          alert('Không thể đọc file: ' + error.message);
        }
      });
    }
    
    // Confirm import
    const btnConfirm = modal.querySelector('#btn-confirm-deployment-import');
    if (btnConfirm) {
      btnConfirm.addEventListener('click', () => {
        const activeTab = modal.querySelector('.import-tab.active').dataset.tab;
        if (activeTab === 'json') {
          const jsonText = modal.querySelector('#deployment-import-json-textarea').value.trim();
          if (!jsonText) {
            alert('Vui lòng nhập JSON');
            return;
          }
          try {
            const deployment = JSON.parse(jsonText);
            this.fillFormFromDeployment(deployment);
            modal.remove();
          } catch (error) {
            alert('JSON không hợp lệ: ' + error.message);
          }
        }
      });
    }
  },

  showDeploymentPreview(deployment, modal) {
    const preview = modal.querySelector('#deployment-import-preview');
    const content = modal.querySelector('#deployment-import-preview-content');
    if (!preview || !content) return;
    
    preview.classList.remove('hidden');
    
    let html = '<div class="config-preview-section">';
    html += `<div class="config-preview-item">
      <div class="config-preview-label">Tên:</div>
      <div class="config-preview-value">${this.escapeHtml(deployment.name || 'N/A')}</div>
    </div>`;
    html += `<div class="config-preview-item">
      <div class="config-preview-label">ID:</div>
      <div class="config-preview-value code-value">${this.escapeHtml(deployment.id || 'N/A')}</div>
    </div>`;
    if (deployment.gcp?.projectId) {
      html += `<div class="config-preview-item">
        <div class="config-preview-label">GCP Project:</div>
        <div class="config-preview-value">${this.escapeHtml(deployment.gcp.projectId)}</div>
      </div>`;
    }
    if (deployment.secrets) {
      html += `<div class="config-preview-item">
        <div class="config-preview-label">Secrets:</div>
        <div class="config-preview-value">${Object.keys(deployment.secrets).length} keys</div>
      </div>`;
    }
    html += '</div>';
    content.innerHTML = html;
  },

  fillFormFromDeployment(deployment) {
    if (!deployment) return;
    
    // Fill all form fields
    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el && value !== undefined && value !== null) {
        el.value = value;
      }
    };
    
    setValue('form-name', deployment.name);
    setValue('form-id', deployment.id);
    setValue('form-gcp-project', deployment.gcp?.projectId);
    setValue('form-gcp-email', deployment.gcp?.accountEmail);
    setValue('form-cf-account-id', deployment.cloudflare?.accountId);
    setValue('form-cf-email', deployment.cloudflare?.email);
    setValue('form-worker-name', deployment.workerName);
    setValue('form-pages-name', deployment.pagesProjectName);
    
    // Fill secrets
    if (deployment.secrets) {
      setValue('form-secret-rapidapi-key', deployment.secrets.RAPIDAPI_KEY);
      setValue('form-secret-rapidapi-host', deployment.secrets.RAPIDAPI_HOST);
      setValue('form-secret-rapidapi-endpoint', deployment.secrets.RAPIDAPI_ENDPOINT);
      setValue('form-secret-google-key', deployment.secrets.GOOGLE_CLOUD_API_KEY);
      setValue('form-secret-google-endpoint', deployment.secrets.GOOGLE_VISION_ENDPOINT);
    }
    
    alert('Đã điền form từ cấu hình!');
  },

  async saveDeployment(existingDeployment) {
    try {
      const config = window.dashboard?.getCurrentConfig();
      if (!config) {
        throw new Error('Không thể tải cấu hình');
      }

      const deployment = {
        id: document.getElementById('form-id').value,
        name: document.getElementById('form-name').value,
        gcp: {
          projectId: document.getElementById('form-gcp-project').value,
          accountEmail: document.getElementById('form-gcp-email').value
        },
        cloudflare: {
          accountId: document.getElementById('form-cf-account-id').value,
          email: document.getElementById('form-cf-email').value
        },
        secrets: {
          RAPIDAPI_KEY: document.getElementById('form-secret-rapidapi-key').value,
          RAPIDAPI_HOST: document.getElementById('form-secret-rapidapi-host').value,
          RAPIDAPI_ENDPOINT: document.getElementById('form-secret-rapidapi-endpoint').value,
          GOOGLE_CLOUD_API_KEY: document.getElementById('form-secret-google-key').value,
          GOOGLE_VISION_ENDPOINT: document.getElementById('form-secret-google-endpoint').value
        },
        workerName: document.getElementById('form-worker-name').value || 'ai-faceswap-backend',
        pagesProjectName: document.getElementById('form-pages-name').value || 'ai-faceswap-frontend',
        status: existingDeployment?.status || 'idle'
      };

      // Validate
      const validation = await window.electronAPI.configValidate({ ...config, deployments: [deployment] });
      if (!validation.valid) {
        throw new Error(validation.error || 'Cấu hình không hợp lệ');
      }

      // Add or update deployment
      if (existingDeployment) {
        const index = config.deployments.findIndex(d => d.id === existingDeployment.id);
        if (index >= 0) {
          config.deployments[index] = deployment;
        }
      } else {
        config.deployments.push(deployment);
      }

      await window.dashboard.saveConfig();
      await window.dashboard.loadConfig();
      this.hide();
      alert('Đã lưu triển khai thành công!');
    } catch (error) {
      alert(`Lỗi lưu triển khai: ${error.message}`);
    }
  },

  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

