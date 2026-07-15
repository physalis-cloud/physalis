import { NextResponse } from "next/server";
// Route session-based (requireEnvironment → tenant context entré) →
// utilise le strict prisma qui auto-route via search_path.
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import { isValidSecretKey, readJson, requireEnvironment } from "@/lib/api";
import { isValidCategory } from "@/lib/categories";
import { logAction } from "@/lib/audit";
import { normalizeTags, TAG_VALIDATION_ERROR } from "@/lib/tags";
import { createSecretVersion } from "@/lib/versioning";
import { triggerSync } from "@/lib/sync/dispatch";

type Params = { params: Promise<{ slug: string; env: string; key: string }> };

// Reveal a single secret value (web UI - one key at a time, never bulk).
export async function GET(req: Request, { params }: Params) {
  try {
    const { slug, env, key } = await params;
    const access = await requireEnvironment(slug, env);
    if ("error" in access) return access.error;

    const secret = await prisma.secret.findUnique({
      where: {
        environmentId_key: { environmentId: access.environment.id, key },
      },
      select: { id: true, key: true, encryptedValue: true, iv: true, tag: true },
    });
    if (!secret) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const value = decrypt({
      encryptedValue: secret.encryptedValue,
      iv: secret.iv,
      tag: secret.tag,
    });

    logAction({
      action: "SECRET_REVEAL",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.project.organizationId,
      projectId: access.project.id,
      environmentId: access.environment.id,
      targetType: "Secret",
      targetId: secret.id,
      secretKey: secret.key,
      req,
    });

    return NextResponse.json({ key: secret.key, value });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reveal] unexpected error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PATCH partiel. Tous les champs sont optionnels et ne sont modifies
 * que s'ils sont presents dans le body :
 *   - category / tags : metadata pure, pas de re-encrypt
 *   - value          : re-encrypt + cree une SecretVersion snapshot
 *                       (parite avec POST upsert)
 *   - newKey         : renomme la cle (verification d'unicite dans l'env)
 *
 * Si le body est vide → no-op silencieux. Permet a l'UI d'envoyer "ce
 * que l'user a touche" sans craindre d'ecraser des champs intacts.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { slug, env, key } = await params;
  const access = await requireEnvironment(slug, env, "EDITOR");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | {
        category?: string | null;
        tags?: string[];
        value?: string;
        newKey?: string;
      }
    | null;
  if (
    !body ||
    (!("category" in body) &&
      !("tags" in body) &&
      !("value" in body) &&
      !("newKey" in body))
  ) {
    return NextResponse.json(
      { error: "at least one of category, tags, value, newKey is required" },
      { status: 400 },
    );
  }

  const existing = await prisma.secret.findUnique({
    where: {
      environmentId_key: { environmentId: access.environment.id, key },
    },
    select: {
      id: true,
      key: true,
      category: true,
      tags: true,
      encryptedValue: true,
      iv: true,
      tag: true,
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const data: {
    category?: string | null;
    tags?: string[];
    key?: string;
    encryptedValue?: string;
    iv?: string;
    tag?: string;
  } = {};
  const changed: string[] = [];

  if ("category" in body) {
    let category: string | null = null;
    if (body.category !== null && body.category !== "" && body.category !== undefined) {
      if (!isValidCategory(body.category)) {
        return NextResponse.json(
          { error: "Invalid category" },
          { status: 400 },
        );
      }
      category = body.category;
    }
    if (existing.category !== category) {
      data.category = category;
      changed.push("category");
    }
  }

  if ("tags" in body) {
    const tags = normalizeTags(body.tags);
    if (tags === null) {
      return NextResponse.json({ error: TAG_VALIDATION_ERROR }, { status: 400 });
    }
    // Compare arrays naïf : ordres + contenu identiques ?
    const sameTags =
      existing.tags.length === tags.length &&
      existing.tags.every((t, i) => t === tags[i]);
    if (!sameTags) {
      data.tags = tags;
      changed.push("tags");
    }
  }

  // newKey : rename avec verification d'unicite + format
  if ("newKey" in body && typeof body.newKey === "string") {
    const nk = body.newKey.trim();
    if (nk !== existing.key) {
      if (!isValidSecretKey(nk)) {
        return NextResponse.json(
          {
            error:
              "Invalid key (must match [A-Z][A-Z0-9_]{0,127}, e.g. DATABASE_URL)",
          },
          { status: 400 },
        );
      }
      const conflict = await prisma.secret.findUnique({
        where: {
          environmentId_key: { environmentId: access.environment.id, key: nk },
        },
        select: { id: true },
      });
      if (conflict) {
        return NextResponse.json(
          { error: "A secret with this key already exists in this environment" },
          { status: 409 },
        );
      }
      data.key = nk;
      changed.push("key");
    }
  }

  // value : re-encrypt + version snapshot (parite avec POST upsert)
  let mustSnapshot = false;
  if ("value" in body && typeof body.value === "string" && body.value !== "") {
    const payload = encrypt(body.value);
    data.encryptedValue = payload.encryptedValue;
    data.iv = payload.iv;
    data.tag = payload.tag;
    changed.push("value");
    mustSnapshot = true;
  }

  if (changed.length === 0) {
    // No-op : pas de write, pas d'audit log inutile.
    return NextResponse.json({
      secret: {
        key: existing.key,
        category: existing.category,
        tags: existing.tags,
      },
    });
  }

  // Snapshot atomique + update si la valeur change. Sinon update simple.
  const updated = mustSnapshot
    ? await prisma.$transaction(async (tx) => {
        await createSecretVersion({
          tx,
          secretId: existing.id,
          encryptedValue: existing.encryptedValue,
          iv: existing.iv,
          tag: existing.tag,
          createdById: access.user.id,
        });
        return tx.secret.update({
          where: { id: existing.id },
          data,
          select: { key: true, category: true, tags: true, updatedAt: true },
        });
      })
    : await prisma.secret.update({
        where: { id: existing.id },
        data,
        select: { key: true, category: true, tags: true, updatedAt: true },
      });

  logAction({
    action: "SECRET_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: access.environment.id,
    targetType: "Secret",
    targetId: existing.id,
    secretKey: updated.key,
    metadata: {
      changedFields: changed,
      ...(data.key ? { previousKey: existing.key, newKey: data.key } : {}),
    },
    req,
  });

  // Sync sortante (fire-and-forget) — valeur, clé ou tags peuvent avoir changé.
  void triggerSync(access.tenantSlug, access.environment.id, "secret_update", {
    userId: access.user.id,
    email: access.user.email,
  });

  return NextResponse.json({ secret: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const { slug, env, key } = await params;
    const access = await requireEnvironment(slug, env, "EDITOR");
    if ("error" in access) return access.error;

    const existing = await prisma.secret.findUnique({
      where: {
        environmentId_key: { environmentId: access.environment.id, key },
      },
      select: { id: true, key: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Deux awaits séquentiels sur prisma (client étendu) — évite $transaction
    // dont la gestion d'erreur est incompatible avec l'extension multi-tenant.
    // secretVersion.deleteMany en premier : défense si le CASCADE DB est absent.
    await prisma.secretVersion.deleteMany({ where: { secretId: existing.id } });
    // select minimal : évite "RETURNING *" qui référence des colonnes absentes en staging (P2022)
    await prisma.secret.delete({ where: { id: existing.id }, select: { id: true } });

    logAction({
      action: "SECRET_DELETE",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.project.organizationId,
      projectId: access.project.id,
      environmentId: access.environment.id,
      targetType: "Secret",
      targetId: existing.id,
      secretKey: existing.key,
      req,
    });

    // Sync sortante (fire-and-forget) — la cible retirera la var distante
    // absente de l'état désiré (réconciliation côté connecteur).
    void triggerSync(access.tenantSlug, access.environment.id, "secret_delete", {
      userId: access.user.id,
      email: access.user.email,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[delete] unexpected error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
