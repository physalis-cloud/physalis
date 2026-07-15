// POST /api/projects/[slug]/[env]/secrets/[key]/versions/[version]/rollback
//
// Restaure une version historique d'un Secret comme valeur courante.
// RBAC : EDITOR+ (mêmes droits que UPDATE).
//
// Séquencement (en transaction atomique) :
//   1. Lit la valeur ACTUELLE du Secret (avant écrasement)
//   2. INSERT cette valeur courante dans SecretVersion (snapshot pré-rollback)
//   3. UPDATE Secret avec la valeur de la version cible
//
// Résultat : la valeur courante d'avant le rollback est conservée
// dans l'historique (pas de perte). On peut re-rollback dans l'autre
// sens si besoin.
//
// Audit : SECRET_ROLLBACK avec metadata.fromVersion (version snapshot
// créée par le rollback) et toVersion (version cible restaurée).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnvironment } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { triggerSync } from "@/lib/sync/dispatch";
import { createSecretVersion } from "@/lib/versioning";

type Params = {
  params: Promise<{
    slug: string;
    env: string;
    key: string;
    version: string;
  }>;
};

export async function POST(req: Request, { params }: Params) {
  const { slug, env, key, version: versionStr } = await params;
  const targetVersion = Number.parseInt(versionStr, 10);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  }

  const access = await requireEnvironment(slug, env, "EDITOR");
  if ("error" in access) return access.error;

  const secret = await prisma.secret.findUnique({
    where: {
      environmentId_key: { environmentId: access.environment.id, key },
    },
    select: { id: true, encryptedValue: true, iv: true, tag: true },
  });
  if (!secret) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const targetVersionRow = await prisma.secretVersion.findUnique({
    where: {
      secretId_version: { secretId: secret.id, version: targetVersion },
    },
    select: { encryptedValue: true, iv: true, tag: true },
  });
  if (!targetVersionRow) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  }

  // Transaction : snapshot l'ancienne valeur + UPDATE atomique.
  const result = await prisma.$transaction(async (tx) => {
    const { version: snapshotVersion } = await createSecretVersion({
      tx,
      secretId: secret.id,
      encryptedValue: secret.encryptedValue,
      iv: secret.iv,
      tag: secret.tag,
      createdById: access.user.id,
    });
    const updated = await tx.secret.update({
      where: { id: secret.id },
      data: {
        encryptedValue: targetVersionRow.encryptedValue,
        iv: targetVersionRow.iv,
        tag: targetVersionRow.tag,
      },
      select: {
        key: true,
        category: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { snapshotVersion, updated };
  });

  logAction({
    action: "SECRET_ROLLBACK",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: access.environment.id,
    targetType: "Secret",
    targetId: secret.id,
    secretKey: key,
    metadata: {
      fromVersion: result.snapshotVersion,
      toVersion: targetVersion,
    },
    req,
  });

  // Sync sortante (fire-and-forget) — la valeur du secret a changé.
  void triggerSync(access.tenantSlug, access.environment.id, "secret_rollback", {
    userId: access.user.id,
    email: access.user.email,
  });

  return NextResponse.json({ secret: result.updated });
}
