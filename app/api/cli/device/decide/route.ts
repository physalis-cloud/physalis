// POST /api/cli/device/decide — l'utilisateur approuve ou refuse une demande
// `physalis login` (C-0050, phase 2). Session web requise ; protégée contre le
// CSRF par le cookie SameSite=Lax, comme /api/plugin/issue.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { cliTenantOfWebSession } from "@/lib/cli-tenant";
import { decideDevice, findPendingDevice, normalizeUserCode } from "@/lib/cli-session";
import { validateAiSelection, aiScopeToJson } from "@/lib/cli-ai-scope";

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  // §2.18 — une session DÉRIVÉE d'un PluginToken n'ouvre pas d'autre accès :
  // un token d'extension volé ne doit pas se changer en session CLI.
  if (user.origin === "plugin_token") {
    return NextResponse.json(
      { error: "Session dérivée d'un token ; ré-authentification requise." },
      { status: 403 },
    );
  }

  const tenant = cliTenantOfWebSession(userRes.tenantSlug);
  if (!tenant.ok) {
    return NextResponse.json({ error: tenant.error }, { status: tenant.status });
  }

  const limited = rateLimit(req, "cli-device-decide", { max: 20, windowMs: 15 * 60_000 }, user.id);
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as
    | { code?: unknown; approve?: unknown; scope?: unknown }
    | null;
  const userCode = normalizeUserCode(body?.code);
  if (!userCode || typeof body?.approve !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Session « agent IA » (phase 2d) : approuver exige un périmètre, validé
  // contre ce que l'humain lit lui-même, environnements de dev seulement.
  let scope = null;
  let scopeSummary: string[] | undefined;
  if (body.approve) {
    const pending = await findPendingDevice(tenant.tenantSlug, userCode);
    if (!pending) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (pending.kind === "AI") {
      const valid = await validateAiSelection(tenant.tenantSlug, user.id, user.role, body.scope);
      if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });
      scope = aiScopeToJson(valid.scope);
      scopeSummary = valid.scope.projects.flatMap((p) => p.environments.map((e) => `${p.slug}/${e}`));
    }
  }

  const decided = await decideDevice(tenant.tenantSlug, userCode, user.id, body.approve, scope);
  if (!decided) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const orgMember = await prisma.orgMember.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });

  logAction({
    action: body.approve ? "CLI_SESSION_APPROVED" : "CLI_SESSION_DENIED",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: orgMember?.organizationId ?? null,
    targetType: "CliDeviceAuthorization",
    targetId: decided.id,
    metadata: {
      deviceName: decided.deviceName,
      kind: decided.kind,
      ...(scopeSummary ? { scope: scopeSummary } : {}),
    },
    req,
    tenantSlug: tenant.tenantSlug,
  });

  return NextResponse.json({ ok: true });
}
