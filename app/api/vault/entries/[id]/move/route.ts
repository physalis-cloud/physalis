// POST /api/vault/entries/[id]/move
//
// Deplace une entree du coffre personnel vers une collection d'equipe (org
// ou projet). Operation transactionnelle :
//   1. Lecture de la VaultEntry source (proprietaire = req.user)
//   2. Resolution de l'acces a la collection cible (EDITOR+ requis)
//   3. Creation de la TeamVaultEntry avec re-encrypt du password
//   4. Suppression de la VaultEntry source
//   5. Audit log VAULT_ENTRY_MOVE avec from/to
//
// La cle de chiffrement est la meme (ENCRYPTION_KEY env), mais on
// re-encrypt avec un nouvel IV pour eviter de partager des bytes
// chiffres entre les deux tables (defense en profondeur).
//
// Le sens est unilateral : perso → equipe seulement. Le reverse
// (equipe → perso) ouvre des questions UX (faux sens de propriete sur
// un secret deja partage) — pas implemente en V1.

import { NextResponse } from "next/server";
import type { Role, VaultRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encrypt, decrypt } from "@/lib/crypto";
import { readJson, requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { hasVaultRole } from "@/lib/vault-access";
import { isPlatformAdmin, hasDevPrivileges } from "@/lib/roles";

type Params = { params: Promise<{ id: string }> };

const PROJECT_TO_VAULT = {
  VIEWER: "VIEWER" as VaultRole,
  EDITOR: "EDITOR" as VaultRole,
  OWNER: "OWNER" as VaultRole,
};

const VAULT_RANK: Record<VaultRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

function maxVaultRole(
  a: VaultRole | null,
  b: VaultRole | null,
): VaultRole | null {
  if (!a) return b;
  if (!b) return a;
  return VAULT_RANK[a] >= VAULT_RANK[b] ? a : b;
}

type MoveBody = {
  target?: "team_org" | "team_project" | "project_account";
  orgSlug?: string;
  projectSlug?: string;
  collectionSlug?: string;
};

type ResolvedTarget = {
  collectionId: string;
  collectionName: string;
  organizationId: string | null;
  projectId: string | null;
  source: "org" | "project";
  role: VaultRole;
};

async function resolveTarget(
  userId: string,
  userRole: Role,
  body: MoveBody,
): Promise<ResolvedTarget | null> {
  if (body.target === "team_org") {
    if (!body.orgSlug || !body.collectionSlug) return null;
    const org = await prisma.organization.findUnique({
      where: { slug: body.orgSlug },
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
        organizationId_slug: {
          organizationId: org.id,
          slug: body.collectionSlug,
        },
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
    // Meme logique que lib/vault-access.ts#requireOrgCollectionAccess :
    // role implicite (ADMIN/OWNER → OWNER, DEV → EDITOR) combine avec
    // un eventuel TeamVaultMember explicite, on prend le max.
    const implicit: VaultRole | null =
      isPlatformAdmin(userRole) || orgRole === "OWNER" || orgRole === "ADMIN"
        ? "OWNER"
        : hasDevPrivileges(orgRole)
          ? "EDITOR"
          : null;
    const memberRole = collection.members[0]?.role ?? null;
    const role = maxVaultRole(implicit, memberRole);
    if (!role) return null;
    return {
      collectionId: collection.id,
      collectionName: collection.name,
      organizationId: org.id,
      projectId: null,
      source: "org",
      role,
    };
  }

  if (body.target === "team_project") {
    if (!body.projectSlug || !body.collectionSlug) return null;
    const project = await prisma.project.findUnique({
      where: { slug: body.projectSlug },
      select: {
        id: true,
        organizationId: true,
        members: {
          where: { userId },
          select: { role: true },
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
        projectId_slug: {
          projectId: project.id,
          slug: body.collectionSlug,
        },
      },
      select: { id: true, name: true, organizationId: true, projectId: true },
    });
    if (!collection) return null;
    const projectRole = project.members[0]?.role;
    const orgRole = project.organization.members[0]?.role;
    // Mapping aligne avec lib/vault-access.ts#requireProjectCollectionAccess :
    // OrgDEV sans ProjectMember explicite obtient EDITOR implicite (peut
    // donc deplacer un secret perso vers une collection projet).
    let role: VaultRole | null = null;
    if (isPlatformAdmin(userRole) || orgRole === "OWNER" || orgRole === "ADMIN") {
      role = "OWNER";
    } else if (projectRole) {
      role = PROJECT_TO_VAULT[projectRole];
    } else if (hasDevPrivileges(orgRole)) {
      role = "EDITOR";
    }
    if (!role) return null;
    return {
      collectionId: collection.id,
      collectionName: collection.name,
      organizationId: project.organizationId,
      projectId: project.id,
      source: "project",
      role,
    };
  }

  return null;
}

export async function POST(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;
  const { id } = await params;

  const body = (await readJson(req)) as MoveBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (
    body.target !== "team_org" &&
    body.target !== "team_project" &&
    body.target !== "project_account"
  ) {
    return NextResponse.json(
      { error: "target must be 'team_org', 'team_project' or 'project_account'" },
      { status: 400 },
    );
  }

  // Lecture entry source (proprietaire only).
  const source = await prisma.vaultEntry.findFirst({
    where: { id, userId: user.id },
  });
  if (!source) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Cible « compte de projet » (AppAccount) — déplacement INTER-MODÈLES :
  // l'entrée de login perso devient un Compte du projet. Mapping :
  // name→name, username→user, password→password. L'URL et le 2FA (TOTP) ne
  // sont PAS portés par AppAccount → perdus (l'UI prévient avant le move).
  if (body.target === "project_account") {
    if (!body.projectSlug) {
      return NextResponse.json({ error: "projectSlug requis" }, { status: 400 });
    }
    const project = await prisma.project.findUnique({
      where: { slug: body.projectSlug },
      select: {
        id: true,
        organizationId: true,
        members: { where: { userId: user.id }, select: { role: true } },
        organization: { select: { members: { where: { userId: user.id }, select: { role: true } } } },
      },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Rôle effectif aligné sur requireProjectCollectionAccess (cf. team_project).
    const projectRole = project.members[0]?.role;
    const orgRole = project.organization.members[0]?.role;
    let role: VaultRole | null = null;
    if (isPlatformAdmin(user.role) || orgRole === "OWNER" || orgRole === "ADMIN") {
      role = "OWNER";
    } else if (projectRole) {
      role = PROJECT_TO_VAULT[projectRole];
    } else if (hasDevPrivileges(orgRole)) {
      role = "EDITOR";
    }
    if (!role || !hasVaultRole(role, "EDITOR")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Mot de passe en clair pour le blob {user, password} de l'AppAccount.
    let plaintextPwd = "";
    if (source.encryptedPassword && source.passwordIv && source.passwordTag) {
      plaintextPwd = decrypt({
        encryptedValue: source.encryptedPassword,
        iv: source.passwordIv,
        tag: source.passwordTag,
      });
    }
    const payload = encrypt(JSON.stringify({ user: source.username ?? "", password: plaintextPwd }));

    const created = await prisma.$transaction(async (tx) => {
      const acc = await tx.appAccount.create({
        data: {
          projectId: project.id,
          name: source.name,
          encryptedData: payload.encryptedValue,
          iv: payload.iv,
          tag: payload.tag,
          tags: source.tags,
        },
        select: { id: true },
      });
      await tx.vaultEntry.delete({ where: { id: source.id } });
      return acc;
    });

    logAction({
      action: "ACCOUNT_CREATE",
      actor: { kind: "user", userId: user.id, email: user.email },
      organizationId: project.organizationId,
      projectId: project.id,
      targetType: "AppAccount",
      targetId: created.id,
      metadata: { from: "personal", fromEntryId: source.id, name: source.name },
      req,
    });

    return NextResponse.json({ id: created.id, target: "project_account" });
  }

  // Resolution de la cible.
  const target = await resolveTarget(user.id, user.role, body);
  if (!target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!hasVaultRole(target.role, "EDITOR")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Re-encrypt password (cf. note en tete : nouvel IV pour defense en
  // profondeur, meme si la cle est identique).
  let encryptedPassword: string | null = null;
  let passwordIv: string | null = null;
  let passwordTag: string | null = null;
  if (source.encryptedPassword && source.passwordIv && source.passwordTag) {
    const plaintext = decrypt({
      encryptedValue: source.encryptedPassword,
      iv: source.passwordIv,
      tag: source.passwordTag,
    });
    const reEnc = encrypt(plaintext);
    encryptedPassword = reEnc.encryptedValue;
    passwordIv = reEnc.iv;
    passwordTag = reEnc.tag;
  }

  // Idem pour le secret TOTP si present.
  let encryptedTotpSecret: string | null = null;
  let totpSecretIv: string | null = null;
  let totpSecretTag: string | null = null;
  if (
    source.encryptedTotpSecret &&
    source.totpSecretIv &&
    source.totpSecretTag
  ) {
    const plaintext = decrypt({
      encryptedValue: source.encryptedTotpSecret,
      iv: source.totpSecretIv,
      tag: source.totpSecretTag,
    });
    const reEnc = encrypt(plaintext);
    encryptedTotpSecret = reEnc.encryptedValue;
    totpSecretIv = reEnc.iv;
    totpSecretTag = reEnc.tag;
  }

  // Transaction : create TeamVaultEntry → delete source.
  const created = await prisma.$transaction(async (tx) => {
    const newEntry = await tx.teamVaultEntry.create({
      data: {
        collectionId: target.collectionId,
        name: source.name,
        url: source.url,
        username: source.username,
        encryptedPassword,
        passwordIv,
        passwordTag,
        encryptedTotpSecret,
        totpSecretIv,
        totpSecretTag,
        tags: source.tags,
        favorite: source.favorite,
      },
      select: { id: true },
    });
    await tx.vaultEntry.delete({ where: { id: source.id } });
    return newEntry;
  });

  logAction({
    action: "VAULT_ENTRY_MOVE",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: target.organizationId,
    projectId: target.projectId,
    targetType: "TeamVaultEntry",
    targetId: created.id,
    metadata: {
      from: "personal",
      fromEntryId: source.id,
      to: target.source,
      collectionId: target.collectionId,
      collectionName: target.collectionName,
      name: source.name,
    },
    req,
  });

  return NextResponse.json({ id: created.id, target: target.source });
}
