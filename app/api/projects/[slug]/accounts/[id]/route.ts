import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import { readJson, requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { normalizeTags, TAG_VALIDATION_ERROR } from "@/lib/tags";
import { resolveAccountLink, accountLinkView } from "@/lib/account-link";

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

export async function GET(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug);
  if ("error" in access) return access.error;

  const account = await prisma.appAccount.findFirst({
    where: { id, projectId: access.project.id },
    include: {
      environment: { select: { name: true, url: true } },
      service: { select: { name: true, url: true } },
    },
  });
  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const creds = decryptCreds(account);

  logAction({
    action: "ACCOUNT_REVEAL",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "AppAccount",
    targetId: account.id,
    metadata: { name: account.name },
    req,
  });

  return NextResponse.json({
    account: {
      id: account.id,
      name: account.name,
      user: creds.user,
      password: creds.password,
      environmentId: account.environmentId,
      serviceId: account.serviceId,
      ...accountLinkView(account),
    },
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const account = await prisma.appAccount.findFirst({
    where: { id, projectId: access.project.id },
  });
  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await readJson(req)) as
    | { name?: string; user?: string; password?: string; tags?: string[]; environmentId?: string | null; serviceId?: string | null }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const data: {
    name?: string;
    encryptedData?: string;
    iv?: string;
    tag?: string;
    tags?: string[];
    environmentId?: string | null;
    serviceId?: string | null;
  } = {};
  const changed: string[] = [];

  if ("environmentId" in body || "serviceId" in body) {
    const link = await resolveAccountLink(access.project.id, body);
    if ("error" in link) return NextResponse.json({ error: link.error }, { status: 400 });
    data.environmentId = link.environmentId;
    data.serviceId = link.serviceId;
    changed.push("link");
  }

  if (typeof body.name === "string") {
    const newName = body.name.trim();
    if (!newName) {
      return NextResponse.json({ error: "Nom requis" }, { status: 400 });
    }
    if (newName !== account.name) {
      data.name = newName;
      changed.push("name");
    }
  }

  if (typeof body.user === "string" || typeof body.password === "string") {
    const existing = decryptCreds(account);
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
      account.tags.length === tags.length &&
      account.tags.every((t, i) => t === tags[i]);
    if (!sameTags) {
      data.tags = tags;
      changed.push("tags");
    }
  }

  if (changed.length === 0) {
    return NextResponse.json({ ok: true, account });
  }

  const updated = await prisma.appAccount.update({
    where: { id: account.id },
    data,
    select: { id: true, name: true, tags: true, updatedAt: true, createdAt: true },
  });

  logAction({
    action: "ACCOUNT_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "AppAccount",
    targetId: account.id,
    metadata: { changedFields: changed },
    req,
  });

  return NextResponse.json({ ok: true, account: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const account = await prisma.appAccount.findFirst({
    where: { id, projectId: access.project.id },
    select: { id: true, name: true },
  });
  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.appAccount.delete({ where: { id: account.id } });

  logAction({
    action: "ACCOUNT_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "AppAccount",
    targetId: account.id,
    metadata: { name: account.name },
    req,
  });

  return NextResponse.json({ ok: true });
}
