// Test statique — garde-fou de la piste d'audit P3 (documentation/rapports/failles.md §5/P3, §37).
//
// Contexte : le cookie de session est `sameSite: lax` (partagé sur
// `.physalis.cloud` pour porter le SSO multi-tenant). `lax` envoie le cookie
// sur toute navigation GET top-level (clic sur un lien) → une route HTTP **GET
// qui mute l'état serveur** est un vecteur CSRF (la victime authentifiée
// déclenche la mutation en cliquant un lien attaquant). Les mutations en
// POST/PUT/PATCH/DELETE sont sûres : `lax` ne les envoie pas cross-site.
//
// L'audit P3 a établi qu'AUCUN handler GET cookie-authentifié ne mute l'état :
// les écritures présentes dans des GET sont soit des `logAction` d'audit
// (REVEAL/FETCH, bénignes), soit des mutations en routes **bearer d'agent**
// (`consumeForceRequest`, hors portée du cookie). Le seul risque résiduel est
// une **future** route GET qui introduirait une mutation.
//
// Ce test est un TRIPWIRE : il casse si un corps de handler `GET` sous app/api
// (ou app/**) introduit une mutation Prisma inline
// (create/update/delete/upsert/$executeRaw). Style aligné sur les autres tests
// statiques du repo (secrets-no-leak-static, crypto-aad-invariant).
//
// Limite assumée : ne détecte que les mutations Prisma INLINE dans le corps du
// GET (pas une mutation cachée derrière un nouveau helper). C'est le garde-fou
// proportionné : la forme la plus courante de la régression. La règle de fond
// (mutation ⇒ méthode non-GET) reste une responsabilité de revue.

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");

/** Signatures de mutation Prisma (écriture d'état persistant). */
const MUTATION_RE =
  /\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(|\$executeRaw|\$executeRawUnsafe/;

/** Tous les route.ts sous app/ qui exportent un handler GET. */
function routeFilesWithGet(): string[] {
  try {
    const out = execSync(
      `grep -rl "export async function GET" app --include=route.ts`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Extrait le corps textuel du handler GET : de la ligne `export async
 * function GET` jusqu'au prochain export de handler/const, ou la fin du
 * fichier. Suffisant pour isoler le GET des éventuels PUT/DELETE du même
 * fichier (qui, eux, ont le droit de muter).
 */
function extractGetBody(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /export async function GET\b/.test(l));
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (
      i > start &&
      (/^export (const|async function|function) /.test(l)) &&
      !/GET\b/.test(l)
    ) {
      break;
    }
    body.push(l);
  }
  return body.join("\n");
}

describe("P3 — CSRF : aucun handler GET ne mute l'état (sameSite lax)", () => {
  it("aucun corps de GET sous app/ ne contient de mutation Prisma inline", () => {
    // Allowlist : vide. Toute route ajoutée ici DOIT être justifiée (soit
    // authentifiée par bearer non-cookie, soit prouvée non CSRF) ET consignée
    // dans documentation/rapports/failles.md §5/P3.
    const ALLOWLIST = new Set<string>([]);

    const offenders: string[] = [];
    for (const rel of routeFilesWithGet()) {
      if (ALLOWLIST.has(rel)) continue;
      const source = readFileSync(resolve(REPO_ROOT, rel), "utf8");
      const getBody = extractGetBody(source);
      if (MUTATION_RE.test(getBody)) {
        const line = getBody
          .split("\n")
          .find((l) => MUTATION_RE.test(l))
          ?.trim();
        offenders.push(`${rel} → ${line}`);
      }
    }

    expect(
      offenders,
      `Mutation Prisma inline détectée dans un handler GET (vecteur CSRF via sameSite lax) :\n` +
        offenders.map((o) => `  - ${o}`).join("\n") +
        `\nSi la mutation est légitime, déplace-la vers une méthode non-GET (POST/PUT/DELETE), ` +
        `ou — si la route est authentifiée par bearer non-cookie — ajoute-la à l'allowlist ET à failles.md §5/P3.`,
    ).toEqual([]);
  });

  it("le test protège une surface réelle (des handlers GET existent)", () => {
    // Sanity : si le grep ne trouve plus aucun GET, c'est que le scan est cassé
    // (chemin/flag), pas que le repo n'a plus de routes de lecture.
    expect(routeFilesWithGet().length).toBeGreaterThan(10);
  });
});
