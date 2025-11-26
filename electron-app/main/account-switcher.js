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
        if (setError.message.includes('reauthentication') ||
            setError.message.includes('auth tokens') ||
            setError.message.includes('cannot prompt during non-interactive')) {
          return {
            success: false,
            error: 'GCP authentication expired. Run: gcloud auth login',
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

      // Check if we need to switch
      // Wrangler uses account_id in wrangler.jsonc or wrangler.toml
      // We can verify by checking the current account ID
      
      // For now, just verify authentication
      // The actual account switching will be handled by wrangler configuration
      const accountMatch = whoamiOutput.match(/account ID:?\s*([^\s]+)/i);
      const currentAccountId = accountMatch ? accountMatch[1] : null;

      if (accountConfig && accountConfig.accountId) {
        // If accountId is specified in config, we need to ensure wrangler.jsonc has it
        // This is handled by deploy.js when it uses the correct config
        if (currentAccountId && currentAccountId !== accountConfig.accountId) {
          return {
            success: false,
            error: `Account mismatch. Current: ${currentAccountId}, Expected: ${accountConfig.accountId}`,
            needsLogin: true
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

