// C-0050 (agent-ssh), phase 3 — API de l'agent SSH contre la stack réelle :
// liste des clés publiques et signature côté serveur, avec une session CLI.
// La signature renvoyée est vérifiée avec la clé publique ; les refus
// (clé inconnue, session coupée, session IA, clé supprimée) et le journal aussi.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash, createPublicKey, verify } from "node:crypto";
import {
  BASE_URL,
  Session,
  adminSession,
  postJson,
  deleteReq,
  TENANT_SLUG,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql, execSqlValue } from "./helpers/db";
import { cuid } from "./helpers/org";

const RUN = `integ-agent-ssh-${Date.now()}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const created: string[] = [];
const tokens: string[] = [];
let admin: Session;
let adminUserId = "";

type Key = { name: string; fingerprint: string; publicKey: string; algorithm: string };

/** Session CLI posée en base pour l'admin (le flux d'appareil est prouvé ailleurs). */
async function seedSession(kind = "HUMAN", userId = adminUserId): Promise<string> {
  const token = "sv_cli_" + randomBytes(32).toString("hex");
  await execSql(
    `INSERT INTO "${TENANT_SCHEMA}"."CliSession" (id, "tokenHash", "userId", kind, "deviceName", "expiresAt", "createdAt")
     VALUES ('${cuid()}', '${sha256(token)}', '${userId}', '${kind}', '${RUN}', NOW() + interval '12 hours', NOW())`,
  );
  await execSql(
    `INSERT INTO admin.token_index (token_hash, tenant_slug, kind, created_at)
     VALUES ('${sha256(token)}', '${TENANT_SLUG}', 'CLI', NOW())`,
  );
  tokens.push(token);
  return token;
}

const agent = (token: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "x-forwarded-for": `10.88.${randomBytes(1)[0]}.${randomBytes(1)[0]}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/** Une demande d'authentification SSH (RFC 4252 §7), comme celle que signe un client. */
function userauthData(user: string, pubBlob: Buffer): Buffer {
  const s = (b: Buffer | string) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    return Buffer.concat([len, buf]);
  };
  return Buffer.concat([
    s(randomBytes(32)),
    Buffer.from([50]),
    s(user),
    s("ssh-connection"),
    s("publickey"),
    Buffer.from([1]),
    s("ssh-ed25519"),
    s(pubBlob),
  ]);
}

let key: Key;
let token = "";

beforeAll(async () => {
  admin = await adminSession();
  adminUserId = await execSqlValue(
    `SELECT id FROM "${TENANT_SCHEMA}"."User" WHERE email = 'admin@artpotentiel.fr'`,
  );
  const res = await postJson(admin, "/api/vault/ssh-keys", { name: `${RUN}-cle`, mode: "generate" });
  expect(res.status).toBe(201);
  created.push(((await res.json()) as { entry: { id: string } }).entry.id);
  token = await seedSession();
});

afterAll(async () => {
  for (const id of created) await deleteReq(admin, `/api/vault/entries/${id}`);
  for (const t of tokens) {
    await execSql(`DELETE FROM admin.token_index WHERE token_hash = '${sha256(t)}'`);
  }
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."CliSession" WHERE "deviceName" = '${RUN}'`);
  await execSql(`DELETE FROM "${TENANT_SCHEMA}"."User" WHERE email = '${RUN}-autre@test.local'`);
});

describe("GET /api/agent/ssh/keys", () => {
  it("liste les clés publiques de l'utilisateur, sans rien de secret", async () => {
    const res = await agent(token, "/api/agent/ssh/keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Key[] };
    const mine = body.keys.find((k) => k.name === `${RUN}-cle`);
    expect(mine?.algorithm).toBe("ssh-ed25519");
    expect(mine?.fingerprint).toMatch(/^SHA256:/);
    // L'empreinte est bien celle du blob renvoyé.
    const blob = Buffer.from(mine!.publicKey, "base64");
    expect("SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")).toBe(mine!.fingerprint);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE KEY|encryptedData/);
    key = mine!;
  });

  it("sans session valide → 401", async () => {
    expect((await agent("sv_cli_" + "0".repeat(64), "/api/agent/ssh/keys")).status).toBe(401);
    expect((await fetch(`${BASE_URL}/api/agent/ssh/keys`)).status).toBe(401);
  });
});

describe("POST /api/agent/ssh/sign", () => {
  it("signe côté serveur ; la signature se vérifie avec la clé publique", async () => {
    const blob = Buffer.from(key.publicKey, "base64");
    const data = userauthData("deploy", blob);
    const res = await agent(token, "/api/agent/ssh/sign", {
      fingerprint: key.fingerprint,
      data: data.toString("base64"),
      flags: 0,
    });
    expect(res.status).toBe(200);
    const sigBlob = Buffer.from(((await res.json()) as { signature: string }).signature, "base64");
    // Blob = string("ssh-ed25519") + string(signature de 64 octets).
    expect(sigBlob.subarray(4, 4 + sigBlob.readUInt32BE(0)).toString()).toBe("ssh-ed25519");
    const raw = sigBlob.subarray(4 + 11 + 4);
    expect(raw.length).toBe(64);
    // Clé publique ed25519 = les 32 derniers octets du blob.
    const pub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: blob.subarray(blob.length - 32).toString("base64url") },
      format: "jwk",
    });
    expect(verify(null, data, pub, raw)).toBe(true);
  });

  it("la signature est journalisée, avec le compte SSH visé", async () => {
    const user = await execSqlValue(
      `SELECT metadata->>'sshUser' FROM "${TENANT_SCHEMA}"."AccessLog"
         WHERE action = 'SSH_KEY_SIGN' AND metadata->>'fingerprint' = '${key.fingerprint}'
         ORDER BY "createdAt" DESC LIMIT 1`,
    );
    expect(user).toBe("deploy");
  });

  it("clé inconnue → 404, requête mal formée → 400", async () => {
    const data = Buffer.from("x").toString("base64");
    const unknown = "SHA256:" + "A".repeat(43);
    expect((await agent(token, "/api/agent/ssh/sign", { fingerprint: unknown, data })).status).toBe(404);
    expect((await agent(token, "/api/agent/ssh/sign", { fingerprint: "pas-une-empreinte", data })).status).toBe(400);
    expect((await agent(token, "/api/agent/ssh/sign", { fingerprint: key.fingerprint })).status).toBe(400);
  });

  it("un AUTRE utilisateur ne signe pas avec ma clé, même avec son empreinte (publique)", async () => {
    const otherId = cuid();
    await execSql(
      `INSERT INTO "${TENANT_SCHEMA}"."User" (id, email, "createdAt") VALUES ('${otherId}', '${RUN}-autre@test.local', NOW())`,
    );
    const other = await seedSession("HUMAN", otherId);
    const res = await agent(other, "/api/agent/ssh/sign", {
      fingerprint: key.fingerprint,
      data: Buffer.from("x").toString("base64"),
    });
    expect(res.status).toBe(404);
    const list = (await (await agent(other, "/api/agent/ssh/keys")).json()) as { keys: Key[] };
    expect(list.keys.some((k) => k.fingerprint === key.fingerprint)).toBe(false);
  });

  it("une session « agent IA » n'a pas accès aux clés SSH", async () => {
    const ai = await seedSession("AI");
    const res = await agent(ai, "/api/agent/ssh/keys");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden", reason: "ai_ssh_not_granted" });
  });

  it("session coupée → l'agent ne signe plus, sans rien redémarrer", async () => {
    const t = await seedSession();
    const body = { fingerprint: key.fingerprint, data: Buffer.from("x").toString("base64") };
    expect((await agent(t, "/api/agent/ssh/sign", body)).status).toBe(200);
    await execSql(`UPDATE "${TENANT_SCHEMA}"."CliSession" SET "revokedAt" = NOW() WHERE "tokenHash" = '${sha256(t)}'`);
    expect((await agent(t, "/api/agent/ssh/sign", body)).status).toBe(401);
  });

  it("clé supprimée du coffre → l'agent ne peut plus signer avec", async () => {
    const res = await postJson(admin, "/api/vault/ssh-keys", { name: `${RUN}-ephemere`, mode: "generate" });
    const { entry } = (await res.json()) as { entry: { id: string; sshFingerprint: string } };
    const body = { fingerprint: entry.sshFingerprint, data: Buffer.from("x").toString("base64") };
    expect((await agent(token, "/api/agent/ssh/sign", body)).status).toBe(200);
    expect((await deleteReq(admin, `/api/vault/entries/${entry.id}`)).status).toBe(200);
    expect((await agent(token, "/api/agent/ssh/sign", body)).status).toBe(404);
  });
});
