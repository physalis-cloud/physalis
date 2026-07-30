import { withTenantSchema } from "@/lib/tenant";
import { applyRotationSuccess } from "@/lib/rotation-agent";
import { generatePassword } from "@/lib/generate-password";
import { safeFetchHook, HookUrlError } from "@/lib/safe-fetch";

// Stratégie WEBHOOK — mode DIRECT (hook joignable depuis le centralisé).
//
// Physalis génère un mot de passe fort, le POST au hook ; l'app l'applique
// (hashe + met à jour sa source) et répond 200. Physalis committe ALORS la
// valeur qu'il a générée (applyRotationSuccess = snapshot + version + redeploy +
// audit) — « source d'abord, vault ensuite ». Le hashing reste côté app.
//
// Mode AGENT (hook interne réseau Docker) : ce n'est PAS ce rotator — l'agent
// génère + POST le hook en local et reporte via /api/rotation/agent/report.
export async function rotateWebhook(secretId: string, clientSlug: string): Promise<void> {
  const secret = await withTenantSchema(clientSlug, (tx) =>
    tx.secret.findUnique({
      where: { id: secretId },
      select: { id: true, key: true, rotationWebhookUrl: true, rotationHookToken: true },
    }),
  );
  if (!secret) throw new Error(`[rotateWebhook] secret ${secretId} introuvable`);
  if (!secret.rotationWebhookUrl) {
    throw new Error(`[rotateWebhook] secret ${secretId} sans rotationWebhookUrl`);
  }

  const newValue = generatePassword(24);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret.rotationHookToken) headers["Authorization"] = `Bearer ${secret.rotationHookToken}`;

  let res: Response;
  try {
    // safeFetchHook : garde SSRF (cible interne refusée, redirects re-validés).
    // Ce rotator est le chemin DIRECT (le serveur central fetch) ; le mode AGENT
    // ne l'appelle pas.
    res = await safeFetchHook(secret.rotationWebhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ secretKey: secret.key, newValue }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (e instanceof HookUrlError) {
      throw new Error(`[rotateWebhook] URL de hook refusée : ${e.message}`);
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[rotateWebhook] hook injoignable (${msg})`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`[rotateWebhook] le hook a répondu ${res.status}${detail ? ` — ${detail}` : ""}`);
  }

  // Le hook a appliqué le credential à la source → committe la valeur générée.
  await applyRotationSuccess(clientSlug, secret.id, newValue, "webhook");
}
