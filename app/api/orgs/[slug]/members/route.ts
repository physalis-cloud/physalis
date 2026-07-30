import { NextResponse } from "next/server";
import type { OrgRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isValidEmail, readJson, requireOrgMember } from "@/lib/api";
import {
  buildAcceptUrl,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_MS,
} from "@/lib/invitations";
import { sendInvitationEmail } from "@/lib/email";
import { logAction } from "@/lib/audit";
import {
  parseInvitationProjectAccess,
  type InvitationProjectAccess,
} from "@/lib/invitation-project-access";

type Params = { params: Promise<{ slug: string }> };

// ADMIN_DEV coule dans le self-host (enum force-ajoute a l'OrgRole, cf.
// public-overlay/manifest.json). Le chemin de changement de role
// (members/[userId], verbatim) l'accepte → on l'accepte aussi ici pour eviter
// une asymetrie invite/changement dans le self-host.
const VALID_ROLES: OrgRole[] = ["OWNER", "ADMIN", "ADMIN_DEV", "DEV", "MEMBER"];

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug);
  if ("error" in access) return access.error;

  const members = await prisma.orgMember.findMany({
    where: { organizationId: access.organization.id },
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { id: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const invitations = await prisma.invitation.findMany({
    where: { organizationId: access.organization.id, acceptedAt: null },
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      createdAt: true,
      inviteeUserId: true,
      invitedBy: { select: { email: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ members, invitations, role: access.role });
}

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug, "ADMIN");
  if ("error" in access) return access.error;

  // Body : soit { email } (legacy email-based) soit { targetUserId } (in-app
  // pour un user deja sur la plateforme). Si les 2 sont fournis,
  // targetUserId prend le pas.
  const body = (await readJson(req)) as
    | {
        email?: string;
        role?: string;
        targetUserId?: string;
        projectAccess?: unknown;
      }
    | null;
  const role = String(body?.role ?? "MEMBER").toUpperCase() as OrgRole;
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  // Only OWNERs can invite OWNERs.
  if (role === "OWNER" && access.role !== "OWNER") {
    return NextResponse.json(
      { error: "Only OWNERs can invite OWNERs" },
      { status: 403 },
    );
  }

  // #2 — accès projet pré-attribués, appliqués a l'acceptation. Sans objet pour
  // un OWNER/ADMIN d'org (OWNER implicite partout). Borne aux projets de l'org.
  let projectAccessToStore: InvitationProjectAccess[] | null = null;
  if (role !== "OWNER" && role !== "ADMIN") {
    const parsed = parseInvitationProjectAccess(body?.projectAccess);
    if (parsed.length > 0) {
      const orgProjects = await prisma.project.findMany({
        where: {
          organizationId: access.organization.id,
          id: { in: parsed.map((e) => e.projectId) },
        },
        select: { id: true },
      });
      const valid = new Set(orgProjects.map((p) => p.id));
      const filtered = parsed.filter((e) => valid.has(e.projectId));
      if (filtered.length > 0) projectAccessToStore = filtered;
    }
  }

  const targetUserId = body?.targetUserId?.trim() || null;

  // ─── Branche in-app ─────────────────────────────────────────────────
  if (targetUserId) {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true },
    });
    if (!targetUser) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Self-invite blocking : on ne peut pas s'auto-inviter.
    if (targetUser.id === access.user.id) {
      return NextResponse.json(
        { error: "Cannot invite yourself" },
        { status: 400 },
      );
    }
    // Deja membre ?
    const existingMember = await prisma.orgMember.findUnique({
      where: {
        userId_organizationId: {
          userId: targetUser.id,
          organizationId: access.organization.id,
        },
      },
    });
    if (existingMember) {
      return NextResponse.json(
        { error: "User is already a member" },
        { status: 409 },
      );
    }
    // Deja invite (email OU in-app) ? Conflit pour eviter doublon.
    const existingInv = await prisma.invitation.findFirst({
      where: {
        organizationId: access.organization.id,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
        OR: [{ inviteeUserId: targetUser.id }, { email: targetUser.email }],
      },
    });
    if (existingInv) {
      return NextResponse.json(
        { error: "Invitation already pending for this user" },
        { status: 409 },
      );
    }

    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const invitation = await prisma.invitation.create({
      data: {
        email: targetUser.email,
        organizationId: access.organization.id,
        role,
        tokenHash,
        expiresAt,
        invitedById: access.user.id,
        inviteeUserId: targetUser.id,
        ...(projectAccessToStore ? { projectAccess: projectAccessToStore } : {}),
      },
      select: { id: true, email: true, role: true, expiresAt: true },
    });

    logAction({
      action: "MEMBER_INVITE",
      actor: { kind: "user", userId: access.user.id, email: access.user.email },
      organizationId: access.organization.id,
      targetType: "Invitation",
      targetId: invitation.id,
      metadata: {
        email: targetUser.email,
        role,
        kind: "in_app",
        inviteeUserId: targetUser.id,
      },
      req,
    });

    return NextResponse.json({ invitation }, { status: 201 });
  }

  // ─── Branche email-based (legacy) ──────────────────────────────────
  const email = String(body?.email ?? "").toLowerCase().trim();
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    const existingMember = await prisma.orgMember.findUnique({
      where: {
        userId_organizationId: {
          userId: existingUser.id,
          organizationId: access.organization.id,
        },
      },
    });
    if (existingMember) {
      return NextResponse.json(
        { error: "User is already a member" },
        { status: 409 },
      );
    }
  }

  // Conflit avec une invitation in-app pour le meme email.
  const existingInv = await prisma.invitation.findFirst({
    where: {
      organizationId: access.organization.id,
      email,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (existingInv) {
    return NextResponse.json(
      { error: "Invitation already pending for this email" },
      { status: 409 },
    );
  }

  const token = generateInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const invitation = await prisma.invitation.create({
    data: {
      email,
      organizationId: access.organization.id,
      role,
      tokenHash,
      expiresAt,
      invitedById: access.user.id,
      ...(projectAccessToStore ? { projectAccess: projectAccessToStore } : {}),
    },
    select: { id: true, email: true, role: true, expiresAt: true },
  });

  logAction({
    action: "MEMBER_INVITE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: { email, role, kind: "email" },
    req,
  });

  // Side-effect: send the email.
  try {
    const inviter = await prisma.user.findUnique({
      where: { id: access.user.id },
      select: { email: true },
    });
    await sendInvitationEmail({
      to: email,
      inviterEmail: inviter?.email ?? "(unknown)",
      organizationName: access.organization.name,
      acceptUrl: buildAcceptUrl(token, null),
      expiresAt,
    });
  } catch (err) {
    console.error("[invitation] email delivery failed:", err);
  }

  return NextResponse.json({ invitation }, { status: 201 });
}
