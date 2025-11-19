// Deployment form management
window.deploymentForm = {
  async show(deployment) {
    const formSection = document.getElementById('deployment-form-section');
    const listSection = document.getElementById('deployment-list-section');
    
    if (formSection) formSection.classList.remove('hidden');
    if (listSection) listSection.classList.add('hidden');

    const formTitle = document.getElementById('form-title');
    if (formTitle) {
      formTitle.textContent = deployment ? 'Chỉnh sửa Triển khai' : 'Thêm Triển khai Mới';
    }

    await this.renderForm(deployment);
    this.setupFormListeners(deployment);
  },

  hide() {
    const formSection = document.getElementById('deployment-form-section');
    const listSection = document.getElementById('deployment-list-section');
    
    if (formSection) formSection.classList.add('hidden');
    if (listSection) listSection.classList.remove('hidden');
  },

  async renderForm(deployment) {
    const formContainer = document.getElementById('deployment-form');
    if (!formContainer) return;

    const isEdit = !!deployment;
    
    // Auto-fill from existing deployments if creating new
    let deploymentData = deployment;
    if (!deployment) {
      // First, try to load saved draft from localStorage
      const savedDraft = this.loadFormDraft();
      
      const config = window.dashboard?.getCurrentConfig();
      const existingDeployments = config?.deployments || [];
      
      // Get secrets from last deployment or use defaults
      const lastDeployment = existingDeployments[existingDeployments.length - 1];
      
      // Try to auto-fill emails from current auth status
      let gcpEmail = savedDraft?.gcpEmail || lastDeployment?.gcp?.accountEmail || '';
      let cfEmail = savedDraft?.cfEmail || lastDeployment?.cloudflare?.email || '';
      
      // Auto-fetch current auth emails if not set
      if (!gcpEmail) {
        try {
          const gcpAuth = await window.electronAPI.authCheckGCP();
          if (gcpAuth.authenticated && gcpAuth.currentAccount) {
            gcpEmail = gcpAuth.currentAccount;
          }
        } catch (e) {
          // Ignore
        }
      }
      
      if (!cfEmail) {
        try {
          const cfAuth = await window.electronAPI.authCheckCloudflare();
          if (cfAuth.authenticated && cfAuth.email) {
            cfEmail = cfAuth.email;
          }
        } catch (e) {
          // Ignore
        }
      }
      
      // Merge saved draft with defaults
      deploymentData = {
        id: `deployment-${Date.now()}`,
        name: '',
        gcp: {
          projectId: savedDraft?.gcpProjectId || lastDeployment?.gcp?.projectId || '',
          accountEmail: gcpEmail
        },
        cloudflare: {
          accountId: savedDraft?.cfAccountId || lastDeployment?.cloudflare?.accountId || '',
          email: cfEmail
        },
        secrets: {
          RAPIDAPI_KEY: savedDraft?.secrets?.RAPIDAPI_KEY || lastDeployment?.secrets?.RAPIDAPI_KEY || '',
          RAPIDAPI_HOST: savedDraft?.secrets?.RAPIDAPI_HOST || lastDeployment?.secrets?.RAPIDAPI_HOST || '',
          RAPIDAPI_ENDPOINT: savedDraft?.secrets?.RAPIDAPI_ENDPOINT || lastDeployment?.secrets?.RAPIDAPI_ENDPOINT || '',
          GOOGLE_CLOUD_API_KEY: savedDraft?.secrets?.GOOGLE_CLOUD_API_KEY || lastDeployment?.secrets?.GOOGLE_CLOUD_API_KEY || '',
          GOOGLE_VISION_ENDPOINT: savedDraft?.secrets?.GOOGLE_VISION_ENDPOINT || lastDeployment?.secrets?.GOOGLE_VISION_ENDPOINT || ''
        },
        workerName: savedDraft?.workerName || lastDeployment?.workerName || 'ai-faceswap-backend',
        pagesProjectName: savedDraft?.pagesProjectName || lastDeployment?.pagesProjectName || 'ai-faceswap-frontend'
      };
      
      if (savedDraft) {
        console.log('[Auto-load] Pre-filled form with saved data from:', savedDraft.savedAt);
        // Show a subtle notification
        setTimeout(() => {
          window.toast?.info('Đã tự động điền dữ liệu từ lần trước');
        }, 500);
      }
    }

    formContainer.innerHTML = `
      <form id="deployment-form-form">
        <!-- Left Column: Basic Configuration -->
        <div class="form-column">
          <h3 class="form-column-title">⚙️ Cấu hình Cơ bản</h3>
          
          <div class="form-group">
            <label class="form-label">Tên triển khai *</label>
            <input type="text" class="form-input" id="form-name" value="${this.escapeHtml(deploymentData.name)}" required>
          </div>

          <div class="form-group">
            <label class="form-label">ID triển khai *</label>
            <input type="text" class="form-input" id="form-id" value="${this.escapeHtml(deploymentData.id)}" required ${isEdit ? 'readonly' : ''}>
          </div>

          <h4 class="form-subsection-title">🌐 GCP Configuration</h4>
          <div class="form-group">
            <label class="form-label">Project ID *</label>
            <div style="display: flex; gap: 8px;">
              <input type="text" class="form-input" id="form-gcp-project" value="${this.escapeHtml(deploymentData.gcp?.projectId || '')}" required style="flex: 1;">
              <button type="button" id="btn-fetch-gcp-projects" class="btn btn-secondary btn-small" title="Fetch your GCP projects">🔍</button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Account Email</label>
            <div style="display: flex; gap: 8px;">
              <input type="email" class="form-input" id="form-gcp-email" value="${this.escapeHtml(deploymentData.gcp?.accountEmail || '')}" style="flex: 1;">
              <button type="button" id="btn-fetch-gcp-email" class="btn btn-secondary btn-small" title="Get current GCP account email">🔍</button>
            </div>
          </div>

          <h4 class="form-subsection-title">☁️ Cloudflare Configuration</h4>
          <div class="form-group">
            <label class="form-label">Account ID</label>
            <div style="display: flex; gap: 8px;">
              <input type="text" class="form-input" id="form-cf-account-id" value="${this.escapeHtml(deploymentData.cloudflare?.accountId || '')}" placeholder="32-character hex string" style="flex: 1;">
              <button type="button" id="btn-fetch-cf-info" class="btn btn-secondary btn-small" title="Fetch Cloudflare account info">🔍</button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Email</label>
            <div style="display: flex; gap: 8px;">
              <input type="email" class="form-input" id="form-cf-email" value="${this.escapeHtml(deploymentData.cloudflare?.email || '')}" style="flex: 1;">
              <button type="button" id="btn-fetch-cf-email" class="btn btn-secondary btn-small" title="Get current Cloudflare email">🔍</button>
            </div>
          </div>

          <h4 class="form-subsection-title">🔧 Worker Configuration</h4>
          <div class="form-group">
            <label class="form-label">Worker Name</label>
            <input type="text" class="form-input" id="form-worker-name" value="${this.escapeHtml(deploymentData.workerName || 'ai-faceswap-backend')}">
          </div>

          <div class="form-group">
            <label class="form-label">Pages Project Name</label>
            <input type="text" class="form-input" id="form-pages-name" value="${this.escapeHtml(deploymentData.pagesProjectName || 'ai-faceswap-frontend')}">
          </div>
        </div>

        <!-- Right Column: Secrets -->
        <div class="form-column">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--spacing-md);">
            <h3 class="form-column-title" style="margin: 0;">🔐 Secrets</h3>
            <button type="button" id="btn-import-deployment" class="btn btn-secondary btn-small">📥 Tự động điền</button>
          </div>

          <div class="secrets-column">
            <h4 class="secrets-column-title">🔑 RapidAPI</h4>
            <div class="form-group">
              <label class="form-label">API Key *</label>
              <input type="password" class="form-input" id="form-secret-rapidapi-key" value="${this.escapeHtml(deploymentData.secrets?.RAPIDAPI_KEY || '')}" required>
            </div>
            <div class="form-group">
              <label class="form-label">Host *</label>
              <input type="text" class="form-input" id="form-secret-rapidapi-host" value="${this.escapeHtml(deploymentData.secrets?.RAPIDAPI_HOST || '')}" required>
            </div>
            <div class="form-group">
              <label class="form-label">Endpoint *</label>
              <input type="text" class="form-input" id="form-secret-rapidapi-endpoint" value="${this.escapeHtml(deploymentData.secrets?.RAPIDAPI_ENDPOINT || '')}" required>
            </div>
          </div>

          <div class="secrets-column" style="margin-top: var(--spacing-md);">
            <h4 class="secrets-column-title">☁️ Google Cloud</h4>
            <div class="form-group">
              <label class="form-label">API Key *</label>
              <input type="password" class="form-input" id="form-secret-google-key" value="${this.escapeHtml(deploymentData.secrets?.GOOGLE_CLOUD_API_KEY || '')}" required>
            </div>
            <div class="form-group">
              <label class="form-label">Vision Endpoint *</label>
              <input type="text" class="form-input" id="form-secret-google-endpoint" value="${this.escapeHtml(deploymentData.secrets?.GOOGLE_VISION_ENDPOINT || '')}" required>
            </div>
          </div>
        </div>

        <!-- Form Actions -->
        <div class="form-actions full-width">
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

    // Helper buttons
    const btnFetchGCPProjects = document.getElementById('btn-fetch-gcp-projects');
    if (btnFetchGCPProjects) {
      btnFetchGCPProjects.addEventListener('click', async () => {
        await this.fetchGCPProjects();
      });
    }

    const btnFetchGCPEmail = document.getElementById('btn-fetch-gcp-email');
    if (btnFetchGCPEmail) {
      btnFetchGCPEmail.addEventListener('click', async () => {
        await this.fetchGCPEmail();
      });
    }

    const btnFetchCFInfo = document.getElementById('btn-fetch-cf-info');
    if (btnFetchCFInfo) {
      btnFetchCFInfo.addEventListener('click', async () => {
        await this.fetchCloudflareInfo();
      });
    }

    const btnFetchCFEmail = document.getElementById('btn-fetch-cf-email');
    if (btnFetchCFEmail) {
      btnFetchCFEmail.addEventListener('click', async () => {
        await this.fetchCloudflareEmail();
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

    // Auto-save form data as user types (remember for next time)
    this.setupAutoSave();
  },

  setupAutoSave() {
    const formFields = [
      'form-gcp-project',
      'form-gcp-email',
      'form-cf-account-id',
      'form-cf-email',
      'form-worker-name',
      'form-pages-name',
      'form-secret-rapidapi-key',
      'form-secret-rapidapi-host',
      'form-secret-rapidapi-endpoint',
      'form-secret-google-key',
      'form-secret-google-endpoint'
    ];

    formFields.forEach(fieldId => {
      const field = document.getElementById(fieldId);
      if (field) {
        // Save to localStorage when field changes
        field.addEventListener('change', () => {
          this.saveFormDraft();
        });
        
        // Also save after a short delay when typing
        let timeout;
        field.addEventListener('input', () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => {
            this.saveFormDraft();
          }, 1000); // Save 1 second after user stops typing
        });
      }
    });
  },

  saveFormDraft() {
    const draft = {
      gcpProjectId: document.getElementById('form-gcp-project')?.value || '',
      gcpEmail: document.getElementById('form-gcp-email')?.value || '',
      cfAccountId: document.getElementById('form-cf-account-id')?.value || '',
      cfEmail: document.getElementById('form-cf-email')?.value || '',
      workerName: document.getElementById('form-worker-name')?.value || '',
      pagesProjectName: document.getElementById('form-pages-name')?.value || '',
      secrets: {
        RAPIDAPI_KEY: document.getElementById('form-secret-rapidapi-key')?.value || '',
        RAPIDAPI_HOST: document.getElementById('form-secret-rapidapi-host')?.value || '',
        RAPIDAPI_ENDPOINT: document.getElementById('form-secret-rapidapi-endpoint')?.value || '',
        GOOGLE_CLOUD_API_KEY: document.getElementById('form-secret-google-key')?.value || '',
        GOOGLE_VISION_ENDPOINT: document.getElementById('form-secret-google-endpoint')?.value || ''
      },
      savedAt: new Date().toISOString()
    };

    try {
      localStorage.setItem('deployment-form-draft', JSON.stringify(draft));
      console.log('[Auto-save] Form data saved to localStorage');
    } catch (error) {
      console.error('[Auto-save] Failed to save form draft:', error);
    }
  },

  loadFormDraft() {
    try {
      const draftJson = localStorage.getItem('deployment-form-draft');
      if (draftJson) {
        const draft = JSON.parse(draftJson);
        console.log('[Auto-load] Found saved form data from:', draft.savedAt);
        return draft;
      }
    } catch (error) {
      console.error('[Auto-load] Failed to load form draft:', error);
    }
    return null;
  },

  async fetchGCPProjects() {
    try {
      const result = await window.electronAPI.helperGetGCPProjects();
      if (!result.success) {
        window.toast?.error(`Không thể lấy danh sách projects: ${result.error}\nHãy đảm bảo bạn đã đăng nhập GCP và cài đặt gcloud CLI`);
        return;
      }

      if (result.projects.length === 0) {
        window.toast?.warning('Không tìm thấy project nào. Hãy tạo project mới trong Google Cloud Console.');
        return;
      }

      // Show project selection modal
      this.showProjectSelectionModal(result.projects, result.currentAccount);
    } catch (error) {
      window.toast?.error(`Lỗi: ${error.message}`);
    }
  },

  showDeploymentSelectionModal(deployments) {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.id = 'deployment-selection-modal';
      
      const deploymentListHtml = deployments.map((d, i) => 
        `<div class="project-item" data-index="${i}" style="padding: 12px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='var(--bg-tertiary)'" onmouseout="this.style.background=''">
          <div style="font-weight: 600; color: var(--text-primary);">${i + 1}. ${this.escapeHtml(d.name || d.id)}</div>
          ${d.id ? `<div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">ID: ${this.escapeHtml(d.id)}</div>` : ''}
        </div>`
      ).join('');
      
      modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
          <div class="modal-header">
            <h2>Chọn Deployment</h2>
            <button class="btn-close" id="btn-close-deployment-modal">&times;</button>
          </div>
          <div class="modal-body">
            <p style="margin-bottom: 16px;">Chọn deployment để import:</p>
            <div id="deployment-list" style="max-height: 400px; overflow-y: auto;">
              ${deploymentListHtml}
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="btn-cancel-deployment-modal">Hủy</button>
          </div>
        </div>
      `;
      
      document.body.appendChild(modal);
      
      // Close handlers
      const closeModal = () => {
        resolve(null);
        modal.remove();
      };
      
      modal.querySelector('#btn-close-deployment-modal').addEventListener('click', closeModal);
      modal.querySelector('#btn-cancel-deployment-modal').addEventListener('click', closeModal);
      
      // Click on deployment item
      modal.querySelectorAll('.project-item').forEach(item => {
        item.addEventListener('click', () => {
          const index = parseInt(item.dataset.index);
          const selectedDeployment = deployments[index];
          resolve(selectedDeployment);
          modal.remove();
        });
      });
    });
  },

  showProjectSelectionModal(projects, currentAccount) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'gcp-project-selection-modal';
    
    const projectListHtml = projects.map((p, i) => 
      `<div class="project-item" data-index="${i}" data-project-id="${this.escapeHtml(p.projectId)}" style="padding: 12px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='var(--bg-tertiary)'" onmouseout="this.style.background=''">
        <div style="font-weight: 600; color: var(--text-primary);">${i + 1}. ${this.escapeHtml(p.projectId)}</div>
        ${p.name !== p.projectId ? `<div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">${this.escapeHtml(p.name)}</div>` : ''}
      </div>`
    ).join('');
    
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 600px;">
        <div class="modal-header">
          <h2>Chọn GCP Project</h2>
          <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin-bottom: 16px;">Chọn project từ danh sách hoặc nhập project ID:</p>
          <div id="project-list" style="max-height: 400px; overflow-y: auto; margin-bottom: 16px;">
            ${projectListHtml}
          </div>
          <div class="form-group">
            <label class="form-label">Hoặc nhập Project ID:</label>
            <input type="text" id="manual-project-id" class="form-input" placeholder="my-project-id">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">Hủy</button>
          <button id="btn-confirm-project" class="btn btn-primary">Chọn</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    let selectedProject = null;
    
    // Click on project item
    modal.querySelectorAll('.project-item').forEach(item => {
      item.addEventListener('click', () => {
        modal.querySelectorAll('.project-item').forEach(i => {
          i.style.border = '1px solid var(--border)';
          i.style.background = '';
        });
        item.style.border = '2px solid var(--primary)';
        item.style.background = 'var(--bg-tertiary)';
        const index = parseInt(item.dataset.index);
        selectedProject = projects[index];
      });
    });
    
    // Confirm button
    const btnConfirm = modal.querySelector('#btn-confirm-project');
    btnConfirm.addEventListener('click', () => {
      // Check if manual input was used
      const manualInput = modal.querySelector('#manual-project-id').value.trim();
      if (manualInput) {
        const foundProject = projects.find(p => p.projectId === manualInput);
        if (foundProject) {
          selectedProject = foundProject;
        } else {
          // Use manual input as project ID
          selectedProject = { projectId: manualInput, name: manualInput };
        }
      }
      
      if (selectedProject) {
        document.getElementById('form-gcp-project').value = selectedProject.projectId;
        if (currentAccount) {
          document.getElementById('form-gcp-email').value = currentAccount;
        }
        window.toast?.success(`Đã chọn project: ${selectedProject.projectId}`);
        modal.remove();
      } else {
        window.toast?.warning('Vui lòng chọn project hoặc nhập Project ID');
      }
    });
  },

  async fetchGCPEmail() {
    try {
      const emailField = document.getElementById('form-gcp-email');
      if (!emailField) {
        window.toast?.warning('Form chưa được hiển thị. Vui lòng đảm bảo form đã được mở.');
        return;
      }

      const result = await window.electronAPI.authCheckGCP();
      console.log('GCP auth check result:', result);
      
      if (result.authenticated && result.currentAccount) {
        emailField.value = result.currentAccount;
        emailField.dispatchEvent(new Event('input', { bubbles: true })); // Trigger input event
        console.log('Filled GCP email:', result.currentAccount);
        window.toast?.success(`Đã lấy email: ${result.currentAccount}`);
      } else {
        window.toast?.warning(`Chưa đăng nhập GCP. Hãy click "Đăng nhập GCP" ở sidebar.`);
      }
    } catch (error) {
      console.error('Error fetching GCP email:', error);
      window.toast?.error(`Lỗi: ${error.message}`);
    }
  },

  async fetchCloudflareInfo() {
    try {
      const result = await window.electronAPI.helperGetCloudflareInfo();
      if (!result.success) {
        window.toast?.error(`Không thể lấy thông tin Cloudflare: ${result.error}\nHãy đảm bảo bạn đã đăng nhập Cloudflare và cài đặt wrangler CLI`);
        return;
      }

      if (result.email) {
        document.getElementById('form-cf-email').value = result.email;
      }
      
      if (result.accountId) {
        document.getElementById('form-cf-account-id').value = result.accountId;
        window.toast?.success(`Đã lấy thông tin\nEmail: ${result.email}\nAccount ID: ${result.accountId}`);
      } else {
        document.getElementById('form-cf-email').value = result.email || '';
        window.toast?.info(`${result.message}\nEmail: ${result.email}\nĐể tìm Account ID: Vào Cloudflare Dashboard > Workers & Pages > Overview`);
      }
    } catch (error) {
      window.toast?.error(`Lỗi: ${error.message}`);
    }
  },

  async fetchCloudflareEmail() {
    try {
      const emailField = document.getElementById('form-cf-email');
      if (!emailField) {
        window.toast?.warning('Form chưa được hiển thị. Vui lòng đảm bảo form đã được mở.');
        return;
      }

      const result = await window.electronAPI.authCheckCloudflare();
      console.log('Cloudflare auth check result:', result);
      
      if (result.authenticated && result.email) {
        emailField.value = result.email;
        emailField.dispatchEvent(new Event('input', { bubbles: true })); // Trigger input event
        console.log('Filled Cloudflare email:', result.email);
        window.toast?.success(`Đã lấy email: ${result.email}`);
      } else {
        window.toast?.warning(`Chưa đăng nhập Cloudflare. Hãy click "Đăng nhập Cloudflare" ở sidebar.`);
      }
    } catch (error) {
      console.error('Error fetching Cloudflare email:', error);
      window.toast?.error(`Lỗi: ${error.message}`);
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
          window.toast?.warning('Vui lòng nhập JSON trước');
          return;
        }
        try {
          const deployment = JSON.parse(jsonText);
          this.showDeploymentPreview(deployment, modal);
        } catch (error) {
          window.toast?.error('JSON không hợp lệ: ' + error.message);
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
            let deployment = result.config;
            
            // Check if it's a full config with deployments array
            if (result.config.deployments && Array.isArray(result.config.deployments)) {
              if (result.config.deployments.length > 1) {
                // Show deployment selection modal
                const selectedDeployment = await this.showDeploymentSelectionModal(result.config.deployments);
                if (selectedDeployment) {
                  deployment = selectedDeployment;
                } else {
                  return; // User cancelled
                }
              } else if (result.config.deployments.length === 1) {
                deployment = result.config.deployments[0];
              } else {
                // Empty deployments array, use the config itself if it has deployment structure
                if (result.config.id || result.config.name || result.config.secrets) {
                  deployment = result.config;
                } else {
                  window.toast?.error('File không chứa dữ liệu deployment hợp lệ.');
                  return;
                }
              }
            } else {
              // It's either a single deployment object or a secrets-only file
              // Check if it looks like a secrets-only file
              const isSecretsOnly = !deployment.id && !deployment.name && !deployment.gcp && !deployment.cloudflare &&
                (deployment.RAPIDAPI_KEY || deployment.RAPIDAPI_HOST || deployment.GOOGLE_CLOUD_API_KEY);
              
              if (isSecretsOnly) {
                console.log('Detected secrets-only file');
                // Keep as is, fillFormFromDeployment will handle it
              }
              // Otherwise assume it's a deployment object
            }
            
            // Ensure form is shown first
            await this.show(null); // Show form (create new deployment)
            
            // Close modal first
            modal.remove();
            
            // Wait for form to render, then fill it
            // fillFormFromDeployment now has its own retry logic
            setTimeout(() => {
              this.fillFormFromDeployment(deployment);
            }, 300);
          }
        } catch (error) {
          console.error('Error loading config file:', error);
          window.toast?.error('Không thể đọc file: ' + error.message);
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
            window.toast?.warning('Vui lòng nhập JSON');
            return;
          }
          try {
            const deployment = JSON.parse(jsonText);
            console.log('Parsed deployment:', deployment);
            
            // Ensure form is shown first
            this.show(null); // Show form (create new deployment)
            
            // Close modal first
            modal.remove();
            
            // Wait for form to render, then fill it
            // fillFormFromDeployment now has its own retry logic
            setTimeout(() => {
              this.fillFormFromDeployment(deployment);
            }, 200);
          } catch (error) {
            window.toast?.error('JSON không hợp lệ: ' + error.message);
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
    if (!deployment) {
      window.toast?.warning('Không có dữ liệu để điền vào form');
      return;
    }
    
    console.log('Filling form with data:', deployment);
    
    // Check if this is a secrets-only file (flat object with secret keys)
    const isSecretsOnly = !deployment.id && !deployment.name && !deployment.gcp && !deployment.cloudflare &&
      (deployment.RAPIDAPI_KEY || deployment.RAPIDAPI_HOST || deployment.GOOGLE_CLOUD_API_KEY);
    
    // If it's secrets-only, wrap it in a secrets object
    if (isSecretsOnly) {
      console.log('Detected secrets-only file, wrapping in secrets object');
      deployment = { secrets: deployment };
    }
    
    // Wait for form elements to exist with retry logic
    const waitForForm = (retries = 20, delay = 100) => {
      return new Promise((resolve, reject) => {
        const checkForm = () => {
          const formName = document.getElementById('form-name');
          if (formName) {
            resolve();
          } else if (retries > 0) {
            retries--;
            setTimeout(checkForm, delay);
          } else {
            reject(new Error('Form elements not found after waiting'));
          }
        };
        checkForm();
      });
    };
    
    waitForForm().then(() => {
      // Ensure form is visible
      const formSection = document.getElementById('deployment-form-section');
      if (formSection) {
        formSection.classList.remove('hidden');
      }
      
      // Fill all form fields with better error handling
      const setValue = (id, value) => {
        const el = document.getElementById(id);
        if (!el) {
          console.warn(`Form element not found: ${id}`);
          return false;
        }
        // Allow empty strings, but skip undefined/null
        if (value !== undefined && value !== null && value !== '') {
          el.value = String(value);
          return true;
        }
        return false;
      };
      
      let filledCount = 0;
      const filledFields = [];
      
      // Fill basic fields (only if they exist in data)
      if (setValue('form-name', deployment.name)) {
        filledCount++;
        filledFields.push('Tên Triển khai');
      }
      
      if (setValue('form-id', deployment.id)) {
        filledCount++;
        filledFields.push('ID Triển khai');
      }
      
      if (setValue('form-gcp-project', deployment.gcp?.projectId)) {
        filledCount++;
        filledFields.push('GCP Project ID');
      }
      
      if (setValue('form-gcp-email', deployment.gcp?.accountEmail)) {
        filledCount++;
        filledFields.push('GCP Email');
      }
      
      if (setValue('form-cf-account-id', deployment.cloudflare?.accountId)) {
        filledCount++;
        filledFields.push('Cloudflare Account ID');
      }
      
      if (setValue('form-cf-email', deployment.cloudflare?.email)) {
        filledCount++;
        filledFields.push('Cloudflare Email');
      }
      
      if (setValue('form-worker-name', deployment.workerName)) {
        filledCount++;
        filledFields.push('Worker Name');
      }
      
      if (setValue('form-pages-name', deployment.pagesProjectName)) {
        filledCount++;
        filledFields.push('Pages Project Name');
      }
      
      // Fill secrets (handle both deployment.secrets and flat secrets object)
      const secrets = deployment.secrets || deployment;
      if (secrets) {
        if (setValue('form-secret-rapidapi-key', secrets.RAPIDAPI_KEY)) {
          filledCount++;
          filledFields.push('RAPIDAPI_KEY');
        }
        if (setValue('form-secret-rapidapi-host', secrets.RAPIDAPI_HOST)) {
          filledCount++;
          filledFields.push('RAPIDAPI_HOST');
        }
        if (setValue('form-secret-rapidapi-endpoint', secrets.RAPIDAPI_ENDPOINT)) {
          filledCount++;
          filledFields.push('RAPIDAPI_ENDPOINT');
        }
        if (setValue('form-secret-google-key', secrets.GOOGLE_CLOUD_API_KEY)) {
          filledCount++;
          filledFields.push('GOOGLE_CLOUD_API_KEY');
        }
        if (setValue('form-secret-google-endpoint', secrets.GOOGLE_VISION_ENDPOINT)) {
          filledCount++;
          filledFields.push('GOOGLE_VISION_ENDPOINT');
        }
      }
      
      // Show success message with count
      if (filledCount > 0) {
        console.log(`Filled ${filledCount} fields:`, filledFields);
        console.log('Deployment data:', deployment);
        window.toast?.success(`Đã điền ${filledCount} trường từ cấu hình\n${filledFields.join(', ')}`);
      } else {
        console.error('No fields filled. Deployment data:', deployment);
        console.error('Available keys:', Object.keys(deployment));
        window.toast?.warning(`Không tìm thấy dữ liệu để điền vào form. Kiểm tra console để xem chi tiết.`);
      }
    }).catch((error) => {
      console.error('Error waiting for form:', error);
      window.toast?.error(`Lỗi: Không thể tìm thấy form. ${error.message}`);
    });
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
      
      // Clear the saved draft since deployment was successfully created
      this.clearFormDraft();
      
      this.hide();
      window.toast?.success('Đã lưu triển khai thành công!');
    } catch (error) {
      window.toast?.error(`Lỗi lưu triển khai: ${error.message}`);
    }
  },

  clearFormDraft() {
    try {
      localStorage.removeItem('deployment-form-draft');
      console.log('[Auto-save] Cleared saved form draft');
    } catch (error) {
      console.error('[Auto-save] Failed to clear form draft:', error);
    }
  },

  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

