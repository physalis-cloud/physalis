"use client";

import { useState, useTransition } from "react";
import { signOut } from "next-auth/react";
import { useLocale, useTranslations } from "next-intl";
import { clearExtensionSession } from "@/lib/extension-bridge";

// Zone dangereuse : suppression DÉFINITIVE du compte (tout le tenant) +
// annulation de l'abonnement. Réservée à l'OWNER de l'org principale (le
// rendu est déjà gardé côté serveur). Confirmation par saisie du nom exact.
export default function DeleteAccountPanel({
  clientName,
  memberCount,
}: {
  clientName: string;
  /**
   * Nombre d'utilisateurs du tenant. Affiché AVANT validation : la décision de
   * l'owner détruit aussi les données de tous les autres, il doit le lire
   * explicitement plutôt que de le déduire.
   */
  memberCount: number;
}) {
  const t = useTranslations("account.deleteAccount");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const canDelete = confirmName.trim() === clientName && !pending;

  function submit() {
    if (!canDelete) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName: confirmName.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("error"));
        return;
      }
      // Tenant détruit : on déconnecte et on renvoie vers le login générique
      // (le sous-domaine/portail du tenant n'existe plus).
      //
      // Pas de révocation serveur ici, contrairement à LogoutButton : le tenant
      // part avec ses PluginToken, et l'appel se ferait de toute façon sur une
      // session dont le compte vient de basculer en suppression. On se contente
      // de l'oubli local pour que l'extension n'affiche pas une session
      // fantôme.
      clearExtensionSession();
      await signOut({ redirectTo: `/${locale}/login` });
    });
  }

  return (
    <section className="section">
      <div
        className="card"
        style={{ padding: 24, border: "1px solid var(--danger)", display: "grid", gap: 12 }}
      >
        <h2 className="section-title" style={{ color: "var(--danger)", margin: 0 }}>
          {t("title")}
        </h2>
        <p className="help" style={{ margin: 0 }}>
          {t("desc")}
        </p>

        {!open ? (
          <div>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setOpen(true)}
            >
              {t("openBtn")}
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {/* Conséquences énoncées AVANT la saisie, pas après. */}
            <ul
              className="help"
              style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}
            >
              <li>{t("consequenceBilling")}</li>
              <li>{t("consequenceWindow")}</li>
              <li>{t("consequenceExport")}</li>
              {memberCount > 1 && (
                <li style={{ color: "var(--danger)", fontWeight: 600 }}>
                  {t("consequenceMembers", { count: memberCount - 1 })}
                </li>
              )}
            </ul>
            <label className="field" style={{ maxWidth: 360 }}>
              <span>{t("confirmLabel", { name: clientName })}</span>
              <input
                className="input"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={clientName}
                autoFocus
                disabled={pending}
              />
            </label>
            {error && <p className="error-text" style={{ margin: 0 }}>{error}</p>}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={submit}
                disabled={!canDelete}
              >
                {pending ? t("deletingBtn") : t("confirmBtn")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setOpen(false);
                  setConfirmName("");
                  setError(null);
                }}
                disabled={pending}
              >
                {t("cancelBtn")}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
