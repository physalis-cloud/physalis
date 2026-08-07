// §4bis — « Fermer le générateur de révocation ».
//
// Le PREMIER générateur (autorisation projet re-dérivée à la main) est fermé par
// lib/project-access.ts + tests/lib/project-access.test.ts. Il en existe un SECOND,
// aussi productif : un GESTE DE RETRAIT (reset mdp, retrait d'org, masquage projet,
// pause rotation…) ne cascade pas sur TOUS les PORTEURS d'identité. Dix findings de
// l'audit (§2.7, §2.9, §2.14, §2.15, §2.18, §2.19, §2.20, §2.25c + corollaire
// SUPERADMIN) sont la même cause vue N fois.
//
// Ce fichier est le MÉCANISME qui ferme cette famille, sur le modèle exact de
// project-access.test.ts :
//
//   1. EXHAUSTIVITÉ COMPILE-TIME — `Record<BearerKind, Record<Gesture, Cell>>`.
//      Ajouter un porteur (nouveau `TokenKind`) ou un geste SANS remplir la
//      colonne/ligne casse `tsc`. Un trou ne peut pas rester invisible.
//
//   2. CELLULES DÉLIBÉRÉES — une cellule `survives` encode un ARBITRAGE (ex.
//      « lier un token machine à sessionsValidFrom casserait la CI », §3). Ces
//      décisions vivaient en prose dans un réfuté ; ici elles sont exécutables et
//      un futur lecteur ne peut pas se tromper de sens.
//
//   3. TROUS SUIVIS — une cellule `hole` DOIT porter une référence de finding.
//      C'est la liste de travail restante, rendue visible (pas un finding à
//      re-trouver).
//
//   4. VÉRIFICATION LIVE — une cellule `dies`/`survives` non triviale porte
//      `verifiedBy` : le test d'intégration qui la PROUVE contre la stack réelle.
//      Sans preuve live, la matrice deviendrait elle-même « un test qui certifie
//      l'inverse » (cf. les 7 tests qui figeaient une faille). La couverture
//      `verifiedBy` monte au fil des fermetures (2.18, 2.19, 2.20…).

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Les PORTEURS d'identité qui accordent un accès DURABLE. (SHARE / SECRET_REQUEST
// / INVITATION sont à usage unique ou éphémère → hors matrice de déprovisionnement.)
// Aligné sur TokenKind (prisma) + la session JWT (cookie, pas un TokenKind) et le
// token d'agent (sous-type backup de sv_). Ajouter un porteur ici OBLIGE à remplir
// ses 8 cellules.
type BearerKind =
  | "jwt_web" // Session NextAuth (cookie .physalis.cloud). sessionsValidFrom honoré.
  | "plugin_token" // sv_plugin_ — session extension. revoked+exp+sessionsValidFrom.
  | "machine_token" // sv_ — scopé (projet, env). revokedAt SEUL.
  | "user_token" // sv_user_ — PAT au nom du user. revoked+exp, PAS sessionsValidFrom.
  | "org_token" // sv_org_ — institutionnel, scopé org. Survit au départ du créateur.
  | "agent_token" // sv_backup_ — agent rotation/backup, scopé (projet, env).
  | "gateway_apikey"; // ph_live_sk_ — clé API Gateway (tiers externes).

// Les GESTES de retrait / changement d'état qui DEVRAIENT invalider (ou pas) un
// porteur. Ajouter un geste OBLIGE à remplir sa colonne pour les 7 porteurs.
type Gesture =
  | "password_reset" // reset mdp → User.sessionsValidFrom = now
  | "twofa_disable" // 2FA off → sessionsValidFrom = loginAt (coupe l'ANTÉRIEUR)
  | "org_member_removal" // retrait d'un OrgMember (cascade transaction)
  | "project_hidden" // ProjectMember.hidden = true (= retrait d'accès projet)
  | "role_downgrade" // rétrogradation de rôle (org ou projet)
  | "client_suspended" // Client.status → SUSPENDED / CANCELLED / PENDING_DELETION
  | "rotation_pause" // Project.rotationPaused = true (kill-switch rotation)
  | "explicit_revoke" // révocation explicite du porteur (DELETE dédié)
  | "web_logout"; // clic « Déconnexion » dans le dashboard (signOut NextAuth)

type Expectation =
  | "dies" // le geste invalide le porteur (ou l'accès qu'il porte)
  | "survives" // le porteur survit — ARBITRAGE DÉLIBÉRÉ (why obligatoire)
  | "na" // le geste ne s'applique pas à ce porteur
  | "hole"; // comportement non tranché / défaut ouvert (finding obligatoire)

type Cell = {
  expect: Expectation;
  /** Raison — obligatoire pour survives/hole/na non trivial. */
  why: string;
  /** Référence de finding — OBLIGATOIRE si expect === "hole". */
  finding?: string;
  /** Test d'intégration qui PROUVE la cellule live. */
  verifiedBy?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// LA MATRICE. Source unique de « quel geste tue quel porteur ». Exhaustive par
// construction (Record<BearerKind, Record<Gesture, …>>).
const MATRIX: Record<BearerKind, Record<Gesture, Cell>> = {
  jwt_web: {
    password_reset: {
      expect: "dies",
      why: "sessionsValidFrom = now ; requireUser + callback jwt rejettent (§2.9).",
      verifiedBy: "integ/session-invalidation",
    },
    twofa_disable: {
      expect: "dies",
      why: "sessionsValidFrom = loginAt : coupe les sessions ANTÉRIEURES (la courante survit, à dessein).",
    },
    org_member_removal: {
      expect: "dies",
      why: "l'accès à l'org est re-dérivé par requête (requireOrgMember → 404).",
      verifiedBy: "integ/access-revocation",
    },
    project_hidden: {
      expect: "dies",
      why: "requireProjectMember re-lit hidden par requête → 403 (règle 2).",
      verifiedBy: "integ/project-hidden-bypass",
    },
    role_downgrade: {
      expect: "dies",
      why: "le rôle effectif est re-dérivé par requête (aucune copie dans le JWT).",
    },
    client_suspended: {
      expect: "survives",
      why: "Client.status ne RÉVOQUE aucun porteur : le login est refusé sur CANCELLED (auth.ts) et les ÉCRITURES sont bloquées par quotas.ts, mais une session/token déjà émis reste valide en LECTURE. Durcir (couper les lectures d'un tenant CANCELLED) = §2.24-famille.",
    },
    rotation_pause: { expect: "na", why: "geste propre à l'agent de rotation." },
    explicit_revoke: {
      expect: "dies",
      why: "révocable via `sessionsValidFrom` (posé au reset mdp / 2FA off), désormais appliqué à TOUTES les sessions — Y COMPRIS le SUPERADMIN plateforme (tenantSlug=null), auparavant irrévocable car le check était enfermé dans `if(slug)` et le layout /admin bypasse requireUser (§2.9-corollaire). Note : pas de révocation d'UNE session isolée (JWT stateless — sessionsValidFrom coupe toutes les sessions du user), limitation produit assumée, pas un trou.",
      verifiedBy: "integ/superadmin-revocation",
    },
    web_logout: {
      expect: "dies",
      why: "le geste EST la destruction du cookie de session (signOut NextAuth) ; events.signOut trace le LOGOUT à l'audit.",
    },
  },

  plugin_token: {
    password_reset: {
      expect: "dies",
      why: "validatePluginToken applique sessionsValidFrom (createdAt < borne → null).",
    },
    twofa_disable: {
      expect: "dies",
      why: "même borne sessionsValidFrom.",
    },
    org_member_removal: {
      expect: "dies",
      why: "l'accès coffre est re-dérivé par /plugin/match (appartenance explicite).",
    },
    project_hidden: {
      expect: "dies",
      why: "/plugin/match exige une ligne ProjectMember explicite non masquée (RESTRICTION DÉLIBÉRÉE §4).",
    },
    role_downgrade: { expect: "dies", why: "re-dérivé par requête." },
    client_suspended: {
      expect: "survives",
      why: "Client.status ne révoque pas le porteur ; les écritures sont gatées par quotas.ts, la lecture non. Durcir = §2.24-famille.",
    },
    rotation_pause: { expect: "na", why: "sans objet." },
    explicit_revoke: {
      expect: "dies",
      why: "revokedAt rejette l'usage direct (validatePluginToken) ; la boucle de renouvellement est fermée (§2.18) : une session DÉRIVÉE d'un token (origin=plugin_token) ne peut plus re-frapper de token via /api/plugin/issue. Résidu assumé : une session déjà dérivée survit jusqu'à l'expiration de son JWT (≤8h), sans pouvoir se renouveler.",
      verifiedBy: "integ/plugin-token-renewal",
    },
    web_logout: {
      expect: "dies",
      why: "SYMÉTRIE DU HAND-OFF : charger le dashboard émet un PluginToken et le pousse dans l'extension sans que l'user l'ait demandé (sso-extension-handoff.tsx) ; la déconnexion doit donc propager dans l'autre sens. components/LogoutButton.tsx redemande à l'extension le token de CE navigateur via le pont postMessage (PHYSALIS_GET_SESSION) et le fait révoquer (POST /api/plugin/revoke) AVANT de laisser partir le signOut — la page se décharge à la soumission, il n'y aurait plus personne pour l'émettre après. PORTÉE VOLONTAIREMENT LIMITÉE au navigateur qui se déconnecte : le token présenté EST la désignation de ce navigateur, donc aucune colonne de liaison session web ↔ token n'est nécessaire, et une déconnexion depuis le téléphone ne tue pas l'extension du poste fixe. Les sessions plugin des AUTRES navigateurs survivent — révocables à la main depuis /account (§ « Sessions plugin »). Best-effort par construction : extension absente ou pont muet → la déconnexion web part quand même.",
    },
  },

  machine_token: {
    password_reset: {
      expect: "survives",
      why: "ARBITRAGE (§3) : un credential machine lié à sessionsValidFrom casserait la CI à chaque reset. Ne PAS lier.",
    },
    twofa_disable: {
      expect: "survives",
      why: "idem — credential non interactif.",
    },
    org_member_removal: {
      expect: "dies",
      why: "cascade transaction : machineToken.updateMany({revokedAt}) pour les tokens du partant dans les projets de l'org (§2.7).",
    },
    project_hidden: {
      expect: "dies",
      why: "le PATCH members révoque les MachineTokens créés par la cible sur ce projet (§2.15).",
      verifiedBy: "integ/machine-token-revoke-on-hide",
    },
    role_downgrade: {
      expect: "survives",
      why: "ARBITRAGE : EDITOR→VIEWER non exploitable (la lecture est de niveau VIEWER ; §2.15).",
    },
    client_suspended: {
      expect: "survives",
      why: "Client.status ne révoque pas le porteur ; les écritures sont gatées par quotas.ts, la lecture non. Durcir = §2.24-famille.",
    },
    rotation_pause: { expect: "na", why: "sans objet." },
    explicit_revoke: {
      expect: "dies",
      why: "DELETE /api/tokens/[id] pose revokedAt ; validateToken le teste.",
    },
    web_logout: {
      expect: "survives",
      why: "ARBITRAGE : credential non interactif — une déconnexion humaine ne doit pas casser la CI (même raison que password_reset).",
    },
  },

  user_token: {
    password_reset: {
      expect: "survives",
      why: "ARBITRAGE TRANCHÉ (§2.20a) : un UserToken est un PAT (sémantique GitHub/GitLab) — il SURVIT au reset. Brancher sessionsValidFrom casserait les intégrations N8n à chaque rotation. Le vrai fix du vecteur « session volée → token permanent » est la ré-auth à l'ÉMISSION (POST /api/user-tokens), pas la révocation par borne — décision cadrée, différée.",
      verifiedBy: "integ/user-token-survives-reset",
    },
    twofa_disable: {
      expect: "survives",
      why: "ARBITRAGE (§2.20a) : idem password_reset — PAT non lié au 2FA de l'user.",
      verifiedBy: "integ/user-token-survives-reset",
    },
    org_member_removal: {
      expect: "dies",
      why: "accès projet re-dérivé via ProjectMember (la cascade purge les lignes) ; le token global survit mais n'ouvre plus rien de l'org.",
    },
    project_hidden: {
      expect: "dies",
      why: "integrations/* exige une ligne explicite non masquée (RESTRICTION DÉLIBÉRÉE §4).",
    },
    role_downgrade: { expect: "dies", why: "re-dérivé par requête." },
    client_suspended: {
      expect: "survives",
      why: "Client.status ne révoque pas le porteur ; les écritures sont gatées par quotas.ts, la lecture non. Durcir = §2.24-famille.",
    },
    rotation_pause: { expect: "na", why: "sans objet." },
    explicit_revoke: {
      expect: "dies",
      why: "DELETE /api/user-tokens/[id] pose revokedAt.",
    },
    web_logout: {
      expect: "survives",
      why: "ARBITRAGE (§2.20a) : un PAT (sémantique GitHub) survit à la déconnexion comme au reset — sinon toute intégration N8n tomberait dès que son auteur ferme son onglet.",
    },
  },

  org_token: {
    password_reset: {
      expect: "survives",
      why: "ARBITRAGE : token institutionnel, non lié à la session d'un user.",
    },
    twofa_disable: { expect: "survives", why: "idem institutionnel." },
    org_member_removal: {
      expect: "dies",
      why: "§2.19 : un token de FORME DEV (allProjects=false + expiration) créé par le partant est révoqué dans la cascade ; les tokens de forme INSTITUTIONNELLE (allProjects OU sans expiration) SURVIVENT — différenciateur voulu. La forme distingue sans migration. ⚠️ Un token ADMIN scopé+expirant a la MÊME forme → aussi révoqué (over-révocation fail-safe assumée, jamais d'ouverture d'accès).",
      verifiedBy: "integ/org-token-offboard",
    },
    project_hidden: {
      expect: "dies",
      why: "§2.19 : masquer un membre d'un projet révoque ses OrgToken de forme DEV qui COUVRENT ce projet (allowedProjectIds has projectId) ; les institutionnels et les tokens scopés à d'AUTRES projets survivent.",
      verifiedBy: "integ/org-token-offboard",
    },
    role_downgrade: { expect: "survives", why: "institutionnel (idem)." },
    client_suspended: {
      expect: "survives",
      why: "Client.status ne révoque pas le porteur ; les écritures sont gatées par quotas.ts, la lecture non. Durcir = §2.24-famille.",
    },
    rotation_pause: { expect: "na", why: "sans objet." },
    explicit_revoke: {
      expect: "dies",
      why: "DELETE /api/orgs/[slug]/org-tokens/[id] pose revokedAt.",
    },
    web_logout: {
      expect: "survives",
      why: "institutionnel : non lié à la session d'un user (idem password_reset).",
    },
  },

  agent_token: {
    password_reset: { expect: "survives", why: "credential machine non interactif (idem MachineToken)." },
    twofa_disable: { expect: "survives", why: "credential machine non interactif — pas de session utilisateur." },
    org_member_removal: {
      expect: "survives",
      why: "ARBITRAGE (§5/P2, AUDITÉ) : le token agent vit sur ProjectBackupConfig (projectId @unique, AUCUN champ user — pas de createdById), généré par le SYSTÈME (ensureRotationAgentToken), pas par un user. Aucune liaison utilisateur → un retrait de membre ne l'affecte pas (vérifié : les routes offboard/hide n'y réfèrent pas). Auto-re-roll casserait l'agent backup/rotation (credential PARTAGÉ, propagé au redeploy). Résidu assumé : un ex-membre ayant capturé le token (via un .env de deploy) le garde jusqu'à re-roll MANUEL ; scopé (projet, env). Concern voisin §2.25c (backup-off ↛ re-roll) = geste distinct, hors colonnes.",
    },
    project_hidden: {
      expect: "survives",
      why: "ARBITRAGE (§5/P2) : idem — le token agent n'a aucune dimension utilisateur, masquer un membre ne le touche pas (par conception, credential d'infra projet).",
    },
    role_downgrade: { expect: "survives", why: "credential machine." },
    client_suspended: {
      expect: "survives",
      why: "Client.status ne révoque pas le porteur ; les écritures sont gatées par quotas.ts, la lecture non. Durcir = §2.24-famille.",
    },
    rotation_pause: {
      expect: "dies",
      why: "l'ÉCRITURE est coupée : /rotation/agent/report applique le portail (rotationPaused:false) depuis §2.14. Le token n'est pas révoqué mais devient inopérant en écriture. Re-roll du token à la pause = §2.25c, ouvert.",
      verifiedBy: "integ/rotation-agent-env-scope",
    },
    explicit_revoke: {
      expect: "dies",
      why: "révocation du token agent (rotate/regénération du ProjectBackupConfig).",
    },
    web_logout: {
      expect: "survives",
      why: "credential d'infra projet, aucune dimension utilisateur (pas de createdById) — rien à quoi rattacher une déconnexion.",
    },
  },

  gateway_apikey: {
    password_reset: { expect: "survives", why: "clé API tiers, non liée à un user Physalis." },
    twofa_disable: { expect: "survives", why: "clé API tiers, non liée au 2FA d'un user." },
    org_member_removal: {
      expect: "survives",
      why: "ARBITRAGE (§3, réfuté) : createdById est de la PROVENANCE, pas de la propriété — révoquer en masse couperait des intégrations de prod de tiers légitimes.",
    },
    project_hidden: { expect: "na", why: "une ApiKey n'est pas scopée projet." },
    role_downgrade: { expect: "survives", why: "non lié au rôle du créateur." },
    client_suspended: {
      expect: "survives",
      why: "verifyApiKey ne consulte pas Client.status — une clé d'un tenant suspendu vérifie toujours. Durcissement candidat = §2.24-famille.",
    },
    rotation_pause: { expect: "na", why: "sans objet." },
    explicit_revoke: {
      expect: "dies",
      why: "DELETE /api/gateway/keys/[id] pose revokedAt ; verifyApiKey le teste.",
    },
    web_logout: {
      expect: "survives",
      why: "clé API tiers, non liée à une session Physalis.",
    },
  },
};

const BEARERS = Object.keys(MATRIX) as BearerKind[];
const GESTURES: Gesture[] = [
  "password_reset",
  "twofa_disable",
  "org_member_removal",
  "project_hidden",
  "role_downgrade",
  "client_suspended",
  "rotation_pause",
  "explicit_revoke",
  "web_logout",
];

describe("Matrice de révocation (§4bis) — mécanisme", () => {
  it("est exhaustive : chaque porteur couvre chaque geste", () => {
    // Le Record typé garantit déjà l'exhaustivité à la COMPILATION (clé manquante
    // = erreur tsc). Ce test le double au runtime et sert de garde explicite.
    for (const b of BEARERS) {
      for (const g of GESTURES) {
        expect(MATRIX[b][g], `cellule manquante : ${b} × ${g}`).toBeDefined();
        expect(MATRIX[b][g].why.length, `${b} × ${g} sans raison`).toBeGreaterThan(0);
      }
    }
  });

  it("tout TROU porte une référence de finding (dette suivie, pas oubliée)", () => {
    const untrackedHoles: string[] = [];
    for (const b of BEARERS) {
      for (const g of GESTURES) {
        const c = MATRIX[b][g];
        if (c.expect === "hole" && !c.finding) untrackedHoles.push(`${b} × ${g}`);
      }
    }
    expect(
      untrackedHoles,
      "Trou sans finding : une cellule 'hole' est un défaut ouvert, elle DOIT " +
        "pointer le § qui le suit. Sinon c'est un trou invisible.",
    ).toEqual([]);
  });

  it("chaque référence verifiedBy pointe vers un fichier de test EXISTANT", () => {
    // Une cellule qui se dit « prouvée live » par un test qui n'existe plus (ou a
    // été renommé) est pire qu'une cellule non prouvée : elle affiche une garantie
    // fantôme. Ce check attrape la référence morte. Format : "integ/<nom>".
    const REPO_ROOT = resolve(__dirname, "../..");
    const dead: string[] = [];
    for (const b of BEARERS) {
      for (const g of GESTURES) {
        const ref = MATRIX[b][g].verifiedBy;
        if (!ref) continue;
        const rel = ref.replace(/^integ\//, "tests/integ/") + ".test.ts";
        if (!existsSync(resolve(REPO_ROOT, rel))) dead.push(`${b} × ${g} → ${ref}`);
      }
    }
    expect(
      dead,
      "Référence verifiedBy morte : le fichier de test n'existe pas. " +
        "Corriger le nom ou retirer la garantie fantôme.",
    ).toEqual([]);
  });

  it("aucune cellule 'survives' sans arbitrage explicite", () => {
    // Une cellule « survit » est une DÉCISION (ex. « casserait la CI »). Sans
    // raison, c'est indistinguable d'un oubli — exactement le piège à fermer.
    const silent: string[] = [];
    for (const b of BEARERS) {
      for (const g of GESTURES) {
        const c = MATRIX[b][g];
        if (c.expect === "survives" && c.why.trim().length < 15) {
          silent.push(`${b} × ${g}`);
        }
      }
    }
    expect(silent).toEqual([]);
  });

  // Inventaire chiffré, imprimé pour le suivi : combien de cellules restent des
  // trous, et lesquelles sont déjà prouvées live. Ne fait pas échouer — c'est le
  // tableau de bord de la fermeture (il DESCEND au fil des passes 2.18/2.19/2.20).
  it("tableau de bord : trous restants + cellules vérifiées live", () => {
    const cells = BEARERS.flatMap((b) => GESTURES.map((g) => MATRIX[b][g]));
    const holes = cells.filter((c) => c.expect === "hole").length;
    const verified = cells.filter((c) => c.verifiedBy).length;
    const actionable = cells.filter((c) => c.expect === "dies" || c.expect === "survives").length;
    console.log(
      `[revocation-matrix] ${cells.length} cellules · ${holes} trous suivis · ` +
        `${verified}/${actionable} cellules actionnables prouvées live`,
    );
    // Garde-fou : le nombre de trous ne doit pas MONTER. 7 → 6 (§2.18) → 5 (§2.19)
    // → 3 (§2.20a) → 1 (§5/P2) → 0 (§2.9-corollaire). Le SECOND GÉNÉRATEUR EST CLOS :
    // toute cellule est soit décidée (dies/survives/na), soit — plus aucune — un trou.
    expect(holes).toBe(0);
  });
});
