// Garde SSRF pour les appels sortants pilotés par le tenant (hooks de rotation
// WEBHOOK en mode DIRECT : c'est le serveur central qui fetch une URL choisie
// par un EDITOR de projet). Sans garde, l'URL peut viser le réseau interne
// (base, KMS, métadonnées cloud) et le corps de réponse est réfléchi à
// l'appelant → exfiltration + POST sortant forgé. Cf. docs/failles.md §6.
//
// La validation est faite AU MOMENT DE L'APPEL et RE-appliquée à CHAQUE saut de
// redirection (fetch suit les redirects) : valider seulement à l'écriture serait
// contourné par un hôte public qui répond 302 vers l'interne, ou par un domaine
// dont la résolution DNS change entre l'écriture et l'appel (DNS rebinding).
//
// Le mode AGENT ne passe JAMAIS par ici : dans ce mode le hook est appelé par
// l'agent, en local chez le client — le serveur central ne fetch pas.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// En dev (et pour un self-host mono-tenant qui l'active explicitement), on
// autorise les cibles internes : les hooks y visent légitimement `app:3000`,
// `127.0.0.1`, etc. En production SaaS, c'est refusé.
function allowInternalTargets(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.ROTATION_HOOK_ALLOW_INTERNAL === "1"
  );
}

export class HookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookUrlError";
  }
}

/**
 * Une IP est-elle « interne » (non routable publiquement) ? Couvre loopback,
 * RFC1918, link-local (169.254 / métadonnées cloud), CGNAT (100.64/10), ULA
 * IPv6, etc. Le test se fait sur l'IP RÉSOLUE, pas sur la chaîne saisie :
 * `127.0.0.1`, `2130706433`, `0x7f.1` et un domaine qui résout en local
 * tombent tous sur la même IP normalisée.
 */
export function ipIsPrivate(ip: string): boolean {
  let addr = ip;
  // IPv4-mappée en IPv6 (::ffff:127.0.0.1) → traiter comme l'IPv4 sous-jacente.
  if (isIP(addr) === 6) {
    const low = addr.toLowerCase();
    const m = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m && isIP(m[1]) === 4) addr = m[1];
  }

  if (isIP(addr) === 4) {
    const p = addr.split(".").map(Number);
    if (p[0] === 0) return true; // 0.0.0.0/8 "this host"
    if (p[0] === 10) return true; // RFC1918
    if (p[0] === 127) return true; // loopback
    if (p[0] === 169 && p[1] === 254) return true; // link-local + métadonnées cloud
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // RFC1918
    if (p[0] === 192 && p[1] === 168) return true; // RFC1918
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT RFC6598
    if (p[0] >= 224) return true; // multicast / réservé / limited-broadcast
    return false;
  }

  if (isIP(addr) === 6) {
    const l = addr.toLowerCase().replace(/^\[|\]$/g, "");
    if (l === "::1") return true; // loopback
    if (l === "::") return true; // unspecified
    if (l.startsWith("fe80")) return true; // link-local
    if (l.startsWith("fc") || l.startsWith("fd")) return true; // ULA RFC4193
    return false;
  }

  // Ni IPv4 ni IPv6 valide → on ne sait pas, on refuse par prudence.
  return true;
}

/** Résout un hôte en liste d'IP. Injectable pour les tests (pas de DNS réel). */
export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (host) => {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
};

/**
 * Vérifie la forme d'une URL de hook SANS résolution DNS (protocole, absence
 * d'identifiants inline, hôte non-interne littéral). Renvoie un message d'erreur
 * ou `null`. Utilisé à l'écriture pour un retour immédiat ; l'enforcement
 * autoritaire reste `safeFetchHook` (qui résout le DNS et suit les redirects).
 */
export function validateHookUrlSyntax(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "URL de hook invalide";
  }
  if (allowInternalTargets()) return null;

  if (u.protocol !== "https:") return "Le hook doit utiliser https://";
  if (u.username || u.password) return "Les identifiants dans l'URL du hook sont interdits";

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    return ipIsPrivate(host) ? "L'URL du hook vise une adresse IP interne" : null;
  }
  // Un hôte sans point est un nom de service interne (Docker : app, db, openbao…).
  if (!host.includes(".")) return "L'URL du hook vise un nom d'hôte interne";
  return null;
}

async function assertPublicUrl(raw: string, resolve: HostResolver): Promise<void> {
  const syntax = validateHookUrlSyntax(raw);
  if (syntax) throw new HookUrlError(syntax);
  if (allowInternalTargets()) return;

  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return; // déjà validé par validateHookUrlSyntax

  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new HookUrlError("Résolution DNS de l'URL du hook impossible");
  }
  if (addrs.length === 0) throw new HookUrlError("L'URL du hook ne résout vers aucune adresse");
  // Refus si UNE SEULE des IP résolues est interne : bloque l'astuce
  // « résout à la fois public et privé » et réduit la fenêtre de rebinding.
  for (const a of addrs) {
    if (ipIsPrivate(a)) throw new HookUrlError("Le domaine du hook résout vers une adresse interne");
  }
}

export interface SafeFetchOptions {
  maxRedirects?: number;
  /** Résolveur DNS injectable (tests). Défaut : `node:dns`. */
  resolve?: HostResolver;
}

/**
 * POST sortant sûr vers un hook : valide l'URL et CHAQUE saut de redirection
 * avant de fetch. `redirect: "manual"` empêche fetch de suivre une 3xx vers
 * l'interne sans repasser par la validation.
 */
export async function safeFetchHook(
  url: string,
  init: RequestInit,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const resolve = opts.resolve ?? defaultResolver;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current, resolve);
    const res = await fetch(current, { ...init, redirect: "manual" });

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return res;

    current = new URL(res.headers.get("location")!, current).toString();
  }
  throw new HookUrlError("Trop de redirections sur l'URL du hook");
}
