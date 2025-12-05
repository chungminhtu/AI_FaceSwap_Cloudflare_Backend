const https = require('https');

async function getTokenId(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: '/client/v4/user/tokens/verify',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.success || !json.result?.id) {
            reject(new Error(`Failed to get token ID: ${JSON.stringify(json.errors || json)}`));
            return;
          }
          resolve(json.result.id);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function getAllEditPermissionGroups(token, accountId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${accountId}/tokens/permission_groups`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.success) {
            reject(new Error(`Failed to get permission groups: ${JSON.stringify(json.errors)}`));
            return;
          }
          const allGroups = json.result || [];
          const editGroups = allGroups.filter(g => {
            const name = (g.name || '').toLowerCase();
            return name.includes('edit') || name.includes('write');
          });
          resolve(editGroups);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function updateTokenWithAllEditPermissions(currentToken, accountId, fallbackTokens = []) {
  const tokenId = await getTokenId(currentToken);
  
  let editGroups;
  let permissionGroupsError = null;
  
  try {
    editGroups = await getAllEditPermissionGroups(currentToken, accountId);
  } catch (error) {
    permissionGroupsError = error;
    
    if (fallbackTokens.length > 0) {
      for (const fallbackToken of fallbackTokens) {
        try {
          const fallbackAccountId = fallbackToken.accountId || accountId;
          editGroups = await getAllEditPermissionGroups(fallbackToken.token, fallbackAccountId);
          console.log(`✓ Using permission groups from fallback token (account: ${fallbackAccountId})`);
          break;
        } catch (e) {
          continue;
        }
      }
    }
    
    if (!editGroups || editGroups.length === 0) {
      throw new Error(
        `Cannot get permission groups. Current token error: ${permissionGroupsError.message}. ` +
        `Please ensure your token has access to read permission groups, or provide a working ` +
        `fallback token with permission to read permission groups.`
      );
    }
  }
  
  if (editGroups.length === 0) {
    throw new Error('No edit permission groups found');
  }

  const tokenData = {
    policies: [{
      effect: 'allow',
      permission_groups: editGroups.map(g => ({ id: g.id })),
      resources: {
        [`com.cloudflare.api.account.${accountId}`]: '*'
      }
    }]
  };

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(tokenData);
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/user/tokens/${tokenId}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.success) {
            reject(new Error(`Failed to update token: ${JSON.stringify(json.errors)}`));
            return;
          }
          resolve(json.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(postData);
    req.end();
  });
}

if (require.main === module) {
  (async () => {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    
    if (!token) {
      console.error('Error: CLOUDFLARE_API_TOKEN environment variable required');
      process.exit(1);
    }
    
    if (!accountId) {
      console.error('Error: CLOUDFLARE_ACCOUNT_ID environment variable required');
      process.exit(1);
    }
    
    try {
      console.log('🔄 Updating token with all edit permissions...');
      await updateTokenWithAllEditPermissions(token, accountId);
      console.log('✅ Token updated successfully with all edit permissions!');
    } catch (error) {
      console.error('❌ Failed to update token:', error.message);
      process.exit(1);
    }
  })();
}

module.exports = { updateTokenWithAllEditPermissions, getTokenId, getAllEditPermissionGroups };

