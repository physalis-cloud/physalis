// POST /api/me/delete/now — suppression DÉFINITIVE et immédiate de son compte.
//
// Jumeau SELF-HOST : la garde `if (!tenantSlug) → 401` est retirée. En
// mono-tenant `requireUser()` renvoie TOUJOURS `tenantSlug: null` (cf.
// lib/api.ts : le champ n'existe que pour que le code SaaS coulé verbatim
// compile), donc elle était vraie à chaque appel — la suppression immédiate
// répondait 401 sur toute instance auto-hébergée. Les DEUX contrôles réels
// ci-dessous (phrase + ré-auth) sont intacts : c'est eux qui protègent
// l'action, pas cette garde qui ne parlait que du contexte tenant.
//
// Seule action de ce parcours qui soit irréversible : elle exige donc les DEUX
// contrôles (cf. docs/steps-docs/todo/suppression-compte.md) —
//   • la phrase à recopier    → prouve l'INTENTION (défend contre l'accident) ;
//   • la ré-authentification  → prouve l'IDENTITÉ  (défend contre l'usurpation).
// La phrase seule ne suffirait pas : elle est affichée à l'écran, donc lisible
// et recopiable par quiconque détient une session volée.
//
// Ce que la suppression emporte est entièrement décrit par le schéma (Cascade
// vs SetNull sur les FK vers User) : le coffre personnel, les appartenances et
// les tokens meurent ; la donnée de l'org survit avec sa paternité effacée, et
// le journal d'audit reste intègre (`actorUserId` → SetNull, `actorUserEmail`
// dénormalisé). Voir §B.4 du plan pour les deux cascades assumées
// (invitations envoyées, partages one-time créés).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { verifyReauth } from "@/lib/reauth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;

  // Borne PAR USER : la vérification coûte un bcrypt (~2 s CPU) et un essai de
  // backup code, donc la route est un amplificateur DoS si on la laisse nue.
  const limited = rateLimit(
    req,
    "me-delete-now",
    { max: 5, windowMs: 15 * 60_000 },
    user.id,
  );
  if (limited) return limited;

  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      email: true,
      password: true,
      twoFactorEnabled: true,
      twoFactorSecret: true,
      twoFactorIv: true,
      twoFactorTag: true,
      backupCodes: true,
      lastTotpTimeStep: true,
      deletionRequestedAt: true,
    },
  });
  if (!me) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  // La suppression immédiate est un RACCOURCI de la fenêtre, pas une porte
  // d'entrée : il faut avoir demandé la suppression d'abord. Cela garantit
  // qu'un export a été proposé et qu'un e-mail est parti.
  if (me.deletionRequestedAt === null) {
    return NextResponse.json(
      { error: "Aucune suppression en cours" },
      { status: 409 },
    );
  }

  const body = (await readJson(req)) as {
    confirmPhrase?: string;
    password?: string;
    code?: string;
  } | null;

  // 1. Preuve d'INTENTION.
  if ((body?.confirmPhrase ?? "").trim() !== me.email) {
    return NextResponse.json(
      { error: "La confirmation ne correspond pas" },
      { status: 400 },
    );
  }

  // 2. Preuve d'IDENTITÉ, selon le palier applicable au compte.
  const reauth = await verifyReauth({
    user: me,
    loginAt: user.loginAt ?? null,
    proof: { password: body?.password, code: body?.code },
    updateMany: (a) => prisma.user.updateMany(a),
    consumeBackupCode: async (userId, hash) => {
      // §2.20c — retrait ATOMIQUE : deux consommations concurrentes de codes
      // DIFFÉRENTS ne doivent pas laisser le code du « perdant » valide.
      await prisma.$executeRaw`UPDATE "User" SET "backupCodes" = array_remove("backupCodes", ${hash}) WHERE "id" = ${userId}`;
    },
  });
  if (!reauth.ok) {
    logAction({
      action: "TWO_FACTOR_FAILURE",
      actor: { kind: "user", userId: me.id, email: me.email },
      metadata: { context: "account_delete_now", reason: reauth.reason },
      req,
      tenantSlug,
    });
    return NextResponse.json(
      { error: reauth.reason, method: reauth.method },
      { status: reauth.status },
    );
  }

  // 3. Journaliser AVANT de supprimer : `actorUserId` passera à NULL par la
  //    FK SetNull, mais `actorUserEmail` est dénormalisé — c'est la seule trace
  //    qu'il restera de ce compte, et elle doit exister.
  await logAction({
    action: "USER_ACCOUNT_DELETED",
    actor: { kind: "user", userId: me.id, email: me.email },
    metadata: { trigger: "self_service_immediate", reauthMethod: reauth.method },
    req,
    tenantSlug,
  });

  await prisma.user.delete({ where: { id: me.id } });

  return NextResponse.json({ ok: true });
}
