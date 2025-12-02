// Deployment form management
window.deploymentForm = {
  async show(deployment) {
    try {
      const formSection = document.getElementById('deployment-form-section');
      const listSection = document.getElementById('deployment-list-section');
      
      if (!formSection || !listSection) {
        console.error('[deploymentForm.show] Form sections not found');
        window.toast?.error('Không tìm thấy form. Vui lòng refresh trang.');
        return;
      }
      
      formSection.classList.remove('hidden');
      listSection.classList.add('hidden');

      const formTitle = document.getElementById('form-title');
      if (formTitle) {
        formTitle.textContent = deployment ? 'Chỉnh sửa Deploy' : 'Deploy store mới';
      }

      console.log('[deploymentForm.show] Rendering form for deployment:', deployment?.id, deployment?.name);
    await this.renderForm(deployment);
    // Reset auto-save setup flag when showing new form
    this._autoSaveSetup = false;
    // Set auto-save enabled flag based on whether we're editing or creating
    this._autoSaveEnabled = !!deployment;
    this.setupFormListeners(deployment);
    console.log('[deploymentForm.show] Form rendered successfully');
    } catch (error) {
      console.error('[deploymentForm.show] Error:', error);
      window.toast?.error(`Lỗi mở form: ${error.message}`);
      // Re-show list section on error
      const listSection = document.getElementById('deployment-list-section');
      if (listSection) listSection.classList.remove('hidden');
      const formSection = document.getElementById('deployment-form-section');
      if (formSection) formSection.classList.add('hidden');
    }
  },

  hide() {
    const formSection = document.getElementById('deployment-form-section');
    const listSection = document.getElementById('deployment-list-section');
    
    if (formSection) formSection.classList.add('hidden');
    if (listSection) listSection.classList.remove('hidden');
  },

  async renderForm(deployment) {
    try {
      const formContainer = document.getElementById('deployment-form');
      if (!formContainer) {
        console.error('[renderForm] Form container not found');
        throw new Error('Form container not found');
      }

      const isEdit = !!deployment;
      
      // Auto-fill from existing deployments if creating new
      let deploymentData = deployment;
      
      // If editing, normalize the deployment structure (secrets might be flat or nested)
      if (deployment) {
        // Ensure deployment has required fields
        if (!deployment.id) {
          console.error('[renderForm] Deployment missing id:', deployment);
          throw new Error('Deployment thiếu ID');
        }
        
        // Normalize secrets structure - handle both flat and nested
        if (!deployment.secrets) {
          // Secrets are flat, create nested structure for form
          deploymentData = {
            ...deployment,
            // Ensure nested objects exist
            gcp: deployment.gcp || {},
            cloudflare: deployment.cloudflare || {},
            secrets: {
              RAPIDAPI_KEY: deployment.RAPIDAPI_KEY || '',
              RAPIDAPI_HOST: deployment.RAPIDAPI_HOST || '',
              RAPIDAPI_ENDPOINT: deployment.RAPIDAPI_ENDPOINT || '',
              GOOGLE_VISION_API_KEY: deployment.GOOGLE_VISION_API_KEY || '',
              GOOGLE_VERTEX_PROJECT_ID: deployment.GOOGLE_VERTEX_PROJECT_ID || '',
              GOOGLE_VERTEX_LOCATION: deployment.GOOGLE_VERTEX_LOCATION || 'us-central1',
              GOOGLE_VISION_ENDPOINT: deployment.GOOGLE_VISION_ENDPOINT || '',
              GOOGLE_SERVICE_ACCOUNT_EMAIL: deployment.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
              GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: deployment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || ''
            }
          };
        } else {
          // Already has nested structure, ensure nested objects exist
          deploymentData = {
            ...deployment,
            gcp: deployment.gcp || {},
            cloudflare: deployment.cloudflare || {}
          };
        }
        
        console.log('[renderForm] Editing deployment:', {
          id: deploymentData.id,
          name: deploymentData.name,
          hasGcp: !!deploymentData.gcp,
          hasCloudflare: !!deploymentData.cloudflare,
          hasSecrets: !!deploymentData.secrets
        });
      }
    
    if (!deployment) {
      // Check if we're importing (skip draft loading if importing)
      const isImporting = window._isImportingDeployment || false;
      window._isImportingDeployment = false; // Reset flag
      
      // Clear draft when creating new deployment (user wants blank form)
      // Do this BEFORE rendering to ensure draft is cleared
      if (!isImporting) {
        await this.clearFormDraft();
        // Reset draft tracking
        this._lastDraftString = '';
      }
      
      // All fields must be blank for new deployment
      deploymentData = {
        id: `deployment-${Date.now()}`,
        name: '',
        gcp: {
          projectId: '',
          accountEmail: ''
        },
        cloudflare: {
          accountId: '',
          email: ''
        },
        secrets: {
          RAPIDAPI_KEY: '',
          RAPIDAPI_HOST: '',
          RAPIDAPI_ENDPOINT: '',
          GOOGLE_VISION_API_KEY: '',
          GOOGLE_VERTEX_PROJECT_ID: '',
          GOOGLE_VERTEX_LOCATION: 'us-central1',
          GOOGLE_VISION_ENDPOINT: ''
        },
        workerName: '',
        pagesProjectName: '',
        databaseName: '',
        bucketName: ''
      };
    }

    formContainer.innerHTML = `
      <form id="deployment-form-form" class="deployment-form-grid">
        <!-- Section 1: Basic Info -->
        <div class="form-section-card form-section-basic">
          <div class="form-section-header">
            <h3 class="form-section-title">📋 Thông tin Cơ bản</h3>
          </div>
          <div class="form-section-content">
            <div class="form-group">
              <label class="form-label">Tên triển khai *</label>
              <input type="text" class="form-input" id="form-name" value="${this.escapeHtml(deploymentData.name)}" required>
            </div>
            <div class="form-group">
              <label class="form-label">ID triển khai *</label>
              <input type="text" class="form-input" id="form-id" value="${this.escapeHtml(deploymentData.id)}" required ${isEdit ? 'readonly' : ''}>
            </div>
          </div>
        </div>

        <!-- Section 2: GCP Configuration -->
        <div class="form-section-card form-section-gcp">
          <div class="form-section-header">
            <h3 class="form-section-title">🌐 Google Cloud Platform</h3>
          </div>
          <div class="form-section-content">
            <div class="form-group">
              <label class="form-label">
                Project ID *
                <button type="button" id="btn-fetch-gcp-projects" class="label-fetch-btn" title="Lấy danh sách GCP projects">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                  </svg>
                  <span>Tự động tìm</span>
                </button>
              </label>
              <input type="text" class="form-input" id="form-gcp-project" value="${this.escapeHtml(deploymentData.gcp?.projectId || '')}" required>
            </div>
            <div class="form-group">
              <label class="form-label">
                Account Email
                <button type="button" id="btn-fetch-gcp-email" class="label-fetch-btn" title="Lấy email GCP hiện tại">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                  </svg>
                  <span>Tự động tìm</span>
                </button>
              </label>
              <input type="email" class="form-input" id="form-gcp-email" value="${this.escapeHtml(deploymentData.gcp?.accountEmail || '')}">
            </div>
          </div>
        </div>

        <!-- Section 3: Cloudflare Configuration -->
        <div class="form-section-card form-section-cloudflare">œ
          <div class="form-section-header">
            <h3 class="form-section-title">☁️ Cloudflare</h3>
          </div>
          <div class="form-section-content">
            <div class="form-group">
              <label class="form-label">
                Account ID
                <button type="button" id="btn-fetch-cf-info" class="label-fetch-btn" title="Lấy Account ID và Email Cloudflare">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                  </svg>
                  <span>Tự động tìm</span>
                </button>
              </label>
              <input type="text" class="form-input" id="form-cf-account-id" value="${this.escapeHtml(deploymentData.cloudflare?.accountId || '')}" placeholder="32-character hex string">
            </div>
            <div class="form-group">
              <label class="form-label">Email</label>
              <input type="email" class="form-input" id="form-cf-email" value="${this.escapeHtml(deploymentData.cloudflare?.email || '')}">
            </div>
          </div>
        </div>

        <!-- Section 4: Cloudflare Projects -->
        <div class="form-section-card form-section-projects">
          <div class="form-section-header">
            <h3 class="form-section-title">🔧 Cloudflare Projects</h3>
          </div>
          <div class="form-section-content">
            <div class="form-group">
              <label class="form-label">Worker Name *</label>
              <input type="text" class="form-input" id="form-worker-name" value="${this.escapeHtml(deploymentData.workerName || '')}" required>
              <small class="form-hint">Unique name for your Cloudflare Worker (backend API)</small>
            </div>
            <div class="form-group">
              <label class="form-label">Pages Project Name *</label>
              <input type="text" class="form-input" id="form-pages-name" value="${this.escapeHtml(deploymentData.pagesProjectName || '')}" required>
              <small class="form-hint">Unique name for your Cloudflare Pages (frontend)</small>
            </div>
            <div class="form-group">
              <label class="form-label">D1 Database Name</label>
              <input type="text" class="form-input" id="form-database-name" value="${this.escapeHtml(deploymentData.databaseName || '')}">
              <small class="form-hint">Database name for storing app data</small>
            </div>
            <div class="form-group">
              <label class="form-label">R2 Bucket Name</label>
              <input type="text" class="form-input" id="form-bucket-name" value="${this.escapeHtml(deploymentData.bucketName || '')}">
              <small class="form-hint">Bucket name for image storage</small>
            </div>
          </div>
        </div>

        <!-- Section 5: RapidAPI Secrets -->
        <div class="form-section-card form-section-rapidapi">
          <div class="form-section-header">
            <h3 class="form-section-title">🔑 RapidAPI</h3>
            <button type="button" id="btn-import-deployment" class="section-action-btn" title="Nhập từ file JSON">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Nhập JSON</span>
            </button>
          </div>
          <div class="form-section-content">
            <div class="form-group">
              <label class="form-label">API Key *</label>
              <input type="text" class="form-input" id="form-secret-rapidapi-key" value="${this.escapeHtml(deploymentData.secrets?.RAPIDAPI_KEY || '')}" required>
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
        </div>

        <!-- Section 6: Google Cloud Secrets -->
        <div class="form-section-card form-section-google">
          <div class="form-section-header">
            <h3 class="form-section-title">☁️ Google Cloud Secrets</h3>
          </div>
          <div class="form-section-content">
            <div class="form-group">
              <label class="form-label">Vision API Key *</label>
              <input type="text" class="form-input" id="form-secret-google-vision-key" value="${this.escapeHtml(deploymentData.secrets?.GOOGLE_VISION_API_KEY || '')}" required>
              <small class="form-hint">For SafeSearch (Vision API)</small>
            </div>
            <div class="form-group">
              <label class="form-label">Vertex AI Project ID *</label>
              <input type="text" class="form-input" id="form-secret-google-vertex-project-id" value="${this.escapeHtml(deploymentData.secrets?.GOOGLE_VERTEX_PROJECT_ID || '')}" required>
              <small class="form-hint">GCP Project ID for Vertex AI</small>
            </div>
            <div class="form-group">
              <label class="form-label">Vertex AI Location *</label>
              <input type="text" class="form-input" id="form-secret-google-vertex-location" value="${this.escapeHtml(deploymentData.secrets?.GOOGLE_VERTEX_LOCATION || 'us-central1')}" required>
              <small class="form-hint">Region for Vertex AI (e.g., us-central1)</small>
            </div>
            <div class="form-group">
              <label class="form-label">Vision Endpoint *</label>
              <input type="text" class="form-input" id="form-secret-google-endpoint" value="${this.escapeHtml(deploymentData.secrets?.GOOGLE_VISION_ENDPOINT || '')}" required>
            </div>
            <div class="form-group">
              <label class="form-label">
                Service Account Email *
                <button type="button" id="btn-fetch-service-account" class="label-fetch-btn" title="Tự động lấy Service Account credentials">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"></path>
                  </svg>
                </button>
              </label>
              <input type="email" class="form-input" id="form-secret-google-service-account-email" value="${this.escapeHtml(deploymentData.secrets?.GOOGLE_SERVICE_ACCOUNT_EMAIL || '')}" required>
              <small class="form-hint">GCP Service Account email for Vertex AI OAuth</small>
            </div>
            <div class="form-group">
              <label class="form-label">Service Account Private Key *</label>
              <textarea class="form-input" id="form-secret-google-service-account-key" rows="4" required>${this.escapeHtml(deploymentData.secrets?.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '')}</textarea>
              <small class="form-hint">GCP Service Account private key (JSON format, include newlines)</small>
            </div>
          </div>
        </div>
      </form>
    `;
    } catch (error) {
      console.error('[renderForm] Error:', error);
      throw error; // Re-throw to be caught by show()
    }
  },

  setupFormListeners(deployment) {
    // Cancel button (in header)
    const btnCancel = document.getElementById('btn-cancel-form');
    if (btnCancel) {
      // Remove existing listeners to avoid duplicates
      const newBtnCancel = btnCancel.cloneNode(true);
      btnCancel.parentNode?.replaceChild(newBtnCancel, btnCancel);
      newBtnCancel.addEventListener('click', () => {
        this.hide();
      });
    }

    // Import RapidAPI secrets button (in RapidAPI section)
    const btnImport = document.getElementById('btn-import-deployment');
    if (btnImport) {
      btnImport.addEventListener('click', () => {
        this.showImportRapidAPIModal();
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

    const btnFetchServiceAccount = document.getElementById('btn-fetch-service-account');
    if (btnFetchServiceAccount) {
      btnFetchServiceAccount.addEventListener('click', async () => {
        await this.fetchServiceAccountCredentials();
      });
    }

    // AUTO-FETCH Cloudflare Account ID when form opens (if not already set)
    const accountIdField = document.getElementById('form-cf-account-id');
    if (accountIdField && !accountIdField.value) {
      // Auto-fetch after a short delay to let form render
      setTimeout(async () => {
        try {
          const result = await window.electronAPI.helperGetCloudflareInfo();
          if (result.success && result.accountId && !accountIdField.value) {
            accountIdField.value = result.accountId;
            accountIdField.dispatchEvent(new Event('input', { bubbles: true }));
            console.log('[Auto-fetch] Automatically filled Account ID:', result.accountId);
            // Show subtle notification
            window.toast?.success(`✅ Đã tự động lấy Account ID: ${result.accountId}`, { duration: 3000 });
          }
        } catch (e) {
          // Silently fail - user can click button if needed
          console.log('[Auto-fetch] Could not auto-fetch Account ID:', e.message);
        }
      }, 500);
    }

    // AUTO-FETCH Service Account Credentials when form opens (if not already set)
    const saEmailField = document.getElementById('form-secret-google-service-account-email');
    const saKeyField = document.getElementById('form-secret-google-service-account-key');
    if ((saEmailField && !saEmailField.value) || (saKeyField && !saKeyField.value)) {
      // Auto-fetch after a longer delay to let GCP project be set first
      setTimeout(async () => {
        try {
          const result = await window.electronAPI.helperGetServiceAccountCredentials();
          if (result.success && result.email && result.privateKey) {
            if (saEmailField && !saEmailField.value) {
              saEmailField.value = result.email;
              saEmailField.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (saKeyField && !saKeyField.value) {
              saKeyField.value = result.privateKey;
              saKeyField.dispatchEvent(new Event('input', { bubbles: true }));
            }
            console.log('[Auto-fetch] Automatically filled Service Account credentials');
            // Show subtle notification
            window.toast?.success(`✅ Đã tự động lấy Service Account credentials`, { duration: 3000 });
          } else if (result.error) {
            // Only log error, don't show toast - user can fill manually
            console.log('[Auto-fetch] Could not auto-fetch Service Account credentials:', result.error);
          }
        } catch (e) {
          // Silently fail - user can fill manually
          console.log('[Auto-fetch] Could not auto-fetch Service Account credentials:', e.message);
        }
      }, 1500);
    }

    const btnFetchCFEmail = document.getElementById('btn-fetch-cf-email');
    if (btnFetchCFEmail) {
      btnFetchCFEmail.addEventListener('click', async () => {
        await this.fetchCloudflareEmail();
      });
    }

    // Combined Cloudflare fetch - fetch both ID and email
    const btnFetchCFInfo = document.getElementById('btn-fetch-cf-info');
    if (btnFetchCFInfo) {
      btnFetchCFInfo.addEventListener('click', async () => {
        await this.fetchCloudflareInfo();
        // Also fetch email after a short delay
        setTimeout(async () => {
          await this.fetchCloudflareEmail();
        }, 500);
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
    // Prevent duplicate listeners by checking if already set up
    if (this._autoSaveSetup) {
      return;
    }
    this._autoSaveSetup = true;

    // Don't auto-save if disabled (for new deployments)
    if (this._autoSaveEnabled === false) {
      return;
    }

    // Shared debounced save function
    let saveTimeout;
    const debouncedSave = () => {
      // Don't save if auto-save is disabled
      if (this._autoSaveEnabled === false) {
        return;
      }
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        this.saveFormDraft();
      }, 2000); // Increased to 2 seconds to reduce frequency
    };

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
      'form-secret-google-vision-key',
      'form-secret-google-vertex-project-id',
      'form-secret-google-vertex-location',
      'form-secret-google-endpoint',
      'form-secret-google-service-account-email',
      'form-secret-google-service-account-key'
    ];

    formFields.forEach(fieldId => {
      const field = document.getElementById(fieldId);
      if (field && !field.dataset.autoSaveAttached) {
        field.dataset.autoSaveAttached = 'true';
        
        // Save on change (immediate)
        field.addEventListener('change', () => {
          this.saveFormDraft();
        });
        
        // Save on input (debounced)
        field.addEventListener('input', debouncedSave);
      }
    });
  },

  async saveFormDraft() {
    // Prevent saving if already saving
    if (this._savingDraft) {
      return;
    }

    const draft = {
      name: document.getElementById('form-name')?.value || '',
      id: document.getElementById('form-id')?.value || '',
      gcpProjectId: document.getElementById('form-gcp-project')?.value || '',
      gcpEmail: document.getElementById('form-gcp-email')?.value || '',
      cfAccountId: document.getElementById('form-cf-account-id')?.value || '',
      cfEmail: document.getElementById('form-cf-email')?.value || '',
      workerName: document.getElementById('form-worker-name')?.value || '',
      pagesProjectName: document.getElementById('form-pages-name')?.value || '',
      databaseName: document.getElementById('form-database-name')?.value || '',
      bucketName: document.getElementById('form-bucket-name')?.value || '',
      secrets: {
        RAPIDAPI_KEY: document.getElementById('form-secret-rapidapi-key')?.value || '',
        RAPIDAPI_HOST: document.getElementById('form-secret-rapidapi-host')?.value || '',
        RAPIDAPI_ENDPOINT: document.getElementById('form-secret-rapidapi-endpoint')?.value || '',
        GOOGLE_VISION_API_KEY: document.getElementById('form-secret-google-vision-key')?.value || '',
        GOOGLE_VERTEX_PROJECT_ID: document.getElementById('form-secret-google-vertex-project-id')?.value || '',
        GOOGLE_VERTEX_LOCATION: document.getElementById('form-secret-google-vertex-location')?.value || 'us-central1',
        GOOGLE_VISION_ENDPOINT: document.getElementById('form-secret-google-endpoint')?.value || '',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: document.getElementById('form-secret-google-service-account-email')?.value || '',
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: document.getElementById('form-secret-google-service-account-key')?.value || ''
      },
      savedAt: new Date().toISOString()
    };

    // Check if form is completely blank (no name, no id, no meaningful data)
    const isBlank = !draft.name.trim() && 
                   !draft.gcpProjectId.trim() && 
                   !draft.workerName.trim() && 
                   !draft.pagesProjectName.trim() &&
                   !draft.secrets.RAPIDAPI_KEY.trim() &&
                   !draft.secrets.GOOGLE_VISION_API_KEY.trim();

    // If form is blank, clear the draft instead of saving
    if (isBlank) {
      await this.clearFormDraft();
      this._lastDraftString = '';
      return;
    }

    // Check if draft actually changed (compare with last saved draft)
    const draftString = JSON.stringify(draft);
    if (this._lastDraftString === draftString) {
      return; // No changes, skip save
    }
    this._lastDraftString = draftString;

    try {
      this._savingDraft = true;
      window.electronAPI.configWrite({
        ...window.dashboard?.getCurrentConfig(),
        formDraft: draft
      }).then(() => {
      }).catch((error) => {
        console.error('[Auto-save] Failed to save form draft:', error);
      }).finally(() => {
        this._savingDraft = false;
      });
    } catch (error) {
      console.error('[Auto-save] Failed to save form draft:', error);
      this._savingDraft = false;
    }
  },

  async loadFormDraft() {
    try {
      const config = await window.electronAPI.configRead();
      if (config && config.formDraft) {
        console.log('[Auto-load] Found saved form data from:', config.formDraft.savedAt);
        return config.formDraft;
      }
    } catch (error) {
      console.error('[Auto-load] Failed to load form draft:', error);
    }
    return null;
  },

  async clearFormDraft() {
    try {
      const config = window.dashboard?.getCurrentConfig() || {};
      const result = await window.electronAPI.configWrite({
        ...config,
        formDraft: null
      });
      if (result && result.success) {
        console.log('[clearFormDraft] Cleared form draft from database');
        this._lastDraftString = '';
      } else {
        console.error('[clearFormDraft] Failed to clear form draft:', result?.error);
      }
    } catch (error) {
      console.error('[clearFormDraft] Failed to clear form draft:', error);
    }
  },

  async fetchGCPProjects() {
    const fetchFn = async () => {
    try {
      const result = await window.electronAPI.helperGetGCPProjects();
      if (!result.success) {
        let errorMessage = `Không thể lấy danh sách projects: ${result.error}`;
        
        if (result.needsLogin) {
          errorMessage += '\n\nVui lòng chạy lệnh sau trong terminal:\n';
          errorMessage += 'gcloud auth login\n';
          errorMessage += 'hoặc\n';
          errorMessage += 'gcloud auth application-default login\n\n';
          errorMessage += 'Sau đó làm mới trang này.';
        } else {
          errorMessage += '\nHãy đảm bảo bạn đã đăng nhập GCP và cài đặt gcloud CLI';
        }
        
        window.toast?.error(errorMessage);
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
    };

    // Show loading overlay during fetch
    if (window.loading && window.loading.withLoading) {
      await window.loading.withLoading(fetchFn, 'Đang lấy danh sách GCP projects...');
    } else {
      await fetchFn();
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
    const fetchFn = async () => {
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
    };

    // Show loading overlay during fetch
    if (window.loading && window.loading.withLoading) {
      await window.loading.withLoading(fetchFn, 'Đang lấy thông tin GCP...');
    } else {
      await fetchFn();
    }
  },

  async fetchServiceAccountCredentials() {
    const fetchFn = async () => {
      try {
        const emailField = document.getElementById('form-secret-google-service-account-email');
        const keyField = document.getElementById('form-secret-google-service-account-key');
        
        if (!emailField || !keyField) {
          window.toast?.warning('Form chưa được hiển thị. Vui lòng đảm bảo form đã được mở.');
          return;
        }

        const result = await window.electronAPI.helperGetServiceAccountCredentials();
        console.log('Service Account credentials result:', result);
        
        if (result.success && result.email && result.privateKey) {
          emailField.value = result.email;
          emailField.dispatchEvent(new Event('input', { bubbles: true }));
          keyField.value = result.privateKey;
          keyField.dispatchEvent(new Event('input', { bubbles: true }));
          console.log('Filled Service Account credentials');
          window.toast?.success(`✅ Đã lấy Service Account credentials thành công!`);
        } else {
          let errorMessage = `Không thể lấy Service Account credentials: ${result.error || 'Unknown error'}`;
          
          if (result.needsLogin) {
            errorMessage += '\n\nVui lòng đăng nhập GCP trước.';
          } else if (result.needsProject) {
            errorMessage += '\n\nVui lòng chọn GCP project trước.';
          } else if (result.details) {
            errorMessage += `\n\nChi tiết: ${result.details}`;
          }
          
          window.toast?.error(errorMessage);
        }
      } catch (error) {
        console.error('Error fetching Service Account credentials:', error);
        window.toast?.error(`Lỗi: ${error.message}`);
      }
    };

    // Show loading overlay during fetch
    if (window.loading && window.loading.withLoading) {
      await window.loading.withLoading(fetchFn, 'Đang lấy Service Account credentials...');
    } else {
      await fetchFn();
    }
  },

  async fetchCloudflareInfo() {
    const fetchFn = async () => {
    try {
      const accountIdField = document.getElementById('form-cf-account-id');
      const emailField = document.getElementById('form-cf-email');
      
        // Show loading state in fields
      if (accountIdField) accountIdField.value = 'Đang tải...';
      if (emailField) emailField.value = 'Đang tải...';
      
      const result = await window.electronAPI.helperGetCloudflareInfo();
      if (!result.success) {
        window.toast?.error(`Không thể lấy thông tin Cloudflare: ${result.error}\nHãy đảm bảo bạn đã đăng nhập Cloudflare và cài đặt wrangler CLI`);
        if (accountIdField) accountIdField.value = '';
        if (emailField) emailField.value = '';
        return;
      }

      // Always set email if available
      if (result.email && emailField) {
        emailField.value = result.email;
        emailField.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      // Set Account ID if found
      if (result.accountId && accountIdField) {
        accountIdField.value = result.accountId;
        accountIdField.dispatchEvent(new Event('input', { bubbles: true }));
        window.toast?.success(`✅ Đã tự động lấy thông tin Cloudflare\n📧 Email: ${result.email}\n🆔 Account ID: ${result.accountId}`);
      } else {
        // If email found but no account ID, still show email
        if (result.email && emailField) {
          emailField.value = result.email;
        }
        // Try one more time with API method
        window.toast?.warning(`Đã lấy email nhưng chưa tìm thấy Account ID. Đang thử phương pháp khác...`);
        
        // Retry with a slight delay to allow API methods to work
        setTimeout(async () => {
          try {
            const retryResult = await window.electronAPI.helperGetCloudflareInfo();
            if (retryResult.success && retryResult.accountId && accountIdField) {
              accountIdField.value = retryResult.accountId;
              accountIdField.dispatchEvent(new Event('input', { bubbles: true }));
              window.toast?.success(`✅ Đã tự động lấy Account ID: ${retryResult.accountId}`);
            } else if (!retryResult.accountId) {
              window.toast?.error(`Không thể tự động lấy Account ID. Vui lòng nhập thủ công từ Cloudflare Dashboard.`);
            }
          } catch (retryError) {
            window.toast?.error(`Không thể tự động lấy Account ID: ${retryError.message}`);
          }
        }, 1000);
      }
    } catch (error) {
      window.toast?.error(`Lỗi: ${error.message}`);
      const accountIdField = document.getElementById('form-cf-account-id');
      const emailField = document.getElementById('form-cf-email');
      if (accountIdField) accountIdField.value = '';
      if (emailField) emailField.value = '';
      }
    };

    // Show loading overlay during fetch
    if (window.loading && window.loading.withLoading) {
      await window.loading.withLoading(fetchFn, 'Đang lấy thông tin Cloudflare...');
    } else {
      await fetchFn();
    }
  },

  async fetchCloudflareEmail() {
    const fetchFn = async () => {
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
    };

    // Show loading overlay during fetch
    if (window.loading && window.loading.withLoading) {
      await window.loading.withLoading(fetchFn, 'Đang lấy thông tin Cloudflare...');
    } else {
      await fetchFn();
    }
  },

  showImportDeploymentModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'import-deployment-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 500px;">
        <div class="modal-header">
          <h2>📥 Nhập Cấu hình Deploy</h2>
          <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
        </div>
        <div class="modal-body">
          <div class="file-import-zone" style="text-align: center; padding: 2rem;">
            <button id="btn-select-deployment-file" class="btn btn-primary btn-large" style="font-size: 16px; padding: 12px 24px;">
              📁 Chọn File JSON
            </button>
            <p class="file-import-hint" style="margin-top: 1rem; color: var(--text-secondary);">
              Chọn file JSON chứa cấu hình triển khai<br>
              <small>File sẽ tự động được nhập vào form</small>
            </p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">Hủy</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // File selection - auto import to form
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
                (deployment.RAPIDAPI_KEY || deployment.RAPIDAPI_HOST || deployment.GOOGLE_VISION_API_KEY);
              
              if (isSecretsOnly) {
                console.log('Detected secrets-only file');
                // Keep as is, fillFormFromDeployment will handle it
              }
              // Otherwise assume it's a deployment object
            }
            
            // Auto-import to form immediately
            // Set flag BEFORE showing form to skip draft loading
            window._isImportingDeployment = true;
            
            // Close modal first
            modal.remove();
            
            // Show form and fill it automatically
            await this.show(null); // Show form (create new deployment)
            
            // Wait for form to render, then fill it
            setTimeout(() => {
              this.fillFormFromDeployment(deployment).then(() => {
                // Save imported data to draft AFTER form is filled
                setTimeout(() => {
                  this.saveFormDraft();
                  window.toast?.success('Đã nhập cấu hình vào form thành công!');
                }, 300);
              }).catch((error) => {
                console.error('Error filling form:', error);
                window.toast?.error('Lỗi khi điền form: ' + error.message);
              });
            }, 300);
          }
        } catch (error) {
          console.error('Error loading config file:', error);
          window.toast?.error('Không thể đọc file: ' + error.message);
        }
      });
    }
  },

  showImportRapidAPIModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'import-rapidapi-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 500px;">
        <div class="modal-header">
          <h2>📥 Nhập Secrets</h2>
          <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
        </div>
        <div class="modal-body">
          <div class="file-import-zone" style="text-align: center; padding: 2rem;">
            <button id="btn-select-rapidapi-file" class="btn btn-primary btn-large" style="font-size: 16px; padding: 12px 24px;">
              📁 Chọn File JSON
            </button>
            <p class="file-import-hint" style="margin-top: 1rem; color: var(--text-secondary);">
              Chọn file JSON chứa secrets<br>
              <small>Sẽ điền RapidAPI và Google Cloud secrets, không ảnh hưởng các trường khác</small>
            </p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">Hủy</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    const btnSelectFile = modal.querySelector('#btn-select-rapidapi-file');
    if (btnSelectFile) {
      btnSelectFile.addEventListener('click', async () => {
        try {
          const result = await window.electronAPI.dialogLoadConfig();
          if (result.success) {
            const data = result.config;
            
            // Extract secrets from various possible structures
            let secrets = {};
            
            if (data.secrets) {
              secrets = data.secrets;
            }
            else if (data.RAPIDAPI_KEY || data.GOOGLE_VISION_API_KEY) {
              // Flat secrets object
              secrets = data;
            }
            else if (data.deployments && Array.isArray(data.deployments) && data.deployments.length > 0) {
              const firstDeployment = data.deployments[0];
              if (firstDeployment.secrets) {
                secrets = firstDeployment.secrets;
              } else if (firstDeployment.RAPIDAPI_KEY || firstDeployment.GOOGLE_VISION_API_KEY) {
                secrets = firstDeployment;
              }
            }
            
            // Check if we found any secrets
            if (!secrets.RAPIDAPI_KEY && !secrets.GOOGLE_VISION_API_KEY) {
              window.toast?.error('File không chứa secrets hợp lệ (RapidAPI hoặc Google Cloud).');
              modal.remove();
              return;
            }
            
            modal.remove();
            
            const setSecretValue = (id, value) => {
              const el = document.getElementById(id);
              if (el && value) {
                el.value = String(value);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              }
              return false;
            };
            
            let filledCount = 0;
            const filledFields = [];
            
            // Fill RapidAPI secrets
            if (setSecretValue('form-secret-rapidapi-key', secrets.RAPIDAPI_KEY)) {
              filledCount++;
              filledFields.push('RAPIDAPI_KEY');
            }
            if (setSecretValue('form-secret-rapidapi-host', secrets.RAPIDAPI_HOST)) {
              filledCount++;
              filledFields.push('RAPIDAPI_HOST');
            }
            if (setSecretValue('form-secret-rapidapi-endpoint', secrets.RAPIDAPI_ENDPOINT)) {
              filledCount++;
              filledFields.push('RAPIDAPI_ENDPOINT');
            }
            
            // Fill Google Cloud secrets
            if (setSecretValue('form-secret-google-vision-key', secrets.GOOGLE_VISION_API_KEY)) {
              filledCount++;
              filledFields.push('GOOGLE_VISION_API_KEY');
            }
            if (setSecretValue('form-secret-google-vertex-project-id', secrets.GOOGLE_VERTEX_PROJECT_ID)) {
              filledCount++;
              filledFields.push('GOOGLE_VERTEX_PROJECT_ID');
            }
            if (setSecretValue('form-secret-google-vertex-location', secrets.GOOGLE_VERTEX_LOCATION)) {
              filledCount++;
              filledFields.push('GOOGLE_VERTEX_LOCATION');
            }
            if (setSecretValue('form-secret-google-endpoint', secrets.GOOGLE_VISION_ENDPOINT)) {
              filledCount++;
              filledFields.push('GOOGLE_VISION_ENDPOINT');
            }
            if (setSecretValue('form-secret-google-service-account-email', secrets.GOOGLE_SERVICE_ACCOUNT_EMAIL)) {
              filledCount++;
              filledFields.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
            }
            if (setSecretValue('form-secret-google-service-account-key', secrets.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)) {
              filledCount++;
              filledFields.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
            }
            
            if (filledCount > 0) {
              const rapidapiCount = filledFields.filter(f => f.startsWith('RAPIDAPI')).length;
              const googleCount = filledFields.filter(f => f.startsWith('GOOGLE')).length;
              let message = `Đã nhập ${filledCount} trường secrets thành công!`;
              if (rapidapiCount > 0 && googleCount > 0) {
                message += ` (${rapidapiCount} RapidAPI, ${googleCount} Google Cloud)`;
              } else if (rapidapiCount > 0) {
                message += ` (${rapidapiCount} RapidAPI)`;
              } else if (googleCount > 0) {
                message += ` (${googleCount} Google Cloud)`;
              }
              window.toast?.success(message);
            } else {
              window.toast?.warning('Không tìm thấy trường secrets nào để điền.');
            }
          }
        } catch (error) {
          console.error('Error loading secrets file:', error);
          window.toast?.error('Không thể đọc file: ' + error.message);
        }
      });
    }
  },

  fillFormFromDeployment(deployment) {
    if (!deployment) {
      window.toast?.warning('Không có dữ liệu để điền vào form');
      return Promise.resolve();
    }
    
    console.log('Filling form with data:', deployment);
    
    // Check if this is a secrets-only file (flat object with secret keys)
    const isSecretsOnly = !deployment.id && !deployment.name && !deployment.gcp && !deployment.cloudflare &&
      (deployment.RAPIDAPI_KEY || deployment.RAPIDAPI_HOST || deployment.GOOGLE_VISION_API_KEY);
    
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
    
    return waitForForm().then(() => {
      // Ensure form is visible
      const formSection = document.getElementById('deployment-form-section');
      if (formSection) {
        formSection.classList.remove('hidden');
      }
      
      // Fill all form fields with better error handling
      const setValue = (id, value, allowEmpty = false) => {
        const el = document.getElementById(id);
        if (!el) {
          console.warn(`Form element not found: ${id}`);
          return false;
        }
        // If allowEmpty is true, set even empty strings (for import)
        // Otherwise, skip undefined/null/empty
        if (allowEmpty) {
          el.value = value !== undefined && value !== null ? String(value) : '';
          return true;
        } else if (value !== undefined && value !== null && value !== '') {
          el.value = String(value);
          return true;
        }
        return false;
      };
      
      let filledCount = 0;
      const filledFields = [];
      
      // Fill basic fields (allow empty for import to clear existing values)
      const isImporting = window._isImportingDeployment || false;
      
      if (setValue('form-name', deployment.name, isImporting)) {
        filledCount++;
        filledFields.push('Tên Deploy');
      }
      
      if (setValue('form-id', deployment.id, isImporting)) {
        filledCount++;
        filledFields.push('ID Deploy');
      }
      
      if (setValue('form-gcp-project', deployment.gcp?.projectId, isImporting)) {
        filledCount++;
        filledFields.push('GCP Project ID');
      }
      
      if (setValue('form-gcp-email', deployment.gcp?.accountEmail, isImporting)) {
        filledCount++;
        filledFields.push('GCP Email');
      }
      
      if (setValue('form-cf-account-id', deployment.cloudflare?.accountId, isImporting)) {
        filledCount++;
        filledFields.push('Cloudflare Account ID');
      }
      
      if (setValue('form-cf-email', deployment.cloudflare?.email, isImporting)) {
        filledCount++;
        filledFields.push('Cloudflare Email');
      }
      
      if (setValue('form-worker-name', deployment.workerName, isImporting)) {
        filledCount++;
        filledFields.push('Worker Name');
      }
      
      if (setValue('form-pages-name', deployment.pagesProjectName, isImporting)) {
        filledCount++;
        filledFields.push('Pages Project Name');
      }
      
      if (setValue('form-database-name', deployment.databaseName, isImporting)) {
        filledCount++;
        filledFields.push('Database Name');
      }
      
      if (setValue('form-bucket-name', deployment.bucketName, isImporting)) {
        filledCount++;
        filledFields.push('Bucket Name');
      }
      
      // Fill secrets (handle both deployment.secrets and flat secrets object)
      const secrets = deployment.secrets || deployment;
      if (secrets) {
        if (setValue('form-secret-rapidapi-key', secrets.RAPIDAPI_KEY, isImporting)) {
          filledCount++;
          filledFields.push('RAPIDAPI_KEY');
        }
        if (setValue('form-secret-rapidapi-host', secrets.RAPIDAPI_HOST, isImporting)) {
          filledCount++;
          filledFields.push('RAPIDAPI_HOST');
        }
        if (setValue('form-secret-rapidapi-endpoint', secrets.RAPIDAPI_ENDPOINT, isImporting)) {
          filledCount++;
          filledFields.push('RAPIDAPI_ENDPOINT');
        }
        if (setValue('form-secret-google-vision-key', secrets.GOOGLE_VISION_API_KEY, isImporting)) {
          filledCount++;
          filledFields.push('GOOGLE_VISION_API_KEY');
        }
        if (setValue('form-secret-google-vertex-project-id', secrets.GOOGLE_VERTEX_PROJECT_ID || deployment.GOOGLE_VERTEX_PROJECT_ID, isImporting)) {
          filledCount++;
          filledFields.push('GOOGLE_VERTEX_PROJECT_ID');
        }
        if (setValue('form-secret-google-vertex-location', secrets.GOOGLE_VERTEX_LOCATION || deployment.GOOGLE_VERTEX_LOCATION || 'us-central1', isImporting)) {
          filledCount++;
          filledFields.push('GOOGLE_VERTEX_LOCATION');
        }
        if (setValue('form-secret-google-endpoint', secrets.GOOGLE_VISION_ENDPOINT, isImporting)) {
          filledCount++;
          filledFields.push('GOOGLE_VISION_ENDPOINT');
        }
        if (setValue('form-secret-google-service-account-email', secrets.GOOGLE_SERVICE_ACCOUNT_EMAIL || deployment.GOOGLE_SERVICE_ACCOUNT_EMAIL, isImporting)) {
          filledCount++;
          filledFields.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
        }
        if (setValue('form-secret-google-service-account-key', secrets.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || deployment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, isImporting)) {
          filledCount++;
          filledFields.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
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
    const saveFn = async () => {
      try {
        console.log('[Save] Starting deployment save...');

      const config = window.dashboard?.getCurrentConfig();
      if (!config) {
        throw new Error('Không thể tải cấu hình');
      }

      // Get form elements with null checks
      const formIdEl = document.getElementById('form-id');
      const formNameEl = document.getElementById('form-name');
      const formGcpProjectEl = document.getElementById('form-gcp-project');
      const formGcpEmailEl = document.getElementById('form-gcp-email');
      const formCfAccountIdEl = document.getElementById('form-cf-account-id');
      const formCfEmailEl = document.getElementById('form-cf-email');
      const formWorkerNameEl = document.getElementById('form-worker-name');
      const formPagesNameEl = document.getElementById('form-pages-name');
      const formDatabaseNameEl = document.getElementById('form-database-name');
      const formBucketNameEl = document.getElementById('form-bucket-name');
      const formRapidApiKeyEl = document.getElementById('form-secret-rapidapi-key');
      const formRapidApiHostEl = document.getElementById('form-secret-rapidapi-host');
      const formRapidApiEndpointEl = document.getElementById('form-secret-rapidapi-endpoint');
      const formGoogleVisionKeyEl = document.getElementById('form-secret-google-vision-key');
      const formGoogleVertexProjectIdEl = document.getElementById('form-secret-google-vertex-project-id');
      const formGoogleVertexLocationEl = document.getElementById('form-secret-google-vertex-location');
      const formGoogleEndpointEl = document.getElementById('form-secret-google-endpoint');
      const formGoogleServiceAccountEmailEl = document.getElementById('form-secret-google-service-account-email');
      const formGoogleServiceAccountKeyEl = document.getElementById('form-secret-google-service-account-key');

      // Check for missing elements
      const missingElements = [];
      if (!formIdEl) missingElements.push('form-id');
      if (!formNameEl) missingElements.push('form-name');
      if (!formGcpProjectEl) missingElements.push('form-gcp-project');
      if (!formWorkerNameEl) missingElements.push('form-worker-name');
      if (!formPagesNameEl) missingElements.push('form-pages-name');
      if (!formRapidApiKeyEl) missingElements.push('form-secret-rapidapi-key');
      if (!formGoogleVisionKeyEl) missingElements.push('form-secret-google-vision-key');
      if (!formGoogleVertexProjectIdEl) missingElements.push('form-secret-google-vertex-project-id');

      if (missingElements.length > 0) {
        console.error('[Save] Missing form elements:', missingElements);
        throw new Error(`Form elements not found: ${missingElements.join(', ')}. Please refresh the page.`);
      }

      // Get values - NO DEFAULTS, NO TRYING TO HIDE ERRORS
      const deploymentId = formIdEl.value.trim();
      const deploymentName = formNameEl.value.trim();
      
      // Validate immediately - throw error if empty
      if (!deploymentId) {
        throw new Error('ID triển khai không được để trống');
      }
      if (!deploymentName) {
        throw new Error('Tên triển khai không được để trống');
      }
      
      const deployment = {
        id: deploymentId,
        name: deploymentName,
        gcp: {
          projectId: formGcpProjectEl.value.trim(),
          accountEmail: (formGcpEmailEl?.value || '').trim()
        },
        cloudflare: {
          accountId: (formCfAccountIdEl?.value || '').trim(),
          email: (formCfEmailEl?.value || '').trim()
        },
        // Flat structure for CLI compatibility (same as deployments-secrets.json)
        workerName: formWorkerNameEl.value.trim(),
        pagesProjectName: formPagesNameEl.value.trim(),
        databaseName: (formDatabaseNameEl?.value || '').trim(),
        bucketName: (formBucketNameEl?.value || '').trim(),
        RAPIDAPI_KEY: formRapidApiKeyEl.value.trim(),
        RAPIDAPI_HOST: formRapidApiHostEl.value.trim(),
        RAPIDAPI_ENDPOINT: formRapidApiEndpointEl.value.trim(),
        GOOGLE_VISION_API_KEY: formGoogleVisionKeyEl.value.trim(),
        GOOGLE_VERTEX_PROJECT_ID: formGoogleVertexProjectIdEl.value.trim(),
        GOOGLE_VERTEX_LOCATION: formGoogleVertexLocationEl.value.trim() || 'us-central1',
        GOOGLE_VISION_ENDPOINT: formGoogleEndpointEl.value.trim(),
        GOOGLE_SERVICE_ACCOUNT_EMAIL: formGoogleServiceAccountEmailEl.value.trim(),
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: formGoogleServiceAccountKeyEl.value.trim(),
        status: existingDeployment?.status || 'idle'
      };

      // Validate required fields
      if (!deployment.name) {
        throw new Error('Tên triển khai không được để trống');
      }
      if (!deployment.gcp.projectId) {
        throw new Error('GCP Project ID không được để trống');
      }
      if (!deployment.workerName) {
        throw new Error('Worker Name không được để trống');
      }
      if (!deployment.pagesProjectName) {
        throw new Error('Pages Project Name không được để trống');
      }

      console.log('[Save] Collected deployment data:', {
        id: deployment.id,
        name: deployment.name,
        workerName: deployment.workerName,
        gcpProjectId: deployment.gcp?.projectId,
        hasSecrets: !!(deployment.RAPIDAPI_KEY || deployment.GOOGLE_VISION_API_KEY)
      });

      // Validate flat structure (same as deployments-secrets.json format)
      // The saveDeployment function expects flat structure, not nested (for deployments-secrets.json format)
      const flatDeploymentForValidation = {
        workerName: deployment.workerName?.trim() || '',
        pagesProjectName: deployment.pagesProjectName?.trim() || '',
        databaseName: deployment.databaseName?.trim() || '',
        bucketName: deployment.bucketName?.trim() || '',
        RAPIDAPI_KEY: deployment.RAPIDAPI_KEY?.trim() || '',
        RAPIDAPI_HOST: deployment.RAPIDAPI_HOST?.trim() || '',
        RAPIDAPI_ENDPOINT: deployment.RAPIDAPI_ENDPOINT?.trim() || '',
        GOOGLE_VISION_API_KEY: deployment.GOOGLE_VISION_API_KEY?.trim() || '',
        GOOGLE_VERTEX_PROJECT_ID: deployment.GOOGLE_VERTEX_PROJECT_ID?.trim() || '',
        GOOGLE_VERTEX_LOCATION: deployment.GOOGLE_VERTEX_LOCATION?.trim() || '',
        GOOGLE_VISION_ENDPOINT: deployment.GOOGLE_VISION_ENDPOINT?.trim() || '',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: deployment.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() || '',
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: deployment.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim() || ''
      };

      // Check required fields with strict validation
      const requiredFields = [
        { key: 'workerName', label: 'Worker Name' },
        { key: 'pagesProjectName', label: 'Pages Project Name' },
        { key: 'databaseName', label: 'Database Name' },
        { key: 'bucketName', label: 'Bucket Name' },
        { key: 'RAPIDAPI_KEY', label: 'RapidAPI Key' },
        { key: 'RAPIDAPI_HOST', label: 'RapidAPI Host' },
        { key: 'RAPIDAPI_ENDPOINT', label: 'RapidAPI Endpoint' },
        { key: 'GOOGLE_VISION_API_KEY', label: 'Google Vision API Key' },
        { key: 'GOOGLE_VERTEX_PROJECT_ID', label: 'Vertex AI Project ID' },
        { key: 'GOOGLE_VERTEX_LOCATION', label: 'Vertex AI Location' },
        { key: 'GOOGLE_VISION_ENDPOINT', label: 'Google Vision Endpoint' },
        { key: 'GOOGLE_SERVICE_ACCOUNT_EMAIL', label: 'Service Account Email' },
        { key: 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', label: 'Service Account Private Key' }
      ];

      const missingFields = [];
      for (const field of requiredFields) {
        const value = flatDeploymentForValidation[field.key];
        if (!value || value.length === 0) {
          missingFields.push(field.label);
        }
      }

      if (missingFields.length > 0) {
        throw new Error(`Các trường bắt buộc chưa được điền:\n${missingFields.map(f => `  - ${f}`).join('\n')}\n\nVui lòng điền đầy đủ tất cả các trường bắt buộc trước khi lưu.`);
      }

      // Save to secrets.json (same file CLI uses)
      // Convert to flat structure for saveDeployment (secrets.json format)
      // Use validated values (already trimmed and checked)
      const flatDeployment = {
        workerName: flatDeploymentForValidation.workerName,
        pagesProjectName: flatDeploymentForValidation.pagesProjectName,
        databaseName: flatDeploymentForValidation.databaseName,
        bucketName: flatDeploymentForValidation.bucketName,
        RAPIDAPI_KEY: flatDeploymentForValidation.RAPIDAPI_KEY,
        RAPIDAPI_HOST: flatDeploymentForValidation.RAPIDAPI_HOST,
        RAPIDAPI_ENDPOINT: flatDeploymentForValidation.RAPIDAPI_ENDPOINT,
        GOOGLE_VISION_API_KEY: flatDeploymentForValidation.GOOGLE_VISION_API_KEY,
        GOOGLE_VERTEX_PROJECT_ID: flatDeploymentForValidation.GOOGLE_VERTEX_PROJECT_ID,
        GOOGLE_VERTEX_LOCATION: flatDeploymentForValidation.GOOGLE_VERTEX_LOCATION,
        GOOGLE_VISION_ENDPOINT: flatDeploymentForValidation.GOOGLE_VISION_ENDPOINT,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: flatDeploymentForValidation.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: flatDeploymentForValidation.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      };

      if (!config) {
        throw new Error('Không thể tải cấu hình');
      }

      const existingIndex = config.deployments?.findIndex(d => d.id === deployment.id);
      if (existingIndex >= 0) {
        config.deployments[existingIndex] = deployment;
      } else {
        if (!config.deployments) {
          config.deployments = [];
        }
        config.deployments.push(deployment);
      }

      const configWriteResult = await window.electronAPI.configWrite(config);
      if (!configWriteResult.success) {
        throw new Error(configWriteResult.error || 'Failed to save deployment');
      }

        // Reload config to reflect changes
        await window.dashboard.loadConfig();
        
        // Clear the saved draft since deployment was successfully created
        this.clearFormDraft();
        
        this.hide();
        window.toast?.success('Đã lưu triển khai thành công!');
      } catch (error) {
        window.toast?.error(`Lỗi lưu triển khai: ${error.message}`);
      }
    };
    
    if (window.loading && window.loading.withLoading) {
      return await window.loading.withLoading(saveFn, 'Đang lưu deployment...');
    } else {
      return await saveFn();
    }
  },

  async clearFormDraft() {
    try {
      const config = await window.electronAPI.configRead();
      if (config && config.formDraft) {
        delete config.formDraft;
        await window.electronAPI.configWrite(config);
      }
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

