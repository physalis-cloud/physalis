"use client";

// Phase 11a — UI gestion des UserToken.
//
// Tokens user-scoped pour intégrations N8n / Make / scripts (READ only V1).
// Affichés dans /account à côté des sessions plugin.
//
// UX :
//   - Liste les tokens actifs/révoqués (préfixe + nom + dates)
//   - Création via dialog : nom (req) + expiration optionnelle (1-365j)
//   - Token brut affiché UNE SEULE FOIS après création — copy button
//   - Révocation soft via clic (confirmation native)

import { useCallback, useEffect, useState, useTransition } from "react";
import { RiKey2Line } from "@remixicon/react";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ConfirmDialog";

type UserToken = {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export default function UserTokensPanel() {
  const t = useTranslations("settings.security.userTokens");
  const confirm = useConfirm();

  const EXPIRY_OPTIONS: Array<{ label: string; days: number | null }> = [
    { label: t("expiry.never"), days: null },
    { label: t("expiry.30days"), days: 30 },
    { label: t("expiry.90days"), days: 90 },
    { label: t("expiry.1year"), days: 365 },
  ];

  const [tokens, setTokens] = useState<UserToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<{
    token: string;
    name: string;
  } | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/user-tokens");
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as { tokens: UserToken[] };
    setTokens(data.tokens);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function revoke(tok: UserToken) {
    if (!(await confirm({ message: t("revokeConfirm", { name: tok.name }), danger: true }))) {
      return;
    }
    const res = await fetch(`/api/user-tokens/${tok.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(t("revokeError"));
      return;
    }
    reload();
  }

  function isActive(tok: UserToken): boolean {
    if (tok.revokedAt) return false;
    if (tok.expiresAt && new Date(tok.expiresAt).getTime() < Date.now()) return false;
    return true;
  }

  return (
    <section className="settings-block">
      <div className="settings-block-row" style={{ marginBottom: 10 }}>
        <h2 className="settings-block-title" style={{ margin: 0 }}>{t("title")}</h2>
        {!creating && !justCreated && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="btn btn-primary btn-sm"
          >
            {t("createBtn")}
          </button>
        )}
      </div>
      <p className="settings-section-desc">{t("desc")}</p>

      <div className="settings-block-card">
      {error && <p className="error-text">{error}</p>}

      {justCreated && (
        <div
          className="card"
          style={{
            padding: 14,
            marginBottom: 12,
            background: "rgba(34, 197, 94, 0.08)",
            border: "1px solid rgba(34, 197, 94, 0.3)",
          }}
        >
          <div className="row-name" style={{ marginBottom: 6 }}>
            {t("created", { name: justCreated.name })}
          </div>
          <p className="help" style={{ marginBottom: 8 }}>
            {t("saveNow")}
          </p>
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <code
              className="code-mono"
              style={{
                flex: 1,
                padding: "8px 10px",
                background: "var(--surface-hover, rgba(0,0,0,0.2))",
                borderRadius: 4,
                wordBreak: "break-all",
                fontSize: 12,
              }}
            >
              {justCreated.token}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(justCreated.token).catch(() => null);
              }}
              className="btn btn-primary btn-sm"
            >
              {t("copyBtn")}
            </button>
            <button
              type="button"
              onClick={() => setJustCreated(null)}
              className="btn btn-ghost btn-sm"
            >
              {t("doneBtn")}
            </button>
          </div>
        </div>
      )}

      {creating && (
        <CreateForm
          onCancel={() => setCreating(false)}
          onCreated={(token, name) => {
            setCreating(false);
            setJustCreated({ token, name });
            reload();
          }}
        />
      )}

      {tokens === null ? (
        <p className="help">{t("loading")}</p>
      ) : tokens.length === 0 ? (
        <p className="help">{t("noTokens")}</p>
      ) : (
        <div className="row-list">
          {tokens.map((tok) => {
            const active = isActive(tok);
            return (
              <div key={tok.id} className="row" style={{ opacity: active ? 1 : 0.55 }}>
                <div className="row-icon"><RiKey2Line size={18} aria-hidden /></div>
                <div className="row-info">
                  <div className="row-name">
                    {tok.name}{" "}
                    <code className="code-mono" style={{ fontSize: 11, marginLeft: 6 }}>
                      {tok.prefix}…
                    </code>
                    {!active && (
                      <span
                        className="chip"
                        style={{
                          marginLeft: 6,
                          fontSize: 10,
                          background: "rgba(239, 68, 68, 0.15)",
                          color: "#ef4444",
                        }}
                      >
                        {tok.revokedAt ? t("status.revoked") : t("status.expired")}
                      </span>
                    )}
                  </div>
                  <div className="row-meta">
                    <span title={new Date(tok.createdAt).toLocaleString()}>
                      {t("createdAt", { time: relativeTime(tok.createdAt, t) })}
                    </span>
                    {tok.lastUsedAt && (
                      <span title={new Date(tok.lastUsedAt).toLocaleString()}>
                        · {t("lastUsed", { time: relativeTime(tok.lastUsedAt, t) })}
                      </span>
                    )}
                    {tok.expiresAt && (
                      <span title={new Date(tok.expiresAt).toLocaleString()}>
                        · {t("expires", { time: relativeTime(tok.expiresAt, t) })}
                      </span>
                    )}
                  </div>
                </div>
                {active && (
                  <div className="row-actions">
                    <button
                      type="button"
                      onClick={() => revoke(tok)}
                      className="btn btn-danger btn-xs"
                    >
                      {t("revokeBtn")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </div>
    </section>
  );
}

function CreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (token: string, name: string) => void;
}) {
  const t = useTranslations("settings.security.userTokens");
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<number | null>(90);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const EXPIRY_OPTIONS: Array<{ label: string; days: number | null }> = [
    { label: t("expiry.never"), days: null },
    { label: t("expiry.30days"), days: 30 },
    { label: t("expiry.90days"), days: 90 },
    { label: t("expiry.1year"), days: 365 },
  ];

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/user-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), expiresInDays }),
      });
      const data = (await res.json().catch(() => null)) as
        | { token?: string; error?: string }
        | null;
      if (!res.ok || !data?.token) {
        setError(data?.error ?? t("createError"));
        return;
      }
      onCreated(data.token, name.trim());
    });
  }

  return (
    <form onSubmit={submit} className="card" style={{ padding: 14, marginBottom: 12 }}>
      <div className="form-row">
        <div className="field" style={{ minWidth: 240, flex: 1 }}>
          <label>{t("nameLabel")}</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="N8n Voyages workflows"
            className="input"
            disabled={pending}
            required
          />
        </div>
        <div className="field" style={{ minWidth: 180 }}>
          <label>{t("expiryLabel")}</label>
          <select
            value={expiresInDays === null ? "never" : String(expiresInDays)}
            onChange={(e) =>
              setExpiresInDays(
                e.target.value === "never" ? null : Number(e.target.value),
              )
            }
            className="select"
            disabled={pending}
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.label} value={o.days === null ? "never" : String(o.days)}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
      <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="btn btn-primary btn-sm"
        >
          {t("createBtn")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-ghost btn-sm"
          disabled={pending}
        >
          {t("cancelBtn")}
        </button>
      </div>
    </form>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TFunc = (key: string, values?: any) => string;

function relativeTime(iso: string, t: TFunc): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return future ? t("relTime.inSeconds") : t("relTime.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return future ? t("relTime.inMinutes", { n: min }) : t("relTime.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return future ? t("relTime.inHours", { n: hr }) : t("relTime.hoursAgo", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return future ? t("relTime.inDays", { n: day }) : t("relTime.daysAgo", { n: day });
  const month = Math.floor(day / 30);
  if (month < 12) return future ? t("relTime.inMonths", { n: month }) : t("relTime.monthsAgo", { n: month });
  const year = Math.floor(day / 365);
  return future ? t("relTime.inYears", { n: year }) : t("relTime.yearsAgo", { n: year });
}
