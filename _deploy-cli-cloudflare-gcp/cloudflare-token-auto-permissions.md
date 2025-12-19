# Cloudflare API Token Auto-Permissions

## Problem

`wrangler login` uses OAuth tokens that expire quickly, requiring frequent re-authentication for deployments.

## Solution

Create a minimal API token with **"User API Tokens:Edit"** permission, then programmatically update it with ALL edit/write permissions. This token never expires and can be reused for all future deployments.

## Prerequisites

- Cloudflare Account ID
- API Token with **"User API Tokens:Edit"** permission (created manually once)

## Environment Variables

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
```

---

## API Endpoints

### 1. Verify Token & Get Token ID

```bash
curl -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "result": {
    "id": "token-id-here",
    "status": "active"
  }
}
```

### 2. Get All Permission Groups

```bash
curl -X GET "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/permission_groups" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json"
```

**Response:** Array of permission groups. Filter for names containing "edit" or "write".

### 3. Update Token with All Edit Permissions

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/user/tokens/{tokenId}" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "policies": [{
      "effect": "allow",
      "permission_groups": [
        {"id": "permission-group-id-1"},
        {"id": "permission-group-id-2"}
      ],
      "resources": {
        "com.cloudflare.api.account.YOUR_ACCOUNT_ID": "*"
      }
    }]
  }'
```

---

## Node.js Implementation

```javascript
#!/usr/bin/env node
const https = require('https');

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) {
  console.error('Required: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
  process.exit(1);
}

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(postData && { 'Content-Length': Buffer.byteLength(postData) })
      },
      ...options
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          json.success ? resolve(json.result) : reject(new Error(JSON.stringify(json.errors)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

async function getTokenId() {
  const result = await request({ path: '/client/v4/user/tokens/verify', method: 'GET' });
  if (!result?.id) throw new Error('Failed to get token ID');
  return result.id;
}

async function getEditPermissionGroups() {
  const groups = await request({
    path: `/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens/permission_groups`,
    method: 'GET'
  });
  return (groups || []).filter(g => {
    const name = (g.name || '').toLowerCase();
    return name.includes('edit') || name.includes('write');
  });
}

async function updateTokenPermissions(tokenId, permissionGroups) {
  const payload = JSON.stringify({
    policies: [{
      effect: 'allow',
      permission_groups: permissionGroups.map(g => ({ id: g.id })),
      resources: { [`com.cloudflare.api.account.${CLOUDFLARE_ACCOUNT_ID}`]: '*' }
    }]
  });
  return request({ path: `/client/v4/user/tokens/${tokenId}`, method: 'PUT' }, payload);
}

async function main() {
  console.log('🔄 Getting token ID...');
  const tokenId = await getTokenId();
  console.log(`✓ Token ID: ${tokenId}`);

  console.log('🔄 Fetching edit permission groups...');
  const editGroups = await getEditPermissionGroups();
  console.log(`✓ Found ${editGroups.length} edit/write permission groups`);

  console.log('🔄 Updating token with all edit permissions...');
  await updateTokenPermissions(tokenId, editGroups);
  console.log('✅ Token updated successfully!');
  console.log('\nThis token can now deploy Workers, D1, R2, Pages, KV, etc.');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
```

---

## Usage

### 1. Create Initial Token (One-time, Manual)

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Add permission: **User API Tokens → Edit**
4. Set Account Resources: Include your account
5. Create and copy token

### 2. Update Token with Full Permissions

```bash
export CLOUDFLARE_API_TOKEN="your-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
node update-token.js
```

### 3. Use for Deployments

```bash
# Token now has all permissions - use with wrangler
wrangler deploy
wrangler d1 create my-db
wrangler r2 bucket create my-bucket
wrangler pages deploy ./dist
```

---

## Integration with Wrangler

After token is updated, create `wrangler.jsonc` in project root:

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01",
  "account_id": "$CLOUDFLARE_ACCOUNT_ID",
  "d1_databases": [{ "binding": "DB", "database_name": "my-db" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "my-bucket" }]
}
```

Deploy:
```bash
wrangler deploy
```

---

## Key Points

| Aspect | Detail |
|--------|--------|
| **Initial Permission** | Only "User API Tokens:Edit" needed |
| **After Update** | Token has ALL edit/write permissions |
| **Expiration** | Token never expires (unless manually revoked) |
| **Re-authentication** | Never needed - use same token forever |
| **Scope** | Account-level (all resources in that account) |

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Failed to get token ID` | Invalid token | Check token is correct, not expired |
| `Failed to get permission groups` | Token lacks read permission | Ensure token has "User API Tokens:Edit" |
| `Failed to update token` | Token can't modify itself | Token must have "User API Tokens:Edit" |
| `Account not found` | Wrong account ID | Verify CLOUDFLARE_ACCOUNT_ID |
