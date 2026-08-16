// Jumeau self-host de lib/mobile-policy.ts — résolution d'une policy mobile.
//
// Mono-tenant : pas d'`admin.policies` à interroger d'abord, pas de client
// tenant à ouvrir ensuite. La table `Policy` locale porte tout, et la jointure
// remplace les deux lectures successives de la version SaaS.
//
// ⚠️ La frontière d'autorisation est la MÊME et doit le rester : une policy
// `server` et une policy `mobile` peuvent avoir exactement les mêmes claims
// OIDC (même repo, même workflow, même branche). Seul le `kind` sépare « ce
// pipeline peut lire les secrets d'un environnement » de « ce pipeline peut
// signer une app ». Voir la garde symétrique dans app/api/deploy/route.ts.

import { prisma } from "./prisma";

export type MobilePolicyClaims = {
  provider: string;
  repo: string;
  workflow: string;
  branch: string;
  issuer: string | null;
};

export type MobilePolicyMatch = {
  tenantSlug: string;
  policyId: string;
  project: { id: string; slug: string; organizationId: string };
  app: {
    id: string;
    platform: string;
    bundleId: string;
    displayName: string;
    vendorTeamId: string | null;
    /** Coupe-circuit : true => l'endpoint refuse de servir (403 audité). */
    deployPaused: boolean;
  };
};

/**
 * Résout la policy mobile correspondant à ces claims ET à l'application
 * demandée. `requestedApp` (bundleId ou id) est COMPARÉ à la cible désignée
 * par la policy, jamais utilisé pour la chercher : un pipeline ne choisit pas
 * sa cible, la policy la lui assigne.
 *
 * `tenantSlug` est toujours `null` en self-host — la forme du retour reste
 * celle du SaaS pour que l'appelant soit strictement le même des deux côtés.
 */
export async function resolveMobilePolicy(
  claims: MobilePolicyClaims,
  requestedApp: string,
): Promise<MobilePolicyMatch | null> {
  const wanted = requestedApp.trim();
  if (!wanted) return null;

  const policy = await prisma.policy.findFirst({
    where: {
      kind: "mobile",
      provider: claims.provider,
      repo: claims.repo,
      workflow: claims.workflow,
      branch: claims.branch,
      issuer: claims.issuer,
    },
    select: {
      id: true,
      projectId: true,
      mobileApp: {
        select: {
          id: true,
          platform: true,
          bundleId: true,
          displayName: true,
          vendorTeamId: true,
          deployPaused: true,
          projectId: true,
        },
      },
      project: {
        select: {
          id: true,
          slug: true,
          organizationId: true,
          mobileEnabled: true,
        },
      },
    },
  });

  const app = policy?.mobileApp;
  if (!policy || !app) return null;
  if (app.projectId !== policy.projectId) return null;
  if (wanted !== app.bundleId && wanted !== app.id) return null;
  // Même second verrou que l'interface : l'onglet éteint sur le projet coupe
  // aussi le pipeline, sinon l'interrupteur ne voudrait rien dire.
  if (!policy.project.mobileEnabled) return null;

  return {
    tenantSlug: "",
    policyId: policy.id,
    project: {
      id: policy.project.id,
      slug: policy.project.slug,
      organizationId: policy.project.organizationId,
    },
    app: {
      id: app.id,
      platform: app.platform,
      bundleId: app.bundleId,
      displayName: app.displayName,
      vendorTeamId: app.vendorTeamId,
      deployPaused: app.deployPaused,
    },
  };
}
