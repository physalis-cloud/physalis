// Helpers pour les rôles globaux (User.role). Distincts des rôles d'org
// (OrgRole) et de projet (ProjectRole).
//
//   ADMIN       — god-mode tenant (legacy testing)
//   MEMBER      — défaut, pas de pouvoir spécial
//   SUPERADMIN  — opérateur de la plateforme Physalis : /admin dashboard +
//                 hérite des pouvoirs ADMIN tenant pour pouvoir tester /
//                 dépanner.
//
// Convention : `isPlatformAdmin` couvre toutes les zones où un god-mode
// tenant est attendu (visibilite cross-org, lecture de tous les secrets…).
// `isSuperadmin` est strictement réservé aux gates `/admin`.

import type { Role, OrgRole } from "@prisma/client";

export function isPlatformAdmin(role: Role | string | null | undefined): boolean {
  return role === "ADMIN" || role === "SUPERADMIN";
}

/**
 * Vrai si le rôle d'org dispose des droits DEV. ADMIN_DEV hérite de TOUS les
 * droits DEV (EDITOR implicite sur les projets, accès vault DEV, vue projets,
 * tokens, etc.) — en plus du CRUD serveurs/secrets d'org géré ailleurs.
 * À utiliser partout où un droit DEV était gardé par `role === "DEV"`.
 */
export function hasDevPrivileges(role: OrgRole | null | undefined): boolean {
  return role === "DEV" || role === "ADMIN_DEV";
}

/** Rôles d'org disposant des droits DEV+ (accès implicite aux projets de l'org).
 *  Source UNIQUE pour les filtres Prisma `role: { in: [...] }` — évite de
 *  re-dériver la liste à la main et d'oublier `ADMIN_DEV` (motif de bug
 *  récurrent, cf. documentation/rapports/failles.md §4 : `hasDevPrivileges` inclut ADMIN_DEV). */
export const ORG_DEV_PLUS_ROLES: OrgRole[] = [
  "OWNER",
  "ADMIN",
  "ADMIN_DEV",
  "DEV",
];

export function isSuperadmin(role: Role | string | null | undefined): boolean {
  return role === "SUPERADMIN";
}

/** Forme minimale de session attendue par `isPlatformSuperadminSession`.
 *  Typage structurel volontaire : garde ce module pur (pas d'import NextAuth). */
type SuperadminSessionShape = {
  user?: {
    id?: string | null;
    role?: Role | string | null;
    tenantSlug?: string | null;
  } | null;
} | null;

/**
 * Gate UNIQUE de la zone `/admin` — opérateur de la plateforme Physalis.
 *
 * Les DEUX termes comptent :
 *   - `isSuperadmin(role)` — le rôle ;
 *   - `tenantSlug === null` — la session est celle du schéma `public`, PAS
 *     celle d'un tenant. Sans ce second terme, un utilisateur de tenant
 *     porteur de `role=SUPERADMIN` accéderait à `admin.clients` : fuite
 *     cross-tenant critique.
 *
 * Aujourd'hui l'enum `Role` des schémas tenant ne contient que ADMIN/MEMBER,
 * donc le premier terme suffirait — mais `scripts/clone-public-to-tenant.mjs`
 * exécute `ALTER TYPE "<schema>"."Role" ADD VALUE 'SUPERADMIN'` sur un schéma
 * tenant : la valeur PEUT exister côté tenant. La barrière ne doit pas tenir à
 * une invariante de données.
 *
 * Prédicat partagé plutôt que recopié : quatre copies de ce gate avaient
 * divergé, trois d'entre elles ayant perdu le test `tenantSlug`
 * (rapport-security.md F4.1). Le rendu de l'échec reste au choix de l'appelant
 * (`redirect` pour une page, `throw` pour une server action).
 */
export function isPlatformSuperadminSession(
  session: SuperadminSessionShape,
): boolean {
  return (
    !!session?.user?.id &&
    isSuperadmin(session.user.role) &&
    session.user.tenantSlug === null
  );
}
