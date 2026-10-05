// Stub self-host : pas de table admin.token_index (résolveur cross-tenant).
// En single-tenant, les tokens sont résolus directement dans la table
// tenant correspondante (MachineToken, PluginToken, OneTimeShare).
// Signatures alignées sur le source SaaS.

export type TokenKind =
  | "MACHINE"
  | "PLUGIN"
  | "SHARE"
  | "SECRET_REQUEST"
  | "USER"
  | "ORG"
  | "CLI";

export type TokenIndexEntry = {
  tokenHash: string;
  tenantSlug: string;
  kind: TokenKind;
};

export async function resolveTokenIndex(
  _tokenHash: string,
): Promise<TokenIndexEntry | null> {
  return null;
}

export async function createTokenIndex(
  _tokenHash: string,
  _tenantSlug: string,
  _kind: TokenKind,
): Promise<void> {
  // no-op
}

export async function deleteTokenIndex(_tokenHash: string): Promise<void> {
  // no-op
}
