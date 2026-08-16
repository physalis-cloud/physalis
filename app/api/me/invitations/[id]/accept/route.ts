// Jumeau SELF-HOST — divergence unique : le contrôle de quota de sièges
// (`checkSeatForOrgAdd`, lib/quotas) est retiré. Les sièges sont une notion de
// l'offre hébergée ; en mono-tenant il n'y a ni plan ni add-on à faire respecter,
// et `lib/quotas.ts` interroge le schéma `admin` qui n'existe pas ici.
// Tout le reste — y compris les gardes d'acceptation d'invitation — est identique.

// POST /api/me/invitations/[id]/accept
//
// L'invite valide une invitation in-app : cree le OrgMember, marque
// l'invitation acceptedAt. Audit `MEMBER_INVITE_ACCEPT`.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { applyInvitationProjectAccess } from "@/lib/invitation-project-access";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;
  const { id } = await params;

  const invitation = await prisma.invitation.findFirst({
    where: {
      id,
      inviteeUserId: user.id,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!invitation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // §2.24b — le quota de sièges n'était vérifié qu'à l'ÉMISSION de l'invitation
  // (les pendantes ne consomment rien) : émettre en SHARED puis downgrade FREE
  // laissait accepter au-delà du quota. On re-vérifie À L'ACCEPTATION — borne
  // dure quel que soit le nombre d'invitations émises. Sauté si l'user est DÉJÀ
  // membre (le siège est déjà consommé, l'accept n'en ajoute pas). `null` = aucun
  // siège consommé (user déjà global rejoignant une org ajoutée).
  const alreadyMember = await prisma.orgMember.findUnique({
    where: {
      userId_organizationId: {
        userId: user.id,
        organizationId: invitation.organizationId,
      },
    },
    select: { id: true },
  });
  // Race-safe : transaction qui cree OrgMember + marque acceptedAt.
  // Si l'user est deja membre (race / double click), on ne crash pas.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.orgMember.findUnique({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: invitation.organizationId,
        },
      },
    });
    if (!existing) {
      await tx.orgMember.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          role: invitation.role,
        },
      });
      // #2 — applique les accès projet pré-attribués (seulement à la 1re
      // acceptation, pas sur une race où l'user est déjà membre).
      await applyInvitationProjectAccess(
        tx,
        invitation.organizationId,
        invitation.projectAccess,
        user.id,
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
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: invitation.organizationId,
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: { role: invitation.role, kind: "in_app" },
    req,
  });

  return NextResponse.json({
    ok: true,
    organizationId: invitation.organizationId,
  });
}
