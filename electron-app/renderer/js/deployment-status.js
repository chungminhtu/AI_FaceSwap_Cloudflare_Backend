// Deployment status management
window.deploymentStatus = {
  currentDeploymentId: null,
  currentDeploymentName: null,
  steps: [],
  combinedLogLines: [],
  viewingHistory: false,
  currentHistoryIndex: null,
  historyList: [],

  show(deploymentId) {
    this.currentDeploymentId = deploymentId;
    this.currentDeploymentName = this.lookupDeploymentName(deploymentId);
    this.viewingHistory = false;
    this.currentHistoryIndex = null;
    this.historyList = [];
    this.combinedLogLines = [];
    this.steps = [];
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
    this.viewingHistory = false;
    this.currentHistoryIndex = null;
    this.historyList = [];
    this.combinedLogLines = [];
  },

  showHistory(deploymentId) {
    this.currentDeploymentId = deploymentId;
    this.currentDeploymentName = this.lookupDeploymentName(deploymentId);
    this.viewingHistory = true;
    this.currentHistoryIndex = null;
    this.steps = [];
    this.combinedLogLines = [];
    this.historyList = this.loadHistoryList();
    if (this.historyList.length > 0) {
      this.currentHistoryIndex = 0;
    }
    const statusSection = document.getElementById('deployment-status-section');
    const listSection = document.getElementById('deployment-list-section');
    
    if (statusSection) statusSection.classList.remove('hidden');
    if (listSection) listSection.classList.add('hidden');

    this.renderHistory();
    this.setupListeners();
  },

  renderHistory() {
    const container = document.getElementById('deployment-status');
    if (!container) return;

    if (!this.historyList || this.historyList.length === 0) {
      container.innerHTML = `
      <div class="text-center" style="padding: 2rem;">
        <p>Chưa có lịch sử triển khai nào.</p>
          <p style="margin-top: 0.5rem; color: var(--text-secondary); font-size: 14px;">Các log và kết quả sẽ được lưu lại sau khi triển khai hoàn tất.</p>
        </div>
      `;
      return;
    }

    const selectedIndex = this.currentHistoryIndex ?? 0;
    const selectedEntry = this.historyList[selectedIndex] || this.historyList[0];
    container.innerHTML = `
      <div class="history-grid">
        <div class="history-column history-list-column">
          <h3>Lịch sử Deploy</h3>
          <div class="history-list">
            ${this.historyList.map((entry, index) => this.renderHistoryEntry(entry, index, index === selectedIndex)).join('')}
          </div>
        </div>
        <div class="history-column history-detail-column">
          ${selectedEntry ? this.renderHistoryDetailContent(selectedEntry) : '<p class="text-center">Chọn một entry để xem log.</p>'}
        </div>
      </div>
    `;

    this.setupHistoryListListeners();
    this.updateStatusSubtitle();
  },

  renderHistoryEntry(entry, index, isActive) {
    const date = new Date(entry.timestamp);
    const formattedDate = date.toLocaleString('vi-VN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    const duration = entry.endTime ? 
      Math.round((new Date(entry.endTime) - new Date(entry.timestamp)) / 1000) : null;
    
    const statusIcon = entry.status === 'success' ? '✅' : '❌';
    const statusClass = entry.status === 'success' ? 'success' : 'failed';
    const statusText = entry.status === 'success' ? 'Thành công' : 'Thất bại';
    const relativeTime = this.formatRelativeTime(entry.timestamp);

    const activeClass = isActive ? 'active' : '';

    return `
      <div class="history-entry-card ${statusClass} ${activeClass}" data-index="${index}">
        <button class="btn-delete-history" data-index="${index}" data-timestamp="${entry.timestamp}" title="Xóa dòng này">🗑️</button>
        <div class="history-entry-header compact-header">
          <div class="history-entry-status">${statusIcon} ${statusText}</div>
          <div class="history-entry-relative">${relativeTime}</div>
        </div>
        <div class="history-entry-date-line">${formattedDate}</div>
        <div class="history-entry-info compact-info">
          ${duration ? `<span>⏱️ ${duration}s</span>` : ''}
          ${entry.steps ? `<span>📋 ${entry.steps.length} bước</span>` : ''}
          ${entry.results?.workerUrl ? `<span>Worker</span>` : ''}
          ${entry.results?.pagesUrl ? `<span>Pages</span>` : ''}
        </div>
      </div>
    `;
  },

  renderHistoryDetailContent(entry) {
    const date = new Date(entry.timestamp);
    const formattedDate = date.toLocaleString('vi-VN');
    const duration = entry.endTime ? 
      Math.round((new Date(entry.endTime) - new Date(entry.timestamp)) / 1000) : null;

    const statusIcon = entry.status === 'success' ? '✅' : '❌';
    const statusText = entry.status === 'success' ? 'Thành công' : 'Thất bại';
    const relativeTime = this.formatRelativeTime(entry.timestamp);

    return `
      <div class="history-detail-card">
        <div class="history-detail-header">
          <div>
            <h3>${statusIcon} Deploy ${statusText}</h3>
            <p class="history-detail-meta">
              📅 ${formattedDate} (${relativeTime})
            </p>
          </div>
        </div>
        <div class="deployment-status">
          ${entry.steps ? entry.steps.map(step => this.renderStep(step)).join('') : ''}
        </div>
        ${this.renderHistoryLogs(entry)}
        ${entry.results ? `
          <div class="deployment-results">
            <h4>📊 Kết quả</h4>
            ${entry.results.workerUrl ? `<p>🔗 Worker: <a href="${entry.results.workerUrl}" target="_blank">${entry.results.workerUrl}</a></p>` : ''}
            ${entry.results.pagesUrl ? `<p>📄 Pages: <a href="${entry.results.pagesUrl}" target="_blank">${entry.results.pagesUrl}</a></p>` : ''}
          </div>
        ` : ''}
        ${entry.error ? `
          <div class="deployment-error">
            <h4>❌ Lỗi</h4>
            <pre>${this.escapeHtml(entry.error)}</pre>
          </div>
        ` : ''}
      </div>
    `;
  },

  renderHistoryLogs(entry) {
    const logs = entry.fullLogs?.length ? entry.fullLogs : this.flattenStepLogs(entry.steps);
    if (!logs || logs.length === 0) {
      return `<p class="history-detail-empty">Không có log CLI để hiển thị.</p>`;
    }

    const logsText = logs.map(log => `[${log.step || 'step'}] ${log.log}`).join('\n');

    return `
      <div class="status-step completed">
        <div class="step-content">
          <div class="step-title">🔧 Toàn bộ log CLI</div>
          <div class="step-logs">
            <pre class="logs-output">${this.escapeHtml(logsText)}</pre>
          </div>
        </div>
      </div>
    `;
  },

  flattenStepLogs(steps = []) {
    const result = [];
    steps.forEach(step => {
      if (Array.isArray(step.logs)) {
        step.logs.forEach(log => {
          result.push({ step: step.step, log });
        });
      }
    });
    return result;
  },

  deleteHistoryEntry(index) {
    if (!this.historyList || index === undefined || index < 0 || index >= this.historyList.length) return;
    const entry = this.historyList[index];
    if (!entry || !entry.timestamp) return;

    this.markHistoryDeleted(this.currentDeploymentId, entry.timestamp);
    this.removeHistoryEntryFromCache(this.currentDeploymentId, entry.timestamp);
    this.historyList = this.loadHistoryList();
    if (this.historyList.length > 0) {
      this.currentHistoryIndex = Math.min(index, this.historyList.length - 1);
    } else {
      this.currentHistoryIndex = null;
    }
    this.renderHistory();
  },

  formatRelativeTime(timestamp) {
    if (!timestamp) return 'vừa xong';
    const now = Date.now();
    const target = new Date(timestamp).getTime();
    if (Number.isNaN(target)) return 'vừa xong';
    const diff = now - target;
    if (diff < 60000) return 'vài giây trước';
    if (diff < 3600000) {
      const mins = Math.max(1, Math.floor(diff / 60000));
      return `${mins} phút trước`;
    }
    if (diff < 86400000) {
      const hours = Math.max(1, Math.floor(diff / 3600000));
      return `${hours} giờ trước`;
    }
    const days = Math.max(1, Math.floor(diff / 86400000));
    return `${days} ngày trước`;
  },

  setupHistoryListListeners() {
    const entries = document.querySelectorAll('.history-entry-card');
    entries.forEach(entry => {
      entry.addEventListener('click', (event) => {
        const index = parseInt(entry.dataset.index, 10);
        if (!isNaN(index)) {
          this.currentHistoryIndex = index;
          this.renderHistory();
        }
      });
    });
    const deleteButtons = document.querySelectorAll('.btn-delete-history');
    deleteButtons.forEach(button => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const index = parseInt(button.dataset.index, 10);
        this.deleteHistoryEntry(index);
      });
    });
  },

  renderCombinedLogSection() {
    if (!this.combinedLogLines.length) return '';
    return `
      <div class="combined-log-panel">
        <div class="combined-log-header">
          <span>🔧 Toàn bộ log CLI (${this.combinedLogLines.length} dòng)</span>
        </div>
        <div class="combined-log-list">
          ${this.combinedLogLines.map(line => `
            <div class="combined-log-line">
              <span class="combined-log-step">[${this.escapeHtml(line.step || 'step')}]</span>
              <span class="combined-log-text">${this.escapeHtml(line.log)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  },

  autoScrollLogs() {
    setTimeout(() => {
      const logsElements = document.querySelectorAll('.logs-output, .combined-log-list');
      logsElements.forEach(el => {
        el.scrollTop = el.scrollHeight;
      });
    }, 60);
  },

  updateStatusSubtitle() {
    const statusTitle = document.getElementById('status-header-title');
    if (!statusTitle) return;
    const parts = ['Trạng thái Deploy'];
    if (this.currentDeploymentName) {
      parts.push(this.currentDeploymentName);
    }
    const lastLog = this.combinedLogLines[this.combinedLogLines.length - 1];
    if (lastLog) {
      const relativeTime = this.formatRelativeTime(lastLog.timestamp);
      if (relativeTime) {
        parts.push(relativeTime);
      }
    }
    statusTitle.textContent = parts.join(' · ');
  },

  saveHistoryEntry(result) {
    if (!this.currentDeploymentId || !result.history) return;
    const historyEntry = {
      ...result.history,
      timestamp: result.history.timestamp || new Date().toISOString(),
      status: result.history.status || (result.success ? 'success' : 'failed'),
      fullLogs: this.combinedLogLines.map(log => ({ ...log }))
    };

    try {
      this.historyList = this.appendHistoryEntryToCache(this.currentDeploymentId, historyEntry);
    } catch (error) {
      console.error('Failed to cache deployment history locally:', error);
    }
  },

  getHistoryCacheKey(deploymentId) {
    return `deploymentHistory_${deploymentId}`;
  },

  loadHistoryEntries(deploymentId) {
    if (!deploymentId || typeof window.localStorage === 'undefined') return [];
    try {
      const cached = localStorage.getItem(this.getHistoryCacheKey(deploymentId));
      return cached ? JSON.parse(cached) : [];
    } catch (error) {
      console.warn('Failed to read deployment history cache', error);
      return [];
    }
  },

  appendHistoryEntryToCache(deploymentId, entry) {
    if (!deploymentId || typeof window.localStorage === 'undefined') return [];
    const key = this.getHistoryCacheKey(deploymentId);
    const entries = this.loadHistoryEntries(deploymentId).filter(e => e.timestamp !== entry.timestamp);
    const next = [entry, ...entries].slice(0, 50);
    localStorage.setItem(key, JSON.stringify(next));
    return next;
  },

  getHistoryDeletedKey(deploymentId) {
    return `deploymentHistoryDeleted_${deploymentId}`;
  },

  loadDeletedTimestamps(deploymentId) {
    if (!deploymentId || typeof window.localStorage === 'undefined') return [];
    try {
      const value = localStorage.getItem(this.getHistoryDeletedKey(deploymentId));
      return value ? JSON.parse(value) : [];
    } catch (error) {
      console.warn('Failed to read deleted history cache', error);
      return [];
    }
  },

  markHistoryDeleted(deploymentId, timestamp) {
    if (!deploymentId || typeof window.localStorage === 'undefined' || !timestamp) return;
    const key = this.getHistoryDeletedKey(deploymentId);
    const existing = new Set(this.loadDeletedTimestamps(deploymentId));
    existing.add(timestamp);
    localStorage.setItem(key, JSON.stringify([...existing]));
  },

  removeHistoryEntryFromCache(deploymentId, timestamp) {
    if (!deploymentId || !timestamp || typeof window.localStorage === 'undefined') return [];
    const key = this.getHistoryCacheKey(deploymentId);
    const entries = this.loadHistoryEntries(deploymentId).filter(e => e.timestamp !== timestamp);
    localStorage.setItem(key, JSON.stringify(entries));
    return entries;
  },

  loadHistoryList() {
    const cacheEntries = this.loadHistoryEntries(this.currentDeploymentId);
    const config = window.dashboard?.getCurrentConfig();
    const deployment = config?.deployments?.find(d => d.id === this.currentDeploymentId);
    const configEntries = deployment?.history || [];

    const deletedSet = new Set(this.loadDeletedTimestamps(this.currentDeploymentId));

    const merged = cacheEntries
      .filter(entry => entry.timestamp && !deletedSet.has(entry.timestamp));

    configEntries.forEach(entry => {
      if (entry.timestamp && !deletedSet.has(entry.timestamp) && !merged.some(item => item.timestamp === entry.timestamp)) {
        merged.push(entry);
      }
    });

    return merged
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  },

  render() {
    if (this.viewingHistory) {
      this.renderHistory();
      return;
    }

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
    const combinedLogsHtml = this.renderCombinedLogSection();

    container.innerHTML = `
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${progress}%"></div>
      </div>
      <div class="deployment-status">
        ${this.steps.map(step => this.renderStep(step)).join('')}
      </div>
      ${combinedLogsHtml}
    `;

    this.autoScrollLogs();
    this.updateStatusSubtitle();
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

    const title = step.details || step.step;
    const subtitle = step.details ? step.step : '';

    return `
      <div class="status-step ${step.status}">
        <div class="step-content">
          <div class="step-title">${this.escapeHtml(title)}</div>
          ${subtitle ? `<div class="step-details">${this.escapeHtml(subtitle)}</div>` : ''}
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
      this.combinedLogLines.push({
        step: data.step,
        log: data.log,
        timestamp: Date.now()
      });
      if (this.combinedLogLines.length > 500) {
        this.combinedLogLines.shift();
      }
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
        details: 'Deploy thành công!'
      });
    } else {
      this.steps.push({
        step: 'Lỗi',
        status: 'error',
        details: result.error || 'Deploy thất bại'
      });
    }

    this.saveHistoryEntry(result);
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

  lookupDeploymentName(deploymentId) {
    const config = window.dashboard?.getCurrentConfig();
    return config?.deployments?.find(d => d.id === deploymentId)?.name || null;
  },

  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

