// Parcours : connexion
// - Session valide → le tableau de bord s'affiche
// - Mauvais mot de passe → message d'erreur, on reste sur /login
// - Page protégée sans session → redirection vers /login
// - Déconnexion → retour au login
//
// ⚠️ Chaque soumission du formulaire compte dans le plafond de 5 tentatives
// / 15 min du compte (lib/auth.ts) : ce fichier en consomme 2, le setup 1.

import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, submitLogin } from "./helpers/env";

test("session valide → tableau de bord", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/dashboard/);
  await expect(page.locator("main")).toBeVisible();
});

test.describe("sans session", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("mauvais mot de passe → erreur, pas de redirection", async ({ page }) => {
    await submitLogin(page, ADMIN_EMAIL, "mauvais-mot-de-passe");
    await expect(page.getByText(/email ou mot de passe invalide/i)).toBeVisible();
    await expect(page).toHaveURL(/login/);
  });

  test("page protégée → redirection vers le login", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveURL(/login/);
  });

  test("déconnexion → retour au login", async ({ page }) => {
    await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.waitForURL(/dashboard|projects/, { timeout: 15_000 });
    await page.goto("/api/auth/signout");
    await page.getByRole("button", { name: /sign out/i }).click();
    await page.waitForURL(/login/);
    await page.goto("/projects");
    await expect(page).toHaveURL(/login/);
  });
});
