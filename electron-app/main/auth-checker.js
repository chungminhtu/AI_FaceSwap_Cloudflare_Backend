const { execSync, spawn } = require('child_process');

class AuthChecker {
  // Check Cloudflare authentication
  async checkCloudflare() {
    try {
      const output = execSync('wrangler whoami', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });

      // Parse whoami output to extract email
      const lines = output.trim().split('\n');
      const emailMatch = output.match(/([^\s]+@[^\s]+)/);
      const email = emailMatch ? emailMatch[1] : null;

      return {
        authenticated: true,
        email: email || 'Unknown',
        details: output.trim()
      };
    } catch (error) {
      return {
        authenticated: false,
        email: null,
        error: error.message,
        details: error.stderr?.toString() || error.stdout?.toString() || 'Not authenticated'
      };
    }
  }

  // Check GCP authentication
  async checkGCP() {
    try {
      const output = execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });

      const accounts = output.trim().split('\n').filter(a => a);
      const currentAccount = accounts[0] || null;

      return {
        authenticated: accounts.length > 0,
        accounts: accounts,
        currentAccount: currentAccount,
        details: output.trim()
      };
    } catch (error) {
      return {
        authenticated: false,
        accounts: [],
        currentAccount: null,
        error: error.message,
        details: error.stderr?.toString() || error.stdout?.toString() || 'Not authenticated'
      };
    }
  }

  // Login to Cloudflare
  async loginCloudflare() {
    return new Promise((resolve, reject) => {
      const wranglerProcess = spawn('wrangler', ['login'], {
        stdio: 'inherit',
        shell: true
      });

      wranglerProcess.on('close', (code) => {
        if (code === 0) {
          // Verify login
          this.checkCloudflare().then(result => {
            resolve({
              success: result.authenticated,
              email: result.email,
              error: result.authenticated ? null : 'Login completed but verification failed'
            });
          }).catch(reject);
        } else {
          reject(new Error(`wrangler login exited with code ${code}`));
        }
      });

      wranglerProcess.on('error', (error) => {
        reject(error);
      });
    });
  }

  // Login to GCP
  async loginGCP() {
    return new Promise((resolve, reject) => {
      const gcloudProcess = spawn('gcloud', ['auth', 'login'], {
        stdio: 'inherit',
        shell: true
      });

      gcloudProcess.on('close', (code) => {
        if (code === 0) {
          // Verify login
          this.checkGCP().then(result => {
            resolve({
              success: result.authenticated,
              accounts: result.accounts,
              currentAccount: result.currentAccount,
              error: result.authenticated ? null : 'Login completed but verification failed'
            });
          }).catch(reject);
        } else {
          reject(new Error(`gcloud auth login exited with code ${code}`));
        }
      });

      gcloudProcess.on('error', (error) => {
        reject(error);
      });
    });
  }
}

module.exports = new AuthChecker();

