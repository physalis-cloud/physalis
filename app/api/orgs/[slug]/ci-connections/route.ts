import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { readJson, requireOrgMember } from "@/lib/api";
import { isCiProvider, validateConnectionIssuer } from "@/lib/ci-provider";
import { CI_SECRET_KIND } from "@/lib/ci-connection";
import { isSyncProvider, syncTokenKind } from "@/lib/sync/types";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string }> };

const NAME_MAX = 80;
const TEAM_ID_MAX = 120;

// kinds des secrets d'une connexion, mappés depuis les champs du body.
const SECRET_FIELDS = [
  ["redeployToken", CI_SECRET_KIND.redeployToken],
  ["registryUrl", CI_SECRET_KIND.registryUrl],
  ["registryUser", CI_SECRET_KIND.registryUser],
  ["registryToken", CI_SECRET_KIND.registryToken],
  ["apiIdentity", CI_SECRET_KIND.apiIdentity],
] as const;

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug, "DEV");
  if ("error" in access) return access.error;

  const connections = await prisma.ciConnection.findMany({
    where: { organizationId: access.organization.id },
    select: {
      id: true,
      name: true,
      provider: true,
      issuer: true,
      createdAt: true,
      updatedAt: true,
      secrets: { select: { kind: true } },
      _count: { select: { projects: true, syncTargets: true } },
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    connections: connections.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      issuer: c.issuer,
      projectCount: c._count.projects,
      syncTargetCount: c._count.syncTargets,
      // On n'expose JAMAIS les valeurs, seulement la présence par kind.
      secretsSet: c.secrets.map((s) => s.kind),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  });
}

// Feature payante `ci_cd`. Les GET restent ouverts : après un downgrade, la
// connexion existante doit rester consultable (et son secret récupérable) pour
// que le client puisse migrer ailleurs. Seules la création et la modification
// sont fermées — cf. `documentation/plans/gating-plans.md` §5.
export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug, "ADMIN_DEV", { feature: "ci_cd" });
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | {
        name?: string;
        provider?: string;
        issuer?: string | null;
        redeployToken?: string | null;
        registryUrl?: string | null;
        registryUser?: string | null;
        registryToken?: string | null;
        // Identité Basic auth Bitbucket (email Atlassian / username).
        apiIdentity?: string | null;
        // Providers de sync (vercel/render) : token + teamId optionnel (issuer).
        syncToken?: string | null;
      }
    | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const name = String(body.name ?? "").trim();
  if (!name || name.length > NAME_MAX) {
    return NextResponse.json(
      { error: `Nom requis (1-${NAME_MAX} caractères)` },
      { status: 400 },
    );
  }
  const provider = String(body.provider ?? "").trim().toLowerCase();
  const sync = isSyncProvider(provider);
  if (!isCiProvider(provider) && !sync) {
    return NextResponse.json(
      { error: "provider invalide (github|gitlab|bitbucket|vercel|render)" },
      { status: 400 },
    );
  }

  // issuer : OIDC pour github/gitlab/bitbucket ; pour les providers de sync il
  // est réutilisé comme scope d'équipe optionnel (Vercel teamId/slug).
  const issuer = String(body.issuer ?? "").trim();
  if (sync) {
    if (issuer.length > TEAM_ID_MAX) {
      return NextResponse.json({ error: "teamId trop long" }, { status: 400 });
    }
  } else {
    const issuerErr = validateConnectionIssuer(provider, issuer);
    if (issuerErr) return NextResponse.json({ error: issuerErr }, { status: 400 });
  }

  const dup = await prisma.ciConnection.findUnique({
    where: { organizationId_name: { organizationId: access.organization.id, name } },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json(
      { error: "Une connexion porte déjà ce nom." },
      { status: 409 },
    );
  }

  let secretRows: { kind: string; encryptedValue: string; iv: string; tag: string }[];
  if (sync) {
    // Une connexion de sync exige son token (sinon inexploitable).
    const token = typeof body.syncToken === "string" ? body.syncToken.trim() : "";
    if (!token) {
      return NextResponse.json({ error: "Token requis" }, { status: 400 });
    }
    secretRows = [{ kind: syncTokenKind(provider)!, ...encrypt(token) }];
  } else {
    secretRows = SECRET_FIELDS.flatMap(([field, kind]) => {
      const v = body[field];
      if (typeof v !== "string" || v.trim() === "") return [];
      return [{ kind, ...encrypt(v.trim()) }];
    });
  }

  const conn = await prisma.ciConnection.create({
    data: {
      organizationId: access.organization.id,
      name,
      provider,
      issuer: provider === "github" || issuer === "" ? null : issuer,
      secrets: { create: secretRows },
    },
    select: { id: true, name: true, provider: true, issuer: true },
  });

  logAction({
    action: "ORG_SECRET_CREATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "CiConnection",
    targetId: conn.id,
    metadata: { ciConnection: conn.name, provider: conn.provider },
    req,
  });

  return NextResponse.json({ connection: conn }, { status: 201 });
}
