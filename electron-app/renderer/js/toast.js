// Toast notification system
window.toast = {
  show(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) {
      console.warn('Toast container not found');
      return;
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };

    const titles = {
      success: 'Thành công',
      error: 'Lỗi',
      warning: 'Cảnh báo',
      info: 'Thông tin'
    };

    // Split message into title and content if it contains newlines
    const parts = message.split('\n');
    const title = parts.length > 1 ? parts[0] : titles[type];
    const content = parts.length > 1 ? parts.slice(1).join('\n') : message;

    toast.innerHTML = `
      <div class="toast-icon">${icons[type] || icons.info}</div>
      <div class="toast-content">
        <div class="toast-title">${this.escapeHtml(title)}</div>
        ${content ? `<div class="toast-message">${this.escapeHtml(content)}</div>` : ''}
      </div>
      <button class="toast-close" onclick="this.closest('.toast').remove()">&times;</button>
    `;

    container.appendChild(toast);

    // Auto remove after duration
    if (duration > 0) {
      setTimeout(() => {
        this.remove(toast);
      }, duration);
    }

    return toast;
  },

  remove(toast) {
    if (toast && toast.parentNode) {
      toast.classList.add('toast-exiting');
      setTimeout(() => {
        if (toast.parentNode) {
          toast.remove();
        }
      }, 300);
    }
  },

  success(message, duration = 3000) {
    return this.show(message, 'success', duration);
  },

  error(message, duration = 5000) {
    return this.show(message, 'error', duration);
  },

  warning(message, duration = 4000) {
    return this.show(message, 'warning', duration);
  },

  info(message, duration = 3000) {
    return this.show(message, 'info', duration);
  },

  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};


