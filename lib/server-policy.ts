// Jumeau self-host de lib/server-policy.ts — résolution d'une policy serveur.
//
// Mono-tenant : pas d'`admin.policies` à interroger d'abord, pas de client
// tenant à ouvrir ensuite. La table `Policy` locale porte tout.
//
// ⚠️ La frontière d'autorisation est la MÊME et doit le rester : `kind:
// "server"` sépare « ce pipeline peut lire les secrets d'un environnement » de
// « ce pipeline peut signer une app ». Voir la garde symétrique dans
// app/api/deploy/route.ts.

import { prisma } from "./prisma";

export type ServerPolicyClaims = {
  provider: string;
  repo: string;
  workflow: string;
  branch: string;
  issuer: string | null;
};

export type ServerPolicyMatch = {
  /** Toujours "" en self-host. */
  tenantSlug: string;
  policyId: string;
  project: { id: string; slug: string; organizationId: string };
  environment: { id: string; name: string };
};

export async function resolveServerPolicy(
  claims: ServerPolicyClaims,
  projectSlug: string,
  envName: string,
): Promise<ServerPolicyMatch | null> {
  const policy = await prisma.policy.findFirst({
    where: {
      kind: "server",
      provider: claims.provider,
      issuer: claims.issuer,
      repo: claims.repo,
      workflow: claims.workflow,
      branch: claims.branch,
      project: { slug: projectSlug },
      environment: { name: envName },
    },
    select: {
      id: true,
      project: { select: { id: true, slug: true, organizationId: true } },
      environment: { select: { id: true, name: true } },
    },
  });
  if (!policy || !policy.environment) return null;
  return {
    tenantSlug: "",
    policyId: policy.id,
    project: policy.project,
    environment: policy.environment,
  };
}
