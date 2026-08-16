/**
 * Source unique des règles d'accès aux projets (§4 de documentation/rapports/failles.md).
 *
 * ── Pourquoi ce module ──
 * Les 6 règles d'accès existaient en prose, ré-implémentées à la main sous
 * TROIS formes incompatibles, sur ~20 sites : le rôle effectif sur UN projet
 * (« point »), la clause `WHERE` d'un listing, et le filtre en mémoire sur des
 * lignes déjà chargées. Les commentaires disaient « miroir STRICT » — un
 * commentaire n'est pas un mécanisme.
 *
 * Preuve que ça produisait déjà des bugs : `lib/vault-access.ts` filtre sur
 * `["DEV","ADMIN","OWNER"]` et teste `role === "DEV"` — **`ADMIN_DEV` manque
 * aux deux**. L'ajout de la valeur d'enum n'a pas cassé le build là où il aurait
 * dû. `ORG_ROLE_RANK` (`lib/api.ts`), lui, est un `Record<OrgRole, number>` : il
 * A cassé le build, et il est correct. **Ce contraste est la conception de ce
 * module** — d'où les `Record<OrgRole, …>` exhaustifs ci-dessous plutôt qu'une
 * cascade de `if`. Ajouter un rôle d'org DOIT casser la compilation ici.
 *
 * ── Les 6 règles (référence : `requireProjectMember`) ──
 *   1. Admin plateforme ou OrgADMIN/OWNER → OWNER ; `hidden` est IGNORÉ.
 *   2. Ligne ProjectMember `hidden: true` → aucun accès (403), SANS retomber
 *      sur le fallback DEV de la règle 4.
 *   3. Ligne `hidden: false` → le rôle explicite de la ligne.
 *   4. Pas de ligne + OrgDEV/ADMIN_DEV → EDITOR implicite.
 *   5. Pas de ligne + OrgMEMBER → aucun accès.
 *   6. Pas membre de l'org → aucun accès, PARCE QU'IL NE PEUT PAS SUBSISTER DE
 *      LIGNE. Ce n'est pas un test explicite mais un invariant maintenu par les
 *      deux seules voies d'écriture :
 *        • ajout/modification d'un ProjectMember → vérifie l'appartenance org
 *          et répond 404 sinon (`projects/[slug]/members/[userId]`) ;
 *        • retrait d'un membre d'org → purge ses ProjectMember dans la même
 *          transaction (`orgs/[slug]/members/[userId]`).
 *      Si une ligne existait malgré tout (manipulation directe en base, ou
 *      régression de la cascade), la branche `membership` ci-dessous lui
 *      accorderait son rôle. C'est pourquoi `tests/integ/access-revocation`
 *      garde la cascade : elle EST le mécanisme de la règle 6.
 *
 * ⚠️ `tests/lib/project-access.test.ts` asserte que les trois formes sont
 * D'ACCORD sur toute la matrice. C'est le vrai garde-fou : rien ne détectait
 * une divergence entre elles jusqu'ici.
 */

import type { Prisma, OrgRole, ProjectRole, Role } from "@prisma/client";
import { isPlatformAdmin, hasDevPrivileges } from "./roles";

/** Ligne `ProjectMember` de l'utilisateur sur le projet considéré. */
export type ProjectMembershipInput = {
  role: ProjectRole;
  hidden: boolean;
} | null;

/**
 * Rôles d'org qui IGNORENT `hidden` et donnent OWNER sur tout projet de l'org
 * (règle 1). Exhaustif par construction.
 */
const ORG_ROLE_IGNORES_HIDDEN: Record<OrgRole, boolean> = {
  OWNER: true,
  ADMIN: true,
  ADMIN_DEV: false,
  DEV: false,
  MEMBER: false,
};

/**
 * Ce qu'un rôle d'org confère EN L'ABSENCE de ligne ProjectMember
 * (règles 1, 4 et 5). Exhaustif par construction — c'est ce `Record` qui fait
 * tomber une omission comme celle d'`ADMIN_DEV`.
 */
const ORG_ROLE_IMPLICIT_GRANT: Record<OrgRole, ProjectRole | null> = {
  OWNER: "OWNER",
  ADMIN: "OWNER",
  ADMIN_DEV: "EDITOR",
  DEV: "EDITOR",
  MEMBER: null,
};

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

/**
 * Normalise le rôle d'org : une appartenance EXPLICITE prime sur le statut
 * d'admin plateforme. Un SUPERADMIN qui est aussi OrgMEMBER reste MEMBER —
 * c'est le comportement de `requireProjectMember`, à ne pas « simplifier ».
 */
export function resolveOrgRole(
  orgRole: OrgRole | null | undefined,
  platformRole?: Role | string | null,
): OrgRole | null {
  if (orgRole) return orgRole;
  return isPlatformAdmin(platformRole) ? "OWNER" : null;
}

/**
 * Forme POINT — rôle effectif sur UN projet, ou `null` si aucun accès.
 *
 * Pure, sans Prisma : testable exhaustivement sans base.
 */
export function effectiveProjectRole(input: {
  orgRole: OrgRole | null | undefined;
  membership: ProjectMembershipInput;
  platformRole?: Role | string | null;
}): ProjectRole | null {
  const orgRole = resolveOrgRole(input.orgRole, input.platformRole);

  // Règle 1 — `hidden` ignoré, la ligne éventuelle n'est même pas consultée.
  if (orgRole && ORG_ROLE_IGNORES_HIDDEN[orgRole]) {
    return ORG_ROLE_IMPLICIT_GRANT[orgRole];
  }

  // Règles 2 + 3 — la ligne fait foi, et une ligne masquée BLOQUE sans
  // retomber sur le fallback DEV (c'est là que se logeait la famille de bugs).
  if (input.membership) {
    return input.membership.hidden ? null : input.membership.role;
  }

  // Règles 4 + 5 + 6 — pas de ligne : seul le rôle d'org peut donner accès.
  return orgRole ? ORG_ROLE_IMPLICIT_GRANT[orgRole] : null;
}

/**
 * `true` si le rôle effectif atteint au moins `requiredRole`.
 *
 * Prédicat de type : après un `if (!hasProjectRole(role, …)) return 403`, le
 * compilateur sait que `role` n'est plus `null` — l'appelant n'a pas à
 * re-tester, donc pas d'occasion de re-dériver.
 */
export function hasProjectRole(
  effective: ProjectRole | null,
  requiredRole: ProjectRole,
): effective is ProjectRole {
  if (!effective) return false;
  return PROJECT_ROLE_RANK[effective] >= PROJECT_ROLE_RANK[requiredRole];
}

/**
 * Forme WHERE — clause Prisma « projets de `orgId` visibles par `userId` ».
 * Source unique pour TOUT listing de projets.
 *
 * `orgRole` doit être celui renvoyé par `requireOrgMember` /
 * `requireProjectMember` (donc déjà « OWNER » pour un admin plateforme), ou
 * être normalisé via `resolveOrgRole`.
 *
 * Ne dit RIEN du rôle effectif sur chaque projet : pour agir sur un projet
 * précis, passer par `effectiveProjectRole`.
 */
export function accessibleProjectsWhere(
  orgId: string,
  userId: string,
  orgRole: OrgRole | null,
): Prisma.ProjectWhereInput {
  return { organizationId: orgId, ...visibilityClause(userId, orgRole) };
}

/**
 * Même règle, scopée par SLUG d'org plutôt que par id — pour les pages qui
 * n'ont que le slug en main et re-dérivaient la clause à la main.
 */
export function accessibleProjectsWhereByOrgSlug(
  orgSlug: string,
  userId: string,
  orgRole: OrgRole | null,
): Prisma.ProjectWhereInput {
  return {
    organization: { slug: orgSlug },
    ...visibilityClause(userId, orgRole),
  };
}

/**
 * Le PRÉDICAT DE VISIBILITÉ seul, sans scope d'org — partie commune aux deux
 * helpers ci-dessus. Privé à dessein : exposer un fragment composable
 * inviterait à le recombiner de travers, ce qui est exactement le générateur
 * qu'on ferme ici.
 */
function visibilityClause(
  userId: string,
  orgRole: OrgRole | null,
): Prisma.ProjectWhereInput {
  // Règle 1 — OrgOWNER/ADMIN (et admin plateforme) : tout, `hidden` ignoré.
  if (orgRole && ORG_ROLE_IGNORES_HIDDEN[orgRole]) {
    return {};
  }
  // Règles 2 + 4 — DEV/ADMIN_DEV : EDITOR implicite partout, SAUF si une ligne
  // les masque explicitement.
  if (hasDevPrivileges(orgRole)) {
    return { members: { none: { userId, hidden: true } } };
  }
  // Règles 3 + 5 + 6 — MEMBER (ou non-membre) : uniquement les projets où il a
  // une ligne explicite non masquée.
  return { members: { some: { userId, hidden: false } } };
}

/**
 * Forme MÉMOIRE — filtre des lignes DÉJÀ chargées.
 *
 * À n'utiliser que quand les projets viennent d'une requête qu'on ne contrôle
 * pas (jointure large, agrégat). Quand c'est possible, préférer
 * `accessibleProjectsWhere` : filtrer en base plutôt que de charger puis jeter.
 */
export function filterAccessibleProjects<
  P extends { members?: Array<{ userId: string; hidden: boolean }> },
>(
  projects: P[],
  userId: string,
  orgRole: OrgRole | null,
  platformRole?: Role | string | null,
): P[] {
  const resolved = resolveOrgRole(orgRole, platformRole);
  return projects.filter((project) => {
    const row = project.members?.find((m) => m.userId === userId);
    return (
      effectiveProjectRole({
        orgRole: resolved,
        // Le rôle projet n'influe pas sur la VISIBILITÉ (seul `hidden` compte) :
        // on passe VIEWER, le plancher, pour ne pas exiger l'info à l'appelant.
        membership: row ? { role: "VIEWER", hidden: row.hidden } : null,
      }) !== null
    );
  });
}

/**
 * Ce qu'un gestionnaire DEMANDE pour un membre sur un projet. `"NONE"` = aucun
 * accès, y compris contre l'EDITOR implicite d'un DEV (règle 4) — c'est la
 * seule valeur qui n'est pas un `ProjectRole`.
 */
export type DesiredProjectAccess = ProjectRole | "NONE";

/** Valide une valeur venue du réseau. */
export function isDesiredProjectAccess(
  value: unknown,
): value is DesiredProjectAccess {
  return (
    value === "NONE" ||
    value === "VIEWER" ||
    value === "EDITOR" ||
    value === "OWNER"
  );
}

/**
 * Forme ÉCRITURE — la ligne `ProjectMember` à poser pour que l'accès effectif
 * du membre soit exactement `desired`. `null` = AUCUNE ligne ne doit exister
 * (l'implicite du rôle d'org fait déjà le travail, ou aucune ligne ne peut
 * donner ce résultat).
 *
 * C'est la réciproque d'`effectiveProjectRole`, et l'invariant qui les lie est
 * asserté dans `tests/lib/project-access.test.ts` sur toute la matrice :
 *
 *   effectiveProjectRole({orgRole, membership: desiredMembershipRow(orgRole, d)})
 *     === (d === "NONE" ? null : d)          // sauf OrgADMIN/OWNER, cf. ci-dessous
 *
 * Deux rôles d'org échappent à cet invariant, et c'est voulu :
 *   • OrgOWNER/ADMIN — OWNER implicite partout, `hidden` ignoré (règle 1) :
 *     aucune ligne ne change quoi que ce soit → toujours `null`. Les appelants
 *     REFUSENT ces cibles plutôt que d'écrire une ligne sans effet.
 *   • Pas membre de l'org (`null`) — règle 6 : il ne doit PAS subsister de
 *     ligne. Les appelants vérifient l'appartenance AVANT d'arriver ici.
 *
 * Le « ne rien écrire quand l'implicite suffit » n'est pas une micro-optim :
 * figer une ligne EDITOR explicite sur chaque projet d'un DEV la lui laisserait
 * après une rétrogradation en MEMBER, qui devrait au contraire tout lui retirer.
 */
export function desiredMembershipRow(
  orgRole: OrgRole | null,
  desired: DesiredProjectAccess,
): { role: ProjectRole; hidden: boolean } | null {
  if (!orgRole) return null;
  if (ORG_ROLE_IGNORES_HIDDEN[orgRole]) return null;

  const implicit = ORG_ROLE_IMPLICIT_GRANT[orgRole];

  if (desired === "NONE") {
    // Rien à bloquer si le rôle d'org ne donne déjà rien (MEMBER, règle 5) :
    // l'absence de ligne EST le refus. Une barrière n'est utile que contre un
    // accès implicite (DEV/ADMIN_DEV).
    if (implicit === null) return null;
    // `role` est inerte tant que `hidden` est vrai ; VIEWER = le plancher, pour
    // qu'un dé-masquage accidentel ne donne pas plus que le minimum.
    return { role: "VIEWER", hidden: true };
  }

  if (desired === implicit) return null;
  return { role: desired, hidden: false };
}
