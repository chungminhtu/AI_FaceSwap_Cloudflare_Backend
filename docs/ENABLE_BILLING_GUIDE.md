# How to Enable Billing for Google Cloud Vision API

## ⚠️ Error You're Seeing

```
API error: 403 - This API method requires billing to be enabled. 
Please enable billing on project #521788129450
```

## ✅ Solution: Enable Billing

**Google Cloud Vision API requires billing to be enabled**, even for free tier usage. This is a Google requirement.

### Step-by-Step Instructions

1. **Go to Google Cloud Billing Page:**
   - Direct link: https://console.developers.google.com/billing?project=521788129450
   - Or: https://console.cloud.google.com/billing?project=trusted-play-console-reporter

2. **Enable Billing:**
   - Click **"Link a billing account"** or **"Create billing account"**
   - If you don't have a billing account, create one
   - Add a payment method (credit card required)
   - Link it to your project: `trusted-play-console-reporter`

3. **Verify Billing is Enabled:**
   - Go to: https://console.cloud.google.com/billing?project=trusted-play-console-reporter
   - You should see your billing account linked

4. **Test Again:**
   - Make a face swap request
   - The safety check should now work!

## 💰 Free Tier Information

**Good News:** Google Cloud Vision API has a **generous free tier**:

- **First 1,000 requests per month: FREE** ✅
- **After that:** $1.50 per 1,000 requests

For most applications, you'll stay within the free tier!

## 🔗 Quick Links

- **Enable Billing:** https://console.developers.google.com/billing?project=521788129450
- **Billing Dashboard:** https://console.cloud.google.com/billing?project=trusted-play-console-reporter
- **Project Settings:** https://console.cloud.google.com/home/dashboard?project=trusted-play-console-reporter

## 📊 Monitor Usage

After enabling billing, you can monitor your usage:

1. Go to: https://console.cloud.google.com/apis/api/vision.googleapis.com/quotas?project=trusted-play-console-reporter
2. Check your API usage and quotas
3. Set up billing alerts if needed

## ⚠️ Important Notes

- **Billing is required** even for free tier usage
- **You won't be charged** for the first 1,000 requests per month
- **Payment method is required** but won't be charged unless you exceed free tier
- **You can set spending limits** to prevent unexpected charges

## 🚀 After Enabling Billing

1. ✅ Billing is enabled
2. ✅ Vision API will work
3. ✅ Safety checks will pass
4. ✅ You can monitor usage in Google Cloud Console

## 🔒 Set Spending Limits (Optional but Recommended)

To prevent unexpected charges:

1. Go to: https://console.cloud.google.com/billing/budgets
2. Create a budget alert
3. Set a monthly limit (e.g., $5 or $10)
4. Get notified if you approach the limit

---

**Once billing is enabled, your safety API will work immediately!** 🎉

