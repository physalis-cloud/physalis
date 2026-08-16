// Chantier "Déploiement mobile" — Phase 1 (socle credentials).
// Cf. documentation/plans/deploiement-mobile.md §4.2.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember, readJson } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";
import { BUNDLE_ID_RE, isValidMobilePlatform } from "@/lib/mobile-credentials";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "VIEWER", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const apps = await prisma.mobileApp.findMany({
    where: { projectId: access.project.id },
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
      createdAt: true,
      updatedAt: true,
      _count: { select: { credentials: true } },
    },
    orderBy: [{ group: "asc" }, { platform: "asc" }, { displayName: "asc" }],
  });

  // Surveillance d'expiration (Phase 4, §5.4) : l'échéance la PLUS PROCHE par
  // application, pour la bannière du panneau. Une requête agrégée plutôt qu'un
  // aller-retour par app — l'écran en liste jusqu'à six (dev/staging/prod × 2
  // plateformes) et la bannière doit être là au premier rendu, pas après.
  const soonest = apps.length
    ? await prisma.mobileCredential.groupBy({
        by: ["appId"],
        where: {
          appId: { in: apps.map((a) => a.id) },
          expiresAt: { not: null },
        },
        _min: { expiresAt: true },
      })
    : [];
  const byApp = new Map(soonest.map((s) => [s.appId, s._min.expiresAt]));

  return NextResponse.json({
    apps: apps.map((a) => ({ ...a, expiresAt: byApp.get(a.id) ?? null })),
  });
}

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "EDITOR", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const body = (await readJson(req)) as
    | {
        platform?: string;
        bundleId?: string;
        displayName?: string;
        vendorTeamId?: string | null;
        group?: string | null;
        versionName?: string | null;
        buildNumber?: number;
      }
    | null;

  if (
    !body ||
    typeof body.platform !== "string" ||
    typeof body.bundleId !== "string" ||
    typeof body.displayName !== "string" ||
    !body.bundleId.trim() ||
    !body.displayName.trim()
  ) {
    return NextResponse.json(
      { error: "platform, bundleId and displayName are required" },
      { status: 400 },
    );
  }
  if (!isValidMobilePlatform(body.platform)) {
    return NextResponse.json(
      { error: 'platform must be "android" or "ios"' },
      { status: 400 },
    );
  }

  const bundleId = body.bundleId.trim();
  if (!BUNDLE_ID_RE.test(bundleId)) {
    return NextResponse.json(
      { error: "Invalid bundleId (expected reverse-DNS form, e.g. com.exemple.app)" },
      { status: 400 },
    );
  }

  const existing = await prisma.mobileApp.findUnique({
    where: {
      projectId_platform_bundleId: {
        projectId: access.project.id,
        platform: body.platform,
        bundleId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "An app with this platform and bundleId already exists in this project" },
      { status: 409 },
    );
  }

  // buildNumber : entier >= 0, à initialiser au dernier numéro déjà publié.
  const buildNumber =
    typeof body.buildNumber === "number" &&
    Number.isInteger(body.buildNumber) &&
    body.buildNumber >= 0
      ? body.buildNumber
      : 0;

  const app = await prisma.mobileApp.create({
    data: {
      projectId: access.project.id,
      platform: body.platform,
      bundleId,
      displayName: body.displayName.trim(),
      vendorTeamId: body.vendorTeamId?.trim() || null,
      group: body.group?.trim() || null,
      versionName: body.versionName?.trim() || null,
      buildNumber,
    },
    select: {
      id: true,
      platform: true,
      bundleId: true,
      displayName: true,
      vendorTeamId: true,
      group: true,
      versionName: true,
      buildNumber: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  logAction({
    action: "MOBILE_APP_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileApp",
    targetId: app.id,
    metadata: { platform: app.platform, bundleId: app.bundleId },
    req,
  });

  return NextResponse.json({ app }, { status: 201 });
}
