import { FlatCompat } from "@eslint/eslintrc";
import { readFileSync } from "node:fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * Ce fichier est SYNCHRONISÉ vers le build self-host (mono-tenant), où le
 * client `prisma` est un PrismaClient ordinaire et où `$transaction` est
 * parfaitement légitime — 9 sites l'utilisent. Y appliquer la règle F5.1
 * ci-dessous rendrait `npm run lint` rouge chez tous les auto-hébergés.
 *
 * Plutôt qu'un jumeau d'overlay de plus à maintenir (et à voir diverger), on
 * détecte la présence du client ÉTENDU, seule raison d'être de la règle : le
 * marqueur `TenantAwarePrisma` n'existe que dans le `lib/prisma.ts` du SaaS.
 * Si un jour l'extension disparaît, la règle s'éteint d'elle-même — ce qui est
 * exactement le comportement voulu.
 */
const hasExtendedPrismaClient = (() => {
  try {
    return readFileSync(`${__dirname}/lib/prisma.ts`, "utf8").includes(
      "TenantAwarePrisma",
    );
  } catch {
    return false;
  }
})();

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "prisma/migrations/**",
      "next-env.d.ts",
    ],
  },
  ...(hasExtendedPrismaClient
    ? [
        {
          // F5.1 — `prisma.$transaction` sur le client étendu (lib/prisma.ts) n'ouvre
          // aucune transaction utile : l'extension redispatche chaque opération vers
          // un autre PrismaClient, qui les exécute en autocommit hors transaction.
          // Le type l'interdit déjà (le `$transaction` est retiré de
          // `TenantAwarePrisma`) ; cette règle n'existe que pour que le message soit
          // lisible plutôt qu'un « Property '$transaction' does not exist ».
          //
          // Portée : `app/**` et `lib/**`, les seuls endroits où le nom `prisma`
          // désigne le client étendu. Ailleurs il désigne un vrai client et
          // `$transaction` y est légitime : les `scripts/*.mjs` autonomes font leur
          // propre `new PrismaClient()`, et `scripts/public-overlay/**` est le jumeau
          // self-host mono-tenant. `basePrisma`, `adminPrisma` et
          // `getTenantPrisma(slug)` ne sont jamais visés — le sélecteur porte sur le
          // nom `prisma` seul. Le garde-fou qui couvre TOUT reste le type.
          files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
          rules: {
            "no-restricted-syntax": [
              "error",
              {
                selector:
                  'MemberExpression[object.name="prisma"][property.name="$transaction"]',
                message:
                  "prisma.$transaction n'a AUCUNE atomicité (client étendu multi-tenant, cf. rapport-security.md §F5.1). Utiliser withTenantSchema(slug, (tx) => …) de lib/tenant.ts.",
              },
            ],
          },
        },
      ]
    : []),
];

export default eslintConfig;
