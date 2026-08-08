"use client";

import { useEffect, useState, useTransition } from "react";
import { RiSaveLine } from "@remixicon/react";
import { useTranslations } from "next-intl";

type Org = { id: string; name: string; slug: string };
type Project = { id: string; name: string; slug: string };

export default function SecretRequestCreateDialog({
  orgs,
  onClose,
  onCreated,
}: {
  orgs: Org[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations("shares");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environmentName, setEnvironmentName] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [expiresInHours, setExpiresInHours] = useState(48);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [created, setCreated] = useState<{
    requestUrl: string;
    privateKey: string;
    label: string;
  } | null>(null);
  const [savingToVault, setSavingToVault] = useState(false);
  const [savedToVault, setSavedToVault] = useState(false);
  // Le coffre du projet est-il une destination d'import ouverte à CET
  // utilisateur sur CE projet ? Écrire dans un coffre d'équipe ne relève pas du
  // même droit qu'écrire un secret d'environnement (et c'est gaté par plan
  // côté SaaS) — on ne peut donc pas le déduire du fait qu'il voit le projet.
  // null = pas encore su. Cf. /api/secret-requests/vault-target.
  const [vaultTarget, setVaultTarget] = useState<{
    available: boolean;
    collectionName?: string;
  } | null>(null);
  // Étape de confirmation « pas de cible d'environnement » (Valider/Modifier).
  const [confirmVault, setConfirmVault] = useState(false);

  // Charge les projets de l'org sélectionnée.
  useEffect(() => {
    if (!orgId) {
      setProjects([]);
      return;
    }
    const slug = orgs.find((o) => o.id === orgId)?.slug;
    if (!slug) return;
    fetch(`/api/projects?org=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { projects?: Project[] } | null) => {
        setProjects(data?.projects ?? []);
        setProjectId("");
      })
      .catch(() => setProjects([]));
  }, [orgId, orgs]);

  // Préflight du repli « coffre du projet » à chaque changement de projet.
  useEffect(() => {
    setConfirmVault(false);
    if (!projectId) {
      setVaultTarget(null);
      return;
    }
    const slug = projects.find((p) => p.id === projectId)?.slug;
    if (!slug) {
      setVaultTarget(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/secret-requests/vault-target?project=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { available?: boolean; collectionName?: string } | null) => {
        if (cancelled) return;
        // Réponse illisible → on traite comme « indisponible » : mieux vaut
        // exiger une cible explicite que promettre une destination incertaine.
        setVaultTarget({
          available: data?.available === true,
          collectionName: data?.collectionName,
        });
      })
      .catch(() => {
        if (!cancelled) setVaultTarget({ available: false });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, projects]);

  // Esc → fermer
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    // Un projet sélectionné pose la question de la destination d'import. Sans
    // cette étape, une demande sans environnement ni clé partait en silence et
    // n'était JAMAIS importable : le bouton d'import n'apparaissait tout
    // simplement pas au retour du tiers, sans le moindre message.
    if (projectId && !confirmVault) {
      const hasEnv = environmentName.trim().length > 0;
      const hasKey = secretKey.trim().length > 0;

      // À moitié rempli : ce n'est pas une cible, et deviner l'autre moitié
      // serait pire que demander.
      if (hasEnv !== hasKey) {
        setError(t("createRequestDialog.targetIncomplete"));
        return;
      }
      if (!hasEnv && !hasKey) {
        // Repli fermé (droits insuffisants sur le coffre du projet, ou plan
        // sans coffre d'équipe) → on exige une cible explicite plutôt que de
        // promettre une destination que le serveur refusera à l'import.
        if (!vaultTarget?.available) {
          setError(t("createRequestDialog.targetRequired"));
          return;
        }
        setConfirmVault(true);
        return;
      }
    }

    startTransition(async () => {
      const res = await fetch("/api/secret-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label,
          description: description || undefined,
          organizationId: orgId,
          projectId: projectId || undefined,
          environmentName: environmentName || undefined,
          secretKey: secretKey || undefined,
          recipientEmail: recipientEmail || undefined,
          expiresInHours,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(data?.error ?? t("createRequestDialog.error"));
        return;
      }
      const data = (await res.json()) as {
        id: string;
        requestUrl: string;
        privateKey: string;
      };
      setCreated({
        requestUrl: data.requestUrl,
        privateKey: data.privateKey,
        label,
      });
    });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }

  async function saveToVault() {
    if (!created) return;
    setSavingToVault(true);
    try {
      const res = await fetch("/api/vault/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Private key — ${created.label}`,
          password: created.privateKey,
          tags: ["secret-request", "hybrid-pqc-key"],
        }),
      });
      if (res.ok) setSavedToVault(true);
    } finally {
      setSavingToVault(false);
    }
  }

  function done() {
    setCreated(null);
    onCreated();
    onClose();
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog dialog-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560 }}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">
            {created ? t("requestCreated.title") : t("createRequestDialog.title")}
          </h2>
          <button
            type="button"
            onClick={created ? done : onClose}
            className="dialog-close"
            aria-label={t("createRequestDialog.cancelBtn")}
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          {created ? (
            <>
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  background: "var(--accent-bg)",
                  fontSize: 13,
                }}
              >
                {t("requestCreated.saveKeyWarning")}
              </div>
              <div className="field">
                <label>{t("requestCreated.linkLabel")}</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    readOnly
                    value={created.requestUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="input input-mono"
                    style={{ fontSize: 12 }}
                  />
                  <button
                    type="button"
                    onClick={() => copy(created.requestUrl)}
                    className="btn btn-ghost btn-sm"
                  >
                    {t("requestCreated.copyBtn")}
                  </button>
                </div>
              </div>
              <div className="field">
                <label>{t("requestCreated.privateKeyLabel")}</label>
                <textarea
                  readOnly
                  rows={4}
                  value={created.privateKey}
                  onFocus={(e) => e.currentTarget.select()}
                  className="input input-mono"
                  style={{ fontSize: 11, resize: "vertical" }}
                />
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginTop: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => copy(created.privateKey)}
                    className="btn btn-ghost btn-sm"
                  >
                    {t("requestCreated.copyKeyBtn")}
                  </button>
                  <button
                    type="button"
                    onClick={saveToVault}
                    disabled={savingToVault || savedToVault}
                    className="btn btn-primary btn-sm"
                  >
                    {savedToVault
                      ? t("requestCreated.savedToVault")
                      : savingToVault
                        ? t("requestCreated.savingBtn")
                        : (
                          <>
                            <RiSaveLine size={14} aria-hidden /> {t("requestCreated.saveToVaultBtn")}
                          </>
                        )}
                  </button>
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  marginTop: 8,
                }}
              >
                <button
                  type="button"
                  onClick={done}
                  className="btn btn-primary"
                >
                  {t("requestCreated.doneBtn")}
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <div className="field">
                <label>{t("createRequestDialog.labelLabel")}</label>
                <input
                  required
                  autoFocus
                  maxLength={200}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="input"
                />
              </div>

              <div className="field">
                <label>{t("createRequestDialog.descriptionLabel")}</label>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="input"
                  style={{ resize: "vertical" }}
                />
              </div>

              <div className="field">
                <label>{t("createRequestDialog.recipientLabel")}</label>
                <input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  className="input"
                />
                <div className="help" style={{ marginTop: 4, fontSize: 12 }}>
                  {t("createRequestDialog.recipientHint")}
                </div>
              </div>

              <div className="form-row">
                <div className="field" style={{ flex: 1 }}>
                  <label>{t("createRequestDialog.orgLabel")}</label>
                  <select
                    required
                    value={orgId}
                    onChange={(e) => setOrgId(e.target.value)}
                    className="select"
                  >
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>{t("createRequestDialog.projectLabel")}</label>
                  <select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="select"
                  >
                    <option value="">{t("createRequestDialog.noneProject")}</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="field" style={{ flex: 1 }}>
                  <label>{t("createRequestDialog.expirationLabel")}</label>
                  <select
                    value={expiresInHours}
                    onChange={(e) => setExpiresInHours(Number(e.target.value))}
                    className="select"
                  >
                    <option value={1}>{t("createRequestDialog.expiration1h")}</option>
                    <option value={24}>{t("createRequestDialog.expiration24h")}</option>
                    <option value={48}>{t("createRequestDialog.expiration48h")}</option>
                    <option value={168}>{t("createRequestDialog.expiration7d")}</option>
                  </select>
                </div>
              </div>

              {projectId && (
                <div className="form-row">
                  <div className="field" style={{ flex: 1 }}>
                    <label>{t("createRequestDialog.envLabel")}</label>
                    <input
                      maxLength={100}
                      value={environmentName}
                      onChange={(e) => setEnvironmentName(e.target.value)}
                      placeholder="production"
                      className="input"
                    />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>{t("createRequestDialog.keyLabel")}</label>
                    <input
                      value={secretKey}
                      onChange={(e) =>
                        setSecretKey(e.target.value.toUpperCase())
                      }
                      placeholder="STRIPE_SECRET_KEY"
                      className="input input-mono"
                    />
                  </div>
                </div>
              )}

              {error && <p className="error-text">{error}</p>}

              {confirmVault ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    marginTop: 6,
                    padding: 12,
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                  }}
                >
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
                    {t("createRequestDialog.vaultFallbackNotice", {
                      collection:
                        vaultTarget?.collectionName ??
                        t("createRequestDialog.vaultFallbackCollection"),
                    })}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 8,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setConfirmVault(false)}
                      className="btn btn-ghost btn-sm"
                    >
                      {t("createRequestDialog.vaultFallbackEditBtn")}
                    </button>
                    <button
                      type="submit"
                      disabled={pending}
                      className="btn btn-primary btn-sm"
                    >
                      {pending
                        ? t("createRequestDialog.creatingBtn")
                        : t("createRequestDialog.vaultFallbackConfirmBtn")}
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                    marginTop: 6,
                  }}
                >
                  <button
                    type="button"
                    onClick={onClose}
                    className="btn btn-ghost btn-sm"
                  >
                    {t("createRequestDialog.cancelBtn")}
                  </button>
                  <button
                    type="submit"
                    disabled={pending || !label || !orgId}
                    className="btn btn-primary btn-sm"
                  >
                    {pending ? t("createRequestDialog.creatingBtn") : t("createRequestDialog.submitBtn")}
                  </button>
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
