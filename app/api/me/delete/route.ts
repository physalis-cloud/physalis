// Jumeau SELF-HOST de app/api/me/delete/route.ts.
//
// Différence unique avec la version SaaS : la règle B.5 (« la suppression du
// compte CLIENT absorbe les suppressions individuelles ») est retirée. Elle
// s'appuie sur `adminPrisma.client`, or le modèle `Client` n'existe pas en
// mono-tenant — il n'y a pas de tenant à résilier. Conserver ce code casserait
// la compilation du build public.
//
// Tout le reste est identique, et notamment la garde du DERNIER OWNER, qui
// prend ici une importance particulière : sur une instance à utilisateur
// unique, elle est ce qui empêche la seule personne autorisée de se verrouiller
// dehors. Filet supplémentaire si le cas se produisait quand même :
// scripts/bootstrap-admin.mjs recrée un admin depuis l'env quand la table
// `User` est vide.

// Suppression du compte MEMBRE (self-service).
//
// ⚠️ À NE PAS CONFONDRE avec /api/account/delete, qui supprime tout le CLIENT
// (le tenant, toutes orgs et tous membres) et n'est ouvert qu'à l'OWNER de
// l'org principale. Ici, seul le compte de l'appelant disparaît ; le tenant
// continue de vivre. Cf. docs/steps-docs/todo/suppression-compte.md.
//
//   GET  → éligibilité (ce que l'UI doit afficher AVANT d'ouvrir la modale)
//   POST → demande de suppression (action RÉVERSIBLE → phrase à recopier seule)
//
// La suppression définitive immédiate est dans ./now (phrase + ré-auth), et
// l'annulation dans ./cancel.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { reauthMethodFor } from "@/lib/reauth";
import {
  RECOVERY_WINDOW_DAYS,
  daysUntilPurge,
  orgsLeftWithoutOwner,
} from "@/lib/deletion-window";

export const runtime = "nodejs";

/**
 * Orgs que le départ de cet utilisateur laisserait sans propriétaire.
 * Une seule requête groupée plutôt qu'un count par org.
 */
async function blockingOrgs(userId: string) {
  const owned = await prisma.orgMember.findMany({
    where: { userId, role: "OWNER" },
    select: { organization: { select: { id: true, name: true } } },
  });
  if (owned.length === 0) return [];

  const counts = await prisma.orgMember.groupBy({
    by: ["organizationId"],
    where: {
      organizationId: { in: owned.map((o) => o.organization.id) },
      role: "OWNER",
    },
    _count: { _all: true },
  });
  const countById = new Map(counts.map((c) => [c.organizationId, c._count._all]));

  return orgsLeftWithoutOwner(
    owned.map((o) => ({
      id: o.organization.id,
      name: o.organization.name,
      ownerCount: countById.get(o.organization.id) ?? 0,
    })),
  );
}

export async function GET() {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;
  if (!tenantSlug) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      email: true,
      password: true,
      twoFactorEnabled: true,
      deletionRequestedAt: true,
      purgeAt: true,
    },
  });
  if (!me) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }


  const blocking = await blockingOrgs(user.id);

  return NextResponse.json({
    email: me.email,
    // La phrase à recopier : preuve d'INTENTION (pas d'identité).
    confirmPhrase: me.email,
    pending: me.deletionRequestedAt !== null,
    purgeAt: me.purgeAt?.toISOString() ?? null,
    daysRemaining: daysUntilPurge(me.purgeAt),
    recoveryWindowDays: RECOVERY_WINDOW_DAYS,
    // Orgs qui resteraient sans propriétaire → l'UI les NOMME dans la modale
    // au lieu de laisser l'utilisateur se heurter à un refus après coup.
    blockingOrgs: blocking,
    canDelete: blocking.length === 0,
    // Preuve d'identité que ce compte devra fournir pour la suppression
    // IMMÉDIATE (l'UI adapte son formulaire ; le serveur revérifie).
    reauthMethod: reauthMethodFor({
      hasPassword: me.password !== null,
      twoFactorEnabled: me.twoFactorEnabled,
    }),
  });
}

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user, tenantSlug } = userRes;
  if (!tenantSlug) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = rateLimit(
    req,
    "me-delete",
    { max: 5, windowMs: 15 * 60_000 },
    user.id,
  );
  if (limited) return limited;

  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true, deletionRequestedAt: true },
  });
  if (!me) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (me.deletionRequestedAt !== null) {
    return NextResponse.json(
      { error: "Suppression déjà demandée" },
      { status: 409 },
    );
  }


  const blocking = await blockingOrgs(user.id);
  if (blocking.length > 0) {
    return NextResponse.json(
      {
        error: "last_owner",
        organizations: blocking,
      },
      { status: 409 },
    );
  }

  // Preuve d'INTENTION. Pas de preuve d'identité ici : l'action est réversible
  // pendant toute la fenêtre, et une session volée qui la déclencherait ne
  // ferait qu'une nuisance visible et annulable d'un clic.
  const body = (await readJson(req)) as { confirmPhrase?: string } | null;
  if ((body?.confirmPhrase ?? "").trim() !== me.email) {
    return NextResponse.json(
      { error: "La confirmation ne correspond pas" },
      { status: 400 },
    );
  }

  const now = new Date();
  const purgeAt = new Date(
    now.getTime() + RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  await prisma.user.update({
    where: { id: user.id },
    data: { deletionRequestedAt: now, purgeAt },
  });

  logAction({
    action: "USER_ACCOUNT_DELETE_REQUESTED",
    actor: { kind: "user", userId: user.id, email: me.email },
    metadata: {
      purgeAt: purgeAt.toISOString(),
      recoveryWindowDays: RECOVERY_WINDOW_DAYS,
    },
    req,
    tenantSlug,
  });

  return NextResponse.json({ ok: true, purgeAt: purgeAt.toISOString() });
}
