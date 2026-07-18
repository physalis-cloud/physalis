// GET /api/integrations/tags?project=<slug>&type=<secret|service|account>&env=<name>
//
// Liste des tags techniques distincts dans un projet, pour l'autocomplete
// du nœud N8n. Pas d'audit log (lecture méta sans valeur sensible).
//
// Auth : Bearer (UserToken OU MachineToken). Mêmes règles RBAC que
// /api/integrations/credentials.

import { NextResponse } from "next/server";
import {
  extractBearer,
  orgTokenAllowsProject,
  scopeForType,
  validateIntegrationToken,
} from "@/lib/integration-token";
import { withTenantSchema } from "@/lib/tenant";

type ItemType = "secret" | "service" | "account";

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await validateIntegrationToken(token);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const projectSlug = url.searchParams.get("project");
  const type = url.searchParams.get("type") as ItemType | null;
  const envName = url.searchParams.get("env");

  if (!projectSlug) {
    return NextResponse.json({ error: "project required" }, { status: 400 });
  }
  if (!type || !["secret", "service", "account"].includes(type)) {
    return NextResponse.json(
      { error: "type must be one of: secret, service, account" },
      { status: 400 },
    );
  }
  if (type === "secret" && !envName) {
    return NextResponse.json(
      { error: "env is required when type=secret" },
      { status: 400 },
    );
  }

  if (ctx.kind === "machine" && ctx.projectSlug !== projectSlug) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (ctx.kind === "machine" && type === "secret" && envName !== ctx.environmentName) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // OrgToken : check du scope mappé sur le type demandé.
  if (ctx.kind === "org" && !ctx.allowedScopes.includes(scopeForType(type))) {
    return NextResponse.json({ error: "Forbidden (scope)" }, { status: 403 });
  }

  const tags = await withTenantSchema(ctx.tenantSlug, async (tx) => {
    const project = await tx.project.findUnique({
      where: { slug: projectSlug },
      select: { id: true, organizationId: true },
    });
    if (!project) return null;

    if (ctx.kind === "user") {
      // Cf. /api/integrations/credentials : `hidden` doit être lu, un projet
      // masqué est refusé (403) partout ailleurs.
      const member = await tx.projectMember.findUnique({
        where: {
          userId_projectId: { userId: ctx.userId, projectId: project.id },
        },
        select: { role: true, hidden: true },
      });
      if (!member || member.hidden) return "forbidden" as const;
    } else if (ctx.kind === "org") {
      if (project.organizationId !== ctx.organizationId) {
        return "forbidden" as const;
      }
      if (!orgTokenAllowsProject(ctx, project.id)) {
        return "forbidden" as const;
      }
    }

    if (type === "secret") {
      const env = await tx.environment.findUnique({
        where: { projectId_name: { projectId: project.id, name: envName! } },
        select: { id: true },
      });
      if (!env) return null;
      const rows = await tx.secret.findMany({
        where: { environmentId: env.id },
        select: { tags: true },
      });
      return collect(rows);
    }
    if (type === "service") {
      const rows = await tx.service.findMany({
        where: { projectId: project.id },
        select: { tags: true },
      });
      return collect(rows);
    }
    const rows = await tx.appAccount.findMany({
      where: { projectId: project.id },
      select: { tags: true },
    });
    return collect(rows);
  });

  if (tags === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (tags === "forbidden")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  return NextResponse.json({ tags });
}

function collect(rows: Array<{ tags: string[] }>): string[] {
  const set = new Set<string>();
  for (const r of rows) for (const t of r.tags) set.add(t);
  return Array.from(set).sort();
}
