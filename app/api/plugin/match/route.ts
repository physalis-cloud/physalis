// GET /api/plugin/match?domain=<hostname>
//
// Retourne les credentials Service + AppAccount accessibles a l'user
// (via PluginToken Bearer) dont le hostname matche strictement la query.
//
// Logique d'acces (cf. requireProjectMember dans lib/api.ts) :
//   - User.role = ADMIN → access global
//   - OrgMember.role ∈ {OWNER, ADMIN} sur l'org du projet → access OWNER implicite
//   - ProjectMember explicite (n'importe quel role) → access
//
// Logique de match :
//   - Service : Service.url hostname === query.domain
//   - AppAccount : un Environment.url du projet parent a hostname === query.domain
//     (decision design #2 : pas de champ url dedie sur AppAccount, on derive
//      via les envs du projet)
//
// Audit : PLUGIN_CREDENTIALS_FETCH avec metadata { domain, services_count,
// accounts_count, vault_count } (vault_count = total des 3 sources perso/org/projet).
//
// ─── Coffres (Sub-PR3) ───────────────────────────────────────────────────
// En plus des Services et AppAccounts, le bundle agrege les VaultEntry
// (perso) du user du token + les TeamVaultEntry des collections org et
// projet accessibles. Chaque entree porte un `target` ("personal" /
// "team_org" / "team_project") + slugs (`orgSlug` / `projectSlug` /
// `collectionSlug`) pour identification stable cote extension.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import {
  extractPluginBearer,
  validatePluginToken,
} from "@/lib/plugin-token";
import {
  checkPluginOrigin,
  preflightResponse,
  withCors,
} from "@/lib/plugin-cors";
import { getAccessibleCollectionIds } from "@/lib/vault-access";
import { isPlatformAdmin } from "@/lib/roles";
import { logAction } from "@/lib/audit";

export const runtime = "nodejs";

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
  return { user: parsed.user ?? "", password: parsed.password ?? "" };
}

export async function GET(req: Request) {
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
  const url = new URL(req.url);
  const queryDomain = safeHostname(url.searchParams.get("domain"));
  if (!queryDomain) {
    return withCors(
      NextResponse.json(
        { error: "domain query param is required and must be a valid hostname" },
        { status: 400 },
      ),
      allowOrigin,
    );
  }

  // 1. Calcule l'ensemble des projectId accessibles a l'user.
  const userId = session.userId;
  const isGlobalAdmin = isPlatformAdmin(session.user.role);

  let accessibleProjectIds: string[];
  if (isGlobalAdmin) {
    const all = await prisma.project.findMany({ select: { id: true } });
    accessibleProjectIds = all.map((p) => p.id);
  } else {
    const orgMemberships = await prisma.orgMember.findMany({
      where: { userId, role: { in: ["OWNER", "ADMIN"] } },
      select: { organizationId: true },
    });
    const projectMemberships = await prisma.projectMember.findMany({
      // `hidden: true` = projet masqué pour cet user → requireProjectMember
      // lui répond 403 (règle 2). Sans ce filtre, l'extension autofillait les
      // credentials DÉCHIFFRÉS (Service.user/password, AppAccount) d'un projet
      // que l'UI lui ferme — sur simple match de domaine, sans action de sa part.
      // La branche org ci-dessus reste OWNER/ADMIN seulement : eux ignorent
      // `hidden` à raison (règle 1).
      where: { userId, hidden: false },
      select: { projectId: true },
    });
    const orgProjects = orgMemberships.length
      ? await prisma.project.findMany({
          where: {
            organizationId: { in: orgMemberships.map((m) => m.organizationId) },
          },
          select: { id: true },
        })
      : [];
    accessibleProjectIds = Array.from(
      new Set([
        ...orgProjects.map((p) => p.id),
        ...projectMemberships.map((m) => m.projectId),
      ]),
    );
  }

  // 2. Services dont l'URL matche le hostname (skip si aucun projet accessible).
  const candidateServices = accessibleProjectIds.length === 0
    ? []
    : await prisma.service.findMany({
        where: {
          projectId: { in: accessibleProjectIds },
          url: { not: null },
        },
        select: {
          id: true,
          name: true,
          url: true,
          encryptedData: true,
          iv: true,
          tag: true,
          project: { select: { name: true, organizationId: true } },
        },
      });
  const matchedServices: Array<{
    id: string;
    projectName: string;
    name: string;
    url: string;
    user: string;
    password: string;
  }> = [];
  for (const s of candidateServices) {
    if (safeHostname(s.url) === queryDomain) {
      const creds = decryptCreds(s);
      matchedServices.push({
        id: s.id,
        projectName: s.project.name,
        name: s.name,
        url: s.url ?? "",
        user: creds.user,
        password: creds.password,
      });
    }
  }

  // 3. AppAccounts via Environment.url du projet parent.
  const projectsWithEnvAndAccounts = accessibleProjectIds.length === 0
    ? []
    : await prisma.project.findMany({
        where: {
          id: { in: accessibleProjectIds },
          environments: { some: { url: { not: null } } },
          appAccounts: { some: {} },
        },
        select: {
          id: true,
          name: true,
          environments: {
            where: { url: { not: null } },
            select: { url: true },
          },
          appAccounts: {
            select: {
              id: true,
              name: true,
              encryptedData: true,
              iv: true,
              tag: true,
            },
          },
        },
      });
  const matchedAccounts: Array<{
    id: string;
    projectName: string;
    name: string;
    user: string;
    password: string;
  }> = [];
  for (const p of projectsWithEnvAndAccounts) {
    const projectMatches = p.environments.some(
      (e) => safeHostname(e.url) === queryDomain,
    );
    if (!projectMatches) continue;
    for (const acc of p.appAccounts) {
      const creds = decryptCreds(acc);
      matchedAccounts.push({
        id: acc.id,
        projectName: p.name,
        name: acc.name,
        user: creds.user,
        password: creds.password,
      });
    }
  }

  // 4. Coffres : perso + org + projet.
  type VaultEntryOut = {
    id: string;
    target: "personal" | "team_org" | "team_project";
    orgSlug?: string;
    projectSlug?: string;
    collectionSlug?: string;
    name: string;
    url: string;
    username: string;
    password: string;
    /** Secret base32 TOTP du site cible (null si non configure). L'extension
     *  calcule le code 6 chiffres localement via Web Crypto. */
    totpSecret: string | null;
    tags: string[];
  };

  function decryptPwd(payload: {
    encryptedPassword: string | null;
    passwordIv: string | null;
    passwordTag: string | null;
  }): string {
    if (!payload.encryptedPassword || !payload.passwordIv || !payload.passwordTag) {
      return "";
    }
    return decrypt({
      encryptedValue: payload.encryptedPassword,
      iv: payload.passwordIv,
      tag: payload.passwordTag,
    });
  }

  function decryptTotp(payload: {
    encryptedTotpSecret: string | null;
    totpSecretIv: string | null;
    totpSecretTag: string | null;
  }): string | null {
    if (
      !payload.encryptedTotpSecret ||
      !payload.totpSecretIv ||
      !payload.totpSecretTag
    ) {
      return null;
    }
    return decrypt({
      encryptedValue: payload.encryptedTotpSecret,
      iv: payload.totpSecretIv,
      tag: payload.totpSecretTag,
    });
  }

  const matchedVault: VaultEntryOut[] = [];

  // 4a. Coffre personnel : VaultEntry ou userId = session.userId.
  // `type: LOGIN` est redondant avec `url != null` (seul LOGIN porte une
  // URL, cf. lib/vault-entry-types.ts) mais rend l'invariant visible ici :
  // l'autofill ne propose jamais un SECRET, une LIST ou une NOTE.
  const personalEntries = await prisma.vaultEntry.findMany({
    where: { userId, type: "LOGIN", url: { not: null } },
    select: {
      id: true,
      name: true,
      url: true,
      username: true,
      tags: true,
      encryptedPassword: true,
      passwordIv: true,
      passwordTag: true,
      encryptedTotpSecret: true,
      totpSecretIv: true,
      totpSecretTag: true,
    },
  });
  for (const e of personalEntries) {
    if (safeHostname(e.url) !== queryDomain) continue;
    matchedVault.push({
      id: e.id,
      target: "personal",
      name: e.name,
      url: e.url ?? "",
      username: e.username ?? "",
      password: decryptPwd(e),
      totpSecret: decryptTotp(e),
      tags: e.tags,
    });
  }

  // 4b. Coffres d'equipe : TeamVaultEntry des collections accessibles.
  // Reuse du helper getAccessibleCollectionIds qui combine les 4 voies
  // d'acces (membership direct, OrgADMIN+, ProjectMember, OrgADMIN+ → projets de l'org).
  const accessibleCollectionIds = await getAccessibleCollectionIds(
    userId,
    session.user.role,
  );

  const teamEntries =
    accessibleCollectionIds.length === 0
      ? []
      : await prisma.teamVaultEntry.findMany({
          where: {
            collectionId: { in: accessibleCollectionIds },
            url: { not: null },
          },
          select: {
            id: true,
            name: true,
            url: true,
            username: true,
            tags: true,
            encryptedPassword: true,
            passwordIv: true,
            passwordTag: true,
            encryptedTotpSecret: true,
            totpSecretIv: true,
            totpSecretTag: true,
            collection: {
              select: {
                slug: true,
                organization: { select: { slug: true } },
                project: { select: { slug: true } },
              },
            },
          },
        });

  for (const e of teamEntries) {
    if (safeHostname(e.url) !== queryDomain) continue;
    const orgSlug = e.collection.organization?.slug;
    const projectSlug = e.collection.project?.slug;
    if (orgSlug) {
      matchedVault.push({
        id: e.id,
        target: "team_org",
        orgSlug,
        collectionSlug: e.collection.slug,
        name: e.name,
        url: e.url ?? "",
        username: e.username ?? "",
        password: decryptPwd(e),
        totpSecret: decryptTotp(e),
        tags: e.tags,
      });
    } else if (projectSlug) {
      matchedVault.push({
        id: e.id,
        target: "team_project",
        projectSlug,
        collectionSlug: e.collection.slug,
        name: e.name,
        url: e.url ?? "",
        username: e.username ?? "",
        password: decryptPwd(e),
        totpSecret: decryptTotp(e),
        tags: e.tags,
      });
    }
  }

  logAction({
    action: "PLUGIN_CREDENTIALS_FETCH",
    actor: { kind: "user", userId: session.userId, email: session.user.email },
    metadata: {
      domain: queryDomain,
      services_count: matchedServices.length,
      accounts_count: matchedAccounts.length,
      vault_count: matchedVault.length,
      vault_personal: matchedVault.filter((v) => v.target === "personal").length,
      vault_org: matchedVault.filter((v) => v.target === "team_org").length,
      vault_project: matchedVault.filter((v) => v.target === "team_project")
        .length,
    },
    req,
  });

  return withCors(
    NextResponse.json({
      services: matchedServices,
      accounts: matchedAccounts,
      vault: matchedVault,
    }),
    allowOrigin,
  );
}
