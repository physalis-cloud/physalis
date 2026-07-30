import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/password-hash";
import { prisma } from "@/lib/prisma";
import { hashInvitationToken } from "@/lib/invitations";
import { applyInvitationProjectAccess } from "@/lib/invitation-project-access";
import { rateLimit } from "@/lib/rate-limit";
import { logAction } from "@/lib/audit";
import { readJson } from "@/lib/api";

type Params = { params: Promise<{ token: string }> };

/**
 * Register a new user account and accept an invitation in one transaction.
 *
 * The invitation token authorizes the email — no `ALLOW_REGISTRATION` check.
 * The new user joins ONLY the inviting org (no personal org is auto-created;
 * they can create one later via the switcher).
 *
 * If a user with the invitation's email already exists, returns 409 — the
 * client should redirect to login + the existing acceptance flow.
 */
export async function POST(req: Request, { params }: Params) {
  // Modest rate-limit (token is the real auth gate; this just guards against
  // abuse if a token were leaked).
  const limited = rateLimit(req, "invitation-register", {
    max: 5,
    windowMs: 60 * 60_000,
  });
  if (limited) return limited;

  const { token } = await params;

  const body = (await readJson(req)) as { password?: string } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters" },
      { status: 400 },
    );
  }

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    include: {
      organization: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
    return NextResponse.json(
      { error: "Invitation invalid or expired" },
      { status: 404 },
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email: invitation.email },
  });
  if (existing) {
    return NextResponse.json(
      {
        error:
          "Un compte existe deja avec cet email. Connectez-vous puis acceptez l'invitation.",
      },
      { status: 409 },
    );
  }

  const hash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email: invitation.email, password: hash },
      select: { id: true, email: true },
    });
    await tx.orgMember.create({
      data: {
        userId: created.id,
        organizationId: invitation.organizationId,
        role: invitation.role,
      },
    });
    // #2 — applique les accès projet pré-attribués à l'invitation.
    await applyInvitationProjectAccess(
      tx,
      invitation.organizationId,
      invitation.projectAccess,
      created.id,
    );
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });
    return created;
  });

  logAction({
    action: "MEMBER_INVITE_ACCEPT",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: invitation.organizationId,
    targetType: "Invitation",
    targetId: invitation.id,
    metadata: { role: invitation.role, viaRegister: true },
    req,
  });

  return NextResponse.json({
    ok: true,
    organization: invitation.organization,
  });
}
