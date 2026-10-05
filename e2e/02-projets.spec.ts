// Parcours : projets
// - Créer un projet depuis l'interface → il apparaît
// - L'ouvrir → ses environnements par défaut sont là, « Déploiements » est
//   le sous-onglet ouvert par défaut d'un environnement

import { test, expect } from "@playwright/test";
import { ENV, PROJECT_NAME, PROJECT_SLUG, ensureProject, openEnv } from "./helpers/env";

test.describe.serial("projets", () => {
  test("créer un projet depuis l'interface", async ({ page }) => {
    await page.goto("/projects");
    const existing = page.getByText(PROJECT_NAME).first();
    if (!(await existing.isVisible({ timeout: 2_000 }).catch(() => false))) {
      await page.getByRole("button", { name: /créer un projet/i }).click();
      // Scopé au formulaire de projet : la page a aussi « Créer un groupe ».
      const form = page
        .locator("form")
        .filter({ has: page.locator('input[placeholder="ex: voyages"]') });
      await form.locator('input[placeholder="ex: voyages"]').fill(PROJECT_NAME);
      await form.getByRole("button", { name: /^créer$/i }).click();
    }
    await expect(page.getByText(PROJECT_NAME).first()).toBeVisible();
  });

  test("ouvrir le projet → environnements et sous-onglet Déploiements", async ({ page }) => {
    await ensureProject(page);
    await page.goto(`/projects/${PROJECT_SLUG}`);
    for (const env of ["production", "staging", "development"]) {
      await expect(
        page.locator("button.tab", { hasText: new RegExp(`^${env}`, "i") }).first(),
      ).toBeVisible();
    }
    await openEnv(page, ENV);
    await expect(page.locator("button.subtab.active")).toHaveText(/déploiements/i);
  });
});
