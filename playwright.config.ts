import { defineConfig, devices } from "@playwright/test";

// e2e du build SELF-HOST (DEP-020/027). Ils ne visent pas une instance
// déployée : la CI construit l'image, la lance par docker compose sur une base
// neuve, puis joue ces parcours contre elle (cf. .github/workflows/ci.yml).
// En local : `docker compose -f docker-compose.yml -f docker-compose.build.yml
// up -d --build`, puis `E2E_BASE_URL=http://localhost:<PORT> npm run e2e`.
//
// Une seule connexion pour toute la suite (projet `setup` → storageState) :
// le login est plafonné à 5 tentatives / 15 min PAR COMPTE (lib/auth.ts),
// succès compris. Un `beforeEach(login)` par test bloquerait la suite.

const AUTH_FILE = "e2e/.auth/admin.json";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  // Instance jetable, état connu : un échec est un vrai échec. Un retry
  // rejouerait aussi des connexions et userait le plafond par compte.
  retries: 0,
  // En CI, le rapport HTML est publié comme artefact en cas d'échec.
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    locale: "fr-FR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: AUTH_FILE },
      dependencies: ["setup"],
    },
  ],
});
