// Test d'intégration : comportement quand la base est indisponible (Qualité #3).
//
// On coupe BRIÈVEMENT le conteneur DB (`docker stop`) puis on le redémarre,
// pour vérifier que l'app dégrade proprement : message correct + code adapté,
// JAMAIS de 500 brut fuitant une stack trace, le client Prisma, la chaîne de
// connexion ou le port DB.
//
// Sûr car : suite séquentielle (fileParallelism:false), fenêtre de coupure de
// ~1 s (connexion refusée = échec immédiat, pas de hang), et restauration
// garantie via `finally` + `afterAll`.
//
// RESTAURATION COMPLÈTE : un `docker stop/start` de la DB partagée laisse des
// connexions MORTES dans les pools Prisma de l'app (basePrisma ET tenant) ;
// le 1er hit suivant — y compris un login — échoue alors une fois (500, ou
// NextAuth qui redirige en erreur). Pour ne PAS léguer cette flakiness aux
// autres fichiers de la suite, on redémarre le conteneur APP après la panne :
// pools neufs garantis (~4 s boot-to-healthy), comportement déterministe.
//
// Surfaces testées :
//   - /api/health  → 503 { status:"degraded", db:"error" } (dégradation conçue)
//   - /api/me/2fa  → 5xx propre sur une route data authentifiée (requireUser
//                    interroge la DB) : pas de fuite d'internals dans le body.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  BASE_URL,
  loginAs,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  type Session,
} from "./helpers/api";

const execAsync = promisify(exec);
const DB_CONTAINER = process.env.TEST_DB_CONTAINER ?? "physalis-db";
const APP_CONTAINER = process.env.TEST_APP_CONTAINER ?? "physalis";

/** Motifs qui ne doivent JAMAIS apparaître dans une réponse d'erreur. */
const LEAK_PATTERNS = [
  "prisma",
  "PrismaClient",
  "econnrefused",
  "node_modules",
  "at async",
  "at object.",
  "reach database",
  "5432",
  "postgresql://",
  ".ts:",
  ".js:",
];

function assertNoLeak(body: string) {
  const lower = body.toLowerCase();
  for (const p of LEAK_PATTERNS) {
    expect(lower, `fuite d'internals: "${p}"`).not.toContain(p.toLowerCase());
  }
}

async function health(): Promise<Response> {
  return fetch(`${BASE_URL}/api/health`, { redirect: "manual" });
}

async function waitHealthy(maxTries = 30): Promise<void> {
  for (let i = 0; i < maxTries; i++) {
    try {
      if ((await health()).status === 200) return;
    } catch {
      /* DB encore en train de remonter */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("DB pas revenue healthy après restart");
}

// Restaure la DB puis redémarre l'app pour repartir sur des pools Prisma
// neufs (cf. en-tête) — état déterministe garanti pour le fichier suivant.
async function restoreStack(): Promise<void> {
  await execAsync(`docker start ${DB_CONTAINER}`).catch(() => {});
  await waitHealthy();
  await execAsync(`docker restart ${APP_CONTAINER}`);
  await waitHealthy();
}

// Session pré-authentifiée (login pendant que la DB est UP) pour sonder une
// route data pendant la panne.
let authed: Session;

beforeAll(async () => {
  await waitHealthy(); // état de départ sain
  authed = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD, "203.0.113.66");
});

// Filet de sécurité : quoi qu'il arrive, la stack doit être relancée et saine.
afterAll(async () => {
  await restoreStack();
});

describe("Qualité #3 — base de données indisponible", () => {
  it("dégrade proprement puis récupère, sans fuite d'internals", async () => {
    // Baseline saine.
    expect((await health()).status).toBe(200);

    await execAsync(`docker stop ${DB_CONTAINER}`);
    try {
      // 1. /api/health : dégradation conçue → 503 + message structuré.
      const h = await health();
      expect(h.status).toBe(503);
      const hBody = await h.text();
      const hJson = JSON.parse(hBody) as { status?: string; db?: string };
      expect(hJson.status).toBe("degraded");
      expect(hJson.db).toBe("error");
      assertNoLeak(hBody);

      // 2. Route data authentifiée : requireUser() interroge la DB → erreur.
      //    Doit renvoyer un 5xx propre, pas une stack trace.
      const r = await authed.fetch("/api/me/2fa");
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(r.status).toBeLessThan(600);
      const rBody = await r.text();
      assertNoLeak(rBody);
    } finally {
      // Restauration complète (DB + redémarrage app pour pools neufs).
      await restoreStack();
    }

    // 3. Après restauration : service de nouveau opérationnel.
    expect((await health()).status).toBe(200);
  });
});
