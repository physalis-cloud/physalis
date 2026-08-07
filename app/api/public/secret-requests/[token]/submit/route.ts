// /api/secret-requests/[token]/submit
//
// Endpoint public (sans auth). Reçoit le ciphertext + IV + clé publique
// éphémère du tiers. Stocke en base sans pouvoir déchiffrer.
//
// Rate-limit 5/h/IP pour éviter le brute-force sur des tokens devinés.
// Notification email à l'admin (best-effort).
// 410 si déjà soumis / expiré / révoqué (anti-replay sur lien copié-collé).
//
// Jumeau SELF-HOST, trois divergences.
//
// 1. Plus de résolution de tenant : la version SaaS passe par
//    `admin.token_index` pour savoir quel tenant possède le token. Rien
//    n'alimente cette table dans le build → la résolution renvoyait toujours
//    null et l'endpoint était mort. En mono-tenant le `tokenHash` est unique
//    et il n'y a qu'un schéma.
// 2. Plus de SQL brut qualifié `"client_<slug>"` : le client Prisma du build
//    n'a pas d'extension tenant à contourner. L'UPDATE conditionnel devient un
//    `updateMany`, qui reste UNE seule instruction SQL — l'atomicité qui
//    interdit la double soumission est donc conservée telle quelle.
// 3. L'AccessLog est écrit avec le client Prisma (le SaaS devait qualifier
//    jusqu'au type enum `"client_<slug>"."AccessAction"`). On garde une
//    création directe plutôt que `logAction` : la source journalise un acteur
//    SANS `actorUserId` mais AVEC l'email du demandeur, ce que la signature de
//    `logAction` ne sait pas exprimer.
//
// `reviewUrl` pointe sur l'URL canonique de CETTE instance et non sur le
// portail partagé du SaaS — cf. la même correction dans la route de création.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { readJson } from "@/lib/api";
import { physalisBaseUrl } from "@/lib/app-url";
import {
  hashSecretRequestToken,
  isSecretRequestTokenFormat,
} from "@/lib/secret-request";
import { sendSecretReceivedEmail } from "@/lib/email";

type Params = { params: Promise<{ token: string }> };

type Body = {
  ciphertext?: string;
  iv?: string;
  ephemeralPublicJwk?: string;
};

export async function POST(req: Request, { params }: Params) {
  const limited = rateLimit(req, "secret-request-submit", {
    max: 5,
    windowMs: 60 * 60_000,
  });
  if (limited) return limited;

  const { token } = await params;
  if (!isSecretRequestTokenFormat(token)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await readJson(req)) as Body | null;
  if (
    !body ||
    typeof body.ciphertext !== "string" ||
    typeof body.iv !== "string" ||
    typeof body.ephemeralPublicJwk !== "string"
  ) {
    return NextResponse.json(
      { error: "ciphertext, iv and ephemeralPublicJwk are required" },
      { status: 400 },
    );
  }
  // Sanity bounds : un secret raisonnable < 64 KiB en base64.
  if (
    body.ciphertext.length > 100_000 ||
    body.iv.length > 200 ||
    body.ephemeralPublicJwk.length > 1_000
  ) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const tokenHash = hashSecretRequestToken(token);
  const ip = getClientIp(req);
  const submitterIp = ip === "unknown" ? null : ip;

  // UPDATE conditionnel atomique : ne soumet QUE si pending (pas révoqué,
  // pas déjà soumis, pas expiré). `updateMany` compile en UNE instruction SQL,
  // donc la garde anti-double-soumission tient toujours. count === 0 si aucune
  // des conditions n'est remplie → 410 (gone) sans distinction (anti-leak),
  // ce qui couvre aussi le token inconnu.
  const { count } = await prisma.secretRequest.updateMany({
    where: {
      tokenHash,
      revokedAt: null,
      submittedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: {
      encryptedSecret: body.ciphertext,
      secretIv: body.iv,
      ephemeralPublicKey: body.ephemeralPublicJwk,
      submittedAt: new Date(),
      submitterIp,
    },
  });

  if (count === 0) {
    return NextResponse.json({ error: "Gone" }, { status: 410 });
  }

  // Audit + notification email (best-effort, hors transaction)
  const sr = await prisma.secretRequest.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      label: true,
      organizationId: true,
      projectId: true,
      requestedByEmail: true,
    },
  });
  if (sr) {
    await prisma.accessLog
      .create({
        data: {
          action: "SECRET_REQUEST_SUBMITTED",
          organizationId: sr.organizationId,
          projectId: sr.projectId,
          // Pas d'`actorUserId` : le soumissionnaire est un tiers sans compte.
          // L'email conservé est celui du DEMANDEUR, comme dans la source.
          actorUserEmail: sr.requestedByEmail,
          ipAddress: submitterIp,
          targetType: "SecretRequest",
          targetId: sr.id,
          metadata: { label: sr.label, viaPublicLink: true },
        },
      })
      .catch((err) => {
        console.error("[secret-requests] failed to log SUBMITTED:", err);
      });

    sendSecretReceivedEmail({
      to: sr.requestedByEmail,
      label: sr.label,
      submitterIp,
      reviewUrl: `${physalisBaseUrl()}/shares?tab=external#req-${sr.id}`,
    }).catch((err) => {
      console.error("[secret-requests] failed to send received email:", err);
    });
  }

  return NextResponse.json({ ok: true });
}
