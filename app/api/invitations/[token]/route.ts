// Jumeau SELF-HOST — divergence unique : le contrôle de quota de sièges
// (`checkSeatForOrgAdd`, lib/quotas) est retiré. Les sièges sont une notion de
// l'offre hébergée ; en mono-tenant il n'y a ni plan ni add-on à faire respecter,
// et `lib/quotas.ts` interroge le schéma `admin` qui n'existe pas ici.
// Tout le reste — y compris les gardes d'acceptation d'invitation — est identique.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { hashInvitationToken } from "@/lib/invitations";
import { logAction } from "@/lib/audit";
import { applyInvitationProjectAccess } from "@/lib/invitation-project-access";

type Params = { params: Promise<{ token: string }> };

async function findActiveInvitation(token: string) {
  const tokenHash = hashInvitationToken(token);
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash },
    include: {
      organization: { select: { name: true, slug: true } },
      invitedBy: { select: { email: true } },
    },
  });
  if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
    return null;
  }
  return invitation;
}

// Public: anyone holding the link can fetch the metadata to decide if they
// want to accept. Email is also returned so the UI can hint about the right
// account to log in with.
export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;
  const invitation = await findActiveInvitation(token);
  if (!invitation) {
    return NextResponse.json(
      { error: "Invitation invalid or expired" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    invitation: {
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      organization: invitation.organization,
      invitedBy: invitation.invitedBy,
    },
  });
}

// Authenticated: accept the invitation. The logged-in user must match the
// email the invitation was sent to (case-insensitive).
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;

  const invitation = await findActiveInvitation(token);
  if (!invitation) {
    return NextResponse.json(
      { error: "Invitation invalid or expired" },
      { status: 404 },
    );
  }

  const me = await prisma.user.findUnique({
    where: { id: userRes.user.id },
    select: { id: true, email: true },
  });
  if (!me || me.email.toLowerCase() !== invitation.email.toLowerCase()) {
    return NextResponse.json(
      {
        error: "This invitation is for another email address",
        invitedEmail: invitation.email,
      },
      { status: 403 },
    );
  }

  // (Le `alreadyMember` de la version SaaS n'existait ici que pour le quota de
  // sièges, retiré en mono-tenant : il était devenu du code mort. La lecture
  // équivalente vit désormais DANS la transaction, où elle sert vraiment.)
  await prisma.$transaction(async (tx) => {
    const existing = await tx.orgMember.findUnique({
      where: {
        userId_organizationId: {
          userId: me.id,
          organizationId: invitation.organizationId,
        },
      },
      select: { id: true },
    });
    await tx.orgMember.upsert({
      where: {
        userId_organizationId: {
          userId: me.id,
          organizationId: invitation.organizationId,
        },
      },
      create: {
        userId: me.id,
        organizationId: invitation.organizationId,
        role: invitation.role,
      },
      update: { role: invitation.role },
    });
    // #2 — accès projet pré-attribués, seulement à la 1re acceptation.
    // Ce chemin (acceptation depuis le LIEN E-MAIL) ne les appliquait pas alors
    // que les deux autres le font : l'inviteur cochait des projets, l'invité
    // arrivait sans aucun accès, en silence.
    if (!existing) {
      await applyInvitationProjectAccess(
        tx,
        invitation.organizationId,
        invitation.projectAccess,
        me.id,
        invitation.role,
      );
    }
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });
  });

  logAction({
    action: "MEMBER_INVITE_ACCEPT",
    actor: { kind: "user", userId: me.id, email: me.email },
    organizationId: invitation.organizationId,
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: { role: invitation.role },
    req,
  });

  return NextResponse.json({
    ok: true,
    organization: invitation.organization,
  });
}
