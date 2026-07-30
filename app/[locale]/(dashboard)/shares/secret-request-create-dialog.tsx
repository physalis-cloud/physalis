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
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
