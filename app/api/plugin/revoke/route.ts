// POST /api/plugin/revoke  { sessionToken }
//
// Jumeau self-host de la route SaaS. Seule divergence : la garde `!tenantSlug`.
//
// En mono-tenant, `requireUser()` renvoie TOUJOURS `tenantSlug: null` (cf.
// lib/api.ts, où le champ n'existe que pour que le code SaaS coulé verbatim
// compile). La version source court-circuite donc sur cette garde à CHAQUE
// appel et répond `{ ok: true }` sans jamais révoquer : la déconnexion web
// laisserait la session de l'extension vivante, en silence et sans erreur —
// exactement le contraire de ce que la fonctionnalité annonce. Même classe de
// piège que la garde `!tenantSlug` retirée de `rotation/force`.
//
// Le reste est identique à la source, et notamment les deux propriétés qui
// portent la sécurité de la route :
//   - double garde — la session web (`requireUser`) prouve QUI appelle, le
//     contrôle `userId` prouve que le token présenté lui appartient. Sans le
//     second, la route serait un oracle de révocation ;
//   - réponse uniforme (200 `{ ok: true }`) que le token soit inconnu, déjà
//     révoqué ou d'autrui : on ne renseigne pas l'appelant sur l'existence
//     d'un token qu'il présente.
//
// `withTenantSchema` est ici le stub self-host (lib/tenant.ts) : il ignore le
// slug et dégénère en `prisma.$transaction`. Lui passer `null` est donc exact,
// pas un contournement.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api";
import { withTenantSchema } from "@/lib/tenant";
import { logAction } from "@/lib/audit";
import { hashPluginToken, isPluginTokenFormat } from "@/lib/plugin-token";

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const body = (await req.json().catch(() => null)) as {
    sessionToken?: unknown;
  } | null;
  const token =
    typeof body?.sessionToken === "string" ? body.sessionToken : null;

  // Rien d'exploitable → succès silencieux : extension absente, ou session
  // plugin déjà expirée. Le client enchaîne sur la déconnexion web quoi qu'il
  // arrive, il n'a rien à décider de ce retour.
  if (!token || !isPluginTokenFormat(token)) {
    return NextResponse.json({ ok: true });
  }

  const tokenHash = hashPluginToken(token);
  const revokedId = await withTenantSchema(null, async (tx) => {
    const existing = await tx.pluginToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, revokedAt: true },
    });
    // Token d'autrui → on ne touche à rien (cf. oracle ci-dessus). Déjà
    // révoqué → idempotent, pas de second audit.
    if (!existing || existing.userId !== user.id || existing.revokedAt) {
      return null;
    }
    await tx.pluginToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    return existing.id;
  });

  if (revokedId) {
    logAction({
      action: "PLUGIN_TOKEN_REVOKED",
      actor: { kind: "user", userId: user.id, email: user.email },
      targetType: "PluginToken",
      targetId: revokedId,
      metadata: { via: "web_logout" },
      req,
    });
  }

  return NextResponse.json({ ok: true });
}
