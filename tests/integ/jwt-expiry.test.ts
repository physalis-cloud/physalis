// Test d'intégration : rejet d'un JWT de session expiré (Auth #4).
//
// Contexte : NextAuth v5 émet des **JWE** (`dir` + A256GCM), pas des JWT
// signés — l'`exp` est posé par `encode()` à partir de `session.maxAge` (8h,
// cf. lib/auth.config.ts) et vérifié au `decode()` via jose `jwtDecrypt`
// (clockTolerance: 15s). On ne peut donc pas « attendre 8h » ni bricoler un
// payload en clair : on forge un vrai JWE avec la clé serveur (AUTH_SECRET)
// et un `exp` dans le passé, puis on vérifie que la route authentifiée le
// rejette (401).
//
// Le test de CONTRÔLE (token forgé valide → 200) prouve que la clé, le salt
// (= nom du cookie) et les claims sont corrects : il isole donc l'expiration
// comme seule cause du 401 sur le token expiré (sinon un 401 pourrait venir
// d'un token mal formé, pas de son expiration).
//
// Pré-requis : stack live. AUTH_SECRET lu depuis le conteneur app, id admin
// depuis client_test."User". Sonde : GET /api/me/2fa (passe par requireUser).

import { describe, it, expect, beforeAll } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { encode } from "@auth/core/jwt";
import { BASE_URL, ADMIN_EMAIL, TENANT_SLUG, TENANT_SCHEMA } from "./helpers/api";
import { execSql } from "./helpers/db";

const execAsync = promisify(exec);

const PROBE = "/api/me/2fa";
// Sur http://localhost (secure=false), NextAuth nomme le cookie de session
// `authjs.session-token` ; ce nom sert aussi de `salt` HKDF au chiffrement.
const COOKIE_NAME = "authjs.session-token";
const APP_CONTAINER = process.env.TEST_APP_CONTAINER ?? "physalis";

let secret: string;
let adminId: string;

/** Claims minimaux attendus par le callback `session` → `requireUser()`. */
function baseClaims() {
  return {
    id: adminId,
    email: ADMIN_EMAIL,
    role: "USER",
    tenantSlug: TENANT_SLUG,
    loginAt: Date.now(),
  };
}

/** Forge un JWE NextAuth ; `maxAge` négatif ⇒ `exp` dans le passé. */
async function mintToken(maxAge: number): Promise<string> {
  return encode({ token: baseClaims(), secret, salt: COOKIE_NAME, maxAge });
}

async function probeWith(token: string): Promise<number> {
  const res = await fetch(`${BASE_URL}${PROBE}`, {
    headers: {
      cookie: `${COOKIE_NAME}=${token}`,
      "x-forwarded-for": "203.0.113.77",
    },
    redirect: "manual",
  });
  return res.status;
}

beforeAll(async () => {
  const { stdout } = await execAsync(
    `docker exec ${APP_CONTAINER} printenv AUTH_SECRET`,
  );
  secret = stdout.trim();
  if (!secret) throw new Error("AUTH_SECRET introuvable dans le conteneur app");
  adminId = await execSql(
    `SELECT id FROM ${TENANT_SCHEMA}."User" WHERE email = '${ADMIN_EMAIL}' LIMIT 1`,
  );
  if (!adminId) throw new Error(`admin ${ADMIN_EMAIL} introuvable en DB`);
});

describe("Auth #4 — JWT de session expiré", () => {
  it("token forgé valide (exp futur) → route authentifiée accessible (200)", async () => {
    // CONTRÔLE : prouve que clé + salt + claims sont corrects.
    expect(await probeWith(await mintToken(3600))).toBe(200);
  });

  it("token forgé expiré (exp passé) → rejeté (401)", async () => {
    // 1h dans le passé : bien au-delà des 15s de clockTolerance de jose.
    expect(await probeWith(await mintToken(-3600))).toBe(401);
  });

  it("token expiré d'1s seulement (hors clockTolerance après marge) → rejeté (401)", async () => {
    // -60s : au-delà de la tolérance d'horloge (15s) → doit être rejeté.
    expect(await probeWith(await mintToken(-60))).toBe(401);
  });

  it("aucun cookie de session → 401 (sanity)", async () => {
    const res = await fetch(`${BASE_URL}${PROBE}`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });
});
