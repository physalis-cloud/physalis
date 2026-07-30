import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isValidDeployPath,
  isValidEnvName,
  readJson,
  requireProjectMember,
} from "@/lib/api";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; name: string }> };

/**
 * Update an environment. Body fields are all optional :
 *   { name?: string, url?: string | null, dockerCompose?: string | null }
 *
 * EDITOR+ requis (y compris pour le rename). Le rename peut casser des
 * deploy scripts qui utilisent l'ancien nom dans l'URL Bearer endpoint —
 * c'est au DEV/EDITOR qui rename de mettre a jour les references
 * externes (cf. politique RBAC settings projet : tout est ouvert a
 * EDITOR+, seul le DELETE projet reste OWNER).
 */
export async function PATCH(req: Request, { params }: Params) {
  const { slug, name } = await params;

  const body = (await readJson(req)) as
    | {
        name?: string;
        url?: string | null;
        dockerCompose?: string | null;
        serverId?: string | null;
        deployPath?: string | null;
      }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const newName =
    typeof body.name === "string" ? body.name.trim().toLowerCase() : undefined;
  const isRename = newName !== undefined && newName !== name;

  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const env = await prisma.environment.findUnique({
    where: { projectId_name: { projectId: access.project.id, name } },
  });
  if (!env) {
    return NextResponse.json({ error: "Environment not found" }, { status: 404 });
  }

  const data: {
    name?: string;
    url?: string | null;
    dockerCompose?: string | null;
    serverId?: string | null;
    deployPath?: string | null;
  } = {};

  if (isRename) {
    if (!isValidEnvName(newName)) {
      return NextResponse.json(
        { error: "Nom d'environnement invalide" },
        { status: 400 },
      );
    }
    const conflict = await prisma.environment.findUnique({
      where: { projectId_name: { projectId: access.project.id, name: newName } },
    });
    if (conflict) {
      return NextResponse.json(
        { error: "Un environnement avec ce nom existe déjà" },
        { status: 409 },
      );
    }
    data.name = newName;
  }

  if ("url" in body) {
    if (body.url === null || body.url === "") {
      data.url = null;
    } else if (typeof body.url === "string") {
      data.url = body.url.trim();
    }
  }

  if ("dockerCompose" in body) {
    if (body.dockerCompose === null || body.dockerCompose === "") {
      data.dockerCompose = null;
    } else if (typeof body.dockerCompose === "string") {
      data.dockerCompose = body.dockerCompose;
    }
  }

  if ("serverId" in body) {
    if (body.serverId === null || body.serverId === "") {
      data.serverId = null;
    } else if (typeof body.serverId === "string") {
      // Le serveur doit appartenir a la meme org que le projet.
      const server = await prisma.server.findFirst({
        where: {
          id: body.serverId,
          organizationId: access.project.organizationId,
        },
        select: { id: true },
      });
      if (!server) {
        return NextResponse.json(
          { error: "Serveur introuvable dans cette organisation" },
          { status: 400 },
        );
      }
      data.serverId = server.id;
    }
  }

  if ("deployPath" in body) {
    if (
      body.deployPath === null ||
      (typeof body.deployPath === "string" && body.deployPath.trim() === "")
    ) {
      data.deployPath = null;
    } else if (typeof body.deployPath === "string") {
      // deployPath atterrit dans une commande shell distante au deploy :
      // valide (jeu de caracteres ferme) avant stockage. Cf. isValidDeployPath.
      const candidate = body.deployPath.trim();
      if (!isValidDeployPath(candidate)) {
        return NextResponse.json(
          {
            error:
              "Chemin de déploiement invalide : chemin absolu, caractères [A-Za-z0-9._/-] uniquement, sans « .. » ni « // » (ex. /srv/projets/production/mon-app)",
          },
          { status: 400 },
        );
      }
      data.deployPath = candidate;
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: true, environment: env });
  }

  const updated = await prisma.environment.update({
    where: { id: env.id },
    data,
    select: {
      id: true,
      name: true,
      url: true,
      dockerCompose: true,
      serverId: true,
      deployPath: true,
    },
  });

  logAction({
    action: "ENVIRONMENT_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: env.id,
    targetType: "Environment",
    targetId: env.id,
    metadata: {
      changedFields: Object.keys(data),
      ...(isRename ? { fromName: name, toName: newName } : {}),
    },
    req,
  });

  return NextResponse.json({ ok: true, environment: updated });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug, name } = await params;
  const access = await requireProjectMember(slug, "OWNER");
  if ("error" in access) return access.error;

  const env = await prisma.environment.findUnique({
    where: { projectId_name: { projectId: access.project.id, name } },
    select: {
      id: true,
      name: true,
      _count: { select: { secrets: true, tokens: true } },
    },
  });
  if (!env) {
    return NextResponse.json({ error: "Environment not found" }, { status: 404 });
  }

  await prisma.environment.delete({ where: { id: env.id } });

  logAction({
    action: "ENVIRONMENT_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "Environment",
    targetId: env.id,
    metadata: {
      name: env.name,
      cascadedSecrets: env._count.secrets,
      cascadedTokens: env._count.tokens,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}

/**
 * Read a single environment with its dockerCompose content.
 * Used by the docker-compose tab in the UI.
 */
export async function GET(_req: Request, { params }: Params) {
  const { slug, name } = await params;
  const access = await requireProjectMember(slug);
  if ("error" in access) return access.error;

  const env = await prisma.environment.findUnique({
    where: { projectId_name: { projectId: access.project.id, name } },
    select: {
      id: true,
      name: true,
      url: true,
      dockerCompose: true,
      serverId: true,
      deployPath: true,
    },
  });
  if (!env) {
    return NextResponse.json({ error: "Environment not found" }, { status: 404 });
  }
  return NextResponse.json({ environment: env });
}
