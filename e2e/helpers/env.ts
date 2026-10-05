import { expect, type Page } from "@playwright/test";

// Identifiants du superadmin créé au premier démarrage par
// scripts/bootstrap-admin.mjs (ADMIN_EMAIL / ADMIN_PASSWORD du .env).
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";

export const PROJECT_NAME = "E2E Test";
export const PROJECT_SLUG = "e2e-test";
// Créé avec le projet (DEFAULT_ENVS de POST /api/projects).
export const ENV = "production";

/**
 * Remplit le formulaire de login et le soumet. Le formulaire est contrôlé par
 * React : un `fill` joué avant l'hydratation est perdu. On retente jusqu'à ce
 * que la valeur tienne.
 */
export async function submitLogin(page: Page, email: string, password: string) {
  await page.goto("/login");
  const emailInput = page.locator('input[type="email"]');
  const passwordInput = page.locator('input[type="password"]');
  await expect(async () => {
    await emailInput.fill(email);
    await passwordInput.fill(password);
    await expect(emailInput).toHaveValue(email, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: /se connecter/i }).click();
}

// Même défaut que `baseURL` dans playwright.config.ts.
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3001";

/** En-têtes des appels d'API mutants : la vérification d'origine les exige. */
export function apiHeaders(): Record<string, string> {
  return { Origin: new URL(BASE_URL).origin };
}

/**
 * Projet de la suite, créé par l'API s'il n'existe pas : chaque parcours peut
 * tourner seul (`npx playwright test e2e/03-secrets.spec.ts`).
 */
export async function ensureProject(page: Page) {
  const existing = await page.request.get(`/api/projects/${PROJECT_SLUG}`);
  if (existing.ok()) return;
  const res = await page.request.post("/api/projects", {
    headers: apiHeaders(),
    data: { name: PROJECT_NAME, slug: PROJECT_SLUG },
  });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

/** Ouvre le projet sur un onglet d'environnement. */
export async function openEnv(page: Page, env = ENV) {
  await page.goto(`/projects/${PROJECT_SLUG}`);
  await page.locator("button.tab", { hasText: new RegExp(`^${env}`, "i") }).first().click();
}
