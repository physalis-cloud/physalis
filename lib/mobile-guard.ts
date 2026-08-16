// Chantier "Déploiement mobile" — interrupteur par projet.
//
// Deux verrous distincts, à ne pas confondre :
//   - la feature de plan `mobile_deploy` (payante, refusée en FREE) ouvre la
//     capacité au TENANT — portée par `opts.feature` sur `requireProjectMember` ;
//   - `Project.mobileEnabled` (défaut false) l'active PROJET PAR PROJET,
//     depuis la modale Paramètres.
//
// Server-only (importe `next/server`) : ne jamais l'importer depuis un
// composant client — cf. l'avertissement en tête de lib/mobile-credentials.ts.

import { NextResponse } from "next/server";

/**
 * Renvoie une 403 si le déploiement mobile est coupé sur ce projet, sinon
 * `null`. À appeler dans CHAQUE route `/mobile/*` juste après le contrôle
 * d'accès : masquer l'onglet côté interface n'est pas une protection.
 */
export function requireProjectMobileEnabled(project: {
  mobileEnabled: boolean;
}): NextResponse | null {
  if (project.mobileEnabled) return null;
  return NextResponse.json(
    {
      error:
        "Le déploiement mobile est désactivé pour ce projet — activez-le dans les paramètres du projet.",
    },
    { status: 403 },
  );
}
