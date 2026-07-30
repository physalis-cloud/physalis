"use client";

// Zone dangereuse — suppression de SON PROPRE compte utilisateur.
//
// ⚠️ À ne pas confondre avec DeleteAccountPanel (juste à côté), qui supprime
// tout le CLIENT et n'est offert qu'à l'OWNER de l'org principale. Ici le
// tenant survit : seul ce compte disparaît, avec son coffre personnel et ses
// appartenances.
//
// L'éligibilité est chargée à l'OUVERTURE, pas au rendu de la page : inutile de
// faire payer une requête à chaque affichage du compte pour un panneau que
// presque personne n'ouvre.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";

type Eligibility = {
  confirmPhrase: string;
  canDelete: boolean;
  pending: boolean;
  recoveryWindowDays: number;
  tenantPendingDeletion: boolean;
  blockingOrgs: { id: string; name: string }[];
};

export default function DeleteMyAccountPanel() {
  const t = useTranslations("account.deleteMyAccount");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function openPanel() {
    setOpen(true);
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/me/delete");
      if (!res.ok) throw new Error();
      setElig((await res.json()) as Eligibility);
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    if (!elig || confirmPhrase.trim() !== elig.confirmPhrase) return;
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/me/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmPhrase: confirmPhrase.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? t("error"));
        return;
      }
      // L'espace bascule en verrouillé : le rafraîchissement fait rendre
      // l'écran de verrou par la layout, sans redirection à orchestrer ici.
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const canSubmit =
    elig?.canDelete === true &&
    confirmPhrase.trim() === elig.confirmPhrase &&
    !pending;

  return (
    <section className="section">
      <div
        className="card"
        style={{
          padding: 24,
          border: "1px solid var(--danger)",
          display: "grid",
          gap: 12,
        }}
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
              onClick={openPanel}
            >
              {t("openBtn")}
            </button>
          </div>
        ) : loading ? (
          <p className="help" style={{ margin: 0 }}>
            {t("loading")}
          </p>
        ) : elig ? (
          <div style={{ display: "grid", gap: 10 }}>
            {/* Le tenant part de toute façon : proposer une suppression
                individuelle n'aurait aucun sens. */}
            {elig.tenantPendingDeletion ? (
              <p className="error-text" style={{ margin: 0 }}>
                {t("tenantPending")}
              </p>
            ) : elig.blockingOrgs.length > 0 ? (
              // Le cas du dernier OWNER est annoncé AVANT toute saisie, avec le
              // nom des organisations concernées — plutôt qu'un refus après coup.
              <p className="error-text" style={{ margin: 0 }}>
                {t("lastOwner", {
                  orgs: elig.blockingOrgs.map((o) => o.name).join(", "),
                })}
              </p>
            ) : (
              <>
                <p className="help" style={{ margin: 0 }}>
                  {t("consequences", { days: elig.recoveryWindowDays })}
                </p>
                <label className="field" style={{ maxWidth: 360 }}>
                  <span>{t("confirmLabel", { phrase: elig.confirmPhrase })}</span>
                  <input
                    className="input"
                    value={confirmPhrase}
                    onChange={(e) => setConfirmPhrase(e.target.value)}
                    placeholder={elig.confirmPhrase}
                    autoFocus
                    disabled={pending}
                  />
                </label>
              </>
            )}

            {error && (
              <p className="error-text" style={{ margin: 0 }}>
                {error}
              </p>
            )}

            <div className="flex items-center gap-2">
              {elig.canDelete && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={submit}
                  disabled={!canSubmit}
                >
                  {pending ? t("submittingBtn") : t("confirmBtn")}
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setOpen(false);
                  setConfirmPhrase("");
                  setError(null);
                  setElig(null);
                }}
                disabled={pending}
              >
                {t("cancelBtn")}
              </button>
            </div>
          </div>
        ) : (
          <div>
            {error && (
              <p className="error-text" style={{ margin: 0 }}>
                {error}
              </p>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setOpen(false)}
            >
              {t("cancelBtn")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
