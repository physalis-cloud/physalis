import { createHash, randomBytes } from "crypto";
import { tenantBaseUrl } from "./app-url";

export const INVITATION_TTL_MS = 48 * 60 * 60_000; // 48h

export function generateInvitationToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Construit l'URL d'acceptation d'une invitation, depuis le slug du tenant
 * (issu de la session authentifiée) et NON depuis un en-tête de requête.
 *
 * L'implémentation précédente interpolait `X-Forwarded-Host` brut : un ADMIN
 * d'org pouvait poser `X-Forwarded-Host: evil.tld` sur `POST /members` et faire
 * partir, depuis l'expéditeur légitime et avec DKIM valide, un mail dont le
 * bouton pointait sur `https://evil.tld/invite/<token>` — livrant un token
 * vivant (TTL 48 h) suffisant à créer le compte de la victime. Cf. §2.11.
 *
 * Le repli `physalisBaseUrl()` (tenantSlug null) ne sert qu'au mono-tenant
 * self-host. En multi-tenant, viser l'URL canonique produirait un lien MORT :
 * `vault` est un sous-domaine réservé, donc `/invite/[token]` rejette la page
 * faute de pouvoir résoudre un tenant.
 */
export function buildAcceptUrl(token: string, tenantSlug: string | null): string {
  return `${tenantBaseUrl(tenantSlug)}/invite/${token}`;
}
