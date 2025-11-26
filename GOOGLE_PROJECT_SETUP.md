# How to Get GOOGLE_PROJECT_ID

## Quick Answer

**GOOGLE_PROJECT_ID** is your Google Cloud Project ID. You need to create a Google Cloud project first.

**GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY** is **automatically generated** during deployment - you don't need to get it manually!

---

## Step-by-Step Guide

### Option 1: Create Project via Web Console (Easiest)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top
3. Click **"New Project"**
4. Enter:
   - **Project name**: `My Vertex AI Project` (or any name you like)
   - **Project ID**: This will be auto-generated (e.g., `my-vertex-ai-project-123456`)
5. Click **"Create"**
6. **Copy the Project ID** - this is your `GOOGLE_PROJECT_ID`

### Option 2: Create Project via CLI

```bash
# Create project
gcloud projects create YOUR_PROJECT_ID --name="My Vertex AI Project"

# Link billing account (required for Vertex AI)
gcloud billing projects link YOUR_PROJECT_ID --billing-account=YOUR_BILLING_ACCOUNT_ID
```

### Option 3: Use Existing Project

If you already have a Google Cloud project:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top
3. Select your project
4. **Copy the Project ID** from the project info panel

Or list projects via CLI:
```bash
gcloud projects list
```

---

## What About GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?

**You don't need to get this manually!** 

The deployment script automatically:
1. Creates a service account named `cloudflare-worker-gemini`
2. Generates a private key
3. Saves it to your `secrets.json`

Just set `GOOGLE_PROJECT_ID` in your `secrets.json` and run deployment - everything else is automatic!

---

## Example secrets.json

```json
{
  "GOOGLE_PROJECT_ID": "my-vertex-ai-project-123456",
  "GOOGLE_GEMINI_ENDPOINT": "https://us-central1-aiplatform.googleapis.com/v1beta1",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL": "auto-generated-if-missing",
  "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY": "auto-generated-if-missing"
}
```

**Note**: The `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` will be automatically filled in during deployment.

---

## Requirements

- **Google Cloud Account**: Sign up at https://cloud.google.com/
- **Billing Account**: Required for Vertex AI (free tier available)
- **gcloud CLI**: Install from https://cloud.google.com/sdk/docs/install

---

## Troubleshooting

### "Project not found" error

The deployment script will automatically:
- Check if your project exists
- List available projects if yours doesn't exist
- Provide instructions to create a new project

### "Billing not enabled" error

Vertex AI requires billing to be enabled:
1. Go to [Billing](https://console.cloud.google.com/billing)
2. Link your project to a billing account
3. Or use the CLI: `gcloud billing projects link PROJECT_ID --billing-account=BILLING_ACCOUNT_ID`

### "Permission denied" error

Make sure you're authenticated:
```bash
gcloud auth login
```

---

## Summary

1. **Get GOOGLE_PROJECT_ID**: Create a Google Cloud project (web console or CLI)
2. **Set it in secrets.json**: `"GOOGLE_PROJECT_ID": "your-project-id"`
3. **Run deployment**: The script automatically creates service account and generates private key
4. **Done!**: Everything is configured automatically

No manual key generation needed! 🎉

