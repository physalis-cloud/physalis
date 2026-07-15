import { prisma } from "@/lib/prisma";

// Lien URL d'un AppAccount : XOR environnement (frontend) / service (backend),
// les deux appartenant au projet. Retourne les champs à écrire, ou une erreur.
// Appelé dans un contexte tenant (search_path déjà entré par requireProjectMember).
export async function resolveAccountLink(
  projectId: string,
  body: { environmentId?: string | null; serviceId?: string | null },
): Promise<{ environmentId: string | null; serviceId: string | null } | { error: string }> {
  const envId = body.environmentId || null;
  const svcId = body.serviceId || null;
  if (envId && svcId) {
    return { error: "Un compte est lié à un environnement OU un service, pas les deux." };
  }
  if (envId) {
    const env = await prisma.environment.findFirst({ where: { id: envId, projectId }, select: { id: true } });
    if (!env) return { error: "Environnement introuvable dans ce projet." };
    return { environmentId: envId, serviceId: null };
  }
  if (svcId) {
    const svc = await prisma.service.findFirst({ where: { id: svcId, projectId }, select: { id: true } });
    if (!svc) return { error: "Service introuvable dans ce projet." };
    return { environmentId: null, serviceId: svcId };
  }
  return { environmentId: null, serviceId: null };
}

// Forme du lien pour l'affichage (liste/reveal) à partir des relations chargées.
export function accountLinkView(account: {
  environment: { name: string; url: string | null } | null;
  service: { name: string; url: string | null } | null;
}): { linkType: "environment" | "service" | null; linkName: string | null; url: string | null } {
  if (account.environment) {
    return { linkType: "environment", linkName: account.environment.name, url: account.environment.url };
  }
  if (account.service) {
    return { linkType: "service", linkName: account.service.name, url: account.service.url };
  }
  return { linkType: null, linkName: null, url: null };
}
