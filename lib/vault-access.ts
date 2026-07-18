// RBAC resolver pour les TeamVaultCollection (cf. coffres.md §Règles d'accès).
//
// Une collection est scopée à UNE org OU UN projet (XOR strict, garanti par
// CHECK constraint Postgres). La logique d'accès diffère :
//
//   ┌─────────────┬──────────────────────────────────────────────────────────┐
//   │ Scope org   │ • OrgADMIN / OrgOWNER → OWNER implicite                  │
//   │             │ • global ADMIN → OWNER implicite                         │
//   │             │ • OrgDEV → EDITOR implicite (peut consulter/éditer       │
//   │             │   toutes les collections org ; OWNER seulement via       │
//   │             │   TeamVaultMember explicite, p.ex. comme créateur)       │
//   │             │ • TeamVaultMember explicite → role du member (max avec   │
//   │             │   l'implicite ci-dessus)                                 │
//   │             │ • Sinon → 404 (jamais 403, anti-leak)                    │
//   ├─────────────┼──────────────────────────────────────────────────────────┤
//   │ Scope projet│ • OrgADMIN / OrgOWNER de l'org du projet → OWNER         │
//   │             │ • global ADMIN → OWNER                                   │
//   │             │ • ProjectMember : VIEWER → VIEWER, EDITOR → EDITOR,      │
//   │             │   OWNER → OWNER (mapping 1:1)                            │
//   │             │ • OrgDEV sans ProjectMember → EDITOR implicite           │
//   │             │ • Sinon → 404                                            │
//   │             │ • TeamVaultMember sur ce type de collection : IGNORÉ     │
//   │             │   (validation app-level refuse leur création)            │
//   └─────────────┴──────────────────────────────────────────────────────────┘

import { NextResponse } from "next/server";
import type { ProjectRole, Role, VaultRole } from "@prisma/client";
import { prisma } from "./prisma";
import { requireUser, type AuthedUser } from "./api";
import { isPlatformAdmin } from "./roles";

const VAULT_ROLE_RANK: Record<VaultRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

const PROJECT_TO_VAULT: Record<ProjectRole, VaultRole> = {
  VIEWER: "VIEWER",
  EDITOR: "EDITOR",
  OWNER: "OWNER",
};

export type CollectionRow = {
  id: string;
  name: string;
  slug: string;
  organizationId: string | null;
  projectId: string | null;
};

export type CollectionAccess = {
  user: AuthedUser;
  collection: CollectionRow;
  role: VaultRole;
  /** Pour les audit logs : org du scope (ou de l'org parent si scope projet). */
  organizationId: string | null;
  /** Pour les audit logs : projet du scope si applicable, sinon null. */
  projectId: string | null;
};

export function hasVaultRole(actual: VaultRole, required: VaultRole): boolean {
  return VAULT_ROLE_RANK[actual] >= VAULT_ROLE_RANK[required];
}

/**
 * Calcule l'ensemble des `TeamVaultCollection.id` accessibles a un user
 * en lecture (VIEWER ou plus). Combine les voies d'acces :
 *   1. Global ADMIN → toutes les collections
 *   2. OrgADMIN/OWNER → toutes les collections org de cette org + toutes
 *      les collections projet des projets de cette org
 *   3. OrgDEV → toutes les collections org de cette org + toutes les
 *      collections projet des projets de cette org (heritage transitif,
 *      cf. requireProjectCollectionAccess : EDITOR implicite si pas de
 *      ProjectMember explicite)
 *   4. TeamVaultMember explicite (role quelconque) → la collection
 *   5. ProjectMember (role quelconque) → toutes les collections du projet
 *
 * Utilise par /api/plugin/match pour agreger les coffres d'equipe dans
 * le bundle de l'extension. Ce helper ne fait PAS de match URL — c'est
 * au caller de filtrer les entries selon le hostname.
 */
export async function getAccessibleCollectionIds(
  userId: string,
  userRole: Role,
): Promise<string[]> {
  if (isPlatformAdmin(userRole)) {
    const all = await prisma.teamVaultCollection.findMany({
      select: { id: true },
    });
    return all.map((c) => c.id);
  }

  // Toutes les requetes en parallele.
  const [direct, orgMemberships, projectMemberships] = await Promise.all([
    prisma.teamVaultMember.findMany({
      where: { userId },
      select: { collectionId: true },
    }),
    prisma.orgMember.findMany({
      where: { userId, role: { in: ["DEV", "ADMIN", "OWNER"] } },
      select: { organizationId: true, role: true },
    }),
    prisma.projectMember.findMany({
      // `hidden: true` = projet masqué → requireProjectMember répond 403
      // (règle 2). Cf. accessibleProjectsWhere dans lib/api.ts.
      where: { userId, hidden: false },
      select: { projectId: true },
    }),
  ]);

  // Tous les roles (DEV/ADMIN/OWNER) donnent acces aux collections org
  // de l'org. Pour les collections projet, l'heritage transitif depuis
  // l'org concerne aussi DEV (EDITOR implicite) ET ADMIN/OWNER (OWNER
  // implicite) — un user explicitement ProjectMember reste pris en
  // compte separement via la branche projectMemberIds.
  const orgScopeOrgIds = orgMemberships.map((o) => o.organizationId);
  const projectMemberIds = projectMemberships.map((p) => p.projectId);
  // Héritage transitif org → projet : `hidden` ne se comporte PAS pareil
  // selon le rôle (cf. accessibleProjectsWhere, lib/api.ts).
  //   - OrgADMIN/OWNER (règle 1) : voient tout, `hidden` est ignoré.
  //   - OrgDEV (règles 2+4) : EDITOR implicite partout SAUF si une ligne
  //     les masque explicitement — sinon un DEV récupérait par héritage
  //     le projet que la branche 3 vient justement de lui refuser.
  const adminOrgIds = orgMemberships
    .filter((o) => o.role === "ADMIN" || o.role === "OWNER")
    .map((o) => o.organizationId);
  const devOrgIds = orgMemberships
    .filter((o) => o.role === "DEV")
    .map((o) => o.organizationId);

  const collections = await prisma.teamVaultCollection.findMany({
    where: {
      OR: [
        // 1. Membership direct sur la collection (via TeamVaultMember)
        { id: { in: direct.map((d) => d.collectionId) } },
        // 2. Collections org dont l'user est OrgDEV/ADMIN/OWNER
        ...(orgScopeOrgIds.length > 0
          ? [{ organizationId: { in: orgScopeOrgIds } }]
          : []),
        // 3. Collections projet dont l'user est ProjectMember (any role)
        ...(projectMemberIds.length > 0
          ? [{ projectId: { in: projectMemberIds } }]
          : []),
        // 4a. Collections projet dont le projet appartient a une org ou
        //     l'user est OrgADMIN/OWNER (heritage transitif). Regle 1 :
        //     `hidden` est ignore pour eux. Un ProjectMember=VIEWER
        //     explicite obtient quand meme VIEWER via la branche 3 (qui
        //     shadow l'EDITOR implicite, mais ici on s'en moque : on ne
        //     calcule que la VISIBILITE, pas le role effectif).
        ...(adminOrgIds.length > 0
          ? [
              {
                projectId: { not: null },
                project: { organizationId: { in: adminOrgIds } },
              } as const,
            ]
          : []),
        // 4b. Idem pour OrgDEV, MAIS un projet explicitement masque pour
        //     lui est exclu (regles 2+4) — sans ce `none`, le DEV
        //     recuperait par heritage le projet que la branche 3 filtre.
        ...(devOrgIds.length > 0
          ? [
              {
                projectId: { not: null },
                project: {
                  organizationId: { in: devOrgIds },
                  members: { none: { userId, hidden: true } },
                },
              } as const,
            ]
          : []),
      ],
    },
    select: { id: true },
  });

  return collections.map((c) => c.id);
}

/**
 * Resout l'acces a une collection org-scoped. Retourne soit `{ access }`
 * soit `{ error: NextResponse }` avec le bon code HTTP.
 *
 * Le 404 est volontairement utilise pour les cas "pas de droits" pour ne
 * pas leak l'existence de la collection a un user non autorise.
 */
export async function requireOrgCollectionAccess(
  orgSlug: string,
  collectionSlug: string,
  requiredRole: VaultRole = "VIEWER",
): Promise<{ access: CollectionAccess } | { error: NextResponse }> {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes;
  const { user } = userRes;

  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: {
      id: true,
      members: {
        where: { userId: user.id },
        select: { role: true },
      },
    },
  });
  if (!org) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  const collection = await prisma.teamVaultCollection.findUnique({
    where: {
      organizationId_slug: { organizationId: org.id, slug: collectionSlug },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      organizationId: true,
      projectId: true,
      members: {
        where: { userId: user.id },
        select: { role: true },
      },
    },
  });
  if (!collection) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  // Calcul du role effectif : on combine un role implicite derive de
  // l'OrgRole (ADMIN/OWNER → OWNER, DEV → EDITOR) avec un eventuel
  // TeamVaultMember explicite. On prend le max des deux, ce qui permet
  // qu'un DEV creator devienne OWNER de sa propre collection via un
  // TeamVaultMember explicite ajoute a la creation.
  const orgRole = org.members[0]?.role;
  const implicit: VaultRole | null =
    isPlatformAdmin(user.role) || orgRole === "OWNER" || orgRole === "ADMIN"
      ? "OWNER"
      : orgRole === "DEV"
        ? "EDITOR"
        : null;
  const memberRole = collection.members[0]?.role ?? null;
  let effective: VaultRole | null = null;
  if (implicit && memberRole) {
    effective =
      VAULT_ROLE_RANK[implicit] >= VAULT_ROLE_RANK[memberRole]
        ? implicit
        : memberRole;
  } else {
    effective = implicit ?? memberRole;
  }

  if (!effective || !hasVaultRole(effective, requiredRole)) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return {
    access: {
      user,
      collection: {
        id: collection.id,
        name: collection.name,
        slug: collection.slug,
        organizationId: collection.organizationId,
        projectId: collection.projectId,
      },
      role: effective,
      organizationId: org.id,
      projectId: null,
    },
  };
}

/**
 * Resout l'acces a une collection project-scoped. RBAC herite directement
 * du projet : VIEWER projet → VIEWER collection, etc. Aucun role
 * TeamVaultMember n'est pris en compte ici (validation API refuse leur
 * creation sur ce type de collection).
 */
export async function requireProjectCollectionAccess(
  projectSlug: string,
  collectionSlug: string,
  requiredRole: VaultRole = "VIEWER",
): Promise<{ access: CollectionAccess } | { error: NextResponse }> {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes;
  const { user } = userRes;

  const project = await prisma.project.findUnique({
    where: { slug: projectSlug },
    select: {
      id: true,
      organizationId: true,
      members: {
        where: { userId: user.id },
        select: { role: true, hidden: true },
      },
      organization: {
        select: {
          members: {
            where: { userId: user.id },
            select: { role: true },
          },
        },
      },
    },
  });
  if (!project) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  const collection = await prisma.teamVaultCollection.findUnique({
    where: {
      projectId_slug: { projectId: project.id, slug: collectionSlug },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      organizationId: true,
      projectId: true,
    },
  });
  if (!collection) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  // Calcul du role projet effectif. Doit rester en sync avec :
  //   - requireProjectMember dans lib/api.ts
  //   - projects/[slug]/page.tsx (RBAC effectif affiche)
  //   - requireProjectScope plus bas dans ce fichier
  //
  // Mapping (miroir STRICT de requireProjectMember, hidden compris) :
  //   1. Global ADMIN / OrgADMIN / OrgOWNER → OWNER implicite (hidden ignore)
  //   2. ProjectMember.hidden=true → AUCUN acces (404) — barriere explicite qui
  //      prime meme sur l'EDITOR implicite du DEV (regle 3).
  //   3. ProjectMember explicite non masque → role du member (mapping 1:1 Vault)
  //   4. Pas de row + OrgDEV → EDITOR implicite (sauf restriction explicite)
  //   5. Sinon → null → 404
  const membership = project.members[0];
  const orgRole = project.organization.members[0]?.role;

  let effective: VaultRole | null = null;
  if (
    isPlatformAdmin(user.role) ||
    orgRole === "OWNER" ||
    orgRole === "ADMIN"
  ) {
    effective = "OWNER";
  } else if (membership) {
    // Regle 2 : une ligne masquee bloque, sans retomber sur le fallback DEV.
    if (membership.hidden) {
      return {
        error: NextResponse.json({ error: "Not found" }, { status: 404 }),
      };
    }
    effective = PROJECT_TO_VAULT[membership.role];
  } else if (orgRole === "DEV") {
    effective = "EDITOR";
  }

  if (!effective || !hasVaultRole(effective, requiredRole)) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return {
    access: {
      user,
      collection: {
        id: collection.id,
        name: collection.name,
        slug: collection.slug,
        organizationId: collection.organizationId,
        projectId: collection.projectId,
      },
      role: effective,
      organizationId: project.organizationId,
      projectId: project.id,
    },
  };
}

/**
 * Resout l'org parente par slug avec les memberships du user. Utilise pour
 * l'endpoint LIST des collections (POST création) ou la gestion des members.
 */
export async function requireOrgScope(
  orgSlug: string,
  requiredOrgRole: "MEMBER" | "DEV" | "ADMIN" | "OWNER" = "MEMBER",
): Promise<
  | {
      user: AuthedUser;
      organizationId: string;
      orgRole: "OWNER" | "ADMIN" | "ADMIN_DEV" | "DEV" | "MEMBER";
    }
  | { error: NextResponse }
> {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes;
  const { user } = userRes;

  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: {
      id: true,
      members: {
        where: { userId: user.id },
        select: { role: true },
      },
    },
  });
  if (!org) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  const ORG_RANK = { MEMBER: 1, DEV: 2, ADMIN_DEV: 3, ADMIN: 4, OWNER: 5 } as const;
  const orgRole: "OWNER" | "ADMIN" | "ADMIN_DEV" | "DEV" | "MEMBER" | null =
    org.members[0]?.role ?? (isPlatformAdmin(user.role) ? "OWNER" : null);
  if (!orgRole || ORG_RANK[orgRole] < ORG_RANK[requiredOrgRole]) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { user, organizationId: org.id, orgRole };
}

/**
 * Resout le projet parent par slug avec les memberships du user. Utilise
 * pour l'endpoint LIST des collections projet (POST creation).
 */
export async function requireProjectScope(
  projectSlug: string,
  requiredRole: ProjectRole = "VIEWER",
): Promise<
  | {
      user: AuthedUser;
      projectId: string;
      organizationId: string;
      role: ProjectRole;
    }
  | { error: NextResponse }
> {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes;
  const { user } = userRes;

  const project = await prisma.project.findUnique({
    where: { slug: projectSlug },
    select: {
      id: true,
      organizationId: true,
      members: {
        where: { userId: user.id },
        select: { role: true, hidden: true },
      },
      organization: {
        select: {
          members: {
            where: { userId: user.id },
            select: { role: true },
          },
        },
      },
    },
  });
  if (!project) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  const PROJECT_RANK = { VIEWER: 1, EDITOR: 2, OWNER: 3 } as const;
  const membership = project.members[0];
  const orgRole = project.organization.members[0]?.role;

  // Mapping aligne avec requireProjectMember (lib/api.ts) et page.tsx, hidden
  // compris : OrgADMIN/OWNER ignorent hidden (regle 1) ; une ligne masquee
  // bloque (regle 2) meme l'EDITOR implicite du DEV ; OrgDEV sans ligne obtient
  // EDITOR implicite (regle 4).
  let effective: ProjectRole | null = null;
  if (
    isPlatformAdmin(user.role) ||
    orgRole === "OWNER" ||
    orgRole === "ADMIN"
  ) {
    effective = "OWNER";
  } else if (membership) {
    if (membership.hidden) {
      return {
        error: NextResponse.json({ error: "Not found" }, { status: 404 }),
      };
    }
    effective = membership.role;
  } else if (orgRole === "DEV") {
    effective = "EDITOR";
  }

  if (!effective || PROJECT_RANK[effective] < PROJECT_RANK[requiredRole]) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return {
    user,
    projectId: project.id,
    organizationId: project.organizationId,
    role: effective,
  };
}
