"use client";

// Purge IMMÉDIATE du compte client — raccourci de la fenêtre de 30 jours,
// offert à l'OWNER depuis le bandeau de suppression en cours.
//
// L'action détruit le tenant entier, donc AUSSI les données de tous les autres
// membres. D'où l'affichage, en premier et avant toute saisie, du compteur
// « X sur Y ont récupéré leurs données » : la décision doit être informée, pas
// aveugle. Le plancher (règle serveur) empêche de toute façon de purger tant
// que ni la condition d'export ni le délai ne sont remplis.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type Eligibility = {
  confirmPhrase: string;
  allowed: boolean;
  exported: number;
  total: number;
  floorDaysRemaining: number;
  reauthFields: { password: boolean; code: boolean };
};

export default function PurgeNowDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("deletionBanner.purgeNow");
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmName, setConfirmName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/account/delete/now")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: Eligibility) => alive && setElig(d))
      .catch(() => alive && setError(t("loadError")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [t]);

  async function submit() {
    if (!elig) return;
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/account/delete/now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmName: confirmName.trim(),
          ...(password ? { password } : {}),
          ...(code ? { code: code.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(
          data?.error === "session_not_fresh"
            ? t("reauthStale")
            : data?.error === "purge_floor_not_reached"
              ? t("floorNotReached")
              : (data?.error ?? t("error")),
        );
        return;
      }
      // Le tenant n'existe plus : rester dans l'app n'a plus de sens.
      window.location.href = "/";
    } catch {
      setError(t("error"));
    } finally {
      setPending(false);
    }
  }

  const canSubmit =
    elig?.allowed === true &&
    confirmName.trim() === elig.confirmPhrase &&
    (!elig.reauthFields.password || password.length > 0) &&
    (!elig.reauthFields.code || code.trim().length > 0) &&
    !pending;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        style={{ maxWidth: 520 }}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{t("title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("cancelBtn")}
          >
            ✕
          </button>
        </div>

        <div className="dialog-body" style={{ display: "grid", gap: 10 }}>
          {loading ? (
            <p style={{ margin: 0 }}>{t("loading")}</p>
          ) : elig ? (
            <>
              <p style={{ margin: 0, lineHeight: 1.5 }}>{t("warning")}</p>

              {/* Le compteur en premier : c'est lui qui rend la décision
                  informée plutôt qu'aveugle. */}
              <p style={{ margin: 0, fontWeight: 600 }}>
                {t("exportedCount", {
                  exported: elig.exported,
                  total: elig.total,
                })}
              </p>

              {!elig.allowed && (
                <p className="error-text" style={{ margin: 0 }}>
                  {t("blocked", { days: elig.floorDaysRemaining })}
                </p>
              )}

              {elig.allowed && (
                <>
                  <label className="field">
                    <span>{t("confirmLabel", { name: elig.confirmPhrase })}</span>
                    <input
                      className="input"
                      value={confirmName}
                      onChange={(e) => setConfirmName(e.target.value)}
                      placeholder={elig.confirmPhrase}
                      autoFocus
                      disabled={pending}
                    />
                  </label>
                  {elig.reauthFields.password && (
                    <label className="field">
                      <span>{t("passwordLabel")}</span>
                      <input
                        className="input"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={pending}
                      />
                    </label>
                  )}
                  {elig.reauthFields.code && (
                    <label className="field">
                      <span>{t("codeLabel")}</span>
                      <input
                        className="input"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        disabled={pending}
                      />
                    </label>
                  )}
                  {!elig.reauthFields.password && !elig.reauthFields.code && (
                    <p style={{ margin: 0, fontSize: 13 }}>
                      {t("reauthFreshness")}
                    </p>
                  )}
                </>
              )}
            </>
          ) : null}

          {error && (
            <p className="error-text" style={{ margin: 0 }}>
              {error}
            </p>
          )}
        </div>

        <div className="dialog-footer">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm"
            disabled={pending}
          >
            {t("cancelBtn")}
          </button>
          <button
            type="button"
            onClick={submit}
            className="btn btn-danger btn-sm"
            disabled={!canSubmit}
          >
            {pending ? t("purgingBtn") : t("confirmBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
