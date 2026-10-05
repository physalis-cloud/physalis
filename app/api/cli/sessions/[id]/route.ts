// DELETE /api/cli/sessions/[id] — coupe une session CLI depuis /account (C-0050).
//
// Soft-delete (`revokedAt = now`) : la requête suivante de cette session
// répond 401. Un utilisateur ne coupe que SES sessions ; l'id d'un autre → 404.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;
  const { id } = await params;

  const existing = await prisma.cliSession.findFirst({
    where: { id, userId: user.id },
    select: { id: true, revokedAt: true, deviceName: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.revokedAt) {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await prisma.cliSession.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  const orgMember = await prisma.orgMember.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });

  logAction({
    action: "CLI_SESSION_REVOKED",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: orgMember?.organizationId ?? null,
    targetType: "CliSession",
    targetId: existing.id,
    metadata: { via: "account", deviceName: existing.deviceName },
    req,
  });

  return NextResponse.json({ ok: true });
}
