// §2.12 — le compteur de tentatives de mot de passe d'un OneTimeShare doit être
// atomique.
//
// L'implémentation d'origine lisait le share, faisait un `bcrypt.compare`
// (cost 12, ~250 ms), puis écrivait `share.passwordAttempts + 1` — une valeur
// dérivée d'un instantané pris AVANT le bcrypt, dans une transaction distincte
// et sans verrou. N requêtes concurrentes lisaient toutes N0 et écrivaient
// toutes N0+1 : un lot de N essais ne faisait progresser le compteur que de 1.
// Le seuil de 5, qui doit auto-révoquer le partage et zéroer le ciphertext, ne
// bornait donc plus rien — budget réel ~5 × concurrence, de quoi épuiser un PIN
// à 4 chiffres (PASSWORD_MIN = 4) dans le TTL de 24 h.
//
// La concurrence ne se teste pas en unitaire : il faut de vraies requêtes
// simultanées contre une vraie base. D'où ce test d'intégration.

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

const CIPHERTEXT = "ZmFrZS1jaXBoZXJ0ZXh0";
const IV = "ZmFrZWl2MTIzNA==";
const GOOD = "1234"; // PASSWORD_MIN = 4, sans exigence de complexité
const BAD = "0000";

let admin: Session;
const createdHashes: string[] = [];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function createShare(password: string): Promise<string> {
  const res = await postJson(admin, "/api/share", {
    ciphertext: CIPHERTEXT,
    iv: IV,
    ttlSeconds: 900,
    password,
  });
  if (res.status !== 201) {
    throw new Error(`share create expected 201, got ${res.status}`);
  }
  const { token } = (await res.json()) as { token: string };
  createdHashes.push(sha256(token));
  return token;
}

// IP unique par requête : `share-consume` est limité à 30/min/IP, or cette
// suite tire une trentaine d'essais. Ça n'affaiblit rien — le compteur testé
// est porté par le SHARE, pas par l'IP, ce qui est précisément le sujet : un
// attaquant distribué ne doit pas gagner d'essais.
let ipSeq = 0;
const nextIp = () => `198.51.100.${(ipSeq++ % 254) + 1}`;

/** Route publique anonyme : le token EST l'authentification. */
async function consume(token: string, password: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/share/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextIp(),
    },
    body: JSON.stringify({ password }),
  });
}

/** Lit l'état du share en base : compteur, révocation, ciphertext zéroé. */
async function state(token: string) {
  const out = await execSql(
    `SELECT "passwordAttempts", ("revokedAt" IS NOT NULL), ("ciphertext" = '')
       FROM "${TENANT_SCHEMA}"."OneTimeShare" WHERE "tokenHash" = '${sha256(token)}'`,
  );
  const [attempts, revoked, zeroed] = out.trim().split("|");
  return {
    attempts: Number(attempts),
    revoked: revoked === "t",
    zeroed: zeroed === "t",
  };
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

describe("§2.12 — compteur de tentatives atomique sur les partages", () => {
  it("séquentiel (témoin) : 5 échecs révoquent le partage et zèrent le ciphertext", async () => {
    const token = await createShare(GOOD);
    for (let i = 1; i <= 5; i++) {
      const res = await consume(token, BAD);
      expect(res.status, `essai ${i}`).toBe(401);
    }
    const s = await state(token);
    expect(s.attempts).toBe(5);
    expect(s.revoked).toBe(true);
    expect(s.zeroed).toBe(true);
  });

  it("CONCURRENT : 10 essais simultanés comptent tous et révoquent", async () => {
    const token = await createShare(GOOD);
    // Le cœur du finding. Avant le correctif : attempts = 1, revoked = false —
    // 10 essais pour le prix d'un.
    await Promise.all(Array.from({ length: 10 }, () => consume(token, BAD)));

    const s = await state(token);
    expect(s.attempts).toBe(10); // chaque tentative a bien été comptée
    expect(s.revoked).toBe(true);
    expect(s.zeroed).toBe(true);
  });

  it("après révocation, même le BON mot de passe ne rend plus rien", async () => {
    const token = await createShare(GOOD);
    await Promise.all(Array.from({ length: 10 }, () => consume(token, BAD)));
    const res = await consume(token, GOOD);
    expect(res.status).toBe(404);
  });

  // Garde anti sur-restriction : une première version du correctif révoquait
  // AVANT de vérifier le mot de passe, ce qui refusait un utilisateur légitime
  // s'étant trompé 4 fois. La révocation ne doit avoir lieu que sur échec.
  it("4 échecs puis le BON mot de passe au 5e essai : le partage se consomme", async () => {
    const token = await createShare(GOOD);
    for (let i = 1; i <= 4; i++) {
      expect((await consume(token, BAD)).status, `essai ${i}`).toBe(401);
    }
    const res = await consume(token, GOOD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ciphertext?: string };
    expect(body.ciphertext).toBe(CIPHERTEXT);
  });

  it("un mot de passe absent ne consomme pas de tentative", async () => {
    const token = await createShare(GOOD);
    const res = await fetch(`${BASE_URL}/api/share/${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": nextIp(),
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect((await state(token)).attempts).toBe(0);
  });
});
