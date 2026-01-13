#!/usr/bin/env node
const express = require('express');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = {
    accountId: 'd6bbe756fe7a10cc4982a882cd98c9c8',
    r2AccessKeyId: '7a2fdf3156f2195594313b9166de3879',
    r2SecretAccessKey: 'ddf6eb789cb176357eaab8985c0f3d67d7d8a7a45d3cd6aadb8d254b7c206982',
    bucketName: 'faceswap-images-office-dev',
    port: process.env.PORT || 3000
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'r2-file-manager.html'));
});

let rcloneConfig = null;

function getRcloneConfig() {
    if (rcloneConfig && fs.existsSync(rcloneConfig.tempConfigPath)) {
        return rcloneConfig;
    }
    const endpoint = `https://${CONFIG.accountId}.r2.cloudflarestorage.com`;
    const tempConfigPath = path.join(os.tmpdir(), `rclone-${Date.now()}.conf`);
    fs.writeFileSync(tempConfigPath, `[r2]
type = s3
provider = Cloudflare
access_key_id = ${CONFIG.r2AccessKeyId}
secret_access_key = ${CONFIG.r2SecretAccessKey}
endpoint = ${endpoint}
`);
    rcloneConfig = { remoteName: 'r2', tempConfigPath, baseArgs: ['--config', tempConfigPath] };
    return rcloneConfig;
}

function listFolders(folderPath) {
    return new Promise((resolve, reject) => {
        const config = getRcloneConfig();
        const { remoteName, baseArgs } = config;
        const remotePath = `${remoteName}:${CONFIG.bucketName}/${folderPath}`;
        const rclone = spawn('rclone', [...baseArgs, 'lsf', '--dirs-only', '-R', remotePath], { stdio: 'pipe' });
        let stdout = '', stderr = '';
        rclone.stdout.on('data', d => stdout += d.toString());
        rclone.stderr.on('data', d => stderr += d.toString());
        rclone.on('close', code => {
            if (code === 0 || stderr.includes('directory not found')) {
                const folders = stdout.split('\n').filter(f => f.trim()).map(f => {
                    const base = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
                    return f.startsWith('/') ? `${base}${f}` : `${base}/${f}`;
                }).filter(f => {
                    const last = f.split('/').pop();
                    return !last.includes('.') || !/\.(webp|png|json|jpg|jpeg|gif)$/i.test(last);
                }).sort();
                resolve(folders);
            } else {
                reject(new Error(stderr));
            }
        });
        rclone.on('error', reject);
    });
}

function listFiles(folderPath) {
    return new Promise((resolve, reject) => {
        const config = getRcloneConfig();
        const { remoteName, baseArgs } = config;
        const remotePath = folderPath ? `${remoteName}:${CONFIG.bucketName}/${folderPath}` : `${remoteName}:${CONFIG.bucketName}`;
        
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
                        return !last.includes('.') || !/\.(webp|png|json|jpg|jpeg|gif)$/i.test(last);
                    }).sort();
                    foldersResolve(folders);
                } else {
                    foldersReject(new Error(stderr));
                }
            });
            rclone.on('error', foldersReject);
        });
        
        const filesPromise = new Promise((filesResolve, filesReject) => {
            const rclone = spawn('rclone', [...baseArgs, 'lsl', '-R', remotePath], { stdio: 'pipe' });
            let stdout = '', stderr = '';
            rclone.stdout.on('data', d => stdout += d.toString());
            rclone.stderr.on('data', d => stderr += d.toString());
            rclone.on('close', code => {
                if (code === 0 || stderr.includes('directory not found')) {
                    const fileMap = {};
                    stdout.split('\n').filter(line => line.trim()).forEach(line => {
                        const match = line.match(/^\s*(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(.+)$/);
                        if (match) {
                            const [, size, dateStr, filePath] = match;
                            let fullPath;
                            if (!folderPath) {
                                fullPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
                            } else {
                                const base = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
                                fullPath = filePath.startsWith('/') ? `${base}${filePath}` : `${base}/${filePath}`;
                            }
                            const last = fullPath.split('/').pop();
                            if (last.includes('.') && /\.(webp|png|json|jpg|jpeg|gif)$/i.test(last)) {
                                fileMap[fullPath] = {
                                    path: fullPath,
                                    date: new Date(dateStr),
                                    size: parseInt(size, 10)
                                };
                            }
                        }
                    });
                    filesResolve(Object.values(fileMap));
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

function deleteFile(filePath) {
    return new Promise((resolve, reject) => {
        const config = getRcloneConfig();
        const { remoteName, baseArgs } = config;
        const rclone = spawn('rclone', [...baseArgs, 'delete', `${remoteName}:${CONFIG.bucketName}/${filePath}`], { stdio: 'pipe' });
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

function deleteFolder(folderPath) {
    return new Promise((resolve, reject) => {
        const config = getRcloneConfig();
        const { remoteName, baseArgs } = config;
        const folderPathClean = folderPath.replace(/\/$/, '');
        const remotePath = `${remoteName}:${CONFIG.bucketName}/${folderPathClean}`;
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

app.get('/api/list', async (req, res) => {
    try {
        const folderPath = req.query.path || '';
        const { files, folders } = await listFiles(folderPath);
        res.json({ 
            success: true, 
            files: files.map(f => ({ path: f.path, date: f.date ? f.date.toISOString() : null, size: f.size })),
            folders: folders.map(f => f.path),
            path: folderPath 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/delete/files', async (req, res) => {
    try {
        const { files } = req.body;
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ success: false, error: 'No files provided' });
        }
        const results = [];
        for (const file of files) {
            try {
                await deleteFile(file);
                results.push({ file, success: true });
            } catch (error) {
                results.push({ file, success: false, error: error.message });
            }
        }
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/delete/folders', async (req, res) => {
    try {
        const { folders } = req.body;
        if (!Array.isArray(folders) || folders.length === 0) {
            return res.status(400).json({ success: false, error: 'No folders provided' });
        }
        const results = [];
        for (const folder of folders) {
            try {
                await deleteFolder(folder);
                results.push({ folder, success: true });
            } catch (error) {
                results.push({ folder, success: false, error: error.message });
            }
        }
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check rclone on startup
try {
    execSync('rclone version', { stdio: 'ignore' });
} catch {
    console.error('Error: rclone is not installed or not in PATH');
    console.error('Install with: brew install rclone');
    process.exit(1);
}

app.listen(CONFIG.port, () => {
    console.log('R2 File Manager running at http://localhost:' + CONFIG.port);
});

// Cleanup on exit
process.on('exit', () => {
    if (rcloneConfig && fs.existsSync(rcloneConfig.tempConfigPath)) {
        try {
            fs.unlinkSync(rcloneConfig.tempConfigPath);
        } catch {}
    }
});
