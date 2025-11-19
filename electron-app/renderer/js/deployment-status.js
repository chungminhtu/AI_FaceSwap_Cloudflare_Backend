// Deployment status management
window.deploymentStatus = {
  currentDeploymentId: null,
  steps: [],

  show(deploymentId) {
    this.currentDeploymentId = deploymentId;
    const statusSection = document.getElementById('deployment-status-section');
    const listSection = document.getElementById('deployment-list-section');
    
    if (statusSection) statusSection.classList.remove('hidden');
    if (listSection) listSection.classList.add('hidden');

    this.render();
    this.setupListeners();
  },

  hide() {
    const statusSection = document.getElementById('deployment-status-section');
    const listSection = document.getElementById('deployment-list-section');
    
    if (statusSection) statusSection.classList.add('hidden');
    if (listSection) listSection.classList.remove('hidden');
    
    this.currentDeploymentId = null;
    this.steps = [];
  },

  render() {
    const container = document.getElementById('deployment-status');
    if (!container) return;

    if (this.steps.length === 0) {
      container.innerHTML = `
        <div class="text-center" style="padding: 2rem;">
          <p>Chưa có thông tin triển khai. Bắt đầu triển khai để xem tiến trình.</p>
        </div>
      `;
      return;
    }

    const completedSteps = this.steps.filter(s => s.status === 'completed').length;
    const totalSteps = this.steps.length;
    const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

    container.innerHTML = `
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${progress}%"></div>
      </div>
      <div class="deployment-status">
        ${this.steps.map(step => this.renderStep(step)).join('')}
      </div>
    `;
  },

  renderStep(step) {
    const icons = {
      running: '⏳',
      completed: '✅',
      error: '❌',
      warning: '⚠️'
    };

    const logsHtml = step.logs && step.logs.length > 0 ? `
      <div class="step-logs">
        <pre class="logs-output">${this.escapeHtml(step.logs.join('\n'))}</pre>
      </div>
    ` : '';

    return `
      <div class="status-step ${step.status}">
        <div class="step-icon">${icons[step.status] || '○'}</div>
        <div class="step-content">
          <div class="step-title">${this.escapeHtml(step.step)}</div>
          <div class="step-details">${this.escapeHtml(step.details || '')}</div>
          ${logsHtml}
        </div>
      </div>
    `;
  },

  updateProgress(data) {
    if (data.deploymentId !== this.currentDeploymentId) {
      return; // Not for current deployment
    }

    // Find or create step
    let step = this.steps.find(s => s.step === data.step);
    if (!step) {
      step = {
        step: data.step,
        status: data.status,
        details: data.details,
        logs: []
      };
      this.steps.push(step);
    } else {
      step.status = data.status;
      step.details = data.details;
    }

    // Append logs if provided
    if (data.log) {
      if (!step.logs) step.logs = [];
      step.logs.push(data.log);
    }

    this.render();
    
    // Auto-scroll to bottom of logs
    setTimeout(() => {
      const logsElements = document.querySelectorAll('.logs-output');
      logsElements.forEach(el => {
        el.scrollTop = el.scrollHeight;
      });
    }, 50);
  },

  updateResult(result) {
    if (result.success) {
      this.steps.push({
        step: 'Hoàn tất',
        status: 'completed',
        details: 'Triển khai thành công!'
      });
    } else {
      this.steps.push({
        step: 'Lỗi',
        status: 'error',
        details: result.error || 'Triển khai thất bại'
      });
    }

    this.render();
  },

  setupListeners() {
    const btnClose = document.getElementById('btn-close-status');
    if (btnClose) {
      btnClose.replaceWith(btnClose.cloneNode(true)); // Remove old listeners
      document.getElementById('btn-close-status').addEventListener('click', () => {
        this.hide();
      });
    }
  },

  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

