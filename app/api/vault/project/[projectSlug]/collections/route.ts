// /api/vault/project/[projectSlug]/collections — coffres d'equipe au niveau
// projet. RBAC herite directement du projet (cf. lib/vault-access.ts).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, slugify } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireProjectScope } from "@/lib/vault-access";

const NAME_MAX = 80;

type Params = { params: Promise<{ projectSlug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { projectSlug } = await params;
  const scope = await requireProjectScope(projectSlug, "VIEWER");
  if ("error" in scope) return scope.error;

  // Tous les VIEWER+ projet voient toutes les collections du projet
  // (heritage RBAC, pas de filtrage par membership explicite).
  const collections = await prisma.teamVaultCollection.findMany({
    where: { projectId: scope.projectId },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { entries: true } },
    },
    orderBy: { name: "asc" },
  });

  // Mapping ProjectRole → VaultRole pour le badge UI.
  const PROJECT_TO_VAULT = { VIEWER: "VIEWER", EDITOR: "EDITOR", OWNER: "OWNER" } as const;
  const vaultRole = PROJECT_TO_VAULT[scope.role];

  return NextResponse.json({
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      entryCount: c._count.entries,
      role: vaultRole,
    })),
  });
}

export async function POST(req: Request, { params }: Params) {
  const { projectSlug } = await params;
  const scope = await requireProjectScope(projectSlug, "EDITOR", { feature: "team_vault" });
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
    where: { projectId_slug: { projectId: scope.projectId, slug } },
    select: { id: true },
  });
  if (conflict) {
    return NextResponse.json(
      { error: "A collection with this slug already exists" },
      { status: 409 },
    );
  }

  const created = await prisma.teamVaultCollection.create({
    data: { projectId: scope.projectId, name, slug },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  logAction({
    action: "VAULT_COLLECTION_CREATE",
    actor: { kind: "user", userId: scope.user.id, email: scope.user.email },
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    targetType: "TeamVaultCollection",
    targetId: created.id,
    metadata: { scope: "project", name, slug },
    req,
  });

  return NextResponse.json(
    { collection: { ...created, role: "OWNER", entryCount: 0 } },
    { status: 201 },
  );
}
