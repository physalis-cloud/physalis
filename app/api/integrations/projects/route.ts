// GET /api/integrations/projects — Phase 11b/11c.
//
// Liste les projets accessibles au token Bearer, pour le chargement
// dynamique des selectors dans le nœud N8n / module Make.
//
// UserToken    : tous les projets dont l'user est ProjectMember
// OrgToken     : projets de l'org filtrés par allowedProjectIds (ou tous
//                si allProjects=true). Requiert PROJECTS_LIST scope.
// MachineToken : un seul projet (celui scopé au token) avec son env

import { NextResponse } from "next/server";
import { extractBearer, validateIntegrationToken } from "@/lib/integration-token";
import { withTenantSchema } from "@/lib/tenant";
import { logAction } from "@/lib/audit";

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ctx = await validateIntegrationToken(token);
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // OrgToken : doit avoir le scope PROJECTS_LIST (sinon le token N8n ne
  // peut pas charger dynamiquement la liste — comportement explicite).
  if (ctx.kind === "org" && !ctx.allowedScopes.includes("PROJECTS_LIST")) {
    return NextResponse.json({ error: "Forbidden (scope)" }, { status: 403 });
  }

  const projects = await withTenantSchema(ctx.tenantSlug, async (tx) => {
    if (ctx.kind === "user") {
      const memberships = await tx.projectMember.findMany({
        // Cf. /api/integrations/credentials : un UserToken ne doit pas lister
        // les projets masqués pour son porteur.
        where: { userId: ctx.userId, hidden: false },
        select: {
          role: true,
          project: {
            select: {
              slug: true,
              name: true,
              environments: {
                select: { name: true, url: true },
                orderBy: { name: "asc" },
              },
            },
          },
        },
        orderBy: { project: { name: "asc" } },
      });
      return memberships.map((m) => ({
        slug: m.project.slug,
        name: m.project.name,
        role: m.role,
        environments: m.project.environments,
      }));
    }

    if (ctx.kind === "org") {
      // Liste les projets de l'org, filtrés par allowedProjectIds
      // (si allProjects=false). allProjects=true → tous les projets.
      const where = ctx.allProjects
        ? { organizationId: ctx.organizationId }
        : {
            organizationId: ctx.organizationId,
            id: { in: ctx.allowedProjectIds },
          };
      const rows = await tx.project.findMany({
        where,
        select: {
          slug: true,
          name: true,
          environments: {
            select: { name: true, url: true },
            orderBy: { name: "asc" },
          },
        },
        orderBy: { name: "asc" },
      });
      return rows.map((p) => ({
        slug: p.slug,
        name: p.name,
        role: "VIEWER" as const, // OrgToken = lecture seule en V1
        environments: p.environments,
      }));
    }

    // MachineToken : un seul projet (le sien)
    const project = await tx.project.findUnique({
      where: { id: ctx.projectId },
      select: {
        slug: true,
        name: true,
        environments: {
          where: { id: ctx.environmentId },
          select: { name: true, url: true },
        },
      },
    });
    if (!project) return [];
    return [
      {
        slug: project.slug,
        name: project.name,
        role: "EDITOR" as const,
        environments: project.environments,
      },
    ];
  });

  logAction({
    action: "INTEGRATION_PROJECTS_LIST",
    actor:
      ctx.kind === "user"
        ? { kind: "user", userId: ctx.userId, email: ctx.userEmail }
        : { kind: "token", tokenId: ctx.tokenId, tokenName: ctx.tokenName },
    metadata: { tokenKind: ctx.kind, count: projects.length },
    req,
  });

  return NextResponse.json({ projects });
}
