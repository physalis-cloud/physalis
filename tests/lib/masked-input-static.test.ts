// Garde-fou statique : aucun `input[type=password]` dans les écrans qui
// manipulent des SECRETS GÉRÉS PAR L'APP.
//
// Pourquoi ce test existe : le gestionnaire de mots de passe du navigateur se
// déclenche sur la seule présence d'un `type="password"`. Dans ces écrans il
// pré-remplissait les champs avec les credentials Physalis de l'utilisateur et
// proposait « Enregistrer ce mot de passe ? » à chaque secret créé. Le
// masquage passe donc par `.input-masked` (cf. lib/masked-input.ts).
//
// C'est le genre de régression qu'on réintroduit sans y penser en copiant un
// champ existant : le symptôme ne se voit qu'au navigateur, jamais en test
// unitaire ni au typecheck.
//
// Le pendant est tout aussi important : les VRAIS identifiants Physalis
// (login, inscription, reset, ré-authentification) doivent GARDER
// `type="password"` — là on veut que le navigateur remplisse et propose
// d'enregistrer. Les deux sens sont vérifiés.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ce fichier coule tel quel dans le build self-host, qui n'embarque pas
 * toutes les surfaces SaaS (le SSO Enterprise, par exemple, y est
 * denylisté). Un fichier absent y est donc NORMAL et le test le saute.
 *
 * Dans la SOURCE en revanche, un fichier absent signifie que la liste
 * ci-dessous a pourri — renommage, déplacement — et que le garde-fou ne
 * garde plus rien. On échoue alors franchement plutôt que de passer au vert
 * en ne vérifiant rien.
 */
const IS_PUBLIC_BUILD = existsSync(join(process.cwd(), ".physalis-build"));

/** Écrans où un champ mot de passe natif est INTERDIT. */
const SECRET_MANAGER_FILES = [
  "app/[locale]/(dashboard)/vault/vault-panel.tsx",
  "app/[locale]/(dashboard)/team-vault-panel.tsx",
  "app/[locale]/(dashboard)/share-create-button.tsx",
  "app/[locale]/(dashboard)/account/sso-panel.tsx",
  "app/[locale]/(dashboard)/orgs/[slug]/ci-connections-panel.tsx",
  "app/[locale]/(dashboard)/projects/[slug]/access-panel.tsx",
  "app/[locale]/(dashboard)/projects/[slug]/secrets-panel.tsx",
  "components/ImmediateRotationSection.tsx",
];

/** Écrans d'authentification, où il est ATTENDU. */
const AUTH_FILES = [
  "app/[locale]/(auth)/login/login-form.tsx",
  "app/[locale]/(auth)/signup/signup-form.tsx",
  "app/[locale]/(auth)/register/register-form.tsx",
  "app/[locale]/(auth)/reset-password/[token]/reset-form.tsx",
  "app/[locale]/invite/[token]/register-form.tsx",
  "app/[locale]/(dashboard)/account-lock-screen.tsx",
  "app/[locale]/(dashboard)/purge-now-dialog.tsx",
];

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** Le fichier est-il à vérifier ici ? Absent + build public → on saute ;
 *  absent dans la source → la liste est périmée, on échoue. */
function present(rel: string): boolean {
  if (existsSync(join(process.cwd(), rel))) return true;
  if (IS_PUBLIC_BUILD) return false;
  throw new Error(
    `${rel} est introuvable : la liste de ce garde-fou est périmée, mettez-la à jour.`,
  );
}

/** Retire les commentaires de ligne et de bloc : ces fichiers PARLENT de
 *  `type="password"` dans leurs commentaires, ce n'est pas du markup. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Un `type` de champ valant "password", quelle qu'en soit la forme :
 *  `type="password"`, `type={cond ? "text" : "password"}`, etc. */
const PASSWORD_TYPE = /type=\{?[^}\n]*["']password["']/;

describe("champs masqués — pas de type=password hors authentification", () => {
  for (const file of SECRET_MANAGER_FILES) {
    it(`${file} ne contient aucun input[type=password]`, () => {
      if (!present(file)) return;
      const src = stripComments(read(file));
      const offending = src
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => PASSWORD_TYPE.test(line));
      expect(
        offending,
        `Utiliser maskedInputProps() de lib/masked-input.ts au lieu de type="password" :\n` +
          offending.map((o) => `  ligne ${o.n}: ${o.line.slice(0, 120)}`).join("\n"),
      ).toEqual([]);
    });
  }

  for (const file of AUTH_FILES) {
    it(`${file} garde bien un input[type=password]`, () => {
      if (!present(file)) return;
      // Anti sur-application : masquer le formulaire de login casserait le
      // remplissage et l'enregistrement légitimes du mot de passe Physalis.
      expect(PASSWORD_TYPE.test(stripComments(read(file)))).toBe(true);
    });
  }
});

describe("lib/masked-input", () => {
  it("n'expose jamais un type password", async () => {
    const { maskedInputProps } = await import("@/lib/masked-input");
    expect(maskedInputProps(false).type).toBe("text");
    expect(maskedInputProps(true).type).toBe("text");
  });

  it("masque tant que la valeur n'est pas révélée", async () => {
    const { maskedInputProps } = await import("@/lib/masked-input");
    expect(maskedInputProps(false).className).toContain("input-masked");
    expect(maskedInputProps(true).className).not.toContain("input-masked");
  });

  it("respecte les classes de base fournies", async () => {
    const { maskedInputProps } = await import("@/lib/masked-input");
    expect(maskedInputProps(false, "input")).toEqual({
      type: "text",
      className: "input input-masked",
    });
  });
});

describe("globals.css", () => {
  it("masque .input-masked, avec un repli pour les navigateurs sans support", () => {
    const css = read("app/globals.css");
    expect(css).toContain("-webkit-text-security: disc");
    // Sans le repli, un navigateur sans la propriété afficherait le secret
    // EN CLAIR — c'est le seul point où ce choix pourrait mal tourner.
    expect(css).toMatch(/@supports not \(-webkit-text-security: disc\)/);
    const fallback = css.slice(css.indexOf("@supports not (-webkit-text-security"));
    expect(fallback).toContain("color: transparent");
  });
});
