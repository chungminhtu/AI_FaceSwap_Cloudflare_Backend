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
      let email = emailMatch ? emailMatch[1] : null;
      
      // Remove trailing punctuation (period, comma, etc.) from email
      if (email) {
        email = email.replace(/[.,;:!?]+$/, '');
      }

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
      // First try regular auth
      let output;
      try {
        output = execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });
      } catch (authError) {
        // If regular auth fails, try application-default credentials
        const errorMsg = authError.message || authError.stderr?.toString() || '';
        if (errorMsg.includes('reauthentication') ||
            errorMsg.includes('auth tokens') ||
            errorMsg.includes('cannot prompt during non-interactive')) {
          // Try application-default credentials as fallback
          try {
            execSync('gcloud auth application-default print-access-token', {
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 5000
            });
            // Application-default credentials work, but we don't have account info
            return {
              authenticated: true,
              accounts: ['application-default'],
              currentAccount: 'application-default',
              details: 'Using application-default credentials',
              usingApplicationDefault: true
            };
          } catch (appDefaultError) {
            // Both failed
            return {
              authenticated: false,
              accounts: [],
              currentAccount: null,
              error: 'GCP authentication expired. Run: gcloud auth login or gcloud auth application-default login',
              needsReauth: true,
              details: errorMsg
            };
          }
        }
        throw authError;
      }

      const accounts = output.trim().split('\n').filter(a => a);
      
      // Remove trailing punctuation from all accounts
      const cleanedAccounts = accounts.map(account => account.replace(/[.,;:!?]+$/, ''));
      const currentAccount = cleanedAccounts[0] || null;

      return {
        authenticated: cleanedAccounts.length > 0,
        accounts: cleanedAccounts,
        currentAccount: currentAccount,
        details: output.trim()
      };
    } catch (error) {
      const errorMsg = error.message || error.stderr?.toString() || '';
      return {
        authenticated: false,
        accounts: [],
        currentAccount: null,
        error: errorMsg,
        needsReauth: errorMsg.includes('reauthentication') || errorMsg.includes('auth tokens'),
        details: error.stderr?.toString() || error.stdout?.toString() || 'Not authenticated'
      };
    }
  }

  // Login to Cloudflare
  async loginCloudflare() {
    // First, verify wrangler is accessible
    try {
      execSync('wrangler --version', { stdio: 'ignore', timeout: 5000 });
    } catch (error) {
      throw new Error('wrangler is not installed or not in PATH. Please install wrangler first: npm install -g wrangler');
    }

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let resolved = false;
      
      console.log('[auth-checker] Starting wrangler login process...');
      
      // Use execSync for a quick test first, then spawn for interactive
      const wranglerProcess = spawn('wrangler', ['login'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        detached: false,
        windowsHide: true,
        env: {
          ...process.env,
          // Ensure browser can open
          BROWSER: process.env.BROWSER || 'default'
        }
      });

      // Capture output for debugging
      wranglerProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        console.log('[wrangler login] stdout:', text.trim());
      });

      wranglerProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        console.log('[wrangler login] stderr:', text.trim());
      });

      // Set a timeout (10 minutes for login - user needs time to complete OAuth)
      const timeout = setTimeout(() => {
        if (!resolved) {
          console.error('[wrangler login] Timeout reached, killing process');
          try {
            wranglerProcess.kill('SIGTERM');
            setTimeout(() => {
              if (!wranglerProcess.killed) {
                wranglerProcess.kill('SIGKILL');
              }
            }, 5000);
          } catch (e) {
            console.error('[wrangler login] Error killing process:', e);
          }
          // Don't set resolved here - let the close handler set it
          reject(new Error('Login timeout: The login process took too long (10 minutes). Please complete the browser authentication and try again.'));
        }
      }, 600000); // 10 minutes

      const cleanup = () => {
        clearTimeout(timeout);
      };

      wranglerProcess.on('close', (code, signal) => {
        if (resolved) {
          console.log('[wrangler login] Already resolved, ignoring close event');
          return; // Already handled
        }
        
        cleanup();
        console.log(`[wrangler login] Process exited with code ${code}, signal ${signal}`);
        console.log(`[wrangler login] stdout: ${stdout}`);
        console.log(`[wrangler login] stderr: ${stderr}`);
        
        // Code 0 means success, null might mean killed but we'll check auth anyway
        if (code === 0 || (code === null && signal === null)) {
          console.log('[wrangler login] Login process completed, verifying...');
          resolved = true; // Mark as resolved to prevent duplicate handling
          
          // Give it a moment for auth to settle
          setTimeout(() => {
            this.checkCloudflare().then(result => {
              console.log('[wrangler login] Verification result:', result);
              if (result.authenticated) {
                resolve({
                  success: true,
                  email: result.email,
                  error: null
                });
              } else {
                // Even if verification fails, if stdout says "Successfully logged in", trust it
                if (stdout.includes('Successfully logged in')) {
                  console.log('[wrangler login] Stdout confirms login, treating as success');
                  resolve({
                    success: true,
                    email: result.email || 'Authenticated',
                    error: null
                  });
                } else {
                  resolve({
                    success: false,
                    email: result.email,
                    error: 'Login completed but verification failed. Please check your authentication.'
                  });
                }
              }
            }).catch(err => {
              console.error('[wrangler login] Verification error:', err);
              // If stdout says success, trust it even if verification fails
              if (stdout.includes('Successfully logged in')) {
                console.log('[wrangler login] Stdout confirms login despite verification error');
                resolve({
                  success: true,
                  email: 'Authenticated',
                  error: null
                });
              } else {
                reject(new Error(`Verification failed: ${err.message}`));
              }
            });
          }, 2000); // Wait 2 seconds before verification
        } else if (code !== null) {
          resolved = true;
          const errorMsg = stderr || stdout || `wrangler login exited with code ${code}`;
          console.error('[wrangler login] Login failed:', errorMsg);
          reject(new Error(`Login failed: ${errorMsg}`));
        } else {
          // Process was killed or terminated
          console.warn('[wrangler login] Process was terminated');
          resolved = true;
          // Still try to verify - user might have completed login before timeout
          setTimeout(() => {
            this.checkCloudflare().then(result => {
              if (result.authenticated) {
                resolve({
                  success: true,
                  email: result.email,
                  error: null
                });
              } else {
                reject(new Error('Login process was interrupted. Please try again.'));
              }
            }).catch(err => {
              reject(new Error(`Login process was interrupted: ${err.message}`));
            });
          }, 2000);
        }
      });

      wranglerProcess.on('error', (error) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        console.error('[wrangler login] Process error:', error);
        reject(new Error(`Failed to start login process: ${error.message}. Make sure wrangler is installed and in your PATH.`));
      });

      // Log process start
      console.log('[wrangler login] Process started, PID:', wranglerProcess.pid);
      console.log('[wrangler login] Waiting for browser authentication...');
    });
  }

  // Login to GCP
  async loginGCP() {
    // First, verify gcloud is accessible
    try {
      execSync('gcloud --version', { stdio: 'ignore', timeout: 5000 });
    } catch (error) {
      throw new Error('gcloud is not installed or not in PATH. Please install Google Cloud SDK first.');
    }

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let resolved = false;
      
      console.log('[auth-checker] Starting gcloud login process...');
      
      const gcloudProcess = spawn('gcloud', ['auth', 'login'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        detached: false,
        windowsHide: true,
        env: {
          ...process.env,
          // Ensure browser can open
          BROWSER: process.env.BROWSER || 'default'
        }
      });

      // Capture output for debugging
      gcloudProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        console.log('[gcloud login] stdout:', text.trim());
      });

      gcloudProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        console.log('[gcloud login] stderr:', text.trim());
      });

      // Set a timeout (10 minutes for login - user needs time to complete OAuth)
      const timeout = setTimeout(() => {
        if (!resolved) {
          console.error('[gcloud login] Timeout reached, killing process');
          try {
            gcloudProcess.kill('SIGTERM');
            setTimeout(() => {
              if (!gcloudProcess.killed) {
                gcloudProcess.kill('SIGKILL');
              }
            }, 5000);
          } catch (e) {
            console.error('[gcloud login] Error killing process:', e);
          }
          // Don't set resolved here - let the close handler set it
          reject(new Error('Login timeout: The login process took too long (10 minutes). Please complete the browser authentication and try again.'));
        }
      }, 600000); // 10 minutes

      const cleanup = () => {
        clearTimeout(timeout);
      };

      gcloudProcess.on('close', (code, signal) => {
        if (resolved) {
          console.log('[gcloud login] Already resolved, ignoring close event');
          return; // Already handled
        }
        
        cleanup();
        console.log(`[gcloud login] Process exited with code ${code}, signal ${signal}`);
        console.log(`[gcloud login] stdout: ${stdout}`);
        console.log(`[gcloud login] stderr: ${stderr}`);
        
        // Code 0 means success, null might mean killed but we'll check auth anyway
        if (code === 0 || (code === null && signal === null)) {
          console.log('[gcloud login] Login process completed, verifying...');
          resolved = true; // Mark as resolved to prevent duplicate handling
          
          // Give it a moment for auth to settle
          setTimeout(() => {
            this.checkGCP().then(result => {
              console.log('[gcloud login] Verification result:', result);
              if (result.authenticated) {
                resolve({
                  success: true,
                  accounts: result.accounts,
                  currentAccount: result.currentAccount,
                  error: null
                });
              } else {
                // Even if verification fails, if stdout indicates success, trust it
                if (stdout.includes('You are now logged in') || stdout.includes('Successfully') || stdout.includes('Authenticated')) {
                  console.log('[gcloud login] Stdout confirms login, treating as success');
                  resolve({
                    success: true,
                    accounts: result.accounts || [],
                    currentAccount: result.currentAccount || 'Authenticated',
                    error: null
                  });
                } else {
                  resolve({
                    success: false,
                    accounts: result.accounts || [],
                    currentAccount: result.currentAccount,
                    error: 'Login completed but verification failed. Please check your authentication.'
                  });
                }
              }
            }).catch(err => {
              console.error('[gcloud login] Verification error:', err);
              // If stdout indicates success, trust it even if verification fails
              if (stdout.includes('You are now logged in') || stdout.includes('Successfully') || stdout.includes('Authenticated')) {
                console.log('[gcloud login] Stdout confirms login despite verification error');
                resolve({
                  success: true,
                  accounts: [],
                  currentAccount: 'Authenticated',
                  error: null
                });
              } else {
                reject(new Error(`Verification failed: ${err.message}`));
              }
            });
          }, 2000); // Wait 2 seconds before verification
        } else if (code !== null) {
          resolved = true;
          const errorMsg = stderr || stdout || `gcloud auth login exited with code ${code}`;
          console.error('[gcloud login] Login failed:', errorMsg);
          reject(new Error(`Login failed: ${errorMsg}`));
        } else {
          // Process was killed or terminated
          console.warn('[gcloud login] Process was terminated');
          resolved = true;
          // Still try to verify - user might have completed login before timeout
          setTimeout(() => {
            this.checkGCP().then(result => {
              if (result.authenticated) {
                resolve({
                  success: true,
                  accounts: result.accounts,
                  currentAccount: result.currentAccount,
                  error: null
                });
              } else {
                reject(new Error('Login process was interrupted. Please try again.'));
              }
            }).catch(err => {
              reject(new Error(`Login process was interrupted: ${err.message}`));
            });
          }, 2000);
        }
      });

      gcloudProcess.on('error', (error) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        console.error('[gcloud login] Process error:', error);
        reject(new Error(`Failed to start login process: ${error.message}. Make sure gcloud is installed and in your PATH.`));
      });

      // Log process start
      console.log('[gcloud login] Process started, PID:', gcloudProcess.pid);
      console.log('[gcloud login] Waiting for browser authentication...');
    });
  }
}

module.exports = new AuthChecker();

