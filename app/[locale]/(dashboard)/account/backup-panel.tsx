"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";

type Server = { id: string; name: string; ip: string };
type State = {
  enabled: boolean;
  canManage: boolean;
  backupServerId: string | null;
  backupPath: string | null;
  servers: Server[];
};

/**
 * Interrupteur + DESTINATION du service de backup au niveau CLIENT (tenant).
 * La destination (VPS + chemin de base) est commune à tous les projets du client.
 * La visibilité de ce panneau est gated en amont (page Sécurité).
 */
export default function AccountBackupPanel() {
  const t = useTranslations("settings.backup");
  const base = "/api/account/backup";

  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [serverId, setServerId] = useState("");
  const [path, setPath] = useState("");
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
    const data = (await res.json()) as State;
    setState(data);
    setServerId(data.backupServerId ?? "");
    setPath(data.backupPath ?? "");
    setLoading(false);
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(next: boolean) {
    setError(null);
    setSaved(false);
    startBusy(async () => {
      const res = await fetch(base, { method: next ? "POST" : "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? t("loadError"));
        return;
      }
      await load();
    });
  }

  function saveDestination() {
    setError(null);
    setSaved(false);
    startBusy(async () => {
      const res = await fetch(base, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backupServerId: serverId, backupPath: path.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? t("loadError"));
        return;
      }
      setSaved(true);
      await load();
    });
  }

  const destValid = serverId !== "" && path.trim().startsWith("/");

  return (
    <section className="settings-block">
      <h2 className="settings-block-title">{t("title")}</h2>
      <p className="settings-section-desc">{t("intro")}</p>

      <div className="settings-block-card flex flex-col gap-3">
      {loading ? (
        <p className="help">Chargement…</p>
      ) : (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state?.enabled ?? false}
              disabled={busy || !state?.canManage}
              onChange={(e) => toggle(e.target.checked)}
            />
            <span>{t("enableLabel")}</span>
          </label>

          {state?.enabled && state.canManage && (
            <div className="flex flex-col gap-2" style={{ marginTop: 4 }}>
              <h3 className="help" style={{ fontWeight: 600 }}>{t("destTitle")}</h3>
              <p className="help">{t("destIntro")}</p>
              <div className="flex gap-3 flex-wrap items-end">
                <label className="flex flex-col gap-1">
                  <span className="help">{t("destServer")}</span>
                  <select className="select" value={serverId} onChange={(e) => setServerId(e.target.value)} style={{ minWidth: 200 }}>
                    <option value="">{t("selectServer")}</option>
                    {state.servers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.ip})</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="help">{t("destPath")}</span>
                  <input className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/srv/backups" style={{ minWidth: 220 }} />
                </label>
                <button type="button" className="btn btn-primary btn-primary-form" onClick={saveDestination} disabled={busy || !destValid}>
                  {busy ? t("saving") : t("destSave")}
                </button>
              </div>
              <p className="help">{t("destHint")}</p>
              {saved && <p className="help" style={{ color: "var(--ok, green)" }}>{t("destSaved")}</p>}
            </div>
          )}
        </>
      )}

      {!loading && !state?.canManage && <p className="help">{t("readOnlyHint")}</p>}
      {error && <p className="error-text">{error}</p>}
      </div>
    </section>
  );
}
