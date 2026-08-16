// Test statique — tout chemin d'acceptation d'invitation doit appliquer les
// accès projet pré-attribués (#2, `Invitation.projectAccess`).
//
// Contexte : un OWNER/ADMIN peut pré-cocher, à l'invitation, les projets
// auxquels le futur membre aura accès. La valeur est stockée en JSON sur
// `Invitation.projectAccess` et appliquée à l'acceptation par
// `applyInvitationProjectAccess` (lib/invitation-project-access.ts).
//
// Il existe TROIS chemins d'acceptation, écrits à des moments différents :
//   - `/api/invitations/[token]`               lien e-mail, compte existant
//   - `/api/invitations/[token]/register-and-accept`  lien e-mail, compte à créer
//   - `/api/me/invitations/[id]/accept`        acceptation in-app
//
// Le premier ne l'appliquait PAS (trouvé le 2026-08-09, en marge de F5.1). Le
// mode de défaillance est le pire possible : silencieux et invisible côté
// serveur — l'invité rejoint bien l'org, mais sans aucun accès projet, et
// aucune erreur n'est levée. Le test e2e `invitation-project-access-e2e`
// n'exerçait que `register-and-accept`, c'est-à-dire précisément l'un des deux
// chemins qui marchaient.
//
// INVARIANT enforcé : chacun des trois fichiers importe ET appelle
// `applyInvitationProjectAccess`. Vérifié aussi sur les JUMEAUX overlay
// (`scripts/public-overlay/`) quand ils existent — le trou était présent des
// deux côtés, et un jumeau qui diverge est le mode de régression documenté de
// ce dépôt.
//
// Ce n'est pas une preuve de correction (le test e2e s'en charge pour un
// chemin) : c'est une preuve de NON-OUBLI, la propriété qui a manqué ici.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");

/** Les trois chemins d'acceptation, chemins relatifs au dépôt. */
const ACCEPT_ROUTES = [
  "app/api/invitations/[token]/route.ts",
  "app/api/invitations/[token]/register-and-accept/route.ts",
  "app/api/me/invitations/[id]/accept/route.ts",
];

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

/** Le fichier importe le helper ET l'appelle (pas seulement un import mort). */
function appliesProjectAccess(src: string): boolean {
  return (
    /import\s*\{[^}]*applyInvitationProjectAccess[^}]*\}\s*from/.test(src) &&
    /applyInvitationProjectAccess\s*\(/.test(src)
  );
}

describe("#2 — accès projet pré-attribués : tous les chemins d'acceptation", () => {
  it("le jeu de chemins n'est pas devenu obsolète (fichiers présents)", () => {
    const missing = ACCEPT_ROUTES.filter(
      (r) => !existsSync(resolve(REPO_ROOT, r)),
    );
    expect(
      missing,
      "Route d'acceptation déplacée ou supprimée — mettre à jour ACCEPT_ROUTES, " +
        "sinon ce test se met à surveiller le vide.",
    ).toEqual([]);
  });

  it("chaque chemin d'acceptation applique projectAccess", () => {
    const offenders = ACCEPT_ROUTES.filter((r) => !appliesProjectAccess(read(r)));
    expect(
      offenders,
      "Chemin d'acceptation d'invitation qui n'applique PAS " +
        "`applyInvitationProjectAccess` :\n" +
        offenders.map((o) => `  - ${o}`).join("\n") +
        "\nL'invité rejoindra l'org SANS les accès projet cochés par " +
        "l'inviteur, en silence. Appeler le helper dans la transaction qui " +
        "crée l'OrgMember, et seulement à la 1re acceptation.",
    ).toEqual([]);
  });

  it("les jumeaux self-host qui existent l'appliquent aussi", () => {
    // Les jumeaux sont hand-maintained : un correctif SaaS ne s'y propage pas.
    // Le trou d'origine était présent dans les DEUX versions.
    const twins = ACCEPT_ROUTES.map((r) => `scripts/public-overlay/${r}`).filter(
      (r) => existsSync(resolve(REPO_ROOT, r)),
    );
    // Contrôle positif : si le dépôt n'a plus d'overlay (= on tourne DANS le
    // build public), il n'y a rien à vérifier et l'assertion suivante serait
    // vide de sens. On la saute explicitement plutôt que de la laisser passer.
    if (!existsSync(resolve(REPO_ROOT, "scripts/public-overlay"))) return;
    expect(twins.length, "aucun jumeau trouvé — le test surveille le vide").toBeGreaterThan(0);

    const offenders = twins.filter((r) => !appliesProjectAccess(read(r)));
    expect(
      offenders,
      "Jumeau overlay divergent — le self-host perdra les accès projet " +
        "pré-attribués :\n" + offenders.map((o) => `  - ${o}`).join("\n"),
    ).toEqual([]);
  });
});
