// Deployment status management
window.deploymentStatus = {
  currentDeploymentId: null,
  currentDeploymentName: null,
  steps: [],
  combinedLogLines: [],
  viewingHistory: false,
  currentHistoryIndex: null,
  historyList: [],
  liveEntry: null, // Current live deployment entry

  show(deploymentId) {
    this.currentDeploymentId = deploymentId;
    this.currentDeploymentName = this.lookupDeploymentName(deploymentId);
    this.steps = [];
    this.combinedLogLines = [];
    
    // Create a live entry for real-time deployment
    this.liveEntry = {
      timestamp: new Date().toISOString(),
      status: 'running',
      steps: [],
      fullLogs: [],
      isLive: true // Mark as live deployment
    };
    
    // Load history and show in history view
    this.historyList = this.loadHistoryList();
    // Live entry will be shown first (index -1 or special handling)
    this.currentHistoryIndex = null; // null means show live entry
    
    const statusSection = document.getElementById('deployment-status-section');
    const listSection = document.getElementById('deployment-list-section');
    
    if (statusSection) statusSection.classList.remove('hidden');
    if (listSection) listSection.classList.add('hidden');

    this.renderHistory();
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
    this.liveEntry = null;
  },

  showHistory(deploymentId) {
    this.currentDeploymentId = deploymentId;
    this.currentDeploymentName = this.lookupDeploymentName(deploymentId);
    this.viewingHistory = true;
    this.currentHistoryIndex = null;
    this.liveEntry = null; // Clear any live entry when viewing history
    this.historyList = this.loadHistoryList();
    if (this.historyList.length > 0) {
      // Show newest entry (last in array)
      this.currentHistoryIndex = this.historyList.length - 1;
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

    // Determine which entry to show
    let selectedEntry = null;
    let selectedIndex = null;
    
    // If there's a live deployment, show it
    if (this.liveEntry) {
      selectedEntry = this.liveEntry;
      selectedIndex = -1; // Special index for live entry
    } else if (this.historyList && this.historyList.length > 0) {
      // Otherwise show selected history entry or newest one (last in array)
      selectedIndex = this.currentHistoryIndex ?? (this.historyList.length - 1);
      selectedEntry = this.historyList[selectedIndex] || this.historyList[this.historyList.length - 1];
    }

    // Build display list with live entry first if it exists
    const displayList = [];
    if (this.liveEntry) {
      displayList.push({ entry: this.liveEntry, index: -1, isLive: true });
    }
    // Add history list in reverse order (newest first)
    if (this.historyList && this.historyList.length > 0) {
      for (let i = this.historyList.length - 1; i >= 0; i--) {
        displayList.push({ entry: this.historyList[i], index: i, isLive: false });
      }
    }

    if (displayList.length === 0) {
      container.innerHTML = `
      <div class="text-center" style="padding: 2rem;">
        <p>Chưa có lịch sử triển khai nào.</p>
          <p style="margin-top: 0.5rem; color: var(--text-secondary); font-size: 14px;">Các log và kết quả sẽ được lưu lại sau khi triển khai hoàn tất.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="history-grid">
        <div class="history-column history-list-column">
          <h3>Lịch sử Deploy</h3>
          <div class="history-list">
            ${displayList.map(({ entry, index, isLive }) => {
              const isActive = (isLive && selectedIndex === -1) || (!isLive && index === selectedIndex);
              return this.renderHistoryEntry(entry, index, isActive, isLive);
            }).join('')}
          </div>
        </div>
        <div class="history-column history-detail-column">
          ${selectedEntry ? this.renderHistoryDetailContent(selectedEntry) : '<p class="text-center">Chọn một entry để xem log.</p>'}
        </div>
      </div>
    `;

    this.setupHistoryListListeners();
    this.updateStatusSubtitle();
    this.autoScrollLogs();
  },

  renderHistoryEntry(entry, index, isActive, isLive = false) {
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
    
    let statusIcon, statusClass, statusText;
    if (isLive && entry.status === 'running') {
      statusIcon = '⏳';
      statusClass = 'running';
      statusText = 'Đang chạy...';
    } else {
      statusIcon = entry.status === 'success' ? '✅' : '❌';
      statusClass = entry.status === 'success' ? 'success' : 'failed';
      statusText = entry.status === 'success' ? 'Thành công' : 'Thất bại';
    }
    
    const relativeTime = isLive ? 'Đang chạy...' : this.formatRelativeTime(entry.timestamp);
    const activeClass = isActive ? 'active' : '';
    const liveClass = isLive ? 'live-entry' : '';

    return `
      <div class="history-entry-card ${statusClass} ${activeClass} ${liveClass}" data-index="${index}" data-live="${isLive}">
        ${!isLive ? `<button class="btn-delete-history" data-index="${index}" data-timestamp="${entry.timestamp}" title="Xóa dòng này">🗑️</button>` : ''}
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
    // Display steps exactly as stored - no sorting, no filtering
    const steps = entry.steps || [];
    const completedSteps = steps.filter(s => s.status === 'completed').length;
    const totalSteps = steps.length;
    const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;
    
    // Render combined logs section from entry's fullLogs
    const combinedLogsHtml = this.renderHistoryCombinedLogs(entry);
    
    // Render results section
    const resultsHtml = entry.results ? `
      <div class="deployment-results">
        <h4>📊 Kết quả</h4>
        ${entry.results.workerUrl ? `<p>🔗 Worker: <a href="${entry.results.workerUrl}" target="_blank">${entry.results.workerUrl}</a></p>` : ''}
        ${entry.results.pagesUrl ? `<p>📄 Pages: <a href="${entry.results.pagesUrl}" target="_blank">${entry.results.pagesUrl}</a></p>` : ''}
      </div>
    ` : '';
    
    // Render errors section
    const errorHtml = entry.error ? `
      <div class="deployment-error">
        <h4>❌ Lỗi</h4>
        <pre>${this.escapeHtml(entry.error)}</pre>
      </div>
    ` : '';

    return `
      <div class="history-detail-card">
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${progress}%"></div>
        </div>
        <div class="deployment-status">
          ${steps.map(step => this.renderStep(step)).join('')}
        </div>
        ${combinedLogsHtml}
        ${resultsHtml}
        ${errorHtml}
      </div>
    `;
  },

  renderHistoryCombinedLogs(entry) {
    const logs = entry.fullLogs?.length ? entry.fullLogs : this.flattenStepLogs(entry.steps);
    if (!logs || logs.length === 0) {
      return '';
    }

    // Display logs exactly as stored - no sorting
    return `
      <div class="combined-log-panel">
        <div class="combined-log-header">
          <span>🔧 Toàn bộ log CLI (${logs.length} dòng)</span>
        </div>
        <div class="combined-log-list">
          ${logs.map(line => `
            <div class="combined-log-line">
              <span class="combined-log-step">[${this.escapeHtml(line.step || 'step')}]</span>
              <span class="combined-log-text">${this.escapeHtml(line.log)}</span>
            </div>
          `).join('')}
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
        // Don't switch if clicking delete button
        if (event.target.classList.contains('btn-delete-history')) {
          return;
        }
        const index = parseInt(entry.dataset.index, 10);
        const isLive = entry.dataset.live === 'true';
        if (!isNaN(index)) {
          if (isLive) {
            this.currentHistoryIndex = null; // Show live entry
          } else {
            this.currentHistoryIndex = index;
          }
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
    if (!this.currentDeploymentId) return;
    
    // Merge backend steps with frontend steps (preserve all data)
    const backendSteps = result.history?.steps || [];
    const frontendSteps = this.steps || [];
    
    // Create map of backend steps
    const backendMap = new Map();
    backendSteps.forEach(step => {
      backendMap.set(step.step, step);
    });
    
    // Merge frontend data into backend steps (frontend may have more updated info)
    const mergedSteps = backendSteps.map(backendStep => {
      const frontendStep = frontendSteps.find(fs => fs.step === backendStep.step);
      if (frontendStep) {
        // Merge both - prefer backend for logs, frontend for status/details
        return {
          step: backendStep.step,
          status: frontendStep.status || backendStep.status,
          details: frontendStep.details || backendStep.details,
          logs: [...(backendStep.logs || []), ...(frontendStep.logs || [])]
        };
      }
      return backendStep;
    });
    
    // Add any frontend-only steps
    frontendSteps.forEach(frontendStep => {
      if (!backendMap.has(frontendStep.step)) {
        mergedSteps.push(frontendStep);
      }
    });
    
    // Simple: just use combinedLogLines as-is (already in chronological order)
    const allLogs = this.combinedLogLines.map(log => ({
      step: log.step || 'unknown',
      log: log.log,
      timestamp: log.timestamp || Date.now()
    }));
    
    // Save everything to localStorage
    // Create history entry even if result.history doesn't exist
    const historyEntry = {
      timestamp: result.history?.timestamp || this.liveEntry?.timestamp || new Date().toISOString(),
      endTime: result.history?.endTime || this.liveEntry?.endTime || new Date().toISOString(),
      status: result.history?.status || (result.success ? 'success' : 'failed'),
      steps: mergedSteps.length > 0 ? mergedSteps : frontendSteps, // Use merged steps or frontend steps
      fullLogs: allLogs, // All logs
      results: result.results || result.history?.results || this.liveEntry?.results || {},
      error: result.error || result.history?.error || null
    };

    try {
      this.historyList = this.appendHistoryEntryToCache(this.currentDeploymentId, historyEntry);
      console.log('[deploymentStatus] Saved history entry:', {
        deploymentId: this.currentDeploymentId,
        timestamp: historyEntry.timestamp,
        status: historyEntry.status,
        stepsCount: historyEntry.steps.length,
        logsCount: historyEntry.fullLogs.length
      });
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
      if (!cached) return [];
      
      // Return as-is - no sorting
      return JSON.parse(cached);
    } catch (error) {
      console.warn('Failed to read deployment history cache', error);
      return [];
    }
  },

  appendHistoryEntryToCache(deploymentId, entry) {
    if (!deploymentId || typeof window.localStorage === 'undefined') return [];
    const key = this.getHistoryCacheKey(deploymentId);
    
    // Ensure entry has timestamp
    if (!entry.timestamp) {
      entry.timestamp = new Date().toISOString();
    }
    
    // Load existing entries
    const entries = this.loadHistoryEntries(deploymentId);
    
    // Simply append to end of array (newest last)
    entries.push(entry);
    
    // Keep only last 50 entries
    const limited = entries.slice(-50);
    
    // Save back to localStorage
    localStorage.setItem(key, JSON.stringify(limited));
    
    // Return as-is
    return limited;
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
    const existing = this.loadDeletedTimestamps(deploymentId);
    
    // Simple array append if not already present
    if (!existing.includes(timestamp)) {
      existing.push(timestamp);
      localStorage.setItem(key, JSON.stringify(existing));
    }
  },

  removeHistoryEntryFromCache(deploymentId, timestamp) {
    if (!deploymentId || !timestamp || typeof window.localStorage === 'undefined') return [];
    const key = this.getHistoryCacheKey(deploymentId);
    const entries = this.loadHistoryEntries(deploymentId).filter(e => e.timestamp !== timestamp);
    localStorage.setItem(key, JSON.stringify(entries));
    return entries;
  },

  loadHistoryList() {
    // First, try to load from localStorage cache
    const cacheEntries = this.loadHistoryEntries(this.currentDeploymentId);
    const deletedTimestamps = this.loadDeletedTimestamps(this.currentDeploymentId);

    // Load from config
    let configEntries = [];
    try {
      const config = window.dashboard?.getCurrentConfig();
      if (config && config.deployments) {
        const deployment = config.deployments.find(d => d.id === this.currentDeploymentId);
        if (deployment && deployment.history && Array.isArray(deployment.history)) {
          // Convert config history format to cache format
          configEntries = deployment.history.map(h => {
            // Handle both database format (with history_data) and direct format
            const historyData = h.history_data ? (typeof h.history_data === 'string' ? JSON.parse(h.history_data) : h.history_data) : {};
            
            return {
              timestamp: h.timestamp || historyData.timestamp || h.id || new Date().toISOString(),
              endTime: h.endTime || historyData.endTime || h.end_time,
              status: h.status || historyData.status || 'unknown',
              steps: h.steps || historyData.steps || [],
              fullLogs: h.fullLogs || historyData.fullLogs || this.flattenStepLogs(h.steps || historyData.steps || []),
              results: h.results || historyData.results || {
                workerUrl: h.workerUrl || h.worker_url,
                pagesUrl: h.pagesUrl || h.pages_url
              },
              error: h.error || h.error_message || historyData.error || null
            };
          });
          console.log('[deploymentStatus] Loaded history from config:', configEntries.length, 'entries');
        }
      }
    } catch (error) {
      console.warn('[deploymentStatus] Failed to load history from config:', error);
    }

    // Merge cache and config entries, preferring cache (more recent)
    // Create a map of timestamps to avoid duplicates
    const entryMap = new Map();
    
    // Add config entries first (older)
    configEntries.forEach(entry => {
      if (entry.timestamp && !deletedTimestamps.includes(entry.timestamp)) {
        entryMap.set(entry.timestamp, entry);
      }
    });
    
    // Add cache entries (newer, will overwrite if same timestamp)
    cacheEntries.forEach(entry => {
      if (entry.timestamp && !deletedTimestamps.includes(entry.timestamp)) {
        entryMap.set(entry.timestamp, entry);
      }
    });

    // Convert map to array and return
    const allEntries = Array.from(entryMap.values());
    console.log('[deploymentStatus] Total history entries loaded:', allEntries.length);
    return allEntries;
  },

  // Removed separate render() - now using renderHistory() for everything

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

    // Update live entry if it exists
    if (this.liveEntry) {
      this.liveEntry.steps = [...this.steps];
      this.liveEntry.fullLogs = [...this.combinedLogLines];
      this.liveEntry.status = data.status === 'error' ? 'failed' : 'running';
    }

    this.renderHistory(); // Use history view instead of separate render
    
    // Auto-scroll to bottom of logs
    setTimeout(() => {
      const logsElements = document.querySelectorAll('.logs-output, .combined-log-list');
      logsElements.forEach(el => {
        el.scrollTop = el.scrollHeight;
      });
    }, 50);
  },

  async updateResult(result) {
    if (result.success) {
      this.steps.push({
        step: 'Hoàn tất',
        status: 'completed',
        details: 'Deploy thành công!'
      });
      // Show success toast
      window.toast?.success('✅ Deploy thành công!');
    } else {
      this.steps.push({
        step: 'Lỗi',
        status: 'error',
        details: result.error || 'Deploy thất bại'
      });
      // Show error toast
      window.toast?.error(`❌ Deploy thất bại: ${result.error || 'Lỗi không xác định'}`);
    }

    // Update live entry before saving
    if (this.liveEntry) {
      this.liveEntry.steps = [...this.steps];
      this.liveEntry.fullLogs = [...this.combinedLogLines];
      this.liveEntry.status = result.success ? 'success' : 'failed';
      this.liveEntry.endTime = new Date().toISOString();
      this.liveEntry.results = result.results || {};
      if (result.error) {
        this.liveEntry.error = result.error;
      }
    }

    this.saveHistoryEntry(result);
    
    // Reload config to get latest history
    try {
      await window.dashboard?.loadConfig();
    } catch (error) {
      console.warn('[deploymentStatus] Failed to reload config:', error);
    }
    
    // Clear live entry and show saved history entry
    this.liveEntry = null;
    this.historyList = this.loadHistoryList();
    if (this.historyList.length > 0) {
      // Show the newly saved entry (last in array)
      this.currentHistoryIndex = this.historyList.length - 1;
    }
    
    this.renderHistory();
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

