#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEPLOYMENTS_FILE = path.join(__dirname, '../_deploy-cli-cloudflare-gcp/deployments-secrets.json');

function getDeploymentConfig(env) {
  const config = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, 'utf8'));
  return config.environments[env];
}

async function clearKVCache(env = 'ai-office-dev') {
  const config = getDeploymentConfig(env);
  if (!config) {
    console.error(`Environment "${env}" not found`);
    process.exit(1);
  }

  const namespaceName = config.promptCacheKV?.namespaceName;
  if (!namespaceName) {
    console.error(`KV namespace not configured for environment "${env}"`);
    process.exit(1);
  }

  const accountId = config.cloudflare.accountId;
  const apiToken = config.cloudflare.apiToken;

  console.log(`Clearing KV cache for environment: ${env}`);
  console.log(`Namespace: ${namespaceName}`);
  console.log(`Account ID: ${accountId}`);
  console.log('');

  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`;

  let namespaceId = null;
  try {
    const listResponse = await fetch(baseUrl, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!listResponse.ok) {
      throw new Error(`Failed to list namespaces: ${listResponse.status} ${listResponse.statusText}`);
    }

    const namespaces = await listResponse.json();
    const namespace = namespaces.result?.find(n => n.title === namespaceName);
    
    if (!namespace) {
      throw new Error(`Namespace "${namespaceName}" not found`);
    }

    namespaceId = namespace.id;
    console.log(`Found namespace ID: ${namespaceId}`);
  } catch (error) {
    console.error(`Error finding namespace:`, error.message);
    process.exit(1);
  }

  let deletedCount = 0;
  let cursor = null;
  let hasMore = true;

  console.log('Deleting keys...');
  
  while (hasMore) {
    try {
      const listUrl = `${baseUrl}/${namespaceId}/keys${cursor ? `?cursor=${cursor}` : ''}`;
      const listResponse = await fetch(listUrl, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!listResponse.ok) {
        throw new Error(`Failed to list keys: ${listResponse.status} ${listResponse.statusText}`);
      }

      const data = await listResponse.json();
      const keys = data.result || [];
      cursor = data.result_info?.cursor;
      hasMore = !!cursor && keys.length > 0;

      if (keys.length === 0) {
        hasMore = false;
        break;
      }

      for (const key of keys) {
        try {
          const deleteUrl = `${baseUrl}/${namespaceId}/values/${encodeURIComponent(key.name)}`;
          const deleteResponse = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Content-Type': 'application/json'
            }
          });

          if (deleteResponse.ok) {
            deletedCount++;
            process.stdout.write(`\rDeleted: ${deletedCount} keys`);
          } else {
            console.error(`\nFailed to delete key "${key.name}": ${deleteResponse.status}`);
          }
        } catch (error) {
          console.error(`\nError deleting key "${key.name}":`, error.message);
        }
      }
    } catch (error) {
      console.error(`\nError listing keys:`, error.message);
      hasMore = false;
    }
  }

  console.log(`\n\nDone! Deleted ${deletedCount} keys from KV cache.`);
}

const env = process.argv[2] || 'ai-office-dev';
clearKVCache(env).catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
