// Connexion unique de la suite : la session est enregistrée puis réutilisée
// par tous les parcours (projet `chromium`, cf. playwright.config.ts).

import { test as setup, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { ADMIN_EMAIL, ADMIN_PASSWORD, submitLogin } from "./helpers/env";

setup("connexion de l'administrateur", async ({ page }) => {
  expect(ADMIN_PASSWORD, "E2E_ADMIN_PASSWORD manquant").not.toBe("");
  await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.waitForURL(/dashboard|projects/, { timeout: 15_000 });
  mkdirSync("e2e/.auth", { recursive: true });
  await page.context().storageState({ path: "e2e/.auth/admin.json" });
});
