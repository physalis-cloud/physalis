import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { readJson, requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { normalizeTags, TAG_VALIDATION_ERROR } from "@/lib/tags";
import { validateHookUrlSyntax } from "@/lib/safe-fetch";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug);
  if ("error" in access) return access.error;

  const services = await prisma.service.findMany({
    where: { projectId: access.project.id },
    select: {
      id: true, name: true, url: true, tags: true, updatedAt: true, createdAt: true,
      // Hook de rotation des comptes (service backend). Le token n'est pas exposé ici.
      rotationWebhookUrl: true,
      rotationExecMode: true,
      // Cible DB de rotation des comptes (service base de données managée).
      // dbUser exposé (prefill éditeur) ; le mot de passe DB ne l'est pas.
      dbType: true,
      dbHost: true,
      dbPort: true,
      dbName: true,
      dbUser: true,
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ services });
}

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | {
        name?: string; url?: string; user?: string; password?: string; tags?: string[];
        rotationWebhookUrl?: string | null; rotationHookToken?: string | null; rotationExecMode?: string | null;
        dbType?: string | null; dbHost?: string | null; dbPort?: number | null; dbName?: string | null;
        dbUser?: string | null; dbPassword?: string | null;
      }
    | null;
  const name = String(body?.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Nom requis" }, { status: 400 });
  }
  const user = String(body?.user ?? "");
  const password = String(body?.password ?? "");
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const tags = normalizeTags(body?.tags);
  if (tags === null) {
    return NextResponse.json({ error: TAG_VALIDATION_ERROR }, { status: 400 });
  }
  const hookUrl = typeof body?.rotationWebhookUrl === "string" ? body.rotationWebhookUrl.trim() || null : null;
  const hookToken = typeof body?.rotationHookToken === "string" ? body.rotationHookToken.trim() || null : null;
  const execMode = body?.rotationExecMode === "DIRECT" ? "DIRECT" : body?.rotationExecMode === "AGENT" ? "AGENT" : null;
  // Hook DIRECT = le serveur central fetch cette URL → refus des cibles internes
  // (garde SSRF, cf. documentation/rapports/failles.md §6). AGENT = hook local, non concerné.
  if (hookUrl && execMode === "DIRECT") {
    const urlError = validateHookUrlSyntax(hookUrl);
    if (urlError) return NextResponse.json({ error: urlError }, { status: 400 });
  }
  const dbType = body?.dbType === "POSTGRESQL" ? "POSTGRESQL" : body?.dbType === "MYSQL" ? "MYSQL" : null;
  const dbHost = typeof body?.dbHost === "string" ? body.dbHost.trim() || null : null;
  const dbName = typeof body?.dbName === "string" ? body.dbName.trim() || null : null;
  const dbPort =
    body?.dbPort != null && Number.isFinite(Number(body.dbPort)) ? Number(body.dbPort) : null;
  const dbUser = typeof body?.dbUser === "string" ? body.dbUser.trim() || null : null;
  // Mot de passe admin DB dédié (distinct des creds dashboard) → chiffré.
  const dbPw =
    typeof body?.dbPassword === "string" && body.dbPassword !== ""
      ? encrypt(body.dbPassword)
      : null;

  const payload = encrypt(JSON.stringify({ user, password }));

  const service = await prisma.service.create({
    data: {
      name,
      url: url || null,
      encryptedData: payload.encryptedValue,
      iv: payload.iv,
      tag: payload.tag,
      tags,
      projectId: access.project.id,
      rotationWebhookUrl: hookUrl,
      rotationHookToken: hookToken,
      rotationExecMode: execMode,
      dbType,
      dbHost,
      dbPort,
      dbName,
      dbUser,
      dbPwEncrypted: dbPw?.encryptedValue ?? null,
      dbPwIv: dbPw?.iv ?? null,
      dbPwTag: dbPw?.tag ?? null,
    },
    select: { id: true, name: true, url: true, tags: true, createdAt: true, updatedAt: true },
  });

  logAction({
    action: "SERVICE_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Service",
    targetId: service.id,
    metadata: { name, hasUrl: Boolean(url) },
    req,
  });

  return NextResponse.json({ service }, { status: 201 });
}
