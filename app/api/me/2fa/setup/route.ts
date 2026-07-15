import { NextResponse } from "next/server";
import { prisma, basePrisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { requireUser } from "@/lib/api";
import {
  generateTotpSecret,
  generateOtpauthUrl,
  generateQrDataUrl,
} from "@/lib/totp";

/**
 * Génère un nouveau secret TOTP, le chiffre et le stocke en base avec
 * `twoFactorEnabled: false`. La 2FA n'est activée qu'après confirmation
 * via /api/me/2fa/verify avec un code valide.
 *
 * Si la 2FA est déjà activée, refuse (il faut désactiver d'abord pour
 * éviter de remplacer accidentellement un setup fonctionnel).
 *
 * Retourne le secret en clair (pour la saisie manuelle dans l'app
 * authenticator) + l'URL otpauth + un QR code en data URL.
 */
export async function POST() {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;
  // SUPERADMIN platform-level (tenantSlug=null) vit dans public.User → le
  // client `prisma` scopé tenant throw (pas de contexte). On bascule sur
  // basePrisma (schéma public) pour qu'il puisse gérer sa 2FA comme un tenant.
  const db = tenantSlug ? prisma : basePrisma;

  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: { id: true, email: true, twoFactorEnabled: true },
  });
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (dbUser.twoFactorEnabled) {
    return NextResponse.json(
      { error: "2FA est déjà active. Désactivez-la d'abord pour la reconfigurer." },
      { status: 409 },
    );
  }

  const secret = generateTotpSecret();
  const otpauthUrl = generateOtpauthUrl(dbUser.email, secret);
  const qrDataUrl = await generateQrDataUrl(otpauthUrl);

  const enc = encrypt(secret);
  await db.user.update({
    where: { id: user.id },
    data: {
      twoFactorSecret: enc.encryptedValue,
      twoFactorIv: enc.iv,
      twoFactorTag: enc.tag,
      // twoFactorEnabled reste à false jusqu'à la vérification.
    },
  });

  return NextResponse.json({ secret, otpauthUrl, qrDataUrl });
}
