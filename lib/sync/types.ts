// Couche de synchronisation SORTANTE des secrets vers des plateformes externes
// (Vercel en Phase B1, puis Render/Railway). À l'inverse de l'OIDC entrant
// (/api/deploy), ici Physalis pousse activement les secrets déchiffrés vers
// l'API de la plateforme à chaque modification. Cf. lib/sync/dispatch.ts.
//
// La connexion (token) réutilise CiConnection / CiConnectionSecret (onglet CI/CD
// org) : un provider de sync est un provider de CiConnection (ex. "vercel") dont
// le token vit dans un CiConnectionSecret de `kind` ci-dessous.

/** Providers de sync sortante (≠ providers OIDC github/gitlab/bitbucket). */
export const SYNC_PROVIDERS = ["vercel", "render", "railway"] as const;
export type SyncProvider = (typeof SYNC_PROVIDERS)[number];

/** Vrai si `provider` est une plateforme de sync sortante (pas un provider OIDC). */
export function isSyncProvider(provider: string): provider is SyncProvider {
  return (SYNC_PROVIDERS as readonly string[]).includes(provider);
}

/** `kind` du CiConnectionSecret portant le token de chaque plateforme. */
export const SYNC_TOKEN_KIND: Record<SyncProvider, string> = {
  vercel: "vercel_token",
  render: "render_token",
  railway: "railway_token",
};

/** `kind` du token pour un provider de sync, ou null si provider inconnu. */
export function syncTokenKind(provider: string): string | null {
  return isSyncProvider(provider) ? SYNC_TOKEN_KIND[provider] : null;
}

/** Targets natifs Vercel (mapping depuis un environnement Physalis). */
export const VERCEL_TARGETS = ["production", "preview", "development"] as const;

/**
 * Targets natifs par provider. Vercel = enum prod/preview/dev ; Render n'a pas de
 * notion de target (un service = un seul jeu de vars) → liste vide.
 */
export const PROVIDER_TARGETS: Record<SyncProvider, readonly string[]> = {
  vercel: VERCEL_TARGETS,
  render: [],
  // Railway : l'environnement est choisi via externalEnvironmentId (id dynamique),
  // pas via un enum de targets → liste vide.
  railway: [],
};

/** Targets autorisés pour un provider ([] si provider inconnu ou sans targets). */
export function providerTargets(provider: string): readonly string[] {
  return isSyncProvider(provider) ? PROVIDER_TARGETS[provider] : [];
}

/** Vrai si le provider a une dimension « target » (Vercel oui, Render non). */
export function providerSupportsTargets(provider: string): boolean {
  return providerTargets(provider).length > 0;
}

/** Un secret à pousser (déchiffré, en clair — ne jamais logger `value`). */
export type SyncSecret = { key: string; value: string };

/** Options de scope d'équipe (Vercel : opérer pour le compte d'une team). */
export type SyncScope = { teamId?: string | null };

/** Une ressource distante (pour le picker UI). */
export type RemoteProject = { id: string; name: string };
export type RemoteRef = { id: string; name: string };
/** Arbre de sélection pour les providers multi-niveaux (Railway : projet→env→service). */
export type RemoteTreeProject = RemoteRef & {
  environments: RemoteRef[];
  services: RemoteRef[];
};
export type RemoteTree = { projects: RemoteTreeProject[] };

/** Entrée d'un push : état désiré COMPLET que la plateforme doit refléter. */
export type SyncPushInput = SyncScope & {
  token: string;
  /** Identifiant du projet côté plateforme (ex. project id Vercel / service id Render / project id Railway). */
  externalProjectId: string;
  /** Railway : ids environment + service (les 3 requis par variableCollectionUpsert). */
  externalEnvironmentId?: string | null;
  externalServiceId?: string | null;
  /** Targets natifs de la plateforme (Vercel : production/preview/development). */
  targets: string[];
  secrets: SyncSecret[];
};

/** Connecteur d'une plateforme. Implémentations : lib/sync/{vercel,render,railway}.ts. */
export interface SyncConnector {
  readonly provider: SyncProvider;
  /** Valide le token (test de connexion). */
  test(token: string, scope?: SyncScope): Promise<{ ok: boolean; error?: string }>;
  /** Liste les projets distants accessibles par le token (picker UI plat : Vercel/Render). */
  listProjects(token: string, scope?: SyncScope): Promise<RemoteProject[]>;
  /** Providers multi-niveaux (Railway) : arbre projet→env→service pour un picker en cascade. */
  listResourceTree?(token: string, scope?: SyncScope): Promise<RemoteTree>;
  /** Réconcilie l'état distant avec `secrets` (create/update/delete côté plateforme). */
  push(input: SyncPushInput): Promise<void>;
}
