// /api/secret-requests/[id]/reveal
//
// Retourne le ciphertext + IV + clé publique éphémère pour permettre à
// l'admin de déchiffrer LOCALEMENT dans son navigateur (avec sa clé
// privée). Le serveur ne déchiffre rien.
//
// Met à jour viewedAt à la première révélation. Audit SECRET_REQUEST_REVEALED.

import { ORG_DEV_PLUS_ROLES } from "@/lib/roles";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { effectiveProjectRole } from "@/lib/project-access";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { id } = await params;

  const sr = await prisma.secretRequest.findUnique({
    where: { id },
    select: {
      id: true,
      label: true,
      requestedById: true,
      organizationId: true,
      organization: {
        select: {
          members: {
            where: {
              userId: userRes.user.id,
              role: { in: ORG_DEV_PLUS_ROLES },
            },
            select: { role: true },
          },
        },
      },
      projectId: true,
      // §2.16 — ligne ProjectMember du user, pour appliquer `hidden` (cf. GET/DELETE).
      project: {
        select: {
          members: {
            where: { userId: userRes.user.id },
            select: { role: true, hidden: true },
          },
        },
      },
      encryptedSecret: true,
      secretIv: true,
      ephemeralPublicKey: true,
      submittedAt: true,
      revokedAt: true,
      viewedAt: true,
      expiresAt: true,
    },
  });
  if (!sr) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Le PROPRIÉTAIRE révèle toujours SA demande (clé destinée à lui) ; sinon
  // DEV+ requis dans l'org (feature ouverte aux membres pour leurs demandes).
  if (sr.requestedById !== userRes.user.id) {
    if (sr.organization.members.length === 0) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // §2.16 — projet scopé : un DEV masqué du projet n'a pas accès (règle 1 pour
    // OrgADMIN/OWNER, `hidden` bloquant pour DEV). Sinon /reveal pollue l'audit
    // (`viewedAt`) d'une demande d'un projet que l'UI lui ferme.
    if (sr.projectId && sr.project) {
      const row = sr.project.members[0] ?? null;
      const effective = effectiveProjectRole({
        orgRole: sr.organization.members[0].role,
        membership: row ? { role: row.role, hidden: row.hidden } : null,
      });
      if (effective === null) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  }
  if (sr.revokedAt) {
    return NextResponse.json({ error: "Revoked" }, { status: 410 });
  }
  if (
    !sr.encryptedSecret ||
    !sr.secretIv ||
    !sr.ephemeralPublicKey ||
    !sr.submittedAt
  ) {
    return NextResponse.json(
      { error: "Secret not yet submitted" },
      { status: 404 },
    );
  }

  // Marque la première révélation (timestamp utile pour l'audit UI).
  if (!sr.viewedAt) {
    await prisma.secretRequest.update({
      where: { id: sr.id },
      data: { viewedAt: new Date() },
    });
  }

  logAction({
    action: "SECRET_REQUEST_REVEALED",
    actor: { kind: "user", userId: userRes.user.id, email: userRes.user.email },
    organizationId: sr.organizationId,
    projectId: sr.projectId,
    targetType: "SecretRequest",
    targetId: sr.id,
    metadata: { label: sr.label, firstReveal: !sr.viewedAt },
    req,
  });

  return NextResponse.json({
    encryptedSecret: sr.encryptedSecret,
    iv: sr.secretIv,
    ephemeralPublicJwk: sr.ephemeralPublicKey,
  });
}
