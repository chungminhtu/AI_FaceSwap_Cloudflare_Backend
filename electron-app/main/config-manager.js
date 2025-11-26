const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');

class ConfigManager {
  constructor() {
    // Store SQLite database in user's app data directory
    const userDataPath = app.getPath('userData');
    this.dbPath = path.join(userDataPath, 'electron-config.db');
    this.db = null;
    this.initDatabase();
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
  }

  getDefaultConfig() {
    return {
      codebasePath: process.cwd(),
      deployments: []
    };
  }

  read() {
    try {
      // Read codebase path from config table
      const codebasePathStmt = this.db.prepare('SELECT value FROM electron_config WHERE key = ?');
      let codebasePath = process.cwd();

      const codebaseResult = codebasePathStmt.get('codebasePath');
      if (codebaseResult) {
        codebasePath = codebaseResult.value;
      } else {
        // Set default if not exists
        this.setConfigValue('codebasePath', codebasePath);
      }

      // Read form draft
      let formDraft = null;
      const formDraftResult = codebasePathStmt.get('formDraft');
      if (formDraftResult) {
        try {
          formDraft = JSON.parse(formDraftResult.value);
        } catch (e) {
          console.warn('[ConfigManager] Failed to parse form draft:', e);
        }
      }

      // Read deployments
      const deploymentsStmt = this.db.prepare(`
        SELECT
          d.*,
          GROUP_CONCAT(ds.secret_key || ':' || ds.secret_value, '|') as secrets_json
        FROM deployments d
        LEFT JOIN deployment_secrets ds ON d.id = ds.deployment_id
        GROUP BY d.id
        ORDER BY d.created_at DESC
      `);

      const deploymentRows = deploymentsStmt.all();
      const deployments = deploymentRows.map(row => {
        const deployment = {
          id: row.id,
          name: row.name,
          status: row.status || 'idle',
          gcp: {
            projectId: row.gcp_project_id,
            accountEmail: row.gcp_account_email
          },
          cloudflare: {
            accountId: row.cf_account_id,
            email: row.cf_email
          },
          workerName: row.worker_name,
          pagesProjectName: row.pages_project_name
        };

        // Parse secrets
        if (row.secrets_json) {
          const secrets = {};
          row.secrets_json.split('|').forEach(pair => {
            const [key, value] = pair.split(':', 2);
            if (key && value) {
              secrets[key] = value;
            }
          });
          deployment.secrets = secrets;
        } else {
          deployment.secrets = {};
        }

        // Load history if exists
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

      return {
        codebasePath,
        deployments,
        formDraft
      };
    } catch (error) {
      console.error('Error reading config from SQLite:', error);
      const defaultConfig = this.getDefaultConfig();
      this.write(defaultConfig);
      return defaultConfig;
    }
  }

  write(config) {
    try {
      // Validate before writing
      const validation = this.validate(config);
      if (!validation.valid) {
        throw new Error(`Invalid config: ${validation.error}`);
      }

      // Begin transaction
      const transaction = this.db.transaction(() => {
        // Write codebase path
        this.setConfigValue('codebasePath', config.codebasePath);

        // Write form draft if present
        if (config.formDraft) {
          this.setConfigValue('formDraft', config.formDraft);
        }

        // Clear existing deployments (we'll re-insert)
        this.db.prepare('DELETE FROM deployments').run();
        this.db.prepare('DELETE FROM deployment_secrets').run();

        // Write deployments
        const insertDeploymentStmt = this.db.prepare(`
          INSERT INTO deployments (
            id, name, gcp_project_id, gcp_account_email,
            cf_account_id, cf_email, worker_name, pages_project_name, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertSecretStmt = this.db.prepare(`
          INSERT INTO deployment_secrets (deployment_id, secret_key, secret_value)
          VALUES (?, ?, ?)
        `);

        for (const deployment of config.deployments) {
          insertDeploymentStmt.run(
            deployment.id,
            deployment.name,
            deployment.gcp?.projectId,
            deployment.gcp?.accountEmail,
            deployment.cloudflare?.accountId,
            deployment.cloudflare?.email,
            deployment.workerName,
            deployment.pagesProjectName,
            deployment.status || 'idle'
          );

          // Insert secrets
          if (deployment.secrets) {
            for (const [key, value] of Object.entries(deployment.secrets)) {
              insertSecretStmt.run(deployment.id, key, value);
            }
          }

          // Insert history if exists
          if (deployment.history && Array.isArray(deployment.history)) {
            for (const historyItem of deployment.history) {
              this.saveDeploymentHistory(deployment.id, historyItem);
            }
          }
        }
      });

      transaction();
      return { success: true };
    } catch (error) {
      console.error('Error writing config to SQLite:', error);
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

    if (!Array.isArray(config.deployments)) {
      return { valid: false, error: 'deployments must be an array' };
    }

    // Validate each deployment
    for (let i = 0; i < config.deployments.length; i++) {
      const deployment = config.deployments[i];
      const validation = this.validateDeployment(deployment);
      if (!validation.valid) {
        return { valid: false, error: `Deployment ${i}: ${validation.error}` };
      }
    }

    return { valid: true };
  }

  validateDeployment(deployment) {
    if (!deployment.id) {
      return { valid: false, error: 'Deployment must have an id' };
    }

    if (!deployment.name) {
      return { valid: false, error: 'Deployment must have a name' };
    }

    if (deployment.gcp && !deployment.gcp.projectId) {
      return { valid: false, error: 'GCP deployment must have projectId' };
    }

    if (deployment.secrets) {
      const requiredSecrets = [
        'RAPIDAPI_KEY',
        'RAPIDAPI_HOST',
        'RAPIDAPI_ENDPOINT',
        'GOOGLE_VISION_API_KEY',
        'GOOGLE_GEMINI_API_KEY',
        'GOOGLE_PROJECT_ID',
        'GOOGLE_GEMINI_ENDPOINT',
        'GOOGLE_SERVICE_ACCOUNT_EMAIL',
        'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
        'GOOGLE_VISION_ENDPOINT'
      ];

      for (const secret of requiredSecrets) {
        const value = deployment.secrets[secret];
        if (value === undefined || value === null || value === '') {
          return { valid: false, error: `Missing required secret: ${secret}` };
        }
        if (typeof value !== 'string') {
          return { valid: false, error: `Secret ${secret} must be a string` };
        }
      }
    }

    return { valid: true };
  }

  getConfigPath() {
    return this.dbPath;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = new ConfigManager();

