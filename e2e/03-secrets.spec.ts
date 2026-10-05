// Parcours : secrets d'un environnement
// - Ajouter un secret depuis l'interface → il apparaît dans la liste
// - Afficher sa valeur → la valeur déchiffrée s'affiche
// - Le supprimer → il disparaît

import { test, expect, type Page } from "@playwright/test";
import { ENV, PROJECT_SLUG, apiHeaders, ensureProject, openEnv } from "./helpers/env";

const KEY = `E2E_SECRET_${Date.now()}`;
const VALUE = "valeur-secrete-e2e-42";

async function openSecrets(page: Page) {
  await openEnv(page, ENV);
  await page.locator("button.subtab", { hasText: /^Secrets$/ }).click();
}

test.describe.serial("secrets", () => {
  test.beforeEach(async ({ page }) => {
    await ensureProject(page);
    await openSecrets(page);
  });

  test("ajouter un secret", async ({ page }) => {
    await page.getByRole("button", { name: /\+ ajouter un secret/i }).click();
    await page.locator('input[placeholder="DATABASE_URL"]').fill(KEY);
    await page.locator('input[placeholder="Valeur"]').fill(VALUE);
    await page.getByRole("button", { name: /^créer$/i }).click();
    await expect(page.getByText(KEY).first()).toBeVisible();
  });

  test("afficher la valeur", async ({ page }) => {
    const row = page.locator("div.row", { hasText: KEY }).first();
    await row.getByRole("button", { name: /afficher/i }).click();
    await expect(page.getByText(VALUE).first()).toBeVisible();
  });

  test("supprimer le secret", async ({ page }) => {
    const res = await page.request.delete(
      `/api/projects/${PROJECT_SLUG}/${ENV}/secrets/${KEY}`,
      { headers: apiHeaders() },
    );
    expect(res.status(), await res.text()).toBe(200);
    await page.reload();
    await openSecrets(page);
    await expect(page.getByText(KEY)).toHaveCount(0);
  });
});
