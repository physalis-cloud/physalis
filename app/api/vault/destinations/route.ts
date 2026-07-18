// GET /api/vault/destinations
//
// Retourne l'arborescence des cibles vers lesquelles le user peut deplacer
// une entree de son coffre personnel : orgs et projets accessibles, avec
// les collections sur lesquelles il a au moins le role EDITOR.
//
// Utilise par le dialog "Deplacer vers..." du coffre personnel.
//
// Format :
//   {
//     orgs: [
//       { slug, name, collections: [{ slug, name, role }] }
//     ],
//     projects: [
//       { slug, name, orgSlug, collections: [{ slug, name, role }] }
//     ]
//   }
//
// Reglesd'inclusion :
//   - Orgs : user est OrgMember (n'importe quel role).
//   - Projets : user est ProjectMember direct OU OrgADMIN+ de l'org du
//     projet (OWNER implicite) OU OrgDEV de l'org (EDITOR implicite).
//     Un ProjectMember explicite ne se fait jamais ecraser par l'implicite
//     (cf. lib/vault-access.ts : meme regle partout).
//   - Collections : seules celles ou le user est >= EDITOR sont listees
//     (pre-requis pour ecrire). Liste vide si rien dispo a ce role.

import { NextResponse } from "next/server";
import type { VaultRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { isPlatformAdmin, hasDevPrivileges } from "@/lib/roles";

const VAULT_ROLE_RANK: Record<VaultRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

const PROJECT_TO_VAULT = {
  VIEWER: "VIEWER" as const,
  EDITOR: "EDITOR" as const,
  OWNER: "OWNER" as const,
};

export async function GET() {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;
  const isGlobalAdmin = isPlatformAdmin(user.role);

  // 1. Memberships du user.
  const [orgMemberships, projectMemberships, vaultMemberships] =
    await Promise.all([
      prisma.orgMember.findMany({
        where: { userId: user.id },
        select: {
          role: true,
          organization: { select: { id: true, slug: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.projectMember.findMany({
        where: { userId: user.id },
        select: {
          role: true,
          hidden: true,
          project: {
            select: {
              id: true,
              slug: true,
              name: true,
              organizationId: true,
              organization: { select: { slug: true, name: true } },
            },
          },
        },
      }),
      prisma.teamVaultMember.findMany({
        where: { userId: user.id },
        select: { role: true, collectionId: true },
      }),
    ]);

  const adminOrgIds = orgMemberships
    .filter((m) => m.role === "OWNER" || m.role === "ADMIN")
    .map((m) => m.organization.id);
  const devOrgIds = orgMemberships
    .filter((m) => hasDevPrivileges(m.role))
    .map((m) => m.organization.id);
  const adminOrgIdSet = new Set(adminOrgIds);

  // 2. Projets accessibles via OrgADMIN+ (OWNER implicite) OU OrgDEV
  // (EDITOR implicite), en plus des projets membres directs. Un
  // ProjectMember explicite gagne sur l'implicite (la verif !has(p.id)
  // ci-dessous preserve cet ordre).
  const inheritOrgIds = [...adminOrgIds, ...devOrgIds];
  const inheritedProjects = inheritOrgIds.length
    ? await prisma.project.findMany({
        where: { organizationId: { in: inheritOrgIds } },
        select: {
          id: true,
          slug: true,
          name: true,
          organizationId: true,
          organization: { select: { slug: true, name: true } },
        },
      })
    : [];

  type ProjectInfo = {
    id: string;
    slug: string;
    name: string;
    organizationId: string;
    orgSlug: string;
    role: "OWNER" | "EDITOR" | "VIEWER";
  };
  // `hidden: true` = projet masqué pour ce user → requireProjectMember répond
  // 403 (règle 2). Miroir de accessibleProjectsWhere : une ligne masquée ne
  // sème PAS de destination, ET le projet est exclu du chemin d'héritage DEV
  // ci-dessous — sinon un DEV masqué le récupérerait en implicite (règles 2+4).
  // OrgADMIN/OWNER, eux, ignorent hidden (règle 1) via la branche admin.
  const hiddenProjectIds = new Set(
    projectMemberships.filter((pm) => pm.hidden).map((pm) => pm.project.id),
  );

  const projectMap = new Map<string, ProjectInfo>();
  for (const pm of projectMemberships) {
    if (pm.hidden) continue;
    projectMap.set(pm.project.id, {
      id: pm.project.id,
      slug: pm.project.slug,
      name: pm.project.name,
      organizationId: pm.project.organizationId,
      orgSlug: pm.project.organization.slug,
      role: pm.role,
    });
  }
  for (const p of inheritedProjects) {
    if (projectMap.has(p.id)) continue;
    const isAdminOrg = adminOrgIdSet.has(p.organizationId);
    // Règle 2 : un projet masqué reste masqué pour l'héritage DEV. Les
    // OrgADMIN/OWNER (règle 1) l'ignorent → seul le cas non-admin est filtré.
    if (!isAdminOrg && hiddenProjectIds.has(p.id)) continue;
    projectMap.set(p.id, {
      id: p.id,
      slug: p.slug,
      name: p.name,
      organizationId: p.organizationId,
      orgSlug: p.organization.slug,
      // ADMIN/OWNER orga → OWNER implicite ; DEV orga → EDITOR implicite.
      role: isAdminOrg ? "OWNER" : "EDITOR",
    });
  }

  // 3. Toutes les collections potentiellement reachables : org du user OU
  // projet du user. Le filtrage par role EDITOR+ est fait apres resolution.
  const orgIds = orgMemberships.map((m) => m.organization.id);
  const projectIds = Array.from(projectMap.keys());

  const collections =
    orgIds.length === 0 && projectIds.length === 0 && !isGlobalAdmin
      ? []
      : await prisma.teamVaultCollection.findMany({
          where: isGlobalAdmin
            ? {}
            : {
                OR: [
                  ...(orgIds.length
                    ? [{ organizationId: { in: orgIds } } as const]
                    : []),
                  ...(projectIds.length
                    ? [{ projectId: { in: projectIds } } as const]
                    : []),
                ],
              },
          select: {
            id: true,
            slug: true,
            name: true,
            organizationId: true,
            projectId: true,
          },
          orderBy: { name: "asc" },
        });

  // 4. Resolve le VaultRole effectif pour chaque collection.
  const vaultRoleByCollection = new Map<string, VaultRole>(
    vaultMemberships.map((m) => [m.collectionId, m.role]),
  );
  const orgRoleByOrg = new Map<
    string,
    "OWNER" | "ADMIN" | "ADMIN_DEV" | "DEV" | "MEMBER"
  >(orgMemberships.map((m) => [m.organization.id, m.role]));

  function effectiveRole(c: {
    id: string;
    organizationId: string | null;
    projectId: string | null;
  }): VaultRole | null {
    if (isGlobalAdmin) return "OWNER";
    if (c.organizationId) {
      const orgRole = orgRoleByOrg.get(c.organizationId);
      if (orgRole === "OWNER" || orgRole === "ADMIN") return "OWNER";
      return vaultRoleByCollection.get(c.id) ?? null;
    }
    if (c.projectId) {
      const proj = projectMap.get(c.projectId);
      if (!proj) return null;
      return PROJECT_TO_VAULT[proj.role];
    }
    return null;
  }

  // 5. Indexer en filtrant EDITOR+.
  const orgCollections = new Map<
    string,
    Array<{ slug: string; name: string; role: VaultRole }>
  >();
  const projectCollections = new Map<
    string,
    Array<{ slug: string; name: string; role: VaultRole }>
  >();

  for (const c of collections) {
    const role = effectiveRole(c);
    if (!role || VAULT_ROLE_RANK[role] < VAULT_ROLE_RANK.EDITOR) continue;
    if (c.organizationId) {
      const arr = orgCollections.get(c.organizationId) ?? [];
      arr.push({ slug: c.slug, name: c.name, role });
      orgCollections.set(c.organizationId, arr);
    } else if (c.projectId) {
      const arr = projectCollections.get(c.projectId) ?? [];
      arr.push({ slug: c.slug, name: c.name, role });
      projectCollections.set(c.projectId, arr);
    }
  }

  const orgs = orgMemberships.map((m) => ({
    slug: m.organization.slug,
    name: m.organization.name,
    collections: orgCollections.get(m.organization.id) ?? [],
  }));

  const projects = Array.from(projectMap.values()).map((p) => ({
    slug: p.slug,
    name: p.name,
    orgSlug: p.orgSlug,
    collections: projectCollections.get(p.id) ?? [],
  }));

  return NextResponse.json({ orgs, projects });
}
