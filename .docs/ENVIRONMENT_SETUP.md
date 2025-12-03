# Environment Configuration Guide

This guide explains how to configure the deployment script for multiple infrastructure environments using environment variables.

## Quick Setup for Multiple Environments

### 1. Create Environment-Specific .env Files

For each infrastructure environment, create a separate .env file:

```bash
# Production environment
cp env-example.txt .env.production

# Staging environment
cp env-example.txt .env.staging

# Development environment
cp env-example.txt .env.dev
```

### 2. Configure Each .env File

Edit each .env file with the appropriate credentials:

**`.env.production`:**
```env
CLOUDFLARE_ACCOUNT_ID=72474c350e3f55d96195536a5d39e00d
CLOUDFLARE_API_TOKEN=your_production_api_token
GOOGLE_PROJECT_ID=your-production-project
GOOGLE_APPLICATION_CREDENTIALS=/path/to/production-service-account.json
```

**`.env.staging`:**
```env
CLOUDFLARE_ACCOUNT_ID=different_account_id_for_staging
CLOUDFLARE_API_TOKEN=your_staging_api_token
GOOGLE_PROJECT_ID=your-staging-project
GOOGLE_APPLICATION_CREDENTIALS=/path/to/staging-service-account.json
```

### 3. Deploy to Different Environments

Switch between environments by copying the appropriate .env file:

```bash
# Deploy to production
cp .env.production .env
node deploy.js production

# Deploy to staging
cp .env.staging .env
node deploy.js staging

# Deploy to development
cp .env.dev .env
node deploy.js dev
```

## Environment Variables Reference

### Cloudflare Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID | `72474c350e3f55d96195536a5d39e00d` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` |
| `CLOUDFLARE_EMAIL` | Alternative: Your Cloudflare email | `user@example.com` |
| `CLOUDFLARE_API_KEY` | Alternative: Global API key | `your_global_api_key` |

### GCP Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `GOOGLE_PROJECT_ID` | Your GCP project ID | `my-gcp-project-12345` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account key | `/home/user/keys/service-account.json` |
| `GCP_ACCOUNT_EMAIL` | Your GCP account email | `user@company.com` |

## Getting Your Credentials

### Cloudflare Credentials

1. **Account ID**: Found in your Cloudflare dashboard URL or account settings
2. **API Token**: Create at https://dash.cloudflare.com/profile/api-tokens
   - Use "Edit Cloudflare Workers" template
   - Or create custom token with necessary permissions

### GCP Credentials

1. **Project ID**: Found in GCP Console → Project Settings
2. **Service Account Key**: Create at GCP Console → IAM & Admin → Service Accounts
   - Create service account with necessary permissions
   - Generate JSON key file
   - Store securely and reference path in `GOOGLE_APPLICATION_CREDENTIALS`

## Alternative: Interactive Setup

If you prefer not to manually configure credentials, use the interactive setup:

```bash
node deploy.js setup
```

This will:
- Guide you through browser-based login for Cloudflare and GCP
- Automatically extract and save credentials
- Create the necessary configuration files

## Security Notes

- Never commit .env files to version control
- Store service account key files securely
- Use different credentials for each environment
- Rotate API tokens regularly

## Troubleshooting

### "Cloudflare accountId is required"
- Ensure `CLOUDFLARE_ACCOUNT_ID` is set in your .env file
- Or run `node deploy.js setup` to configure interactively

### "GCP projectId is required"
- Ensure `GOOGLE_PROJECT_ID` is set in your .env file
- Or run `node deploy.js setup` to configure interactively

### "API token not found"
- Ensure `CLOUDFLARE_API_TOKEN` is set correctly
- Or run `node deploy.js setup` to extract it automatically
