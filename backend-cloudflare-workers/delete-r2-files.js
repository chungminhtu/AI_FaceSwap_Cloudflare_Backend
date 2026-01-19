#!/usr/bin/env node
const express = require('express');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const CONFIG = {
    accountId: 'd6bbe756fe7a10cc4982a882cd98c9c8',
    r2AccessKeyId: '7a2fdf3156f2195594313b9166de3879',
    r2SecretAccessKey: 'ddf6eb789cb176357eaab8985c0f3d67d7d8a7a45d3cd6aadb8d254b7c206982',
    bucketName: '',
    port: process.env.PORT || 3000
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

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

function listFiles(folderPath) {
    return new Promise((resolve, reject) => {
        const config = getRcloneConfig();
        const { remoteName, baseArgs } = config;
        let remotePath;
        if (CONFIG.bucketName) {
            remotePath = folderPath ? `${remoteName}:${CONFIG.bucketName}/${folderPath}` : `${remoteName}:${CONFIG.bucketName}`;
        } else {
            remotePath = folderPath ? `${remoteName}:${folderPath}` : `${remoteName}:`;
        }
        
        console.log('[rclone] Listing:', remotePath);
        
        const foldersPromise = new Promise((foldersResolve, foldersReject) => {
            const args = [...baseArgs, 'lsf', '--fast-list', '--dirs-only', remotePath];
            const rclone = spawn('rclone', args, { stdio: 'pipe' });
            let stdout = '', stderr = '';
            rclone.stdout.on('data', d => stdout += d.toString());
            rclone.stderr.on('data', d => stderr += d.toString());
            rclone.on('close', code => {
                if (code === 0 || stderr.includes('directory not found') || stderr.includes('Couldn\'t find')) {
                    if (stderr && !stderr.includes('directory not found') && !stderr.includes('Couldn\'t find')) {
                        console.log('[rclone lsf] stderr:', stderr.substring(0, 200));
                    }
                    const folderLines = stdout.split('\n').filter(f => f.trim());
                    console.log('[rclone lsf] Received', folderLines.length, 'folder lines');
                    const folders = folderLines
                        .map(f => {
                            let p = f.trim();
                            if (p.endsWith('/')) p = p.slice(0, -1);
                            if (!folderPath) {
                                return p.startsWith('/') ? p.slice(1) : p;
                            }
                            const base = folderPath.replace(/\/$/, '');
                            return `${base}/${p}`;
                        })
                        .filter(f => {
                            const parts = f.split('/');
                            const last = parts[parts.length - 1];
                            if (!last) return false;
                            const hasExtension = last.includes('.') && /\.(webp|png|json|jpg|jpeg|gif|txt|pdf|zip)$/i.test(last);
                            return !hasExtension;
                        })
                        .sort();
                    console.log('[rclone lsf] Parsed', folders.length, 'folders');
                    foldersResolve(folders);
                } else {
                    console.error('[rclone lsf] Failed with code', code, 'stderr:', stderr.substring(0, 500));
                    foldersReject(new Error(stderr || 'Failed to list folders'));
                }
            });
            rclone.on('error', foldersReject);
        });
        
        const filesPromise = new Promise((filesResolve, filesReject) => {
            const args = [...baseArgs, 'lsjson', remotePath];
            const rclone = spawn('rclone', args, { stdio: 'pipe' });
            let stdout = '', stderr = '';
            rclone.stdout.on('data', d => stdout += d.toString());
            rclone.stderr.on('data', d => stderr += d.toString());
            rclone.on('close', code => {
                if (code === 0 || stderr.includes('directory not found') || stderr.includes('Couldn\'t find')) {
                    if (stderr && !stderr.includes('directory not found') && !stderr.includes('Couldn\'t find')) {
                        console.log('[rclone lsjson] stderr:', stderr.substring(0, 200));
                    }
                    const files = [];
                    if (stdout.trim()) {
                        const trimmed = stdout.trim();
                        let jsonStr = trimmed;
                        
                        if (trimmed.startsWith('[')) {
                            try {
                                const items = JSON.parse(jsonStr);
                                items.forEach(item => {
                                    if (item.IsDir) return;
                                    let itemPath = item.Path || item.Name || '';
                                    if (!itemPath) return;
                                    
                                    let fullPath;
                                    if (!folderPath) {
                                        fullPath = itemPath.startsWith('/') ? itemPath.slice(1) : itemPath;
                                    } else {
                                        const base = folderPath.replace(/\/$/, '');
                                        if (itemPath.startsWith('/')) {
                                            itemPath = itemPath.slice(1);
                                        }
                                        fullPath = `${base}/${itemPath}`;
                                    }
                                    
                                    const last = fullPath.split('/').pop();
                                    if (last && last.includes('.')) {
                                        files.push({
                                            path: fullPath,
                                            date: item.ModTime ? new Date(item.ModTime) : null,
                                            size: item.Size || 0
                                        });
                                    }
                                });
                            } catch (e) {
                                console.log('[rclone lsjson] Array parse failed, trying line-by-line:', e.message);
                            }
                        }
                        
                        if (files.length === 0) {
                            const lines = trimmed.split('\n');
                            console.log('[rclone lsjson] Parsing', lines.length, 'lines as NDJSON');
                            lines.forEach((line, index) => {
                                const trimmedLine = line.trim();
                                if (!trimmedLine) return;
                                
                                try {
                                    const item = JSON.parse(trimmedLine);
                                    if (item.IsDir) return;
                                    
                                    let itemPath = item.Path || item.Name || '';
                                    if (!itemPath) return;
                                    
                                    let fullPath;
                                    if (!folderPath) {
                                        fullPath = itemPath.startsWith('/') ? itemPath.slice(1) : itemPath;
                                    } else {
                                        const base = folderPath.replace(/\/$/, '');
                                        if (itemPath.startsWith('/')) {
                                            itemPath = itemPath.slice(1);
                                        }
                                        fullPath = `${base}/${itemPath}`;
                                    }
                                    
                                    const last = fullPath.split('/').pop();
                                    if (last && last.includes('.')) {
                                        files.push({
                                            path: fullPath,
                                            date: item.ModTime ? new Date(item.ModTime) : null,
                                            size: item.Size || 0
                                        });
                                    }
                                } catch (e) {
                                    if (index < 5) {
                                        console.log('[rclone lsjson] Line', index, 'parse error:', e.message);
                                        console.log('[rclone lsjson] Line content (first 200 chars):', trimmedLine.substring(0, 200));
                                        if (trimmedLine.includes('}{')) {
                                            console.log('[rclone lsjson] WARNING: Multiple JSON objects on same line detected');
                                        }
                                    }
                                }
                            });
                        }
                    }
                    console.log('[rclone lsjson] Parsed', files.length, 'files');
                    filesResolve(files);
                } else {
                    console.error('[rclone lsjson] Failed with code', code, 'stderr:', stderr.substring(0, 500));
                    filesReject(new Error(stderr || 'Failed to list files'));
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
        const remotePath = CONFIG.bucketName ? `${remoteName}:${CONFIG.bucketName}/${filePath}` : `${remoteName}:${filePath}`;
        const rclone = spawn('rclone', [...baseArgs, 'delete', remotePath], { stdio: 'pipe' });
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
        const remotePath = CONFIG.bucketName ? `${remoteName}:${CONFIG.bucketName}/${folderPathClean}` : `${remoteName}:${folderPathClean}`;
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

async function extractZip(zipPath, extractTo) {
    try {
        const zipData = fs.readFileSync(zipPath);
        const zip = await JSZip.loadAsync(zipData);
        const files = [];
        const extractPromises = [];
        
        for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
            if (zipEntry.dir) {
                const dirPath = path.join(extractTo, relativePath);
                if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, { recursive: true });
                }
            } else {
                const filePath = path.join(extractTo, relativePath);
                const dirPath = path.dirname(filePath);
                if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, { recursive: true });
                }
                extractPromises.push(
                    zipEntry.async('nodebuffer').then(buffer => {
                        fs.writeFileSync(filePath, buffer);
                        files.push({
                            localPath: filePath,
                            r2Key: relativePath.replace(/\\/g, '/'),
                            size: buffer.length
                        });
                    })
                );
            }
        }
        await Promise.all(extractPromises);
        return files;
    } catch (error) {
        throw new Error(`Failed to extract zip: ${error.message}`);
    }
}

function checkRcloneAvailable() {
    try {
        execSync('which rclone', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function getRcloneRemoteName() {
    try {
        const remotes = execSync('rclone listremotes', { encoding: 'utf-8', stdio: 'pipe' }).trim().split('\n').filter(r => r.trim());
        const r2Remotes = remotes.filter(r => {
            const name = r.replace(':', '').toLowerCase();
            return name.includes('r2') || name.includes('cloudflare');
        });
        if (r2Remotes.length > 0) {
            return r2Remotes[0].replace(':', '');
        }
        if (remotes.length > 0) {
            return remotes[0].replace(':', '');
        }
    } catch {}
    return null;
}

async function uploadFolderWithRclone(tempDir, bucket, prefix) {
    return new Promise((resolve, reject) => {
        const endpoint = `https://${CONFIG.accountId}.r2.cloudflarestorage.com`;
        const sourcePath = tempDir;
        let remoteName;
        let args;
        let tempConfigPath = null;
        
        const preConfiguredRemote = getRcloneRemoteName();
        
        if (preConfiguredRemote) {
            remoteName = preConfiguredRemote;
            const destPath = prefix 
                ? `${remoteName}:${bucket}/${prefix.replace(/\/$/, '')}/` 
                : `${remoteName}:${bucket}/`;
            args = [
                'copy',
                sourcePath,
                destPath,
                '--transfers', '50',
                '--checkers', '50'
            ];
        } else if (CONFIG.r2AccessKeyId && CONFIG.r2SecretAccessKey) {
            tempConfigPath = path.join(os.tmpdir(), `rclone-upload-${Date.now()}.conf`);
            const configContent = `[r2]
type = s3
provider = Cloudflare
access_key_id = ${CONFIG.r2AccessKeyId}
secret_access_key = ${CONFIG.r2SecretAccessKey}
endpoint = ${endpoint}
`;
            fs.writeFileSync(tempConfigPath, configContent);
            remoteName = 'r2';
            const destPath = prefix 
                ? `${remoteName}:${bucket}/${prefix.replace(/\/$/, '')}/` 
                : `${remoteName}:${bucket}/`;
            args = [
                '--config', tempConfigPath,
                'copy',
                sourcePath,
                destPath,
                '--transfers', '50',
                '--checkers', '50'
            ];
        } else {
            reject(new Error('No rclone remote configured and R2 access keys not provided'));
            return;
        }
        
        const rclone = spawn('rclone', args, {
            env: process.env,
            stdio: 'pipe'
        });
        
        let stdout = '', stderr = '';
        rclone.stdout.on('data', d => stdout += d.toString());
        rclone.stderr.on('data', d => stderr += d.toString());
        
        rclone.on('close', code => {
            if (tempConfigPath && fs.existsSync(tempConfigPath)) {
                try {
                    fs.unlinkSync(tempConfigPath);
                } catch {}
            }
            
            if (code === 0) {
                resolve(true);
            } else {
                reject(new Error(`rclone upload failed: ${stderr || stdout}`));
            }
        });
        
        rclone.on('error', error => {
            if (tempConfigPath && fs.existsSync(tempConfigPath)) {
                try {
                    fs.unlinkSync(tempConfigPath);
                } catch {}
            }
            reject(error);
        });
    });
}

app.get('/api/list', async (req, res) => {
    try {
        const folderPath = req.query.path || '';
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 50;
        const sortBy = req.query.sortBy || 'name';
        const sortOrder = req.query.sortOrder || 'asc';
        const search = (req.query.search || '').toLowerCase().trim();
        
        console.log('[API] Listing path:', folderPath, 'page:', page, 'pageSize:', pageSize, 'search:', search);
        const result = await listFiles(folderPath);
        console.log('[API] Found', result.folders.length, 'folders and', result.files.length, 'files');
        
        let allItems = [
            ...(result.folders || []).map(f => ({ 
                path: typeof f === 'string' ? f : f.path, 
                type: 'folder',
                date: null,
                size: 0
            })),
            ...(result.files || []).map(f => ({ 
                path: f.path, 
                type: 'file',
                date: f.date ? new Date(f.date) : null, 
                size: f.size || 0 
            }))
        ];
        
        if (search) {
            allItems = allItems.filter(item => {
                const name = item.path.split('/').pop().toLowerCase();
                return name.includes(search);
            });
        }
        
        allItems.sort((a, b) => {
            if (a.type === 'folder' && b.type === 'file') return -1;
            if (a.type === 'file' && b.type === 'folder') return 1;
            
            let comparison = 0;
            if (sortBy === 'name') {
                const nameA = a.path.split('/').pop();
                const nameB = b.path.split('/').pop();
                comparison = nameA.localeCompare(nameB);
            } else if (sortBy === 'date') {
                const dateA = a.date ? a.date.getTime() : 0;
                const dateB = b.date ? b.date.getTime() : 0;
                comparison = dateA - dateB;
            } else if (sortBy === 'size') {
                comparison = (a.size || 0) - (b.size || 0);
            } else if (sortBy === 'type') {
                comparison = a.type.localeCompare(b.type);
            }
            return sortOrder === 'asc' ? comparison : -comparison;
        });
        
        const totalItems = allItems.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const pageItems = allItems.slice(start, end);
        
        const response = { 
            success: true, 
            files: pageItems.filter(i => i.type === 'file').map(f => ({ 
                path: f.path, 
                date: f.date ? f.date.toISOString() : null, 
                size: f.size || 0 
            })),
            folders: pageItems.filter(i => i.type === 'folder').map(f => f.path),
            path: folderPath,
            pagination: {
                page,
                pageSize,
                totalItems,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1
            }
        };
        console.log('[API] Sending page', page, 'of', totalPages, '(', pageItems.length, 'items, total:', totalItems, ')');
        res.json(response);
    } catch (error) {
        console.error('[API] Error listing path:', error);
        res.status(500).json({ success: false, error: error.message || 'Unknown error' });
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

app.post('/api/upload/zip', (req, res) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
        return res.status(400).json({ success: false, error: 'Invalid content type' });
    }
    
    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    if (!boundaryMatch) {
        return res.status(400).json({ success: false, error: 'Invalid multipart data' });
    }
    const boundary = '--' + boundaryMatch[1].trim();
    
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-upload-'));
    let zipFilePath = null;
    let prefix = '';
    let bucket = CONFIG.bucketName || '';
    const chunks = [];
    
    req.on('data', chunk => {
        chunks.push(chunk);
    });
    
    req.on('end', async () => {
        try {
            const buffer = Buffer.concat(chunks);
            const boundaryBuffer = Buffer.from(boundary, 'utf8');
            const parts = [];
            let start = 0;
            
            while (true) {
                const index = buffer.indexOf(boundaryBuffer, start);
                if (index === -1) break;
                
                if (index > start) {
                    parts.push(buffer.slice(start, index));
                }
                start = index + boundaryBuffer.length;
            }
            
            for (const part of parts) {
                if (part.length < 10) continue;
                
                const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
                if (headerEnd === -1) continue;
                
                const headerBuffer = part.slice(0, headerEnd);
                const headers = headerBuffer.toString('utf8');
                const bodyStart = headerEnd + 4;
                let bodyEnd = part.length;
                
                const lastCrlf = part.lastIndexOf(Buffer.from('\r\n'));
                if (lastCrlf > bodyStart) {
                    bodyEnd = lastCrlf;
                }
                
                const body = part.slice(bodyStart, bodyEnd);
                
                if (headers.includes('name="zipfile"')) {
                    const filenameMatch = headers.match(/filename="([^"]+)"/);
                    if (filenameMatch) {
                        zipFilePath = path.join(os.tmpdir(), `zip-${Date.now()}-${filenameMatch[1]}`);
                        fs.writeFileSync(zipFilePath, body);
                    }
                } else if (headers.includes('name="prefix"')) {
                    prefix = body.toString('utf8').trim();
                } else if (headers.includes('name="bucket"')) {
                    bucket = body.toString('utf8').trim() || CONFIG.bucketName || '';
                }
            }
            
            if (!zipFilePath || !fs.existsSync(zipFilePath)) {
                if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
                return res.status(400).json({ success: false, error: 'No file uploaded' });
            }
            
            if (!bucket) {
                if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
                if (zipFilePath) fs.unlinkSync(zipFilePath);
                return res.status(400).json({ success: false, error: 'Bucket name is required' });
            }
            
            const files = await extractZip(zipFilePath, tempDir);
            
            const rcloneAvailable = checkRcloneAvailable();
            const hasAccessKeys = CONFIG.r2AccessKeyId && CONFIG.r2SecretAccessKey;
            const hasPreConfiguredRemote = getRcloneRemoteName() !== null;
            const useRclone = rcloneAvailable && (hasAccessKeys || hasPreConfiguredRemote);
            
            if (useRclone) {
                try {
                    await uploadFolderWithRclone(tempDir, bucket, prefix);
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    fs.unlinkSync(zipFilePath);
                    res.json({ 
                        success: true, 
                        message: `Successfully uploaded ${files.length} files`,
                        fileCount: files.length
                    });
                } catch (uploadError) {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    fs.unlinkSync(zipFilePath);
                    throw uploadError;
                }
            } else {
                if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
                if (zipFilePath) fs.unlinkSync(zipFilePath);
                res.status(500).json({ success: false, error: 'rclone not available or not configured' });
            }
        } catch (error) {
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
            if (zipFilePath && fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);
            res.status(500).json({ success: false, error: error.message });
        }
    });
});

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

process.on('exit', () => {
    if (rcloneConfig && fs.existsSync(rcloneConfig.tempConfigPath)) {
        try {
            fs.unlinkSync(rcloneConfig.tempConfigPath);
        } catch {}
    }
});
