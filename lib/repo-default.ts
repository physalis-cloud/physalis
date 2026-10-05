// Chantier C-0051 — dépôt GitHub par défaut d'un projet (retour utilisateur du
// 2026-10-03) : `<owner>/<slug du projet>`, où l'owner est l'« utilisateur
// registry » de la connexion CI (le compte ou l'organisation GHCR).
//
// GitHub seulement : pour GitLab, l'utilisateur registry n'est pas un namespace
// de projet ; pour Bitbucket, le dépôt est désigné par un UUID.

import { decrypt } from "./crypto";
import { CI_SECRET_KIND } from "./ci-connection";

/** Noms de compte/organisation GitHub : alphanumériques et tirets, 39 max. */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function defaultGithubRepo(owner: string | null, slug: string): string | null {
  const o = (owner ?? "").trim();
  return GITHUB_OWNER.test(o) && slug ? `${o}/${slug}` : null;
}

type Db = {
  ciConnection: { findFirst(args: unknown): Promise<unknown> };
};

/**
 * Utilisateur registry d'une connexion GitHub de l'organisation donnée.
 * Bornée à l'org : un id de connexion d'une autre organisation ne rend rien.
 */
export async function connectionRegistryOwner(
  db: Db,
  connectionId: string,
  organizationId: string,
): Promise<string | null> {
  const conn = (await db.ciConnection.findFirst({
    where: { id: connectionId, organizationId, provider: "github" },
    select: {
      secrets: {
        where: { kind: CI_SECRET_KIND.registryUser },
        select: { encryptedValue: true, iv: true, tag: true },
      },
    },
  })) as { secrets: { encryptedValue: string; iv: string; tag: string }[] } | null;
  const s = conn?.secrets[0];
  if (!s) return null;
  try {
    return decrypt(s);
  } catch {
    return null;
  }
}
