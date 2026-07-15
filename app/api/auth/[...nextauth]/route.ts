import { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";

// next-auth (lib/env.js `reqWithEnvURL`) dérive l'origine de la requête de
// `req.url` et ne la corrige QUE depuis AUTH_URL/NEXTAUTH_URL — il n'utilise
// JAMAIS `x-forwarded-host`. En Next standalone derrière un proxy, `req.url`
// porte l'adresse de bind du conteneur (`0.0.0.0:3000`) → sans NEXTAUTH_URL le
// `redirect_uri` OAuth part sur `0.0.0.0:3000`.
//
// Pour un SSO multi-tenant où l'origine doit suivre le SOUS-DOMAINE du tenant
// (et non un host canonique figé), on réécrit `req.url` depuis `x-forwarded-host`
// AVANT next-auth. Le proxy (NPM/Cloudflare) fournit le bon host par requête.
//
// Cohabite avec les deux modes :
//   - NEXTAUTH_URL posée  → reqWithEnvURL réécrit ensuite vers cette origine
//     (notre réécriture est écrasée) → mode portail canonique inchangé.
//   - NEXTAUTH_URL retirée → notre réécriture tient → SSO natif par sous-domaine.
function withForwardedOrigin(req: NextRequest): NextRequest {
  const xfHost = req.headers.get("x-forwarded-host");
  const host = xfHost?.split(",")[0]?.trim();
  if (!host) return req;
  const proto =
    (req.headers.get("x-forwarded-proto") ?? "https").split(",")[0]?.trim() ||
    "https";
  // x-forwarded-host est typiquement le hostname seul (port standard implicite).
  // On pose hostname ET port séparément : `url.host = "h"` (sans port) ne VIDE
  // pas le port existant (le `:3000` du bind 0.0.0.0:3000 persisterait sinon).
  const [hostname, port = ""] = host.split(":");
  const url = new URL(req.url);
  if (
    url.hostname === hostname &&
    url.port === port &&
    url.protocol === `${proto}:`
  ) {
    return req;
  }
  url.protocol = `${proto}:`;
  url.hostname = hostname;
  url.port = port; // "" → retire le port → 443 implicite en https
  // Même patron que next-auth `reqWithEnvURL` : new NextRequest(href, req)
  // préserve méthode, en-têtes et body (nécessaire pour les POST signin).
  return new NextRequest(url.toString(), req);
}

export const GET = (req: NextRequest) => handlers.GET(withForwardedOrigin(req));
export const POST = (req: NextRequest) =>
  handlers.POST(withForwardedOrigin(req));
