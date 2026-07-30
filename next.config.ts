import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    // Posé par l'APP et pas seulement par le reverse proxy. Deux raisons :
    //   • le self-host tourne sans NPM devant — sans ça, une instance
    //     auto-hébergée n'a aucun HSTS ;
    //   • défense en profondeur si la config du proxy dérive.
    // Inoffensif en dev : RFC 6797 §7.2 impose aux navigateurs d'IGNORER cet
    // en-tête reçu sur une connexion non sécurisée. Un doublon avec celui du
    // proxy est sans effet (le premier reçu fait foi, même valeur).
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Force Next à embarquer les markdown utilisateur dans la sortie standalone.
  // La layout `/docs` lit `docs/documentation/*.md` via fs.readdir à chaque
  // requête (sidebar) — sans cette directive, Next ne trace pas ces fichiers
  // (path en dehors de l'arbre `app/`) et le runtime échoue avec ENOENT.
  outputFileTracingIncludes: {
    "/[locale]/docs": ["./docs/documentation/**/*"],
    "/[locale]/docs/[slug]": ["./docs/documentation/**/*"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
