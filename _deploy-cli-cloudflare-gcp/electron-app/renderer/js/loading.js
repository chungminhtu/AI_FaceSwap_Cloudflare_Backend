(function() {
  'use strict';
  
  window.loading = {
    _counter: 0,
    _message: 'Đang xử lý...',

    show(message = 'Đang xử lý...') {
      this._counter++;
      this._message = message;
      
      const overlay = document.getElementById('loading-overlay');
      const textEl = overlay?.querySelector('.loading-text');
      
      if (overlay) {
        overlay.classList.remove('hidden');
        if (textEl) {
          textEl.textContent = this._message;
        }
      }
    },

    hide() {
      this._counter = Math.max(0, this._counter - 1);
      
      if (this._counter === 0) {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
          overlay.classList.add('hidden');
        }
      }
    },

    async withLoading(fn, message = 'Đang xử lý...') {
      if (!fn || typeof fn !== 'function') {
        console.error('[loading.withLoading] Invalid function provided');
        return;
      }
      
      try {
        this.show(message);
        return await fn();
      } finally {
        this.hide();
      }
    }
  };
})();

