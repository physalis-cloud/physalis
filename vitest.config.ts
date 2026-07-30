import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/lib/**/*.test.ts"],
    exclude: ["tests/integ/**"],
    // Pas de DB requise pour la tier unit. Setup global pour fixer les
    // variables d'environnement nécessaires (ENCRYPTION_KEY).
    setupFiles: ["./tests/setup.ts"],
    // `forks` (process enfants) et NON `threads` (worker_threads) : plusieurs
    // modules `lib/*` importent `@/lib/prisma`, qui charge le query-engine
    // Prisma (addon natif N-API). Ce moteur est INSTABLE dans les
    // worker_threads de Vitest → crash non déterministe sous CI
    // (« Failed to deserialize constructor options », SIGABRT / exit 134) alors
    // que tout passe en local. `forks` isole chaque fichier dans son propre
    // process → moteur natif stable. Les modules à état partagé (rate-limit)
    // restent corrects : chaque cas utilise un scope/clé distinct, et forks
    // isole en plus par fichier.
    pool: "forks",
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
