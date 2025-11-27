const { execSync } = require('child_process');

class AccountSwitcher {
  // Switch GCP project
  async switchGCPProject(projectId) {
    try {
      // First check if we're already in the correct project (avoid unnecessary operations)
      const currentProject = execSync('gcloud config get-value project', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000
      }).trim();

      if (currentProject === projectId) {
        return {
          success: true,
          projectId: currentProject,
          message: 'Already in correct project'
        };
      }

      // Try to switch project (may fail if auth issues)
      try {
        execSync(`gcloud config set project ${projectId}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000
        });
      } catch (setError) {
        // Handle authentication errors gracefully
        const errorMsg = setError.message || setError.stderr?.toString() || '';
        if (errorMsg.includes('reauthentication') ||
            errorMsg.includes('auth tokens') ||
            errorMsg.includes('cannot prompt during non-interactive')) {
          return {
            success: false,
            error: 'GCP authentication expired. Please run "gcloud auth login" or "gcloud auth application-default login" in your terminal.',
            needsAuth: true,
            currentProject: currentProject || 'unknown'
          };
        }
        throw setError;
      }

      // Verify the switch
      const verifyProject = execSync('gcloud config get-value project', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000
      }).trim();

      if (verifyProject !== projectId) {
        throw new Error(`Failed to switch project. Current project: ${verifyProject}`);
      }

      return {
        success: true,
        projectId: verifyProject
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.stderr?.toString() || error.stdout?.toString() || 'Unknown error'
      };
    }
  }

  // Switch GCP account
  async switchGCPAccount(email) {
    try {
      // Check authentication first
      try {
        execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000
        });
      } catch (authError) {
        const errorMsg = authError.message || authError.stderr?.toString() || '';
        if (errorMsg.includes('reauthentication') ||
            errorMsg.includes('auth tokens') ||
            errorMsg.includes('cannot prompt during non-interactive')) {
          return {
            success: false,
            error: 'GCP authentication expired. Please run "gcloud auth login" or "gcloud auth application-default login" in your terminal.',
            needsAuth: true
          };
        }
        throw authError;
      }

      // First check if the account is already authenticated
      const accountsOutput = execSync('gcloud auth list --format="value(account)"', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });

      const accounts = accountsOutput.trim().split('\n').filter(a => a);
      const accountExists = accounts.includes(email);

      if (!accountExists) {
        // Need to login with this account
        return {
          success: false,
          error: `Account ${email} is not authenticated. Please login first.`,
          needsLogin: true
        };
      }

      // Activate the account
      execSync(`gcloud config set account ${email}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });

      // Verify the switch
      const currentAccount = execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000
      }).trim();

      if (currentAccount !== email) {
        throw new Error(`Failed to switch account. Current account: ${currentAccount}`);
      }

      return {
        success: true,
        account: currentAccount
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.stderr?.toString() || error.stdout?.toString() || 'Unknown error'
      };
    }
  }

  // Switch Cloudflare account
  // Note: Cloudflare account switching is typically done via wrangler.toml or environment variables
  // This is a placeholder - actual implementation depends on how wrangler handles multi-account
  async switchCloudflare(accountConfig) {
    try {
      // Verify current account
      const whoamiOutput = execSync('wrangler whoami', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });

      // Parse account ID from wrangler whoami output
      // Wrangler outputs a table format: │ Account Name │ Account ID │
      let currentAccountId = null;
      
      // Method 1: Parse table format (most reliable)
      const lines = whoamiOutput.split('\n');
      for (const line of lines) {
        // Look for table row with Account ID (contains │ and hex string)
        if (line.includes('│') && /[a-f0-9]{32}/i.test(line)) {
          // Split by │ and find the hex string (32 chars)
          const parts = line.split('│').map(p => p.trim());
          for (const part of parts) {
            const idMatch = part.match(/([a-f0-9]{32})/i);
            if (idMatch && idMatch[1].length === 32) {
              currentAccountId = idMatch[1];
              break;
            }
          }
          if (currentAccountId) break;
        }
      }
      
      // Method 2: Fallback - Try simple regex patterns
      if (!currentAccountId) {
        // Pattern 1: "Account ID: 72474c350e3f55d96195536a5d39e00d"
        const accountIdMatch1 = whoamiOutput.match(/account\s+id:?\s*([a-f0-9]{32})/i);
        if (accountIdMatch1) {
          currentAccountId = accountIdMatch1[1];
        }
      }
      
      // Method 3: Fallback - Any 32-char hex string
      if (!currentAccountId) {
        const hexMatches = whoamiOutput.match(/\b([a-f0-9]{32})\b/gi);
        if (hexMatches && hexMatches.length > 0) {
          // Use the last match (usually the Account ID)
          currentAccountId = hexMatches[hexMatches.length - 1];
        }
      }

      if (accountConfig && accountConfig.accountId) {
        // If accountId is specified in config, verify it matches
        if (!currentAccountId) {
          return {
            success: false,
            error: `Could not detect current Cloudflare account ID. Please ensure you are authenticated with wrangler.`,
            needsLogin: true
          };
        }
        
        if (currentAccountId !== accountConfig.accountId) {
          return {
            success: false,
            error: `Account mismatch. Current: ${currentAccountId}, Expected: ${accountConfig.accountId}`,
            needsLogin: true,
            currentAccountId: currentAccountId,
            expectedAccountId: accountConfig.accountId
          };
        }
      }

      return {
        success: true,
        accountId: currentAccountId,
        message: 'Cloudflare account verification passed'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.stderr?.toString() || error.stdout?.toString() || 'Unknown error',
        needsLogin: true
      };
    }
  }
}

module.exports = new AccountSwitcher();

