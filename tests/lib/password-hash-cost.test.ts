// Coût bcrypt des mots de passe de compte + calibrage du hash factice
// anti-timing (docs/rapport-security.md F3.1, docs/security.md §1).
//
// La mitigation anti-timing du login ne vaut QUE si le hash factice et les
// hashs réels ont le même facteur de coût. Ils avaient divergé (10 contre 12)
// sans que rien ne le signale : le mécanisme était en place, le calibrage
// absent, et `security.md` listait le contrôle comme corrigé.
//
// Ces tests vérifient l'invariant sur les DEUX plans : la valeur du coût
// embarquée dans le hash factice, et l'absence de facteur réécrit en dur sur
// un chemin d'écriture de mot de passe de compte — y compris dans l'overlay
// self-host, qui portait exactement la même divergence.

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import bcrypt from "bcryptjs";
import {
  DUMMY_PASSWORD_HASH,
  PASSWORD_BCRYPT_ROUNDS,
  hashPassword,
} from "@/lib/password-hash";

const REPO_ROOT = resolve(__dirname, "../..");

/** Facteur de coût encodé dans un hash bcrypt (`$2b$12$…` → 12). */
function costOf(hash: string): number {
  const m = /^\$2[aby]?\$(\d{2})\$/.exec(hash);
  if (!m) throw new Error(`hash bcrypt non reconnu : ${hash.slice(0, 10)}`);
  return Number(m[1]);
}

describe("coût bcrypt des mots de passe de compte", () => {
  it("le hash factice porte exactement le coût des hashs réels", () => {
    expect(costOf(DUMMY_PASSWORD_HASH)).toBe(PASSWORD_BCRYPT_ROUNDS);
  });

  it("hashPassword produit un hash au coût canonique", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(costOf(h)).toBe(PASSWORD_BCRYPT_ROUNDS);
    expect(await bcrypt.compare("correct horse battery staple", h)).toBe(true);
  });

  it("le coût reste dans une fourchette défendable", () => {
    // Trop bas = brute-force hors ligne bon marché ; trop haut = DoS par le
    // login lui-même (bcryptjs est du JS pur, ~300 ms au coût 12).
    expect(PASSWORD_BCRYPT_ROUNDS).toBeGreaterThanOrEqual(12);
    expect(PASSWORD_BCRYPT_ROUNDS).toBeLessThanOrEqual(14);
  });

  it("aucun facteur de coût réécrit en dur hors du module canonique", () => {
    let hits: string[] = [];
    try {
      hits = execSync(
        `grep -rEn "bcrypt\\.(hash|hashSync)\\([^,]+, *[0-9]+\\)" app lib scripts/public-overlay --include='*.ts' --include='*.tsx'`,
        { cwd: REPO_ROOT, encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean)
        // `lib/totp.ts` (codes de secours) et `app/api/share/route.ts` (mot de
        // passe d'un partage) hashent d'autres artefacts, jamais comparés au
        // hash factice du login : leur coût peut diverger sans créer d'oracle.
        .filter((l) => !l.startsWith("lib/totp.ts"))
        .filter((l) => !l.includes("api/share/route.ts"));
    } catch {
      hits = [];
    }
    expect(
      hits,
      "Un mot de passe de compte doit être hashé par `hashPassword()` " +
        "(lib/password-hash.ts). Un facteur écrit en dur peut diverger de " +
        "celui du hash factice anti-timing et rouvrir l'oracle d'énumération " +
        "des comptes (F3.1).",
    ).toEqual([]);
  });

  it("les deux lib/auth.ts importent le hash factice partagé", () => {
    for (const f of ["lib/auth.ts", "scripts/public-overlay/lib/auth.ts"]) {
      // Ce fichier tourne aussi DANS le build self-host, où l'overlay a déjà
      // été appliqué et où `scripts/public-overlay/` n'existe plus.
      if (!existsSync(resolve(REPO_ROOT, f))) continue;
      const src = execSync(`cat ${JSON.stringify(f)}`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(src, `${f} doit importer DUMMY_PASSWORD_HASH`).toContain(
        "DUMMY_PASSWORD_HASH",
      );
      expect(
        /hashSync\(/.test(src),
        `${f} ne doit pas recalculer un hash factice localement`,
      ).toBe(false);
    }
  });
});
