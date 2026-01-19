const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class R2Manager {
  constructor(config) {
    this.config = config;
    this.rcloneConfig = null;
  }

  getRcloneConfig() {
    if (this.rcloneConfig && fs.existsSync(this.rcloneConfig.tempConfigPath)) {
      return this.rcloneConfig;
    }
    const endpoint = `https://${this.config.accountId}.r2.cloudflarestorage.com`;
    const tempConfigPath = path.join(os.tmpdir(), `rclone-${Date.now()}.conf`);
    fs.writeFileSync(tempConfigPath, `[r2]
type = s3
provider = Cloudflare
access_key_id = ${this.config.r2AccessKeyId}
secret_access_key = ${this.config.r2SecretAccessKey}
endpoint = ${endpoint}
`);
    this.rcloneConfig = { remoteName: 'r2', tempConfigPath, baseArgs: ['--config', tempConfigPath] };
    return this.rcloneConfig;
  }

  async list(folderPath = '') {
    return new Promise((resolve, reject) => {
      const config = this.getRcloneConfig();
      const { remoteName, baseArgs } = config;
      const remotePath = folderPath ? `${remoteName}:${this.config.bucketName}/${folderPath}` : `${remoteName}:${this.config.bucketName}`;
      
      const foldersPromise = new Promise((foldersResolve, foldersReject) => {
        const rclone = spawn('rclone', [...baseArgs, 'lsf', '--dirs-only', '-R', remotePath], { stdio: 'pipe' });
        let stdout = '', stderr = '';
        rclone.stdout.on('data', d => stdout += d.toString());
        rclone.stderr.on('data', d => stderr += d.toString());
        rclone.on('close', code => {
          if (code === 0 || stderr.includes('directory not found')) {
            const folders = stdout.split('\n').filter(f => f.trim()).map(f => {
              if (!folderPath) return f.startsWith('/') ? f.slice(1) : f;
              const base = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
              return f.startsWith('/') ? `${base}${f}` : `${base}/${f}`;
            }).filter(f => {
              const last = f.split('/').pop();
              return !last.includes('.') || !/\.(webp|png|json|jpg|jpeg|gif|txt|pdf|zip)$/i.test(last);
            }).sort();
            foldersResolve(folders);
          } else {
            foldersReject(new Error(stderr));
          }
        });
        rclone.on('error', foldersReject);
      });
      
      const filesPromise = new Promise((filesResolve, filesReject) => {
        const rclone = spawn('rclone', [...baseArgs, 'lsjson', '-R', remotePath], { stdio: 'pipe' });
        let stdout = '', stderr = '';
        rclone.stdout.on('data', d => stdout += d.toString());
        rclone.stderr.on('data', d => stderr += d.toString());
        rclone.on('close', code => {
          if (code === 0 || stderr.includes('directory not found')) {
            const files = [];
            try {
              const lines = stdout.trim().split('\n').filter(line => line.trim());
              lines.forEach(line => {
                try {
                  const item = JSON.parse(line);
                  if (item.IsDir) return;
                  
                  let fullPath = item.Path || item.Name;
                  if (!folderPath) {
                    fullPath = fullPath.startsWith('/') ? fullPath.slice(1) : fullPath;
                  } else {
                    const base = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
                    fullPath = fullPath.startsWith('/') ? `${base}${fullPath}` : `${base}/${fullPath}`;
                  }
                  
                  const last = fullPath.split('/').pop();
                  if (last.includes('.') && /\.(webp|png|json|jpg|jpeg|gif|txt|pdf|zip)$/i.test(last)) {
                    files.push({
                      path: fullPath,
                      date: item.ModTime ? new Date(item.ModTime) : null,
                      size: item.Size || 0
                    });
                  }
                } catch (parseError) {
                  // Skip invalid JSON lines
                }
              });
            } catch (error) {
              // If parsing fails, return empty array
            }
            filesResolve(files);
          } else {
            filesReject(new Error(stderr));
          }
        });
        rclone.on('error', filesReject);
      });
      
      Promise.all([foldersPromise, filesPromise])
        .then(([folders, files]) => {
          resolve({ 
            folders: folders.map(f => ({ path: f, type: 'folder' })),
            files: files.map(f => ({ path: f.path, date: f.date, size: f.size, type: 'file' }))
          });
        })
        .catch(reject);
    });
  }

  async count(folderPath = '') {
    return new Promise((resolve, reject) => {
      const config = this.getRcloneConfig();
      const { remoteName, baseArgs } = config;
      const remotePath = folderPath ? `${remoteName}:${this.config.bucketName}/${folderPath}` : `${remoteName}:${this.config.bucketName}`;
      const rclone = spawn('rclone', [...baseArgs, 'size', remotePath], { stdio: 'pipe' });
      let stdout = '', stderr = '';
      rclone.stdout.on('data', d => stdout += d.toString());
      rclone.stderr.on('data', d => stderr += d.toString());
      rclone.on('close', code => {
        if (code === 0) {
          const match = stdout.match(/(\d+)\s+files/);
          resolve({ count: match ? parseInt(match[1], 10) : 0, output: stdout });
        } else {
          reject(new Error(stderr || 'Count failed'));
        }
      });
      rclone.on('error', reject);
    });
  }

  async deleteFiles(filePaths) {
    const results = [];
    for (const filePath of filePaths) {
      try {
        await this.deleteFile(filePath);
        results.push({ path: filePath, success: true });
      } catch (error) {
        results.push({ path: filePath, success: false, error: error.message });
      }
    }
    return results;
  }

  async deleteFile(filePath) {
    return new Promise((resolve, reject) => {
      const config = this.getRcloneConfig();
      const { remoteName, baseArgs } = config;
      const rclone = spawn('rclone', [...baseArgs, 'delete', `${remoteName}:${this.config.bucketName}/${filePath}`], { stdio: 'pipe' });
      let stderr = '';
      rclone.stderr.on('data', d => stderr += d.toString());
      rclone.on('close', code => {
        if (code === 0 || stderr.includes('not found')) {
          resolve({ success: true });
        } else {
          reject(new Error(stderr));
        }
      });
      rclone.on('error', reject);
    });
  }

  async deleteFolders(folderPaths) {
    const results = [];
    for (const folderPath of folderPaths) {
      try {
        await this.deleteFolder(folderPath);
        results.push({ path: folderPath, success: true });
      } catch (error) {
        results.push({ path: folderPath, success: false, error: error.message });
      }
    }
    return results;
  }

  async deleteFolder(folderPath) {
    return new Promise((resolve, reject) => {
      const config = this.getRcloneConfig();
      const { remoteName, baseArgs } = config;
      const folderPathClean = folderPath.replace(/\/$/, '');
      const remotePath = `${remoteName}:${this.config.bucketName}/${folderPathClean}`;
      const rclone = spawn('rclone', [...baseArgs, 'purge', '-P', remotePath], { stdio: 'pipe' });
      let stderr = '';
      rclone.stderr.on('data', d => stderr += d.toString());
      rclone.on('close', code => {
        if (code === 0 || stderr.includes('directory not found') || stderr.includes('is a file not a directory')) {
          resolve({ success: true });
        } else {
          reject(new Error(stderr));
        }
      });
      rclone.on('error', reject);
    });
  }

  async deleteWithWildcard(pattern) {
    return new Promise((resolve, reject) => {
      const config = this.getRcloneConfig();
      const { remoteName, baseArgs } = config;
      const remotePath = `${remoteName}:${this.config.bucketName}/${pattern}`;
      const rclone = spawn('rclone', [...baseArgs, 'delete', remotePath], { stdio: 'pipe' });
      let stderr = '';
      rclone.stderr.on('data', d => stderr += d.toString());
      rclone.on('close', code => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          reject(new Error(stderr));
        }
      });
      rclone.on('error', reject);
    });
  }

  async move(sourcePath, destPath) {
    return new Promise((resolve, reject) => {
      const config = this.getRcloneConfig();
      const { remoteName, baseArgs } = config;
      const source = `${remoteName}:${this.config.bucketName}/${sourcePath}`;
      const dest = `${remoteName}:${this.config.bucketName}/${destPath}`;
      const rclone = spawn('rclone', [...baseArgs, 'moveto', source, dest], { stdio: 'pipe' });
      let stderr = '';
      rclone.stderr.on('data', d => stderr += d.toString());
      rclone.on('close', code => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          reject(new Error(stderr));
        }
      });
      rclone.on('error', reject);
    });
  }

  async copy(sourcePath, destPath) {
    return new Promise((resolve, reject) => {
      const config = this.getRcloneConfig();
      const { remoteName, baseArgs } = config;
      const source = `${remoteName}:${this.config.bucketName}/${sourcePath}`;
      const dest = `${remoteName}:${this.config.bucketName}/${destPath}`;
      const rclone = spawn('rclone', [...baseArgs, 'copyto', source, dest], { stdio: 'pipe' });
      let stderr = '';
      rclone.stderr.on('data', d => stderr += d.toString());
      rclone.on('close', code => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          reject(new Error(stderr));
        }
      });
      rclone.on('error', reject);
    });
  }

  async getFileContent(filePath) {
    return new Promise((resolve, reject) => {
      const config = this.getRcloneConfig();
      const { remoteName, baseArgs } = config;
      const remotePath = `${remoteName}:${this.config.bucketName}/${filePath}`;
      const rclone = spawn('rclone', [...baseArgs, 'cat', remotePath], { stdio: 'pipe' });
      let stdout = '', stderr = '';
      rclone.stdout.on('data', d => stdout += d.toString());
      rclone.stderr.on('data', d => stderr += d.toString());
      rclone.on('close', code => {
        if (code === 0) {
          resolve({ content: stdout });
        } else {
          reject(new Error(stderr || 'Failed to read file'));
        }
      });
      rclone.on('error', reject);
    });
  }

  async getFileUrl(filePath) {
    return `https://${this.config.accountId}.r2.cloudflarestorage.com/${this.config.bucketName}/${filePath}`;
  }

  cleanup() {
    if (this.rcloneConfig && fs.existsSync(this.rcloneConfig.tempConfigPath)) {
      try {
        fs.unlinkSync(this.rcloneConfig.tempConfigPath);
      } catch {}
    }
  }
}

module.exports = R2Manager;
