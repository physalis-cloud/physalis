import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import https from "node:https";
import { EventEmitter } from "node:events";
import {
  isKmsConfigured,
  kmsKeyNameForTenant,
  provisionTenantKey,
  issueAgentSecretId,
  getRestoreToken,
} from "../../lib/kms";

// Surface déterministe uniquement (pas d'appel réseau OpenBao réel) : nommage
// des clés, gating de configuration, validation stricte du slug, body envoyé à
// OpenBao pour le mint du token restore.

const SAVED = { ...process.env };

beforeAll(() => {
  // CA présente pour tout le fichier (caPem() est mis en cache au 1ᵉʳ appel).
  process.env.OPENBAO_CACERT_PEM = "-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----";
});

afterAll(() => {
  process.env = { ...SAVED };
});

describe("kmsKeyNameForTenant", () => {
  it("préfixe le slug par tenant-", () => {
    expect(kmsKeyNameForTenant("argoweb")).toBe("tenant-argoweb");
  });
});

describe("isKmsConfigured", () => {
  it("vrai quand addr + admin role/secret + CA sont présents", () => {
    process.env.OPENBAO_ADDR = "https://kms.example:8200";
    process.env.OPENBAO_ADMIN_ROLE_ID = "role-id";
    process.env.OPENBAO_ADMIN_SECRET_ID = "secret-id";
    expect(isKmsConfigured()).toBe(true);
  });

  it("faux si une variable requise manque (dual-path → reste en GPG)", () => {
    process.env.OPENBAO_ADDR = "https://kms.example:8200";
    process.env.OPENBAO_ADMIN_ROLE_ID = "role-id";
    delete process.env.OPENBAO_ADMIN_SECRET_ID;
    expect(isKmsConfigured()).toBe(false);
  });
});

describe("getRestoreToken — token_bound_cidrs (§2.25b)", () => {
  // OpenBao simulé au niveau de https.request : on capture le body de chaque
  // appel et on répond ce qu'attend le flux (admin login → role-id → secret-id
  // → login restore).
  let calls: { path: string; body: Record<string, unknown> | undefined }[];

  beforeEach(() => {
    process.env.OPENBAO_ADDR = "https://kms.example:8200";
    process.env.OPENBAO_ADMIN_ROLE_ID = "admin-role";
    process.env.OPENBAO_ADMIN_SECRET_ID = "admin-secret";
    calls = [];
    vi.spyOn(https, "request").mockImplementation(((url: URL, _opts: unknown, cb: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { write: (s: string) => void; end: () => void };
      let payload = "";
      req.write = (s: string) => { payload += s; };
      req.end = () => {
        const path = url.pathname;
        calls.push({ path, body: payload ? JSON.parse(payload) : undefined });
        const reply =
          path.endsWith("/role-id") ? { data: { role_id: "rid" } }
          : path.endsWith("/secret-id") ? { data: { secret_id: "sid" } }
          : { auth: { client_token: "tok" } };
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = 200;
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify(reply)));
        res.emit("end");
      };
      return req;
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  const secretIdBody = () => calls.find((c) => c.path.endsWith("/secret-id"))?.body;

  it("lie le token à TOUTES les IP fournies (requête Tailscale + IP publique)", async () => {
    const r = await getRestoreToken("argo", ["100.118.195.40/32", "203.0.113.10/32"]);
    expect(r.token).toBe("tok");
    expect(secretIdBody()).toEqual({ token_bound_cidrs: ["100.118.195.40/32", "203.0.113.10/32"] });
  });

  it("ne pose jamais de cidr_list sur le secret_id (consommé par le control plane)", async () => {
    await getRestoreToken("argo", ["203.0.113.10/32"]);
    expect(secretIdBody()).not.toHaveProperty("cidr_list");
  });

  it("sans IP : token non borné (body vide)", async () => {
    await getRestoreToken("argo", []);
    expect(secretIdBody()).toEqual({});
  });
});

describe("validation du slug (avant tout appel réseau)", () => {
  const bad = ["", "Bad_Slug", "a/b", "-lead", "x".repeat(64), "Évil"];
  for (const slug of bad) {
    it(`rejette « ${slug} »`, async () => {
      await expect(provisionTenantKey(slug)).rejects.toThrow(/slug tenant invalide/);
      await expect(issueAgentSecretId(slug)).rejects.toThrow(/slug tenant invalide/);
      await expect(getRestoreToken(slug)).rejects.toThrow(/slug tenant invalide/);
    });
  }
});
