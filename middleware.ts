// Middleware Next.js — fait trois choses pour chaque requete HTML :
//   1. Routage de locale : si le path n'a pas de prefixe de langue,
//      détecte la locale (cookie → Accept-Language → défaut "en") et
//      redirige vers /{locale}/path.
//   2. Genere un nonce et pose un Content-Security-Policy strict (script-src
//      avec nonce + strict-dynamic). Next.js v13+ lit le header `x-nonce`
//      (et `Content-Security-Policy`) sur la requete et l'applique
//      automatiquement aux <script> qu'il inline pour l'hydration.
//   3. Pour les routes protegees, valide la session JWT et redirige vers
//      /{locale}/login si manquante.
//
// CSP rationale :
//   - script-src 'self' 'nonce-<x>' 'strict-dynamic' : interdit tout script
//     inline non-nonce ; le nonce permet aux scripts de Next d'en charger
//     d'autres dynamiquement (chunks). Pas d'allowlist statique a maintenir.
//   - style-src 'self' 'unsafe-inline' : compromis pragmatique car React
//     inline les style="..." attributes (ex. style={{ color: ... }}). Les
//     attributs HTML ne supportent pas les nonces, et les CSS injections
//     sont nettement moins critiques que les scripts.
//   - img-src 'self' data: blob: : data: pour le QR code 2FA (base64).
//   - frame-ancestors 'none' + form-action 'self' + base-uri 'self' :
//     defense en profondeur classique anti-clickjacking et anti-takeover.
//   - upgrade-insecure-requests : downgrade auto HTTP→HTTPS si jamais une
//     ressource passe avec un schema relatif.
//   - 'unsafe-eval' uniquement en dev : Next HMR l'exige. En prod : strict.

import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

const LOCALES = ["en", "es", "fr"] as const;
type Locale = (typeof LOCALES)[number];
// Self-host : langue par défaut de l'instance. L'utilisateur peut changer via
// le LocaleSwitcher (pose un cookie NEXT_LOCALE). Mettre "en"/"es" si besoin.
const DEFAULT_LOCALE: Locale = "fr";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/projects",
  "/orgs",
  "/settings",
  "/shares",
  "/vault",
  "/admin",
  // C-0050 : /account/cli, ouverte par `physalis login` — le retour après le
  // login doit ramener sur la page d'approbation avec son ?code=.
  "/account",
];

function getLocaleFromPath(path: string): Locale | null {
  const match = path.match(/^\/([a-z]{2})(\/|$)/);
  if (match && LOCALES.includes(match[1] as Locale)) return match[1] as Locale;
  return null;
}

function detectLocale(req: NextRequest): Locale {
  // 1. Préférence explicite de l'utilisateur (cookie posé par LocaleSwitcher).
  const cookie = req.cookies.get("NEXT_LOCALE")?.value;
  if (cookie && LOCALES.includes(cookie as Locale)) return cookie as Locale;

  // 2. Sinon langue par défaut de l'instance (DEFAULT_LOCALE). On n'utilise
  //    PAS Accept-Language en self-host : l'opérateur choisit la langue par
  //    défaut, l'utilisateur change via le sélecteur. (Pour revenir à la
  //    détection navigateur, ré-introduire la boucle sur `accept-language`.)
  return DEFAULT_LOCALE;
}

function stripLocale(path: string): string {
  return path.replace(/^\/[a-z]{2}(\/|$)/, "/");
}

function isProtectedPath(path: string): boolean {
  return PROTECTED_PREFIXES.some(
    (p) => path === p || path.startsWith(p + "/"),
  );
}

function buildCsp(nonce: string): string {
  const dev = process.env.NODE_ENV !== "production";
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(dev ? ["'unsafe-eval'"] : []),
  ].join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export default auth((req) => {
  const path = req.nextUrl.pathname;

  // Generation du nonce (16 bytes hex via Web Crypto, dispo en Edge runtime).
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const csp = buildCsp(nonce);

  // 1. Routage de locale : redirige /{path} → /{locale}/{path}
  const pathLocale = getLocaleFromPath(path);
  if (!pathLocale) {
    const locale = detectLocale(req);
    const target = new URL(`/${locale}${path === "/" ? "" : path}`, req.url);
    target.search = req.nextUrl.search;
    const response = NextResponse.redirect(target);
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }

  // 2. Auth check : redirige vers /{locale}/login si route protégée + pas authentifié.
  const pathWithoutLocale = stripLocale(path);
  if (isProtectedPath(pathWithoutLocale) && !req.auth) {
    const url = new URL(`/${pathLocale}/login`, req.url);
    url.searchParams.set("callbackUrl", path);
    const response = NextResponse.redirect(url);
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }

  // 3. Pose le nonce + CSP dans les headers de la requete pour que Next les
  //    lise pour l'hydration. Pose aussi la CSP sur la response pour que le
  //    navigateur l'applique. Les deux doivent etre coherents.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  // next-intl lit ce header dans getRequestConfig (i18n/request.ts) pour
  // peupler `requestLocale`. Sans lui, la locale reste undefined → fallback
  // sur defaultLocale partout, et changer d'URL /en|/es ne traduit rien.
  requestHeaders.set("x-next-intl-locale", pathLocale);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", csp);
  return response;
});

// Matcher : toutes les routes HTML. On exclut :
//   - /api : pas de HTML
//   - /_next/static, /_next/image, favicon.ico : assets statiques
//   - les fichiers avec extension image
//   - les requetes de prefetch RSC (sinon le prefetch genere un nonce qui
//     ne correspondra pas a celui de la navigation reelle)
export const config = {
  matcher: [
    {
      // ⚠️ Porte depuis le middleware SaaS le 2026-09-16 — ce fichier en est un
      // jumeau mono-tenant tenu a la main. Le routage de locale est identique
      // des deux cotes, donc le defaut l'etait aussi : `/robots.txt` redirige
      // vers `/en/robots.txt`, qui n'existe pas, donc 404. La liste
      // d'extensions juste apres ne porte que des images et des archives.
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|zip)).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
