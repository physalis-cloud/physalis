// Jumeau self-host de app/api/deploy/mobile/report/route.ts — le CI rapporte
// l'issue de son téléversement (Phase 3, registre de livraisons).
//
// Mono-tenant : pas d'`admin.policies` à interroger, pas de gate de plan. La
// résolution passe par la table `Policy` locale (lib/mobile-policy overlay) et
// le registre s'écrit sur le client unique.
//
// ⚠️ Même frontière `kind` que partout : une policy serveur ne rapporte pas une
// livraison mobile, et réciproquement.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { extractBearer, verifyOidcToken } from "@/lib/oidc";
import { readJson } from "@/lib/api";
import { resolveMobilePolicy } from "@/lib/mobile-policy";
import { isValidReleaseStatus, isValidTrack, recordReport } from "@/lib/mobile-release";

export const runtime = "nodejs";

const RATE_LIMIT = { max: 60, windowMs: 60_000 };
const MAX_DETAIL = 500;

export async function POST(req: Request) {
  const limited = rateLimit(req, "deploy-mobile-report", RATE_LIMIT);
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
      metadata: { reason: verified.reason, surface: "report" },
      req,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { provider, repo, matchKey, branch, policyIssuer } = verified.claims;

  const body = (await readJson(req)) as {
    app?: string;
    buildNumber?: string | number;
    track?: string;
    status?: string;
    versionName?: string;
    detail?: string;
  } | null;

  const requestedApp = String(body?.app ?? "").trim();
  const buildNumber = String(body?.buildNumber ?? "").trim();
  const track = String(body?.track ?? "").trim();
  const status = String(body?.status ?? "").trim();

  if (!requestedApp || !buildNumber || !track || !status) {
    return NextResponse.json(
      { error: "app, buildNumber, track and status are required" },
      { status: 400 },
    );
  }
  if (!isValidTrack(track) || track === "pending") {
    return NextResponse.json({ error: "Invalid track" }, { status: 400 });
  }
  if (!isValidReleaseStatus(status) || status === "requested") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
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
        surface: "report",
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

  // ⚠️ `deployPaused` n'est volontairement PAS vérifié ici — même raison qu'en
  // SaaS : le coupe-circuit interdit de SERVIR du matériel, pas de dire ce
  // qu'un pipeline déjà parti est devenu. Refuser le rapport creuserait un trou
  // dans l'historique au moment où on gèle une app.

  const detail = (body?.detail ?? "").trim().slice(0, MAX_DETAIL) || null;
  const versionName = (body?.versionName ?? "").trim() || null;

  let outcome;
  try {
    outcome = await recordReport(prisma, {
      appId: app.id,
      buildNumber,
      track,
      status,
      versionName,
      statusDetail: detail,
      ci: { provider, repo, ref: branch },
    });
  } catch (err) {
    console.error("[mobile-report] écriture du registre échouée:", err);
    return NextResponse.json({ error: "Could not record release" }, { status: 500 });
  }

  logAction({
    action: "MOBILE_RELEASE_REPORTED",
    actor: { kind: "anonymous" },
    organizationId: project.organizationId,
    projectId: project.id,
    targetType: "MobileRelease",
    targetId: outcome.releaseId,
    metadata: {
      app: app.bundleId,
      platform: app.platform,
      track,
      status,
      buildNumber,
      correlated: outcome.correlated,
      repository: repo,
      branch,
    },
    req,
  });

  return NextResponse.json({
    releaseId: outcome.releaseId,
    correlated: outcome.correlated,
  });
}
