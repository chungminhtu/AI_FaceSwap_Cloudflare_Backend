const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');

class ConfigManager {
  constructor() {
    // Store SQLite database in electron-app folder
    // __dirname is electron-app/main, so go up one level to electron-app
    const electronAppPath = path.resolve(__dirname, '..');
    this.dbPath = path.join(electronAppPath, 'electron-config.db');
    this.db = null;
    this.initDatabase();
    
    // secrets.json path must be in project root (same as CLI uses)
    // __dirname is electron-app/main, so go up two levels to project root
    const projectRoot = path.resolve(__dirname, '../..');
    this.secretsPath = path.join(projectRoot, 'secrets.json');
  }

  initDatabase() {
    try {
      // Create database connection
      this.db = new Database(this.dbPath);

      // Enable foreign keys and WAL mode for better performance
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');

      // Initialize schema
      this.initSchema();

      console.log('[ConfigManager] SQLite database initialized at:', this.dbPath);
    } catch (error) {
      console.error('[ConfigManager] Failed to initialize database:', error);
      throw error;
    }
  }

  initSchema() {
    const schema = `
      -- Electron app configuration tables
      CREATE TABLE IF NOT EXISTS electron_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        gcp_project_id TEXT,
        gcp_account_email TEXT,
        cf_account_id TEXT,
        cf_email TEXT,
        worker_name TEXT,
        pages_project_name TEXT,
        database_name TEXT,
        bucket_name TEXT,
        status TEXT DEFAULT 'idle',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS deployment_secrets (
        deployment_id TEXT NOT NULL,
        secret_key TEXT NOT NULL,
        secret_value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (deployment_id, secret_key),
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS deployment_history (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        end_time INTEGER,
        status TEXT NOT NULL,
        error_message TEXT,
        worker_url TEXT,
        pages_url TEXT,
        history_data TEXT,
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
      );

      -- Indexes for electron app tables
      CREATE INDEX IF NOT EXISTS idx_electron_config_key ON electron_config(key);
      CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
      CREATE INDEX IF NOT EXISTS idx_deployments_created_at ON deployments(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deployment_secrets_deployment_id ON deployment_secrets(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_deployment_history_deployment_id ON deployment_history(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_deployment_history_timestamp ON deployment_history(timestamp DESC);
    `;

    this.db.exec(schema);

    // Migrate existing database: add missing columns if they don't exist
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(deployments)").all();
      const columnNames = tableInfo.map(col => col.name);
      
      if (!columnNames.includes('database_name')) {
        this.db.exec('ALTER TABLE deployments ADD COLUMN database_name TEXT');
        console.log('[ConfigManager] Added database_name column to deployments table');
      }
      
      if (!columnNames.includes('bucket_name')) {
        this.db.exec('ALTER TABLE deployments ADD COLUMN bucket_name TEXT');
        console.log('[ConfigManager] Added bucket_name column to deployments table');
      }
    } catch (migrationError) {
      console.warn('[ConfigManager] Migration error (non-fatal):', migrationError.message);
    }
  }

  getDefaultConfig() {
    return {
      codebasePath: process.cwd(),
      deployments: []
    };
  }

  // Read secrets.json (same format as CLI)
  readSecretsFile() {
    try {
      if (!fs.existsSync(this.secretsPath)) {
        return null;
      }
      const content = fs.readFileSync(this.secretsPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      console.error('[ConfigManager] Error reading secrets.json:', error);
      return null;
    }
  }

  // Write secrets.json (same format as CLI)
  writeSecretsFile(config) {
    try {
      // Convert to flat format for secrets.json
      const flatConfig = {
        workerName: config.workerName,
        pagesProjectName: config.pagesProjectName,
        databaseName: config.databaseName,
        bucketName: config.bucketName,
        RAPIDAPI_KEY: config.RAPIDAPI_KEY || config.secrets?.RAPIDAPI_KEY,
        RAPIDAPI_HOST: config.RAPIDAPI_HOST || config.secrets?.RAPIDAPI_HOST,
        RAPIDAPI_ENDPOINT: config.RAPIDAPI_ENDPOINT || config.secrets?.RAPIDAPI_ENDPOINT,
        GOOGLE_VISION_API_KEY: config.GOOGLE_VISION_API_KEY || config.secrets?.GOOGLE_VISION_API_KEY,
        GOOGLE_VERTEX_PROJECT_ID: config.GOOGLE_VERTEX_PROJECT_ID || config.secrets?.GOOGLE_VERTEX_PROJECT_ID,
        GOOGLE_VERTEX_LOCATION: config.GOOGLE_VERTEX_LOCATION || config.secrets?.GOOGLE_VERTEX_LOCATION || 'us-central1',
        GOOGLE_VERTEX_API_KEY: config.GOOGLE_VERTEX_API_KEY || config.secrets?.GOOGLE_VERTEX_API_KEY,
        GOOGLE_VISION_ENDPOINT: config.GOOGLE_VISION_ENDPOINT || config.secrets?.GOOGLE_VISION_ENDPOINT
      };

      // Remove undefined values
      Object.keys(flatConfig).forEach(key => {
        if (flatConfig[key] === undefined) {
          delete flatConfig[key];
        }
      });

      fs.writeFileSync(this.secretsPath, JSON.stringify(flatConfig, null, 2), 'utf8');
      return { success: true };
    } catch (error) {
      console.error('[ConfigManager] Error writing secrets.json:', error);
      return { success: false, error: error.message };
    }
  }

  read() {
    try {
      // Read codebase path from SQLite (UI state only)
      const codebasePathStmt = this.db.prepare('SELECT value FROM electron_config WHERE key = ?');
      let codebasePath = process.cwd();

      const codebaseResult = codebasePathStmt.get('codebasePath');
      if (codebaseResult) {
        codebasePath = JSON.parse(codebaseResult.value);
      } else {
        // Set default if not exists
        this.setConfigValue('codebasePath', codebasePath);
      }

      // Read form draft from SQLite (UI state only)
      let formDraft = null;
      const formDraftResult = codebasePathStmt.get('formDraft');
      if (formDraftResult) {
        try {
          formDraft = JSON.parse(formDraftResult.value);
        } catch (e) {
          console.warn('[ConfigManager] Failed to parse form draft:', e);
        }
      }

      // Read deployment config from secrets.json (same as CLI)
      const secretsConfig = this.readSecretsFile();
      let deployment = null;

      if (secretsConfig) {
        // Convert flat secrets.json to deployment object
        // NO DEFAULT VALUES - if name is missing, deployment will be null
        if (!secretsConfig.name || secretsConfig.name.trim() === '') {
          console.warn('[ConfigManager] secrets.json has no name, skipping deployment');
          deployment = null;
        } else {
          deployment = {
            id: 'secrets-json-deployment',
            name: secretsConfig.name,
            status: 'idle',
            workerName: secretsConfig.workerName,
            pagesProjectName: secretsConfig.pagesProjectName,
            databaseName: secretsConfig.databaseName,
            bucketName: secretsConfig.bucketName,
            secrets: {
              RAPIDAPI_KEY: secretsConfig.RAPIDAPI_KEY,
              RAPIDAPI_HOST: secretsConfig.RAPIDAPI_HOST,
              RAPIDAPI_ENDPOINT: secretsConfig.RAPIDAPI_ENDPOINT,
              GOOGLE_VISION_API_KEY: secretsConfig.GOOGLE_VISION_API_KEY,
              GOOGLE_GEMINI_API_KEY: secretsConfig.GOOGLE_GEMINI_API_KEY,
              GOOGLE_VISION_ENDPOINT: secretsConfig.GOOGLE_VISION_ENDPOINT
            }
          };

          // Load history from SQLite if exists
          const historyStmt = this.db.prepare(`
            SELECT * FROM deployment_history
            WHERE deployment_id = ?
            ORDER BY timestamp DESC
            LIMIT 50
          `);
          const historyRows = historyStmt.all(deployment.id);
          if (historyRows.length > 0) {
            deployment.history = historyRows.map(h => ({
              id: h.id,
              timestamp: h.timestamp,
              endTime: h.end_time,
              status: h.status,
              error: h.error_message,
              results: {
                workerUrl: h.worker_url,
                pagesUrl: h.pages_url
              },
              ...JSON.parse(h.history_data || '{}')
            }));
          }
        }
      }

      // Read deployments from SQLite (with full nested structure)
      const deploymentsStmt = this.db.prepare('SELECT * FROM deployments ORDER BY created_at DESC');
      const deploymentRows = deploymentsStmt.all();
      
      let deployments = [];
      if (deploymentRows.length > 0) {
        // Load deployments from SQLite with their full structure
        deployments = deploymentRows.map(row => {
          const deployment = {
            id: row.id,
            name: row.name,
            status: row.status || 'idle',
            workerName: row.worker_name,
            pagesProjectName: row.pages_project_name,
            databaseName: row.database_name,
            bucketName: row.bucket_name,
            gcp: {
              projectId: row.gcp_project_id || null,
              accountEmail: row.gcp_account_email || null
            },
            cloudflare: {
              accountId: row.cf_account_id || null,
              email: row.cf_email || null
            }
          };
          
          console.log('[ConfigManager] Loaded deployment from SQLite:', {
            id: deployment.id,
            name: deployment.name,
            gcp: deployment.gcp,
            cloudflare: deployment.cloudflare
          });

          // Load secrets from deployment_secrets table
          const secretsStmt = this.db.prepare('SELECT secret_key, secret_value FROM deployment_secrets WHERE deployment_id = ?');
          const secretsRows = secretsStmt.all(row.id);
          if (secretsRows.length > 0) {
            secretsRows.forEach(secret => {
              deployment[secret.secret_key] = secret.secret_value;
            });
          }

          // Load history
          const historyStmt = this.db.prepare(`
            SELECT * FROM deployment_history
            WHERE deployment_id = ?
            ORDER BY timestamp DESC
            LIMIT 50
          `);
          const historyRows = historyStmt.all(row.id);
          if (historyRows.length > 0) {
            deployment.history = historyRows.map(h => ({
              id: h.id,
              timestamp: h.timestamp,
              endTime: h.end_time,
              status: h.status,
              error: h.error_message,
              results: {
                workerUrl: h.worker_url,
                pagesUrl: h.pages_url
              },
              ...JSON.parse(h.history_data || '{}')
            }));
      }

          return deployment;
        });
      } else if (deployment) {
        // Fallback: use deployment from secrets.json if no SQLite deployments
        deployments = [deployment];
      }

      return {
        codebasePath,
        deployments,
        formDraft
      };
    } catch (error) {
      console.error('Error reading config:', error);
      const defaultConfig = this.getDefaultConfig();
      return defaultConfig;
    }
  }

  write(config) {
    try {
      console.log('[ConfigManager.write] Starting write, deployments count:', config?.deployments?.length || 0);

      // Validate before writing
      const validation = this.validate(config);
      if (!validation.valid) {
        console.error('[ConfigManager.write] Validation failed:', validation.error);
        throw new Error(`Invalid config: ${validation.error}`);
      }

      console.log('[ConfigManager.write] Validation passed');

      // Write UI state to SQLite (codebase path, form draft)
      const transaction = this.db.transaction(() => {
        // Write codebase path
        if (config.codebasePath !== undefined) {
          this.setConfigValue('codebasePath', config.codebasePath);
        }

        // Write form draft if present (or clear it if explicitly set to null)
        if (config.formDraft !== undefined) {
          if (config.formDraft === null) {
            // Clear form draft
            const deleteStmt = this.db.prepare('DELETE FROM electron_config WHERE key = ?');
            deleteStmt.run('formDraft');
          } else {
            this.setConfigValue('formDraft', config.formDraft);
          }
        }
      });
      transaction();

      // Write deployments to SQLite (with full nested structure)
      // First, get all current deployment IDs from SQLite
      const currentDeploymentIds = new Set();
      const allDeploymentsStmt = this.db.prepare('SELECT id FROM deployments');
      const allDeployments = allDeploymentsStmt.all();
      allDeployments.forEach(row => currentDeploymentIds.add(row.id));
      
      console.log('[ConfigManager] Current deployments in SQLite:', Array.from(currentDeploymentIds));
      
      // Get IDs of deployments that should exist
      const configDeploymentIds = new Set();
      if (config.deployments && config.deployments.length > 0) {
        config.deployments.forEach(d => {
          if (d.id) configDeploymentIds.add(d.id);
        });
      }
      
      console.log('[ConfigManager] Deployments in config:', Array.from(configDeploymentIds));
      
      // Delete deployments that are no longer in config
      const deploymentsToDelete = Array.from(currentDeploymentIds).filter(id => !configDeploymentIds.has(id));
      console.log('[ConfigManager] Deployments to delete:', deploymentsToDelete);
      
      if (deploymentsToDelete.length > 0) {
        const deleteTransaction = this.db.transaction(() => {
          for (const deploymentId of deploymentsToDelete) {
            console.log('[ConfigManager] Deleting deployment from SQLite:', deploymentId);
            
            // Delete secrets first (foreign key constraint)
            const deleteSecretsStmt = this.db.prepare('DELETE FROM deployment_secrets WHERE deployment_id = ?');
            const secretsResult = deleteSecretsStmt.run(deploymentId);
            console.log(`[ConfigManager] Deleted ${secretsResult.changes} secrets for deployment ${deploymentId}`);
            
            // Delete history
            const deleteHistoryStmt = this.db.prepare('DELETE FROM deployment_history WHERE deployment_id = ?');
            const historyResult = deleteHistoryStmt.run(deploymentId);
            console.log(`[ConfigManager] Deleted ${historyResult.changes} history records for deployment ${deploymentId}`);
            
            // Delete deployment
            const deleteDeploymentStmt = this.db.prepare('DELETE FROM deployments WHERE id = ?');
            const deploymentResult = deleteDeploymentStmt.run(deploymentId);
            console.log(`[ConfigManager] Deleted deployment ${deploymentId}: ${deploymentResult.changes} row(s) affected`);
            
            if (deploymentResult.changes === 0) {
              console.warn(`[ConfigManager] WARNING: No rows deleted for deployment ${deploymentId}`);
            }
          }
        });
        deleteTransaction();
        console.log(`[ConfigManager] Successfully deleted ${deploymentsToDelete.length} deployment(s) from SQLite`);
        
        // Verify deletion by checking database again
        const verifyStmt = this.db.prepare('SELECT id FROM deployments WHERE id IN (' + deploymentsToDelete.map(() => '?').join(',') + ')');
        const remaining = verifyStmt.all(...deploymentsToDelete);
        if (remaining.length > 0) {
          console.error(`[ConfigManager] ERROR: ${remaining.length} deployment(s) still exist after deletion:`, remaining.map(r => r.id));
        } else {
          console.log('[ConfigManager] Verification: All deployments successfully deleted from SQLite');
        }
      } else {
        console.log('[ConfigManager] No deployments to delete');
      }
      
      // Now save/update deployments that are in config
      if (config.deployments && config.deployments.length > 0) {
        const transaction = this.db.transaction(() => {
          for (const deployment of config.deployments) {
            // Save deployment to SQLite
            const deploymentStmt = this.db.prepare(`
              INSERT OR REPLACE INTO deployments (
                id, name, gcp_project_id, gcp_account_email,
                cf_account_id, cf_email, worker_name, pages_project_name,
                database_name, bucket_name, status, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
            `);
            
            // Extract values with proper null handling
            const gcpProjectId = deployment.gcp?.projectId?.trim() || null;
            const gcpAccountEmail = deployment.gcp?.accountEmail?.trim() || null;
            const cfAccountId = deployment.cloudflare?.accountId?.trim() || null;
            const cfEmail = deployment.cloudflare?.email?.trim() || null;
            
            console.log('[ConfigManager] Saving deployment to SQLite:', {
              id: deployment.id,
              name: deployment.name,
              gcpProjectId,
              gcpAccountEmail,
              cfAccountId,
              cfEmail
            });
            
            // Validate required fields - NO DEFAULTS
            if (!deployment.id || deployment.id.trim() === '') {
              throw new Error('Deployment ID is required');
            }
            if (!deployment.name || deployment.name.trim() === '') {
              throw new Error('Deployment name is required');
            }
            
            deploymentStmt.run(
              deployment.id,
              deployment.name,
              gcpProjectId,
              gcpAccountEmail,
              cfAccountId,
              cfEmail,
              deployment.workerName || null,
              deployment.pagesProjectName || null,
              deployment.databaseName || null,
              deployment.bucketName || null,
              deployment.status || 'idle'
            );

            // Save secrets to deployment_secrets table
            const deleteSecretsStmt = this.db.prepare('DELETE FROM deployment_secrets WHERE deployment_id = ?');
            deleteSecretsStmt.run(deployment.id);

            const secretKeys = [
              'RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT',
              'GOOGLE_VISION_API_KEY', 'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION',
              'GOOGLE_VERTEX_API_KEY', 'GOOGLE_VISION_ENDPOINT'
            ];

            const insertSecretStmt = this.db.prepare(`
              INSERT INTO deployment_secrets (deployment_id, secret_key, secret_value, updated_at)
              VALUES (?, ?, ?, unixepoch())
            `);

            for (const key of secretKeys) {
              const value = deployment[key] || deployment.secrets?.[key];
              if (value) {
                insertSecretStmt.run(deployment.id, key, value);
              }
            }

            // Save history to SQLite
            if (deployment.history && Array.isArray(deployment.history)) {
              const deploymentId = deployment.id || 'secrets-json-deployment';
              for (const historyItem of deployment.history) {
                this.saveDeploymentHistory(deploymentId, historyItem);
              }
            }
          }
        });
        transaction();

        // Also write first deployment to secrets.json (for CLI compatibility)
        // Only write if there's at least one deployment with required fields
        if (config.deployments && config.deployments.length > 0) {
          const firstDeployment = config.deployments[0];
          // Only write if deployment has basic required fields
          if (firstDeployment && firstDeployment.workerName && firstDeployment.pagesProjectName) {
            const writeResult = this.writeSecretsFile(firstDeployment);
            if (!writeResult.success) {
              console.warn('[ConfigManager] Failed to write secrets.json:', writeResult.error);
              // Don't fail - SQLite save was successful
            }
          } else {
            console.log('[ConfigManager] Skipping secrets.json write - first deployment incomplete');
          }
        } else {
          console.log('[ConfigManager] No deployments to write to secrets.json');
        }
      }

      console.log('[ConfigManager.write] Write completed successfully');
      return { success: true };
    } catch (error) {
      console.error('[ConfigManager.write] Error writing config:', error);
      return { success: false, error: error.message };
    }
  }

  // Save a single deployment to secrets.json
  saveDeployment(deployment) {
    try {
      // Validate deployment
      const validation = this.validateDeployment(deployment);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      // Write to secrets.json
      return this.writeSecretsFile(deployment);
    } catch (error) {
      console.error('Error saving deployment:', error);
      return { success: false, error: error.message };
    }
  }

  setConfigValue(key, value) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO electron_config (key, value, updated_at)
      VALUES (?, ?, unixepoch())
    `);
    stmt.run(key, JSON.stringify(value));
  }

  getConfigValue(key) {
    const stmt = this.db.prepare('SELECT value FROM electron_config WHERE key = ?');
    const result = stmt.get(key);
    return result ? JSON.parse(result.value) : null;
  }

  saveDeploymentHistory(deploymentId, historyItem) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO deployment_history (
        id, deployment_id, timestamp, end_time, status, error_message,
        worker_url, pages_url, history_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      historyItem.id || `${deploymentId}-${historyItem.timestamp}`,
      deploymentId,
      historyItem.timestamp,
      historyItem.endTime,
      historyItem.status,
      historyItem.error,
      historyItem.results?.workerUrl,
      historyItem.results?.pagesUrl,
      JSON.stringify(historyItem)
    );
  }

  validate(config) {
    if (!config || typeof config !== 'object') {
      return { valid: false, error: 'Config must be an object' };
    }

    // Ensure deployments is always an array (can be empty)
    if (!Array.isArray(config.deployments)) {
      // If deployments is missing or invalid, make it an empty array
      config.deployments = [];
    }

    // For UI state saves, only validate basic structure (id, name)
    // Full secrets validation happens in saveDeployment() for secrets.json
    // Empty array is valid (allows deleting all deployments)
    for (let i = 0; i < config.deployments.length; i++) {
      const deployment = config.deployments[i];
      
      // Skip null/undefined deployments
      if (!deployment || typeof deployment !== 'object') {
        continue;
      }
      
      // Basic validation: must have id and name
      if (!deployment.id || typeof deployment.id !== 'string' || deployment.id.trim() === '') {
        return { valid: false, error: `Deployment ${i}: Missing or invalid id` };
      }
      if (!deployment.name || typeof deployment.name !== 'string' || deployment.name.trim() === '') {
        return { valid: false, error: `Deployment ${i}: Missing or invalid name` };
      }
    }

    return { valid: true };
  }

  validateDeployment(deployment) {
    // For secrets.json format, we need these fields
    const requiredFields = [
      'workerName', 'pagesProjectName', 'databaseName', 'bucketName',
      'RAPIDAPI_KEY', 'RAPIDAPI_HOST', 'RAPIDAPI_ENDPOINT',
      'GOOGLE_VISION_API_KEY', 'GOOGLE_VERTEX_PROJECT_ID', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_VERTEX_API_KEY', 'GOOGLE_VISION_ENDPOINT'
      ];

    // Check if secrets are in flat format or nested
    const secrets = deployment.secrets || deployment;
    
    for (const field of requiredFields) {
      const value = deployment[field] || secrets[field];
        if (value === undefined || value === null || value === '') {
        return { valid: false, error: `Missing required field: ${field}` };
        }
        if (typeof value !== 'string') {
        return { valid: false, error: `Field ${field} must be a string` };
      }
    }

    return { valid: true };
  }

  getConfigPath() {
    return this.dbPath;
  }

  getSecretsPath() {
    return this.secretsPath;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = new ConfigManager();

