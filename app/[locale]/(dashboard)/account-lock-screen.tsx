"use client";

// Écran de verrou — affiché à la place de TOUT l'espace quand l'utilisateur a
// demandé la suppression de SON compte (User.deletionRequestedAt non nul).
//
// Pourquoi un rendu de layout et pas une redirection middleware : toutes les
// pages /(dashboard)/* traversent la même layout, donc rendre cet écran à la
// place de `children` est infranchissable — changer l'URL à la main ne donne
// accès à rien, et il n'y a aucune boucle de redirection à gérer.
//
// Non fermable, DÉLIBÉRÉMENT : ni bouton de fermeture, ni clic sur le fond, ni
// Échap. Ce n'est pas une modale d'information, c'est l'état de l'espace.
//
// ⚠️ Le verrou porte sur les PAGES, jamais sur /api/me/export : c'est la seule
// fonction utile de cet écran. Un middleware trop large la casserait
// silencieusement, et personne ne s'en apercevrait avant le jour où quelqu'un
// essaie vraiment de récupérer ses données.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { RiAlarmWarningLine, RiDownloadLine } from "@remixicon/react";

/**
 * Quels champs de preuve d'identité afficher, calculés PAR LE SERVEUR depuis
 * `reauthMethodFor` (cf. lib/reauth.ts). On ne réimplémente pas l'échelle ici :
 * ce serait une seconde source de vérité, exactement ce que le helper unique
 * existe pour éviter. Le serveur revérifie tout de toute façon.
 */
export type ReauthFields = { password: boolean; code: boolean };

export default function AccountLockScreen({
  purgeAtIso,
  daysRemaining,
  email,
  reauthFields,
}: {
  purgeAtIso: string | null;
  /** Jours entiers restants (arrondi au supérieur, borné à 0). */
  daysRemaining: number | null;
  /** Phrase à recopier pour l'irréversible = l'adresse du compte. */
  email: string;
  reauthFields: ReauthFields;
}) {
  const t = useTranslations("accountLock");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const purgeDate = purgeAtIso
    ? new Date(purgeAtIso).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : null;

  // Contrairement au bouton d'export de la page Compte (qui pose
  // `window.location.href` et laisse le navigateur gérer), on passe par fetch +
  // blob ICI pour pouvoir AFFICHER l'échec. Sur cet écran, l'export est le seul
  // moyen de récupérer ses données : un échec silencieux se solderait par une
  // perte définitive. Le surcoût mémoire est négligeable (JSON d'un coffre).
  async function download() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/me/export");
      if (res.status === 429) {
        setError(t("rateLimited"));
        return;
      }
      if (!res.ok) {
        setError(t("downloadError"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers
          .get("Content-Disposition")
          ?.match(/filename="?([^";]+)"?/)?.[1] ?? "physalis-export.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDone(true);
    } catch {
      setError(t("downloadError"));
    } finally {
      setPending(false);
    }
  }

  async function reactivate() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/me/delete/cancel", { method: "POST" });
      if (!res.ok) {
        setError(t("reactivateError"));
        return;
      }
      // Le verrou disparaît au re-render de la layout.
      router.refresh();
    } catch {
      setError(t("reactivateError"));
    } finally {
      setPending(false);
    }
  }

  // Action IRRÉVERSIBLE : phrase à recopier (intention) + preuve d'identité
  // selon le palier du compte (cf. lib/reauth.ts). Le serveur revérifie tout —
  // ce formulaire ne fait qu'éviter un aller-retour perdu.
  async function purgeNow() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/me/delete/now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmPhrase: confirmPhrase.trim(),
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
            : (data?.error ?? t("purgeError")),
        );
        return;
      }
      // Le compte n'existe plus : la session ne vaut plus rien, on repart au
      // login plutôt que de laisser l'app tenter un rendu impossible.
      window.location.href = "/";
    } catch {
      setError(t("purgeError"));
    } finally {
      setPending(false);
    }
  }

  const canPurge =
    confirmPhrase.trim() === email &&
    (!reauthFields.password || password.length > 0) &&
    (!reauthFields.code || code.trim().length > 0) &&
    !pending;

  return (
    <div
      className="dialog-overlay"
      style={{ position: "fixed", inset: 0, zIndex: 1000 }}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="account-lock-title"
        style={{ maxWidth: 520 }}
      >
        <div className="dialog-header">
          <h2
            id="account-lock-title"
            className="dialog-title"
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <RiAlarmWarningLine size={22} aria-hidden />
            {t("title")}
          </h2>
          {/* Pas de bouton de fermeture : l'écran n'est pas fermable. */}
        </div>

        <div className="dialog-body">
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            {purgeDate ? t("desc", { date: purgeDate }) : t("descNoDate")}
          </p>

          {daysRemaining !== null && (
            <p style={{ marginTop: 12, marginBottom: 0, fontWeight: 600 }}>
              {daysRemaining === 0
                ? t("remainingToday")
                : t("remaining", { days: daysRemaining })}
            </p>
          )}

          <p style={{ marginTop: 16, marginBottom: 0, lineHeight: 1.55 }}>
            {t("recoverHint")}
          </p>

          {done && (
            <p
              style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}
              role="status"
            >
              {t("downloadDone")}
            </p>
          )}
          {error && (
            <p
              style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        {/* Suppression définitive — seule action irréversible de cet écran,
            donc la seule à exiger une preuve d'identité EN PLUS de la phrase.
            Repliée par défaut : c'est un raccourci, pas le chemin normal. */}
        {purgeOpen && (
          <div className="dialog-body" style={{ display: "grid", gap: 10 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>{t("purgeTitle")}</p>
            <p style={{ margin: 0, lineHeight: 1.5 }}>{t("purgeWarning")}</p>
            {!done && (
              <p style={{ margin: 0, fontSize: 13 }} role="alert">
                {t("purgeNotExported")}
              </p>
            )}
            <label className="field">
              <span>{t("confirmLabel", { phrase: email })}</span>
              <input
                className="input"
                value={confirmPhrase}
                onChange={(e) => setConfirmPhrase(e.target.value)}
                placeholder={email}
                disabled={pending}
              />
            </label>
            {reauthFields.password && (
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
            {reauthFields.code && (
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
            {!reauthFields.password && !reauthFields.code && (
              // Palier 3 : rien à saisir, la preuve est la fraîcheur de la
              // session. On le DIT, sinon l'absence de champ passe pour un bug.
              <p style={{ margin: 0, fontSize: 13 }}>{t("reauthFreshness")}</p>
            )}
          </div>
        )}

        <div className="dialog-footer" style={{ flexWrap: "wrap", gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={download}
            disabled={pending}
          >
            <RiDownloadLine size={16} aria-hidden />
            {pending ? t("downloadingBtn") : t("downloadBtn")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={reactivate}
            disabled={pending}
          >
            {t("reactivateBtn")}
          </button>
          {!purgeOpen ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPurgeOpen(true)}
              disabled={pending}
              style={{ color: "var(--danger)" }}
            >
              {t("purgeOpenBtn")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={purgeNow}
              disabled={!canPurge}
            >
              {pending ? t("purgingBtn") : t("purgeConfirmBtn")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
