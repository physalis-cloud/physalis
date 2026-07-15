"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";

type State = {
  configured: boolean;
  enabled: boolean;
  hasAccount: boolean;
  canManage: boolean;
};

/**
 * Activation du service email Pink-Floyd au niveau CLIENT (tenant). Un compte
 * Pink-Floyd par client. Réservé aux OWNER/ADMIN d'une org du client (le
 * serveur l'impose ; le bouton est masqué sinon).
 */
export default function AccountEmailPanel() {
  const t = useTranslations("settings.email");
  const base = "/api/account/email";

  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetch(base);
    if (!res.ok) {
      setError(t("loadError"));
      setLoading(false);
      return;
    }
    setState((await res.json()) as State);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  function setEnabled(enable: boolean) {
    setError(null);
    startBusy(async () => {
      const res = await fetch(base, { method: enable ? "POST" : "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? t("loadError"));
        return;
      }
      await load();
    });
  }

  return (
    <section className="settings-block">
      <h2 className="settings-block-title">
        {t("title")}{" "}
        {state?.enabled && (
          <span className="role role-owner" style={{ marginLeft: 8 }}>
            {t("enabledBadge")}
          </span>
        )}
      </h2>
      <p className="settings-section-desc">{t("intro")}</p>

      <div className="settings-block-card">
        {loading ? (
          <p className="help" style={{ margin: 0 }}>Chargement…</p>
        ) : !state?.configured ? (
          <p className="help" style={{ margin: 0 }}>{t("notConfigured")}</p>
        ) : (
          <div className="settings-block-row">
            <p className="help" style={{ margin: 0 }}>
              {state.enabled ? t("statusEnabled") : t("statusDisabled")}
            </p>
            {state.canManage ? (
              <button
                type="button"
                onClick={() => setEnabled(!state.enabled)}
                disabled={busy}
                className={`btn btn-sm ${state.enabled ? "btn-ghost" : "btn-primary"}`}
              >
                {busy ? t("working") : state.enabled ? t("disableBtn") : t("enableBtn")}
              </button>
            ) : (
              <p className="help" style={{ margin: 0 }}>{t("readOnlyHint")}</p>
            )}
          </div>
        )}
        {error && <p className="error-text" style={{ marginTop: 10 }}>{error}</p>}
      </div>
    </section>
  );
}
