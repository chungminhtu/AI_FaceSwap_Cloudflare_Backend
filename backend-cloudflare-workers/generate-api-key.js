// backend-cloudflare-workers/generate-api-key.js
// Generate secure API key for mobile API authentication

const crypto = require('crypto');

// Generate 32 bytes (256 bits) of random data
const key = crypto.randomBytes(32).toString('base64url');

console.log('='.repeat(60));
console.log('Generated Mobile API Key:');
console.log('='.repeat(60));
console.log(key);
console.log('='.repeat(60));
console.log('\nAdd this to deployments-secrets.json:');
console.log(`  "MOBILE_API_KEY": "${key}"`);
console.log(`  "ENABLE_MOBILE_API_KEY_AUTH": "true"`);
console.log('\nOr with prefix (optional):');
console.log(`  "MOBILE_API_KEY": "sk_live_${key}"`);
console.log('='.repeat(60));
