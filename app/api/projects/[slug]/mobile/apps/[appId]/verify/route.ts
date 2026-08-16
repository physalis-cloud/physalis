// Chantier "Déploiement mobile" — Phase 2 : validation d'accréditation.
// Cf. documentation/plans/deploiement-mobile.md §7.
//
// Geste EXPLICITE et à la demande, jamais automatique : il déclenche des appels
// sortants vers Google et Apple avec les clés du client. Le mettre sur le chemin
// de l'import (ou pire, du déploiement) reproduirait le piège déjà évité pour le
// numéro de build §4.5 — une console qui tousse ne doit jamais empêcher de
// déposer un credential ni de publier.
//
// POST (et non GET) pour trois raisons : l'appel a des effets de bord distants
// (un edit Play ouvert puis supprimé), il est audité, et il est rate-limité.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";
import { verifyMobileApp } from "@/lib/mobile-verify";

type Params = { params: Promise<{ slug: string; appId: string }> };

/** Une vérification = jusqu'à quatre appels sortants. Large pour un usage
 *  humain normal, assez serré pour que la route ne devienne pas un moyen de
 *  faire marteler l'API de Google depuis nos IP. */
const VERIFY_LIMIT = { max: 20, windowMs: 5 * 60_000 };

export async function POST(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  // EDITOR, comme l'import : vérifier révèle le périmètre d'une clé (nom de
  // l'app chez Apple, pistes ouvertes chez Google, alias du keystore). Ce n'est
  // pas de la donnée de lecture publique du projet.
  const access = await requireProjectMember(slug, "EDITOR", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const limited = rateLimit(req, "mobile-verify", VERIFY_LIMIT);
  if (limited) return limited;

  const app = await prisma.mobileApp.findFirst({
    where: { id: appId, projectId: access.project.id },
    select: { id: true, platform: true, bundleId: true, vendorTeamId: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const report = await verifyMobileApp(prisma, app);

  // Métadonnées d'audit : le COMPTE par statut, jamais un constat verbatim —
  // certains portent le sujet d'un certificat ou l'e-mail d'un compte de
  // service, qui n'ont rien à faire dans un journal consultable par l'org.
  const tally = report.checks.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});

  logAction({
    action: "MOBILE_CREDENTIAL_VERIFY",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileApp",
    targetId: app.id,
    metadata: { platform: app.platform, network: report.network, ...tally },
    req,
  });

  return NextResponse.json({ report });
}
