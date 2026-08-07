// PATCH/DELETE d'une collection org-scoped. Reserve aux OWNER de la collection.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, slugify } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireOrgCollectionAccess } from "@/lib/vault-access";

const NAME_MAX = 80;

type Params = { params: Promise<{ orgSlug: string; slug: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { orgSlug, slug } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "OWNER", { feature: "team_vault" });
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as { name?: string } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    return NextResponse.json(
      { error: `name required (1-${NAME_MAX} chars)` },
      { status: 400 },
    );
  }

  // Le slug est derive du nom et reste stable apres creation par defaut,
  // mais un rename peut le faire bouger si l'utilisateur change le nom de
  // facon significative. On le met a jour aussi (avec check de conflit).
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
        organizationId_slug: {
          organizationId: access.access.organizationId!,
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

  // Reuse l'action existante VAULT_COLLECTION_CREATE n'est pas correct pour
  // un update — on logge sous _CREATE pour la creation, _DELETE pour la
  // suppression, et un update n'a pas d'action dediee dans le scope V1.
  // Pour avoir une trace, on logge un audit "MEMBER_ROLE_CHANGE" — non, pas
  // approprie non plus. On peut utiliser un nouveau log VAULT_COLLECTION_CREATE
  // serait misleading. Optons pour pas d'audit specifique sur le rename V1
  // (le rename modifie juste un libelle, pas un acces). A reconsiderer si
  // besoin de tracage fin.

  return NextResponse.json({ collection: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { orgSlug, slug } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "OWNER");
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
    targetType: "TeamVaultCollection",
    targetId: access.access.collection.id,
    metadata: {
      scope: "org",
      name: access.access.collection.name,
      slug: access.access.collection.slug,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}
