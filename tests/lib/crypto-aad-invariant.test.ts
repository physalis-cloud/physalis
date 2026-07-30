// Test statique — garde-fou de la piste d'audit P4 (docs/failles.md §5/P4, §36).
//
// Contexte : `lib/crypto.ts` chiffre en AES-256-GCM SANS AAD sous une
// `ENCRYPTION_KEY` globale → un triplet {encryptedValue, iv, tag} déchiffre
// dans N'IMPORTE QUELLE ligne. L'audit a établi qu'aucun chemin applicatif ne
// transplante un triplet à travers une frontière d'accès : toute traversée
// re-chiffre (decrypt→encrypt), et les seules copies verbatim (versioning +
// rollback) restent intra-secret (destination scopée par le même
// secretId/orgSecretId). L'invariant n'est PAS enforçable par le type-système.
//
// Ce test est un TRIPWIRE : il casse si une régression rouvre la surface —
// soit le mover inter-frontière cesse de re-chiffrer, soit une NOUVELLE copie
// verbatim de triplet-de-version apparaît hors de l'allowlist auditée. Style
// aligné sur secrets-no-leak-static.test.ts : on privilégie les faux négatifs
// (pattern nouveau non capturé) aux faux positifs.

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

/** grep -rEn dans app/ + lib/, chemins relatifs au repo. */
function grepCode(pattern: string): string[] {
  try {
    const out = execSync(
      `grep -rEn ${JSON.stringify(pattern)} app/ lib/ --include='*.ts'`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(REPO_ROOT + "/", ""));
  } catch {
    return [];
  }
}

describe("P4 — invariant AAD (pas de transplant de triplet)", () => {
  it("l'invariant est documenté au cœur crypto (doc non supprimable en silence)", () => {
    const crypto = read("lib/crypto.ts");
    // Marqueurs ancrés : si quelqu'un retire le bloc d'invariant, ce test casse
    // et force à assumer explicitement la suppression.
    expect(crypto).toContain("PAS D'AAD");
    expect(crypto).toContain("decrypt→encrypt");
  });

  it("le seul mover inter-frontière (move perso→équipe) re-chiffre, jamais de transplant", () => {
    const moveRoute = read("app/api/vault/entries/[id]/move/route.ts");
    // Il DOIT re-chiffrer.
    expect(moveRoute).toMatch(/encrypt\(/);
    // Il ne DOIT PAS écrire le triplet source verbatim dans la ligne de
    // destination (TeamVaultEntry / AppAccount). Un transplant se signerait par
    // l'écriture directe des champs chiffrés de `source` dans le create.
    expect(moveRoute).not.toMatch(/encryptedPassword:\s*source\.encryptedPassword/);
    expect(moveRoute).not.toMatch(/passwordIv:\s*source\.passwordIv/);
    expect(moveRoute).not.toMatch(/encryptedTotpSecret:\s*source\.encryptedTotpSecret/);
    expect(moveRoute).not.toMatch(/encryptedData:\s*source\.encrypted/);
  });

  it("la copie verbatim d'un triplet de VERSION vers une ligne live reste bornée à l'allowlist rollback", () => {
    // `targetVersionRow` est le nom canonique de la row de version tirée par
    // (secretId|orgSecretId, version) dans les routes de rollback. Écrire son
    // triplet dans le Secret/OrgSecret live est la seule copie verbatim
    // inter-ligne légitime — et elle est intra-secret par scoping. Toute
    // apparition de cette signature HORS des 2 routes de rollback = régression.
    const ALLOWLIST = new Set([
      "app/api/projects/[slug]/[env]/secrets/[key]/versions/[version]/rollback/route.ts",
      "app/api/orgs/[slug]/secrets/[key]/versions/[version]/rollback/route.ts",
    ]);
    const hits = grepCode("targetVersionRow\\.(encryptedValue|iv|tag)");
    const files = new Set(hits.map((h) => h.split(":")[0]));
    for (const f of files) {
      expect(
        ALLOWLIST.has(f),
        `Copie verbatim d'un triplet de version détectée dans un fichier non audité: ${f}. ` +
          `Si c'est intentionnel et intra-secret, ajoute-le à l'allowlist ET à docs/failles.md §5/P4. ` +
          `Sinon, re-chiffre (decrypt→encrypt).`,
      ).toBe(true);
    }
    // Sanity : la signature auditée existe toujours (le test protège une
    // surface réelle, pas une chimère).
    expect(files.size).toBeGreaterThan(0);
  });
});
