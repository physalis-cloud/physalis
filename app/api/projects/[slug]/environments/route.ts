import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isValidDeployPath,
  isValidEnvName,
  readJson,
  requireProjectMember,
} from "@/lib/api";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string }> };

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | { name?: string; url?: string; serverId?: string | null; deployPath?: string | null }
    | null;
  const name = String(body?.name ?? "").trim().toLowerCase();
  if (!isValidEnvName(name)) {
    return NextResponse.json(
      {
        error:
          "Nom d'environnement invalide (doit matcher [a-z][a-z0-9-]{0,30})",
      },
      { status: 400 },
    );
  }

  const existing = await prisma.environment.findUnique({
    where: { projectId_name: { projectId: access.project.id, name } },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Un environnement avec ce nom existe déjà" },
      { status: 409 },
    );
  }

  const url = typeof body?.url === "string" ? body.url.trim() : "";

  // Server doit appartenir à la même organisation que le projet (sinon
  // n'importe quel admin pourrait piocher la clé SSH d'une autre org).
  let serverId: string | null = null;
  if (body && typeof body.serverId === "string" && body.serverId !== "") {
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
    serverId = server.id;
  }

  // deployPath atterrit dans une commande shell distante au deploy :
  // valide (jeu de caracteres ferme) avant stockage. Cf. isValidDeployPath.
  const deployPath =
    typeof body?.deployPath === "string" && body.deployPath.trim() !== ""
      ? body.deployPath.trim()
      : null;
  if (deployPath !== null && !isValidDeployPath(deployPath)) {
    return NextResponse.json(
      {
        error:
          "Chemin de déploiement invalide : chemin absolu, caractères [A-Za-z0-9._/-] uniquement, sans « .. » ni « // » (ex. /srv/projets/production/mon-app)",
      },
      { status: 400 },
    );
  }

  // Un environnement neuf se range à la fin de l'ordre choisi (cf. PATCH).
  const last = await prisma.environment.findFirst({
    where: { projectId: access.project.id },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const env = await prisma.environment.create({
    data: {
      name,
      projectId: access.project.id,
      position: (last?.position ?? -1) + 1,
      url: url || null,
      serverId,
      deployPath,
    },
    select: {
      id: true,
      name: true,
      url: true,
      serverId: true,
      deployPath: true,
    },
  });

  logAction({
    action: "ENVIRONMENT_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: env.id,
    targetType: "Environment",
    targetId: env.id,
    metadata: {
      name,
      url: env.url,
      serverId: env.serverId,
      deployPath: env.deployPath,
    },
    req,
  });

  return NextResponse.json({ environment: env }, { status: 201 });
}

// PATCH /api/projects/[slug]/environments — persiste l'ordre choisi par
// glisser-déposer dans les paramètres du projet. Body : { order: string[] }
// (ids d'environnement, dans l'ordre voulu).
//
// Sur la collection plutôt qu'une route `/environments/reorder` : celle-ci
// masquerait un environnement nommé `reorder` (nom valide) pour [name].
//
// Pas de transaction : l'ordre est purement visuel, et `withTenantSchema`
// refuse le tenantSlug null du self-host. Un échec en cours de route laisse au
// pire un ordre partiel, que le client réconcilie par un refresh.
export async function PATCH(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as { order?: unknown } | null;
  const order = body?.order;
  if (
    !Array.isArray(order) ||
    order.length === 0 ||
    order.length > 200 ||
    !order.every((id): id is string => typeof id === "string") ||
    new Set(order).size !== order.length
  ) {
    return NextResponse.json({ error: "Ordre invalide" }, { status: 400 });
  }

  // `projectId` dans chaque where : un id d'un autre projet est ignoré.
  for (const [i, id] of order.entries()) {
    await prisma.environment.updateMany({
      where: { id, projectId: access.project.id },
      data: { position: i },
    });
  }

  return NextResponse.json({ ok: true });
}
