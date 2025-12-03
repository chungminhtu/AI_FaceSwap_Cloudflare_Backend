#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { deployFromConfig } = require('./deploy.js');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = process.cwd();

function serveStatic(filePath, res) {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(ROOT_DIR, filePath);
  const ext = path.extname(fullPath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (pathname === '/api/deploy' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const { flags, environment } = JSON.parse(body);
        
        const progressLog = [];
        const progressCallback = (step, status, details) => {
          progressLog.push({ step, status, details, timestamp: new Date().toISOString() });
        };

        if (environment) process.env.DEPLOY_ENV = environment;
        const { loadConfig } = require('./deploy.js');
        const deployConfig = await loadConfig();
        
        const result = await deployFromConfig(
          deployConfig,
          progressCallback,
          ROOT_DIR,
          flags
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: result.success,
          workerUrl: result.workerUrl,
          pagesUrl: result.pagesUrl,
          progress: progressLog,
          error: result.error
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: error.message
        }));
      }
    });
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    try {
      const configPath = path.join(__dirname, 'deployments-secrets.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Config file not found' }));
      }
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(path.join(__dirname, 'index.html'), res);
    return;
  }

  if (pathname.startsWith('/_cloudflare-gcp-deploy-cli-ui/')) {
    serveStatic(path.join(__dirname, pathname.replace('/_cloudflare-gcp-deploy-cli-ui', '')), res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});


server.listen(PORT, () => {
  console.log(`🚀 Deployment server running on http://localhost:${PORT}`);
  console.log(`📖 Open http://localhost:${PORT} in your browser`);
});

