// Deployment list management
window.deploymentList = {
  render(deployments) {
    const container = document.getElementById('deployment-list');
    if (!container) return;

    if (deployments.length === 0) {
      container.innerHTML = `
        <div class="text-center" style="padding: 3rem; color: #999;">
          <p>Chưa có triển khai nào. Nhấn "Thêm Triển khai" để bắt đầu.</p>
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
    const status = deployment.status || 'idle';
    const statusText = {
      idle: 'Sẵn sàng',
      deploying: 'Đang triển khai...',
      success: 'Thành công',
      error: 'Lỗi'
    };

    return `
      <div class="deployment-card" data-deployment-id="${deployment.id}">
        <div class="deployment-card-header">
          <div class="deployment-name">${this.escapeHtml(deployment.name)}</div>
          <div class="deployment-actions">
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
        <div class="deployment-status-badge ${status}">${statusText[status] || status}</div>
        <div class="deployment-card-footer">
          <button class="btn btn-primary btn-deploy" data-id="${deployment.id}" ${window.dashboard?.isDeploying() ? 'disabled' : ''}>
            Triển khai
          </button>
          <button class="btn btn-secondary btn-view-status" data-id="${deployment.id}">
            Xem Trạng thái
          </button>
        </div>
      </div>
    `;
  },

  attachDeploymentListeners(deploymentId) {
    // Edit button
    const btnEdit = document.querySelector(`.btn-edit[data-id="${deploymentId}"]`);
    if (btnEdit) {
      btnEdit.addEventListener('click', () => {
        const config = window.dashboard?.getCurrentConfig();
        const deployment = config?.deployments?.find(d => d.id === deploymentId);
        if (deployment) {
          window.deploymentForm.show(deployment);
        }
      });
    }

    // Delete button
    const btnDelete = document.querySelector(`.btn-delete[data-id="${deploymentId}"]`);
    if (btnDelete) {
      btnDelete.addEventListener('click', async () => {
        if (confirm('Bạn có chắc muốn xóa triển khai này?')) {
          await this.deleteDeployment(deploymentId);
        }
      });
    }

    // Deploy button
    const btnDeploy = document.querySelector(`.btn-deploy[data-id="${deploymentId}"]`);
    if (btnDeploy) {
      btnDeploy.addEventListener('click', async () => {
        await this.startDeployment(deploymentId);
      });
    }

    // View status button
    const btnViewStatus = document.querySelector(`.btn-view-status[data-id="${deploymentId}"]`);
    if (btnViewStatus) {
      btnViewStatus.addEventListener('click', () => {
        window.deploymentStatus.show(deploymentId);
      });
    }
  },

  async deleteDeployment(deploymentId) {
    try {
      const config = window.dashboard?.getCurrentConfig();
      if (!config) return;

      config.deployments = config.deployments.filter(d => d.id !== deploymentId);
      await window.dashboard.saveConfig();
      await window.dashboard.loadConfig();
    } catch (error) {
      alert(`Lỗi xóa triển khai: ${error.message}`);
    }
  },

  async startDeployment(deploymentId) {
    if (window.dashboard?.isDeploying()) {
      alert('Đang có một triển khai đang chạy. Vui lòng đợi.');
      return;
    }

    if (!confirm('Bắt đầu triển khai?')) {
      return;
    }

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

