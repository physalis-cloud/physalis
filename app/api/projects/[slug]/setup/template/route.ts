// GET /api/projects/[slug]/setup/template?policy=<id>&template=<id>
//
// Modèle de workflow PRÉ-REMPLI pour une policy du projet (C-0051, Phase 5) :
// URL et audience de cette instance, slug du projet, environnement, branche et
// nom de fichier / environment CI de la policy. Cf. lib/workflow-templates.ts.
//
// Aucun secret dans le rendu : le workflow les reçoit par OIDC au runtime.
// Lecture VIEWER, comme le guide.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { physalisBaseUrl } from "@/lib/app-url";
import { expectedAudience } from "@/lib/oidc";
import {
  TemplateDriftError,
  WORKFLOW_TEMPLATES,
  loadTemplateSource,
  renderTemplate,
  templateTargetPath,
  type TemplateId,
} from "@/lib/workflow-templates";

type Params = { params: Promise<{ slug: string }> };

export async function GET(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "VIEWER");
  if ("error" in access) return access.error;

  const url = new URL(req.url);
  const policyId = url.searchParams.get("policy") ?? "";
  const templateId = (url.searchParams.get("template") ?? "") as TemplateId;
  if (!(templateId in WORKFLOW_TEMPLATES)) {
    return NextResponse.json({ error: "Unknown template" }, { status: 400 });
  }

  const [policy, project] = await Promise.all([
    // Bornée au projet de la session : `policy` ne sert qu'à choisir parmi
    // les policies SERVEUR de CE projet.
    prisma.policy.findFirst({
      where: { id: policyId, projectId: access.project.id, kind: "server" },
      select: {
        provider: true,
        workflow: true,
        branch: true,
        environment: { select: { name: true } },
      },
    }),
    prisma.project.findUnique({
      where: { id: access.project.id },
      select: { slug: true, environments: { where: { serverId: { not: null } }, select: { name: true } } },
    }),
  ]);
  if (!policy || !policy.environment || !project) {
    return NextResponse.json({ error: "Policy not found" }, { status: 404 });
  }
  if (WORKFLOW_TEMPLATES[templateId].provider !== policy.provider) {
    return NextResponse.json({ error: "Template does not match the policy provider" }, { status: 400 });
  }

  try {
    const source = await loadTemplateSource(templateId);
    const content = renderTemplate(templateId, source, {
      url: physalisBaseUrl(),
      audience: expectedAudience(),
      project: project.slug,
      env: policy.environment.name,
      branch: policy.branch,
      workflow: policy.workflow,
      envOptions: project.environments.map((e) => e.name),
    });
    return NextResponse.json({
      content,
      path: templateTargetPath(templateId, policy.workflow),
    });
  } catch (err) {
    if (err instanceof TemplateDriftError) {
      console.error("[setup-template] modèle non rendu:", err.message);
      return NextResponse.json({ error: "Template unavailable" }, { status: 422 });
    }
    throw err;
  }
}
