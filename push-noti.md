---
name: FCM Silent Push Integration
overview: Cloudflare Worker + FCM HTTP v1 silent push cho Android/iOS
todos:
  - id: migration
    content: Tạo 006_device_tokens.sql
    status: pending
  - id: secrets
    content: Thêm FIREBASE_PROJECT_ID, FIREBASE_SA_EMAIL, FIREBASE_SA_PRIVATE_KEY, FCM_API_KEY
    status: pending
  - id: types
    content: Thêm FCM types vào types.ts
    status: pending
  - id: config
    content: Thêm FCM_CONFIG vào config.ts
    status: pending
  - id: services
    content: Thêm getFcmAccessToken, sendFcmSilentPush vào services.ts
    status: pending
  - id: routes
    content: Thêm 3 routes vào index.ts
    status: pending
isProject: false
---

# FCM Silent Push - Execution Plan

## Architecture Overview

```mermaid
sequenceDiagram
    participant App
    participant Worker as Cloudflare Worker
    participant D1
    participant KV
    participant FCM as FCM HTTP v1
    participant Device

    Note over App,Device: Registration Flow
    App->>Worker: POST /api/device/register
    Worker->>D1: Verify profile exists
    Worker->>D1: Upsert device_tokens
    Worker-->>App: 200 OK

    Note over App,Device: Push Flow
    App->>Worker: POST /api/push/silent
    Worker->>KV: Get cached FCM token
    alt Token expired/missing
        Worker->>FCM: OAuth token exchange
        Worker->>KV: Cache new token
    end
    Worker->>D1: Get tokens for profile_id
    loop Each device
        Worker->>FCM: Send silent message
        FCM->>Device: Push notification
    end
    alt Invalid token detected
        Worker->>D1: Delete stale token
    end
    Worker-->>App: Results summary
```



---

## 1. D1 Migration

**File:** `backend-cloudflare-workers/migrations/006_device_tokens.sql`

**Why profile_id not user_id:**

- Existing schema uses `profiles.id` as primary identifier
- `profiles` table already has `device_id` and `user_id` fields
- Foreign key ensures data integrity + CASCADE delete

**Why token as PRIMARY KEY:**

- FCM tokens are globally unique
- Prevents duplicate registrations
- ON CONFLICT DO UPDATE handles token refresh

```sql
CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  app_version TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Index for lookup by profile (main query pattern)
CREATE INDEX IF NOT EXISTS idx_device_tokens_profile ON device_tokens(profile_id);

-- Index for stale token cleanup jobs
CREATE INDEX IF NOT EXISTS idx_device_tokens_updated ON device_tokens(updated_at);
```

**Run:**

```bash
wrangler d1 migrations apply <db-name>
```

---

## 2. Secrets

**Why separate credentials from Vertex AI:**

- FCM requires `firebase.messaging` scope
- Vertex AI uses `cloud-platform` scope
- Different service accounts = better security isolation

**Why wrangler secret (not JSON file):**

- Private key contains newlines, hard to escape in JSON
- Secrets encrypted at rest in Cloudflare

```bash
wrangler secret put FIREBASE_PROJECT_ID
# Value: your-project-id (from Firebase Console)

wrangler secret put FIREBASE_SA_EMAIL
# Value: firebase-adminsdk-xxx@project.iam.gserviceaccount.com

wrangler secret put FIREBASE_SA_PRIVATE_KEY
# Value: -----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n

wrangler secret put FCM_API_KEY
# Value: random-string-for-admin-endpoint-auth
```

---

## 3. types.ts

**Why these interfaces:**

- `DeviceToken`: DB row representation
- `DeviceRegisterRequest`: Validates client input
- `SilentPushRequest`: Admin/internal push trigger
- `FcmSendResult`: Track success/failure per device

```typescript
export interface DeviceToken {
  token: string;
  profile_id: string;
  platform: 'android' | 'ios';
  app_version?: string;
  updated_at: number;
}

export interface DeviceRegisterRequest {
  profile_id: string;
  platform: 'android' | 'ios';
  token: string;
  app_version?: string;
}

export interface SilentPushRequest {
  profile_id: string;
  data: Record<string, string>;
  exclude_token?: string;  // Skip current device
}

export interface FcmSendResult {
  token: string;
  platform: string;
  success: boolean;
  error?: string;
  should_remove?: boolean;  // True = token invalid, delete from DB
}
```

---

## 4. config.ts

**Why centralized config:**

- Reusable across services.ts
- Easy to modify endpoints/TTL
- Matches existing pattern (VERTEX_AI_CONFIG)

**Why 3300s TTL:**

- OAuth tokens valid 3600s (1 hour)
- Cache 3300s (55 min) = 5 min buffer before expiry
- Prevents edge case of using expired token

```typescript
export const FCM_CONFIG = {
  TOKEN_URL: 'https://oauth2.googleapis.com/token',
  SEND_URL: (projectId: string) =>
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
  SCOPE: 'https://www.googleapis.com/auth/firebase.messaging',
  TOKEN_CACHE_TTL: 3300,
  INVALID_TOKEN_ERRORS: ['NOT_REGISTERED', 'INVALID_ARGUMENT', 'UNREGISTERED'],
};
```

---

## 5. services.ts

**Why reuse existing OAuth pattern:**

- `getAccessToken()` in utils.ts already implements JWT signing
- Same crypto.subtle API, same KV caching pattern
- Proven code, just different scope

**Why KV cache for FCM token:**

- OAuth token exchange = ~200ms latency
- KV read = ~5ms latency
- High-frequency push = massive savings

**Why auto-remove invalid tokens:**

- FCM returns specific errors for stale tokens
- NOT_REGISTERED = app uninstalled or token rotated
- Auto-cleanup keeps DB clean

```typescript
import { FCM_CONFIG } from './config';
import type { Env, FcmSendResult } from './types';
import { base64UrlEncode } from './utils';

// Reuse existing KV getter pattern from utils.ts
const getTokenCacheKV = (env: Env): KVNamespace | null => {
  const kvBindingName = env.PROMPT_CACHE_KV_BINDING_NAME;
  if (!kvBindingName) return null;
  return (env as any)[kvBindingName] as KVNamespace || null;
};

export const getFcmAccessToken = async (env: Env): Promise<string> => {
  const cacheKey = `fcm_token:${env.FIREBASE_PROJECT_ID}`;
  const now = Math.floor(Date.now() / 1000);

  // Check KV cache first (same pattern as Vertex AI token)
  const tokenCacheKV = getTokenCacheKV(env);
  if (tokenCacheKV) {
    try {
      const cached = await tokenCacheKV.get(cacheKey, 'json') as { token: string; expiresAt: number } | null;
      if (cached && cached.expiresAt > now) return cached.token;
    } catch {}
  }

  // Validate credentials
  if (!env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    throw new Error('FIREBASE_SA_EMAIL and FIREBASE_SA_PRIVATE_KEY required');
  }

  // Build JWT (same algorithm as getAccessToken in utils.ts)
  const expiry = now + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: env.FIREBASE_SA_EMAIL,
    sub: env.FIREBASE_SA_EMAIL,
    aud: FCM_CONFIG.TOKEN_URL,
    exp: expiry,
    iat: now,
    scope: FCM_CONFIG.SCOPE,  // Different scope for FCM
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
  const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

  // Parse PEM private key
  const keyData = env.FIREBASE_SA_PRIVATE_KEY
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\\n/g, '')  // Handle escaped newlines from env
    .replace(/\s/g, '');

  const keyBuffer = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signatureInput)
  );

  const encodedSignature = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
  const jwt = `${signatureInput}.${encodedSignature}`;

  // Exchange JWT for access token
  const tokenResponse = await fetch(FCM_CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`FCM OAuth error: ${tokenResponse.status}`);
  }

  const { access_token } = await tokenResponse.json() as { access_token: string };

  // Cache in KV with 55 min TTL
  if (tokenCacheKV) {
    try {
      await tokenCacheKV.put(cacheKey, JSON.stringify({
        token: access_token,
        expiresAt: now + FCM_CONFIG.TOKEN_CACHE_TTL
      }), { expirationTtl: FCM_CONFIG.TOKEN_CACHE_TTL });
    } catch {}
  }

  return access_token;
};

export const sendFcmSilentPush = async (
  env: Env,
  token: string,
  platform: 'android' | 'ios',
  data: Record<string, string>
): Promise<FcmSendResult> => {
  try {
    const accessToken = await getFcmAccessToken(env);

    // Build message - NO notification field = silent
    const message: any = {
      token,
      // FCM requires all data values to be strings
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    };

    if (platform === 'android') {
      // Data-only message: always triggers onMessageReceived()
      // NORMAL priority = batched delivery, no wake
      message.android = { priority: 'NORMAL' };
    } else {
      // iOS silent push requirements:
      // - apns-push-type: background (not alert)
      // - apns-priority: 5 (not 10, which is immediate)
      // - content-available: 1 (triggers background fetch)
      message.apns = {
        headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
        payload: { aps: { 'content-available': 1 } },
      };
    }

    const response = await fetch(FCM_CONFIG.SEND_URL(env.FIREBASE_PROJECT_ID), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Check if token should be removed (uninstalled app, rotated token)
      const shouldRemove = FCM_CONFIG.INVALID_TOKEN_ERRORS.some(e => errorBody.includes(e));
      return { token, platform, success: false, error: `FCM: ${response.status}`, should_remove: shouldRemove };
    }

    return { token, platform, success: true };
  } catch (error) {
    return { token, platform, success: false, error: error instanceof Error ? error.message : String(error) };
  }
};
```

---

## 6. index.ts Routes

**Why verify profile exists:**

- Prevents orphan tokens in DB
- Foreign key would fail anyway, better error message

**Why exclude_token:**

- User triggers action on Device A
- Push should notify Device B, C (not A)
- Avoids redundant notification on current device

**Why cleanup invalid tokens inline:**

- FCM tells us token is dead
- Immediate cleanup = no retry waste
- Alternative: batch cleanup job (more complex)

```typescript
// POST /api/device/register
// Called by app on startup and token refresh
if (url.pathname === '/api/device/register' && request.method === 'POST') {
  try {
    const body = await request.json<DeviceRegisterRequest>();
    
    // Validate required fields
    if (!body.profile_id || !body.platform || !body.token) {
      return errorResponse('Missing: profile_id, platform, token', 400, {}, request, env);
    }
    if (!['android', 'ios'].includes(body.platform)) {
      return errorResponse('Invalid platform', 400, {}, request, env);
    }

    // Verify profile exists (FK constraint would fail anyway)
    const profile = await env.DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(body.profile_id).first();
    if (!profile) return errorResponse('Profile not found', 404, {}, request, env);

    // Upsert: new token inserts, same token updates profile/platform
    await env.DB.prepare(`
      INSERT INTO device_tokens (token, profile_id, platform, app_version, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        profile_id = excluded.profile_id, platform = excluded.platform,
        app_version = excluded.app_version, updated_at = excluded.updated_at
    `).bind(body.token, body.profile_id, body.platform, body.app_version || null, Date.now()).run();

    return successResponse({ registered: true }, 200, request, env);
  } catch (error) {
    return errorResponse('Register failed', 500, { error: String(error) }, request, env);
  }
}

// POST /api/push/silent
// Admin/internal endpoint to trigger push
if (url.pathname === '/api/push/silent' && request.method === 'POST') {
  // Simple API key auth (not for public use)
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey || apiKey !== env.FCM_API_KEY) {
    return errorResponse('Unauthorized', 401, {}, request, env);
  }

  try {
    const body = await request.json<SilentPushRequest>();
    if (!body.profile_id || !body.data) {
      return errorResponse('Missing: profile_id, data', 400, {}, request, env);
    }

    // Get all devices for this profile
    const { results: tokens } = await env.DB.prepare(
      'SELECT token, platform FROM device_tokens WHERE profile_id = ?'
    ).bind(body.profile_id).all<{ token: string; platform: string }>();

    if (!tokens?.length) {
      return successResponse({ sent: 0 }, 200, request, env);
    }

    // Exclude current device if specified
    const targetTokens = body.exclude_token ? tokens.filter(t => t.token !== body.exclude_token) : tokens;
    const results: FcmSendResult[] = [];
    const tokensToRemove: string[] = [];

    // Send to each device
    for (const { token, platform } of targetTokens) {
      const result = await sendFcmSilentPush(env, token, platform as 'android' | 'ios', body.data);
      results.push(result);
      if (result.should_remove) tokensToRemove.push(token);
    }

    // Cleanup invalid tokens immediately
    if (tokensToRemove.length > 0) {
      await env.DB.prepare(
        `DELETE FROM device_tokens WHERE token IN (${tokensToRemove.map(() => '?').join(',')})`
      ).bind(...tokensToRemove).run();
    }

    return successResponse({
      sent: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      cleaned: tokensToRemove.length,
    }, 200, request, env);
  } catch (error) {
    return errorResponse('Push failed', 500, { error: String(error) }, request, env);
  }
}

// DELETE /api/device/unregister
// Called on logout or app uninstall (if detectable)
if (url.pathname === '/api/device/unregister' && request.method === 'DELETE') {
  try {
    const body = await request.json<{ token: string }>();
    if (!body.token) return errorResponse('Missing: token', 400, {}, request, env);

    await env.DB.prepare('DELETE FROM device_tokens WHERE token = ?').bind(body.token).run();
    return successResponse({ unregistered: true }, 200, request, env);
  } catch (error) {
    return errorResponse('Unregister failed', 500, { error: String(error) }, request, env);
  }
}
```

---

## 7. Firebase Setup

**Step 1: Get Service Account**

1. Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key"
3. Download JSON file

**Step 2: Extract credentials**

```json
{
  "client_email": "firebase-adminsdk-xxx@project.iam.gserviceaccount.com",  // → FIREBASE_SA_EMAIL
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"  // → FIREBASE_SA_PRIVATE_KEY
}
```

**Step 3: iOS APNs (required for iOS push)**

1. Apple Developer → Keys → Create APNs key
2. Firebase Console → Cloud Messaging → Upload APNs key
3. Xcode → Enable Push Notifications capability

---

## 8. Silent Payload Format

**Why no `notification` field:**

- Android: `notification` field = system tray even when app backgrounded
- `data` only = always triggers `onMessageReceived()`

**Why iOS priority 5:**

- Priority 10 = immediate delivery, may show badge
- Priority 5 = opportunistic, truly silent

**Android:**

```json
{
  "message": {
    "token": "device-token",
    "data": { "type": "balance_sync", "amount": "100" },
    "android": { "priority": "NORMAL" }
  }
}
```

**iOS:**

```json
{
  "message": {
    "token": "device-token",
    "data": { "type": "balance_sync", "amount": "100" },
    "apns": {
      "headers": {
        "apns-push-type": "background",
        "apns-priority": "5"
      },
      "payload": {
        "aps": { "content-available": 1 }
      }
    }
  }
}
```

---

## 9. Edge Cases Handled


| Case                | Solution                          |
| ------------------- | --------------------------------- |
| Token refresh race  | ON CONFLICT DO UPDATE             |
| App uninstalled     | Auto-delete on NOT_REGISTERED     |
| Multiple devices    | Send to all tokens for profile_id |
| Current device skip | exclude_token parameter           |
| OAuth token expiry  | KV cache with 55min TTL           |
| Profile deleted     | CASCADE delete tokens             |
| iOS throttling      | Priority 5 + content-available    |


