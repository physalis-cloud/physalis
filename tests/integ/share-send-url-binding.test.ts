// §2.22 — POST /api/me/shares/[id]/send acceptait `body.url` sur le seul
// `startsWith("http")`, SANS lien avec le share, puis l'interpolait non échappé :
// n'importe quel utilisateur envoyait un mail signé par notre DKIM pointant vers
// un host arbitraire (phishing) + injectait du markup.
//
// Le fix VÉRIFIE que l'URL désigne bien CE share (token du path → hash comparé au
// tokenHash stocké) avant tout envoi. On prouve la rejection des URL non liées
// (400 avec un message spécifique, pour distinguer des autres 400 possibles).
// Le chemin succès n'est pas exercé ici : il ENVERRAIT un vrai mail (le stack dev
// a EMAIL_PHYSALIS_* configuré).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  Session,
  adminSession,
  postJson,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const CIPHERTEXT = "ZmFrZS1jaXBoZXJ0ZXh0";
const IV = "ZmFrZWl2MTIzNA==";

let admin: Session;
const createdHashes: string[] = [];

async function createShare(): Promise<{ id: string; token: string }> {
  const res = await postJson(admin, "/api/share", {
    ciphertext: CIPHERTEXT,
    iv: IV,
    ttlSeconds: 900,
  });
  if (res.status !== 201) {
    throw new Error(`share create expected 201, got ${res.status}`);
  }
  const { id, token } = (await res.json()) as { id: string; token: string };
  createdHashes.push(createHash("sha256").update(token).digest("hex"));
  return { id, token };
}

beforeAll(async () => {
  admin = await adminSession();
});

afterAll(async () => {
  for (const h of createdHashes) {
    await execSql(
      `DELETE FROM "${TENANT_SCHEMA}"."OneTimeShare" WHERE "tokenHash" = '${h}'`,
    );
  }
});

describe("§2.22 — l'URL envoyée doit désigner le share (token → hash)", () => {
  it("une URL sans token de share valide est rejetée (400)", async () => {
    const { id } = await createShare();
    const res = await postJson(admin, `/api/me/shares/${id}/send`, {
      email: "victim@test.local",
      url: "https://evil.tld/phishing",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/does not match this share/i);
  });

  it("une URL bien formée mais avec un AUTRE token est rejetée (400)", async () => {
    const { id } = await createShare();
    const otherToken = "sv_share_" + "a".repeat(64); // format valide, hash ≠
    const res = await postJson(admin, `/api/me/shares/${id}/send`, {
      email: "victim@test.local",
      url: `https://evil.tld/fr/share/${otherToken}#somekey`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/does not match this share/i);
  });

  it("le vrai token d'un AUTRE share (host arbitraire) est rejeté pour ce share (400)", async () => {
    const a = await createShare();
    const b = await createShare();
    // URL du share B présentée pour l'envoi du share A → hash ≠ tokenHash(A).
    const res = await postJson(admin, `/api/me/shares/${a.id}/send`, {
      email: "victim@test.local",
      url: `https://evil.tld/fr/share/${b.token}#k`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/does not match this share/i);
  });
});
