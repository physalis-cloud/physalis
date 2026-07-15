import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireOrgMember } from "@/lib/api";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug);
  if ("error" in access) return access.error;

  const organization = await prisma.organization.findUnique({
    where: { id: access.organization.id },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      _count: { select: { projects: true, members: true } },
    },
  });

  return NextResponse.json({ organization, role: access.role });
}

export async function PATCH(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug, "ADMIN");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as { name?: string } | null;
  const newName = body?.name?.trim();
  if (!newName) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (newName === access.organization.name) {
    return NextResponse.json({ ok: true, organization: access.organization });
  }

  const updated = await prisma.organization.update({
    where: { id: access.organization.id },
    data: { name: newName },
    select: { id: true, name: true, slug: true },
  });

  logAction({
    action: "ORG_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "Organization",
    targetId: access.organization.id,
    metadata: { fromName: access.organization.name, toName: newName },
    req,
  });

  return NextResponse.json({ ok: true, organization: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug, "OWNER");
  if ("error" in access) return access.error;

  // L'org principale (compte général) ne peut pas être supprimée seule : elle
  // est l'ancre du tenant. Sa suppression passe par la fermeture du compte
  // (cf. POST /api/account/delete) qui déprovisionne tout le schéma.
  const org = await prisma.organization.findUnique({
    where: { id: access.organization.id },
    select: { isPrimary: true },
  });
  if (org?.isPrimary) {
    return NextResponse.json(
      { error: "PRIMARY_ORG_UNDELETABLE" },
      { status: 409 },
    );
  }

  await prisma.organization.delete({ where: { id: access.organization.id } });

  logAction({
    action: "ORG_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    targetType: "Organization",
    targetId: access.organization.id,
    metadata: { name: access.organization.name, slug: access.organization.slug },
    req,
  });

  return NextResponse.json({ ok: true });
}
