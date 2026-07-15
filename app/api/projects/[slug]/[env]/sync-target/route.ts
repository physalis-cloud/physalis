// Cibles de synchronisation sortante d'un environnement (Vercel…).
//   GET  → liste les cibles de l'env (config + état, jamais le token).
//   POST → crée une cible (réservé OWNER projet — config sensible, cf. garde-fou #1).
//
// La connexion (token) est org-level (CiConnection provider de sync) ; ici on ne
// fait que la référencer + mapper env→projet distant + targets + tagFilter.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireEnvironment } from "@/lib/api";
import { normalizeTags, TAG_VALIDATION_ERROR } from "@/lib/tags";
import { isSyncProvider, providerTargets, providerSupportsTargets } from "@/lib/sync/types";
import { triggerSync } from "@/lib/sync/dispatch";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; env: string }> };

const EXT_ID_MAX = 200;

export async function GET(_req: Request, { params }: Params) {
  const { slug, env } = await params;
  const access = await requireEnvironment(slug, env, "EDITOR");
  if ("error" in access) return access.error;

  const targets = await prisma.environmentSyncTarget.findMany({
    where: { environmentId: access.environment.id },
    select: {
      id: true,
      ciConnectionId: true,
      externalProjectId: true,
      externalProjectName: true,
      targets: true,
      tagFilter: true,
      lastSyncAt: true,
      lastSyncStatus: true,
      lastSyncError: true,
      ciConnection: { select: { name: true, provider: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ targets });
}

export async function POST(req: Request, { params }: Params) {
  const { slug, env } = await params;
  // OWNER projet : décider où partent les secrets est une config sensible.
  const access = await requireEnvironment(slug, env, "OWNER");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as {
    ciConnectionId?: string;
    externalProjectId?: string;
    externalProjectName?: string | null;
    externalEnvironmentId?: string | null;
    externalServiceId?: string | null;
    targets?: string[];
    tagFilter?: string[];
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const ciConnectionId = String(body.ciConnectionId ?? "").trim();
  const externalProjectId = String(body.externalProjectId ?? "").trim();
  if (!ciConnectionId || !externalProjectId || externalProjectId.length > EXT_ID_MAX) {
    return NextResponse.json(
      { error: "ciConnectionId et externalProjectId requis" },
      { status: 400 },
    );
  }

  // La connexion doit appartenir à l'org du projet ET être un provider de sync.
  const conn = await prisma.ciConnection.findFirst({
    where: { id: ciConnectionId, organizationId: access.project.organizationId },
    select: { id: true, provider: true },
  });
  if (!conn || !isSyncProvider(conn.provider)) {
    return NextResponse.json(
      { error: "Connexion de sync invalide pour cette organisation" },
      { status: 400 },
    );
  }

  // Targets : requis + validés pour les providers qui en ont (Vercel) ; forcés à
  // [] pour ceux qui n'en ont pas (Render = un service, un seul jeu de vars).
  let targets: string[] = [];
  if (providerSupportsTargets(conn.provider)) {
    const allowed = providerTargets(conn.provider);
    const requested = Array.isArray(body.targets) ? body.targets : [];
    if (requested.length === 0 || !requested.every((t) => allowed.includes(t))) {
      return NextResponse.json(
        { error: `targets invalides (${allowed.join("|")})` },
        { status: 400 },
      );
    }
    targets = requested;
  }

  // Railway : adressage projet/environnement/service → env + service requis.
  let externalEnvironmentId: string | null = null;
  let externalServiceId: string | null = null;
  if (conn.provider === "railway") {
    externalEnvironmentId = String(body.externalEnvironmentId ?? "").trim() || null;
    externalServiceId = String(body.externalServiceId ?? "").trim() || null;
    if (!externalEnvironmentId || !externalServiceId) {
      return NextResponse.json(
        { error: "environnement et service Railway requis" },
        { status: 400 },
      );
    }
  }

  const tagFilter = normalizeTags(body.tagFilter);
  if (tagFilter === null) {
    return NextResponse.json({ error: TAG_VALIDATION_ERROR }, { status: 400 });
  }

  const name =
    typeof body.externalProjectName === "string" && body.externalProjectName.trim() !== ""
      ? body.externalProjectName.trim().slice(0, 200)
      : null;

  // Unicité (environmentId, ciConnectionId) : une cible par connexion par env.
  const dup = await prisma.environmentSyncTarget.findUnique({
    where: {
      environmentId_ciConnectionId: {
        environmentId: access.environment.id,
        ciConnectionId,
      },
    },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json(
      { error: "Une cible existe déjà pour cette connexion sur cet environnement." },
      { status: 409 },
    );
  }

  const created = await prisma.environmentSyncTarget.create({
    data: {
      environmentId: access.environment.id,
      ciConnectionId,
      externalProjectId,
      externalProjectName: name,
      externalEnvironmentId,
      externalServiceId,
      targets: [...new Set(targets)],
      tagFilter,
    },
    select: { id: true },
  });

  logAction({
    action: "SYNC_TARGET_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: access.environment.id,
    targetType: "EnvironmentSyncTarget",
    targetId: created.id,
    metadata: { provider: conn.provider, targets, tagFilterCount: tagFilter.length },
    req,
  });

  // Sync initiale (fire-and-forget) : pousse l'état courant vers la plateforme.
  void triggerSync(access.tenantSlug, access.environment.id, "target_created", {
    userId: access.user.id,
    email: access.user.email,
  });

  return NextResponse.json({ target: created }, { status: 201 });
}
