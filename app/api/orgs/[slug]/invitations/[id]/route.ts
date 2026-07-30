// DELETE /api/orgs/[slug]/invitations/[id] — revoque une invitation en
// attente cote org (annulation par un admin, ex : mauvais email,
// changement d'avis, doublon). N'agit que sur les invitations pending.
// Une invitation deja acceptee → 404 (anti-leak, et de toutes facons
// supprimer une invitation acceptee ne supprime pas le membership).
//
// RBAC : ADMIN+ orga (meme regle que la creation, cf. POST /members).
//
// Audit : action MEMBER_INVITE avec metadata.revoke = true.
// (On reutilise l'action existante avec metadata plutot que d'ajouter
//  une nouvelle valeur a l'enum AccessAction — meme strategie que pour
//  SECRET_BULK_IMPORT.)

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOrgMember } from "@/lib/api";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; id: string }> };

export async function DELETE(req: Request, { params }: Params) {
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

  // §2.25f — seul un OWNER gère les invitations OWNER (miroir création/resend) :
  // un ADMIN ne peut pas annuler une invitation OWNER émise par un OWNER.
  if (invitation.role === "OWNER" && access.role !== "OWNER") {
    return NextResponse.json(
      { error: "Only OWNERs can revoke OWNER invitations" },
      { status: 403 },
    );
  }

  await prisma.invitation.delete({ where: { id: invitation.id } });

  logAction({
    action: "MEMBER_INVITE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: {
      email: invitation.email,
      role: invitation.role,
      kind: invitation.inviteeUserId ? "in_app" : "email",
      revoke: true,
    },
    req,
  });

  return NextResponse.json({ ok: true });
}
