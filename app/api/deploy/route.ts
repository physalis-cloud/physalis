// POST /api/deploy
//
// Endpoint appele par les workflows GitHub Actions avec un token OIDC en
// Authorization: Bearer. Le token est verifie contre le JWKS GitHub, puis
// les claims sont compares aux Policy en DB. Si une policy match et que
// l'environnement cible a un serveur configure, retourne le bundle de
// deploiement (secrets + creds SSH + path).
//
// Securite :
//   - Aucune session NextAuth ; pas de cookie. Auth = JWT GitHub uniquement.
//   - Rate-limit IP : 30 req / min (les workflows tournent rarement, et la
//     verification JWKS coute ~10ms — ce plafond protege contre les bursts
//     accidentels sans gener un usage normal).
//   - Validation stricte : repo + workflow + branch + project + env doivent
//     tous matcher une Policy unique. Pas de wildcard.
//   - Audit `DEPLOY_AUTHORIZED` / `DEPLOY_DENIED` sur tous les chemins.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { extractBearer, verifyGithubOidcToken } from "@/lib/oidc";
import { defaultDeployPath, readJson } from "@/lib/api";
import { isValidDeployPath } from "@/lib/validation";

// Force Node runtime : jose, node:crypto, prisma — pas Edge.
export const runtime = "nodejs";

const RATE_LIMIT = { max: 30, windowMs: 60_000 };

export async function POST(req: Request) {
  const limited = rateLimit(req, "deploy", RATE_LIMIT);
  if (limited) return limited;

  const token = extractBearer(req);

  const verified = await verifyGithubOidcToken(token);
  if (!verified.ok) {
    if (
      verified.reason === "missing_token" ||
      verified.reason === "wrong_audience" ||
      verified.reason === "wrong_issuer"
    ) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }
    logAction({
      action: "DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      metadata: { reason: verified.reason },
      req,
    });
    if (verified.reason === "expired") {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { repository, workflowFile, branch } = verified.claims;

  const body = (await readJson(req)) as
    | { project?: string; environment?: string }
    | null;
  const projectSlug = String(body?.project ?? "").trim();
  const envName = String(body?.environment ?? "").trim().toLowerCase();
  if (!projectSlug || !envName) {
    logAction({
      action: "DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      metadata: {
        reason: "missing_body",
        repository,
        workflow: workflowFile,
        branch,
      },
      req,
    });
    return NextResponse.json(
      { error: "project and environment are required in body" },
      { status: 400 },
    );
  }

  // Lookup policy par claims OIDC (repo, workflow, branch) + project slug + env name.
  const project = await prisma.project.findUnique({
    where: { slug: projectSlug },
    select: { id: true, slug: true, organizationId: true },
  });

  if (!project) {
    logAction({
      action: "DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      metadata: {
        reason: "policy_not_found",
        repository,
        workflow: workflowFile,
        branch,
        project: projectSlug,
        environment: envName,
      },
      req,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const environment = await prisma.environment.findUnique({
    where: { projectId_name: { projectId: project.id, name: envName } },
    select: {
      id: true,
      name: true,
      deployPath: true,
      dockerCompose: true,
      server: {
        select: {
          id: true,
          name: true,
          ip: true,
          sshUser: true,
          encryptedKey: true,
          iv: true,
          tag: true,
        },
      },
      secrets: {
        select: { key: true, encryptedValue: true, iv: true, tag: true },
      },
    },
  });

  if (!environment) {
    logAction({
      action: "DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      metadata: {
        reason: "policy_not_found",
        repository,
        workflow: workflowFile,
        branch,
        project: projectSlug,
        environment: envName,
      },
      req,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Vérifie qu'une Policy match les claims OIDC.
  const policy = await prisma.policy.findFirst({
    where: {
      repo: repository,
      workflow: workflowFile,
      branch,
      projectId: project.id,
      environmentId: environment.id,
    },
    select: { id: true },
  });

  if (!policy) {
    logAction({
      action: "DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      metadata: {
        reason: "policy_match_failed",
        repository,
        workflow: workflowFile,
        branch,
        project: projectSlug,
        environment: envName,
      },
      req,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!environment.server) {
    logAction({
      action: "DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      targetType: "Policy",
      targetId: policy.id,
      metadata: {
        reason: "no_server",
        repository,
        workflow: workflowFile,
        branch,
        project: projectSlug,
        environment: envName,
      },
      req,
    });
    return NextResponse.json(
      { error: "Environment is not bound to a server" },
      { status: 422 },
    );
  }

  // Si l'env n'a pas de deployPath explicite, on applique la convention
  // /srv/projets/<env>/<slug>. La valeur explicite reste prioritaire si
  // l'admin a saisi un chemin custom dans les settings.
  const deployPath =
    environment.deployPath ?? defaultDeployPath(environment.name, project.slug);
  const usedDefaultDeployPath = environment.deployPath === null;

  // Defense en profondeur : la validation a l'ecriture (POST/PATCH env) ne
  // desamorce pas une valeur stockee AVANT sa mise en place. Ce chemin part
  // verbatim dans une commande shell sur le VPS du client — on refuse plutot
  // que de retomber silencieusement sur la convention (deployer ailleurs que
  // prevu serait pire qu'un echec bruyant).
  if (!isValidDeployPath(deployPath)) {
    logAction({
      action: "DEPLOY_DENIED",
      actor: { kind: "anonymous" },
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      metadata: {
        reason: "invalid_deploy_path",
        repository,
        workflow: workflowFile,
        branch,
        project: projectSlug,
        environment: envName,
      },
      req,
    });
    return NextResponse.json(
      {
        error:
          "Invalid deployPath stored for this environment — fix it in the project settings (absolute path, [A-Za-z0-9._/-] only, no '..' or '//')",
      },
      { status: 422 },
    );
  }

  // Tout est valide : on déchiffre.
  const sshKey = decrypt({
    encryptedValue: environment.server.encryptedKey,
    iv: environment.server.iv,
    tag: environment.server.tag,
  });
  const secrets: Record<string, string> = {};
  for (const s of environment.secrets) {
    secrets[s.key] = decrypt({
      encryptedValue: s.encryptedValue,
      iv: s.iv,
      tag: s.tag,
    });
  }

  // Registry credentials : convention sur 3 OrgSecrets reservés
  // (REGISTRY_PAT + REGISTRY_USER obligatoires, REGISTRY_URL optionnel
  // avec defaut ghcr.io).
  const registry = await resolveRegistry(project.organizationId);

  logAction({
    action: "DEPLOY_AUTHORIZED",
    actor: { kind: "anonymous" },
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    targetType: "Policy",
    targetId: policy.id,
    metadata: {
      repository,
      workflow: workflowFile,
      branch,
      project: projectSlug,
      environment: envName,
      serverId: environment.server.id,
      serverName: environment.server.name,
      secretsCount: environment.secrets.length,
      hasDockerCompose: environment.dockerCompose !== null,
      hasRegistry: registry !== null,
      usedDefaultDeployPath,
    },
    req,
  });

  return NextResponse.json({
    project: project.slug,
    environment: environment.name,
    serverIp: environment.server.ip,
    serverUser: environment.server.sshUser,
    sshKey,
    deployPath,
    secrets,
    dockerCompose: environment.dockerCompose,
    registry,
  });
}

const REGISTRY_PAT_KEY = "REGISTRY_PAT";
const REGISTRY_USER_KEY = "REGISTRY_USER";
const REGISTRY_URL_KEY = "REGISTRY_URL";
const DEFAULT_REGISTRY_URL = "ghcr.io";

async function resolveRegistry(
  organizationId: string,
): Promise<{ url: string; user: string; pat: string } | null> {
  const orgSecrets = await prisma.orgSecret.findMany({
    where: {
      organizationId,
      key: { in: [REGISTRY_PAT_KEY, REGISTRY_USER_KEY, REGISTRY_URL_KEY] },
    },
    select: { key: true, encryptedValue: true, iv: true, tag: true },
  });

  const byKey = new Map(orgSecrets.map((s) => [s.key, s]));
  const patRow = byKey.get(REGISTRY_PAT_KEY);
  const userRow = byKey.get(REGISTRY_USER_KEY);
  if (!patRow || !userRow) return null;

  const pat = decrypt({
    encryptedValue: patRow.encryptedValue,
    iv: patRow.iv,
    tag: patRow.tag,
  });
  const user = decrypt({
    encryptedValue: userRow.encryptedValue,
    iv: userRow.iv,
    tag: userRow.tag,
  });
  const urlRow = byKey.get(REGISTRY_URL_KEY);
  const url = urlRow
    ? decrypt({
        encryptedValue: urlRow.encryptedValue,
        iv: urlRow.iv,
        tag: urlRow.tag,
      })
    : DEFAULT_REGISTRY_URL;

  return { url, user, pat };
}
