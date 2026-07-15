import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rotateAppAccountWebhook } from "@/lib/rotators/app-account-webhook";
import { rotateAppAccountDatabaseDirect } from "@/lib/rotators/app-account-database";

type Params = { params: Promise<{ slug: string; id: string }> };

// POST — force la rotation d'un compte maintenant (hors fenêtre cron).
//   DATABASE → Physalis se connecte à la DB du service lié (admin) et fait
//              l'ALTER ROLE tout de suite (synchrone) puis committe.
//   WEBHOOK DIRECT → Physalis exécute le hook tout de suite et committe.
//   WEBHOOK AGENT  → rend le compte dû ; l'agent le prend à son prochain poll.
export async function POST(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;
  if (!access.tenantSlug) {
    return NextResponse.json({ error: "Contexte tenant manquant" }, { status: 400 });
  }

  const acc = await prisma.appAccount.findFirst({
    where: { id, projectId: access.project.id },
    select: {
      id: true,
      rotationEnabled: true,
      rotationStrategy: true,
      // Le hook (execMode + URL) et la cible DB vivent sur le service backend lié.
      service: { select: { rotationExecMode: true, rotationWebhookUrl: true, dbType: true, dbHost: true } },
    },
  });
  if (!acc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!acc.rotationEnabled) {
    return NextResponse.json({ error: "Rotation non activée sur ce compte." }, { status: 400 });
  }

  // DATABASE : rôle Postgres d'une DB managée → ALTER via l'admin du service lié.
  if (acc.rotationStrategy === "DATABASE") {
    try {
      await rotateAppAccountDatabaseDirect(acc.id, access.tenantSlug);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Échec de la rotation : ${msg}` }, { status: 502 });
    }
    logAction({
      action: "ACCOUNT_UPDATE",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.project.organizationId,
      projectId: access.project.id,
      targetType: "AppAccount",
      targetId: acc.id,
      metadata: { changedFields: ["rotation"], forced: true, via: "database" },
      req,
    });
    return NextResponse.json({ ok: true, executed: "direct-db" });
  }

  if (acc.rotationStrategy !== "WEBHOOK") {
    return NextResponse.json({ error: "Rotation forçable seulement en stratégie Base de données ou Webhook." }, { status: 400 });
  }
  if (!acc.service?.rotationWebhookUrl) {
    return NextResponse.json({ error: "Lie le compte à un service backend ayant un hook configuré." }, { status: 400 });
  }

  if (acc.service.rotationExecMode === "DIRECT") {
    try {
      await rotateAppAccountWebhook(acc.id, access.tenantSlug);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Échec du hook : ${msg}` }, { status: 502 });
    }
    logAction({
      action: "ACCOUNT_UPDATE",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.project.organizationId,
      projectId: access.project.id,
      targetType: "AppAccount",
      targetId: acc.id,
      metadata: { changedFields: ["rotation"], forced: true, via: "webhook" },
      req,
    });
    return NextResponse.json({ ok: true, executed: "direct" });
  }

  // AGENT : rendre dû maintenant (l'agent le prendra à son prochain poll).
  await prisma.appAccount.update({
    where: { id: acc.id },
    data: { rotationNextAt: new Date(Date.now() - 1000) },
  });
  return NextResponse.json({ ok: true, executed: "agent-queued" });
}
