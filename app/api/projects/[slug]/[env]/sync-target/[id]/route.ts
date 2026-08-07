// Modification / suppression d'une cible de sync (réservé OWNER projet).
//   PATCH  → met à jour targets / tagFilter / projet distant (re-sync ensuite).
//   DELETE → supprime la cible ; ?deleteRemote=1 nettoie aussi les vars distantes
//            gérées par Physalis (offboarding, garde-fou #7).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireEnvironment } from "@/lib/api";
import { normalizeTags, TAG_VALIDATION_ERROR } from "@/lib/tags";
import { providerTargets, providerSupportsTargets } from "@/lib/sync/types";
import { triggerSync, offboardSyncTarget } from "@/lib/sync/dispatch";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; env: string; id: string }> };

const EXT_ID_MAX = 200;

async function loadTarget(environmentId: string, id: string) {
  return prisma.environmentSyncTarget.findFirst({
    where: { id, environmentId },
    select: { id: true, ciConnection: { select: { provider: true } } },
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const { slug, env, id } = await params;
  const access = await requireEnvironment(slug, env, "OWNER", { feature: "outbound_sync" });
  if ("error" in access) return access.error;

  const existing = await loadTarget(access.environment.id, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req)) as {
    externalProjectId?: string;
    externalProjectName?: string | null;
    externalEnvironmentId?: string | null;
    externalServiceId?: string | null;
    targets?: string[];
    tagFilter?: string[];
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const data: {
    externalProjectId?: string;
    externalProjectName?: string | null;
    externalEnvironmentId?: string | null;
    externalServiceId?: string | null;
    targets?: string[];
    tagFilter?: string[];
  } = {};

  if (typeof body.externalProjectId === "string") {
    const v = body.externalProjectId.trim();
    if (!v || v.length > EXT_ID_MAX) {
      return NextResponse.json({ error: "externalProjectId invalide" }, { status: 400 });
    }
    data.externalProjectId = v;
  }
  if ("externalProjectName" in body) {
    const n = body.externalProjectName;
    data.externalProjectName =
      typeof n === "string" && n.trim() !== "" ? n.trim().slice(0, 200) : null;
  }
  if ("externalEnvironmentId" in body) {
    const v = body.externalEnvironmentId;
    data.externalEnvironmentId = typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  }
  if ("externalServiceId" in body) {
    const v = body.externalServiceId;
    data.externalServiceId = typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  }
  if ("targets" in body) {
    const provider = existing.ciConnection.provider;
    if (providerSupportsTargets(provider)) {
      const allowed = providerTargets(provider);
      const requested = Array.isArray(body.targets) ? body.targets : [];
      if (requested.length === 0 || !requested.every((t) => allowed.includes(t))) {
        return NextResponse.json(
          { error: `targets invalides (${allowed.join("|")})` },
          { status: 400 },
        );
      }
      data.targets = [...new Set(requested)];
    } else {
      data.targets = []; // provider sans targets (Render)
    }
  }
  if ("tagFilter" in body) {
    const tagFilter = normalizeTags(body.tagFilter);
    if (tagFilter === null) {
      return NextResponse.json({ error: TAG_VALIDATION_ERROR }, { status: 400 });
    }
    data.tagFilter = tagFilter;
  }

  if (Object.keys(data).length > 0) {
    await prisma.environmentSyncTarget.update({ where: { id }, data });
  }

  logAction({
    action: "SYNC_TARGET_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: access.environment.id,
    targetType: "EnvironmentSyncTarget",
    targetId: id,
    metadata: { changedFields: Object.keys(data) },
    req,
  });

  // Re-sync après reconfiguration (fire-and-forget).
  void triggerSync(access.tenantSlug, access.environment.id, "target_updated", {
    userId: access.user.id,
    email: access.user.email,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug, env, id } = await params;
  const access = await requireEnvironment(slug, env, "OWNER");
  if ("error" in access) return access.error;

  const existing = await loadTarget(access.environment.id, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const deleteRemote = new URL(req.url).searchParams.get("deleteRemote") === "1";
  let remotePurged: "ok" | "failed" | "skipped" = "skipped";
  if (deleteRemote && access.tenantSlug) {
    try {
      await offboardSyncTarget(access.tenantSlug, id);
      remotePurged = "ok";
    } catch {
      // On n'empêche pas la suppression locale si le nettoyage distant échoue ;
      // l'utilisateur est informé via remotePurged et peut nettoyer côté plateforme.
      remotePurged = "failed";
    }
  }

  await prisma.environmentSyncTarget.delete({ where: { id } });

  logAction({
    action: "SYNC_TARGET_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: access.environment.id,
    targetType: "EnvironmentSyncTarget",
    targetId: id,
    metadata: { provider: existing.ciConnection.provider, deleteRemote, remotePurged },
    req,
  });

  return NextResponse.json({ ok: true, remotePurged });
}
