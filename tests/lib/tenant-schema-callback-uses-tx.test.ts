// Test statique — garde-fou de la piste d'audit P6 (documentation/rapports/failles.md §5/P6, §38).
//
// `withTenantSchema(slug, fn)` = `getTenantPrisma(slug).$transaction(fn)` : il
// donne au callback un `tx` EXPLICITE lié à `client_<slug>` — mais il NE pose
// PAS l'AsyncLocalStorage. Donc si un callback ignore son `tx` et fait ses
// requêtes via le `prisma` AMBIANT (résolu par l'ALS/session), la requête vise
// le tenant du CONTEXTE, pas `slug`. Selon le contexte c'est soit un no-op qui
// throw (ALS absent), soit — pire — une lecture/écriture dans le MAUVAIS schéma
// (ALS = un autre tenant). C'est le motif P6 (matérialisé une fois à
// app/api/deploy/route.ts avant correctif).
//
// INVARIANT enforcé : tout callback passé à `withTenantSchema(...)` DOIT
// déclarer un paramètre (le `tx`). Un callback sans paramètre (`() =>` /
// `async () =>`) ne peut, par construction, utiliser que l'ambiant → interdit.
// Ce n'est pas une preuve complète (un callback peut recevoir `tx` et quand
// même appeler un helper à `prisma` ambiant), mais ça ferme la forme la plus
// courante et la plus trompeuse. La règle de fond (un helper à `prisma`
// ambiant ne se wrappe pas dans `withTenantSchema` mais se pose l'ALS via
// `runWithTenant`) reste une responsabilité de revue.
//
// Style aligné sur les autres tests statiques du repo (crypto-aad-invariant,
// csrf-get-no-mutation).

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

/**
 * Callbacks `withTenantSchema(<x>, <cb>)` où <cb> ne déclare AUCUN paramètre :
 *   withTenantSchema(slug, () => ...)
 *   withTenantSchema(slug, async () => ...)
 * (une regex volontairement large sur `()` sans identifiant entre parenthèses.)
 */
function paramlessCallbacks(): string[] {
  try {
    const out = execSync(
      `grep -rnE "withTenantSchema\\([^,]+,[[:space:]]*(async[[:space:]]+)?\\([[:space:]]*\\)[[:space:]]*=>" lib app --include=*.ts`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(REPO_ROOT + "/", "").replace(REPO_ROOT, ""));
  } catch {
    return [];
  }
}

describe("P6 — withTenantSchema : le callback doit utiliser son tx explicite", () => {
  it("aucun callback withTenantSchema sans paramètre tx (interdit l'ambiant)", () => {
    // Allowlist vide : un tel callback ne peut router que via l'ambiant → c'est
    // toujours soit un bug (mauvais schéma) soit un wrap trompeur inerte. Le
    // corriger = poser l'ALS avec `runWithTenant(slug, () => helper())`.
    const offenders = paramlessCallbacks();
    expect(
      offenders,
      `Callback withTenantSchema() sans paramètre tx (motif P6 — ne peut utiliser que le prisma ambiant) :\n` +
        offenders.map((o) => `  - ${o}`).join("\n") +
        `\nSi le callback délègue à un helper à prisma ambiant, pose l'ALS via ` +
        `runWithTenant(slug, () => helper()) au lieu de withTenantSchema.`,
    ).toEqual([]);
  });

  // ── Le cas que le test ci-dessus laisse ouvert, et qui est devenu le mode
  //    de régression principal depuis F5.1 ─────────────────────────────────
  //
  // Un callback peut recevoir son `tx` ET faire quand même une requête via le
  // `prisma` ambiant. C'est le pire des deux mondes : la requête sort de la
  // transaction (aucune atomicité — exactement le défaut F5.1 qu'on vient de
  // fermer sur 15 sites) ET elle route par l'ALS, donc potentiellement vers un
  // autre schéma. Le commentaire d'en-tête le déclarait « responsabilité de
  // revue » ; maintenant que 116 appels existent, la revue ne suffit plus.
  //
  // La mesure porte sur le TEXTE du callback (équilibrage de parenthèses depuis
  // `withTenantSchema(`), pas sur une regex de ligne : un appel réparti sur
  // vingt lignes est couvert.
  it("aucun callback withTenantSchema n'utilise le prisma ambiant", () => {
    const offenders: string[] = [];
    let inspected = 0;

    for (const file of filesUsingWithTenantSchema()) {
      const src = readFileSync(resolve(REPO_ROOT, file), "utf8");
      for (const m of src.matchAll(/withTenantSchema\(/g)) {
        let i = m.index! + m[0].length - 1;
        let depth = 0;
        while (i < src.length) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")" && --depth === 0) break;
          i++;
        }
        const body = src.slice(m.index! + m[0].length, i);
        inspected++;
        // `prisma.` non précédé d'un identifiant/point → exclut `adminPrisma.`,
        // `basePrisma.`, `tenantDb.prisma`, etc.
        for (const hit of body.matchAll(/(?<![\w.])prisma\s*\./g)) {
          const line =
            src.slice(0, m.index! + m[0].length + hit.index!).split("\n")
              .length;
          offenders.push(`${file}:${line}`);
        }
      }
    }

    // Contrôle positif : si le parcours n'inspecte rien, le test ne prouve
    // rien. Un compteur à zéro et « aucune infraction » se ressemblent trop.
    //
    // ⚠️ Seuil bas À DESSEIN : ce fichier est SYNCHRONISÉ vers le build public
    // et n'y est pas denylisté. Au 2026-08-09 le dépôt source compte 116 appels
    // et le build public 43 (les surfaces SaaS en sont retirées) — un seuil
    // calé sur la source aurait fait échouer la suite de tous les auto-hébergés
    // sans qu'aucune mesure côté source ne le montre.
    expect(inspected, "aucun appel inspecté — le tripwire est mort").toBeGreaterThan(20);
    expect(
      offenders,
      `Requête sur le prisma AMBIANT dans un callback withTenantSchema :\n` +
        offenders.map((o) => `  - ${o}`).join("\n") +
        `\nElle s'exécute HORS de la transaction (F5.1) et route par l'ALS, ` +
        `pas par le slug passé à withTenantSchema. Utiliser le \`tx\`.`,
    ).toEqual([]);
  });
});

/** Fichiers de `app/` et `lib/` contenant au moins un `withTenantSchema(`. */
function filesUsingWithTenantSchema(): string[] {
  try {
    return execSync(
      `grep -rl "withTenantSchema(" app lib --include='*.ts' --include='*.tsx'`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}
