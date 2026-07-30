import { withTenantSchema } from "@/lib/tenant";
import { encrypt, decrypt } from "@/lib/crypto";
import { generatePassword } from "@/lib/generate-password";
import { computeReminderNextAt, pushRotationHistory } from "@/lib/rotation-reminder";
import { logAction } from "@/lib/audit";
import { safeFetchHook, HookUrlError } from "@/lib/safe-fetch";
import { RotationDisabledError, rotationGateOpen } from "@/lib/rotation-gate";

// Rotation WEBHOOK d'un AppAccount (compte applicatif). Le credential vit en
// `encryptedData = { user, password }`. Comme pour les secrets, seule l'app sait
// hasher le mdp → on délègue l'application au hook. Physalis génère le mdp.

// Committe la nouvelle valeur dans l'AppAccount : ré-encrypt { user inchangé,
// newValue }, snapshot l'ancien blob dans rotationHistory (cap 3), bump échéances.
// Partagé par le rotator DIRECT et le report agent (mode AGENT). Pas de redeploy
// (un compte n'est pas injecté dans le .env).
export async function applyAccountRotationSuccess(
  clientSlug: string,
  accountId: string,
  newValue: string,
): Promise<void> {
  const acc = await withTenantSchema(clientSlug, (tx) =>
    tx.appAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        name: true,
        encryptedData: true,
        iv: true,
        tag: true,
        rotationIntervalDays: true,
        rotationHistory: true,
        projectId: true,
        project: { select: { organizationId: true } },
      },
    }),
  );
  if (!acc) throw new Error(`[appAccountWebhook] compte ${accountId} introuvable`);

  const parsed = JSON.parse(decrypt({ encryptedValue: acc.encryptedData, iv: acc.iv, tag: acc.tag })) as {
    user?: string;
  };
  const payload = encrypt(JSON.stringify({ user: parsed.user ?? "", password: newValue }));
  const now = new Date();
  const history = pushRotationHistory(acc.rotationHistory, {
    encryptedValue: acc.encryptedData,
    iv: acc.iv,
    tag: acc.tag,
    rotatedAt: now.toISOString(),
  });

  await withTenantSchema(clientSlug, (tx) =>
    tx.appAccount.update({
      where: { id: acc.id },
      data: {
        encryptedData: payload.encryptedValue,
        iv: payload.iv,
        tag: payload.tag,
        rotationHistory: history,
        rotationLastAt: now,
        rotationNextAt: computeReminderNextAt(acc.rotationIntervalDays, now),
        rotationLastStatus: null,
      },
    }),
  );

  logAction({
    action: "ACCOUNT_UPDATE",
    actor: { kind: "anonymous" },
    organizationId: acc.project.organizationId,
    projectId: acc.projectId,
    targetType: "AppAccount",
    targetId: acc.id,
    metadata: { changedFields: ["rotation"], valueUpdated: true, via: "webhook" },
    tenantSlug: clientSlug,
  });
}

// Mode DIRECT : Physalis génère le mdp, POST le hook { user, newValue } (l'app
// applique + répond 2xx), puis committe. Mode AGENT : l'agent fait ça en local
// et reporte (cf. /rotation/agent/report) — pas ce rotator.
export async function rotateAppAccountWebhook(accountId: string, clientSlug: string): Promise<void> {
  const acc = await withTenantSchema(clientSlug, (tx) =>
    tx.appAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        encryptedData: true,
        iv: true,
        tag: true,
        // Le hook vit sur le SERVICE backend lié (config partagée par tous ses comptes).
        service: { select: { rotationWebhookUrl: true, rotationHookToken: true } },
        // §2.24c — gate d'org (bloque un « Forcer » sur une org rotation-off).
        project: {
          select: {
            rotationPaused: true,
            organization: { select: { rotationFeatureEnabled: true } },
          },
        },
      },
    }),
  );
  if (!acc) throw new Error(`[rotateAppAccountWebhook] compte ${accountId} introuvable`);
  if (!rotationGateOpen(acc.project)) throw new RotationDisabledError();
  const hookUrl = acc.service?.rotationWebhookUrl ?? null;
  if (!hookUrl) {
    throw new Error(`compte non lié à un service backend avec un hook (rotationWebhookUrl)`);
  }
  const hookToken = acc.service?.rotationHookToken ?? null;

  const parsed = JSON.parse(decrypt({ encryptedValue: acc.encryptedData, iv: acc.iv, tag: acc.tag })) as {
    user?: string;
  };
  const newValue = generatePassword(24);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hookToken) headers["Authorization"] = `Bearer ${hookToken}`;

  let res: Response;
  try {
    // safeFetchHook : garde SSRF (cf. lib/safe-fetch.ts). Chemin DIRECT uniquement.
    res = await safeFetchHook(hookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ user: parsed.user ?? "", newValue }),
      // Timeout : un hook lent/injoignable doit échouer proprement (sinon le
      // reverse-proxy coupe en 502 avant notre réponse).
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (e instanceof HookUrlError) {
      throw new Error(`URL de hook refusée : ${e.message}`);
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`hook injoignable (${msg})`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`le hook a répondu ${res.status}${detail ? ` — ${detail}` : ""}`);
  }

  await applyAccountRotationSuccess(clientSlug, acc.id, newValue);
}
