// /api/vault/org/[orgSlug]/collections — liste/creation des coffres d'equipe
// au niveau organisation. Cf. coffres.md §Coffres d'équipe.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, slugify } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireOrgScope } from "@/lib/vault-access";
import { hasDevPrivileges } from "@/lib/roles";

const NAME_MAX = 80;

type Params = { params: Promise<{ orgSlug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { orgSlug } = await params;
  const scope = await requireOrgScope(orgSlug, "MEMBER");
  if ("error" in scope) return scope.error;

  // Visibilite : ADMIN/OWNER et DEV voient toutes les collections de l'org
  // (DEV beneficie de l'EDITOR implicite sur toutes les collections org).
  // MEMBER ne voit que celles ou il est TeamVaultMember explicite.
  const orgRole = scope.orgRole;
  const isOrgAdmin = orgRole === "ADMIN" || orgRole === "OWNER";
  const canSeeAll = isOrgAdmin || hasDevPrivileges(orgRole);
  const collections = await prisma.teamVaultCollection.findMany({
    where: {
      organizationId: scope.organizationId,
      ...(canSeeAll
        ? {}
        : { members: { some: { userId: scope.user.id } } }),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { entries: true, members: true } },
      members: {
        where: { userId: scope.user.id },
        select: { role: true },
      },
    },
    orderBy: { name: "asc" },
  });

  // Role effectif vu par l'UI : ADMIN/OWNER orga → OWNER ; DEV orga →
  // max(EDITOR implicite, membership explicite) ; sinon membership ou
  // VIEWER par defaut.
  const VAULT_RANK = { VIEWER: 1, EDITOR: 2, OWNER: 3 } as const;
  function effectiveRole(memberRole: "OWNER" | "EDITOR" | "VIEWER" | undefined) {
    if (isOrgAdmin) return "OWNER" as const;
    if (hasDevPrivileges(orgRole)) {
      if (!memberRole) return "EDITOR" as const;
      return VAULT_RANK[memberRole] >= VAULT_RANK.EDITOR
        ? memberRole
        : ("EDITOR" as const);
    }
    return memberRole ?? ("VIEWER" as const);
  }

  return NextResponse.json({
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      entryCount: c._count.entries,
      memberCount: c._count.members,
      role: effectiveRole(c.members[0]?.role),
    })),
  });
}

export async function POST(req: Request, { params }: Params) {
  const { orgSlug } = await params;
  const scope = await requireOrgScope(orgSlug, "DEV", { feature: "team_vault" });
  if ("error" in scope) return scope.error;

  const body = (await readJson(req)) as { name?: string } | null;
  const name = String(body?.name ?? "").trim();
  if (!name || name.length > NAME_MAX) {
    return NextResponse.json(
      { error: `name required (1-${NAME_MAX} chars)` },
      { status: 400 },
    );
  }

  const slug = slugify(name);
  if (!slug) {
    return NextResponse.json(
      { error: "name produces an empty slug" },
      { status: 400 },
    );
  }

  const conflict = await prisma.teamVaultCollection.findUnique({
    where: {
      organizationId_slug: { organizationId: scope.organizationId, slug },
    },
    select: { id: true },
  });
  if (conflict) {
    return NextResponse.json(
      { error: "A collection with this slug already exists" },
      { status: 409 },
    );
  }

  // Pour un DEV createur, on ajoute un TeamVaultMember OWNER explicite :
  // sans ca il n'aurait que l'EDITOR implicite (cf. lib/vault-access.ts)
  // et ne pourrait ni renommer ni supprimer sa propre collection. Pour
  // ADMIN/OWNER orga, c'est inutile (OWNER deja implicite a tous niveaux).
  const isOrgAdmin = scope.orgRole === "ADMIN" || scope.orgRole === "OWNER";
  const created = await prisma.teamVaultCollection.create({
    data: {
      organizationId: scope.organizationId,
      name,
      slug,
      ...(isOrgAdmin
        ? {}
        : {
            members: {
              create: { userId: scope.user.id, role: "OWNER" },
            },
          }),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { members: true } },
    },
  });

  logAction({
    action: "VAULT_COLLECTION_CREATE",
    actor: { kind: "user", userId: scope.user.id, email: scope.user.email },
    organizationId: scope.organizationId,
    targetType: "TeamVaultCollection",
    targetId: created.id,
    metadata: { scope: "org", name, slug },
    req,
  });

  return NextResponse.json(
    {
      collection: {
        id: created.id,
        name: created.name,
        slug: created.slug,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        role: "OWNER",
        entryCount: 0,
        memberCount: created._count.members,
      },
    },
    { status: 201 },
  );
}
