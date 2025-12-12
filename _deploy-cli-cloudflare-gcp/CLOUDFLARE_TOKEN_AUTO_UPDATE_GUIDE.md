# Cloudflare API Token Auto-Update Solution Architecture

## Problem Statement

Cloudflare API tokens need specific permissions to perform deployment operations (D1, R2, Workers, Pages, etc.). Manually configuring tokens with all required permissions is:
- Time-consuming
- Error-prone
- Requires deep knowledge of Cloudflare permission structure
- Needs to be repeated for each new token/environment

## Solution Architecture

### Overview
Automatically update an existing Cloudflare API token with all "Edit" and "Write" permissions during deployment, eliminating manual permission configuration.

### Key Components

1. **Token ID Resolution**: Get the token's internal ID from Cloudflare
2. **Permission Group Discovery**: Fetch all available "Edit" and "Write" permission groups
3. **Token Update**: Update the token via Cloudflare API with all discovered permissions
4. **Fallback Mechanism**: Use tokens from other environments if current token can't read permission groups

### Architecture Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Deployment Script Starts                                    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  setupCloudflare(env)                                       │
│  - Reads token from config                                  │
│  - Validates token                                          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  updateTokenWithAllEditPermissions(token, accountId)       │
│                                                              │
│  Step 1: getTokenId(token)                                  │
│  └─> GET /client/v4/user/tokens/verify                      │
│                                                              │
│  Step 2: getAllEditPermissionGroups(token, accountId)       │
│  └─> GET /client/v4/accounts/{accountId}/tokens/            │
│      permission_groups                                       │
│  └─> Filter: name includes "edit" or "write"                │
│                                                              │
│  Step 3: PUT /client/v4/user/tokens/{tokenId}                │
│  └─> Body: { policies: [{ effect: "allow",                  │
│                           permission_groups: [...],         │
│                           resources: {...} }] }             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Token Updated with Full Permissions                        │
│  - All Edit/Write permissions assigned                      │
│  - Account-scoped resources configured                      │
└─────────────────────────────────────────────────────────────┘
```

## System Flow Diagrams (Mermaid)

### Complete System Flow

```mermaid
flowchart TD
    A[Deployment Script Starts] --> B[Load Config from deployments-secrets.json]
    B --> C{Environment Selected?}
    C -->|DEPLOY_ENV=ai-office| D[Load ai-office Config]
    C -->|DEPLOY_ENV=ai-office-dev| E[Load ai-office-dev Config]
    C -->|Default| F[Load production Config]
    
    D --> G[Extract Token & Account ID]
    E --> G
    F --> G
    
    G --> H[setupCloudflare]
    H --> I[Validate Token]
    I -->|Invalid| J[Error: Token Invalid]
    I -->|Valid| K[updateTokenWithAllEditPermissions]
    
    K --> L[getTokenId]
    L --> M[GET /user/tokens/verify]
    M -->|Success| N[Extract Token ID]
    M -->|Error| O[Error: Cannot Get Token ID]
    
    N --> P[getAllEditPermissionGroups]
    P --> Q["GET /accounts/[id]/tokens/permission_groups"]
    Q -->|Success| R[Filter Edit/Write Groups]
    Q -->|Error| S[Try Fallback Tokens]
    
    S --> T{Has Fallback Tokens?}
    T -->|Yes| U[Try Each Fallback Token]
    T -->|No| V[Error: Cannot Get Permission Groups]
    U -->|Success| R
    U -->|All Failed| V
    
    R --> W[Build Token Update Payload]
    W --> X["PUT /user/tokens/[tokenId]"]
    X -->|Success| Y[Token Updated with Full Permissions]
    X -->|Error| Z[Error: Update Failed]
    
    Y --> AA[Set Environment Variables]
    AA --> AB[CLOUDFLARE_API_TOKEN]
    AA --> AC[CLOUDFLARE_ACCOUNT_ID]
    
    AB --> AD[Continue Deployment]
    AC --> AD
    AD --> AE[Deploy D1, R2, Workers, Pages]
    
    style Y fill:#90EE90
    style J fill:#FFB6C1
    style O fill:#FFB6C1
    style V fill:#FFB6C1
    style Z fill:#FFB6C1
```

### Token Update Process Detail

```mermaid
sequenceDiagram
    participant DS as Deployment Script
    participant SC as setupCloudflare
    participant UT as updateTokenWithAllEditPermissions
    participant GTI as getTokenId
    participant GEPG as getAllEditPermissionGroups
    participant CF as Cloudflare API
    participant FT as Fallback Tokens
    
    DS->>SC: setupCloudflare(token, accountId)
    SC->>SC: Validate token exists
    SC->>UT: updateTokenWithAllEditPermissions(token, accountId)
    
    UT->>GTI: getTokenId(token)
    GTI->>CF: GET /user/tokens/verify
    CF-->>GTI: { success: true, result: { id: "..." } }
    GTI-->>UT: tokenId
    
    UT->>GEPG: getAllEditPermissionGroups(token, accountId)
    GEPG->>CF: GET /accounts/{accountId}/tokens/permission_groups
    CF-->>GEPG: { success: true, result: [groups...] }
    GEPG->>GEPG: Filter: name includes "edit" or "write"
    GEPG-->>UT: editGroups[]
    
    alt Permission Groups Fetch Failed
        UT->>FT: Try fallback tokens
        loop For each fallback token
            FT->>GEPG: getAllEditPermissionGroups(fallbackToken, accountId)
            GEPG->>CF: GET /accounts/{accountId}/tokens/permission_groups
            CF-->>GEPG: { success: true, result: [groups...] }
            GEPG-->>UT: editGroups[]
        end
    end
    
    UT->>UT: Build payload: { policies: [{ effect: "allow", permission_groups: [...], resources: {...} }] }
    UT->>CF: PUT /user/tokens/{tokenId}
    CF-->>UT: { success: true, result: {...} }
    UT-->>SC: Token updated successfully
    SC->>SC: Set process.env.CLOUDFLARE_API_TOKEN
    SC->>SC: Set process.env.CLOUDFLARE_ACCOUNT_ID
    SC-->>DS: Continue deployment
```

### Multi-Account Deployment Flow

```mermaid
flowchart LR
    subgraph "Environment Configuration"
        A1[deployments-secrets.json]
        A2[ai-office: Account 72474c35...]
        A3[ai-office-dev: Account d6bbe756...]
        A4[ai-office-prod: Account d6bbe756...]
        A1 --> A2
        A1 --> A3
        A1 --> A4
    end
    
    subgraph "Deployment 1: ai-office"
        B1[DEPLOY_ENV=ai-office]
        B2[Token: e-w5AMYn2...]
        B3[Account: 72474c350e3f...]
        B4[Update Token Permissions]
        B5[Deploy to Account 1]
        B1 --> B2
        B2 --> B3
        B3 --> B4
        B4 --> B5
    end
    
    subgraph "Deployment 2: ai-office-dev"
        C1[DEPLOY_ENV=ai-office-dev]
        C2[Token: B5PlRHyElt...]
        C3[Account: d6bbe756fe7a...]
        C4[Update Token Permissions]
        C5[Deploy to Account 2]
        C1 --> C2
        C2 --> C3
        C3 --> C4
        C4 --> C5
    end
    
    A2 -.->|Config| B1
    A3 -.->|Config| C1
    
    B5 --> D1[Worker:  .workers.dev]
    C5 --> D2[Worker:  .workers.dev]
    
    style B5 fill:#87CEEB
    style C5 fill:#87CEEB
    style D1 fill:#90EE90
    style D2 fill:#90EE90
```

### Fallback Token Mechanism

```mermaid
flowchart TD
    A[updateTokenWithAllEditPermissions] --> B[Try getTokenId with current token]
    B -->|Success| C[Try getAllEditPermissionGroups with current token]
    B -->|Error| Z[Error: Invalid Token]
    
    C -->|Success| D[Filter Edit/Write Groups]
    C -->|Error| E[Permission Groups Fetch Failed]
    
    E --> F{Has Fallback Tokens?}
    F -->|No| G[Error: Cannot Get Permission Groups]
    F -->|Yes| H[Load Fallback Tokens from Config]
    
    H --> I[Loop Through Fallback Tokens]
    I --> J[Try getAllEditPermissionGroups with Fallback Token]
    J -->|Success| D
    J -->|Error| K{More Fallback Tokens?}
    K -->|Yes| I
    K -->|No| G
    
    D --> L{Edit Groups Found?}
    L -->|No| M[Error: No Edit Groups Found]
    L -->|Yes| N[Build Token Update Payload]
    
    N --> O["PUT /user/tokens/[tokenId]"]
    O -->|Success| P[Token Updated Successfully]
    O -->|Error| Q[Error: Update Failed]
    
    style P fill:#90EE90
    style Z fill:#FFB6C1
    style G fill:#FFB6C1
    style M fill:#FFB6C1
    style Q fill:#FFB6C1
```

### API Interaction Flow

```mermaid
sequenceDiagram
    participant App as Application
    participant API as Cloudflare API
    
    Note over App,API: Step 1: Get Token ID
    App->>API: GET /client/v4/user/tokens/verify<br/>Authorization: Bearer {token}
    API-->>App: { success: true, result: { id: "abc123", ... } }
    
    Note over App,API: Step 2: Get Permission Groups
    App->>API: GET /client/v4/accounts/{accountId}/tokens/permission_groups<br/>Authorization: Bearer {token}
    API-->>App: { success: true, result: [<br/>  { id: "pg1", name: "Zone:Edit" },<br/>  { id: "pg2", name: "D1:Write" },<br/>  { id: "pg3", name: "R2:Edit" },<br/>  ...<br/>] }
    
    Note over App,API: Step 3: Filter Edit/Write Groups
    App->>App: Filter: name.includes("edit") || name.includes("write")
    
    Note over App,API: Step 4: Update Token
    App->>API: PUT /client/v4/user/tokens/{tokenId}<br/>Authorization: Bearer {token}<br/>Body: {<br/>  policies: [{<br/>    effect: "allow",<br/>    permission_groups: [{ id: "pg1" }, { id: "pg2" }, ...],<br/>    resources: {<br/>      "com.cloudflare.api.account.{accountId}": "*"<br/>    }<br/>  }]<br/>}
    API-->>App: { success: true, result: { ... } }
    
    Note over App,API: Token now has all edit/write permissions
```

### Component Architecture

```mermaid
graph TB
    subgraph "Configuration Layer"
        CFG[deployments-secrets.json]
        ENV[DEPLOY_ENV Environment Variable]
    end
    
    subgraph "Core Functions"
        GTI[getTokenId]
        GEPG[getAllEditPermissionGroups]
        UT[updateTokenWithAllEditPermissions]
    end
    
    subgraph "Integration Layer"
        SC[setupCloudflare]
        LC[loadConfig]
        PC[parseConfig]
    end
    
    subgraph "Cloudflare API"
        API1["/user/tokens/verify"]
        API2["/accounts/[id]/tokens/permission_groups"]
        API3["/user/tokens/[id]"]
    end
    
    subgraph "Deployment Layer"
        DD1[D1 Database]
        DR2[R2 Bucket]
        DW[Workers]
        DP[Pages]
    end
    
    ENV --> LC
    CFG --> LC
    LC --> PC
    PC --> SC
    
    SC --> UT
    UT --> GTI
    UT --> GEPG
    
    GTI --> API1
    GEPG --> API2
    UT --> API3
    
    SC --> DD1
    SC --> DR2
    SC --> DW
    SC --> DP
    
    style UT fill:#FFD700
    style SC fill:#87CEEB
    style API3 fill:#90EE90
```

## Implementation Guide

### Prerequisites

- Node.js with `https` module (built-in)
- Cloudflare API token (can be minimal initially)
- Account ID where token will be used

### Step 1: Core Functions

#### 1.1 Get Token ID

```javascript
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
```

#### 1.2 Get All Edit Permission Groups

```javascript
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
```

#### 1.3 Update Token with All Edit Permissions

```javascript
const fs = require('fs');
const path = require('path');

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
```

### Step 2: Integration Example

#### 2.1 Standalone Script

```javascript
const https = require('https');

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN || 'YOUR_TOKEN_HERE';
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || 'YOUR_ACCOUNT_ID_HERE';
  
  if (!token || token === 'YOUR_TOKEN_HERE') {
    console.error('Error: CLOUDFLARE_API_TOKEN environment variable required');
    process.exit(1);
  }
  
  if (!accountId || accountId === 'YOUR_ACCOUNT_ID_HERE') {
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
}

if (require.main === module) {
  main();
}

module.exports = { updateTokenWithAllEditPermissions, getTokenId, getAllEditPermissionGroups };
```

#### 2.2 Integration into Deployment Script

```javascript
async function setupCloudflare(token, accountId, fallbackTokens = []) {
  console.log('Setting up Cloudflare credentials...');
  
  if (!token) {
    throw new Error('API token is required');
  }
  
  if (!accountId) {
    throw new Error('Account ID is required');
  }
  
  console.log('Updating API token with all edit permissions...');
  try {
    await updateTokenWithAllEditPermissions(token, accountId, fallbackTokens);
    console.log('✅ Token updated with all edit permissions');
    
    process.env.CLOUDFLARE_API_TOKEN = token;
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
    
    return { accountId, apiToken: token };
  } catch (error) {
    throw new Error(
      `Failed to update token with all edit permissions: ${error.message}. ` +
      `Please ensure your token has "User API Tokens:Edit" permission.`
    );
  }
}
```

### Step 3: Usage Examples

#### 3.1 Command Line Usage

```bash
# Set environment variables
export CLOUDFLARE_API_TOKEN="your-token-here"
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"

# Run the update script
node update-token-permissions.js
```

#### 3.2 Programmatic Usage

```javascript
const { updateTokenWithAllEditPermissions } = require('./cloudflare-token-updater');

async function deploy() {
  const token = 'your-token-here';
  const accountId = 'your-account-id-here';
  
  await updateTokenWithAllEditPermissions(token, accountId);
  
  process.env.CLOUDFLARE_API_TOKEN = token;
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  
  // Continue with deployment...
}
```

#### 3.3 With Fallback Tokens

```javascript
const fallbackTokens = [
  { token: 'token-from-env-1', accountId: 'account-1' },
  { token: 'token-from-env-2', accountId: 'account-2' }
];

await updateTokenWithAllEditPermissions(currentToken, accountId, fallbackTokens);
```

## API Endpoints Reference

### 1. Get Token ID
- **Endpoint**: `GET /client/v4/user/tokens/verify`
- **Headers**: `Authorization: Bearer {token}`
- **Response**: `{ success: true, result: { id: "token-id", ... } }`

### 2. Get Permission Groups
- **Endpoint**: `GET /client/v4/accounts/{accountId}/tokens/permission_groups`
- **Headers**: `Authorization: Bearer {token}`
- **Response**: `{ success: true, result: [{ id: "...", name: "...", ... }, ...] }`

### 3. Update Token
- **Endpoint**: `PUT /client/v4/user/tokens/{tokenId}`
- **Headers**: `Authorization: Bearer {token}`, `Content-Type: application/json`
- **Body**:
```json
{
  "policies": [{
    "effect": "allow",
    "permission_groups": [
      { "id": "permission-group-id-1" },
      { "id": "permission-group-id-2" }
    ],
    "resources": {
      "com.cloudflare.api.account.{accountId}": "*"
    }
  }]
}
```

## Error Handling

### Common Errors

1. **"Failed to get token ID"**
   - **Cause**: Invalid or expired token
   - **Solution**: Verify token is valid and not expired

2. **"Failed to get permission groups"**
   - **Cause**: Token lacks permission to read permission groups
   - **Solution**: Use fallback token mechanism or ensure token has basic read permissions

3. **"Failed to update token: effect must be present"**
   - **Cause**: Missing `effect: "allow"` in policy
   - **Solution**: Ensure policy includes `effect: "allow"`

4. **"account is not a valid resource name"**
   - **Cause**: Incorrect resource format
   - **Solution**: Use format `com.cloudflare.api.account.{accountId}` not `account: { id: ... }`

5. **"Token lacks permission to update itself"**
   - **Cause**: Token doesn't have "User API Tokens:Edit" permission
   - **Solution**: Token must have at least "User API Tokens:Edit" to update itself

## Security Considerations

1. **Token Storage**: Never commit tokens to version control. Use environment variables or secure secret management.

2. **Token Permissions**: The token being updated must have "User API Tokens:Edit" permission to update itself.

3. **Account Scoping**: Permissions are scoped to the specific account ID. Ensure you're using the correct account.

4. **Fallback Tokens**: Fallback tokens should be from trusted sources and have appropriate permissions.

## Testing

### Test Token Update

```javascript
async function testTokenUpdate() {
  const token = process.env.TEST_TOKEN;
  const accountId = process.env.TEST_ACCOUNT_ID;
  
  try {
    console.log('Testing token update...');
    const result = await updateTokenWithAllEditPermissions(token, accountId);
    console.log('✅ Test passed:', result);
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    throw error;
  }
}
```

### Verify Token Permissions

```bash
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  | jq '.result.permissions'
```

## Complete Standalone Implementation

Save as `cloudflare-token-updater.js`:

```javascript
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
```

## Summary

This solution automatically updates Cloudflare API tokens with all necessary edit/write permissions during deployment, eliminating manual configuration. The implementation:

1. **Fetches all edit/write permission groups** from Cloudflare API
2. **Updates the token** with all discovered permissions
3. **Supports fallback tokens** if current token can't read permission groups
4. **Requires minimal initial permissions** (just "User API Tokens:Edit" to update itself)

The token in your configuration file doesn't need full permissions initially - the code updates it automatically during deployment.


---

# System Requirements & User Journey Guide

## Physical Machine Requirements

### Minimum Hardware Specifications

**For Development/Testing:**
- **CPU**: 2 cores (Intel/AMD x64 or Apple Silicon M1/M2)
- **RAM**: 4 GB minimum, 8 GB recommended
- **Storage**: 5 GB free disk space
- **Network**: Stable internet connection (minimum 5 Mbps)

**For Production Deployments:**
- **CPU**: 4+ cores recommended
- **RAM**: 8 GB minimum, 16 GB recommended
- **Storage**: 10 GB free disk space
- **Network**: Reliable internet connection (10+ Mbps recommended)

### Operating System Support

**Supported Operating Systems:**
- ✅ **macOS**: 10.15 (Catalina) or later (Intel/Apple Silicon)
- ✅ **Linux**: Ubuntu 18.04+, Debian 10+, CentOS 7+, or any modern Linux distribution
- ✅ **Windows**: Windows 10/11 (using WSL 2 recommended) or Windows Server 2019+

**Recommended:**
- macOS 12+ (Monterey) or later
- Ubuntu 20.04 LTS or later
- Windows 11 with WSL 2 (Ubuntu 20.04)

### Required Software

1. **Node.js**: Version 16.x or higher (18.x LTS recommended)
2. **npm**: Version 8.x or higher (comes with Node.js)
3. **Git**: Version 2.20+ (for cloning repositories)
4. **Text Editor**: VS Code, Vim, Nano, or any code editor

### Optional but Recommended

- **Cloudflare Wrangler CLI**: For manual testing (installed automatically by script)
- **Google Cloud SDK (gcloud)**: If deploying to GCP services
- **curl**: For API testing
- **jq**: For JSON parsing in terminal

---

## Environment Setup Guide

### Step 1: Install Node.js

**macOS (using Homebrew):**
```bash
# Install Homebrew if not installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js
brew install node@18

# Verify installation
node --version  # Should show v18.x.x or higher
npm --version   # Should show 8.x.x or higher
```

**Linux (Ubuntu/Debian):**
```bash
# Update package list
sudo apt update

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
npm --version
```

**Windows:**
1. Download Node.js installer from https://nodejs.org/
2. Run installer (choose LTS version 18.x or higher)
3. Verify in PowerShell:
```powershell
node --version
npm --version
```

### Step 2: Clone or Download Project

```bash
# If using Git
git clone <your-repository-url>
cd <project-directory>

# Or download and extract ZIP file
# Then navigate to project directory
cd <project-directory>
```

### Step 3: Install Project Dependencies

```bash
# Install npm packages (if package.json exists)
npm install

# Or if no package.json, ensure you have the required files:
# - deploy.js
# - cloudflare-token-updater.js
# - deployments-secrets.json (create this)
```

### Step 4: Create Configuration File

Create `deployments-secrets.json` in `_deploy-cli-cloudflare-gcp/` directory:

```bash
mkdir -p _deploy-cli-cloudflare-gcp
cd _deploy-cli-cloudflare-gcp
```

Create `deployments-secrets.json` with this structure:

```json
{
  "environments": {
    "production": {
      "name": "production",
      "workerName": "your-worker-name",
      "pagesProjectName": "your-pages-project",
      "databaseName": "your-database-name",
      "bucketName": "your-bucket-name",
      "cloudflare": {
        "accountId": "your-cloudflare-account-id",
        "apiToken": "your-cloudflare-api-token"
      }
    }
  }
}
```

### Step 5: Get Cloudflare Credentials

**Getting Account ID:**
1. Log in to Cloudflare Dashboard: https://dash.cloudflare.com/
2. Select your account
3. Copy Account ID from right sidebar (or from URL: `dash.cloudflare.com/{accountId}/...`)

**Creating API Token:**
1. Go to: https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use "Edit Cloudflare Workers" template OR create custom token with:
   - **Permission**: "User API Tokens:Edit" (minimum required)
   - **Account Resources**: Include your account
4. Copy the token immediately (you won't see it again!)

### Step 6: Set Up Environment Variables (Optional)

You can set environment variables instead of using config file:

```bash
# macOS/Linux
export CLOUDFLARE_API_TOKEN="your-token-here"
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
export DEPLOY_ENV="production"

# Windows (PowerShell)
$env:CLOUDFLARE_API_TOKEN="your-token-here"
$env:CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
$env:DEPLOY_ENV="production"
```

---

## Complete User Journey: Deployment Process

### Pre-Deployment Checklist

Before starting deployment, the user should verify:

- [ ] Node.js is installed and working
- [ ] Project files are in place
- [ ] `deployments-secrets.json` is configured
- [ ] Cloudflare API token is valid
- [ ] Account ID is correct
- [ ] Internet connection is stable
- [ ] Terminal/Command Prompt is ready

### User Journey: First-Time Deployment

#### **Step 1: User Opens Terminal**

**What the user sees:**
```
$ cd /path/to/project
$ ls
deploy.js  deployments-secrets.json  ...
```

**What the user does:**
- Navigates to project directory
- Verifies files are present

---

#### **Step 2: User Reviews Configuration**

**What the user sees:**
```bash
$ cat deployments-secrets.json
{
  "environments": {
    "production": {
      "cloudflare": {
        "accountId": "72474c350e3f55d96195536a5d39e00d",
        "apiToken": "e-w5AMYn2MgkR7nt-VjKAqNbjDgvTX7tWSU0K0Nr"
      }
    }
  }
}
```

**What the user does:**
- Opens `deployments-secrets.json` in editor
- Verifies account ID and token are correct
- Saves file if changes were made

**User's mental state:**
- "Is my token correct?"
- "Do I have the right account ID?"
- "Are all my settings correct?"

---

#### **Step 3: User Runs Deployment Command**

**What the user types:**
```bash
$ DEPLOY_ENV=production DEPLOY_PAGES=true node _deploy-cli-cloudflare-gcp/deploy.js
```

**What the user sees (Initial Output):**
```
╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
║  📊 Deployment Progress                                                                         ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════╝

[1/10] ⏳ Loading configuration...
[2/10] ⏳ Checking prerequisites...
[3/10] ⏳ Authenticating with GCP...
[4/10] ⏳ Checking GCP APIs...
[5/10] ⏳ Setting up Cloudflare credentials...
[6/10] ⏳ [Cloudflare] R2 Bucket: faceswap-images...
[7/10] ⏳ [Cloudflare] D1 Database: faceswap-db...
[8/10] ⏳ Deploying secrets...
[9/10] ⏳ Deploying worker...
[10/10] ⏳ Deploying frontend...
```

**What the user does:**
- Waits and watches the progress
- May feel anxious if it's first time
- Watches for any error messages

**User's mental state:**
- "Is it working?"
- "How long will this take?"
- "I hope nothing breaks..."

---

#### **Step 4: Token Update Process (Automatic)**

**What the user sees:**
```
[5/10] 🔄 Setting up Cloudflare credentials...
      ⚠️  Updating API token with all edit permissions...
      🔄 Getting token ID...
      ✓ Token ID retrieved: abc123def456
      🔄 Fetching permission groups...
      ✓ Found 45 edit/write permission groups
      🔄 Updating token permissions...
      ✓ Token updated with all edit permissions
      ✓ Using API token for account 72474c350e3f55d96195536a5d39e00d
```

**What happens (behind the scenes):**
- Script calls `getTokenId()` → Gets token ID from Cloudflare
- Script calls `getAllEditPermissionGroups()` → Fetches all edit permissions
- Script calls `updateTokenWithAllEditPermissions()` → Updates token via API
- Token now has full permissions

**What the user does:**
- Observes the automatic process
- May not fully understand what's happening (that's okay!)
- Sees success messages

**User's mental state:**
- "It's doing something with my token..."
- "Good, it says 'updated successfully'"
- "I hope this works..."

---

#### **Step 5: Database Setup (Automatic)**

**What the user sees:**
```
[7/10] 🔄 [Cloudflare] D1 Database: faceswap-db...
      🔄 Checking if database exists...
      ✓ Database exists
      🔄 Applying schema migrations...
      ✓ Added column: profile_id
      ✓ Added column: preset_id
      ✓ Schema updated successfully
```

**What happens (behind the scenes):**
- Script checks if D1 database exists
- If exists, checks schema and adds missing columns
- If not exists, creates database and applies full schema

**What the user does:**
- Watches progress
- Sees database operations completing

**User's mental state:**
- "Database is being set up..."
- "Good, it's adding the columns I need"

---

#### **Step 6: R2 Bucket Setup (Automatic)**

**What the user sees:**
```
[6/10] 🔄 [Cloudflare] R2 Bucket: faceswap-images...
      🔄 Checking if bucket exists...
      ✓ Bucket exists
      ✓ R2 bucket ready
```

**What happens (behind the scenes):**
- Script checks if R2 bucket exists
- Creates bucket if it doesn't exist
- Verifies bucket is accessible

**What the user does:**
- Observes the process
- Sees success confirmation

---

#### **Step 7: Secrets Deployment (Automatic)**

**What the user sees:**
```
[8/10] 🔄 Deploying secrets...
      🔄 Setting secret: RAPIDAPI_KEY
      ✓ Secret set: RAPIDAPI_KEY
      🔄 Setting secret: GOOGLE_VISION_API_KEY
      ✓ Secret set: GOOGLE_VISION_API_KEY
      ✓ All secrets deployed
```

**What happens (behind the scenes):**
- Script reads secrets from config
- Uses `wrangler secret put` to set each secret
- Verifies secrets are set

**What the user does:**
- Watches secrets being set
- May feel relieved if sensitive data is handled correctly

---

#### **Step 8: Worker Deployment (Automatic)**

**What the user sees:**
```
[9/10] 🔄 Deploying worker...
      🔄 Building worker...
      ✓ Worker built successfully
      🔄 Uploading to Cloudflare...
      ✓ Worker deployed: https://your-worker.your-subdomain.workers.dev
```

**What happens (behind the scenes):**
- Script builds worker code
- Uploads to Cloudflare Workers
- Configures routes and bindings
- Returns worker URL

**What the user does:**
- Waits for deployment
- Gets excited when URL appears
- May copy URL to test

**User's mental state:**
- "Almost done!"
- "I can see my worker URL!"
- "Let me test it when it's done"

---

#### **Step 9: Frontend Deployment (Automatic)**

**What the user sees:**
```
[10/10] 🔄 Deploying frontend...
       🔄 Uploading frontend files...
       ✓ Frontend deployed: https://your-project.pages.dev
```

**What happens (behind the scenes):**
- Script uploads frontend files to Cloudflare Pages
- Configures build settings
- Returns Pages URL

**What the user does:**
- Sees final deployment step
- Gets frontend URL
- May open URL in browser immediately

---

#### **Step 10: Deployment Complete**

**What the user sees:**
```
╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
║  📊 Deployment Summary                                                                          ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════╝

✓ Deployment completed successfully!

Backend Worker: https://your-worker.your-subdomain.workers.dev
Frontend Pages: https://your-project.pages.dev

Progress: ████████████████████████████████████ 100%
Summary: 10✓ 0✗ 0⚠ 0⟳ 0⊘ | 10 total
Elapsed: 45.3s
```

**What the user does:**
- Reads the summary
- Copies URLs to test
- Feels accomplished!
- May share URLs with team

**User's mental state:**
- "Success! Everything worked!"
- "Let me test these URLs"
- "I should save these URLs somewhere"
- "That was easier than I thought!"

---

### User Journey: Subsequent Deployments

For subsequent deployments, the user journey is simpler:

#### **Step 1: User Makes Code Changes**

**What the user does:**
- Edits code files
- Tests locally (optional)
- Commits changes (optional)

#### **Step 2: User Runs Same Command**

```bash
$ DEPLOY_ENV=production DEPLOY_PAGES=true node _deploy-cli-cloudflare-gcp/deploy.js
```

**What the user sees:**
- Same progress indicators
- Faster execution (token already has permissions)
- Updated URLs (if changed)

**User's mental state:**
- "This is routine now"
- "I know what to expect"
- "It should work like last time"

---

### User Journey: Multi-Account Deployment

#### **Scenario: Deploying to Development Environment**

**Step 1: User Sets Environment Variable**
```bash
$ DEPLOY_ENV=ai-office-dev node _deploy-cli-cloudflare-gcp/deploy.js
```

**What the user sees:**
```
[5/10] 🔄 Setting up Cloudflare credentials...
      ✓ Using account: d6bbe756fe7a10cc4982a882cd98c9c8
      ✓ Token updated with all edit permissions
```

**What happens:**
- Script reads `ai-office-dev` config from `deployments-secrets.json`
- Uses different account ID and token
- Updates that token's permissions
- Deploys to different account

**User's mental state:**
- "I'm deploying to dev now"
- "Different account, same process"
- "This is convenient"

#### **Scenario: Deploying to Production Environment**

**Step 1: User Sets Different Environment**
```bash
$ DEPLOY_ENV=ai-office node _deploy-cli-cloudflare-gcp/deploy.js
```

**What the user sees:**
```
[5/10] 🔄 Setting up Cloudflare credentials...
      ✓ Using account: 72474c350e3f55d96195536a5d39e00d
      ✓ Token updated with all edit permissions
```

**What happens:**
- Script switches to production account
- Uses production token
- Deploys to production account

**User's mental state:**
- "Now deploying to production"
- "I need to be careful"
- "Let me verify everything is correct"

---

## Error Scenarios & User Experience

### Error: Invalid Token

**What the user sees:**
```
[5/10] ❌ Setting up Cloudflare credentials...
      ❌ API token validation failed for environment: production
      ❌ Please check your API token in deployments-secrets.json
```

**What the user does:**
1. Opens `deployments-secrets.json`
2. Checks if token is correct
3. May need to create new token from Cloudflare dashboard
4. Updates token in config file
5. Runs deployment again

**User's mental state:**
- "Oh no, what's wrong?"
- "Let me check my token"
- "I need to fix this"

---

### Error: Token Lacks Permission to Update Itself

**What the user sees:**
```
[5/10] ⚠️  Updating API token with all edit permissions...
      ❌ Failed to update token: Token lacks permission to update itself
      ❌ Please ensure your token has "User API Tokens:Edit" permission
```

**What the user does:**
1. Goes to Cloudflare dashboard
2. Edits the API token
3. Adds "User API Tokens:Edit" permission
4. Saves token
5. Runs deployment again

**User's mental state:**
- "I need to add a permission"
- "Let me fix this in the dashboard"
- "I'll try again after fixing"

---

### Error: Network Timeout

**What the user sees:**
```
[5/10] 🔄 Setting up Cloudflare credentials...
      ⚠️  Request timeout
      🔄 Retrying... (attempt 2/3)
      ✓ Token updated successfully
```

**What happens:**
- Script automatically retries
- Usually succeeds on retry

**User's mental state:**
- "Network issue, but it's retrying"
- "Good, it worked on retry"
- "The script handles this automatically"

---

## User Mental Model

### What Users Think About

**Before First Deployment:**
- "Will this work?"
- "Do I have everything I need?"
- "What if something breaks?"
- "How long will this take?"

**During Deployment:**
- "It's working..."
- "I see progress indicators"
- "I hope it completes successfully"
- "What's happening behind the scenes?"

**After Successful Deployment:**
- "Great! It worked!"
- "I have my URLs"
- "Let me test it"
- "This was easier than expected"

**After Multiple Deployments:**
- "This is routine now"
- "I trust the process"
- "It always works"
- "I can deploy confidently"

---

## Time Expectations

### Typical Deployment Times

- **First Deployment**: 60-90 seconds
  - Token update: 5-10 seconds
  - Database setup: 10-15 seconds
  - R2 setup: 5-10 seconds
  - Secrets: 10-15 seconds
  - Worker: 20-30 seconds
  - Frontend: 15-20 seconds

- **Subsequent Deployments**: 30-45 seconds
  - Token already has permissions (skips update or fast)
  - Database exists (skips creation)
  - Only uploads changed files

- **Multi-Account Switch**: Same as first deployment
  - Each account needs token update
  - Each account has separate resources

---

## User Checklist: Before Deployment

Print this checklist for users:

```
☐ Node.js installed (v16+)
☐ Project files downloaded/cloned
☐ deployments-secrets.json created
☐ Cloudflare account ID copied
☐ Cloudflare API token created
☐ API token has "User API Tokens:Edit" permission
☐ Token and Account ID added to config file
☐ Internet connection stable
☐ Terminal/Command Prompt ready
☐ Ready to deploy!
```

---

## Quick Reference: Common Commands

```bash
# Deploy to production
DEPLOY_ENV=production DEPLOY_PAGES=true node deploy.js

# Deploy to development
DEPLOY_ENV=ai-office-dev DEPLOY_PAGES=true node deploy.js

# Deploy worker only (no frontend)
DEPLOY_ENV=production node deploy.js

# Check Node.js version
node --version

# Verify token manually
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

# Complete Beginner's Guide: From Zero to Deployment

This is a step-by-step guide for someone starting from scratch with no prior setup. Follow these steps in order to achieve a successful deployment.

---

## Phase 1: Initial Setup (30-45 minutes)

### Step 1: Create Cloudflare Account (If You Don't Have One)

**What you need:**
- Email address
- Password (strong password recommended)
- 5 minutes

**Physical steps:**

1. **Open your web browser** (Chrome, Firefox, Safari, Edge)
2. **Navigate to**: https://dash.cloudflare.com/sign-up
3. **Fill in the form:**
   - Enter your email address
   - Create a password
   - Click "Sign up"
4. **Verify your email:**
   - Check your email inbox
   - Click the verification link from Cloudflare
5. **Complete account setup:**
   - You may be asked to add a website (you can skip this for now)
   - Click "Skip" or "Add website later"

**What you should see:**
- Cloudflare dashboard homepage
- Your account is created and verified

**Verification:**
- ✅ You can log in to https://dash.cloudflare.com
- ✅ You see the Cloudflare dashboard

---

### Step 2: Get Your Cloudflare Account ID

**Why you need this:**
- The deployment script needs to know which Cloudflare account to use
- Each account has a unique ID

**Physical steps:**

1. **Log in to Cloudflare Dashboard**: https://dash.cloudflare.com
2. **Look at the right sidebar** (or bottom of left sidebar on mobile)
3. **Find "Account ID"** - it looks like: `72474c350e3f55d96195536a5d39e00d`
4. **Copy the Account ID:**
   - Click on the Account ID text
   - Or select it and copy (Ctrl+C / Cmd+C)
   - **Save it somewhere safe** (text file, notes app, etc.)

**Alternative method (from URL):**
1. Click on any section in the dashboard (like "Workers & Pages")
2. Look at the browser URL bar
3. The URL will be: `https://dash.cloudflare.com/{YOUR_ACCOUNT_ID}/workers`
4. Copy the Account ID from the URL

**What you should have:**
- A 32-character string like: `72474c350e3f55d96195536a5d39e00d`
- Saved in a safe place

**Verification:**
- ✅ You have copied your Account ID
- ✅ It's 32 characters long (letters and numbers)
- ✅ You've saved it somewhere you can find it

---

### Step 3: Create Cloudflare API Token

**Why you need this:**
- The deployment script needs permission to create/update resources in your Cloudflare account
- API tokens are more secure than using your account password

**Physical steps:**

#### 3.1 Navigate to API Tokens Page

1. **In Cloudflare Dashboard**, click on your **profile icon** (top right corner)
2. **Click "My Profile"** from the dropdown menu
3. **Click "API Tokens"** tab (left sidebar)
4. You should see: https://dash.cloudflare.com/profile/api-tokens

**What you should see:**
- A page titled "API Tokens"
- A button that says "Create Token"
- A list of existing tokens (if any)

---

#### 3.2 Create the Token

**Option A: Use Template (Recommended for Beginners)**

1. **Scroll down** to find "API Token Templates"
2. **Find "Edit Cloudflare Workers"** template
3. **Click "Use template"** button next to it
4. **You'll see a form with pre-filled permissions:**
   - Account Resources: Include - All accounts (or select specific account)
   - Zone Resources: Include - All zones (or specific zones)
5. **Scroll down and click "Continue to summary"**
6. **Review the permissions:**
   - Should show: "Workers Scripts:Edit", "Workers Routes:Edit", etc.
7. **Click "Create Token"**

**Option B: Create Custom Token (More Control)**

1. **Click "Create Token"** button (top right)
2. **Token name**: Enter a descriptive name like "Deployment Token - Production"
3. **Permissions section:**
   - Click "Add" next to permissions
   - **Minimum required**: "User API Tokens:Edit" (so token can update itself)
   - **Recommended**: Add these permissions:
     - **Account** → **Workers Scripts** → **Edit**
     - **Account** → **Workers Routes** → **Edit**
     - **Account** → **Workers KV Storage** → **Edit**
     - **Account** → **D1** → **Edit**
     - **Account** → **R2** → **Edit**
     - **Account** → **Pages** → **Edit**
     - **Account** → **Zone** → **Read** (if using custom domains)
4. **Account Resources:**
   - Select "Include" → "All accounts" OR select your specific account
5. **Zone Resources** (if needed):
   - Select "Include" → "All zones" OR specific zones
6. **Click "Continue to summary"**
7. **Review and click "Create Token"**

---

#### 3.3 Copy and Save the Token

**⚠️ CRITICAL: You can only see this token ONCE!**

1. **After clicking "Create Token"**, you'll see a page with your token
2. **The token looks like**: `e-w5AMYn2MgkR7nt-VjKAqNbjDgvTX7tWSU0K0Nr`
3. **IMMEDIATELY copy the token:**
   - Click the "Copy" button next to the token
   - OR select all the token text and copy (Ctrl+C / Cmd+C)
4. **Save it immediately:**
   - Paste into a text file
   - Save the file (e.g., `cloudflare-token.txt`)
   - **DO NOT share this file publicly!**
   - **DO NOT commit it to Git!**

**What you should have:**
- A token string (starts with `e-` or similar)
- Saved in a secure location
- Not shared with anyone

**Verification:**
- ✅ You have copied the token
- ✅ Token is saved in a secure file
- ✅ You can access the token file when needed

---

### Step 4: Install Node.js on Your Computer

**Why you need this:**
- The deployment script runs on Node.js
- Node.js is a JavaScript runtime environment

**Physical steps:**

#### For macOS:

1. **Open Terminal** (Applications → Utilities → Terminal)
2. **Check if Node.js is already installed:**
   ```bash
   node --version
   ```
   - If you see a version like `v18.17.0` or higher, you're done! Skip to Step 5.
   - If you see "command not found", continue below.

3. **Install Homebrew** (if not installed):
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
   - Follow the on-screen instructions
   - Enter your Mac password when prompted

4. **Install Node.js:**
   ```bash
   brew install node@18
   ```

5. **Verify installation:**
   ```bash
   node --version
   npm --version
   ```
   - Should show: `v18.x.x` and `8.x.x` or higher

#### For Windows:

1. **Open your web browser**
2. **Go to**: https://nodejs.org/
3. **Download the LTS version** (recommended, usually version 18.x or 20.x)
   - Click the green "LTS" button
   - File will download (e.g., `node-v18.17.0-x64.msi`)
4. **Run the installer:**
   - Double-click the downloaded `.msi` file
   - Click "Next" through the installation wizard
   - **Important**: Check "Automatically install the necessary tools" if prompted
   - Click "Install"
   - Enter administrator password if asked
5. **Restart your computer** (recommended)
6. **Open PowerShell** (Windows key + X, then click "Windows PowerShell")
7. **Verify installation:**
   ```powershell
   node --version
   npm --version
   ```
   - Should show: `v18.x.x` and `8.x.x` or higher

#### For Linux (Ubuntu/Debian):

1. **Open Terminal** (Ctrl+Alt+T)
2. **Update package list:**
   ```bash
   sudo apt update
   ```
3. **Install Node.js 18.x:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
4. **Verify installation:**
   ```bash
   node --version
   npm --version
   ```
   - Should show: `v18.x.x` and `8.x.x` or higher

**Verification:**
- ✅ `node --version` shows v16.x, v18.x, or v20.x
- ✅ `npm --version` shows 8.x or higher
- ✅ No error messages

---

### Step 5: Get the Project Files

**Physical steps:**

#### Option A: Clone from Git Repository

1. **Open Terminal** (macOS/Linux) or **PowerShell** (Windows)
2. **Navigate to where you want the project:**
   ```bash
   cd ~/Documents  # or wherever you want
   ```
3. **Clone the repository:**
   ```bash
   git clone <your-repository-url>
   cd <project-folder-name>
   ```
   - Replace `<your-repository-url>` with actual Git URL
   - Replace `<project-folder-name>` with actual folder name

#### Option B: Download ZIP File

1. **Download the project ZIP file** from your source
2. **Extract the ZIP file:**
   - **macOS**: Double-click the ZIP file
   - **Windows**: Right-click → "Extract All"
   - **Linux**: `unzip project.zip`
3. **Open Terminal/PowerShell** and navigate to the folder:
   ```bash
   cd ~/Downloads/project-folder  # adjust path as needed
   ```

**Verification:**
- ✅ You can see project files in the folder
- ✅ You see files like `deploy.js`, `package.json`, etc.
- ✅ You're in the project directory in Terminal/PowerShell

---

## Phase 2: Configuration (15-20 minutes)

### Step 6: Create Configuration File

**Physical steps:**

1. **Navigate to the deployment folder:**
   ```bash
   cd _deploy-cli-cloudflare-gcp
   ```
   - If this folder doesn't exist, create it:
     ```bash
     mkdir -p _deploy-cli-cloudflare-gcp
     cd _deploy-cli-cloudflare-gcp
     ```

2. **Create the configuration file:**
   - **macOS/Linux:**
     ```bash
     touch deployments-secrets.json
     ```
   - **Windows (PowerShell):**
     ```powershell
     New-Item -ItemType File -Name deployments-secrets.json
     ```

3. **Open the file in a text editor:**
   - **VS Code**: `code deployments-secrets.json`
   - **Nano** (Terminal): `nano deployments-secrets.json`
   - **Notepad** (Windows): `notepad deployments-secrets.json`
   - **Any text editor** you prefer

4. **Copy and paste this template:**
   ```json
   {
     "environments": {
       "production": {
         "name": "production",
         "workerName": "my-worker-name",
         "pagesProjectName": "my-frontend-project",
         "databaseName": "my-database",
         "bucketName": "my-bucket",
         "cloudflare": {
           "accountId": "YOUR_ACCOUNT_ID_HERE",
           "apiToken": "YOUR_API_TOKEN_HERE"
         },
         "gcp": {
           "projectId": "your-gcp-project-id",
           "private_key": "",
           "client_email": ""
         },
         "RAPIDAPI_KEY": "your-rapidapi-key",
         "RAPIDAPI_HOST": "api.example.com",
         "RAPIDAPI_ENDPOINT": "https://api.example.com/endpoint",
         "GOOGLE_VISION_API_KEY": "your-google-vision-key",
         "GOOGLE_VERTEX_PROJECT_ID": "your-vertex-project-id",
         "GOOGLE_VERTEX_LOCATION": "us-central1",
         "GOOGLE_VISION_ENDPOINT": "https://vision.googleapis.com/v1/images:annotate",
         "gcp": {
           "projectId": "your-project-id",
           "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
           "client_email": "your-service-account@project.iam.gserviceaccount.com"
         }
       }
     }
   }
   ```

5. **Replace the placeholder values:**
   - `YOUR_ACCOUNT_ID_HERE` → Paste your Account ID from Step 2
   - `YOUR_API_TOKEN_HERE` → Paste your API Token from Step 3
   - `my-worker-name` → Choose a name (e.g., `my-app-backend`)
   - `my-frontend-project` → Choose a name (e.g., `my-app-frontend`)
   - `my-database` → Choose a name (e.g., `my-app-db`)
   - `my-bucket` → Choose a name (e.g., `my-app-storage`)
   - Replace other values with your actual API keys (if you have them)

6. **Save the file:**
   - **VS Code**: Ctrl+S / Cmd+S
   - **Nano**: Ctrl+O, then Enter, then Ctrl+X
   - **Notepad**: Ctrl+S

**Important Notes:**
- ⚠️ **DO NOT** commit this file to Git if it contains real tokens
- ⚠️ Add `deployments-secrets.json` to `.gitignore` file
- ⚠️ Keep this file secure and private

**Verification:**
- ✅ File `deployments-secrets.json` exists
- ✅ File contains your Account ID (32 characters)
- ✅ File contains your API Token (starts with `e-`)
- ✅ All placeholder values are replaced
- ✅ File is saved

---

### Step 7: Verify Configuration File Format

**Physical steps:**

1. **Check if JSON is valid** (optional but recommended):
   ```bash
   # macOS/Linux
   python3 -m json.tool deployments-secrets.json > /dev/null && echo "✅ JSON is valid" || echo "❌ JSON has errors"
   
   # Windows (PowerShell)
   # Use an online JSON validator or VS Code will show errors
   ```

2. **Double-check your values:**
   - Open `deployments-secrets.json` again
   - Verify Account ID is correct (32 characters, no spaces)
   - Verify API Token is correct (starts with `e-`, no spaces)
   - Verify all quotes are properly closed
   - Verify there are no trailing commas

**Common mistakes to avoid:**
- ❌ Missing quotes around values
- ❌ Trailing commas (e.g., `"key": "value",` at end of object)
- ❌ Missing commas between properties
- ❌ Extra spaces in Account ID or Token

**Verification:**
- ✅ JSON file is valid (no syntax errors)
- ✅ Account ID and Token are correct
- ✅ No typos in the file

---

## Phase 3: First Deployment (10-15 minutes)

### Step 8: Install Project Dependencies (If Needed)

**Physical steps:**

1. **Navigate to project root:**
   ```bash
   cd ..  # Go back to project root if you're in _deploy-cli-cloudflare-gcp
   ```

2. **Check if package.json exists:**
   ```bash
   ls package.json  # macOS/Linux
   # or
   dir package.json  # Windows
   ```

3. **If package.json exists, install dependencies:**
   ```bash
   npm install
   ```
   - This may take 1-2 minutes
   - You'll see packages being downloaded

4. **If no package.json, that's okay** - the deployment script doesn't require it

**Verification:**
- ✅ `npm install` completed without errors (if package.json exists)
- ✅ You're in the project root directory

---

### Step 9: Test Token Manually (Optional but Recommended)

**Why do this:**
- Verify your token works before running the full deployment
- Catch token issues early

**Physical steps:**

1. **Open Terminal/PowerShell**
2. **Run this command** (replace `YOUR_TOKEN` with your actual token):
   ```bash
   curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```
   
   **Windows PowerShell alternative:**
   ```powershell
   $headers = @{ "Authorization" = "Bearer YOUR_TOKEN" }
   Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/user/tokens/verify" -Headers $headers
   ```

3. **What you should see:**
   ```json
   {
     "result": {
       "id": "abc123...",
       "status": "active",
       ...
     },
     "success": true
   }
   ```

4. **If you see `"success": true`**, your token works! ✅
5. **If you see an error**, check:
   - Token is copied correctly (no extra spaces)
   - Token hasn't been revoked
   - You're using the correct token

**Verification:**
- ✅ Token verification returns `"success": true`
- ✅ You see your token ID in the response

---

### Step 10: Run Your First Deployment

**Physical steps:**

1. **Make sure you're in the project root directory:**
   ```bash
   pwd  # macOS/Linux - shows current directory
   # or
   Get-Location  # Windows PowerShell
   ```
   - You should see the project folder path

2. **Run the deployment command:**
   ```bash
   # macOS/Linux
   DEPLOY_ENV=production DEPLOY_PAGES=true node _deploy-cli-cloudflare-gcp/deploy.js
   
   # Windows PowerShell
   $env:DEPLOY_ENV="production"; $env:DEPLOY_PAGES="true"; node _deploy-cli-cloudflare-gcp/deploy.js
   
   # Windows Command Prompt
   set DEPLOY_ENV=production
   set DEPLOY_PAGES=true
   node _deploy-cli-cloudflare-gcp/deploy.js
   ```

3. **Watch the output:**
   - You'll see progress indicators
   - Each step will show as it completes
   - Don't close the terminal!

4. **What happens automatically:**
   - ✅ Token permissions are updated
   - ✅ Database is created (if needed)
   - ✅ R2 bucket is created (if needed)
   - ✅ Secrets are deployed
   - ✅ Worker is deployed
   - ✅ Frontend is deployed (if DEPLOY_PAGES=true)

5. **Wait for completion:**
   - This takes 30-90 seconds
   - You'll see a summary at the end

**What you should see at the end:**
```
╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
║  📊 Deployment Summary                                                                          ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════╝

✓ Deployment completed successfully!

Backend Worker: https://your-worker.your-subdomain.workers.dev
Frontend Pages: https://your-project.pages.dev

Progress: ████████████████████████████████████ 100%
Summary: 10✓ 0✗ 0⚠ 0⟳ 0⊘ | 10 total
Elapsed: 45.3s
```

**Verification:**
- ✅ Deployment completed without errors
- ✅ You see "Deployment completed successfully!"
- ✅ You have Worker URL and Pages URL
- ✅ Summary shows all steps completed (10✓)

---

### Step 11: Verify Deployment Success

**Physical steps:**

1. **Copy the Worker URL** from the deployment output
2. **Open it in your browser:**
   - Paste the URL in address bar
   - Press Enter
3. **You should see:**
   - Your worker responding (may show JSON, HTML, or API response)
   - No error pages

4. **Copy the Frontend Pages URL** (if deployed)
5. **Open it in your browser:**
   - Should show your frontend application
   - Should load without errors

6. **Test the endpoints:**
   - Try accessing different routes
   - Verify functionality works as expected

**Verification:**
- ✅ Worker URL loads successfully
- ✅ Frontend URL loads successfully (if deployed)
- ✅ No 404 or 500 errors
- ✅ Application functions correctly

---

## Phase 4: Troubleshooting Common Issues

### Issue: "Token validation failed"

**Symptoms:**
```
❌ API token validation failed for environment: production
```

**Physical steps to fix:**

1. **Go back to Cloudflare Dashboard**: https://dash.cloudflare.com/profile/api-tokens
2. **Check if your token exists:**
   - Look in the "API Tokens" list
   - Find your token by name
3. **If token doesn't exist or was deleted:**
   - Create a new token (repeat Step 3)
   - Update `deployments-secrets.json` with new token
4. **If token exists:**
   - Verify you copied it correctly
   - Check for extra spaces or line breaks
   - Re-copy the token from Cloudflare
5. **Update the config file:**
   - Open `deployments-secrets.json`
   - Replace the `apiToken` value
   - Save the file
6. **Run deployment again**

---

### Issue: "Cannot get permission groups"

**Symptoms:**
```
❌ Cannot get permission groups. Current token error: ...
```

**Physical steps to fix:**

1. **Go to Cloudflare Dashboard**: https://dash.cloudflare.com/profile/api-tokens
2. **Find your token** and click "Edit"
3. **Add this permission:**
   - **Account** → **User API Tokens** → **Read** (or **Edit**)
4. **Save the token**
5. **Note**: You can't edit an existing token's permissions directly
   - You may need to create a new token with the correct permissions
6. **Update `deployments-secrets.json`** with the new token
7. **Run deployment again**

---

### Issue: "Account ID not found"

**Symptoms:**
```
❌ No account ID found for environment: production
```

**Physical steps to fix:**

1. **Get your Account ID again** (repeat Step 2)
2. **Open `deployments-secrets.json`**
3. **Verify the Account ID:**
   - Should be 32 characters
   - Should be in `cloudflare.accountId` field
   - No extra spaces or quotes
4. **Update if needed and save**
5. **Run deployment again**

---

### Issue: "Node.js not found"

**Symptoms:**
```
❌ node: command not found
```

**Physical steps to fix:**

1. **Verify Node.js is installed:**
   ```bash
   node --version
   ```
2. **If not installed**, repeat Step 4 (Install Node.js)
3. **If installed but not found:**
   - **macOS/Linux**: Restart terminal
   - **Windows**: Restart computer or add Node.js to PATH
4. **Verify again:**
   ```bash
   node --version
   ```

---

## Quick Reference Checklist

Print this checklist and check off each item as you complete it:

### Pre-Deployment Checklist

- [ ] Cloudflare account created and verified
- [ ] Account ID copied and saved
- [ ] API Token created with "User API Tokens:Edit" permission
- [ ] API Token copied and saved securely
- [ ] Node.js installed (v16+)
- [ ] Project files downloaded/cloned
- [ ] `deployments-secrets.json` file created
- [ ] Account ID added to config file
- [ ] API Token added to config file
- [ ] Config file JSON is valid (no syntax errors)
- [ ] Token verified manually (optional but recommended)
- [ ] Ready to deploy!

### Post-Deployment Checklist

- [ ] Deployment completed successfully
- [ ] Worker URL received
- [ ] Frontend URL received (if deployed)
- [ ] Worker URL tested in browser
- [ ] Frontend URL tested in browser
- [ ] Application functions correctly
- [ ] URLs saved for future reference

---

## Summary: Complete Flow

```
1. Create Cloudflare Account (5 min)
   ↓
2. Get Account ID (2 min)
   ↓
3. Create API Token (5 min)
   ↓
4. Install Node.js (10-15 min)
   ↓
5. Get Project Files (5 min)
   ↓
6. Create Config File (10 min)
   ↓
7. Verify Config (2 min)
   ↓
8. Install Dependencies (2 min)
   ↓
9. Test Token (2 min - optional)
   ↓
10. Run Deployment (1-2 min)
    ↓
11. Verify Success (2 min)
    ↓
✅ DONE! Your application is deployed!
```

**Total Time: 45-60 minutes for first-time setup**

**Subsequent deployments: 1-2 minutes** (just run the deployment command)

---

This guide takes you from having nothing to a fully deployed application. Follow each step in order, and you'll have a successful deployment!
