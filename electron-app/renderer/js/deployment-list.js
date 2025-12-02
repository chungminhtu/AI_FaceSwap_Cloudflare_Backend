// Deployment list management
window.deploymentList = {
  render(deployments) {
    const container = document.getElementById('deployment-list');
    if (!container) return;

    if (deployments.length === 0) {
      container.innerHTML = `
        <div class="text-center" style="padding: 3rem; color: #999;">
          <p>Chưa có deploy nào. Nhấn "Thêm Deploy" để bắt đầu.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = deployments.map(deployment => this.renderDeploymentCard(deployment)).join('');
    
    // Attach event listeners
    deployments.forEach(deployment => {
      this.attachDeploymentListeners(deployment.id);
    });
  },

  renderDeploymentCard(deployment) {

    return `
      <div class="deployment-card" data-deployment-id="${deployment.id}">
        <div class="deployment-card-header">
          <div class="deployment-name">${this.escapeHtml(deployment.name)}</div>
          <div class="deployment-actions">
            <button class="btn btn-small btn-secondary btn-duplicate" data-id="${deployment.id}" title="Nhân đôi deployment này">Nhân đôi</button>
            <button class="btn btn-small btn-secondary btn-export" data-id="${deployment.id}" title="Xuất deployment này">Xuất</button>
            <button class="btn btn-small btn-secondary btn-edit" data-id="${deployment.id}">Sửa</button>
            <button class="btn btn-small btn-secondary btn-delete" data-id="${deployment.id}">Xóa</button>
          </div>
        </div>
        <div class="deployment-info">
          <div class="deployment-info-item">
            <span class="deployment-info-label">GCP Project:</span>
            <span>${deployment.gcp?.projectId || 'N/A'}</span>
          </div>
          <div class="deployment-info-item">
            <span class="deployment-info-label">GCP Account:</span>
            <span>${deployment.gcp?.accountEmail || 'N/A'}</span>
          </div>
          <div class="deployment-info-item">
            <span class="deployment-info-label">Cloudflare:</span>
            <span>${deployment.cloudflare?.email || 'N/A'}</span>
          </div>
        </div>
        <div class="deployment-card-footer">
          <button class="btn btn-primary btn-deploy" data-id="${deployment.id}" ${window.dashboard?.isDeploying() ? 'disabled' : ''}>
            Deploy
          </button>
          <button class="btn btn-secondary btn-view-history" data-id="${deployment.id}">
            Lịch sử triển khai
          </button>
        </div>
      </div>
    `;
  },

  attachDeploymentListeners(deploymentId) {
    // History button
    const btnHistory = document.querySelector(`.btn-history[data-id="${deploymentId}"]`);
    if (btnHistory) {
      btnHistory.addEventListener('click', () => {
        window.deploymentStatus.showHistory(deploymentId);
      });
    }

    // Duplicate button
    const btnDuplicate = document.querySelector(`.btn-duplicate[data-id="${deploymentId}"]`);
    if (btnDuplicate) {
      btnDuplicate.addEventListener('click', async () => {
        await this.duplicateDeployment(deploymentId);
      });
    }

    // Export button
    const btnExport = document.querySelector(`.btn-export[data-id="${deploymentId}"]`);
    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        await this.exportDeployment(deploymentId);
      });
    }

    // Edit button
    const btnEdit = document.querySelector(`.btn-edit[data-id="${deploymentId}"]`);
    if (btnEdit) {
      btnEdit.addEventListener('click', () => {
        try {
          const config = window.dashboard?.getCurrentConfig();
          if (!config) {
            window.toast?.error('Không thể tải cấu hình');
            console.error('[Edit] Config not available');
            return;
          }
          
          const deployment = config?.deployments?.find(d => d.id === deploymentId);
          if (!deployment) {
            window.toast?.error('Không tìm thấy deployment');
            console.error('[Edit] Deployment not found:', deploymentId);
            return;
          }
          
          if (!window.deploymentForm) {
            window.toast?.error('Deployment form chưa được tải. Vui lòng refresh trang.');
            console.error('[Edit] deploymentForm not available');
            return;
          }
          
          if (typeof window.deploymentForm.show !== 'function') {
            window.toast?.error('Deployment form không khả dụng');
            console.error('[Edit] deploymentForm.show is not a function');
            return;
          }
          
          console.log('[Edit] Showing deployment:', deployment.id, deployment.name);
          window.deploymentForm.show(deployment);
        } catch (error) {
          console.error('[Edit] Error:', error);
          window.toast?.error(`Lỗi mở form chỉnh sửa: ${error.message}`);
        }
      });
    }

    // Delete button
    const btnDelete = document.querySelector(`.btn-delete[data-id="${deploymentId}"]`);
    if (btnDelete) {
      btnDelete.addEventListener('click', async () => {
        // No confirmation dialog - proceed with deletion and show toast
        window.toast?.info('🗑️ Đang xóa triển khai...');
          await this.deleteDeployment(deploymentId);
      });
    }

    // Deploy button
    const btnDeploy = document.querySelector(`.btn-deploy[data-id="${deploymentId}"]`);
    if (btnDeploy) {
      btnDeploy.addEventListener('click', async () => {
        await this.startDeployment(deploymentId);
      });
    }

    const btnViewHistory = document.querySelector(`.btn-view-history[data-id="${deploymentId}"]`);
    if (btnViewHistory) {
      btnViewHistory.addEventListener('click', () => {
        window.deploymentStatus.showHistory(deploymentId);
      });
    }


  },

  async duplicateDeployment(deploymentId) {
    try {
      const config = window.dashboard?.getCurrentConfig();
      const originalDeployment = config?.deployments?.find(d => d.id === deploymentId);
      
      if (!originalDeployment) {
        window.toast?.error('Không tìm thấy deployment');
        return;
      }

      const duplicatedDeployment = {
        ...originalDeployment,
        id: `${originalDeployment.id}-copy-${Date.now()}`,
        name: `${originalDeployment.name} (Copy)`,
        status: 'idle',
        history: []
      };

      if (!window.deploymentForm) {
        window.toast?.error('Deployment form chưa được tải. Vui lòng refresh trang.');
        return;
      }

      if (typeof window.deploymentForm.show !== 'function') {
        window.toast?.error('Deployment form không khả dụng');
        return;
      }

      await window.deploymentForm.show(duplicatedDeployment);
      
      setTimeout(() => {
        const idField = document.getElementById('form-id');
        if (idField) {
          idField.removeAttribute('readonly');
        }
      }, 100);

      window.toast?.success(`Đã tạo bản sao của "${originalDeployment.name}"`);
    } catch (error) {
      window.toast?.error(`Lỗi nhân đôi deployment: ${error.message}`);
    }
  },

  async exportDeployment(deploymentId) {
    try {
      const config = window.dashboard?.getCurrentConfig();
      const deployment = config?.deployments?.find(d => d.id === deploymentId);
      
      if (!deployment) {
        window.toast?.error('Không tìm thấy deployment');
        return;
      }

      const deploymentJson = JSON.stringify(deployment, null, 2);
      const fileName = `${deployment.name || deployment.id}-backup.json`;
      
      const result = await window.electronAPI.dialogSaveConfig(deploymentJson);
      if (result.success) {
        window.toast?.success(`Đã xuất "${deployment.name}" thành công!`);
      }
    } catch (error) {
      window.toast?.error(`Lỗi xuất deployment: ${error.message}`);
    }
  },

  async deleteDeployment(deploymentId) {
    const deleteFn = async () => {
      try {
        const config = window.dashboard?.getCurrentConfig();
        if (!config) {
          window.toast?.error('Không thể tải cấu hình');
          return;
        }

        // Ensure deployments is an array
        if (!Array.isArray(config.deployments)) {
          config.deployments = [];
        }

        // Remove from config
        const beforeCount = config.deployments.length;
        config.deployments = config.deployments.filter(d => d && d.id && d.id !== deploymentId);
        
        // Filter out invalid deployments (those without id or name) before saving
        // This prevents validation errors when saving after deletion
        config.deployments = config.deployments.filter(d => {
          if (!d || typeof d !== 'object') return false;
          if (!d.id || typeof d.id !== 'string' || d.id.trim() === '') return false;
          if (!d.name || typeof d.name !== 'string' || d.name.trim() === '') return false;
          return true;
        });
        
        const afterCount = config.deployments.length;
        
        if (beforeCount === afterCount) {
          window.toast?.warning('Không tìm thấy deployment để xóa');
          return;
        }

        console.log(`[deleteDeployment] Removing deployment ${deploymentId}, ${beforeCount} -> ${afterCount} deployments`);

        const saveResult = await window.dashboard.saveConfig();
        if (!saveResult || (saveResult.success === false)) {
          const errorMsg = saveResult?.error || 'Failed to save config';
          console.error('[deleteDeployment] Save failed:', errorMsg);
          throw new Error(errorMsg);
        }

        // Reload to refresh the list
        await window.dashboard.loadConfig();
        
        window.toast?.success('Đã xóa deployment thành công');
      } catch (error) {
        console.error('[deleteDeployment] Error:', error);
        window.toast?.error(`Lỗi xóa triển khai: ${error.message}`);
      }
    };
    
    if (window.loading && window.loading.withLoading) {
      await window.loading.withLoading(deleteFn, 'Đang xóa deployment...');
    } else {
      await deleteFn();
    }
  },

  async startDeployment(deploymentId) {
    if (window.dashboard?.isDeploying()) {
      window.toast?.warning('Đang có một triển khai đang chạy. Vui lòng đợi.');
      return;
    }

    // Check if codebase path is set
    const config = window.dashboard?.getCurrentConfig();
    if (!config?.codebasePath) {
      window.toast?.error('Vui lòng chọn thư mục Codebase trước!\n\n📁 Click "Chọn..." ở sidebar để chọn thư mục chứa code của bạn.');
      return;
    }

    const deployment = config.deployments?.find(d => d.id === deploymentId);
    const deploymentName = deployment?.name || 'deployment này';
    
    // No confirmation dialog - start deployment directly

    try {
      window.dashboard.setIsDeploying(true);
      window.deploymentStatus.show(deploymentId);
      
      const result = await window.electronAPI.deploymentStart(deploymentId);
      
      if (result.success) {
        window.deploymentStatus.updateResult(result);
      } else {
        window.errorDisplay.show(result);
      }
    } catch (error) {
      window.errorDisplay.show({
        success: false,
        error: error.message,
        stack: error.stack
      });
    } finally {
      window.dashboard.setIsDeploying(false);
      await window.dashboard.loadConfig();
    }
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

