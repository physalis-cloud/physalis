// GET /api/plugin/tokens
//
// Liste les PluginTokens actifs du user connecte (session web NextAuth).
// Utilise par la section "Sessions plugin" de /account pour
// permettre a l'utilisateur de revoquer ses sessions extension.
//
// Ne renvoie JAMAIS le tokenHash ni le brut — l'UI affiche uniquement
// les metadonnees pour identifier la session.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";

export async function GET() {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const tokens = await prisma.pluginToken.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      userAgent: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();
  return NextResponse.json({
    tokens: tokens.map((t) => ({
      id: t.id,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      lastUsedAt: t.lastUsedAt,
      revokedAt: t.revokedAt,
      userAgent: t.userAgent,
      isActive: !t.revokedAt && t.expiresAt > now,
    })),
  });
}
