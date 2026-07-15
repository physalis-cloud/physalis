import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getCurrentOrgSlug,
  readJson,
  requireOrgMember,
  requireUser,
} from "@/lib/api";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// Résout le groupe + vérifie que l'org courante du user le possède (MEMBER+).
async function resolveGroup(id: string, userId: string) {
  const orgSlug = await getCurrentOrgSlug(userId);
  if (!orgSlug) return { error: NextResponse.json({ error: "No org" }, { status: 400 }) };
  const access = await requireOrgMember(orgSlug, "MEMBER");
  if ("error" in access) return { error: access.error };
  const group = await prisma.projectGroup.findFirst({
    where: { id, organizationId: access.organization.id },
    select: { id: true, name: true },
  });
  if (!group) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  return { group, organization: access.organization };
}

// PATCH /api/projects/groups/[id] — renomme. Body : { name }.
export async function PATCH(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;
  const { id } = await params;

  const body = (await readJson(req)) as { name?: string } | null;
  if (!body || typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  const name = body.name.trim().slice(0, 80);

  const res = await resolveGroup(id, user.id);
  if ("error" in res) return res.error;

  const group = await prisma.projectGroup.update({
    where: { id },
    data: { name },
    select: { id: true, name: true, position: true },
  });

  logAction({
    action: "PROJECT_GROUP_UPDATE",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: res.organization.id,
    targetType: "ProjectGroup",
    targetId: group.id,
    metadata: { name: group.name },
    req,
  });

  return NextResponse.json({ group });
}

// DELETE /api/projects/groups/[id] — supprime le groupe (projets détachés, SetNull).
export async function DELETE(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;
  const { id } = await params;

  const res = await resolveGroup(id, user.id);
  if ("error" in res) return res.error;

  await prisma.projectGroup.delete({ where: { id } });

  logAction({
    action: "PROJECT_GROUP_DELETE",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: res.organization.id,
    targetType: "ProjectGroup",
    targetId: id,
    metadata: { name: res.group.name },
    req,
  });

  return NextResponse.json({ ok: true });
}
