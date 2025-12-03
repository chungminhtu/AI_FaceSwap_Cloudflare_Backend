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
        let displayText = result.currentAccount || 'Đã xác thực';
        if (result.usingApplicationDefault) {
          displayText = 'Application Default';
        }
        statusEl.textContent = displayText;
        statusEl.className = 'status-indicator authenticated';
      } else {
        let displayText = 'Chưa xác thực';
        if (result.needsReauth) {
          displayText = 'Cần đăng nhập lại';
        }
        statusEl.textContent = displayText;
        statusEl.className = 'status-indicator not-authenticated';
      }
    } catch (error) {
      statusEl.textContent = 'Lỗi kiểm tra';
      statusEl.className = 'status-indicator not-authenticated';
    }
  }
};

// Setup login button listeners
function setupLoginButtons() {
  const btnLoginCF = document.getElementById('btn-login-cf');
  if (!btnLoginCF) {
    console.error('[auth-status] Button btn-login-cf not found!');
    // Retry after a short delay
    setTimeout(setupLoginButtons, 500);
    return;
  }

  // Remove existing listeners to avoid duplicates
  const newBtnLoginCF = btnLoginCF.cloneNode(true);
  btnLoginCF.parentNode?.replaceChild(newBtnLoginCF, btnLoginCF);

  newBtnLoginCF.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    console.log('[auth-status] Cloudflare login button clicked');
    
    try {
      newBtnLoginCF.disabled = true;
      newBtnLoginCF.textContent = 'Đang đăng nhập...';
      
      console.log('[auth-status] Calling authLoginCloudflare...');
      
      // Show user that browser should open
      const userMessage = 'Đang mở trình duyệt để đăng nhập Cloudflare...\n\nVui lòng hoàn tất xác thực trong trình duyệt.\nQuá trình này có thể mất vài phút.';
      console.log('[auth-status]', userMessage);
      
      // Add a timeout wrapper to prevent infinite hanging
      const loginPromise = window.electronAPI.authLoginCloudflare();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Login request timed out. The browser window should have opened - please complete the authentication there. If no browser opened, please check console logs.'));
        }, 600000); // 10 minutes - same as backend timeout
      });
      
      let result;
      try {
        result = await Promise.race([loginPromise, timeoutPromise]);
        console.log('[auth-status] Login result:', result);
      } catch (timeoutError) {
        console.error('[auth-status] Login timeout or error:', timeoutError);
        // Check if user might have completed login manually
        console.log('[auth-status] Checking auth status after timeout...');
        try {
          const checkResult = await window.electronAPI.authCheckCloudflare();
          if (checkResult.authenticated) {
            console.log('[auth-status] User is authenticated! Login completed.');
            await window.authStatus.refresh();
            window.toast?.success('✅ Đăng nhập Cloudflare thành công! (Đã xác thực trong trình duyệt)');
            return;
          }
        } catch (checkError) {
          console.error('[auth-status] Auth check failed:', checkError);
        }
        throw timeoutError;
      }
      
      if (result && result.success) {
        await window.authStatus.refresh();
        window.toast?.success('✅ Đăng nhập Cloudflare thành công!');
      } else {
        const errorMsg = result?.error || 'Unknown error';
        console.error('[auth-status] Login failed:', errorMsg);
        window.toast?.error(`❌ Đăng nhập Cloudflare thất bại: ${errorMsg}`);
      }
    } catch (error) {
      console.error('[auth-status] Login error:', error);
      window.toast?.error(`❌ Lỗi đăng nhập Cloudflare: ${error.message || error}`);
    } finally {
      newBtnLoginCF.disabled = false;
      newBtnLoginCF.textContent = 'Đăng nhập Cloudflare';
    }
  });

  const btnLoginGCP = document.getElementById('btn-login-gcp');
  if (!btnLoginGCP) {
    console.error('[auth-status] Button btn-login-gcp not found!');
    return;
  }

  // Remove existing listeners to avoid duplicates
  const newBtnLoginGCP = btnLoginGCP.cloneNode(true);
  btnLoginGCP.parentNode?.replaceChild(newBtnLoginGCP, btnLoginGCP);

  newBtnLoginGCP.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    console.log('[auth-status] GCP login button clicked');
    
    try {
      newBtnLoginGCP.disabled = true;
      newBtnLoginGCP.textContent = 'Đang đăng nhập...';
      
      console.log('[auth-status] Calling authLoginGCP...');
      
      // Show user that browser should open
      const userMessage = 'Đang mở trình duyệt để đăng nhập GCP...\n\nVui lòng hoàn tất xác thực trong trình duyệt.\nQuá trình này có thể mất vài phút.';
      console.log('[auth-status]', userMessage);
      
      // Add a timeout wrapper to prevent infinite hanging
      const loginPromise = window.electronAPI.authLoginGCP();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Login request timed out. The browser window should have opened - please complete the authentication there. If no browser opened, please check console logs.'));
        }, 600000); // 10 minutes - same as backend timeout
      });
      
      let result;
      try {
        result = await Promise.race([loginPromise, timeoutPromise]);
        console.log('[auth-status] Login result:', result);
      } catch (timeoutError) {
        console.error('[auth-status] Login timeout or error:', timeoutError);
        // Check if user might have completed login manually
        console.log('[auth-status] Checking auth status after timeout...');
        try {
          const checkResult = await window.electronAPI.authCheckGCP();
          if (checkResult.authenticated) {
            console.log('[auth-status] User is authenticated! Login completed.');
            await window.authStatus.refresh();
            window.toast?.success('✅ Đăng nhập GCP thành công! (Đã xác thực trong trình duyệt)');
            return;
          }
        } catch (checkError) {
          console.error('[auth-status] Auth check failed:', checkError);
        }
        throw timeoutError;
      }
      
      if (result && result.success) {
        await window.authStatus.refresh();
        window.toast?.success('✅ Đăng nhập GCP thành công!');
      } else {
        const errorMsg = result?.error || 'Unknown error';
        console.error('[auth-status] Login failed:', errorMsg);
        window.toast?.error(`❌ Đăng nhập GCP thất bại: ${errorMsg}`);
      }
    } catch (error) {
      console.error('[auth-status] Login error:', error);
      window.toast?.error(`❌ Lỗi đăng nhập GCP: ${error.message || error}`);
    } finally {
      newBtnLoginGCP.disabled = false;
      newBtnLoginGCP.textContent = 'Đăng nhập GCP';
    }
  });

  console.log('[auth-status] Login buttons setup complete');
}

// Setup when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupLoginButtons);
} else {
  // DOM is already ready
  setupLoginButtons();
}

