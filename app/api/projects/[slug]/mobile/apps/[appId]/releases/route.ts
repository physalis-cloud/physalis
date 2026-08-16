// Chantier "Déploiement mobile" — Phase 3 : lire le registre de livraisons.
// Cf. documentation/plans/deploiement-mobile.md §5.3.
//
// « Quelle version est en revue, laquelle est live, qui l'a publiée, avec quel
// certificat » — en un écran, plutôt que dans trois consoles et un canal Slack.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";

type Params = { params: Promise<{ slug: string; appId: string }> };

/** Fenêtre d'historique. Le registre n'est pas une archive : au-delà, c'est le
 *  journal d'audit qui fait foi (il est immuable, celui-ci ne l'est pas). */
const PAGE_SIZE = 50;

export async function GET(_req: Request, { params }: Params) {
  const { slug, appId } = await params;
  // VIEWER suffit : une livraison ne contient aucune valeur secrète, seulement
  // des empreintes et des métadonnées de pipeline. C'est précisément ce qui
  // rend l'écran partageable avec quelqu'un qui n'a pas accès au matériel.
  const access = await requireProjectMember(slug, "VIEWER", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const app = await prisma.mobileApp.findFirst({
    where: { id: appId, projectId: access.project.id },
    select: { id: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const releases = await prisma.mobileRelease.findMany({
    where: { appId: app.id },
    select: {
      id: true,
      track: true,
      versionName: true,
      buildNumber: true,
      status: true,
      statusSource: true,
      statusDetail: true,
      credentialsSha: true,
      ciProvider: true,
      ciRepo: true,
      ciRef: true,
      requestedAt: true,
      reportedAt: true,
    },
    orderBy: { requestedAt: "desc" },
    take: PAGE_SIZE,
  });

  // Le matériel ACTUEL, pour dire si une livraison a été signée par ce qui est
  // en place aujourd'hui — la corrélation du §4.2. Une version live signée par
  // un certificat depuis remplacé est une information qui vaut d'être vue :
  // elle dit qu'on ne peut plus reproduire ce build tel quel.
  const current = await prisma.mobileCredential.findMany({
    where: { appId: app.id },
    select: { kind: true, sha256: true },
  });
  const currentSha = Object.fromEntries(current.map((c) => [c.kind, c.sha256]));

  return NextResponse.json({
    releases: releases.map((r) => ({
      ...r,
      // On ne renvoie PAS les empreintes elles-mêmes à l'interface : elles ne
      // lui servent qu'à répondre « signé par le matériel courant ? ». Le
      // détail complet vit dans le journal d'audit, qui est immuable.
      signedByCurrent: signedByCurrent(r.credentialsSha, currentSha),
      credentialsSha: undefined,
    })),
  });
}

/**
 * La livraison a-t-elle été signée par le matériel actuellement en place ?
 *
 * `null` = pas d'empreintes enregistrées, donc rien à conclure — cas d'une
 * livraison rapportée sans que Physalis ait servi le bundle. Distinct de
 * `false`, qui affirme un désaccord.
 */
function signedByCurrent(
  recorded: unknown,
  current: Record<string, string>,
): boolean | null {
  if (typeof recorded !== "object" || recorded === null) return null;
  const entries = Object.entries(recorded as Record<string, unknown>);
  if (entries.length === 0) return null;
  // On ne compare que les kinds qui SIGNENT. Un mot de passe ou un identifiant
  // texte change sans que le certificat change — les inclure ferait clignoter
  // l'indicateur pour rien.
  const signing = entries.filter(([kind]) =>
    ["ios_p12", "ios_profile", "android_keystore"].includes(kind),
  );
  if (signing.length === 0) return null;
  return signing.every(([kind, sha]) => current[kind] === sha);
}
