# Deployment Secrets Setup

This guide explains how to set up the `secrets.json` file for automatic deployment using API tokens.

## Overview

The deployment script has been refactored to use API tokens for automatic authentication instead of requiring manual CLI login. This allows for seamless CI/CD integration and automated deployments.

## deployments-secrets.json Structure

Create a `deploy/deployments-secrets.json` file with the following structure:

```json
{
  "environments": {
    "production": {
      "name": "production",
      "workerName": "your-worker-name",
      "pagesProjectName": "your-pages-name",
      "databaseName": "your-database-name",
      "bucketName": "your-bucket-name",
      "cloudflare": {
        "accountId": "your_cloudflare_account_id",
        "apiToken": "your_cloudflare_api_token"
      },
      "gcp": {
        "projectId": "your-gcp-project-id",
        "serviceAccountKeyJson": {
          "type": "service_account",
          "project_id": "your-gcp-project-id",
          "private_key_id": "your-private-key-id",
          "private_key": "-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n",
          "client_email": "your-service-account@your-project.iam.gserviceaccount.com",
          "client_id": "your-client-id",
          "auth_uri": "https://accounts.google.com/o/oauth2/auth",
          "token_uri": "https://oauth2.googleapis.com/token",
          "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
          "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/your-service-account%40your-project.iam.gserviceaccount.com"
        }
      },
      "RAPIDAPI_KEY": "your_rapidapi_key",
      "RAPIDAPI_HOST": "ai-face-swap2.p.rapidapi.com",
      "RAPIDAPI_ENDPOINT": "https://ai-face-swap2.p.rapidapi.com/public/process/urls",
      "GOOGLE_VISION_API_KEY": "your_google_vision_api_key",
      "GOOGLE_VERTEX_PROJECT_ID": "your-gcp-project-id",
      "GOOGLE_VERTEX_LOCATION": "us-central1",
      "GOOGLE_VISION_ENDPOINT": "https://vision.googleapis.com/v1/images:annotate",
      "GOOGLE_SERVICE_ACCOUNT_EMAIL": "your-service-account@your-project.iam.gserviceaccount.com",
      "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n"
    },
    "staging": {
      // Same structure as production but with staging values
    }
  }
}
```

## Required API Tokens and Keys

### Cloudflare Setup

1. **API Token**: Go to Cloudflare Dashboard → Profile → API Tokens
2. Create a new API Token with the following permissions:
   - Account: Cloudflare Workers:Edit
   - Account: Cloudflare Pages:Edit
   - Account: Cloudflare R2:Edit
   - Account: Cloudflare D1:Edit
3. Copy the token to `cloudflare.apiToken`

4. **Account ID**: Found in Cloudflare Dashboard → Account Home → Account ID
5. Copy to `cloudflare.accountId`

### Google Cloud Setup

1. **Service Account**: Go to Google Cloud Console → IAM & Admin → Service Accounts
2. Create a new service account or use existing one
3. Generate a new JSON key for the service account
4. Download the JSON file and copy its contents to `gcp.serviceAccountKeyJson`
5. The `projectId` should match the `project_id` in the service account JSON

### RapidAPI Setup

1. Get your API key from RapidAPI dashboard
2. Copy to `RAPIDAPI_KEY`

### Google Vision API Setup

1. Enable Google Vision API in your GCP project
2. Create an API key in GCP Console → APIs & Services → Credentials
3. Copy the API key to `GOOGLE_VISION_API_KEY`

## Environment Variables

- `DEPLOY_ENV`: Set to `staging` to deploy to staging environment (defaults to `production`)

## Usage Examples

```bash
# Deploy to production
node deploy/deploy.js

# Deploy to staging
DEPLOY_ENV=staging node deploy/deploy.js

# Show help
node deploy/deploy.js --help
```

## Security Notes

- Never commit `deploy/deployments-secrets.json` to version control
- The deploy directory is already in .gitignore to prevent accidental commits
- Use environment-specific secrets for different deployment environments
- Rotate API tokens regularly
- Use IAM roles and permissions with least privilege principle
