// Helpers CORS pour les endpoints `/api/plugin/*` consommes par
// l'extension navigateur depuis `chrome-extension://<id>` (origin
// distincte du domaine vault).
//
// L'env var `PLUGIN_ALLOWED_ORIGIN` definit l'origin autorise. Format
// attendu : `chrome-extension://abcdefghijklmnopqrstuvwxyz123456`.
// Plusieurs origins separes par virgule autorises (ex. dev + prod IDs).
// Le token special `moz-extension://*` couvre Firefox, dont l'uuid n'est pas
// epinglable (voir la note dediee plus bas).
//
// Si la variable n'est PAS definie, les endpoints plugin renvoient 403
// (kill switch — refus de fonctionner sans whitelist explicite).
//
// ─── Note sur le comportement Chrome ─────────────────────────────────────
// Chrome ne fait PAS toujours suivre l'header `Origin` pour les fetch
// d'extension vers une URL listee dans `host_permissions` :
//   - Requete "non-simple" (POST avec Content-Type: application/json) →
//     preflight CORS → Origin envoye → on peut le valider.
//   - Requete "simple" (GET avec uniquement Authorization) → pas de
//     preflight, Chrome strippe Origin → req.headers.get("origin") = null.
//
// Strategie : si Origin est present il DOIT matcher la whitelist
// (anti-CSRF depuis une page web tierce). S'il est absent, on fait
// confiance au Bearer token (verifie plus loin dans le handler) — c'est
// l'auth reelle de toute facon. Une page web malveillante NE PEUT PAS
// stripper Origin (le navigateur l'ajoute toujours pour les XHR/fetch
// cross-origin), donc le risque CSRF reste couvert.

import { NextResponse } from "next/server";

export type CorsResult =
  | { ok: true; allowOrigin: string | null }
  | { ok: false; reason: "no_origin_configured" | "origin_not_allowed" };

// ─── Note sur le comportement Firefox ────────────────────────────────────
// L'origin d'une extension Firefox est `moz-extension://<uuid>`, ou l'uuid
// est regenere a CHAQUE installation, sur chaque profil. Il est donc
// impossible de l'epingler a l'avance, contrairement a Chrome dont l'ID est
// fige par le `key` du manifest.
//
// Et Firefox envoie bien cet Origin : le bug Mozilla 1405971 (« Webextension
// UUID leak to servers via Fetch request headers ») est toujours ouvert, les
// deux mitigations tentees — suppression de l'en-tete (FF 71-72) puis
// `Origin: null` (FF 73) — ayant ete backoutees.
//
// Sans le motif ci-dessous, tout client Firefox prend donc un 403
// `origin_not_allowed`. Contrairement a ce qu'affirmait
// `documentation/extension/send-to-store.md` §4, un Origin PRESENT mais non
// whiteliste ne « retombe » pas dans la branche « Origin absent » : les deux
// branches sont disjointes.
//
// L'accepter n'affaiblit pas le controle : l'auth reelle est le Bearer token,
// et la branche « Origin absent » fait deja confiance au Bearer seul (ce qui
// laisse deja passer tout client non-navigateur). La valeur anti-CSRF du
// helper est portee par le rejet des origins `https://` — une page web tierce
// ne peut pas forger un Origin, c'est le navigateur qui le pose.
//
// Reste opt-in : il faut inscrire explicitement `moz-extension://*` dans
// PLUGIN_ALLOWED_ORIGIN (coherent avec le kill switch — rien d'implicite).
const FIREFOX_WILDCARD = "moz-extension://*";

// Strict a dessein : un origin n'a pas de chemin, et l'uuid interne Firefox
// est toujours un UUID v4 en minuscules.
const MOZ_EXTENSION_ORIGIN =
  /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Allowed = { exact: string[]; firefox: boolean };

function parseAllowed(): Allowed | null {
  const raw = process.env.PLUGIN_ALLOWED_ORIGIN;
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (entries.length === 0) return null;
  return {
    // Le token wildcard est retire de la liste exacte : sinon un client
    // envoyant litteralement `Origin: moz-extension://*` matcherait, et on
    // lui renverrait cette valeur en `Access-Control-Allow-Origin`.
    exact: entries.filter((o) => o !== FIREFOX_WILDCARD),
    firefox: entries.includes(FIREFOX_WILDCARD),
  };
}

/**
 * Verifie que la requete provient d'une origin whitelistee. Retourne :
 *   - { ok: true, allowOrigin: <origin> } si Origin present et whitelistee
 *   - { ok: true, allowOrigin: null } si Origin absent (Chrome
 *     extension fetch sur URL host_permitted — voir note en tete de fichier)
 *   - { ok: false, reason } si Origin present mais pas whitelistee, ou si
 *     la whitelist n'est pas configuree (kill switch)
 */
export function checkPluginOrigin(req: Request): CorsResult {
  const allowed = parseAllowed();
  if (!allowed) {
    return { ok: false, reason: "no_origin_configured" };
  }
  const origin = req.headers.get("origin");
  // Pas d'Origin → fetch d'extension avec host_permissions, on fait
  // confiance au Bearer token (verifie en aval dans le handler).
  if (!origin) {
    return { ok: true, allowOrigin: null };
  }
  // Extension Firefox : uuid imprevisible, cf. note en tete de fichier.
  if (allowed.firefox && MOZ_EXTENSION_ORIGIN.test(origin)) {
    return { ok: true, allowOrigin: origin };
  }
  if (!allowed.exact.includes(origin)) {
    return { ok: false, reason: "origin_not_allowed" };
  }
  return { ok: true, allowOrigin: origin };
}

/**
 * Headers CORS a ajouter sur chaque reponse plugin (succes ou erreur).
 * Si `allowOrigin` est null, on ne pose pas `Access-Control-Allow-Origin`
 * (le client est cense ignorer CORS — extension fetch sans Origin).
 * `Vary: Origin` important pour les caches.
 */
export function corsHeaders(
  allowOrigin: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }
  return headers;
}

/**
 * Reponse OPTIONS preflight. Tous les endpoints plugin doivent l'exporter.
 *
 * Note : un preflight legitime du navigateur a TOUJOURS un Origin (sinon
 * il n'y a pas de notion de cross-origin a valider). Si Origin est absent
 * en preflight, c'est un client manuel (curl) — on renvoie 204 sans header.
 */
export function preflightResponse(req: Request): NextResponse {
  const cors = checkPluginOrigin(req);
  if (!cors.ok) {
    return new NextResponse(null, { status: 204 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(cors.allowOrigin),
  });
}

/**
 * Wrapper : ajoute les headers CORS a une NextResponse existante.
 * Pratique pour les renvois 200/4xx/5xx. Si allowOrigin est null,
 * aucun header n'est ajoute (le client n'utilise pas CORS).
 */
export function withCors(
  res: NextResponse,
  allowOrigin: string | null,
): NextResponse {
  if (!allowOrigin) return res;
  for (const [k, v] of Object.entries(corsHeaders(allowOrigin))) {
    res.headers.set(k, v);
  }
  return res;
}
