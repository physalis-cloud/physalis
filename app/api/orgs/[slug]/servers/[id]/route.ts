import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isValidServerHost,
  isValidServerName,
  isValidSshUser,
  readJson,
  requireOrgMember,
} from "@/lib/api";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; id: string }> };

/**
 * GET un serveur (sans la cle privee, qui n'est jamais relue apres creation).
 * Retourne aussi la liste des environnements lies, pour donner du contexte
 * a l'admin avant suppression / edition.
 */
export async function GET(_req: Request, { params }: Params) {
  const { slug, id } = await params;
  // DEV+ peut voir les détails d'un serveur (la clé SSH n'est jamais relisible
  // par design, donc inoffensif).
  const access = await requireOrgMember(slug, "DEV");
  if ("error" in access) return access.error;

  const server = await prisma.server.findFirst({
    where: { id, organizationId: access.organization.id },
    select: {
      id: true,
      name: true,
      ip: true,
      sshUser: true,
      createdAt: true,
      updatedAt: true,
      environments: {
        select: {
          id: true,
          name: true,
          deployPath: true,
          project: { select: { name: true, slug: true } },
        },
        orderBy: { project: { name: "asc" } },
      },
    },
  });
  if (!server) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ server });
}

/**
 * PATCH : seuls name / ip / sshUser sont modifiables. La cle SSH privee
 * n'est jamais re-editable (recreer un serveur si rotation). Cela force
 * un audit clair en cas de rotation.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireOrgMember(slug, "ADMIN_DEV", { feature: "server_management" });
  if ("error" in access) return access.error;

  const existing = await prisma.server.findFirst({
    where: { id, organizationId: access.organization.id },
    select: { id: true, name: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await readJson(req)) as
    | { name?: string; ip?: string; sshUser?: string }
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const data: { name?: string; ip?: string; sshUser?: string } = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!isValidServerName(name)) {
      return NextResponse.json({ error: "Nom invalide" }, { status: 400 });
    }
    if (name !== existing.name) {
      const conflict = await prisma.server.findUnique({
        where: {
          organizationId_name: { organizationId: access.organization.id, name },
        },
        select: { id: true },
      });
      if (conflict && conflict.id !== existing.id) {
        return NextResponse.json(
          { error: "Un serveur avec ce nom existe déjà dans l'organisation" },
          { status: 409 },
        );
      }
      data.name = name;
    }
  }

  if (typeof body.ip === "string") {
    const ip = body.ip.trim();
    if (!isValidServerHost(ip)) {
      return NextResponse.json(
        { error: "IP/hostname invalide" },
        { status: 400 },
      );
    }
    data.ip = ip;
  }

  if (typeof body.sshUser === "string") {
    const sshUser = body.sshUser.trim();
    if (!isValidSshUser(sshUser)) {
      return NextResponse.json(
        { error: "Utilisateur SSH invalide" },
        { status: 400 },
      );
    }
    data.sshUser = sshUser;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const updated = await prisma.server.update({
    where: { id: existing.id },
    data,
    select: {
      id: true,
      name: true,
      ip: true,
      sshUser: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  logAction({
    action: "SERVER_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "Server",
    targetId: updated.id,
    metadata: { changedFields: Object.keys(data) },
    req,
  });

  return NextResponse.json({ server: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireOrgMember(slug, "ADMIN_DEV");
  if ("error" in access) return access.error;

  const existing = await prisma.server.findFirst({
    where: { id, organizationId: access.organization.id },
    select: {
      id: true,
      name: true,
      _count: { select: { environments: true } },
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.server.delete({ where: { id: existing.id } });

  logAction({
    action: "SERVER_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "Server",
    targetId: existing.id,
    metadata: {
      name: existing.name,
      detachedEnvironments: existing._count.environments,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}
