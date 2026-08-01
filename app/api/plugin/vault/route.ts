// POST /api/plugin/vault — auto-save de credentials depuis l'extension
//
// Cree (`action: "create"`) ou met a jour (`action: "update"` + `id`) une
// VaultEntry (target=personal) ou une TeamVaultEntry (target=team_org /
// team_project), avec chiffrement AES-256-GCM et audit log.
//
// Les audit logs portent `metadata.origin = "plugin_autosave"` + `domain`
// pour distinguer ces actions des saves manuels via l'UI web. Le champ
// `metadata.source` reste celui du scope ("personal" / "org" / "project")
// — utile pour filtrer l'audit log par scope.
//
// RBAC :
//   - target=personal → toujours autorise pour le user du token
//   - target=team_org → EDITOR+ sur la collection (OrgADMIN+ implicite)
//   - target=team_project → EDITOR+ sur la collection (heritage RBAC projet)
//
// Rate limit : 30 ecritures / 60s / user (anti-abus form submit en boucle).

import { NextResponse } from "next/server";
import type { ProjectRole, Role, VaultRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";
import { encrypt } from "@/lib/crypto";
import { readJson } from "@/lib/api";
import { isPlatformAdmin } from "@/lib/roles";
import {
  extractPluginBearer,
  validatePluginToken,
} from "@/lib/plugin-token";
import {
  checkPluginOrigin,
  preflightResponse,
  withCors,
} from "@/lib/plugin-cors";
import { rateLimit } from "@/lib/rate-limit";
import { logAction } from "@/lib/audit";
import { hasVaultRole } from "@/lib/vault-access";

export const runtime = "nodejs";

const NAME_MAX = 200;
const URL_MAX = 2048;
const USERNAME_MAX = 200;
const PASSWORD_MAX = 4096;
const TAG_MAX = 50;
const TAGS_MAX = 20;

const PROJECT_TO_VAULT: Record<ProjectRole, VaultRole> = {
  VIEWER: "VIEWER",
  EDITOR: "EDITOR",
  OWNER: "OWNER",
};

export async function OPTIONS(req: Request) {
  return preflightResponse(req);
}

function safeHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeTags(input: unknown): string[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > TAGS_MAX) return null;
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") return null;
    const t = raw.trim();
    if (!t) continue;
    if (t.length > TAG_MAX) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

type Body = {
  action?: "create" | "update";
  id?: string;
  target?: "personal" | "team_org" | "team_project";
  orgSlug?: string;
  projectSlug?: string;
  collectionSlug?: string;
  name?: string;
  url?: string;
  username?: string;
  password?: string;
  tags?: unknown;
};

type Validated = {
  action: "create" | "update";
  id: string | null;
  target: "personal" | "team_org" | "team_project";
  orgSlug: string | null;
  projectSlug: string | null;
  collectionSlug: string | null;
  name: string;
  url: string | null;
  username: string | null;
  password: string;
  tags: string[];
};

function validate(
  body: Body | null,
):
  | { ok: true; v: Validated }
  | { ok: false; error: NextResponse } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: NextResponse.json({ error: "Invalid body" }, { status: 400 }),
    };
  }

  if (body.action !== "create" && body.action !== "update") {
    return {
      ok: false,
      error: NextResponse.json(
        { error: "action must be 'create' or 'update'" },
        { status: 400 },
      ),
    };
  }
  // En update l'id est requis. En create on tolere un id surnumeraire mais
  // on l'ignore (cf. decision design).
  let id: string | null = null;
  if (body.action === "update") {
    if (typeof body.id !== "string" || !body.id.trim()) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: "id is required for action=update" },
          { status: 400 },
        ),
      };
    }
    id = body.id.trim();
  }

  if (
    body.target !== "personal" &&
    body.target !== "team_org" &&
    body.target !== "team_project"
  ) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: "target must be 'personal' | 'team_org' | 'team_project'" },
        { status: 400 },
      ),
    };
  }

  let orgSlug: string | null = null;
  let projectSlug: string | null = null;
  let collectionSlug: string | null = null;
  if (body.target === "team_org") {
    if (
      typeof body.orgSlug !== "string" ||
      !body.orgSlug.trim() ||
      typeof body.collectionSlug !== "string" ||
      !body.collectionSlug.trim()
    ) {
      return {
        ok: false,
        error: NextResponse.json(
          { error: "orgSlug and collectionSlug are required for team_org" },
          { status: 400 },
        ),
      };
    }
    orgSlug = body.orgSlug.trim();
    collectionSlug = body.collectionSlug.trim();
  } else if (body.target === "team_project") {
    if (
      typeof body.projectSlug !== "string" ||
      !body.projectSlug.trim() ||
      typeof body.collectionSlug !== "string" ||
      !body.collectionSlug.trim()
    ) {
      return {
        ok: false,
        error: NextResponse.json(
          {
            error:
              "projectSlug and collectionSlug are required for team_project",
          },
          { status: 400 },
        ),
      };
    }
    projectSlug = body.projectSlug.trim();
    collectionSlug = body.collectionSlug.trim();
  }

  if (typeof body.name !== "string" || !body.name.trim()) {
    return {
      ok: false,
      error: NextResponse.json({ error: "name is required" }, { status: 400 }),
    };
  }
  const name = body.name.trim();
  if (name.length > NAME_MAX) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: `name must be 1-${NAME_MAX} chars` },
        { status: 400 },
      ),
    };
  }

  if (typeof body.password !== "string" || body.password.length === 0) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: "password is required" },
        { status: 400 },
      ),
    };
  }
  if (body.password.length > PASSWORD_MAX) {
    return {
      ok: false,
      error: NextResponse.json(
        { error: `password must be <= ${PASSWORD_MAX} chars` },
        { status: 400 },
      ),
    };
  }

  const url =
    typeof body.url === "string" && body.url.trim()
      ? body.url.trim().slice(0, URL_MAX)
      : null;
  const username =
    typeof body.username === "string" && body.username.trim()
      ? body.username.trim().slice(0, USERNAME_MAX)
      : null;

  const tags = normalizeTags(body.tags);
  if (tags === null) {
    return {
      ok: false,
      error: NextResponse.json(
        {
          error: `tags must be a string array of <= ${TAGS_MAX} entries, each <= ${TAG_MAX} chars`,
        },
        { status: 400 },
      ),
    };
  }

  return {
    ok: true,
    v: {
      action: body.action,
      id,
      target: body.target,
      orgSlug,
      projectSlug,
      collectionSlug,
      name,
      url,
      username,
      password: body.password,
      tags,
    },
  };
}

type TeamAccess = {
  collectionId: string;
  collectionName: string;
  organizationId: string | null;
  projectId: string | null;
  role: VaultRole;
  source: "org" | "project";
};

async function resolveTeamOrgAccess(
  prisma: PrismaClient,
  userId: string,
  userRole: Role,
  orgSlug: string,
  collectionSlug: string,
): Promise<TeamAccess | null> {
  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: {
      id: true,
      members: {
        where: { userId },
        select: { role: true },
      },
    },
  });
  if (!org) return null;

  const collection = await prisma.teamVaultCollection.findUnique({
    where: {
      organizationId_slug: { organizationId: org.id, slug: collectionSlug },
    },
    select: {
      id: true,
      name: true,
      organizationId: true,
      projectId: true,
      members: {
        where: { userId },
        select: { role: true },
      },
    },
  });
  if (!collection) return null;

  const orgRole = org.members[0]?.role;
  let role: VaultRole | null = null;
  if (isPlatformAdmin(userRole) || orgRole === "OWNER" || orgRole === "ADMIN") {
    role = "OWNER";
  } else {
    role = collection.members[0]?.role ?? null;
  }
  if (!role) return null;

  return {
    collectionId: collection.id,
    collectionName: collection.name,
    organizationId: org.id,
    projectId: null,
    role,
    source: "org",
  };
}

async function resolveTeamProjectAccess(
  prisma: PrismaClient,
  userId: string,
  userRole: Role,
  projectSlug: string,
  collectionSlug: string,
): Promise<TeamAccess | null> {
  const project = await prisma.project.findUnique({
    where: { slug: projectSlug },
    select: {
      id: true,
      organizationId: true,
      members: {
        where: { userId },
        select: { role: true, hidden: true },
      },
      organization: {
        select: {
          members: {
            where: { userId },
            select: { role: true },
          },
        },
      },
    },
  });
  if (!project) return null;

  const collection = await prisma.teamVaultCollection.findUnique({
    where: {
      projectId_slug: { projectId: project.id, slug: collectionSlug },
    },
    select: { id: true, name: true, organizationId: true, projectId: true },
  });
  if (!collection) return null;

  const membership = project.members[0];
  const orgRole = project.organization.members[0]?.role;
  let role: VaultRole | null = null;
  if (isPlatformAdmin(userRole) || orgRole === "OWNER" || orgRole === "ADMIN") {
    // Regle 1 : OrgADMIN/OWNER (et admin plateforme) ignorent hidden.
    role = "OWNER";
  } else if (membership && !membership.hidden) {
    // Regle 2 : une ligne masquee = 403 ailleurs → aucun acces coffre ici.
    role = PROJECT_TO_VAULT[membership.role];
  }
  if (!role) return null;

  return {
    collectionId: collection.id,
    collectionName: collection.name,
    organizationId: project.organizationId,
    projectId: project.id,
    role,
    source: "project",
  };
}

export async function POST(req: Request) {
  const cors = checkPluginOrigin(req);
  if (!cors.ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const allowOrigin = cors.allowOrigin;

  const bearer = extractPluginBearer(req);
  if (!bearer) {
    return withCors(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      allowOrigin,
    );
  }
  const session = await validatePluginToken(bearer);
  if (!session) {
    return withCors(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      allowOrigin,
    );
  }
  const limited = rateLimit(
    req,
    "plugin-vault-write",
    { max: 30, windowMs: 60_000 },
    session.userId,
  );
  if (limited) return withCors(limited, allowOrigin);

  const body = (await readJson(req)) as Body | null;
  const v = validate(body);
  if (!v.ok) return withCors(v.error, allowOrigin);
  const data = v.v;

  const enc = encrypt(data.password);
  const domain = safeHostname(data.url);

  const userId = session.userId;
  const userRole = session.user.role;
  const userEmail = session.user.email;

  // ─── Personal vault ─────────────────────────────────────────────────
  if (data.target === "personal") {
    if (data.action === "create") {
      const created = await prisma.vaultEntry.create({
        data: {
          userId,
          // L'autosave navigateur ne produit que des credentials de site.
          // Explicite plutôt que de dépendre du DEFAULT de la colonne.
          type: "LOGIN",
          name: data.name,
          url: data.url,
          username: data.username,
          encryptedPassword: enc.encryptedValue,
          passwordIv: enc.iv,
          passwordTag: enc.tag,
          tags: data.tags,
        },
        select: { id: true },
      });
      logAction({
        action: "VAULT_ENTRY_CREATE",
        actor: { kind: "user", userId, email: userEmail },
        targetType: "VaultEntry",
        targetId: created.id,
        metadata: {
          source: "personal",
          origin: "plugin_autosave",
          domain,
          hasPassword: true,
          tagsCount: data.tags.length,
        },
        req,
      });
      return withCors(
        NextResponse.json({ id: created.id, created: true }, { status: 201 }),
        allowOrigin,
      );
    }

    // update — verifie la propriete ET le type. Sans le filtre `type`,
    // l'autosave ecraserait une NOTE ou une LIST avec des champs de login :
    // l'entree garderait son type mais gagnerait une URL et un mot de passe,
    // et son blob chiffre deviendrait orphelin. Une entree non-LOGIN est
    // invisible pour l'extension (404), c'est volontaire.
    const existing = await prisma.vaultEntry.findFirst({
      where: { id: data.id!, userId, type: "LOGIN" },
      select: { id: true },
    });
    if (!existing) {
      return withCors(
        NextResponse.json({ error: "Not found" }, { status: 404 }),
        allowOrigin,
      );
    }
    await prisma.vaultEntry.update({
      where: { id: existing.id },
      data: {
        name: data.name,
        url: data.url,
        username: data.username,
        encryptedPassword: enc.encryptedValue,
        passwordIv: enc.iv,
        passwordTag: enc.tag,
        tags: data.tags,
      },
    });
    logAction({
      action: "VAULT_ENTRY_UPDATE",
      actor: { kind: "user", userId, email: userEmail },
      targetType: "VaultEntry",
      targetId: existing.id,
      metadata: {
        source: "personal",
        origin: "plugin_autosave",
        domain,
        changedFields: ["name", "url", "username", "password", "tags"],
      },
      req,
    });
    return withCors(
      NextResponse.json({ id: existing.id, created: false }),
      allowOrigin,
    );
  }

  // ─── Team vault (org or project) ────────────────────────────────────
  const access =
    data.target === "team_org"
      ? await resolveTeamOrgAccess(
          prisma,
          userId,
          userRole,
          data.orgSlug!,
          data.collectionSlug!,
        )
      : await resolveTeamProjectAccess(
          prisma,
          userId,
          userRole,
          data.projectSlug!,
          data.collectionSlug!,
        );
  if (!access) {
    // 404 plutot que 403 pour ne pas leaker l'existence (cf. vault-access.ts).
    return withCors(
      NextResponse.json({ error: "Not found" }, { status: 404 }),
      allowOrigin,
    );
  }
  if (!hasVaultRole(access.role, "EDITOR")) {
    return withCors(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      allowOrigin,
    );
  }

  if (data.action === "create") {
    const created = await prisma.teamVaultEntry.create({
      data: {
        collectionId: access.collectionId,
        name: data.name,
        url: data.url,
        username: data.username,
        encryptedPassword: enc.encryptedValue,
        passwordIv: enc.iv,
        passwordTag: enc.tag,
        tags: data.tags,
      },
      select: { id: true },
    });
    logAction({
      action: "VAULT_ENTRY_CREATE",
      actor: { kind: "user", userId, email: userEmail },
      organizationId: access.organizationId,
      projectId: access.projectId,
      targetType: "TeamVaultEntry",
      targetId: created.id,
      metadata: {
        source: access.source,
        origin: "plugin_autosave",
        domain,
        collectionId: access.collectionId,
        collectionName: access.collectionName,
        hasPassword: true,
        tagsCount: data.tags.length,
      },
      req,
    });
    return withCors(
      NextResponse.json({ id: created.id, created: true }, { status: 201 }),
      allowOrigin,
    );
  }

  // update team — verifie que l'entry appartient bien a la collection
  const existing = await prisma.teamVaultEntry.findFirst({
    where: { id: data.id!, collectionId: access.collectionId },
    select: { id: true },
  });
  if (!existing) {
    return withCors(
      NextResponse.json({ error: "Not found" }, { status: 404 }),
      allowOrigin,
    );
  }
  await prisma.teamVaultEntry.update({
    where: { id: existing.id },
    data: {
      name: data.name,
      url: data.url,
      username: data.username,
      encryptedPassword: enc.encryptedValue,
      passwordIv: enc.iv,
      passwordTag: enc.tag,
      tags: data.tags,
    },
  });
  logAction({
    action: "VAULT_ENTRY_UPDATE",
    actor: { kind: "user", userId, email: userEmail },
    organizationId: access.organizationId,
    projectId: access.projectId,
    targetType: "TeamVaultEntry",
    targetId: existing.id,
    metadata: {
      source: access.source,
      origin: "plugin_autosave",
      domain,
      collectionId: access.collectionId,
      changedFields: ["name", "url", "username", "password", "tags"],
    },
    req,
  });
  return withCors(
    NextResponse.json({ id: existing.id, created: false }),
    allowOrigin,
  );
}
