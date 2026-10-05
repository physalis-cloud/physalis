// GET /api/cli/sessions — sessions CLI de l'utilisateur connecté (C-0050).
//
// Alimente le panneau « Sessions CLI » de /account. Ne renvoie JAMAIS le
// tokenHash : seulement de quoi reconnaître et couper une session.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/api";
import { parseAiScope } from "@/lib/cli-ai-scope";

export async function GET() {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const sessions = await prisma.cliSession.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      kind: true,
      scope: true,
      deviceName: true,
      ip: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const now = new Date();
  return NextResponse.json({
    sessions: sessions.map(({ scope, ...s }) => ({
      ...s,
      // Session IA : ce qu'elle peut lire, en `projet/environnement`.
      aiScope:
        s.kind === "AI"
          ? (parseAiScope(scope)?.projects ?? []).flatMap((p) =>
              p.environments.map((e) => `${p.slug}/${e}`),
            )
          : null,
      isActive: !s.revokedAt && s.expiresAt > now,
    })),
  });
}
