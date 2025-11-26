# Electron Deployment Manager

Desktop application for deploying Cloudflare Worker from secrets.json - identical to running `node deploy.js`.

## Features

- ✅ Deploy directly from `secrets.json` (same as CLI)
- ✅ Vietnamese UI with English technical terms
- ✅ Automatic Cloudflare and GCP authentication
- ✅ Real-time deployment progress tracking
- ✅ Comprehensive error handling and display
- ✅ SQLite database for persistent configuration

## Installation

1. Navigate to the electron-app directory:
```bash
cd electron-app
```

2. Install dependencies:
```bash
npm install
```

## Running the Application

### Development Mode
```bash
npm run dev
```

This will start the Electron app with DevTools open for debugging.

### Production Mode
```bash
npm start
```

## Building the Application

### Build for Current Platform
```bash
npm run build
```

### Build for Specific Platform
```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

Built applications will be in the `dist/` directory.

## Usage

### First Time Setup

1. **Set Codebase Path**: Click "Chọn..." next to the codebase path field and select your Cloudflare Worker codebase directory (must contain `secrets.json`).

2. **Authenticate**:
   - Click "Đăng nhập Cloudflare" to authenticate with Cloudflare
   - Click "Đăng nhập GCP" to authenticate with Google Cloud

3. **Deploy**:
   - Click "🚀 Deploy from secrets.json"
   - The app will read your `secrets.json` and deploy using the exact same logic as `node deploy.js`
   - Monitor progress in the deployment status view
   - Review any errors if deployment fails

## Configuration

The application stores configuration in SQLite database:
- **macOS**: `~/Library/Application Support/electron-deployment-app/config.sqlite`
- **Windows**: `%APPDATA%/electron-deployment-app/config.sqlite`
- **Linux**: `~/.config/electron-deployment-app/config.sqlite`

**Deployment uses `secrets.json` from your codebase directory** - same file used by `node deploy.js`.

## Requirements

- Node.js 16+ 
- Wrangler CLI installed globally (`npm install -g wrangler`)
- Google Cloud SDK installed (`gcloud` command available)
- Valid Cloudflare account
- Valid Google Cloud account with billing enabled

## Troubleshooting

### Authentication Issues

If authentication fails:
1. Check that `wrangler` and `gcloud` are installed and in your PATH
2. Try logging in manually via terminal:
   - `wrangler login`
   - `gcloud auth login`

### Deployment Failures

1. Check the error display modal for detailed error information
2. Verify all secrets are correctly configured
3. Ensure GCP project has billing enabled
4. Check that Vision API is enabled in the GCP project
5. Verify Cloudflare account has necessary permissions

### Network Errors

The app automatically retries network failures up to 3 times with exponential backoff. If retries fail, you can manually retry the deployment.

## Technical Details

- **Framework**: Electron
- **UI**: Vanilla HTML/CSS/JavaScript
- **IPC**: Electron IPC for main/renderer communication
- **Config Storage**: SQLite database
- **Deployment**: Direct integration with `deploy.js` module (same logic as CLI)

## License

MIT

