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
import type { VaultRole, ProjectRole, OrgRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { isPlatformAdmin, hasDevPrivileges } from "@/lib/roles";
import { effectiveProjectRole } from "@/lib/project-access";

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

  // Rôle d'org du user par org — alimente effectiveProjectRole (source unique §4).
  const orgRoleByOrg = new Map<string, OrgRole>(
    orgMemberships.map((m) => [m.organization.id, m.role]),
  );

  // 2. Projets hérités : ceux des orgs où le rôle d'org confère un accès
  // implicite (OrgADMIN/OWNER → OWNER, OrgDEV/ADMIN_DEV → EDITOR). Un OrgMEMBER
  // n'hérite rien → ses seuls projets viennent de lignes ProjectMember explicites.
  const inheritOrgIds = orgMemberships
    .filter(
      (m) => m.role === "OWNER" || m.role === "ADMIN" || hasDevPrivileges(m.role),
    )
    .map((m) => m.organization.id);
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
    role: ProjectRole;
  };

  // §4 — le rôle projet effectif vient de la SOURCE UNIQUE (`effectiveProjectRole`),
  // plus d'une re-dérivation à la main de « explicite vs implicite vs hidden ». On
  // rassemble les projets candidats (ligne explicite OU héritage d'une org DEV+),
  // puis effectiveProjectRole tranche pour chacun : règle 1 (OrgADMIN/OWNER →
  // OWNER, `hidden` ET la ligne ignorés), règles 2/3 (la ligne fait foi, masquée
  // = aucun accès sans repli DEV), règles 4/5 (héritage d'org, ou rien).
  type Candidate = {
    project: {
      id: string;
      slug: string;
      name: string;
      organizationId: string;
      organization: { slug: string; name: string };
    };
    membership: { role: ProjectRole; hidden: boolean } | null;
  };
  const candidates = new Map<string, Candidate>();
  for (const pm of projectMemberships) {
    candidates.set(pm.project.id, {
      project: pm.project,
      membership: { role: pm.role, hidden: pm.hidden },
    });
  }
  for (const p of inheritedProjects) {
    if (!candidates.has(p.id)) candidates.set(p.id, { project: p, membership: null });
  }

  const projectMap = new Map<string, ProjectInfo>();
  for (const c of candidates.values()) {
    const role = effectiveProjectRole({
      orgRole: orgRoleByOrg.get(c.project.organizationId) ?? null,
      membership: c.membership,
      platformRole: user.role,
    });
    if (!role) continue;
    projectMap.set(c.project.id, {
      id: c.project.id,
      slug: c.project.slug,
      name: c.project.name,
      organizationId: c.project.organizationId,
      orgSlug: c.project.organization.slug,
      role,
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
