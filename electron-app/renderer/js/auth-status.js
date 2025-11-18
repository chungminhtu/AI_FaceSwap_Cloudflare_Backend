// Authentication status management
window.authStatus = {
  async refresh() {
    await this.updateCloudflareStatus();
    await this.updateGCPStatus();
  },

  async updateCloudflareStatus() {
    const statusEl = document.getElementById('cf-status');
    if (!statusEl) return;

    statusEl.textContent = 'Đang kiểm tra...';
    statusEl.className = 'status-indicator checking';

    try {
      const result = await window.electronAPI.authCheckCloudflare();
      if (result.authenticated) {
        statusEl.textContent = result.email || 'Đã xác thực';
        statusEl.className = 'status-indicator authenticated';
      } else {
        statusEl.textContent = 'Chưa xác thực';
        statusEl.className = 'status-indicator not-authenticated';
      }
    } catch (error) {
      statusEl.textContent = 'Lỗi kiểm tra';
      statusEl.className = 'status-indicator not-authenticated';
    }
  },

  async updateGCPStatus() {
    const statusEl = document.getElementById('gcp-status');
    if (!statusEl) return;

    statusEl.textContent = 'Đang kiểm tra...';
    statusEl.className = 'status-indicator checking';

    try {
      const result = await window.electronAPI.authCheckGCP();
      if (result.authenticated) {
        statusEl.textContent = result.currentAccount || 'Đã xác thực';
        statusEl.className = 'status-indicator authenticated';
      } else {
        statusEl.textContent = 'Chưa xác thực';
        statusEl.className = 'status-indicator not-authenticated';
      }
    } catch (error) {
      statusEl.textContent = 'Lỗi kiểm tra';
      statusEl.className = 'status-indicator not-authenticated';
    }
  }
};

// Setup login button listeners
document.addEventListener('DOMContentLoaded', () => {
  const btnLoginCF = document.getElementById('btn-login-cf');
  if (btnLoginCF) {
    btnLoginCF.addEventListener('click', async () => {
      try {
        btnLoginCF.disabled = true;
        btnLoginCF.textContent = 'Đang đăng nhập...';
        const result = await window.electronAPI.authLoginCloudflare();
        if (result.success) {
          await window.authStatus.refresh();
          alert('Đăng nhập Cloudflare thành công!');
        } else {
          alert(`Đăng nhập Cloudflare thất bại: ${result.error || 'Unknown error'}`);
        }
      } catch (error) {
        alert(`Lỗi đăng nhập Cloudflare: ${error.message}`);
      } finally {
        btnLoginCF.disabled = false;
        btnLoginCF.textContent = 'Đăng nhập Cloudflare';
      }
    });
  }

  const btnLoginGCP = document.getElementById('btn-login-gcp');
  if (btnLoginGCP) {
    btnLoginGCP.addEventListener('click', async () => {
      try {
        btnLoginGCP.disabled = true;
        btnLoginGCP.textContent = 'Đang đăng nhập...';
        const result = await window.electronAPI.authLoginGCP();
        if (result.success) {
          await window.authStatus.refresh();
          alert('Đăng nhập GCP thành công!');
        } else {
          alert(`Đăng nhập GCP thất bại: ${result.error || 'Unknown error'}`);
        }
      } catch (error) {
        alert(`Lỗi đăng nhập GCP: ${error.message}`);
      } finally {
        btnLoginGCP.disabled = false;
        btnLoginGCP.textContent = 'Đăng nhập GCP';
      }
    });
  }
});

