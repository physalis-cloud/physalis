import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Session,
  adminSession,
  postJson,
  deleteReq,
  patchJson,
  BASE_URL,
  TENANT_SCHEMA,
  TENANT_SLUG,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const SUFFIX = `${Date.now()}`;
const PROJECT_NAME = `test-gateway-${SUFFIX}`;
let PROJECT_SLUG = "";
let projectId = "";

let admin: Session;
let apiId = "";
let keyId = "";
let rawKey = "";

// Viewer user (Bob) — read-only access, cannot create keys
const BOB_EMAIL = `bob-gw-${SUFFIX}@test.local`;
const BOB_PASSWORD = "bobtestpassword12";
let bobUserId = "";
let bobSession: Session;

import { createHash, randomBytes } from "node:crypto";
import { loginAs } from "./helpers/api";

async function provisionBobAsViewer(orgId: string, invitedById: string, projId: string) {
  const token = "iv_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const id = "ck" + randomBytes(11).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace("Z", "+00");

  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."Invitation" (id, email, "organizationId", role, "tokenHash", "expiresAt", "invitedById", "createdAt")
     VALUES ('${id}', '${BOB_EMAIL}', '${orgId}', 'MEMBER', '${tokenHash}', '${expiresAt}', '${invitedById}', NOW())`,
  );

  const res = await fetch(`${BASE_URL}/api/invitations/${token}/register-and-accept`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-host": `${TENANT_SLUG}.physalis.cloud`,
      "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 254) + 1}`,
    },
    body: JSON.stringify({ password: BOB_PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`register-and-accept failed: ${res.status} — ${text}`);
  }

  // Retrieve Bob's user id
  bobUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = '${BOB_EMAIL}'`)
  ).trim();

  // Add Bob as ProjectMember VIEWER
  const pmId = "ck" + randomBytes(11).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."ProjectMember" (id, "projectId", "userId", role)
     VALUES ('${pmId}', '${projId}', '${bobUserId}', 'VIEWER')`,
  );
}

beforeAll(async () => {
  admin = await adminSession();

  const orgId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."Organization" WHERE slug = 'admin'`)
  ).trim();
  const adminUserId = (
    await execSql(`SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = 'admin@artpotentiel.fr'`)
  ).trim();

  // Create project
  const projRes = await postJson(admin, "/api/projects", { name: PROJECT_NAME });
  if (projRes.status !== 201) {
    const t = await projRes.text();
    throw new Error(`project create: ${projRes.status} — ${t}`);
  }
  const projData = (await projRes.json()) as { project: { id: string; slug: string } };
  projectId = projData.project.id;
  PROJECT_SLUG = projData.project.slug;

  await provisionBobAsViewer(orgId, adminUserId, projectId);
  bobSession = await loginAs(BOB_EMAIL, BOB_PASSWORD, undefined, TENANT_SLUG);
});

afterAll(async () => {
  if (admin && PROJECT_SLUG) {
    await deleteReq(admin, `/api/projects/${PROJECT_SLUG}`).catch(() => {});
  }
  if (bobUserId) {
    await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE id = '${bobUserId}'`).catch(() => {});
  }
});

// ─── Create API ────────────────────────────────────────────────────────────

describe("POST /api/gateway/apis — Create API", () => {
  it("creates an API successfully", async () => {
    const res = await postJson(admin, "/api/gateway/apis", {
      projectSlug: PROJECT_SLUG,
      name: `My API ${SUFFIX}`,
      description: "Integration test API",
      mode: "REMOTE",
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { api: { id: string; name: string; mode: string } };
    expect(data.api.mode).toBe("REMOTE");
    expect(data.api.name).toBe(`My API ${SUFFIX}`);
    apiId = data.api.id;
  });

  it("rejects duplicate API name", async () => {
    const res = await postJson(admin, "/api/gateway/apis", {
      projectSlug: PROJECT_SLUG,
      name: `My API ${SUFFIX}`,
      mode: "REMOTE",
    });
    expect(res.status).toBe(409);
  });

  it("rejects missing name", async () => {
    const res = await postJson(admin, "/api/gateway/apis", {
      projectSlug: PROJECT_SLUG,
    });
    expect(res.status).toBe(400);
  });

  it("lists APIs for project", async () => {
    const res = await admin.fetch(`/api/gateway/apis?project=${PROJECT_SLUG}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { apis: { id: string }[] };
    expect(data.apis.some((a) => a.id === apiId)).toBe(true);
  });
});

// ─── RBAC on API ──────────────────────────────────────────────────────────

describe("RBAC — API creation requires EDITOR", () => {
  it("VIEWER (Bob) cannot create an API", async () => {
    const res = await postJson(bobSession, "/api/gateway/apis", {
      projectSlug: PROJECT_SLUG,
      name: `Bob API ${SUFFIX}`,
    });
    expect(res.status).toBe(403);
  });

  it("VIEWER (Bob) can list APIs", async () => {
    const res = await bobSession.fetch(`/api/gateway/apis?project=${PROJECT_SLUG}`);
    expect(res.status).toBe(200);
  });
});

// ─── Create Key ───────────────────────────────────────────────────────────

describe("POST /api/gateway/apis/[id]/keys — Create Key", () => {
  it("creates a key successfully", async () => {
    const res = await postJson(admin, `/api/gateway/apis/${apiId}/keys`, {
      name: `test-key-${SUFFIX}`,
      scopes: ["read"],
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      key: string;
      keyRecord: { id: string; keyPrefix: string };
    };
    expect(data.key).toMatch(/^ph_live_sk_/);
    expect(data.keyRecord.keyPrefix).toMatch(/^ph_live_sk_/);
    rawKey = data.key;
    keyId = data.keyRecord.id;
  });

  it("rejects missing name", async () => {
    const res = await postJson(admin, `/api/gateway/apis/${apiId}/keys`, {});
    expect(res.status).toBe(400);
  });

  it("VIEWER (Bob) cannot create a key", async () => {
    const res = await postJson(bobSession, `/api/gateway/apis/${apiId}/keys`, {
      name: `bob-key-${SUFFIX}`,
    });
    expect(res.status).toBe(403);
  });

  it("lists keys", async () => {
    const res = await admin.fetch(`/api/gateway/apis/${apiId}/keys`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { keys: { id: string }[] };
    expect(data.keys.some((k) => k.id === keyId)).toBe(true);
  });
});

// ─── Verify Key ───────────────────────────────────────────────────────────

describe("POST /api/gateway/verify — Verify Key", () => {
  it("valid key + apiId correct returns valid:true", async () => {
    const res = await fetch(`${BASE_URL}/api/gateway/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: rawKey, apiId, path: "/test", method: "GET" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { valid: boolean; keyId: string; apiId: string; scopes: string[] };
    expect(data.valid).toBe(true);
    expect(data.keyId).toBe(keyId);
    expect(data.apiId).toBe(apiId);
    expect(data.scopes).toContain("read");
  });

  // Cœur du correctif §2.1/§7 : une clé valide mais destinée à une AUTRE API ne
  // doit PAS valider. Sans la liaison, n'importe quelle clé de la plateforme passait.
  it("clé valide mais apiId d'une autre API → valid:false (liaison)", async () => {
    const created = await postJson(admin, "/api/gateway/apis", {
      projectSlug: PROJECT_SLUG,
      name: `Other API ${SUFFIX}`,
      mode: "REMOTE",
    });
    expect(created.status).toBe(201);
    const otherApiId = ((await created.json()) as { api: { id: string } }).api.id;

    const res = await fetch(`${BASE_URL}/api/gateway/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: rawKey, apiId: otherApiId, path: "/test", method: "GET" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { valid: boolean; reason: string };
    expect(data.valid).toBe(false);
    expect(data.reason).toBe("invalid"); // pas d'oracle : ne révèle pas qu'elle existe ailleurs

    await deleteReq(admin, `/api/gateway/apis/${otherApiId}`);
  });

  it("apiId manquant → 400 api_id_required (fail-closed)", async () => {
    const res = await fetch(`${BASE_URL}/api/gateway/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: rawKey, path: "/test", method: "GET" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { valid: boolean; reason: string };
    expect(data.valid).toBe(false);
    expect(data.reason).toBe("api_id_required");
  });

  it("invalid key + apiId returns valid:false", async () => {
    const res = await fetch(`${BASE_URL}/api/gateway/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "ph_live_sk_invalidkey123456789", apiId }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { valid: boolean; reason: string };
    expect(data.valid).toBe(false);
  });

  it("missing key returns 400", async () => {
    const res = await fetch(`${BASE_URL}/api/gateway/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiId }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Update Key ───────────────────────────────────────────────────────────

describe("PATCH /api/gateway/keys/[id] — Update Key", () => {
  it("updates key name and scopes", async () => {
    const res = await patchJson(admin, `/api/gateway/keys/${keyId}`, {
      name: `renamed-key-${SUFFIX}`,
      scopes: ["read", "write"],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { key: { name: string; scopes: string[] } };
    expect(data.key.name).toBe(`renamed-key-${SUFFIX}`);
    expect(data.key.scopes).toContain("write");
  });
});

// ─── Rate Limit ───────────────────────────────────────────────────────────

describe("Rate limit per key", () => {
  let rateLimitedKey = "";
  let rateLimitedKeyId = "";

  it("creates a key with rateLimit=2", async () => {
    const res = await postJson(admin, `/api/gateway/apis/${apiId}/keys`, {
      name: `rate-limited-${SUFFIX}`,
      rateLimit: 2,
      rateLimitWindow: "1m",
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      key: string;
      keyRecord: { id: string };
    };
    rateLimitedKey = data.key;
    rateLimitedKeyId = data.keyRecord.id;
  });

  it("first 2 calls succeed, 3rd is rate_limited", async () => {
    const call = () =>
      fetch(`${BASE_URL}/api/gateway/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: rateLimitedKey, apiId, path: "/api/data", method: "GET" }),
      });

    const r1 = await call();
    expect(r1.status).toBe(200);
    const d1 = (await r1.json()) as { valid: boolean };
    expect(d1.valid).toBe(true);

    const r2 = await call();
    expect(r2.status).toBe(200);
    const d2 = (await r2.json()) as { valid: boolean };
    expect(d2.valid).toBe(true);

    const r3 = await call();
    expect(r3.status).toBe(200);
    const d3 = (await r3.json()) as { valid: boolean; reason?: string };
    expect(d3.valid).toBe(false);
    expect(d3.reason).toBe("rate_limited");
  });

  afterAll(async () => {
    if (rateLimitedKeyId) {
      await deleteReq(admin, `/api/gateway/keys/${rateLimitedKeyId}`).catch(() => {});
    }
  });
});

// ─── Logs & Stats ─────────────────────────────────────────────────────────

describe("GET /api/gateway/apis/[id]/logs — Logs", () => {
  it("returns logs array (EDITOR required)", async () => {
    const res = await admin.fetch(`/api/gateway/apis/${apiId}/logs`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { logs: unknown[] };
    expect(Array.isArray(data.logs)).toBe(true);
    // At least the verify calls above generated logs
    expect(data.logs.length).toBeGreaterThan(0);
  });

  it("VIEWER (Bob) is denied", async () => {
    const res = await bobSession.fetch(`/api/gateway/apis/${apiId}/logs`);
    expect(res.status).toBe(403);
  });

  it("filters by valid=false", async () => {
    const res = await admin.fetch(`/api/gateway/apis/${apiId}/logs?valid=false`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { logs: { valid: boolean }[] };
    expect(data.logs.every((l) => l.valid === false)).toBe(true);
  });
});

describe("GET /api/gateway/apis/[id]/stats — Stats", () => {
  it("returns stats object (VIEWER allowed)", async () => {
    const res = await bobSession.fetch(`/api/gateway/apis/${apiId}/stats`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      total24h: number;
      failed24h: number;
      successRate: number;
      hourly: unknown[];
      topKeys: unknown[];
    };
    expect(typeof data.total24h).toBe("number");
    expect(typeof data.successRate).toBe("number");
    expect(Array.isArray(data.hourly)).toBe(true);
    expect(data.hourly).toHaveLength(24);
  });
});

// ─── Revoke Key ───────────────────────────────────────────────────────────

describe("DELETE /api/gateway/keys/[id] — Revoke Key", () => {
  it("revokes the key", async () => {
    const res = await deleteReq(admin, `/api/gateway/keys/${keyId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it("revoked key fails verify immediately (REMOTE mode — token_index deleted)", async () => {
    const res = await fetch(`${BASE_URL}/api/gateway/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: rawKey, apiId }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { valid: boolean; reason: string };
    expect(data.valid).toBe(false);
    // REMOTE mode: revoking removes the token_index entry → "invalid" (not "revoked")
    // This means the key is unresolvable before even hitting the tenant DB.
    expect(["revoked", "invalid"]).toContain(data.reason);
  });

  it("cannot revoke the same key twice", async () => {
    const res = await deleteReq(admin, `/api/gateway/keys/${keyId}`);
    expect(res.status).toBe(409);
  });
});

// ─── Update API ───────────────────────────────────────────────────────────

describe("PATCH /api/gateway/apis/[id] — Update API", () => {
  it("updates API description", async () => {
    const res = await patchJson(admin, `/api/gateway/apis/${apiId}`, {
      description: "Updated description",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { api: { description: string } };
    expect(data.api.description).toBe("Updated description");
  });
});

// ─── Delete API ───────────────────────────────────────────────────────────

describe("DELETE /api/gateway/apis/[id] — Delete API (OWNER only)", () => {
  it("VIEWER (Bob) cannot delete the API", async () => {
    const res = await deleteReq(bobSession, `/api/gateway/apis/${apiId}`);
    expect(res.status).toBe(403);
  });

  it("OWNER (admin) can delete the API", async () => {
    const res = await deleteReq(admin, `/api/gateway/apis/${apiId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it("deleted API returns 404", async () => {
    const res = await admin.fetch(`/api/gateway/apis/${apiId}`);
    expect(res.status).toBe(404);
  });
});
