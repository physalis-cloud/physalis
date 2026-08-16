import { NextResponse } from "next/server";

type Window = {
  count: number;
  resetAt: number; // ms epoch
};

// Module-level state: persists for the lifetime of the Node process.
// Suitable for single-container deployments (which is our spec).
// If we ever scale to multiple replicas, swap this for a shared store
// (Postgres or Redis) — keep the same `rateLimit()` signature.
const buckets = new Map<string, Window>();

const CLEANUP_INTERVAL_MS = 60_000;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, win] of buckets) {
    if (win.resetAt <= now) buckets.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

export type RateLimitOptions = {
  max: number;
  windowMs: number;
};

/**
 * Nombre de reverse proxies de confiance entre le client et l'app.
 *
 * La chaîne `X-Forwarded-For` est lue par la DROITE : les segments de gauche
 * sont fournis par l'appelant et donc forgeables, seuls les `n` derniers sont
 * posés par nos propres proxies. Lire le premier élément (l'ancien
 * comportement) laissait l'appelant choisir sa propre clé de bucket, et donc
 * contourner tous les rate-limits — dont les 5 tentatives/15 min du login.
 *
 * Défaut 1 = un unique reverse proxy devant l'app (cas du self-host).
 * **La prod doit poser 2** : la chaîne y est `[.., ip_visiteur, ip_edge_CF]`,
 * Cloudflare appendant l'IP visiteur puis nginx `$remote_addr` via
 * `$proxy_add_x_forwarded_for`. Mesuré le 2026-07-19 sur un LOGIN_SUCCESS réel.
 * Le visiteur reste en avant-dernière position quel que soit le nombre de
 * valeurs bidon préfixées par le client, ce qui rend le comptage robuste.
 *
 * Plancher à 1 volontaire : à 0 aucun en-tête ne serait fiable, tous les
 * appelants tomberaient dans le bucket "unknown" et le moindre brute-force
 * verrouillerait le login de tout le monde.
 */
const TRUST_PROXY_HOPS = (() => {
  const parsed = Number(process.env.TRUST_PROXY_HOPS);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
})();

export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    // Chaîne plus courte qu'attendu (proxy qui écrase au lieu de concaténer) :
    // on retombe sur le premier élément, lui aussi posé par le proxy.
    const ip = hops[Math.max(0, hops.length - TRUST_PROXY_HOPS)];
    if (ip) return ip;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

/**
 * CIDR /32 dérivé de l'IP de l'appelant, à passer en `token_bound_cidrs` OpenBao
 * (§2.25b — CIDR-bind du token restore, miroir de l'identité agent). Retourne
 * `undefined` si l'IP n'est pas une IPv4 propre ("unknown", IPv6, valeur
 * illisible) : mieux vaut un token non borné qu'un `cidr_list` malformé qui
 * ferait rejeter le secret-id par OpenBao et casserait un restore légitime.
 * Le chemin agent suppose lui aussi des IPv4 (`${serverIp}/32`).
 */
export function clientCidr(req: Request): string | undefined {
  const ip = getClientIp(req);
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) ? `${ip}/32` : undefined;
}

/**
 * Réduit une IPv6 à son préfixe /64, sous forme canonique. Retourne null si
 * l'entrée n'est pas une IPv6 (IPv4, IPv4-mapped, "unknown", valeur illisible).
 *
 * La canonicalisation n'est pas cosmétique : sans elle, deux écritures de la
 * MÊME adresse (`2a01:0e0a:…` vs `2a01:e0a:…`, majuscules, `::`) donneraient
 * deux clés de bucket distinctes — un contournement gratuit du rate-limit.
 */
function ipv6Prefix64(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  // Forme `[adresse]` ou `[adresse]:port`.
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end === -1) return null;
    s = s.slice(1, end);
  }
  // Identifiant de zone : `fe80::1%eth0`.
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null; // IPv4 ou littéral
  if (s.includes(".")) return null; // IPv4-mapped (`::ffff:1.2.3.4`) → traité en IPv4

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const prefix: string[] = [];
  for (const group of groups.slice(0, 4)) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    prefix.push(group.replace(/^0+(?=.)/, "")); // zéros de tête, mais garder "0"
  }
  return `${prefix.join(":")}::/64`;
}

/**
 * Clé de bucket dérivée d'une IP.
 *
 * IPv6 → normalisée sur son /64. Un client résidentiel dispose d'un /64 entier
 * (souvent davantage) et les privacy extensions (RFC 4941) font tourner
 * l'identifiant d'interface toutes seules. Bucketiser sur le /128 rendait
 * l'étage IP à la fois **contournable** (une adresse neuve par tentative, 2⁶⁴
 * disponibles) et **instable** pour les utilisateurs légitimes, dont l'adresse
 * change sans qu'ils y soient pour rien. Cf. documentation/rapports/failles.md §16.
 *
 * IPv4 → inchangée. Utilisé UNIQUEMENT pour les clés de rate-limit : l'audit
 * (`lib/audit.ts`) conserve l'adresse complète, qui a une valeur forensique.
 */
export function rateLimitKey(ip: string): string {
  return ipv6Prefix64(ip) ?? ip;
}

/**
 * Fixed-window in-memory rate limiter, keyed by `${scope}:${identifier}`.
 *
 * Returns a 429 NextResponse if the bucket is over the limit, or null to let
 * the caller proceed. Sets standard rate-limit headers on the 429 response.
 */
export function resetRateLimit(
  req: Request | undefined,
  scope: string,
  identifier?: string,
): void {
  const id = identifier ?? (req ? rateLimitKey(getClientIp(req)) : "unknown");
  buckets.delete(`${scope}:${id}`);
}

export function rateLimit(
  req: Request | undefined,
  scope: string,
  opts: RateLimitOptions,
  identifier?: string,
): NextResponse | null {
  const id = identifier ?? (req ? rateLimitKey(getClientIp(req)) : "unknown");
  const key = `${scope}:${id}`;
  const now = Date.now();

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return null;
  }

  if (existing.count >= opts.max) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(opts.max),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(existing.resetAt / 1000)),
        },
      },
    );
  }

  existing.count++;
  return null;
}
