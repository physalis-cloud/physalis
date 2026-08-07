// PATCH/DELETE collection projet. Reserve aux ProjectOWNER (qui inclut
// OrgADMIN+ via implicite).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, slugify } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireProjectCollectionAccess } from "@/lib/vault-access";

const NAME_MAX = 80;

type Params = {
  params: Promise<{ projectSlug: string; slug: string }>;
};

export async function PATCH(req: Request, { params }: Params) {
  const { projectSlug, slug } = await params;
  const access = await requireProjectCollectionAccess(projectSlug, slug, "OWNER", { feature: "team_vault" });
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as { name?: string } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    return NextResponse.json(
      { error: `name required (1-${NAME_MAX} chars)` },
      { status: 400 },
    );
  }
  const newSlug = slugify(name);
  if (!newSlug) {
    return NextResponse.json(
      { error: "name produces an empty slug" },
      { status: 400 },
    );
  }

  if (newSlug !== access.access.collection.slug) {
    const conflict = await prisma.teamVaultCollection.findUnique({
      where: {
        projectId_slug: {
          projectId: access.access.collection.projectId!,
          slug: newSlug,
        },
      },
      select: { id: true },
    });
    if (conflict && conflict.id !== access.access.collection.id) {
      return NextResponse.json(
        { error: "A collection with this slug already exists" },
        { status: 409 },
      );
    }
  }

  const updated = await prisma.teamVaultCollection.update({
    where: { id: access.access.collection.id },
    data: { name, slug: newSlug },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ collection: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { projectSlug, slug } = await params;
  const access = await requireProjectCollectionAccess(projectSlug, slug, "OWNER");
  if ("error" in access) return access.error;

  await prisma.teamVaultCollection.delete({
    where: { id: access.access.collection.id },
  });

  logAction({
    action: "VAULT_COLLECTION_DELETE",
    actor: {
      kind: "user",
      userId: access.access.user.id,
      email: access.access.user.email,
    },
    organizationId: access.access.organizationId,
    projectId: access.access.projectId,
    targetType: "TeamVaultCollection",
    targetId: access.access.collection.id,
    metadata: {
      scope: "project",
      name: access.access.collection.name,
      slug: access.access.collection.slug,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}
