// POST /api/me/delete/cancel — annule sa propre demande de suppression.
//
// AUCUN contrôle, délibérément : ni phrase, ni ré-auth. L'action est
// entièrement bénigne (elle ne fait que RESTAURER l'état antérieur) et c'est la
// porte de sortie de quelqu'un qui a changé d'avis. Y mettre le moindre
// frottement pousserait vers la perte de données, jamais vers la sécurité.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;
  if (!tenantSlug) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true, deletionRequestedAt: true, purgeAt: true },
  });
  if (!me) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (me.deletionRequestedAt === null) {
    return NextResponse.json(
      { error: "Aucune suppression en cours" },
      { status: 409 },
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { deletionRequestedAt: null, purgeAt: null },
  });

  logAction({
    action: "USER_ACCOUNT_DELETE_CANCELLED",
    actor: { kind: "user", userId: user.id, email: me.email },
    metadata: { hadPurgeAt: me.purgeAt?.toISOString() ?? null },
    req,
    tenantSlug,
  });

  return NextResponse.json({ ok: true });
}
