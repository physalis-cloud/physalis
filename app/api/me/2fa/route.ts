import { NextResponse } from "next/server";
import { prisma, basePrisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { readJson, requireUser } from "@/lib/api";
import { findBackupCodeIndex, verifyTotp } from "@/lib/totp";
import { logAction } from "@/lib/audit";

/**
 * GET — état 2FA de l'utilisateur courant.
 */
export async function GET() {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;
  // SUPERADMIN platform-level → public.User (cf. setup/route.ts).
  const db = tenantSlug ? prisma : basePrisma;

  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: { twoFactorEnabled: true, backupCodes: true },
  });
  return NextResponse.json({
    enabled: Boolean(dbUser?.twoFactorEnabled),
    backupCodesRemaining: dbUser?.backupCodes.length ?? 0,
  });
}

/**
 * DELETE — désactive la 2FA. Exige un code TOTP valide (ou backup code)
 * pour confirmer l'identité du demandeur.
 */
export async function DELETE(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;
  // SUPERADMIN platform-level → public.User (cf. setup/route.ts).
  const db = tenantSlug ? prisma : basePrisma;

  const body = (await readJson(req)) as { code?: string } | null;
  const code = body?.code?.trim();
  if (!code) {
    return NextResponse.json({ error: "Code requis" }, { status: 400 });
  }

  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: {
      twoFactorEnabled: true,
      twoFactorSecret: true,
      twoFactorIv: true,
      twoFactorTag: true,
      backupCodes: true,
    },
  });
  if (!dbUser?.twoFactorEnabled) {
    return NextResponse.json(
      { error: "2FA n'est pas active." },
      { status: 409 },
    );
  }
  if (!dbUser.twoFactorSecret || !dbUser.twoFactorIv || !dbUser.twoFactorTag) {
    return NextResponse.json(
      { error: "État 2FA incohérent." },
      { status: 500 },
    );
  }

  const secret = decrypt({
    encryptedValue: dbUser.twoFactorSecret,
    iv: dbUser.twoFactorIv,
    tag: dbUser.twoFactorTag,
  });

  let acceptedVia: "totp" | "backup" | null = null;
  if (await verifyTotp(code, secret)) {
    acceptedVia = "totp";
  } else {
    const idx = await findBackupCodeIndex(code, dbUser.backupCodes);
    if (idx >= 0) acceptedVia = "backup";
  }
  if (!acceptedVia) {
    logAction({
      action: "TWO_FACTOR_FAILURE",
      actor: { kind: "user", userId: user.id, email: user.email },
      metadata: { context: "disable" },
      req,
    });
    return NextResponse.json({ error: "Code invalide" }, { status: 401 });
  }

  // Désactivation : on efface tous les champs 2FA + backup codes.
  // #5 — invalide les sessions ANTÉRIEURES à la session courante
  // (sessionsValidFrom = loginAt courant) : coupe une éventuelle session
  // volée plus ancienne sans déconnecter l'utilisateur qui fait l'action.
  // loginAt null (token legacy) → fallback now() ; ce token-là n'est de toute
  // façon pas soumis au check (loginAt null) et expirera sous 8h.
  await db.user.update({
    where: { id: user.id },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorIv: null,
      twoFactorTag: null,
      backupCodes: [],
      sessionsValidFrom: new Date(user.loginAt ?? Date.now()),
    },
  });

  logAction({
    action: "TWO_FACTOR_DISABLED",
    actor: { kind: "user", userId: user.id, email: user.email },
    metadata: { acceptedVia },
    req,
  });

  return NextResponse.json({ ok: true });
}
