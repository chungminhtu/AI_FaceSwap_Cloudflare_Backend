# Google Cloud Vision API Setup Information

**Generated:** 2025-11-17T06:48:38.055Z

## Setup Summary

✅ Google Cloud Vision API setup completed successfully

## Project Information

- **Project ID:** `ai-photo-office`
- **Project Name:** `AI Photo Office`
- **Service Account Email:** `faceswap-vision-sa@ai-photo-office.iam.gserviceaccount.com`
- **Service Account Display Name:** FaceSwap Vision API Service Account

## Configuration Details

### IAM Role
- **Role:** `roles/editor`
- **Member:** `serviceAccount:faceswap-vision-sa@ai-photo-office.iam.gserviceaccount.com`

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
  --iam-account=faceswap-vision-sa@ai-photo-office.iam.gserviceaccount.com \
  --project=ai-photo-office
base64 -i key.json  # macOS
base64 key.json     # Linux
# Then set as Cloudflare secret
wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
```

## Quick Reference

- **Google Cloud Console:** https://console.cloud.google.com/iam-admin/serviceaccounts?project=ai-photo-office
- **Vision API Dashboard:** https://console.cloud.google.com/apis/api/vision.googleapis.com/overview?project=ai-photo-office
- **IAM & Admin:** https://console.cloud.google.com/iam-admin/iam?project=ai-photo-office

## Support

For issues with:
- **Google Cloud:** See [Google Cloud Documentation](https://cloud.google.com/vision/docs)
- **Cloudflare Workers:** See [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
