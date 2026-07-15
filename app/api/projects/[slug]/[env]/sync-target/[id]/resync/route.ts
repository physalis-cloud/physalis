// Resync manuel d'une cible (bouton "Resync maintenant"). EDITOR+ suffit : on
// ne fait que re-pousser l'état courant déjà configuré pour cette cible.
// Note : triggerSync est env-scopé → re-pousse toutes les cibles de l'env (idempotent).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnvironment } from "@/lib/api";
import { triggerSync } from "@/lib/sync/dispatch";

type Params = { params: Promise<{ slug: string; env: string; id: string }> };

export async function POST(_req: Request, { params }: Params) {
  const { slug, env, id } = await params;
  const access = await requireEnvironment(slug, env, "EDITOR");
  if ("error" in access) return access.error;

  const target = await prisma.environmentSyncTarget.findFirst({
    where: { id, environmentId: access.environment.id },
    select: { id: true },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Synchrone ici (pas de void) : le bouton attend le résultat pour rafraîchir
  // le statut. triggerSync ne throw jamais et persiste lastSync* lui-même.
  await triggerSync(access.tenantSlug, access.environment.id, "manual_resync", {
    userId: access.user.id,
    email: access.user.email,
  });

  return NextResponse.json({ ok: true });
}
