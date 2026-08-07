// PATCH/DELETE d'un membre explicite d'une collection org.

import { NextResponse } from "next/server";
import type { VaultRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireOrgCollectionAccess } from "@/lib/vault-access";

type Params = {
  params: Promise<{ orgSlug: string; slug: string; userId: string }>;
};

const VALID_ROLES = new Set<VaultRole>(["OWNER", "EDITOR", "VIEWER"]);

export async function PATCH(req: Request, { params }: Params) {
  const { orgSlug, slug, userId } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "OWNER", { feature: "team_vault" });
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as { role?: string } | null;
  const role = String(body?.role ?? "") as VaultRole;
  if (!VALID_ROLES.has(role)) {
    return NextResponse.json(
      { error: "role must be OWNER, EDITOR or VIEWER" },
      { status: 400 },
    );
  }

  const member = await prisma.teamVaultMember.findUnique({
    where: {
      collectionId_userId: {
        collectionId: access.access.collection.id,
        userId,
      },
    },
    select: { id: true, role: true, user: { select: { email: true } } },
  });
  if (!member) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (member.role === role) {
    return NextResponse.json({ ok: true });
  }

  await prisma.teamVaultMember.update({
    where: { id: member.id },
    data: { role },
  });

  logAction({
    action: "VAULT_MEMBER_ROLE_CHANGE",
    actor: {
      kind: "user",
      userId: access.access.user.id,
      email: access.access.user.email,
    },
    organizationId: access.access.organizationId,
    targetType: "TeamVaultMember",
    targetId: member.id,
    metadata: {
      collectionId: access.access.collection.id,
      collectionName: access.access.collection.name,
      targetUserEmail: member.user.email,
      from: member.role,
      to: role,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: Params) {
  const { orgSlug, slug, userId } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "OWNER");
  if ("error" in access) return access.error;

  const member = await prisma.teamVaultMember.findUnique({
    where: {
      collectionId_userId: {
        collectionId: access.access.collection.id,
        userId,
      },
    },
    select: { id: true, role: true, user: { select: { email: true } } },
  });
  if (!member) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.teamVaultMember.delete({ where: { id: member.id } });

  logAction({
    action: "VAULT_MEMBER_REMOVE",
    actor: {
      kind: "user",
      userId: access.access.user.id,
      email: access.access.user.email,
    },
    organizationId: access.access.organizationId,
    targetType: "TeamVaultMember",
    targetId: member.id,
    metadata: {
      collectionId: access.access.collection.id,
      collectionName: access.access.collection.name,
      removedUserEmail: member.user.email,
      removedRole: member.role,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}
