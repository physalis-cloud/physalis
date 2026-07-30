---
title: API Gateway
order: 11
icon: RiAppsLine
summary: Generate and manage API keys to protect your own services, with real-time validation, rate limiting and usage monitoring.
---

# API Gateway

Physalis's **API Gateway** lets you protect your own services with API
keys generated, validated and monitored directly from your vault — with
no additional infrastructure.

Physalis becomes the single source of truth for:

- Key generation and revocation
- Real-time validation of every request
- Per-key usage monitoring (logs, stats, rate limiting)
- Automatic key rotation with redeployment

## Concepts

```
Project
  └── API (e.g. "Orders API")
        ├── Keys (ApiKey)
        │     ├── Scopes (permissions)
        │     ├── Rate limit
        │     └── Expiration
        └── Access logs
```

An **API** in Physalis represents one of your services to protect. Each
API can have multiple keys — one per client, per environment, or per
workflow.

## Key format

```
ph_live_sk_<64 hexadecimal characters>
```

- The `ph_` prefix is recognised by secret scanning tools
  (trufflehog, gitleaks) to detect accidental leaks.
- `live` vs `test` distinguishes production keys from development keys.
- The raw key is never stored in the database: only its SHA-256 hash is
  kept.

## Create an API

> Permissions: **EDITOR** or above on the project.

1. Open a project → **API Gateway** tab.
2. Click **New API**.
3. Enter the name and optionally the URL of your service.
4. Choose the **validation mode**:
   - **REMOTE** *(recommended)* — each request is validated in real time
     via Physalis. Key revocation takes effect immediately.
   - **JWT** — keys are tokens signed locally by your service,
     with no network call. Zero latency, but revocation only takes
     effect when the token expires.
5. Optionally define a **default rate limit** (requests per minute) for
   all keys in this API.

## Create a key

1. From the API detail page → **New key**.
2. Give it a name identifying the consumer (e.g. `N8n workflow Orders`,
   `CI/CD staging`).
3. Define **scopes** if your service checks them (e.g.
   `read:orders`, `write:products`).
4. Customise the rate limit or expiration duration if needed.
5. The raw key is shown to you **only once** at creation.
   Copy it and store it somewhere safe.

> ⚠️ After closing the window, the raw key is unrecoverable. If lost,
> revoke the key and create a new one.

## Using a key in your service

### REMOTE mode — calling Physalis on each request

Your middleware sends the key to the Physalis public endpoint to validate
each incoming request:

The **`apiId` field is required**: it is the identifier of YOUR API (shown in the
Gateway dashboard). It ensures a key is only accepted for the API it belongs to —
without it, a valid key meant for another API would be accepted.

```http
POST https://<your-slug>.physalis.cloud/api/gateway/verify
Content-Type: application/json

{
  "apiId": "clx...",
  "key": "ph_live_sk_...",
  "path": "/api/orders",
  "method": "GET"
}
```

Response on success:

```json
{
  "valid": true,
  "apiId": "clx...",
  "keyId": "clx...",
  "keyPrefix": "ph_live_sk_ab",
  "scopes": ["read:orders"],
  "rateLimit": {
    "limit": 100,
    "remaining": 87,
    "resetAt": 1746270060
  }
}
```

Response on failure:

```json
{ "valid": false, "reason": "revoked" }
```

Possible values for `reason` are: `invalid`, `revoked`, `expired`,
`rate_limited`, `api_id_required` (the `apiId` field is missing from the request).

### Example — Next.js middleware

```typescript
// middleware.ts
export async function middleware(req: NextRequest) {
  const key = req.headers.get("x-api-key");
  if (!key) return new Response("Unauthorized", { status: 401 });

  const res = await fetch(
    `${process.env.PHYSALIS_URL}/api/gateway/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiId: process.env.PHYSALIS_API_ID, key, path: req.nextUrl.pathname, method: req.method }),
    }
  );

  const data = await res.json();
  if (!data.valid) return new Response(data.reason, { status: 401 });

  return NextResponse.next();
}
```

### Example — HTTP Request node in N8n

In an N8n **HTTP Request** node, add a header:

```
x-api-key: ph_live_sk_...
```

Your API endpoint validates the key via Physalis. You can see all workflow
calls in the key's logs.

## Rate limiting

Rate limiting is managed **per key** (not per IP). You can define:

- A **default rate limit** on the API (inherited by all new keys).
- A **specific rate limit** on an individual key (override).

Available windows are `1m` (1 minute), `1h` (1 hour) and `1d`
(24 hours).

When the limit is reached, Physalis returns:

```json
{ "valid": false, "reason": "rate_limited" }
```

## Logs and monitoring

Each call to `/api/gateway/verify` generates an entry in the key's logs
(method, path, result, latency). From the API or key detail page, you can:

- View **24h stats**: total requests, success/error rate, hourly breakdown.
- Browse **recent logs** with filter by key or result.
- Identify the **top keys** by usage volume.

## Automatic key rotation

You can configure **automatic rotation** for a secret that stores an API
Gateway key. On each rotation:

1. Physalis generates a new key.
2. The secret value is updated with the new key.
3. The old key is **revoked immediately** — any validation returns
   `{ valid: false, reason: "revoked" }` without delay.
4. A GitHub Actions redeployment is triggered to reload the new value.

To configure rotation:

1. Create a key in the API Gateway and store its value as a secret
   (e.g. `MY_SERVICE_API_KEY`).
2. Open the secret's rotation → **API Gateway key** strategy.
3. Select the corresponding API and key.
4. Set the interval in days.
5. If the key is injected at **build time** (e.g. `VITE_*` passed as a
   Docker `--build-arg`), check **"Full build required"** — Physalis will
   then trigger the project's `deploy.yml` workflow instead of the simple
   `redeploy.yml`, to rebuild the image with the new value.

> ⚠️ Automatic rotation only applies if the key is loaded from the vault,
> either at runtime via `.env` or at build time via `--build-arg`.
> If you copied it directly into n8n, Make or another external tool,
> you will need to update it manually after each rotation.

See [Secret rotation](rotations) for the full configuration.

## Revoke a key

From the API detail page → **Actions** column → **Revoke**. Revocation
is **immediate** in REMOTE mode: the key becomes invalid for any subsequent
call to `/api/gateway/verify`.

> Revocation is audited (`API_KEY_REVOKED`) and irreversible. To restore
> access, create a new key.

## Delete an API

> Permissions: project **OWNER** only.

Deleting an API permanently erases all its keys and all its logs. Entries
in the global token registry are also deleted — all keys for the API
become invalid immediately.

## Security

| Point                         | Implementation                                             |
|-------------------------------|------------------------------------------------------------|
| Key never stored in plaintext | SHA-256 only in the database                               |
| Identifiable prefix           | `ph_` detected by trufflehog, gitleaks                     |
| Instant revocation            | Deletion from the global token_index registry              |
| Per-key rate limiting         | Fixed window in memory, configurable per key or per API    |
| Non-blocking logs             | Async write — does not slow down validation                |
| RBAC                          | EDITOR+ to create/revoke, OWNER to delete the API          |
