import { NextResponse } from "next/server";
import { prisma, basePrisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { readJson, requireUser } from "@/lib/api";
import {
  generateBackupCodes,
  hashBackupCodes,
  verifyTotp,
} from "@/lib/totp";
import { logAction } from "@/lib/audit";

/**
 * Active la 2FA après vérification d'un premier code TOTP fourni par
 * l'utilisateur. Si OK, génère 8 backup codes plaintext (retournés UNE
 * SEULE FOIS dans la réponse), les hash bcrypt, et marque enabled=true.
 *
 * Pré-requis : un secret a déjà été stocké via /api/me/2fa/setup.
 */
export async function POST(req: Request) {
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
    },
  });
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (dbUser.twoFactorEnabled) {
    return NextResponse.json(
      { error: "2FA déjà active." },
      { status: 409 },
    );
  }
  if (!dbUser.twoFactorSecret || !dbUser.twoFactorIv || !dbUser.twoFactorTag) {
    return NextResponse.json(
      { error: "Aucun setup en cours. Appelez /api/me/2fa/setup d'abord." },
      { status: 400 },
    );
  }

  const secret = decrypt({
    encryptedValue: dbUser.twoFactorSecret,
    iv: dbUser.twoFactorIv,
    tag: dbUser.twoFactorTag,
  });

  // §2.17 — pas d'`afterTimeStep` ici (aucun pas antérieur à l'enrôlement), mais on
  // capture le `timeStep` pour INITIALISER la base anti-rejeu : sans ça, le code qui
  // vient d'activer la 2FA resterait rejouable ~90 s sur un login/plugin.
  const totpRes = await verifyTotp(code, secret);
  if (!totpRes.valid) {
    logAction({
      action: "TWO_FACTOR_FAILURE",
      actor: { kind: "user", userId: user.id, email: user.email },
      metadata: { context: "verify_setup" },
      req,
    });
    return NextResponse.json({ error: "Code invalide" }, { status: 401 });
  }

  // Code valide → génération + hash des backup codes + activation.
  const plainBackupCodes = generateBackupCodes();
  const hashes = await hashBackupCodes(plainBackupCodes);

  await db.user.update({
    where: { id: user.id },
    data: {
      twoFactorEnabled: true,
      backupCodes: hashes,
      lastTotpTimeStep: totpRes.timeStep,
    },
  });

  logAction({
    action: "TWO_FACTOR_ENABLED",
    actor: { kind: "user", userId: user.id, email: user.email },
    metadata: { backupCodesCount: plainBackupCodes.length },
    req,
  });

  return NextResponse.json({
    ok: true,
    backupCodes: plainBackupCodes,
  });
}
