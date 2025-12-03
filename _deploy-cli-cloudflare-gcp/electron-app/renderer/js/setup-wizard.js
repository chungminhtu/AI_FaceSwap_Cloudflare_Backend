// Setup wizard management
window.setupWizard = {
  currentTab: 'billing',
  isExecutingCommand: false,

  show() {
    const modal = document.getElementById('setup-guide-modal');
    if (modal) {
      modal.classList.remove('hidden');
      this.render();
      this.setupListeners();
    }
  },

  hide() {
    const modal = document.getElementById('setup-guide-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
  },

  render() {
    const container = document.getElementById('setup-wizard');
    if (!container) return;

    container.innerHTML = `
      <div class="wizard-tabs">
        <button class="wizard-tab ${this.currentTab === 'billing' ? 'active' : ''}" data-tab="billing">
          Thiết lập Billing
        </button>
        <button class="wizard-tab ${this.currentTab === 'vision' ? 'active' : ''}" data-tab="vision">
          Thiết lập Vision API
        </button>
        <button class="wizard-tab ${this.currentTab === 'cloudflare' ? 'active' : ''}" data-tab="cloudflare">
          Thiết lập Cloudflare
        </button>
      </div>

      <div class="wizard-content ${this.currentTab === 'billing' ? 'active' : ''}" id="wizard-billing">
        ${this.renderBillingGuide()}
      </div>

      <div class="wizard-content ${this.currentTab === 'vision' ? 'active' : ''}" id="wizard-vision">
        ${this.renderVisionGuide()}
      </div>

      <div class="wizard-content ${this.currentTab === 'cloudflare' ? 'active' : ''}" id="wizard-cloudflare">
        ${this.renderCloudflareGuide()}
      </div>
    `;
  },

  renderBillingGuide() {
    return `
      <div class="wizard-step">
        <div class="wizard-step-title">1. Truy cập Google Cloud Billing</div>
        <div class="wizard-step-description">
          Đi tới trang Billing của Google Cloud Console để kích hoạt billing cho project của bạn.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="billing-1">
            <label for="billing-1">Truy cập: <a href="https://console.cloud.google.com/billing" target="_blank" class="wizard-step-link">Google Cloud Billing</a></label>
          </li>
        </ul>
      </div>

      <div class="wizard-step">
        <div class="wizard-step-title">2. Tạo hoặc Liên kết Billing Account</div>
        <div class="wizard-step-description">
          Nếu chưa có billing account, tạo mới. Nếu đã có, liên kết với project.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="billing-2">
            <label for="billing-2">Nhấn "Link a billing account" hoặc "Create billing account"</label>
          </li>
          <li>
            <input type="checkbox" id="billing-3">
            <label for="billing-3">Thêm phương thức thanh toán (thẻ tín dụng)</label>
          </li>
          <li>
            <input type="checkbox" id="billing-4">
            <label for="billing-4">Liên kết billing account với project</label>
          </li>
        </ul>
      </div>

      <div class="wizard-step">
        <div class="wizard-step-title">3. Xác nhận Billing đã được kích hoạt</div>
        <div class="wizard-step-description">
          Kiểm tra lại trong Google Cloud Console để đảm bảo billing đã được kích hoạt.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="billing-5">
            <label for="billing-5">Xác nhận billing account đã được liên kết với project</label>
          </li>
        </ul>
      </div>

      <div class="wizard-step">
        <div class="wizard-step-title">Lưu ý về Free Tier</div>
        <div class="wizard-step-description">
          Google Cloud Vision API có free tier: 1,000 requests/tháng miễn phí. Sau đó là $1.50/1,000 requests.
        </div>
      </div>
    `;
  },

  renderVisionGuide() {
    return `
      <div class="wizard-step">
        <div class="wizard-step-title">1. Kích hoạt Cloud Vision API</div>
        <div class="wizard-step-description">
          Kích hoạt Cloud Vision API trong Google Cloud Console.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="vision-1">
            <label for="vision-1">Truy cập: <a href="https://console.cloud.google.com/apis/library/vision.googleapis.com" target="_blank" class="wizard-step-link">Cloud Vision API</a></label>
          </li>
          <li>
            <input type="checkbox" id="vision-2">
            <label for="vision-2">Chọn project của bạn</label>
          </li>
          <li>
            <input type="checkbox" id="vision-3">
            <label for="vision-3">Nhấn "Enable" để kích hoạt API</label>
          </li>
        </ul>
      </div>

      <div class="wizard-step">
        <div class="wizard-step-title">2. Tạo API Key</div>
        <div class="wizard-step-description">
          Tạo API key để sử dụng Vision API.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="vision-4">
            <label for="vision-4">Truy cập: <a href="https://console.cloud.google.com/apis/credentials" target="_blank" class="wizard-step-link">APIs & Services → Credentials</a></label>
          </li>
          <li>
            <input type="checkbox" id="vision-5">
            <label for="vision-5">Nhấn "Create Credentials" → "API Key"</label>
          </li>
          <li>
            <input type="checkbox" id="vision-6">
            <label for="vision-6">Sao chép API key và lưu lại</label>
          </li>
        </ul>
      </div>

      <div class="wizard-step">
        <div class="wizard-step-title">3. Cấu hình API Key (Tùy chọn)</div>
        <div class="wizard-step-description">
          Để bảo mật tốt hơn, bạn có thể giới hạn API key chỉ cho Cloud Vision API.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="vision-7">
            <label for="vision-7">Nhấn "Restrict key" trong API key settings</label>
          </li>
          <li>
            <input type="checkbox" id="vision-8">
            <label for="vision-8">Chọn "Restrict key" → "Cloud Vision API"</label>
          </li>
        </ul>
      </div>
    `;
  },

  renderCloudflareGuide() {
    return `
      <div class="wizard-step">
        <div class="wizard-step-title">1. Tạo Cloudflare Account</div>
        <div class="wizard-step-description">
          Nếu chưa có, tạo tài khoản Cloudflare mới.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="cf-1">
            <label for="cf-1">Truy cập: <a href="https://dash.cloudflare.com/sign-up" target="_blank" class="wizard-step-link">Cloudflare Sign Up</a></label>
          </li>
          <li>
            <input type="checkbox" id="cf-2">
            <label for="cf-2">Đăng ký tài khoản mới hoặc đăng nhập</label>
          </li>
        </ul>
      </div>

      <div class="wizard-step">
        <div class="wizard-step-title">2. Cài đặt Wrangler CLI</div>
        <div class="wizard-step-description">
          Cài đặt Wrangler CLI để quản lý Cloudflare Workers.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="cf-3">
            <label for="cf-3">Chạy: <span class="command-code" data-command="npm install -g wrangler">npm install -g wrangler</span></label>
          </li>
          <li>
            <input type="checkbox" id="cf-4">
            <label for="cf-4">Xác nhận cài đặt: <span class="command-code" data-command="wrangler --version">wrangler --version</span></label>
          </li>
        </ul>
      </div>

      <div class="wizard-step">
        <div class="wizard-step-title">3. Đăng nhập Wrangler</div>
        <div class="wizard-step-description">
          Đăng nhập Wrangler với tài khoản Cloudflare của bạn.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="cf-5">
            <label for="cf-5">Chạy: <span class="command-code" data-command="wrangler login">wrangler login</span></label>
          </li>
          <li>
            <input type="checkbox" id="cf-6">
            <label for="cf-6">Xác nhận đăng nhập: <span class="command-code" data-command="wrangler whoami">wrangler whoami</span></label>
          </li>
        </ul>
      </div>

      <div class="wizard-step">
        <div class="wizard-step-title">4. Tạo R2 Bucket và D1 Database</div>
        <div class="wizard-step-description">
          Tạo các tài nguyên cần thiết cho ứng dụng.
        </div>
        <ul class="wizard-step-checklist">
          <li>
            <input type="checkbox" id="cf-7">
            <label for="cf-7">Tạo R2 bucket: <span class="command-code" data-command="wrangler r2 bucket create faceswap-images">wrangler r2 bucket create faceswap-images</span></label>
          </li>
          <li>
            <input type="checkbox" id="cf-8">
            <label for="cf-8">Tạo D1 database: <span class="command-code" data-command="wrangler d1 create faceswap-db">wrangler d1 create faceswap-db</span></label>
          </li>
        </ul>
      </div>
    `;
  },

  setupListeners() {
    // Tab switching
    const tabs = document.querySelectorAll('.wizard-tab');
    tabs.forEach(tab => {
      tab.replaceWith(tab.cloneNode(true));
    });
    
    document.querySelectorAll('.wizard-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabName = e.target.dataset.tab;
        this.switchTab(tabName);
      });
    });

    // Close button
    const btnClose = document.getElementById('btn-close-modal');
    if (btnClose) {
      btnClose.replaceWith(btnClose.cloneNode(true));
      document.getElementById('btn-close-modal').addEventListener('click', () => {
        this.hide();
      });
    }

    // Make commands clickable - use event delegation to avoid duplicate listeners
    this.setupCommandListeners();
  },

  setupCommandListeners() {
    // Remove old listeners by cloning elements
    document.querySelectorAll('.command-code').forEach(cmd => {
      cmd.replaceWith(cmd.cloneNode(true));
    });
    
    // Setup command code click handlers using event delegation on the modal
    const modal = document.getElementById('setup-guide-modal');
    if (modal) {
      // Remove old listener if exists
      if (modal._commandClickHandler) {
        modal.removeEventListener('click', modal._commandClickHandler);
      }
      
      // Create new handler
      modal._commandClickHandler = async (e) => {
        const cmd = e.target.closest('.command-code');
        if (cmd) {
          e.stopPropagation();
          e.preventDefault();
          const command = cmd.dataset.command;
          if (command) {
            await this.executeCommand(command);
          }
        }
      };
      
      // Add listener to modal (event delegation)
      modal.addEventListener('click', modal._commandClickHandler);
    }
  },

  async executeCommand(command) {
    // Prevent multiple simultaneous executions
    if (this.isExecutingCommand) {
      console.log('Command already executing, ignoring duplicate click');
      return;
    }
    
    this.isExecutingCommand = true;
    
    try {
      // Get codebase path from config
      const config = window.dashboard?.getCurrentConfig();
      const codebasePath = config?.codebasePath;
      
      if (!codebasePath) {
        window.toast?.warning('⚠️ Vui lòng chọn đường dẫn codebase trước khi chạy lệnh!');
        this.isExecutingCommand = false;
        return;
      }

      // Execute command via electron API
      if (window.electronAPI && window.electronAPI.executeCommand) {
        const result = await window.electronAPI.executeCommand(command, codebasePath);
        if (result.success) {
          window.toast?.success(`✅ Lệnh đã chạy thành công!\n\n${result.output || ''}`);
        } else {
          window.toast?.error(`❌ Lỗi khi chạy lệnh:\n\n${result.error || 'Unknown error'}`);
        }
      } else {
        // Fallback: copy to clipboard and show message
        await navigator.clipboard.writeText(command);
        window.toast?.success(`✅ Đã sao chép lệnh vào clipboard:\n\n${command}\n\nVui lòng chạy trong terminal.`);
      }
    } catch (error) {
      console.error('Error executing command:', error);
      window.toast?.error(`❌ Lỗi: ${error.message}`);
    } finally {
      this.isExecutingCommand = false;
    }
  },

  switchTab(tabName) {
    this.currentTab = tabName;
    
    // Update tab buttons
    document.querySelectorAll('.wizard-tab').forEach(tab => {
      tab.classList.remove('active');
      if (tab.dataset.tab === tabName) {
        tab.classList.add('active');
      }
    });

    // Update content
    document.querySelectorAll('.wizard-content').forEach(content => {
      content.classList.remove('active');
      if (content.id === `wizard-${tabName}`) {
        content.classList.add('active');
      }
    });
    
    // Re-setup command listeners for the new tab content
    // But use event delegation so we don't duplicate listeners
    // The event delegation on modal should handle this, but ensure it's set up
    if (!document.getElementById('setup-guide-modal')?._commandClickHandler) {
      this.setupCommandListeners();
    }
  }
};

