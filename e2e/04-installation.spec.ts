// Parcours : guide d'installation d'un projet (C-0051)
// - Un projet neuf ouvre le sous-onglet « Installation » de « Infos »
// - Avec un dépôt et une policy, le modèle de workflow pré-rempli est servi.
//   Il est lu sur le disque de l'image (docs/*.modele.yml) : ce test est le
//   garde-fou du Dockerfile et du tracing de next.config.ts, dont l'oubli
//   faisait répondre la route en 500 dans l'image seulement.
// - Le lien profond vers l'onglet CI/CD de l'organisation ouvre cet onglet

import { test, expect } from "@playwright/test";
import { ENV, PROJECT_SLUG, apiHeaders, ensureProject } from "./helpers/env";

test.describe.serial("installation", () => {
  test.beforeEach(async ({ page }) => {
    await ensureProject(page);
  });

  test("un projet neuf ouvre le guide d'installation", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_SLUG}`);
    await expect(page.locator("button.subtab.active")).toHaveText(/installation/i);
    await expect(
      page.getByRole("heading", { name: /installation du projet/i }),
    ).toBeVisible();
  });

  test("modèle de workflow pré-rempli depuis la policy", async ({ page }) => {
    const repo = await page.request.patch(`/api/projects/${PROJECT_SLUG}`, {
      headers: apiHeaders(),
      data: { githubRepo: "exemple/e2e" },
    });
    expect(repo.status(), await repo.text()).toBe(200);

    const created = await page.request.post(`/api/projects/${PROJECT_SLUG}/policies`, {
      headers: apiHeaders(),
      data: { workflow: "deploy.yml", branch: "main", environment: ENV },
    });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const { policy } = (await created.json()) as { policy: { id: string } };

    const tpl = await page.request.get(
      `/api/projects/${PROJECT_SLUG}/setup/template?policy=${policy.id}&template=deploy`,
    );
    expect(tpl.status(), await tpl.text()).toBe(200);
    const { content } = (await tpl.json()) as { content: string };
    expect(content).toContain("/api/deploy");
    expect(content).toContain("deploy.yml");
  });

  test("lien profond vers l'onglet CI/CD de l'organisation", async ({ page }) => {
    const res = await page.request.get(`/api/projects/${PROJECT_SLUG}`);
    const body = (await res.json()) as { project?: { organization?: { slug?: string } } };
    const orgSlug = body.project?.organization?.slug ?? "admin";
    await page.goto(`/orgs/${orgSlug}?tab=cicd`);
    await expect(page.locator("button.tab.active")).toHaveText(/ci\/cd/i);
  });
});
