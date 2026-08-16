import { NextResponse } from "next/server";
// Route session-based (requireEnvironment → requireUser → tenant context
// entré) → utilise le strict prisma qui auto-route via search_path.
import { prisma } from "@/lib/prisma";
import { withTenantSchema } from "@/lib/tenant";
import { encrypt } from "@/lib/crypto";
import {
  isValidSecretKey,
  readJson,
  requireEnvironment,
} from "@/lib/api";
import { isValidCategory } from "@/lib/categories";
import { logAction } from "@/lib/audit";
import { createSecretVersion } from "@/lib/versioning";
import { normalizeTags, TAG_VALIDATION_ERROR } from "@/lib/tags";
import { triggerSync } from "@/lib/sync/dispatch";

type Params = { params: Promise<{ slug: string; env: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug, env } = await params;
  const access = await requireEnvironment(slug, env);
  if ("error" in access) return access.error;

  const secrets = await prisma.secret.findMany({
    where: { environmentId: access.environment.id },
    select: { id: true, key: true, category: true, tags: true, updatedAt: true, createdAt: true, rotationEnabled: true, rotationStrategy: true },
    orderBy: { key: "asc" },
  });

  return NextResponse.json({ secrets });
}

export async function POST(req: Request, { params }: Params) {
  const { slug, env } = await params;
  const access = await requireEnvironment(slug, env, "EDITOR");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | { key?: string; value?: string; category?: string | null; tags?: string[] }
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
      {
        error:
          "Invalid key (must match [A-Z][A-Z0-9_]{0,127}, e.g. DATABASE_URL)",
      },
      { status: 400 },
    );
  }

  // category : null/absent/"" → "sans catégorie" (DB null) ; sinon doit
  // matcher la liste hardcodée de lib/categories.ts.
  let category: string | null = null;
  if (
    body.category !== undefined &&
    body.category !== null &&
    body.category !== ""
  ) {
    if (!isValidCategory(body.category)) {
      return NextResponse.json(
        { error: "Invalid category" },
        { status: 400 },
      );
    }
    category = body.category;
  }

  const tags = normalizeTags(body.tags);
  if (tags === null) {
    return NextResponse.json({ error: TAG_VALIDATION_ERROR }, { status: 400 });
  }

  // Lit la valeur ACTUELLE du secret (avec encryptedValue/iv/tag) pour
  // créer une version avant l'écrasement. Si pas existant → CREATE
  // simple sans versioning (la valeur initiale n'a pas d'historique).
  const existing = await prisma.secret.findUnique({
    where: {
      environmentId_key: { environmentId: access.environment.id, key },
    },
    select: { id: true, encryptedValue: true, iv: true, tag: true },
  });

  const payload = encrypt(body.value);

  // Transaction : snapshot ancien (si existant) + upsert nouveau, atomique.
  // withTenantSchema, pas prisma.$transaction : cf. F5.1 (lib/prisma.ts).
  const secret = await withTenantSchema(access.tenantSlug, async (tx) => {
    if (existing) {
      await createSecretVersion({
        tx,
        secretId: existing.id,
        encryptedValue: existing.encryptedValue,
        iv: existing.iv,
        tag: existing.tag,
        createdById: access.user.id,
      });
    }
    return tx.secret.upsert({
      where: {
        environmentId_key: { environmentId: access.environment.id, key },
      },
      create: {
        key,
        environmentId: access.environment.id,
        category,
        tags,
        ...payload,
      },
      update: { ...payload, category, tags },
      select: {
        id: true,
        key: true,
        category: true,
        tags: true,
        updatedAt: true,
        createdAt: true,
      },
    });
  });

  logAction({
    action: existing ? "SECRET_UPDATE" : "SECRET_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: access.environment.id,
    targetType: "Secret",
    targetId: secret.id,
    secretKey: key,
    metadata: { category: secret.category },
    req,
  });

  // Sync sortante (fire-and-forget) — pousse l'env vers ses cibles (Vercel…).
  void triggerSync(
    access.tenantSlug,
    access.environment.id,
    existing ? "secret_update" : "secret_create",
    { userId: access.user.id, email: access.user.email },
  );

  return NextResponse.json(
    {
      secret: {
        key: secret.key,
        category: secret.category,
        tags: secret.tags,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
      },
    },
    { status: 200 },
  );
}
