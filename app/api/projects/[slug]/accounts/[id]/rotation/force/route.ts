// Jumeau SELF-HOST — divergence unique : le portail de feature payante
// (`requireFeature("rotation")`, lib/feature-guard) est retiré. La rotation À LA
// DEMANDE est une feature PRODUIT en self-host, pas une option d'offre : il n'y a
// ni plan ni `admin.clients` pour porter le drapeau. Les gardes d'autorisation
// (requireProjectMember EDITOR) et le reste du handler sont identiques.
//
// La garde `if (!access.tenantSlug) → 400` de la version SaaS est retirée elle
// aussi : en mono-tenant le slug est TOUJOURS null, elle ferait échouer chaque
// « Forcer ». Les rotators ne font que le repasser à `withTenantSchema` (stub
// self-host qui l'ignore) et à l'audit → `?? ""` suffit.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rotateAppAccountWebhook } from "@/lib/rotators/app-account-webhook";
import { rotateAppAccountDatabaseDirect } from "@/lib/rotators/app-account-database";
import { RotationDisabledError } from "@/lib/rotation-gate";

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
      await rotateAppAccountDatabaseDirect(acc.id, access.tenantSlug ?? "");
    } catch (e) {
      if (e instanceof RotationDisabledError) {
        return NextResponse.json({ error: e.message }, { status: 403 });
      }
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
      await rotateAppAccountWebhook(acc.id, access.tenantSlug ?? "");
    } catch (e) {
      if (e instanceof RotationDisabledError) {
        return NextResponse.json({ error: e.message }, { status: 403 });
      }
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
