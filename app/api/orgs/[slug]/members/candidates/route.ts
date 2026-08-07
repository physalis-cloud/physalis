// GET /api/orgs/[slug]/members/candidates
//
// Liste les users invitables in-app a l'org cible :
//   = users qui partagent au moins une AUTRE org avec moi
//     (= les gens que je connais via la plateforme)
//   ∩ pas deja membre de l'org cible
//   ∩ pas deja invite (email OU in-app, encore valide)
//   - moi-meme exclus
//
// OrgADMIN+ uniquement (pareil que POST /members).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOrgMember } from "@/lib/api";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireOrgMember(slug, "ADMIN", { feature: "multi_users" });
  if ("error" in access) return access.error;

  // Mes orgs (autres que l'org cible).
  const myOrgs = await prisma.orgMember.findMany({
    where: { userId: access.user.id },
    select: { organizationId: true },
  });
  const myOrgIds = myOrgs
    .map((m) => m.organizationId)
    .filter((id) => id !== access.organization.id);

  if (myOrgIds.length === 0) {
    return NextResponse.json({ candidates: [] });
  }

  // Users membres de mes autres orgs.
  const otherOrgMembers = await prisma.orgMember.findMany({
    where: { organizationId: { in: myOrgIds } },
    select: {
      user: { select: { id: true, email: true } },
      organization: { select: { name: true, slug: true } },
    },
  });

  // Membres deja dans l'org cible (a exclure).
  const targetMembers = await prisma.orgMember.findMany({
    where: { organizationId: access.organization.id },
    select: { userId: true },
  });
  const targetMemberIds = new Set(targetMembers.map((m) => m.userId));

  // Invitations en cours (a exclure).
  const pendingInv = await prisma.invitation.findMany({
    where: {
      organizationId: access.organization.id,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { email: true, inviteeUserId: true },
  });
  const pendingInviteeIds = new Set(
    pendingInv.map((i) => i.inviteeUserId).filter(Boolean) as string[],
  );
  const pendingEmails = new Set(pendingInv.map((i) => i.email.toLowerCase()));

  // Dedup par userId, conserver les sources orgs pour l'UI ("vu dans X").
  const byUserId = new Map<
    string,
    {
      id: string;
      email: string;
      sharedOrgs: { name: string; slug: string }[];
    }
  >();
  for (const m of otherOrgMembers) {
    if (m.user.id === access.user.id) continue; // moi-meme
    if (targetMemberIds.has(m.user.id)) continue; // deja membre de la cible
    if (pendingInviteeIds.has(m.user.id)) continue; // deja invite in-app
    if (pendingEmails.has(m.user.email.toLowerCase())) continue; // deja invite par email
    const existing = byUserId.get(m.user.id);
    if (existing) {
      existing.sharedOrgs.push(m.organization);
    } else {
      byUserId.set(m.user.id, {
        id: m.user.id,
        email: m.user.email,
        sharedOrgs: [m.organization],
      });
    }
  }

  const candidates = Array.from(byUserId.values()).sort((a, b) =>
    a.email.localeCompare(b.email),
  );

  return NextResponse.json({ candidates });
}
