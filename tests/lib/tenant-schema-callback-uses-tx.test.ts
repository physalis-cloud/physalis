// Test statique — garde-fou de la piste d'audit P6 (docs/failles.md §5/P6, §38).
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
});
