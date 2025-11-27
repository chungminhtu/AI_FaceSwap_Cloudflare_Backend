# Electron Deployment Manager

Desktop application for managing multiple Cloudflare Worker deployments to different GCP projects and Cloudflare accounts.

## Features

- ✅ Manage multiple deployment configurations in one place
- ✅ Vietnamese UI with English technical terms
- ✅ Automatic account/project switching
- ✅ Setup wizards for billing, Vision API, and Cloudflare
- ✅ Comprehensive error handling and display
- ✅ Automatic retry for network failures
- ✅ Real-time deployment progress tracking
- ✅ Configuration import/export

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

1. **Set Codebase Path**: Click "Chọn..." next to the codebase path field and select your Cloudflare Worker codebase directory.

2. **Authenticate**:
   - Click "Đăng nhập Cloudflare" to authenticate with Cloudflare
   - Click "Đăng nhập GCP" to authenticate with Google Cloud

3. **Add Deployment**:
   - Click "+ Thêm Triển khai"
   - Fill in all required fields:
     - Deployment name and ID
     - GCP Project ID and account email
     - Cloudflare account information
     - All required secrets (RAPIDAPI_KEY, etc.)
   - Click "Lưu"

4. **Deploy**:
   - Click "Triển khai" on any deployment card
   - Monitor progress in the deployment status view
   - Review any errors if deployment fails

### Setup Guides

Click "Hướng dẫn Thiết lập" to access interactive guides for:
- **Billing Setup**: How to enable billing on Google Cloud
- **Vision API Setup**: Step-by-step Vision API configuration
- **Cloudflare Setup**: Cloudflare account and resources setup

### Configuration Management

- **Export Config**: Save your deployment configurations to a JSON file
- **Import Config**: Load deployment configurations from a JSON file

## Configuration File

The application stores all configurations in:
- **macOS**: `~/Library/Application Support/electron-deployment-app/deployments-config.json`
- **Windows**: `%APPDATA%/electron-deployment-app/deployments-config.json`
- **Linux**: `~/.config/electron-deployment-app/deployments-config.json`

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
- **Config Storage**: JSON file in user data directory
- **CLI Integration**: Uses child_process to execute wrangler and gcloud commands

## License

MIT

