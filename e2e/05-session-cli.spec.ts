// Parcours : connecter un terminal (session CLI, C-0050)
// - La CLI demande un code d'appareil (`physalis login`)
// - L'utilisateur l'approuve depuis /account/cli?code=…
// - La CLI récupère son jeton et lit les secrets d'un environnement avec les
//   droits de l'utilisateur, puis liste les clés SSH pour l'agent
//
// Les appels « CLI » passent par un contexte de requête SANS cookie : c'est
// le jeton `sv_cli_…` seul qui doit ouvrir l'accès.

import { test, expect, request } from "@playwright/test";
import { BASE_URL, ENV, PROJECT_SLUG, apiHeaders, ensureProject } from "./helpers/env";

const KEY = "E2E_CLI_SECRET";
const VALUE = `valeur-cli-${Date.now()}`;

test("approuver un terminal puis lire les secrets avec son jeton", async ({ page }) => {
  await ensureProject(page);
  const put = await page.request.post(`/api/projects/${PROJECT_SLUG}/${ENV}/secrets`, {
    headers: apiHeaders(),
    data: { key: KEY, value: VALUE },
  });
  expect(put.status(), await put.text()).toBeLessThan(300);

  const cli = await request.newContext({ baseURL: BASE_URL });
  try {
    const start = await cli.post("/api/cli/device/start", {
      data: { deviceName: "e2e", kind: "human" },
    });
    expect(start.status(), await start.text()).toBe(200);
    const { deviceCode, userCode, interval } = (await start.json()) as {
      deviceCode: string;
      userCode: string;
      interval: number;
    };
    // RFC 8628 : interroger plus vite que `interval` vaut `slow_down`. On
    // respecte l'intervalle annoncé, comme la CLI.
    const waitInterval = () => page.waitForTimeout(interval * 1000 + 250);

    // Avant l'approbation, le jeton n'existe pas.
    const pending = await cli.post("/api/cli/device/poll", { data: { deviceCode } });
    expect(pending.status()).toBe(400);

    await page.goto(`/account/cli?code=${encodeURIComponent(userCode)}`);
    await page.getByRole("button", { name: /^approuver$/i }).click();
    await expect(page.getByText(/terminal connecté/i)).toBeVisible();

    await waitInterval();
    const poll = await cli.post("/api/cli/device/poll", { data: { deviceCode } });
    expect(poll.status(), await poll.text()).toBe(200);
    const { token } = (await poll.json()) as { token: string };
    expect(token).toMatch(/^sv_cli_/);
    const auth = { Authorization: `Bearer ${token}` };

    const secrets = await cli.get(`/api/secrets/${PROJECT_SLUG}/${ENV}`, { headers: auth });
    expect(secrets.status(), await secrets.text()).toBe(200);
    expect(((await secrets.json()) as { secrets: Record<string, string> }).secrets[KEY]).toBe(
      VALUE,
    );

    const keys = await cli.get("/api/agent/ssh/keys", { headers: auth });
    expect(keys.status(), await keys.text()).toBe(200);

    // Sans jeton, rien.
    const anonymous = await cli.get(`/api/secrets/${PROJECT_SLUG}/${ENV}`);
    expect(anonymous.status()).toBe(401);
  } finally {
    await cli.dispose();
  }
});
