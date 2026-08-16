// Chantier "Déploiement mobile" — Phase 1 (socle credentials).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";

type Params = { params: Promise<{ slug: string; appId: string; kind: string }> };

export async function DELETE(req: Request, { params }: Params) {
  const { slug, appId, kind } = await params;
  const access = await requireProjectMember(slug, "EDITOR", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const credential = await prisma.mobileCredential.findFirst({
    where: { kind, app: { id: appId, projectId: access.project.id } },
    select: { id: true },
  });
  if (!credential) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Cascade DB : supprime aussi MobileCredentialVersion.
  await prisma.mobileCredential.delete({ where: { id: credential.id } });

  logAction({
    action: "MOBILE_CREDENTIAL_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileCredential",
    targetId: credential.id,
    metadata: { appId, kind },
    req,
  });

  return NextResponse.json({ ok: true });
}
