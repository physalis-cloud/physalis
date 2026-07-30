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

/**
 * Budget de ce fichier — il orchestre des conteneurs, pas des requêtes.
 *
 * `restoreStack` appelle `waitHealthy` DEUX fois (après le start DB, puis après
 * le restart app), chacune pouvant attendre jusqu'à 30 s, plus la latence des
 * `docker stop/start`. Le plafond par défaut de 30 s (vitest.integ.config.ts)
 * était donc structurellement intenable : le test expirait pendant la
 * restauration, quel que soit l'état du code. C'est d'autant plus vrai sur une
 * stack de DÉVELOPPEMENT, où l'app recompile la route au premier appel après
 * un restart, là où l'en-tête suppose un boot standalone de ~4 s.
 */
const CONTAINER_ORCHESTRATION_TIMEOUT_MS = 150_000;

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

/**
 * Attend que l'app soit RÉELLEMENT prête, pas seulement que `/api/health`
 * réponde.
 *
 * ⚠️ Ce fichier contaminait les fichiers exécutés APRÈS lui. `waitHealthy`
 * relâchait dès le premier 200 sur `/api/health`, alors que l'app finissait de
 * démarrer : le fichier suivant partait aussitôt et se prenait un 500, un
 * socket fermé, ou un setup qui déclare « la stack ne répond pas ». Observé en
 * mesure de suite complète sur rbac, session-forge, cookie-attrs et
 * input-validation — quatre échecs qui n'avaient rien à voir avec leur objet.
 *
 * Deux durcissements : on exige DEUX succès CONSÉCUTIFS espacés (un démarrage
 * en cours peut répondre une fois puis retomber), et on sonde une VRAIE page en
 * plus de `/api/health` — en dev, chaque route se compile à son premier appel,
 * donc un `/api/health` vert ne dit rien du reste de l'app.
 */
async function waitHealthy(maxTries = 40): Promise<void> {
  let consecutive = 0;
  for (let i = 0; i < maxTries; i++) {
    try {
      const h = await health();
      const page = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
      if (h.status === 200 && page.status < 500) {
        consecutive++;
        if (consecutive >= 2) return;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      consecutive = 0;
    } catch {
      consecutive = 0;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Stack pas revenue saine après restart");
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
}, CONTAINER_ORCHESTRATION_TIMEOUT_MS);

// Filet de sécurité : quoi qu'il arrive, la stack doit être relancée et saine.
afterAll(async () => {
  await restoreStack();
}, CONTAINER_ORCHESTRATION_TIMEOUT_MS);

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

      // 2. Route data authentifiée : la garde de session interroge la DB.
      //
      //    Le résultat observé est un **401**, pas un 5xx — et c'est correct.
      //    Le callback `jwt` (lib/auth.ts) lit `sessionsValidFrom` sans `catch`
      //    délibéré, en pariant que « l'erreur remonte » ; en pratique
      //    next-auth l'avale et rend une session anonyme, donc `requireUser`
      //    répond 401. Le commentaire du code est optimiste, mais le résultat
      //    reste **fail-closed** : aucune requête authentifiée ne passe quand
      //    la borne d'invalidation n'est pas vérifiable. C'est la bonne
      //    posture sur une garde de sécurité.
      //
      //    L'INVARIANT testé ici n'est donc pas le code exact, mais l'absence
      //    de fuite : ni stack trace, ni chaîne de connexion, ni port DB.
      //    On accepte 401 (fail-closed) comme 5xx (dégradation), et on refuse
      //    tout le reste — un 200 signalerait un fail-OPEN.
      const r = await authed.fetch("/api/me/2fa");
      expect([401, 500, 502, 503]).toContain(r.status);
      const rBody = await r.text();
      assertNoLeak(rBody);
    } finally {
      // Restauration complète (DB + redémarrage app pour pools neufs).
      await restoreStack();
    }

    // 3. Après restauration : service de nouveau opérationnel.
    expect((await health()).status).toBe(200);
  }, CONTAINER_ORCHESTRATION_TIMEOUT_MS);
});
