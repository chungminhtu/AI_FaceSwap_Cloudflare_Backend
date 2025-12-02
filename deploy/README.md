# Deploy Folder

This folder contains the deployment scripts and configuration for the AI FaceSwap Cloudflare Backend.

## Files

- `deploy.js` - Main deployment script
- `deployments-secrets.json` - Environment configurations and credentials

## Usage

### From project root:

```bash
# Setup (first time only)
npm run deploy-setup

# Deploy to ai-office environment
npm run deploy-ai-office

# Or run directly
node deploy/deploy.js ai-office
```

### Direct commands:

```bash
# Setup authentication
node deploy/deploy.js setup

# Deploy to ai-office environment
node deploy/deploy.js ai-office
```

## Configuration

Edit `deployments-secrets.json` to configure your environments and credentials.

## Requirements

- Wrangler CLI
- Google Cloud SDK
- Node.js

## Support

For issues, check the main project README.md or DEPLOYMENT_INFO.md.
