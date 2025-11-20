const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CommandRunner = require('./command-runner');
const AccountSwitcher = require('./account-switcher');
const setupGoogleCloud = require('../../setup-google-cloud.js');

class DeploymentEngine {
  constructor() {
    this.commandRunner = new CommandRunner(3, 1000);
    this.reportProgress = null;
    this.currentDeploymentId = null;
    this.currentStep = null;
    this.deploymentLogs = []; // Store all deployment steps and logs
  }

  async executeWithLogs(command, cwd, step) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        cwd: cwd,
        env: process.env
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        
        // Write to terminal (Electron CLI)
        process.stdout.write(output);
        
        // Send each line to UI
        const lines = output.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          if (this.reportProgress) {
            this.reportProgress(step, 'running', null, { 
              deploymentId: this.currentDeploymentId,
              step: step,
              log: line.trim()
            });
          }
        });
      });

      child.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        
        // Write to terminal (Electron CLI)
        process.stderr.write(output);
        
        // Send each line to UI (stderr often contains progress info)
        const lines = output.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          if (this.reportProgress) {
            this.reportProgress(step, 'running', null, {
              deploymentId: this.currentDeploymentId,
              step: step,
              log: line.trim()
            });
          }
        });
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, stdout, stderr });
        } else {
          reject(new Error(`Command exited with code ${code}\n${stderr}`));
        }
      });

      child.on('error', (error) => {
        reject(error);
      });
    });
  }

  async deploy(deployment, config, reportProgress) {
    // Reset deployment logs for this deployment
    this.deploymentLogs = [];
    const deploymentStartTime = new Date().toISOString();
    
    // Store callback for use in executeWithLogs
    this.reportProgress = (step, status, details, data) => {
      // Store in deployment history
      let existingStep = this.deploymentLogs.find(s => s.step === step);
      if (!existingStep) {
        existingStep = {
          step,
          status,
          details: details || '',
          logs: []
        };
        this.deploymentLogs.push(existingStep);
      } else {
        existingStep.status = status;
        if (details) existingStep.details = details;
      }
      
      // Add log line if present
      if (data && data.log) {
        existingStep.logs.push(data.log);
        // Pass log data directly
        reportProgress(step, status, details || '', data);
      } else {
        reportProgress(step, status, details || '');
      }
    };
    this.currentDeploymentId = deployment.id;
    
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
            skipPrompts: true,
            skipCloudflareSecret: true, // Secrets are handled separately in deploySecrets
            skipDocumentation: true // Don't generate docs during automated deployment
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
      
      // Save deployment history
      const deploymentHistory = {
        timestamp: deploymentStartTime,
        endTime: new Date().toISOString(),
        status: 'success',
        results,
        errors: errors.length > 0 ? errors : undefined,
        steps: this.deploymentLogs
      };
      
      return {
        success: true,
        results,
        errors: errors.length > 0 ? errors : undefined,
        history: deploymentHistory
      };
    } catch (error) {
      errors.push({ step: 'deployment', error: error.message, stack: error.stack });
      
      // Save deployment history even on failure
      const deploymentHistory = {
        timestamp: deploymentStartTime,
        endTime: new Date().toISOString(),
        status: 'failed',
        error: error.message,
        results,
        errors,
        steps: this.deploymentLogs
      };
      
      return {
        success: false,
        error: error.message,
        stack: error.stack,
        errors,
        results,
        history: deploymentHistory
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
      const listResult = await this.executeWithLogs('wrangler r2 bucket list', codebasePath, 'check-r2');
      const output = listResult.stdout || '';

      if (!output || !output.includes('faceswap-images')) {
        await this.executeWithLogs('wrangler r2 bucket create faceswap-images', codebasePath, 'check-r2');
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
          try {
            execSync(`wrangler d1 execute faceswap-db --remote --file=${schemaPath}`, {
              stdio: 'inherit',
              timeout: 30000,
              cwd: codebasePath
            });
          } catch (error) {
            // If schema fails, recreate database
            execSync('wrangler d1 delete faceswap-db', {
              stdio: 'inherit',
              timeout: 30000,
              cwd: codebasePath
            });
            execSync('wrangler d1 create faceswap-db', {
              stdio: 'inherit',
              timeout: 30000,
              cwd: codebasePath
            });
            execSync(`wrangler d1 execute faceswap-db --remote --file=${schemaPath}`, {
              stdio: 'inherit',
              timeout: 30000,
              cwd: codebasePath
            });
          }
        }
      } else {
        // Check schema completeness
        const schemaPath = path.join(codebasePath, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
          let needsSchemaUpdate = false;
          
          try {
            // Check for selfies table
            const selfiesCheck = execSync('wrangler d1 execute faceswap-db --remote --command="SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'selfies\';"', {
              encoding: 'utf8',
              stdio: 'pipe',
              timeout: 10000,
              cwd: codebasePath
            });
            
            if (!selfiesCheck || !selfiesCheck.includes('selfies')) {
              needsSchemaUpdate = true;
            } else {
              // Check if results table has selfie_id column
              try {
                const resultsCheck = execSync('wrangler d1 execute faceswap-db --remote --command="PRAGMA table_info(results);"', {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath
                });
                
                if (resultsCheck && !resultsCheck.includes('selfie_id')) {
                  needsSchemaUpdate = true;
                }
              } catch {
                // results table might not exist, that's OK - schema.sql will create it
                needsSchemaUpdate = true;
              }
            }
          } catch (error) {
            // Could not verify schema - will attempt to apply schema.sql
            needsSchemaUpdate = true;
          }
          
          if (needsSchemaUpdate) {
            try {
              // Apply schema.sql - it uses CREATE TABLE IF NOT EXISTS so it's safe
              execSync(`wrangler d1 execute faceswap-db --remote --file=${schemaPath}`, {
                stdio: 'inherit',
                timeout: 30000,
                cwd: codebasePath
              });
              
              // If results table exists but has wrong structure, fix it
              try {
                const resultsCheck = execSync('wrangler d1 execute faceswap-db --remote --command="PRAGMA table_info(results);"', {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath
                });
                
                if (resultsCheck && resultsCheck.includes('preset_collection_id') && !resultsCheck.includes('selfie_id')) {
                  // Check if results table has data
                  const countCheck = execSync('wrangler d1 execute faceswap-db --remote --command="SELECT COUNT(*) as count FROM results;"', {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 10000,
                    cwd: codebasePath
                  });
                  
                  const hasData = countCheck && countCheck.includes('"count":') && !countCheck.includes('"count":0');
                  
                  if (!hasData) {
                    // Safe to recreate - table is empty
                    execSync('wrangler d1 execute faceswap-db --remote --command="DROP TABLE IF EXISTS results;"', {
                      stdio: 'inherit',
                      timeout: 30000,
                      cwd: codebasePath
                    });
                    execSync('wrangler d1 execute faceswap-db --remote --command="CREATE TABLE results (id TEXT PRIMARY KEY, selfie_id TEXT NOT NULL, preset_collection_id TEXT NOT NULL, preset_image_id TEXT NOT NULL, preset_name TEXT NOT NULL, result_url TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (selfie_id) REFERENCES selfies(id), FOREIGN KEY (preset_collection_id) REFERENCES preset_collections(id), FOREIGN KEY (preset_image_id) REFERENCES preset_images(id));"', {
                      stdio: 'inherit',
                      timeout: 30000,
                      cwd: codebasePath
                    });
                  }
                }
              } catch (fixError) {
                // Could not auto-fix results table structure - non-fatal
              }
            } catch (error) {
              // Try to create missing selfies table if it doesn't exist
              try {
                const selfiesCheck = execSync('wrangler d1 execute faceswap-db --remote --command="SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'selfies\';"', {
                  encoding: 'utf8',
                  stdio: 'pipe',
                  timeout: 10000,
                  cwd: codebasePath
                });
                
                if (!selfiesCheck || !selfiesCheck.includes('selfies')) {
                  execSync('wrangler d1 execute faceswap-db --remote --command="CREATE TABLE IF NOT EXISTS selfies (id TEXT PRIMARY KEY, image_url TEXT NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));"', {
                    stdio: 'inherit',
                    timeout: 30000,
                    cwd: codebasePath
                  });
                }
              } catch (createError) {
                // Failed to create selfies table - non-fatal, will be caught below
              }
              
              // Re-throw if it's a critical error
              if (!error.message.includes('already exists') && !error.message.includes('no such table')) {
                throw error;
              }
            }
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
        await this.executeWithLogs(`wrangler r2 bucket cors set faceswap-images --file=${corsPath}`, codebasePath, 'configure-cors');
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
      const result = await this.executeWithLogs(
        'wrangler secret bulk temp-secrets.json',
        codebasePath,
        'deploy-secrets'
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
    const result = await this.executeWithLogs('wrangler deploy', codebasePath, 'deploy-worker');

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
      const result = await this.executeWithLogs(
        `wrangler pages deploy ${publicPageDir} --project-name=${pagesProjectName} --branch=main --commit-dirty=true`,
        codebasePath,
        'deploy-pages'
      );

      if (!result.success) {
        throw new Error(result.error || 'Pages deployment failed');
      }

      // Construct the Pages domain from project name
      return `https://${pagesProjectName}.pages.dev/`;
    } catch (error) {
      // Pages deployment is non-critical
      return null;
    }
  }
}

module.exports = new DeploymentEngine();

