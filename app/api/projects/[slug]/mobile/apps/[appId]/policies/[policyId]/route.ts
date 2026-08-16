// Jumeau self-host — supprimer une policy d'app mobile. Mono-tenant : pas de
// miroir admin.policies à nettoyer.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { hasDevPrivileges } from "@/lib/roles";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";

type Params = {
  params: Promise<{ slug: string; appId: string; policyId: string }>;
};

export async function DELETE(req: Request, { params }: Params) {
  const { slug, appId, policyId } = await params;
  const access = await requireProjectMember(slug, "VIEWER");
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;
  const canManage =
    access.role === "OWNER" || hasDevPrivileges(access.orgRole);
  if (!canManage) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const policy = await prisma.policy.findFirst({
    where: {
      id: policyId,
      projectId: access.project.id,
      mobileAppId: appId,
      kind: "mobile",
    },
    select: {
      id: true,
      provider: true,
      repo: true,
      workflow: true,
      branch: true,
    },
  });
  if (!policy) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.policy.delete({ where: { id: policy.id } });

  logAction({
    action: "POLICY_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Policy",
    targetId: policy.id,
    metadata: {
      kind: "mobile",
      provider: policy.provider,
      repo: policy.repo,
      workflow: policy.workflow,
      branch: policy.branch,
      appId,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}
