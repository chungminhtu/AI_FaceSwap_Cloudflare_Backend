# Google Cloud Vision API Setup Information

**Generated:** 2025-11-17T03:26:30.313Z

## Setup Summary

✅ Google Cloud Vision API setup completed successfully

## Project Information

- **Project ID:** `trusted-play-console-reporter`
- **Project Name:** `Trusted Play Console Reporter`
- **Service Account Email:** `faceswap-vision-sa@trusted-play-console-reporter.iam.gserviceaccount.com`
- **Service Account Display Name:** FaceSwap Vision API Service Account

## Configuration Details

### IAM Role
- **Role:** `roles/editor`
- **Member:** `serviceAccount:faceswap-vision-sa@trusted-play-console-reporter.iam.gserviceaccount.com`

### API Status
- **Cloud Vision API:** ✅ Enabled

### Cloudflare Integration
- **Secret Name:** `GOOGLE_SERVICE_ACCOUNT_KEY`
- **Status:** ✅ Set (Base64-encoded service account JSON)

## Security Notes

⚠️ **Important Security Reminders:**

1. The service account key has been Base64-encoded and stored as a Cloudflare Workers secret
2. The temporary key file has been deleted from your local system
3. Never commit the service account key to version control
4. The key provides access to Google Cloud Vision API - keep it secure
5. If the key is compromised, delete it immediately in Google Cloud Console and create a new one

## Next Steps

1. **Deploy your Worker:**
   ```bash
   npm run deploy
   # or
   node deploy.js
   ```

2. **Test the setup:**
   - Make a face swap request to your Worker
   - The Worker will automatically use the service account to authenticate with Vision API

## Troubleshooting

### Error: "GOOGLE_SERVICE_ACCOUNT_KEY not set"
- Run: `wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY`
- Paste the Base64-encoded key (if you have it saved)

### Error: "OAuth2 token exchange failed"
- Verify the service account key is valid
- Check that Vision API is enabled in the project
- Ensure the service account has the correct IAM role

### Error: "Permission denied"
- Verify the service account has `roles/editor` role
- Check project billing is enabled (required for Vision API)

### Recreate Service Account Key
If you need to recreate the key:
```bash
gcloud iam service-accounts keys create key.json \
  --iam-account=faceswap-vision-sa@trusted-play-console-reporter.iam.gserviceaccount.com \
  --project=trusted-play-console-reporter
base64 -i key.json  # macOS
base64 key.json     # Linux
# Then set as Cloudflare secret
wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
```

## Quick Reference

- **Google Cloud Console:** https://console.cloud.google.com/iam-admin/serviceaccounts?project=trusted-play-console-reporter
- **Vision API Dashboard:** https://console.cloud.google.com/apis/api/vision.googleapis.com/overview?project=trusted-play-console-reporter
- **IAM & Admin:** https://console.cloud.google.com/iam-admin/iam?project=trusted-play-console-reporter

## Support

For issues with:
- **Google Cloud:** See [Google Cloud Documentation](https://cloud.google.com/vision/docs)
- **Cloudflare Workers:** See [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
