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
      // Try JSON format first (most reliable, available in newer wrangler versions)
      let currentAccountId = null;
      let whoamiOutput = '';
      
      try {
        // Method 1: Try JSON format first (most reliable)
        try {
          whoamiOutput = execSync('wrangler whoami --format json', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      });

          try {
            const jsonData = JSON.parse(whoamiOutput);
            if (jsonData.accountId) {
              currentAccountId = jsonData.accountId.toLowerCase();
            } else if (jsonData.account && jsonData.account.id) {
              currentAccountId = jsonData.account.id.toLowerCase();
            }
          } catch (jsonError) {
            // JSON parsing failed, fall through to text parsing
          }
        } catch (jsonCmdError) {
          // JSON format not available, try regular whoami
          whoamiOutput = execSync('wrangler whoami', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 10000
          });
        }
      } catch (error) {
        throw error;
      }

      // Method 2: Parse table format from text output
      if (!currentAccountId && whoamiOutput) {
      const lines = whoamiOutput.split('\n');
      for (const line of lines) {
          // Skip header lines and separator lines
          if (line.includes('Account Name') || line.includes('Account ID') || line.trim().match(/^[│\s\-]+$/)) {
            continue;
          }
          
        // Look for table row with Account ID (contains │ and hex string)
        if (line.includes('│') && /[a-f0-9]{32}/i.test(line)) {
          // Split by │ and find the hex string (32 chars)
            // Filter out empty strings and pipe characters
            const parts = line.split('│')
              .map(p => p.trim())
              .filter(p => p && p !== '│' && p.length > 0);
            
          for (const part of parts) {
              // Look for 32-character hex string
            const idMatch = part.match(/([a-f0-9]{32})/i);
            if (idMatch && idMatch[1].length === 32) {
                currentAccountId = idMatch[1].toLowerCase();
              break;
            }
          }
          if (currentAccountId) break;
          }
        }
      }
      
      // Method 3: Fallback - Try simple regex patterns
      if (!currentAccountId && whoamiOutput) {
        // Pattern 1: "Account ID: 72474c350e3f55d96195536a5d39e00d"
        const accountIdMatch1 = whoamiOutput.match(/account\s+id:?\s*([a-f0-9]{32})/i);
        if (accountIdMatch1) {
          currentAccountId = accountIdMatch1[1].toLowerCase();
        }
      }
      
      // Method 4: Fallback - Any 32-char hex string (but filter out common false positives)
      if (!currentAccountId && whoamiOutput) {
        const hexMatches = whoamiOutput.match(/\b([a-f0-9]{32})\b/gi);
        if (hexMatches && hexMatches.length > 0) {
          // Filter out matches that are clearly not account IDs (e.g., in URLs, paths)
          const validMatches = hexMatches.filter(match => {
            const lowerMatch = match.toLowerCase();
            // Account IDs are typically lowercase and not part of URLs
            return !whoamiOutput.toLowerCase().includes(`http://${lowerMatch}`) &&
                   !whoamiOutput.toLowerCase().includes(`https://${lowerMatch}`);
          });
          
          if (validMatches.length > 0) {
          // Use the last match (usually the Account ID)
            currentAccountId = validMatches[validMatches.length - 1].toLowerCase();
        }
        }
      }

      // Log final result
      if (currentAccountId) {
      } else {
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
        
        // Normalize both account IDs to lowercase for comparison
        const normalizedCurrent = currentAccountId.toLowerCase().trim();
        const normalizedExpected = accountConfig.accountId.toLowerCase().trim();
        
        if (normalizedCurrent !== normalizedExpected) {
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

