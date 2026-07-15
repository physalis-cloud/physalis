import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { readJson, requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { normalizeTags, TAG_VALIDATION_ERROR } from "@/lib/tags";
import { resolveAccountLink, accountLinkView } from "@/lib/account-link";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug);
  if ("error" in access) return access.error;

  const rows = await prisma.appAccount.findMany({
    where: { projectId: access.project.id },
    select: {
      id: true,
      name: true,
      tags: true,
      updatedAt: true,
      createdAt: true,
      environmentId: true,
      serviceId: true,
      environment: { select: { name: true, url: true } },
      service: { select: { name: true, url: true } },
    },
    orderBy: { name: "asc" },
  });

  const accounts = rows.map(({ environment, service, ...a }) => ({
    ...a,
    ...accountLinkView({ environment, service }),
  }));

  return NextResponse.json({ accounts });
}

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | { name?: string; user?: string; password?: string; tags?: string[]; environmentId?: string | null; serviceId?: string | null }
    | null;
  const name = String(body?.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Nom requis" }, { status: 400 });
  }
  const user = String(body?.user ?? "");
  const password = String(body?.password ?? "");
  const tags = normalizeTags(body?.tags);
  if (tags === null) {
    return NextResponse.json({ error: TAG_VALIDATION_ERROR }, { status: 400 });
  }
  const link = await resolveAccountLink(access.project.id, body ?? {});
  if ("error" in link) return NextResponse.json({ error: link.error }, { status: 400 });

  const payload = encrypt(JSON.stringify({ user, password }));

  const account = await prisma.appAccount.create({
    data: {
      name,
      encryptedData: payload.encryptedValue,
      iv: payload.iv,
      tag: payload.tag,
      tags,
      projectId: access.project.id,
      environmentId: link.environmentId,
      serviceId: link.serviceId,
    },
    select: { id: true, name: true, tags: true, createdAt: true, updatedAt: true },
  });

  logAction({
    action: "ACCOUNT_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "AppAccount",
    targetId: account.id,
    metadata: { name },
    req,
  });

  return NextResponse.json({ account }, { status: 201 });
}
