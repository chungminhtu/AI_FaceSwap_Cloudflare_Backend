const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CommandRunner = require('./command-runner');
const AccountSwitcher = require('./account-switcher');
const setupGoogleCloud = require('../../setup-google-cloud-refactored.js');

class DeploymentEngine {
  constructor() {
    this.commandRunner = new CommandRunner(3, 1000);
  }

  async deploy(deployment, config, reportProgress) {
    const errors = [];
    const results = {
      workerUrl: '',
      pagesUrl: '',
      success: false
    };

    const codebasePath = config.codebasePath || process.cwd();
    const workerName = deployment.workerName || 'ai-faceswap-backend';
    const pagesProjectName = deployment.pagesProjectName || 'ai-faceswap-frontend';

    try {
      // Step 1: Check prerequisites
      reportProgress('check-prerequisites', 'running', 'Đang kiểm tra prerequisites...');
      const prerequisites = await this.checkPrerequisites();
      if (!prerequisites.wrangler || !prerequisites.gcloud) {
        throw new Error(`Missing prerequisites: ${JSON.stringify(prerequisites)}`);
      }
      reportProgress('check-prerequisites', 'completed', 'Prerequisites OK');

      // Step 2: Switch accounts
      reportProgress('switch-accounts', 'running', 'Đang chuyển đổi tài khoản...');
      
      if (deployment.gcp) {
        if (deployment.gcp.accountEmail) {
          const accountSwitch = await AccountSwitcher.switchGCPAccount(deployment.gcp.accountEmail);
          if (!accountSwitch.success) {
            throw new Error(`Failed to switch GCP account: ${accountSwitch.error}`);
          }
        }
        
        if (deployment.gcp.projectId) {
          const projectSwitch = await AccountSwitcher.switchGCPProject(deployment.gcp.projectId);
          if (!projectSwitch.success) {
            throw new Error(`Failed to switch GCP project: ${projectSwitch.error}`);
          }
        }
      }

      if (deployment.cloudflare) {
        const cfSwitch = await AccountSwitcher.switchCloudflare(deployment.cloudflare);
        if (!cfSwitch.success && cfSwitch.needsLogin) {
          throw new Error(`Cloudflare authentication required: ${cfSwitch.error}`);
        }
      }

      reportProgress('switch-accounts', 'completed', 'Đã chuyển đổi tài khoản');

      // Step 3: Check authentication
      reportProgress('check-auth', 'running', 'Đang kiểm tra xác thực...');
      const authCheck = await this.checkAuthentication();
      if (!authCheck.cloudflare || !authCheck.gcp) {
        throw new Error(`Authentication failed: Cloudflare=${authCheck.cloudflare}, GCP=${authCheck.gcp}`);
      }
      reportProgress('check-auth', 'completed', 'Xác thực OK');

      // Step 4: Setup GCP (if needed)
      if (deployment.gcp && deployment.gcp.projectId) {
        reportProgress('setup-gcp', 'running', 'Đang thiết lập GCP...');
        try {
          await setupGoogleCloud({
            projectId: deployment.gcp.projectId,
            accountEmail: deployment.gcp.accountEmail,
            skipPrompts: true
          });
          reportProgress('setup-gcp', 'completed', 'GCP setup hoàn tất');
        } catch (error) {
          errors.push({ step: 'setup-gcp', error: error.message });
          reportProgress('setup-gcp', 'warning', `GCP setup warning: ${error.message}`);
        }
      }

      // Step 5: Check/Create R2 bucket
      reportProgress('check-r2', 'running', 'Đang kiểm tra R2 bucket...');
      try {
        await this.ensureR2Bucket(codebasePath);
        reportProgress('check-r2', 'completed', 'R2 bucket OK');
      } catch (error) {
        errors.push({ step: 'check-r2', error: error.message });
        reportProgress('check-r2', 'warning', `R2 bucket warning: ${error.message}`);
      }

      // Step 6: Check/Create D1 database
      reportProgress('check-d1', 'running', 'Đang kiểm tra D1 database...');
      try {
        await this.ensureD1Database(codebasePath);
        reportProgress('check-d1', 'completed', 'D1 database OK');
      } catch (error) {
        errors.push({ step: 'check-d1', error: error.message });
        reportProgress('check-d1', 'warning', `D1 database warning: ${error.message}`);
      }

      // Step 7: Configure R2 CORS
      reportProgress('configure-cors', 'running', 'Đang cấu hình R2 CORS...');
      try {
        await this.configureR2CORS(codebasePath);
        reportProgress('configure-cors', 'completed', 'R2 CORS configured');
      } catch (error) {
        errors.push({ step: 'configure-cors', error: error.message });
        reportProgress('configure-cors', 'warning', `CORS configuration warning: ${error.message}`);
      }

      // Step 8: Deploy secrets
      reportProgress('deploy-secrets', 'running', 'Đang triển khai secrets...');
      try {
        await this.deploySecrets(deployment, codebasePath);
        reportProgress('deploy-secrets', 'completed', 'Secrets đã được triển khai');
      } catch (error) {
        errors.push({ step: 'deploy-secrets', error: error.message });
        throw new Error(`Failed to deploy secrets: ${error.message}`);
      }

      // Step 9: Deploy Worker
      reportProgress('deploy-worker', 'running', `Đang triển khai Worker: ${workerName}...`);
      try {
        results.workerUrl = await this.deployWorker(codebasePath, workerName);
        reportProgress('deploy-worker', 'completed', `Worker deployed: ${results.workerUrl}`);
      } catch (error) {
        errors.push({ step: 'deploy-worker', error: error.message });
        throw new Error(`Worker deployment failed: ${error.message}`);
      }

      // Step 10: Deploy Pages
      reportProgress('deploy-pages', 'running', `Đang triển khai Pages: ${pagesProjectName}...`);
      try {
        results.pagesUrl = await this.deployPages(codebasePath, pagesProjectName);
        reportProgress('deploy-pages', 'completed', `Pages deployed: ${results.pagesUrl || 'URL not available'}`);
      } catch (error) {
        errors.push({ step: 'deploy-pages', error: error.message });
        reportProgress('deploy-pages', 'warning', `Pages deployment warning: ${error.message}`);
      }

      results.success = true;
      return {
        success: true,
        results,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      errors.push({ step: 'deployment', error: error.message, stack: error.stack });
      return {
        success: false,
        error: error.message,
        stack: error.stack,
        errors,
        results
      };
    }
  }

  async checkPrerequisites() {
    const result = {
      wrangler: false,
      gcloud: false
    };

    try {
      execSync('wrangler --version', { stdio: 'ignore', timeout: 5000 });
      result.wrangler = true;
    } catch (error) {
      result.wrangler = false;
    }

    try {
      execSync('gcloud --version', { stdio: 'ignore', timeout: 5000 });
      result.gcloud = true;
    } catch (error) {
      result.gcloud = false;
    }

    return result;
  }

  async checkAuthentication() {
    const result = {
      cloudflare: false,
      gcp: false
    };

    try {
      execSync('wrangler whoami', { stdio: 'ignore', timeout: 10000 });
      result.cloudflare = true;
    } catch (error) {
      result.cloudflare = false;
    }

    try {
      const output = execSync('gcloud auth list --filter=status:ACTIVE --format="value(account)"', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000
      });
      result.gcp = output.trim().length > 0;
    } catch (error) {
      result.gcp = false;
    }

    return result;
  }

  async ensureR2Bucket(codebasePath) {
    try {
      const output = execSync('wrangler r2 bucket list', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
        cwd: codebasePath
      });

      if (!output || !output.includes('faceswap-images')) {
        execSync('wrangler r2 bucket create faceswap-images', {
          stdio: 'inherit',
          timeout: 30000,
          cwd: codebasePath
        });
      }
    } catch (error) {
      // Bucket might already exist or command might fail - non-fatal
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  }

  async ensureD1Database(codebasePath) {
    try {
      const output = execSync('wrangler d1 list', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
        cwd: codebasePath
      });

      if (!output || !output.includes('faceswap-db')) {
        execSync('wrangler d1 create faceswap-db', {
          stdio: 'inherit',
          timeout: 30000,
          cwd: codebasePath
        });

        // Initialize schema
        const schemaPath = path.join(codebasePath, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
          execSync(`wrangler d1 execute faceswap-db --file=${schemaPath}`, {
            stdio: 'inherit',
            timeout: 30000,
            cwd: codebasePath
          });
        }
      } else {
        // Check if schema is initialized
        const schemaPath = path.join(codebasePath, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
          try {
            execSync('wrangler d1 execute faceswap-db --command="SELECT COUNT(*) FROM presets LIMIT 1"', {
              stdio: 'ignore',
              timeout: 10000,
              cwd: codebasePath
            });
          } catch (error) {
            // Schema not initialized, initialize it
            execSync(`wrangler d1 execute faceswap-db --file=${schemaPath}`, {
              stdio: 'inherit',
              timeout: 30000,
              cwd: codebasePath
            });
          }
        }
      }
    } catch (error) {
      // Database might already exist - non-fatal
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  }

  async configureR2CORS(codebasePath) {
    const corsPath = path.join(codebasePath, 'r2-cors.json');
    if (fs.existsSync(corsPath)) {
      try {
        execSync(`wrangler r2 bucket cors set faceswap-images --file=${corsPath}`, {
          stdio: 'inherit',
          timeout: 30000,
          cwd: codebasePath,
          throwOnError: false
        });
      } catch (error) {
        // CORS configuration is non-critical
      }
    }
  }

  async deploySecrets(deployment, codebasePath) {
    if (!deployment.secrets) {
      throw new Error('No secrets provided in deployment config');
    }

    // Create temporary secrets.json file
    const secretsPath = path.join(codebasePath, 'temp-secrets.json');
    try {
      fs.writeFileSync(secretsPath, JSON.stringify(deployment.secrets, null, 2), 'utf8');

      // Deploy secrets using wrangler
      const result = await this.commandRunner.execute(
        'wrangler secret bulk temp-secrets.json',
        {
          cwd: codebasePath,
          silent: false,
          throwOnError: true,
          timeout: 60000
        }
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to deploy secrets');
      }
    } finally {
      // Clean up temporary file
      if (fs.existsSync(secretsPath)) {
        try {
          fs.unlinkSync(secretsPath);
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }
  }

  async deployWorker(codebasePath, workerName) {
    const result = await this.commandRunner.execute('wrangler deploy', {
      cwd: codebasePath,
      silent: false,
      throwOnError: true,
      timeout: 300000 // 5 minutes
    });

    if (!result.success) {
      throw new Error(result.error || 'Worker deployment failed');
    }

    // Try to get Worker URL
    let workerUrl = '';
    try {
      const deployments = execSync('wrangler deployments list --latest', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
        cwd: codebasePath
      });

      if (deployments) {
        const urlMatch = deployments.match(/https:\/\/[^\s]+\.workers\.dev/);
        if (urlMatch) {
          workerUrl = urlMatch[0];
        }
      }
    } catch (error) {
      // Try to construct URL from whoami
      try {
        const whoami = execSync('wrangler whoami', {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 10000,
          cwd: codebasePath
        });

        const accountMatch = whoami.match(/([^\s]+)@/);
        if (accountMatch) {
          const accountSubdomain = accountMatch[1];
          workerUrl = `https://${workerName}.${accountSubdomain}.workers.dev`;
        }
      } catch (error) {
        // Could not determine URL
      }
    }

    // Update HTML with Worker URL if found
    if (workerUrl) {
      const htmlPath = path.join(codebasePath, 'public_page', 'index.html');
      if (fs.existsSync(htmlPath)) {
        try {
          let htmlContent = fs.readFileSync(htmlPath, 'utf8');
          const urlPattern = /const WORKER_URL = ['"](.*?)['"]/;
          if (urlPattern.test(htmlContent)) {
            htmlContent = htmlContent.replace(urlPattern, `const WORKER_URL = '${workerUrl}'`);
            fs.writeFileSync(htmlPath, htmlContent, 'utf8');
          }
        } catch (error) {
          // Non-fatal
        }
      }
    }

    return workerUrl;
  }

  async deployPages(codebasePath, pagesProjectName) {
    const publicPageDir = path.join(codebasePath, 'public_page');
    if (!fs.existsSync(publicPageDir)) {
      return null;
    }

    try {
      const result = await this.commandRunner.execute(
        `wrangler pages deploy ${publicPageDir} --project-name=${pagesProjectName} --branch=main --commit-dirty=true`,
        {
          cwd: codebasePath,
          silent: false,
          throwOnError: false,
          timeout: 300000 // 5 minutes
        }
      );

      if (!result.success) {
        throw new Error(result.error || 'Pages deployment failed');
      }

      // Wait a moment for deployment to register
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Try to get Pages URL
      let pagesUrl = '';
      try {
        const deployments = execSync(
          `wrangler pages deployment list --project-name=${pagesProjectName} --environment=production --json`,
          {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 10000,
            cwd: codebasePath
          }
        );

        if (deployments) {
          try {
            const deploymentList = JSON.parse(deployments);
            if (deploymentList && deploymentList.length > 0) {
              const latestDeployment = deploymentList[0];
              if (latestDeployment && latestDeployment.deployment) {
                pagesUrl = latestDeployment.deployment;
              }
            }
          } catch (parseError) {
            const urlMatch = deployments.match(/https:\/\/[^\s]+\.pages\.dev/);
            if (urlMatch) {
              pagesUrl = urlMatch[0];
            }
          }
        }
      } catch (error) {
        // Could not determine URL
      }

      return pagesUrl;
    } catch (error) {
      // Pages deployment is non-critical
      return null;
    }
  }
}

module.exports = new DeploymentEngine();

