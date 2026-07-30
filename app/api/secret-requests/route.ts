// /api/secret-requests
//
// GET  : liste les demandes de secret externe sur toutes les orgs où le user
//        est DEV+ (multi-org global). Filtres : ?org=<slug>&project=<slug>&status=...
// POST : crée une nouvelle demande. Body :
//        { label, description?, organizationId, projectId?, environmentName?,
//          secretKey?, recipientEmail? }
//        Retourne { id, requestUrl, privateKey } — privateKey UNE SEULE FOIS.

import { ORG_DEV_PLUS_ROLES } from "@/lib/roles";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/api";
import {
  accessibleProjectsWhere,
  effectiveProjectRole,
} from "@/lib/project-access";
import { rateLimit } from "@/lib/rate-limit";
import { isValidEmail, isValidSecretKey } from "@/lib/validation";
import { logAction } from "@/lib/audit";
import { generateEcdhKeypair } from "@/lib/secret-request-crypto";
import {
  resolveSecretRequestTtlMs,
  deriveStatus,
  generateSecretRequestToken,
  hashSecretRequestToken,
  type SecretRequestStatus,
} from "@/lib/secret-request";
import { sendSecretRequestEmail } from "@/lib/email";

const SHARED_PORTAL =
  process.env.PHYSALIS_SHARED_PORTAL ?? "vault.physalis.cloud";

const VALID_STATUSES: SecretRequestStatus[] = [
  "pending",
  "received",
  "imported",
  "revoked",
  "expired",
];

export async function GET(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const url = new URL(req.url);
  const orgSlugFilter = url.searchParams.get("org");
  const projectSlugFilter = url.searchParams.get("project");
  const statusFilter = url.searchParams.get("status");

  // Toutes les orgs dont l'user est membre (TOUT rôle) — cibles de création
  // (proposées dans le dialog). La VISIBILITÉ dépend du rôle : DEV+ voit toutes
  // les demandes de l'org (§2.16) ; un membre ne voit que LES SIENNES.
  const memberships = await prisma.orgMember.findMany({
    where: { userId: user.id },
    select: {
      role: true,
      organization: { select: { id: true, slug: true, name: true } },
    },
  });
  const allOrgs = memberships.map((m) => m.organization);
  if (memberships.length === 0) {
    return NextResponse.json({ requests: [], orgs: [] });
  }
  const devPlus = memberships.filter((m) => ORG_DEV_PLUS_ROLES.includes(m.role));

  // Filtre org optionnel (doit être une org de l'user)
  let orgFilterId: string | undefined;
  if (orgSlugFilter) {
    const match = memberships.find((m) => m.organization.slug === orgSlugFilter);
    if (!match) {
      return NextResponse.json({ requests: [], orgs: allOrgs });
    }
    orgFilterId = match.organization.id;
  }

  // Filtre project optionnel (par slug, scopé sur les orgs du user)
  let projectIdFilter: string | undefined;
  if (projectSlugFilter) {
    const proj = await prisma.project.findFirst({
      where: {
        slug: projectSlugFilter,
        organizationId: { in: memberships.map((m) => m.organization.id) },
      },
      select: { id: true },
    });
    if (!proj) {
      return NextResponse.json({ requests: [], orgs: allOrgs });
    }
    projectIdFilter = proj.id;
  }

  // §2.16 — visibilité DEV+ par org (demandes org-level + projets accessibles,
  // `hidden` respecté ; OrgADMIN/OWNER voient tout). Bornée à l'org demandée.
  const scopedDevPlus = orgFilterId
    ? devPlus.filter((m) => m.organization.id === orgFilterId)
    : devPlus;
  const orgVisibility = scopedDevPlus.map((m) => ({
    organizationId: m.organization.id,
    OR: [
      { projectId: null },
      { project: accessibleProjectsWhere(m.organization.id, user.id, m.role) },
    ],
  }));

  // (DEV+ voit les demandes de son org) OU (chacun voit LES SIENNES), borné par
  // les filtres org/projet éventuels.
  const rows = await prisma.secretRequest.findMany({
    where: {
      AND: [
        { OR: [...orgVisibility, { requestedById: user.id }] },
        ...(orgFilterId ? [{ organizationId: orgFilterId }] : []),
        ...(projectIdFilter ? [{ projectId: projectIdFilter }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      label: true,
      description: true,
      requestedByEmail: true,
      recipientEmail: true,
      organizationId: true,
      organization: { select: { name: true, slug: true } },
      projectId: true,
      project: { select: { name: true, slug: true } },
      environmentName: true,
      secretKey: true,
      submittedAt: true,
      viewedAt: true,
      importedAt: true,
      revokedAt: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  // Statut dérivé en JS (pas filtrable en SQL trivialement)
  const enriched = rows.map((r) => ({
    ...r,
    status: deriveStatus(r),
  }));

  const filtered =
    statusFilter && VALID_STATUSES.includes(statusFilter as SecretRequestStatus)
      ? enriched.filter((r) => r.status === statusFilter)
      : enriched;

  return NextResponse.json({
    requests: filtered,
    orgs: allOrgs,
  });
}

type PostBody = {
  label?: string;
  description?: string;
  organizationId?: string;
  projectId?: string;
  environmentName?: string;
  secretKey?: string;
  recipientEmail?: string;
  /** #5 — durée de vie du lien en heures (1/24/48/168). Défaut 48h. */
  expiresInHours?: number;
};

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  // Anti-abus : la création envoie un email de marque à un destinataire
  // arbitraire (§2.22-famille). Feature ouverte à tout membre → borne par user.
  const limited = rateLimit(
    req,
    "secret-request-create",
    { max: 20, windowMs: 60 * 60_000 },
    user.id,
  );
  if (limited) return limited;

  const body = (await readJson(req)) as PostBody | null;
  if (
    !body ||
    typeof body.label !== "string" ||
    body.label.trim().length === 0 ||
    typeof body.organizationId !== "string"
  ) {
    return NextResponse.json(
      { error: "label and organizationId are required" },
      { status: 400 },
    );
  }
  const label = body.label.trim().slice(0, 200);
  const description = body.description?.trim().slice(0, 500) || null;
  const recipientEmail = body.recipientEmail?.trim().toLowerCase() || null;
  if (recipientEmail && !isValidEmail(recipientEmail)) {
    return NextResponse.json(
      { error: "Invalid recipientEmail" },
      { status: 400 },
    );
  }
  const environmentName =
    body.environmentName?.trim().slice(0, 100) || null;
  const secretKey = body.secretKey?.trim() || null;
  if (secretKey && !isValidSecretKey(secretKey)) {
    return NextResponse.json(
      { error: "secretKey invalide (format ^[A-Z][A-Z0-9_]*$)" },
      { status: 400 },
    );
  }
  // #5 — expiration configurable (bornée à l'allowlist ; défaut 48h).
  const ttlMs = resolveSecretRequestTtlMs(body.expiresInHours);
  if (ttlMs === null) {
    return NextResponse.json(
      { error: "expiresInHours invalide (autorisé : 1, 24, 48, 168)" },
      { status: 400 },
    );
  }

  // Org access : user doit être MEMBRE de l'org (tout rôle). La feature est
  // ouverte aux membres ; un MEMBER ne pourra faire que des demandes org-level
  // (le scoping projet ci-dessous exige un accès projet réel).
  const orgMembership = await prisma.orgMember.findFirst({
    where: {
      userId: user.id,
      organizationId: body.organizationId,
    },
    select: {
      role: true,
      organization: { select: { id: true, slug: true, name: true } },
    },
  });
  if (!orgMembership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const org = orgMembership.organization;

  // Project scoping optionnel : requiert un ACCÈS RÉEL au projet via les 6
  // règles §4 (`effectiveProjectRole`). ⚠️ Ne PAS re-dériver à la main : le
  // check historique `members: { none: { hidden } }` ne tenait QUE grâce à
  // l'ancien gate DEV+ ; sans lui, un MEMBER aurait pu scoper n'importe quel
  // projet non masqué (escalade).
  let projectId: string | null = null;
  if (body.projectId) {
    const proj = await prisma.project.findFirst({
      where: { id: body.projectId, organizationId: org.id },
      select: {
        id: true,
        members: {
          where: { userId: user.id },
          select: { role: true, hidden: true },
        },
      },
    });
    if (!proj) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const row = proj.members[0] ?? null;
    const effective = effectiveProjectRole({
      orgRole: orgMembership.role,
      membership: row ? { role: row.role, hidden: row.hidden } : null,
      platformRole: user.role,
    });
    if (!effective) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    projectId = proj.id;
  }

  // Crypto : génère paire ECDH éphémère côté serveur.
  const keypair = await generateEcdhKeypair();
  const token = generateSecretRequestToken();
  const tokenHash = hashSecretRequestToken(token);
  const expiresAt = new Date(Date.now() + ttlMs);

  const created = await prisma.secretRequest.create({
    data: {
      tokenHash,
      label,
      description,
      requestedById: user.id,
      requestedByEmail: user.email,
      recipientEmail,
      organizationId: org.id,
      projectId,
      environmentName,
      secretKey,
      publicKeyJwk: keypair.publicJwk,
      expiresAt,
    },
    select: { id: true, expiresAt: true },
  });

  const requestUrl = `https://${SHARED_PORTAL}/request/${token}`;

  // Envoi email automatique si destinataire fourni (best-effort).
  if (recipientEmail) {
    sendSecretRequestEmail({
      to: recipientEmail,
      requesterEmail: user.email,
      label,
      description,
      requestUrl,
      expiresAt: created.expiresAt,
    }).catch((err) => {
      console.error("[secret-requests] failed to send invite email:", err);
    });
  }

  logAction({
    action: "SECRET_REQUEST_CREATED",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: org.id,
    projectId,
    targetType: "SecretRequest",
    targetId: created.id,
    metadata: {
      label,
      recipientEmail,
      hasProject: Boolean(projectId),
      hasImportTarget: Boolean(environmentName && secretKey),
    },
    req,
  });

  return NextResponse.json(
    {
      id: created.id,
      requestUrl,
      // Privée renvoyée UNE SEULE FOIS — l'admin doit la stocker
      // (coffre Physalis ou ailleurs).
      privateKey: keypair.privateJwk,
      expiresAt: created.expiresAt,
    },
    { status: 201 },
  );
}
