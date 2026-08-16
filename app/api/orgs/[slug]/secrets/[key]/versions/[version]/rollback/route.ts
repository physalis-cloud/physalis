// POST /api/orgs/[slug]/secrets/[key]/versions/[version]/rollback
//
// Restaure une version historique d'un OrgSecret. Mêmes contraintes
// que pour Secret (cf. ../../../[version]/rollback/route.ts pour la
// spec complète) : transaction atomique snapshot + UPDATE.
//
// RBAC : ADMIN+ (mêmes droits que UPDATE OrgSecret).
// Audit : ORG_SECRET_ROLLBACK avec metadata.fromVersion + toVersion.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withTenantSchema } from "@/lib/tenant";
import { requireOrgMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { createOrgSecretVersion } from "@/lib/versioning";

type Params = {
  params: Promise<{ slug: string; key: string; version: string }>;
};

export async function POST(req: Request, { params }: Params) {
  const { slug, key, version: versionStr } = await params;
  const targetVersion = Number.parseInt(versionStr, 10);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  }

  const access = await requireOrgMember(slug, "ADMIN");
  if ("error" in access) return access.error;

  const secret = await prisma.orgSecret.findUnique({
    where: {
      organizationId_key: { organizationId: access.organization.id, key },
    },
    select: { id: true, encryptedValue: true, iv: true, tag: true },
  });
  if (!secret) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const targetVersionRow = await prisma.orgSecretVersion.findUnique({
    where: {
      orgSecretId_version: { orgSecretId: secret.id, version: targetVersion },
    },
    select: { encryptedValue: true, iv: true, tag: true },
  });
  if (!targetVersionRow) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  }

  // withTenantSchema, pas prisma.$transaction : cf. F5.1 (lib/prisma.ts).
  const result = await withTenantSchema(access.tenantSlug, async (tx) => {
    const { version: snapshotVersion } = await createOrgSecretVersion({
      tx,
      orgSecretId: secret.id,
      encryptedValue: secret.encryptedValue,
      iv: secret.iv,
      tag: secret.tag,
      createdById: access.user.id,
    });
    const updated = await tx.orgSecret.update({
      where: { id: secret.id },
      data: {
        encryptedValue: targetVersionRow.encryptedValue,
        iv: targetVersionRow.iv,
        tag: targetVersionRow.tag,
      },
      select: { key: true, createdAt: true, updatedAt: true },
    });
    return { snapshotVersion, updated };
  });

  logAction({
    action: "ORG_SECRET_ROLLBACK",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "OrgSecret",
    targetId: secret.id,
    secretKey: key,
    metadata: {
      fromVersion: result.snapshotVersion,
      toVersion: targetVersion,
    },
    req,
  });

  return NextResponse.json({ secret: result.updated });
}
