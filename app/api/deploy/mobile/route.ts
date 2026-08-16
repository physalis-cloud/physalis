// Jumeau self-host de app/api/deploy/mobile/route.ts — sert le bundle mobile.
//
// Mono-tenant : pas d'`admin.policies` à interroger, pas de gate de plan. La
// résolution passe par la table `Policy` locale (lib/mobile-policy overlay) et
// le bundle se construit sur le client unique.
//
// ⚠️ La frontière server/mobile est la MÊME : lib/mobile-policy filtre
// `kind: "mobile"`, la résolution serveur filtre `kind: "server"`. Une policy
// mobile ne peut pas ouvrir les secrets d'un environnement.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { extractBearer, verifyOidcToken } from "@/lib/oidc";
import { readJson } from "@/lib/api";
import { resolveMobilePolicy } from "@/lib/mobile-policy";
import { buildMobileBundle, consumeBuildNumber } from "@/lib/mobile-bundle";
import { openRelease } from "@/lib/mobile-release";

export const runtime = "nodejs";

const RATE_LIMIT = { max: 30, windowMs: 60_000 };

export async function POST(req: Request) {
  const limited = rateLimit(req, "deploy-mobile", RATE_LIMIT);
  if (limited) return limited;

  const token = extractBearer(req);
  const verified = await verifyOidcToken(token);
  if (!verified.ok) {
    if (
      verified.reason === "missing_token" ||
      verified.reason === "wrong_audience" ||
      verified.reason === "wrong_issuer" ||
      verified.reason === "untrusted_issuer"
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    logAction({
      action: "MOBILE_DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      metadata: { reason: verified.reason },
      req,
    });
    if (verified.reason === "expired") {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { provider, repo, matchKey, branch, policyIssuer } = verified.claims;

  const body = (await readJson(req)) as { app?: string } | null;
  const requestedApp = String(body?.app ?? "").trim();
  if (!requestedApp) {
    return NextResponse.json(
      { error: "app is required in body (bundleId or app id)" },
      { status: 400 },
    );
  }

  const match = await resolveMobilePolicy(
    { provider, repo, workflow: matchKey, branch, issuer: policyIssuer },
    requestedApp,
  );
  if (!match) {
    logAction({
      action: "MOBILE_DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      metadata: {
        reason: "policy_not_found",
        repository: repo,
        workflow: matchKey,
        branch,
        app: requestedApp,
      },
      req,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { project, app } = match;

  if (app.deployPaused) {
    logAction({
      action: "MOBILE_DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      organizationId: project.organizationId,
      projectId: project.id,
      targetType: "MobileApp",
      targetId: app.id,
      metadata: { reason: "deploy_paused", app: app.bundleId },
      req,
    });
    return NextResponse.json(
      { error: "Mobile deploys are paused for this application (resume them in Physalis)." },
      { status: 403 },
    );
  }

  const bundle = await buildMobileBundle(prisma, app);
  if (!bundle) {
    return NextResponse.json(
      { error: "No signing material imported for this application" },
      { status: 422 },
    );
  }

  const { buildNumber, versionName } = await consumeBuildNumber(prisma, app.id);

  // Registre (Phase 3), identique au SaaS : la ligne naît quand le bundle part,
  // pas au rapport du CI — c'est ce qui rend la corrélation matériel↔version
  // vraie. Best-effort, jamais bloquant.
  const releaseId = await openRelease(prisma, {
    appId: app.id,
    buildNumber,
    versionName,
    credentialsSha: Object.fromEntries(
      bundle.credentials.map((c) => [c.kind, c.sha256]),
    ),
    ci: { provider, repo, ref: branch },
  });

  logAction({
    action: "MOBILE_DEPLOY_AUTHORIZED",
    actor: { kind: "anonymous" },
    organizationId: project.organizationId,
    projectId: project.id,
    targetType: "MobileApp",
    targetId: app.id,
    metadata: {
      repository: repo,
      workflow: matchKey,
      branch,
      project: project.slug,
      app: app.bundleId,
      platform: app.platform,
      credentialKinds: bundle.credentials.map((c) => c.kind),
      credentialShas: bundle.credentials.map((c) => c.sha256),
      buildNumber,
      versionName,
      releaseId,
    },
    req,
  });

  return NextResponse.json({
    project: project.slug,
    versionName,
    buildNumber,
    releaseId,
    ...bundle,
  });
}
