// Test expiration d'un lien de partage (OneTimeShare).
//
// Couvre proposal Fonctionnel Secrets #8 — un lien de partage expire bien.
//
// Route publique POST /api/share/[token] : rejette (404) si
// `expiresAt <= now` (cf. app/api/share/[token]/route.ts, double garde :
// le findUnique ET le updateMany atomique filtrent sur expiresAt).
//
// Stratégie : créer un share via l'API, forcer `expiresAt` dans le passé en
// DB, puis tenter de le consommer → 404. Un share frais (témoin) se consomme
// bien (200) pour prouver que le 404 vient de l'expiration, pas d'un setup
// cassé.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  Session,
  adminSession,
  postJson,
  BASE_URL,
  TENANT_SCHEMA,
} from "./helpers/api";
import { execSql } from "./helpers/db";

const CIPHERTEXT = "ZmFrZS1jaXBoZXJ0ZXh0"; // base64 quelconque (≤ 16 KB)
const IV = "ZmFrZWl2MTIzNA=="; // ≤ 32 chars

let admin: Session;
const createdHashes: string[] = [];

async function createShare(): Promise<string> {
  const res = await postJson(admin, "/api/share", {
    ciphertext: CIPHERTEXT,
    iv: IV,
    ttlSeconds: 900,
  });
  if (res.status !== 201) {
    throw new Error(`share create expected 201, got ${res.status}`);
  }
  const { token } = (await res.json()) as { token: string };
  createdHashes.push(createHash("sha256").update(token).digest("hex"));
  return token;
}

/** Consommation = route publique anonyme (le token EST l'auth). */
async function consume(token: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/share/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 254) + 1}`,
    },
    body: "{}",
  });
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

describe("Expiration d'un lien de partage (Fonctionnel Secrets #8)", () => {
  // Tests séquentiels (vitest integ a sequence.concurrent:false).

  it("Témoin : un share frais se consomme (200, renvoie le ciphertext)", async () => {
    const token = await createShare();
    const res = await consume(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ciphertext?: string };
    expect(body.ciphertext).toBe(CIPHERTEXT);
  });

  it("Un share expiré (expiresAt passé) est refusé (404)", async () => {
    const token = await createShare();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    // Force l'expiration dans le passé.
    await execSql(
      `UPDATE "${TENANT_SCHEMA}"."OneTimeShare"
       SET "expiresAt" = NOW() - INTERVAL '1 hour'
       WHERE "tokenHash" = '${tokenHash}'`,
    );
    const res = await consume(token);
    expect(res.status).toBe(404);
  });

  it("Le refus pour expiration ne marque PAS consumedAt", async () => {
    // Le dernier share créé = l'expiré. Un rejet pour expiration ne doit pas
    // le marquer consommé (sinon faux signal « déjà vu » au lieu de « expiré »).
    const tokenHash = createdHashes[createdHashes.length - 1];
    const consumedAt = (
      await execSql(
        `SELECT "consumedAt" FROM "${TENANT_SCHEMA}"."OneTimeShare"
         WHERE "tokenHash" = '${tokenHash}'`,
      )
    ).trim();
    expect(consumedAt).toBe(""); // NULL → sortie tuples-only vide
  });
});
