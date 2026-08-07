import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { readJson, requireOrgMember } from "@/lib/api";
import { CI_SECRET_KIND } from "@/lib/ci-connection";
import { validateConnectionIssuer } from "@/lib/ci-provider";
import { isSyncProvider, syncTokenKind } from "@/lib/sync/types";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; id: string }> };

const NAME_MAX = 80;
const TEAM_ID_MAX = 120;

const SECRET_FIELDS = [
  ["redeployToken", CI_SECRET_KIND.redeployToken],
  ["registryUrl", CI_SECRET_KIND.registryUrl],
  ["registryUser", CI_SECRET_KIND.registryUser],
  ["registryToken", CI_SECRET_KIND.registryToken],
  ["apiIdentity", CI_SECRET_KIND.apiIdentity],
] as const;

export async function PATCH(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireOrgMember(slug, "ADMIN_DEV", { feature: "ci_cd" });
  if ("error" in access) return access.error;

  const existing = await prisma.ciConnection.findFirst({
    where: { id, organizationId: access.organization.id },
    select: { id: true, name: true, provider: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Connexion introuvable" }, { status: 404 });
  }

  const body = (await readJson(req)) as
    | {
        name?: string;
        issuer?: string | null;
        redeployToken?: string | null;
        registryUrl?: string | null;
        registryUser?: string | null;
        registryToken?: string | null;
        apiIdentity?: string | null;
        syncToken?: string | null;
      }
    | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const sync = isSyncProvider(existing.provider);

  // provider est immuable (un changement réinterpréterait les policies des
  // projets liés) → recréer une connexion pour un autre provider.
  const data: { name?: string; issuer?: string | null } = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > NAME_MAX) {
      return NextResponse.json(
        { error: `Nom requis (1-${NAME_MAX} caractères)` },
        { status: 400 },
      );
    }
    if (name !== existing.name) {
      const dup = await prisma.ciConnection.findUnique({
        where: {
          organizationId_name: { organizationId: access.organization.id, name },
        },
        select: { id: true },
      });
      if (dup) {
        return NextResponse.json(
          { error: "Une connexion porte déjà ce nom." },
          { status: 409 },
        );
      }
      data.name = name;
    }
  }

  if ("issuer" in body) {
    const issuer = String(body.issuer ?? "").trim();
    if (sync) {
      // Providers de sync : issuer = scope d'équipe optionnel (teamId).
      if (issuer.length > TEAM_ID_MAX) {
        return NextResponse.json({ error: "teamId trop long" }, { status: 400 });
      }
      data.issuer = issuer === "" ? null : issuer;
    } else {
      const issuerErr = validateConnectionIssuer(existing.provider, issuer);
      if (issuerErr) return NextResponse.json({ error: issuerErr }, { status: 400 });
      data.issuer = existing.provider === "github" || issuer === "" ? null : issuer;
    }
  }

  if (Object.keys(data).length > 0) {
    await prisma.ciConnection.update({ where: { id }, data });
  }

  if (sync) {
    // Token de sync (vercel/render) : upsert si fourni non vide. On ne le
    // SUPPRIME jamais via edit (une connexion sans token est inexploitable ;
    // un champ vide = "inchangé", cohérent avec l'UI).
    if (typeof body.syncToken === "string" && body.syncToken.trim() !== "") {
      const kind = syncTokenKind(existing.provider)!;
      const payload = encrypt(body.syncToken.trim());
      await prisma.ciConnectionSecret.upsert({
        where: { connectionId_kind: { connectionId: id, kind } },
        create: { connectionId: id, kind, ...payload },
        update: payload,
      });
    }
  } else {
    // Secrets OIDC : champ présent + valeur non vide → upsert ; null/"" → suppression.
    for (const [field, kind] of SECRET_FIELDS) {
      if (!(field in body)) continue;
      const v = body[field];
      if (typeof v === "string" && v.trim() !== "") {
        const payload = encrypt(v.trim());
        await prisma.ciConnectionSecret.upsert({
          where: { connectionId_kind: { connectionId: id, kind } },
          create: { connectionId: id, kind, ...payload },
          update: payload,
        });
      } else if (v === null || v === "") {
        await prisma.ciConnectionSecret.deleteMany({
          where: { connectionId: id, kind },
        });
      }
    }
  }

  logAction({
    action: "ORG_SECRET_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "CiConnection",
    targetId: id,
    metadata: { ciConnection: data.name ?? existing.name },
    req,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireOrgMember(slug, "ADMIN_DEV");
  if ("error" in access) return access.error;

  const existing = await prisma.ciConnection.findFirst({
    where: { id, organizationId: access.organization.id },
    select: {
      id: true,
      name: true,
      _count: { select: { projects: true, syncTargets: true } },
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Connexion introuvable" }, { status: 404 });
  }
  if (existing._count.projects > 0) {
    return NextResponse.json(
      {
        error: `Connexion utilisée par ${existing._count.projects} projet(s). Déliez-les d'abord.`,
      },
      { status: 409 },
    );
  }
  if (existing._count.syncTargets > 0) {
    return NextResponse.json(
      {
        error: `Connexion utilisée par ${existing._count.syncTargets} cible(s) de sync. Supprimez-les d'abord.`,
      },
      { status: 409 },
    );
  }

  await prisma.ciConnection.delete({ where: { id } });

  logAction({
    action: "ORG_SECRET_DELETE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "CiConnection",
    targetId: id,
    metadata: { ciConnection: existing.name },
    req,
  });

  return NextResponse.json({ ok: true });
}
