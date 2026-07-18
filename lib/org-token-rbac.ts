// lib/org-token-rbac.ts — règles RBAC fines pour la création / modification
// d'OrgToken (Phase 11f.3).
//
// Distingue 2 niveaux d'accès :
//   - OrgADMIN+    : peut tout (allProjects, expiration libre, scopes
//                    libres, voir/régénérer/révoquer tous les tokens)
//   - OrgDEV       : restrictions auto (cf. constants ci-dessous), voit
//                    et gère SEULEMENT ses propres tokens
//
// Les MEMBER ne peuvent rien (pas de visibilité sur l'onglet Tokens).

import type { OrgRole, OrgTokenScope } from "@prisma/client";
import { hasDevPrivileges } from "./roles";

/** Constraintes appliquées aux tokens créés par un OrgDEV. */
export const DEV_TOKEN_CONSTRAINTS = {
  /** Pas de wildcard "tous les projets". */
  allowAllProjects: false,
  /** Expiration obligatoire, en jours. */
  maxExpiresInDays: 90,
  expirationRequired: true,
  /** Quota max de tokens actifs par DEV (vs MAX_ACTIVE_TOKENS=50 pour ADMIN). */
  maxActiveTokensPerUser: 10,
} as const;

export type OrgTokenAccessLevel = "admin" | "dev" | "denied";

/** Détermine le niveau d'accès aux fonctionnalités OrgToken pour un rôle. */
export function orgTokenAccessLevel(role: OrgRole): OrgTokenAccessLevel {
  if (role === "OWNER" || role === "ADMIN") return "admin";
  if (hasDevPrivileges(role)) return "dev";
  return "denied";
}

/** Erreur structurée pour signaler une violation de contrainte côté API. */
export type RbacError = { code: number; error: string };

/** Valide les paramètres de création d'un OrgToken pour un DEV.
 *  Renvoie null si OK, ou un objet d'erreur. */
export function validateDevTokenCreation(opts: {
  allProjects: boolean;
  allowedProjectIds: string[];
  expiresInDays: number | null | undefined;
  scopes: OrgTokenScope[];
  /** Liste des project IDs dont le DEV est ProjectMember. */
  devMemberProjectIds: string[];
}): RbacError | null {
  if (opts.allProjects) {
    return {
      code: 403,
      error:
        "Forbidden: DEV users cannot create tokens with 'all projects' scope. Select projects explicitly.",
    };
  }

  if (
    opts.expiresInDays === null ||
    opts.expiresInDays === undefined
  ) {
    return {
      code: 400,
      error: `DEV users must set an expiration (max ${DEV_TOKEN_CONSTRAINTS.maxExpiresInDays} days).`,
    };
  }

  // Défense en profondeur : `expiresInDays` arrive de `readJson` non typé.
  // Sans ce garde, une valeur non-numérique (`"abc"`, `true`) satisfaisait le
  // `> max` ci-dessous (`"abc" > 90` = false, comparaison NaN) → la contrainte
  // d'expiration était contournée, et la persistance (`typeof === "number"`)
  // laissait `expiresAt = null` → token DEV ÉTERNEL. Le prédicat ne doit pas
  // faire confiance au type de son entrée.
  if (typeof opts.expiresInDays !== "number" || !Number.isFinite(opts.expiresInDays)) {
    return {
      code: 400,
      error: `DEV users must set a valid numeric expiration (max ${DEV_TOKEN_CONSTRAINTS.maxExpiresInDays} days).`,
    };
  }

  if (opts.expiresInDays > DEV_TOKEN_CONSTRAINTS.maxExpiresInDays) {
    return {
      code: 400,
      error: `DEV users cannot set expiration beyond ${DEV_TOKEN_CONSTRAINTS.maxExpiresInDays} days.`,
    };
  }

  if (opts.allowedProjectIds.length === 0) {
    return {
      code: 400,
      error: "At least one allowedProjectId is required.",
    };
  }

  const memberSet = new Set(opts.devMemberProjectIds);
  for (const id of opts.allowedProjectIds) {
    if (!memberSet.has(id)) {
      return {
        code: 403,
        error:
          "Forbidden: DEV users can only allow projects they are a member of.",
      };
    }
  }

  return null;
}
