import { NextRequest, NextResponse } from "next/server";
// Phase 6 — validateToken résout le tenant via admin.token_index. On
// utilise withTenantSchema(slug, tx => ...) pour les queries downstream :
// si slug est non-null → SET search_path TO client_<slug>, sinon
// queries hit public (mode legacy fallback).
import { decrypt } from "@/lib/crypto";
import { validateToken } from "@/lib/auth-token";
import { logAction } from "@/lib/audit";
import { machineFetchRateLimited } from "@/lib/machine-rate-limit";
import { withTenantSchema } from "@/lib/tenant";

type Params = { params: Promise<{ slug: string; env: string }> };

// Machine-token endpoint: returns decrypted secrets for the requested env.
// Auth: Authorization: Bearer sv_<hex>
export async function GET(req: NextRequest, { params }: Params) {
  const { slug, env } = await params;

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    logAction({
      action: "TOKEN_USE_FAILED",
      actor: { kind: "anonymous" },
      metadata: { reason: "missing_authorization_header", slug, env },
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
      metadata: { reason: "invalid_or_revoked_token", slug, env },
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
      actor: { kind: "token", tokenId: machineToken.id, tokenName: machineToken.name },
      organizationId: machineToken.project.organizationId,
      projectId: machineToken.project.id,
      environmentId: machineToken.environmentId,
      metadata: {
        reason: "scope_mismatch",
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

  // Plafond par token (120/min) — bride un token compromis qui martèle + trace
  // le 429 dans l'audit. Cf. lib/machine-rate-limit.ts.
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

  const records = await withTenantSchema(machineToken.tenantSlug, (tx) =>
    tx.secret.findMany({
      where: { environmentId: machineToken.environmentId },
      select: { key: true, encryptedValue: true, iv: true, tag: true },
    }),
  );

  const secrets: Record<string, string> = {};
  for (const r of records) {
    secrets[r.key] = decrypt({
      encryptedValue: r.encryptedValue,
      iv: r.iv,
      tag: r.tag,
    });
  }

  logAction({
    action: "SECRET_FETCH_BULK",
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
    metadata: { keys_count: records.length },
    req,
  });

  return NextResponse.json({ secrets });
}
