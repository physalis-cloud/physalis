import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withTenantSchema } from "@/lib/tenant";
import { encrypt } from "@/lib/crypto";
import {
  isValidSecretKey,
  readJson,
  requireOrgMember,
} from "@/lib/api";
import { logAction } from "@/lib/audit";
import { createOrgSecretVersion } from "@/lib/versioning";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  // DEV+ peut lister les OrgSecret (lecture seule). Le reveal de la valeur
  // est dans l'autre route (cf. [key]/route.ts) avec la même règle DEV+.
  const access = await requireOrgMember(slug, "DEV");
  if ("error" in access) return access.error;

  const secrets = await prisma.orgSecret.findMany({
    where: { organizationId: access.organization.id },
    select: { key: true, updatedAt: true, createdAt: true, expiresAt: true },
    orderBy: { key: "asc" },
  });

  return NextResponse.json({ secrets });
}

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug, "ADMIN_DEV");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | { key?: string; value?: string; expiresInDays?: number | null }
    | null;
  if (!body || typeof body.key !== "string" || typeof body.value !== "string") {
    return NextResponse.json(
      { error: "key and value are required strings" },
      { status: 400 },
    );
  }
  const key = body.key.trim();
  if (!isValidSecretKey(key)) {
    return NextResponse.json(
      { error: "Cle invalide (format ^[A-Z][A-Z0-9_]*$)" },
      { status: 400 },
    );
  }

  // Rappel manuel de renouvellement : durée → date d'expiration (null = sans).
  let expiresAt: Date | null = null;
  if (body.expiresInDays != null) {
    const d = Number(body.expiresInDays);
    if (!Number.isInteger(d) || d <= 0 || d > 3650) {
      return NextResponse.json({ error: "expiresInDays invalide (1-3650)" }, { status: 400 });
    }
    expiresAt = new Date(Date.now() + d * 86_400_000);
  }

  // Lit la valeur ACTUELLE (encryptedValue/iv/tag) pour snapshot avant
  // l'écrasement. CREATE simple si pas existant (pas d'historique sur
  // la valeur initiale).
  const existing = await prisma.orgSecret.findUnique({
    where: {
      organizationId_key: { organizationId: access.organization.id, key },
    },
    select: { id: true, encryptedValue: true, iv: true, tag: true },
  });

  const payload = encrypt(body.value);

  // Transaction : snapshot ancien (si existant) + upsert nouveau, atomique.
  // withTenantSchema, pas prisma.$transaction : cf. F5.1 (lib/prisma.ts).
  const secret = await withTenantSchema(access.tenantSlug, async (tx) => {
    if (existing) {
      await createOrgSecretVersion({
        tx,
        orgSecretId: existing.id,
        encryptedValue: existing.encryptedValue,
        iv: existing.iv,
        tag: existing.tag,
        createdById: access.user.id,
      });
    }
    return tx.orgSecret.upsert({
      where: {
        organizationId_key: { organizationId: access.organization.id, key },
      },
      create: {
        key,
        organizationId: access.organization.id,
        ...payload,
        expiresAt,
      },
      // Re-sauvegarde = renouvellement : on réinitialise createdAt + expiresAt.
      update: { ...payload, expiresAt, createdAt: new Date() },
      select: { id: true, key: true, updatedAt: true, createdAt: true, expiresAt: true },
    });
  });

  logAction({
    action: existing ? "ORG_SECRET_UPDATE" : "ORG_SECRET_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "OrgSecret",
    targetId: secret.id,
    secretKey: key,
    req,
  });

  return NextResponse.json({
    secret: {
      key: secret.key,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      expiresAt: secret.expiresAt,
    },
  });
}
