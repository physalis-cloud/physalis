// /api/secret-requests/[id]
//
// GET    : détail (sans déchiffrer le secret — celui-ci sort uniquement
//          via /reveal en encryptedSecret base64)
// DELETE : révoque (efface encryptedSecret/iv/ephemeralPublicKey)

import { ORG_DEV_PLUS_ROLES } from "@/lib/roles";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { deleteTokenIndex } from "@/lib/token-index";
import { deriveStatus } from "@/lib/secret-request";
import { effectiveProjectRole } from "@/lib/project-access";

type Params = { params: Promise<{ id: string }> };

async function loadAndAssertAccess(id: string, userId: string) {
  const sr = await prisma.secretRequest.findUnique({
    where: { id },
    select: {
      id: true,
      tokenHash: true,
      label: true,
      description: true,
      requestedById: true,
      requestedByEmail: true,
      recipientEmail: true,
      organizationId: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          members: {
            where: { userId, role: { in: ORG_DEV_PLUS_ROLES } },
            select: { role: true },
          },
        },
      },
      projectId: true,
      project: {
        select: {
          name: true,
          slug: true,
          // §2.16 — la ligne ProjectMember du user, pour appliquer `hidden`.
          members: { where: { userId }, select: { role: true, hidden: true } },
        },
      },
      environmentName: true,
      secretKey: true,
      publicKeyJwk: true,
      encryptedSecret: true,
      secretIv: true,
      ephemeralPublicKey: true,
      submittedAt: true,
      submitterIp: true,
      viewedAt: true,
      importedAt: true,
      revokedAt: true,
      expiresAt: true,
      createdAt: true,
    },
  });
  if (!sr) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  // Le PROPRIÉTAIRE de la demande y accède toujours (il l'a créée, la clé lui
  // est destinée) — indépendamment de son rôle org/projet actuel. La feature est
  // ouverte aux membres, qui doivent voir/révoquer LEURS demandes.
  if (sr.requestedById === userId) return { sr };
  if (sr.organization.members.length === 0) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  // §2.16 — pour une demande scopée à un projet, le rôle d'org DEV+ ne suffit
  // pas : un DEV masqué du projet n'y a aucun accès (GET fuite les métadonnées,
  // DELETE détruit le ciphertext). OrgADMIN/OWNER ignorent `hidden` (règle 1).
  if (sr.projectId && sr.project) {
    const row = sr.project.members[0] ?? null;
    const effective = effectiveProjectRole({
      orgRole: sr.organization.members[0].role,
      membership: row ? { role: row.role, hidden: row.hidden } : null,
    });
    if (effective === null) {
      return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
  }
  return { sr };
}

export async function GET(_req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { id } = await params;
  const access = await loadAndAssertAccess(id, userRes.user.id);
  if ("error" in access) return access.error;
  const { sr } = access;
  return NextResponse.json({
    request: {
      ...sr,
      // Ne pas leak le tokenHash ni le encrypted blob via le détail
      // (le encrypted ne sort que via /reveal explicite avec audit).
      tokenHash: undefined,
      encryptedSecret: sr.encryptedSecret ? true : null,
      secretIv: undefined,
      ephemeralPublicKey: undefined,
      status: deriveStatus(sr),
    },
  });
}

export async function DELETE(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { id } = await params;
  const access = await loadAndAssertAccess(id, userRes.user.id);
  if ("error" in access) return access.error;
  const { sr } = access;

  await prisma.secretRequest.update({
    where: { id: sr.id },
    data: {
      revokedAt: new Date(),
      // Efface le ciphertext + iv + clé éphémère (cf. spec §Sécurité ligne 339).
      encryptedSecret: null,
      secretIv: null,
      ephemeralPublicKey: null,
    },
  });

  // Cleanup admin.token_index — le lien public devient 404 immédiatement.
  await deleteTokenIndex(sr.tokenHash).catch((err) => {
    console.error("[secret-requests] failed to delete token_index:", err);
  });

  logAction({
    action: "SECRET_REQUEST_REVOKED",
    actor: { kind: "user", userId: userRes.user.id, email: userRes.user.email },
    organizationId: sr.organizationId,
    projectId: sr.projectId,
    targetType: "SecretRequest",
    targetId: sr.id,
    metadata: { label: sr.label, hadSubmittedSecret: Boolean(sr.submittedAt) },
    req,
  });

  return NextResponse.json({ ok: true });
}
