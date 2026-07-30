import { NextRequest, NextResponse } from "next/server";
import { validateToken } from "@/lib/auth-token";
import { logAction } from "@/lib/audit";
import { machineFetchRateLimited } from "@/lib/machine-rate-limit";
import { withTenantSchema } from "@/lib/tenant";

type Params = { params: Promise<{ slug: string; env: string }> };

/**
 * Machine-token endpoint: returns the docker-compose.yml content stored on the
 * environment as `text/plain`. Same auth model as `/api/secrets/[slug]/[env]` :
 * Bearer token scoped to (project, env).
 *
 * Le contenu peut référencer des images privées ou contenir des commentaires
 * sensibles — traiter comme un secret. JAMAIS exposé via session web : auth
 * Bearer uniquement, l'absence de header Authorization renvoie 401.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { slug, env } = await params;

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    logAction({
      action: "TOKEN_USE_FAILED",
      actor: { kind: "anonymous" },
      metadata: {
        reason: "missing_authorization_header",
        endpoint: "compose",
        slug,
        env,
      },
      req,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = authHeader.slice(7).trim();

  const machineToken = await validateToken(token);
  if (!machineToken) {
    logAction({
      action: "TOKEN_USE_FAILED",
      actor: { kind: "anonymous" },
      metadata: {
        reason: "invalid_or_revoked_token",
        endpoint: "compose",
        slug,
        env,
      },
      req,
    });
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  if (
    machineToken.project.slug !== slug ||
    machineToken.environment.name !== env
  ) {
    logAction({
      action: "TOKEN_USE_FAILED",
      actor: {
        kind: "token",
        tokenId: machineToken.id,
        tokenName: machineToken.name,
      },
      organizationId: machineToken.project.organizationId,
      projectId: machineToken.project.id,
      environmentId: machineToken.environmentId,
      metadata: {
        reason: "scope_mismatch",
        endpoint: "compose",
        requested: { slug, env },
        token_scope: {
          slug: machineToken.project.slug,
          env: machineToken.environment.name,
        },
      },
      req,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Plafond par token (120/min) — cf. lib/machine-rate-limit.ts.
  const limited = machineFetchRateLimited(req, {
    tokenId: machineToken.id,
    tokenName: machineToken.name,
    // Mono-tenant : toujours null côté jumeau, mais `machineFetchRateLimited`
    // (fichier synchronisé) type le champ `string`. Le jumeau lib/audit.ts
    // ignore la valeur — elle n'est là que pour la compilation.
    tenantSlug: machineToken.tenantSlug ?? "",
    organizationId: machineToken.project.organizationId,
    projectId: machineToken.project.id,
  });
  if (limited) return limited;

  const environment = await withTenantSchema(machineToken.tenantSlug, (tx) =>
    tx.environment.findUnique({
      where: { id: machineToken.environmentId },
      select: { dockerCompose: true },
    }),
  );

  if (!environment?.dockerCompose) {
    return NextResponse.json(
      { error: "No docker-compose configured for this environment" },
      { status: 404 },
    );
  }

  logAction({
    action: "COMPOSE_FETCHED",
    actor: {
      kind: "token",
      tokenId: machineToken.id,
      tokenName: machineToken.name,
    },
    organizationId: machineToken.project.organizationId,
    projectId: machineToken.project.id,
    environmentId: machineToken.environmentId,
    targetType: "Environment",
    targetId: machineToken.environmentId,
    metadata: { bytes: environment.dockerCompose.length },
    req,
  });

  return new NextResponse(environment.dockerCompose, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="docker-compose.yml"',
      "Cache-Control": "no-store",
    },
  });
}
