const { execSync, spawn } = require('child_process');

class CommandRunner {
  constructor(maxRetries = 3, retryDelay = 1000) {
    this.maxRetries = maxRetries;
    this.baseRetryDelay = retryDelay;
  }

  // Check if error is a network error
  isNetworkError(error) {
    const networkErrorKeywords = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'network',
      'timeout',
      'connection',
      'ECONNREFUSED',
      'socket hang up'
    ];

    const errorMessage = (error.message || '').toLowerCase();
    const errorCode = (error.code || '').toUpperCase();

    return networkErrorKeywords.some(keyword => 
      errorMessage.includes(keyword.toLowerCase()) || 
      errorCode.includes(keyword.toUpperCase())
    );
  }

  // Execute command with retry logic
  async execute(command, options = {}) {
    const {
      silent = false,
      throwOnError = true,
      retries = this.maxRetries,
      retryDelay = this.baseRetryDelay
    } = options;

    let lastError;
    let attempt = 0;

    while (attempt <= retries) {
      try {
        const output = execSync(command, {
          encoding: 'utf8',
          stdio: silent ? 'pipe' : 'inherit',
          timeout: options.timeout || 60000,
          cwd: options.cwd,
          env: options.env || process.env
        });

        return {
          success: true,
          output: output,
          attempt: attempt + 1
        };
      } catch (error) {
        lastError = error;

        // If not a network error or no retries left, throw immediately
        if (!this.isNetworkError(error) || attempt >= retries) {
          if (throwOnError) {
            throw error;
          }
          return {
            success: false,
            error: error.message,
            stderr: error.stderr?.toString(),
            stdout: error.stdout?.toString(),
            attempt: attempt + 1
          };
        }

        // Wait before retrying (exponential backoff)
        const delay = retryDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
      }
    }

    if (throwOnError) {
      throw lastError;
    }

    return {
      success: false,
      error: lastError?.message || 'Command failed',
      stderr: lastError?.stderr?.toString(),
      stdout: lastError?.stdout?.toString(),
      attempt: attempt + 1
    };
  }

  // Execute command with spawn (for interactive commands)
  async executeInteractive(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, {
        stdio: options.stdio || 'inherit',
        shell: true,
        cwd: options.cwd,
        env: options.env || process.env
      });

      let stdout = '';
      let stderr = '';

      if (options.captureOutput) {
        process.stdout?.on('data', (data) => {
          stdout += data.toString();
        });

        process.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
      }

      process.on('close', (code) => {
        if (code === 0) {
          resolve({
            success: true,
            code: 0,
            stdout: stdout,
            stderr: stderr
          });
        } else {
          const error = new Error(`Command exited with code ${code}`);
          error.code = code;
          error.stdout = stdout;
          error.stderr = stderr;
          
          if (options.throwOnError !== false) {
            reject(error);
          } else {
            resolve({
              success: false,
              code: code,
              error: error.message,
              stdout: stdout,
              stderr: stderr
            });
          }
        }
      });

      process.on('error', (error) => {
        if (options.throwOnError !== false) {
          reject(error);
        } else {
          resolve({
            success: false,
            error: error.message,
            stdout: stdout,
            stderr: stderr
          });
        }
      });
    });
  }
}

module.exports = CommandRunner;

