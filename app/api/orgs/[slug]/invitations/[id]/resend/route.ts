// POST /api/orgs/[slug]/invitations/[id]/resend — regenere le token d'une
// invitation en attente et renvoie l'email. Cas d'usage : invitation
// expiree (cul-de-sac sans cette route) OU email perdu en route (spam).
//
// Comportement :
//   - RBAC : ADMIN+ orga (meme regle que la creation).
//   - Cible : invitation pending (acceptedAt = null) appartenant a l'org.
//     Une invitation deja acceptee est rejetee en 404 (anti-leak).
//   - Nouveau token genere + hash → invalide implicitement l'ancien lien
//     (le tokenHash en base change, donc le vieux lien ne matchera plus).
//   - expiresAt rafraichi a now + INVITATION_TTL_MS (sinon resend
//     immediatement re-expire pour une invitation deja expiree).
//   - Audit : action MEMBER_INVITE avec metadata.resend = true.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOrgMember } from "@/lib/api";
import {
  buildAcceptUrl,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_MS,
} from "@/lib/invitations";
import { sendInvitationEmail } from "@/lib/email";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { slug, id } = await params;
  const access = await requireOrgMember(slug, "ADMIN");
  if ("error" in access) return access.error;

  const invitation = await prisma.invitation.findFirst({
    where: {
      id,
      organizationId: access.organization.id,
      acceptedAt: null,
    },
    select: { id: true, email: true, role: true, inviteeUserId: true },
  });
  if (!invitation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // §2.25f — même règle que la création (`members/route.ts`) : seul un OWNER gère
  // les invitations OWNER. Sans ça, un ADMIN ranimait une invitation OWNER (même
  // expirée) vers une adresse qu'il contrôle → escalade ADMIN→OWNER à l'acceptation.
  if (invitation.role === "OWNER" && access.role !== "OWNER") {
    return NextResponse.json(
      { error: "Only OWNERs can resend OWNER invitations" },
      { status: 403 },
    );
  }

  // Une invitation in-app (inviteeUserId != null) n'envoie pas d'email :
  // l'invite la voit dans son dashboard. Pas grand chose a "resend" dans
  // ce cas. On rafraichit quand meme l'expiration + on regenere le token
  // (cas : expiration depassee et user veut prolonger).
  const isInApp = invitation.inviteeUserId !== null;

  const newToken = generateInvitationToken();
  const newTokenHash = hashInvitationToken(newToken);
  const newExpiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { tokenHash: newTokenHash, expiresAt: newExpiresAt },
  });

  logAction({
    action: "MEMBER_INVITE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: {
      email: invitation.email,
      role: invitation.role,
      kind: isInApp ? "in_app" : "email",
      resend: true,
    },
    req,
  });

  if (!isInApp) {
    try {
      const inviter = await prisma.user.findUnique({
        where: { id: access.user.id },
        select: { email: true },
      });
      await sendInvitationEmail({
        to: invitation.email,
        inviterEmail: inviter?.email ?? "(unknown)",
        organizationName: access.organization.name,
        acceptUrl: buildAcceptUrl(newToken, null),
        expiresAt: newExpiresAt,
      });
    } catch (err) {
      console.error("[invitation] resend email delivery failed:", err);
    }
  }

  return NextResponse.json({
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: newExpiresAt,
    },
    emailSent: !isInApp,
  });
}
