// list-r2-objects.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const secretsPath = path.join(__dirname, 'deployments-secrets.json');
const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));

const env = process.argv[2] || 'ai-office';
const bucketName = process.argv[3] || 'my-bucket';
const prefix = process.argv[4] || '';

const envConfig = secrets.environments?.[env];
if (!envConfig?.cloudflare) {
  console.error(`No Cloudflare config found for environment: ${env}`);
  process.exit(1);
}

const { apiToken, accountId } = envConfig.cloudflare;
if (!apiToken || !accountId) {
  console.error(`Missing API token or account ID for environment: ${env}`);
  process.exit(1);
}

process.env.CLOUDFLARE_API_TOKEN = apiToken;
process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

const prefixParam = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects${prefixParam}`;

try {
  const result = execSync(
    `curl -s -X GET "${url}" -H "Authorization: Bearer ${apiToken}" -H "Content-Type: application/json"`,
    { encoding: 'utf8' }
  );
  const data = JSON.parse(result);
  if (data.success) {
    console.log(JSON.stringify(data.result, null, 2));
  } else {
    console.error('Error:', JSON.stringify(data.errors, null, 2));
    process.exit(1);
  }
} catch (error) {
  console.error('Failed to list objects:', error.message);
  process.exit(1);
}

