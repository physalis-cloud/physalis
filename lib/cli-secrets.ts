// Lecture des secrets par une session CLI — C-0050, phase 2b (T-0287).
//
// `GET /api/secrets/{projet}/{env}` servait un seul porteur : le token machine
// `sv_`, lié à UN projet et UN environnement. Une session `sv_cli_` est liée à
// un UTILISATEUR : elle lit tout projet que cet utilisateur peut lire dans le
// navigateur, et rien de plus. Les droits sont re-dérivés À CHAQUE REQUÊTE par
// les helpers uniques de lib/project-access.ts — jamais recopiés :
//
//   - pas membre de l'org du projet (et pas admin plateforme) → 403 ;
//   - `hidden: true` est une BARRIÈRE d'accès (403), pas un réglage
//     d'affichage (mémoire rbac-hidden-invariant) ;
//   - VIEWER suffit, comme pour révéler un secret dans l'interface
//     (requireEnvironment, rôle par défaut VIEWER) ;
//   - production : selon les droits (scénario S3 bis du plan) ;
//   - siège gelé : refusé, comme toute l'API (requireUser).
//
// Session « agent IA » (kind AI, phase 2d) : en PLUS des droits de l'humain,
// le couple (projet, environnement) doit être dans le périmètre coché à
// l'approbation (lib/cli-ai-scope.ts) — environnements de dev seulement, jamais
// de `pull`. Tracée `via: "ai_session"`.

import { NextResponse } from "next/server";
import { decrypt } from "./crypto";
import { logAction } from "./audit";
import { withTenantSchema } from "./tenant";
import { maybeRunWithTenant } from "./tenant-context";
import { isPlatformAdmin } from "./roles";
import { seatFrozenForUser } from "./feature-guard";
import { accessibleProjectsWhere, resolveOrgRole } from "./project-access";
import { machineFetchRateLimited } from "./machine-rate-limit";
import { validateCliSession, type ValidCliSession } from "./cli-session";
import { isPullableEnvironment } from "./cli-env-policy";
import { parseAiScope, aiScopeAllows } from "./cli-ai-scope";

export { PULLABLE_ENV_NAMES, isPullableEnvironment } from "./cli-env-policy";

type Read =
  | {
      ok: true;
      secrets: Record<string, string>;
      organizationId: string;
      projectId: string;
      environmentId: string;
    }
  | {
      ok: false;
      status: 403 | 404;
      reason: string;
      organizationId?: string;
      projectId?: string;
    };

async function readForSession(
  session: ValidCliSession,
  slug: string,
  envName: string,
): Promise<Read> {
  return withTenantSchema(session.tenantSlug, async (tx): Promise<Read> => {
    const project = await tx.project.findUnique({
      where: { slug },
      select: { id: true, organizationId: true },
    });
    if (!project) return { ok: false, status: 404, reason: "project_not_found" };
    const scope = { organizationId: project.organizationId, projectId: project.id };

    const member = await tx.orgMember.findFirst({
      where: { userId: session.user.id, organizationId: project.organizationId },
      select: { role: true },
    });
    const orgRole = resolveOrgRole(member?.role ?? null, session.user.role);
    if (!orgRole) return { ok: false, status: 403, reason: "not_org_member", ...scope };

    const visible = await tx.project.findFirst({
      where: {
        AND: [
          { id: project.id },
          accessibleProjectsWhere(project.organizationId, session.user.id, orgRole),
        ],
      },
      select: { id: true },
    });
    if (!visible) return { ok: false, status: 403, reason: "project_not_accessible", ...scope };

    // Agent IA : l'humain peut lire ce projet, mais l'a-t-il OUVERT à son agent ?
    if (session.kind === "AI" && !aiScopeAllows(parseAiScope(session.scope), project.id, envName)) {
      return { ok: false, status: 403, reason: "outside_ai_scope", ...scope };
    }

    const environment = await tx.environment.findUnique({
      where: { projectId_name: { projectId: project.id, name: envName } },
      select: { id: true },
    });
    if (!environment) return { ok: false, status: 404, reason: "environment_not_found", ...scope };

    const records = await tx.secret.findMany({
      where: { environmentId: environment.id },
      select: { key: true, encryptedValue: true, iv: true, tag: true },
    });
    const secrets: Record<string, string> = {};
    for (const r of records) {
      secrets[r.key] = decrypt({ encryptedValue: r.encryptedValue, iv: r.iv, tag: r.tag });
    }
    return { ok: true, secrets, ...scope, environmentId: environment.id };
  });
}

/**
 * Branche `sv_cli_…` de `GET /api/secrets/{projet}/{env}`. Rend la réponse
 * complète (même forme `{ secrets }` que pour un `sv_`, donc la CLI ne change
 * pas de contrat).
 */
export async function handleCliSecretsRequest(
  req: Request,
  token: string,
  slug: string,
  envName: string,
): Promise<NextResponse> {
  const session = await validateCliSession(token);
  if (!session) {
    logAction({
      action: "TOKEN_USE_FAILED",
      actor: { kind: "anonymous" },
      metadata: { reason: "invalid_or_revoked_cli_session", slug, env: envName },
      req,
    });
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const actor = { kind: "user" as const, userId: session.user.id, email: session.user.email };
  const via = {
    via: session.kind === "AI" ? "ai_session" : "cli_session",
    cliSessionId: session.id,
    deviceName: session.deviceName,
  };

  // `physalis pull` écrit un `.env` EN CLAIR sur le poste : accepté pour un
  // environnement de dev seulement. Déclaré par la CLI (`?purpose=pull`) : c'est
  // un garde-fou contre l'erreur, pas une barrière contre un client modifié —
  // la barrière reste les droits du projet, appliqués plus bas.
  const pull = new URL(req.url).searchParams.get("purpose") === "pull";
  // Un agent IA ne télécharge jamais de .env en clair (scénario S4).
  if (pull && session.kind === "AI") {
    logAction({
      action: "TOKEN_USE_FAILED",
      actor,
      metadata: { reason: "pull_ai_session", slug, env: envName, ...via },
      req,
      tenantSlug: session.tenantSlug,
    });
    return NextResponse.json({ error: "Forbidden", reason: "pull_ai_session" }, { status: 403 });
  }
  if (pull && !isPullableEnvironment(envName)) {
    logAction({
      action: "TOKEN_USE_FAILED",
      actor,
      metadata: { reason: "pull_non_dev_environment", slug, env: envName, ...via },
      req,
      tenantSlug: session.tenantSlug,
    });
    return NextResponse.json(
      { error: "Forbidden", reason: "pull_non_dev_environment" },
      { status: 403 },
    );
  }

  const frozen = await maybeRunWithTenant(session.tenantSlug, () =>
    seatFrozenForUser({
      tenantSlug: session.tenantSlug,
      userId: session.user.id,
      isPlatformAdmin: isPlatformAdmin(session.user.role),
    }),
  );
  if (frozen) {
    return NextResponse.json({ error: "Forbidden", reason: "seat_frozen" }, { status: 403 });
  }

  // Même plafond que les tokens machine (120/min), compté par session, AVANT
  // tout déchiffrement.
  const limited = machineFetchRateLimited(req, {
    tokenId: session.id,
    tokenName: `cli:${session.deviceName ?? session.user.email}`,
    tenantSlug: session.tenantSlug ?? "",
  });
  if (limited) return limited;

  const read = await readForSession(session, slug, envName);
  if (!read.ok) {
    logAction({
      action: "TOKEN_USE_FAILED",
      actor,
      organizationId: read.organizationId ?? null,
      projectId: read.projectId ?? null,
      metadata: { reason: read.reason, requested: { slug, env: envName }, ...via },
      req,
      tenantSlug: session.tenantSlug,
    });
    return NextResponse.json(
      { error: read.status === 404 ? "Not found" : "Forbidden" },
      { status: read.status },
    );
  }

  logAction({
    // Un pull écrit les valeurs dans un fichier : c'est un export (§2.25a),
    // tracé comme tel, pas une lecture en mémoire.
    action: pull ? "SECRET_EXPORT" : "SECRET_FETCH_BULK",
    actor,
    organizationId: read.organizationId,
    projectId: read.projectId,
    environmentId: read.environmentId,
    targetType: "Environment",
    targetId: read.environmentId,
    metadata: {
      keys_count: Object.keys(read.secrets).length,
      ...via,
      ...(pull ? { purpose: "pull" } : {}),
    },
    req,
    tenantSlug: session.tenantSlug,
  });

  return NextResponse.json({ secrets: read.secrets });
}
