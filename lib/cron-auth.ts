// Authentification partagée des endpoints opérateur de confiance (crons métier,
// rotation N8n, rapports de backup VPS).
//
// Deux tiers de privilège (cf. docs/steps-docs/todo/cron-secret-hardening.md, Phase 1) :
//   - "report" → CRON_SECRET_REPORT : bas privilège, n'autorise QUE
//     POST /api/admin/infra/backup (posé sur le maillon le plus exposé, les
//     scripts de backup du VPS secondaire).
//   - "admin"  → CRON_SECRET_ADMIN : haut privilège, tout le reste
//     (/api/cron/*, /api/rotation/admin/*), détenu uniquement par le
//     planificateur de confiance (GitHub Actions, N8n).
//
// Header standardisé : `Authorization: Bearer <token>`.

import { timingSafeEqual } from "node:crypto";
import { verifyOidcToken, extractBearer } from "./oidc";

export type CronTier = "report" | "admin";

// Comparaison constant-time qui ne fuit pas la longueur du secret par timing.
function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b); // compare factice pour préserver le timing
    return false;
  }
  return timingSafeEqual(a, b);
}

// Récupère le token présenté depuis le header standardisé `Authorization: Bearer`.
function presentedToken(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  return auth.startsWith(prefix) ? auth.slice(prefix.length) : "";
}

export function requireCronAuth(req: Request, tier: CronTier): boolean {
  const provided = presentedToken(req);
  if (!provided) return false;

  const tierSecret =
    tier === "report"
      ? process.env.CRON_SECRET_REPORT
      : process.env.CRON_SECRET_ADMIN;

  return Boolean(tierSecret) && safeEqual(provided, tierSecret as string);
}

// ─── Phase 2 — restriction réseau (Tailscale) ──────────────────────────────
//
// Défense EN PLUS du bearer pour les endpoints les plus critiques
// (/api/rotation/admin/* = lecture de secrets déchiffrés cross-tenant,
// /api/cron/purge-accounts = purge destructive). Ils ne doivent être joignables
// que par le réseau privé (tailnet), pas par l'edge public Cloudflare.
//
// Activé par `CRON_PRIVATE_ONLY` (=1/true). DÉSACTIVÉ par défaut → no-op tant
// que le routage Tailscale n'est pas en place : rollout sûr (build le garde-fou
// d'abord, bascule les callers sur l'URL Tailscale, PUIS active le flag).
//
// Signal : une requête passée par Cloudflare porte TOUJOURS `CF-Connecting-IP`
// (IP publique du client). Une requête arrivée par le tailnet (bypass CF) ne
// l'a pas — ou a une IP source dans le CGNAT Tailscale 100.64.0.0/10. On
// autorise donc : (pas d'en-tête CF) OU (IP ∈ tailnet) ; on refuse le reste.

function ipv4ToInt(ip: string): number | null {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

/** True si `ip` (IPv4) est dans le CGNAT Tailscale 100.64.0.0/10. */
export function isTailscaleIp(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const mask = 0xffc00000; // /10
  return (n & mask) === (0x64400000 & mask); // 100.64.0.0
}

/**
 * Exige une origine PRIVÉE (tailnet) pour les endpoints critiques. No-op si
 * `CRON_PRIVATE_ONLY` n'est pas activé (rollout sûr).
 */
export function requirePrivateOrigin(req: Request): boolean {
  const flag = process.env.CRON_PRIVATE_ONLY;
  if (flag !== "1" && flag !== "true") return true; // garde-fou désactivé
  const cf = req.headers.get("cf-connecting-ip");
  if (!cf) return true; // pas passé par l'edge Cloudflare → privé/tailnet
  return isTailscaleIp(cf); // arrivé par l'edge public → refusé (sauf IP tailnet)
}

// ─── Phase 3 — OIDC GitHub Actions (cron-secret-hardening) ─────────────────
//
// Les crons publics planifiés par GitHub Actions (backup-watchdog, email-usage,
// overage-reminders, trial-expiry) s'authentifiaient via le secret statique
// CRON_SECRET_ADMIN stocké en GitHub Secret (long-vécu, détenteur le plus
// exposé). On accepte désormais AUSSI un jeton OIDC GitHub court-lived
// (expiration en minutes) → plus de secret statique chez GitHub. Le bearer
// statique reste accepté (N8n, argostaging, rollback) : on tente le statique
// d'abord, puis l'OIDC.
//
// Gated par CRON_OIDC_REPO : tant qu'il n'est pas défini, l'OIDC est ignoré
// (comportement identique à requireCronAuth) → rollout sûr. La confiance = le
// repo plateforme lui-même (tout workflow de ce repo, sur la branche autorisée,
// est un opérateur de confiance) ; on n'utilise PAS la table Policy — c'est de
// l'opérateur, pas du tenant.

/**
 * Variante async de `requireCronAuth` : accepte le bearer statique du tier OU,
 * pour le tier "admin", un jeton OIDC GitHub valide émis par le repo plateforme.
 */
export async function requireCronAuthAsync(
  req: Request,
  tier: CronTier,
): Promise<boolean> {
  if (requireCronAuth(req, tier)) return true; // bearer statique (tous tiers)
  if (tier !== "admin") return false; // OIDC réservé au tier admin
  return verifyCronOidc(req);
}

/**
 * Valide un jeton OIDC GitHub pour les crons admin. True si :
 *   - CRON_OIDC_REPO est défini (sinon OIDC désactivé → false) ;
 *   - le token est un OIDC GitHub valide (signature / iss / aud / exp, lib/oidc) ;
 *   - le claim `repository` == CRON_OIDC_REPO ;
 *   - la branche == CRON_OIDC_BRANCH (défaut "main").
 * L'audience attendue est gérée par lib/oidc (OIDC_AUDIENCE, déf vault.physalis.cloud).
 */
async function verifyCronOidc(req: Request): Promise<boolean> {
  const repo = process.env.CRON_OIDC_REPO;
  if (!repo) return false;
  const r = await verifyOidcToken(extractBearer(req));
  if (!r.ok) return false;
  if (r.claims.provider !== "github") return false;
  if (r.claims.repo !== repo) return false;
  const branch = process.env.CRON_OIDC_BRANCH ?? "main";
  return r.claims.branch === branch;
}
