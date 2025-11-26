# Vertex AI Setup Guide for Cloudflare Workers

This guide explains how to set up Vertex AI authentication for Gemini API to bypass location restrictions.

## Why Vertex AI?

If you're getting the error "user location is not supported for the api use", you need to use Vertex AI instead of the regular Gemini API. Vertex AI requires JWT authentication with a Google Cloud service account.

## Step 1: Create a Google Cloud Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to **IAM & Admin** > **Service Accounts**
3. Click **Create Service Account**
4. Fill in:
   - **Name**: `gemini-worker-service`
   - **Description**: Service account for Cloudflare Worker
5. Click **Create and Continue**
6. Assign role: **Vertex AI User** (`roles/aiplatform.user`)
7. Click **Done**

## Step 2: Generate Service Account Key

1. Click on your newly created service account
2. Go to **Keys** tab
3. Click **Add Key** > **Create new key**
4. Select **JSON** format
5. Click **Create** - a JSON file will download

## Step 3: Extract Credentials from JSON

Open the downloaded JSON file and extract:

- **`client_email`**: This is your `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- **`private_key`**: This is your `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

Example JSON structure:
```json
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "gemini-worker@your-project.iam.gserviceaccount.com",
  ...
}
```

## Step 4: Configure secrets.json

Add these fields to your `secrets.json`:

```json
{
  "GOOGLE_PROJECT_ID": "your-project-id",
  "GOOGLE_GEMINI_ENDPOINT": "https://us-central1-aiplatform.googleapis.com/v1beta1",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL": "gemini-worker@your-project.iam.gserviceaccount.com",
  "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\\nYOUR_KEY_HERE\\n-----END PRIVATE KEY-----"
}
```

**Important Notes:**
- Keep the `\n` characters in the private key (they should be escaped as `\\n` in JSON)
- The private key must include the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` markers
- Use the exact `client_email` from the JSON file

## Step 5: Deploy

Run your deployment:

```bash
node deploy.js
```

The system will automatically:
1. Detect that you're using Vertex AI (endpoint contains `aiplatform`)
2. Generate JWT tokens using your service account credentials
3. Exchange JWT for OAuth access tokens
4. Use Bearer token authentication for Vertex AI API calls

## Verification

After deployment, test the Gemini API. If configured correctly, you should see logs like:

```
[Gemini] Using Vertex AI endpoint: https://us-central1-aiplatform.googleapis.com/v1beta1/projects/...
[Gemini] Generating OAuth access token for Vertex AI...
[Gemini] ✅ OAuth token obtained successfully
```

## Troubleshooting

### Error: "Failed to import private key"
- Make sure the private key includes the BEGIN/END markers
- Ensure `\n` characters are properly escaped as `\\n` in JSON
- Verify the key is in PKCS8 format (standard Google service account format)

### Error: "Failed to get access token"
- Verify `GOOGLE_SERVICE_ACCOUNT_EMAIL` matches the `client_email` from JSON
- Check that the service account has the **Vertex AI User** role
- Ensure the project has Vertex AI API enabled

### Error: "GOOGLE_PROJECT_ID is required"
- Make sure `GOOGLE_PROJECT_ID` matches your Google Cloud project ID
- It should be the same as `project_id` in your service account JSON

## Security Best Practices

- **Never commit** `secrets.json` to version control
- Store service account keys securely
- Use Cloudflare Workers secrets for production (not `secrets.json`)
- Rotate service account keys regularly
- Grant only necessary permissions (Vertex AI User role)

## Alternative: Regular Gemini API

If you don't need Vertex AI (not in restricted location), use:

```json
{
  "GOOGLE_GEMINI_ENDPOINT": "https://generativelanguage.googleapis.com/v1beta"
}
```

No service account credentials needed for regular Gemini API.

