// Error display management
window.errorDisplay = {
  currentError: null,

  show(errorData) {
    this.currentError = errorData;
    const modal = document.getElementById('error-modal');
    if (modal) {
      modal.classList.remove('hidden');
      this.render();
      this.setupListeners();
    }
  },

  hide() {
    const modal = document.getElementById('error-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
    this.currentError = null;
  },

  render() {
    const container = document.getElementById('error-display');
    if (!container || !this.currentError) return;

    let html = '';

    // Main error
    if (this.currentError.error) {
      html += `
        <div class="error-item">
          <div class="error-step">Lỗi chính</div>
          <div class="error-message">${this.escapeHtml(this.currentError.error)}</div>
        </div>
      `;
    }

    // Stack trace
    if (this.currentError.stack) {
      html += `
        <div class="error-item">
          <div class="error-step">Stack Trace</div>
          <div class="error-stack">${this.escapeHtml(this.currentError.stack)}</div>
        </div>
      `;
    }

    // Step errors
    if (this.currentError.errors && Array.isArray(this.currentError.errors)) {
      this.currentError.errors.forEach((err, index) => {
        html += `
          <div class="error-item">
            <div class="error-step">Bước: ${this.escapeHtml(err.step || `Step ${index + 1}`)}</div>
            <div class="error-message">${this.escapeHtml(err.error || 'Unknown error')}</div>
            ${err.stack ? `<div class="error-stack">${this.escapeHtml(err.stack)}</div>` : ''}
          </div>
        `;
      });
    }

    container.innerHTML = html || '<div class="error-item">Không có thông tin lỗi</div>';
  },

  setupListeners() {
    // Close button
    const btnClose = document.getElementById('btn-close-error');
    const btnCloseFooter = document.getElementById('btn-close-error-btn');
    
    if (btnClose) {
      btnClose.replaceWith(btnClose.cloneNode(true));
      document.getElementById('btn-close-error').addEventListener('click', () => {
        this.hide();
      });
    }

    if (btnCloseFooter) {
      btnCloseFooter.replaceWith(btnCloseFooter.cloneNode(true));
      document.getElementById('btn-close-error-btn').addEventListener('click', () => {
        this.hide();
      });
    }

    // Retry button
    const btnRetry = document.getElementById('btn-retry-deployment');
    if (btnRetry) {
      btnRetry.replaceWith(btnRetry.cloneNode(true));
      document.getElementById('btn-retry-deployment').addEventListener('click', async () => {
        this.hide();
        // Get deployment ID from current error context if available
        // For now, user needs to manually retry from deployment list
        alert('Vui lòng thử lại từ danh sách triển khai.');
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

