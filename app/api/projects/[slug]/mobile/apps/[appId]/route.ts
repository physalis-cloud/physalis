// Chantier "Déploiement mobile" — Phase 1 (socle credentials).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember, readJson } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";
import { BUNDLE_ID_RE } from "@/lib/mobile-credentials";

type Params = { params: Promise<{ slug: string; appId: string }> };

/**
 * Édition des infos d'une application. `platform` est volontairement
 * IMMUABLE : elle détermine les types de credential attendus, et la basculer
 * laisserait un keystore Android accroché à une app iOS. Recréer est plus
 * honnête — le `@@unique(projectId, platform, bundleId)` le dit déjà.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  const access = await requireProjectMember(slug, "EDITOR", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const app = await prisma.mobileApp.findFirst({
    where: { id: appId, projectId: access.project.id },
    select: { id: true, platform: true, bundleId: true, displayName: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req)) as
    | {
        displayName?: string;
        bundleId?: string;
        vendorTeamId?: string | null;
        group?: string | null;
        versionName?: string | null;
        buildNumber?: number;
        deployPaused?: boolean;
      }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const data: {
    displayName?: string;
    bundleId?: string;
    vendorTeamId?: string | null;
    group?: string | null;
    versionName?: string | null;
    buildNumber?: number;
    deployPaused?: boolean;
  } = {};
  const changed: string[] = [];

  if (typeof body.displayName === "string") {
    const name = body.displayName.trim();
    if (!name) {
      return NextResponse.json(
        { error: "displayName is required" },
        { status: 400 },
      );
    }
    if (name !== app.displayName) {
      data.displayName = name;
      changed.push("displayName");
    }
  }

  if (typeof body.bundleId === "string") {
    const bundleId = body.bundleId.trim();
    if (!BUNDLE_ID_RE.test(bundleId)) {
      return NextResponse.json(
        {
          error:
            "Invalid bundleId (expected reverse-DNS form, e.g. com.exemple.app)",
        },
        { status: 400 },
      );
    }
    if (bundleId !== app.bundleId) {
      // Le tuple unique inclut la plateforme : deux apps du même projet
      // peuvent porter le même bundleId sur Android et sur iOS.
      const clash = await prisma.mobileApp.findUnique({
        where: {
          projectId_platform_bundleId: {
            projectId: access.project.id,
            platform: app.platform,
            bundleId,
          },
        },
        select: { id: true },
      });
      if (clash) {
        return NextResponse.json(
          {
            error:
              "An app with this platform and bundleId already exists in this project",
          },
          { status: 409 },
        );
      }
      data.bundleId = bundleId;
      changed.push("bundleId");
    }
  }

  if ("vendorTeamId" in body) {
    data.vendorTeamId = body.vendorTeamId?.trim() || null;
    changed.push("vendorTeamId");
  }
  if ("group" in body) {
    data.group = body.group?.trim() || null;
    changed.push("group");
  }
  if ("versionName" in body) {
    data.versionName = body.versionName?.trim() || null;
    changed.push("versionName");
  }
  if (typeof body.deployPaused === "boolean") {
    data.deployPaused = body.deployPaused;
    changed.push("deployPaused");
  }
  if (typeof body.buildNumber === "number") {
    if (!Number.isInteger(body.buildNumber) || body.buildNumber < 0) {
      return NextResponse.json(
        { error: "buildNumber must be a non-negative integer" },
        { status: 400 },
      );
    }
    // Réglable à la main (correction / réalignement sur le store) — c'est le
    // « dernier numéro servi », le prochain déploiement rendra buildNumber + 1.
    data.buildNumber = body.buildNumber;
    changed.push("buildNumber");
  }

  if (changed.length === 0) return NextResponse.json({ ok: true });

  const updated = await prisma.mobileApp.update({
    where: { id: app.id },
    data,
    select: {
      id: true,
      platform: true,
      bundleId: true,
      displayName: true,
      vendorTeamId: true,
      group: true,
      versionName: true,
      buildNumber: true,
      deployPaused: true,
    },
  });

  logAction({
    action: "MOBILE_APP_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileApp",
    targetId: app.id,
    metadata: { changedFields: changed, bundleId: updated.bundleId },
    req,
  });

  return NextResponse.json({ app: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  const access = await requireProjectMember(slug, "EDITOR", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  // Scope explicite par projectId — appId seul suffirait à trouver la ligne
  // mais pas à prouver qu'elle appartient à CE projet (IDOR).
  const app = await prisma.mobileApp.findFirst({
    where: { id: appId, projectId: access.project.id },
    select: { id: true, platform: true, bundleId: true },
  });
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Cascade DB : supprime aussi MobileCredential + MobileCredentialVersion.
  await prisma.mobileApp.delete({ where: { id: app.id } });

  logAction({
    action: "MOBILE_APP_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileApp",
    targetId: app.id,
    metadata: { platform: app.platform, bundleId: app.bundleId },
    req,
  });

  return NextResponse.json({ ok: true });
}
