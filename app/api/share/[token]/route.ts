// POST /api/share/[token] — consomme un OneTimeShare. Public (le token EST
// l'authentification). Switch GET → POST pour pouvoir transporter le mdp
// dans le body sans laisser fuiter en query string / logs / referer.
//
// Flow :
//   1. POST avec body vide ou `{ password: null }`
//      → si passwordHash null : consume direct
//      → si passwordHash != null : 401 + `{ requiresPassword: true }`
//   2. POST avec `{ password: "..." }`
//      → bcrypt.compare ; mismatch : increment passwordAttempts, audit,
//        retourne 401. Apres 5 echecs → revoke automatique.
//      → match : consume atomique (UPDATE WHERE consumedAt IS NULL),
//        zero ciphertext+iv, audit, email creator, retourne ciphertext+iv.
//
// Rate limit 30/min/IP general + check tentatives mdp par share (max 5
// avant auto-revoke).

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
// Token-based / public route — utilise basePrisma (queries publiques sans tenant
// context). Limitation Phase 5 : tokens stockés dans des schémas tenant ne
// sont pas atteignables ici ; à refondre pour le multi-tenant complet.
import { basePrisma as prisma } from "@/lib/prisma";
import { isShareTokenFormat, hashShareToken } from "@/lib/share-token";
import { logAction } from "@/lib/audit";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { readJson } from "@/lib/api";
import { sendShareConsumedEmail } from "@/lib/email";

export const runtime = "nodejs";

const MAX_PASSWORD_ATTEMPTS = 5;

type Params = { params: Promise<{ token: string }> };
type Body = { password?: string | null };

export async function POST(req: Request, { params }: Params) {
  const limited = rateLimit(req, "share-consume", {
    max: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const { token } = await params;
  if (!isShareTokenFormat(token)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const tokenHash = hashShareToken(token);

  const share = await prisma.oneTimeShare.findUnique({ where: { tokenHash } });
  if (
    !share ||
    share.revokedAt !== null ||
    share.consumedAt !== null ||
    share.expiresAt <= new Date()
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = ((await readJson(req)) as Body | null) ?? {};
  const provided = typeof body.password === "string" ? body.password : null;

  // Gate password si configure.
  if (share.passwordHash !== null) {
    if (provided === null || provided.length === 0) {
      return NextResponse.json(
        { requiresPassword: true },
        { status: 401 },
      );
    }
    // Incrément ATOMIQUE, AVANT le bcrypt (§2.12). L'implémentation précédente
    // écrivait `share.passwordAttempts + 1`, dérivé d'un instantané pris avant
    // ~250 ms de bcrypt, sans verrou : N requêtes concurrentes lisaient toutes
    // N0 et écrivaient N0+1, donc le seuil de 5 ne bornait plus rien. C'est la
    // base qui compte et qui décide, comme le `consume` plus bas.
    const bumped = await prisma.oneTimeShare.update({
      where: { id: share.id },
      data: { passwordAttempts: { increment: 1 } },
      select: { passwordAttempts: true },
    });
    const attempts = bumped.passwordAttempts;
    const revoke = () =>
      prisma.oneTimeShare.update({
        where: { id: share.id },
        data: { revokedAt: new Date(), ciphertext: "", iv: "" },
      });

    // Seuil DÉJÀ dépassé avant cette tentative (course concurrente) : on
    // révoque et on refuse sans même payer le bcrypt.
    if (attempts > MAX_PASSWORD_ATTEMPTS) {
      await revoke();
      return NextResponse.json(
        { requiresPassword: true, attemptsRemaining: 0, revoked: true },
        { status: 401 },
      );
    }

    const ok = await bcrypt.compare(provided, share.passwordHash);
    if (!ok) {
      // Révocation UNIQUEMENT sur échec : un utilisateur légitime qui se trompe
      // 4 fois puis saisit le bon mot de passe au 5e essai doit passer.
      const shouldRevoke = attempts >= MAX_PASSWORD_ATTEMPTS;
      if (shouldRevoke) await revoke();
      logAction({
        action: "SHARE_PASSWORD_FAILURE",
        actor: { kind: "anonymous" },
        organizationId: share.organizationId,
        targetType: "OneTimeShare",
        targetId: share.id,
        metadata: {
          attempts,
          revoked: shouldRevoke,
        },
        req,
      });
      return NextResponse.json(
        {
          requiresPassword: true,
          attemptsRemaining: shouldRevoke
            ? 0
            : MAX_PASSWORD_ATTEMPTS - attempts,
          revoked: shouldRevoke,
        },
        { status: 401 },
      );
    }
  }

  // Atomic consume.
  const ip = getClientIp(req);
  const consumedAt = new Date();
  const result = await prisma.oneTimeShare.updateMany({
    where: {
      id: share.id,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: consumedAt },
    },
    data: {
      consumedAt,
      viewedFromIp: ip,
      ciphertext: "",
      iv: "",
    },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  logAction({
    action: "SHARE_CONSUME",
    actor: { kind: "anonymous" },
    organizationId: share.organizationId,
    targetType: "OneTimeShare",
    targetId: share.id,
    metadata: {
      hasTitle: share.title !== null,
      hasPassword: share.passwordHash !== null,
      createdById: share.createdById,
    },
    req,
  });

  // Email async (best-effort).
  sendShareConsumedEmail({
    to: share.createdByEmail,
    title: share.title,
    createdAt: share.createdAt,
    consumedAt,
    viewedFromIp: ip === "unknown" ? null : ip,
  }).catch((err) => {
    console.error("[share] failed to send consumed email:", err);
  });

  return NextResponse.json({
    ciphertext: share.ciphertext,
    iv: share.iv,
    title: share.title,
  });
}
