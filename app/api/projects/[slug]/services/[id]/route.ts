import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import { readJson, requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { normalizeTags, TAG_VALIDATION_ERROR } from "@/lib/tags";
import { validateHookUrlSyntax } from "@/lib/safe-fetch";

type Params = { params: Promise<{ slug: string; id: string }> };

function decryptCreds(payload: {
  encryptedData: string;
  iv: string;
  tag: string;
}): { user: string; password: string } {
  const json = decrypt({
    encryptedValue: payload.encryptedData,
    iv: payload.iv,
    tag: payload.tag,
  });
  const parsed = JSON.parse(json) as { user?: string; password?: string };
  return {
    user: parsed.user ?? "",
    password: parsed.password ?? "",
  };
}

// Reveal a service with its decrypted credentials.
export async function GET(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug);
  if ("error" in access) return access.error;

  const service = await prisma.service.findFirst({
    where: { id, projectId: access.project.id },
  });
  if (!service) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const creds = decryptCreds(service);

  logAction({
    action: "SERVICE_REVEAL",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Service",
    targetId: service.id,
    metadata: { name: service.name },
    req,
  });

  return NextResponse.json({
    service: {
      id: service.id,
      name: service.name,
      url: service.url,
      user: creds.user,
      password: creds.password,
      rotationWebhookUrl: service.rotationWebhookUrl,
      rotationHookToken: service.rotationHookToken,
      rotationExecMode: service.rotationExecMode,
      dbType: service.dbType,
      dbHost: service.dbHost,
      dbPort: service.dbPort,
      dbName: service.dbName,
      dbUser: service.dbUser,
    },
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const service = await prisma.service.findFirst({
    where: { id, projectId: access.project.id },
  });
  if (!service) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await readJson(req)) as
    | {
        name?: string;
        url?: string | null;
        user?: string;
        password?: string;
        tags?: string[];
        rotationWebhookUrl?: string | null;
        rotationHookToken?: string | null;
        rotationExecMode?: string | null;
        dbType?: string | null;
        dbHost?: string | null;
        dbPort?: number | null;
        dbName?: string | null;
        dbUser?: string | null;
        dbPassword?: string | null;
      }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const data: {
    name?: string;
    url?: string | null;
    encryptedData?: string;
    iv?: string;
    tag?: string;
    tags?: string[];
    rotationWebhookUrl?: string | null;
    rotationHookToken?: string | null;
    rotationExecMode?: string | null;
    dbType?: string | null;
    dbHost?: string | null;
    dbPort?: number | null;
    dbName?: string | null;
    dbUser?: string | null;
    dbPwEncrypted?: string | null;
    dbPwIv?: string | null;
    dbPwTag?: string | null;
  } = {};
  const changed: string[] = [];

  // Hook de rotation des comptes liés (service backend). execMode AGENT|DIRECT.
  if ("rotationWebhookUrl" in body) {
    data.rotationWebhookUrl = body.rotationWebhookUrl?.trim() || null;
    changed.push("rotationHook");
  }
  if ("rotationHookToken" in body) data.rotationHookToken = body.rotationHookToken?.trim() || null;
  if ("rotationExecMode" in body) {
    data.rotationExecMode = body.rotationExecMode === "DIRECT" ? "DIRECT" : body.rotationExecMode === "AGENT" ? "AGENT" : null;
  }
  // Passage explicite en DIRECT avec une URL de hook → refus des cibles internes
  // (garde SSRF, cf. documentation/rapports/failles.md §6). L'enforcement autoritaire reste
  // `safeFetchHook` à l'appel ; ceci est un retour clair à la configuration.
  if (data.rotationExecMode === "DIRECT" && typeof data.rotationWebhookUrl === "string") {
    const urlError = validateHookUrlSyntax(data.rotationWebhookUrl);
    if (urlError) return NextResponse.json({ error: urlError }, { status: 400 });
  }

  // Cible DB de rotation des comptes liés (service base de données managée).
  if ("dbType" in body) {
    data.dbType = body.dbType === "POSTGRESQL" ? "POSTGRESQL" : body.dbType === "MYSQL" ? "MYSQL" : null;
    changed.push("dbTarget");
  }
  if ("dbHost" in body) data.dbHost = body.dbHost?.trim() || null;
  if ("dbName" in body) data.dbName = body.dbName?.trim() || null;
  if ("dbPort" in body) {
    data.dbPort =
      body.dbPort != null && Number.isFinite(Number(body.dbPort)) ? Number(body.dbPort) : null;
  }
  if ("dbUser" in body) data.dbUser = body.dbUser?.trim() || null;
  // Mot de passe admin DB : ré-encrypté seulement si fourni non vide (vide en
  // édition = inchangé, comme les autres mots de passe).
  if (typeof body.dbPassword === "string" && body.dbPassword !== "") {
    const p = encrypt(body.dbPassword);
    data.dbPwEncrypted = p.encryptedValue;
    data.dbPwIv = p.iv;
    data.dbPwTag = p.tag;
    changed.push("dbPassword");
  }

  if (typeof body.name === "string") {
    const newName = body.name.trim();
    if (!newName) {
      return NextResponse.json({ error: "Nom requis" }, { status: 400 });
    }
    if (newName !== service.name) {
      data.name = newName;
      changed.push("name");
    }
  }

  if ("url" in body) {
    const newUrl =
      body.url === null || body.url === "" ? null : body.url?.trim() ?? null;
    if (newUrl !== service.url) {
      data.url = newUrl;
      changed.push("url");
    }
  }

  // If user OR password is provided, re-encrypt the blob with both fields.
  // Existing values preserved for fields not in the body.
  if (typeof body.user === "string" || typeof body.password === "string") {
    const existing = decryptCreds(service);
    const newUser = typeof body.user === "string" ? body.user : existing.user;
    const newPassword =
      typeof body.password === "string" ? body.password : existing.password;
    const payload = encrypt(
      JSON.stringify({ user: newUser, password: newPassword }),
    );
    data.encryptedData = payload.encryptedValue;
    data.iv = payload.iv;
    data.tag = payload.tag;
    if (typeof body.user === "string") changed.push("user");
    if (typeof body.password === "string") changed.push("password");
  }

  if ("tags" in body) {
    const tags = normalizeTags(body.tags);
    if (tags === null) {
      return NextResponse.json({ error: TAG_VALIDATION_ERROR }, { status: 400 });
    }
    const sameTags =
      service.tags.length === tags.length &&
      service.tags.every((t, i) => t === tags[i]);
    if (!sameTags) {
      data.tags = tags;
      changed.push("tags");
    }
  }

  if (changed.length === 0) {
    return NextResponse.json({ ok: true, service });
  }

  const updated = await prisma.service.update({
    where: { id: service.id },
    data,
    select: { id: true, name: true, url: true, tags: true, updatedAt: true, createdAt: true },
  });

  logAction({
    action: "SERVICE_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Service",
    targetId: service.id,
    metadata: { changedFields: changed },
    req,
  });

  return NextResponse.json({ ok: true, service: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const service = await prisma.service.findFirst({
    where: { id, projectId: access.project.id },
    select: { id: true, name: true },
  });
  if (!service) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.service.delete({ where: { id: service.id } });

  logAction({
    action: "SERVICE_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Service",
    targetId: service.id,
    metadata: { name: service.name },
    req,
  });

  return NextResponse.json({ ok: true });
}
