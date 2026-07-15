"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { OrgRole } from "@prisma/client";
import { RiHistoryLine, RiKey2Line } from "@remixicon/react";
import EmptyCard from "@/components/EmptyCard";
import SecretHistoryDialog from "@/components/SecretHistoryDialog";
import { useConfirm } from "@/components/ConfirmDialog";

type SecretListItem = {
  key: string;
  updatedAt: string;
  createdAt: string;
  expiresAt: string | null;
};

function fmtDate(iso?: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}
/** "" (ok) | "warn" (< 7 j) | "expired". */
function expiryState(iso?: string | null): "" | "warn" | "expired" {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  if (ms < 7 * 86_400_000) return "warn";
  return "";
}
const EXPIRY_COLOR: Record<string, string> = {
  expired: "var(--danger-fg, #c0392b)",
  warn: "#9a6a00",
  "": "var(--muted)",
};

const ORG_ROLE_RANK: Record<OrgRole, number> = {
  MEMBER: 1,
  DEV: 2,
  ADMIN_DEV: 3,
  ADMIN: 4,
  OWNER: 5,
};

export default function OrgSecretsPanel({
  slug,
  role,
}: {
  slug: string;
  role: OrgRole;
}) {
  const t = useTranslations("orgs.secrets");
  const confirm = useConfirm();
  const [secrets, setSecrets] = useState<SecretListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);

  // DEV+ peut lire (list + reveal). ADMIN+ peut créer/modifier/supprimer.
  const canRead = ORG_ROLE_RANK[role] >= ORG_ROLE_RANK.DEV;
  const canManage = ORG_ROLE_RANK[role] >= ORG_ROLE_RANK.ADMIN_DEV;

  const reload = useCallback(async () => {
    if (!canRead) {
      setSecrets([]);
      return;
    }
    setError(null);
    const res = await fetch(`/api/orgs/${slug}/secrets`);
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as { secrets: SecretListItem[] };
    setSecrets(data.secrets);
  }, [slug, canRead]);

  useEffect(() => {
    setSecrets(null);
    setRevealed({});
    setEditKey(null);
    setAdding(false);
    reload();
  }, [reload]);

  async function reveal(key: string) {
    if (revealed[key] !== undefined) {
      setRevealed((r) => {
        const copy = { ...r };
        delete copy[key];
        return copy;
      });
      return;
    }
    const res = await fetch(
      `/api/orgs/${slug}/secrets/${encodeURIComponent(key)}`,
    );
    if (!res.ok) {
      setError(t("revealError"));
      return;
    }
    const data = (await res.json()) as { value: string };
    setRevealed((r) => ({ ...r, [key]: data.value }));
  }

  async function remove(key: string) {
    if (!(await confirm({ message: t("deleteConfirm", { key }), danger: true }))) return;
    const res = await fetch(
      `/api/orgs/${slug}/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    setRevealed((r) => {
      const copy = { ...r };
      delete copy[key];
      return copy;
    });
    reload();
  }

  if (!canRead) {
    return (
      <p className="help">
        {t("readOnly")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="section-header">
        <div>
          <h2 className="section-title">{t("title")}</h2>
          <p className="help" style={{ marginTop: 4 }}>
            {t("desc")}
          </p>
        </div>
        {!adding && canManage && secrets && secrets.length > 0 && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn btn-primary btn-sm"
          >
            {t("addBtn")}
          </button>
        )}
      </div>

      {adding && (
        <div className="create-card">
          <SecretForm
            slug={slug}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {secrets === null ? (
        <p className="help">{t("loading")}</p>
      ) : secrets.length === 0 && !adding ? (
        <EmptyCard
          icon={<RiKey2Line size={22} aria-hidden />}
          title={t("empty")}
          action={
            canManage && !adding ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAdding(true)}
              >
                {t("addBtn")}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="row-list">
          {secrets.map((s) =>
            editKey === s.key ? (
              <div key={s.key} className="card">
                <SecretForm
                  slug={slug}
                  initialKey={s.key}
                  onCancel={() => setEditKey(null)}
                  onSaved={() => {
                    setEditKey(null);
                    setRevealed((r) => {
                      const copy = { ...r };
                      delete copy[s.key];
                      return copy;
                    });
                    reload();
                  }}
                />
              </div>
            ) : (
              <div key={s.key} className="row">
                <div className="row-icon"><RiKey2Line size={18} aria-hidden /></div>
                <div className="row-info">
                  <div className="row-name code-mono flex items-center gap-2">
                    {s.key}
                  </div>
                  <div
                    className="row-meta"
                    style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}
                  >
                    <span className="help" style={{ fontSize: 12 }}>
                      {t("createdAt", { date: fmtDate(s.createdAt) })}
                    </span>
                    {s.expiresAt && (
                      <span
                        style={{ fontSize: 12, fontWeight: 600, color: EXPIRY_COLOR[expiryState(s.expiresAt)] }}
                      >
                        {expiryState(s.expiresAt) === "expired"
                          ? t("expiredAt", { date: fmtDate(s.expiresAt) })
                          : t("expiresAt", { date: fmtDate(s.expiresAt) })}
                      </span>
                    )}
                    <span className="code-mono">
                      {revealed[s.key] !== undefined ? revealed[s.key] : "••••••••••••"}
                    </span>
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    onClick={() => reveal(s.key)}
                    className="btn btn-ghost btn-xs"
                  >
                    {revealed[s.key] !== undefined ? t("hideBtn") : t("revealBtn")}
                  </button>
                  {canManage && (
                    <>
                      <button
                        type="button"
                        onClick={() => setHistoryKey(s.key)}
                        className="btn btn-ghost btn-xs"
                      >
                        <RiHistoryLine size={12} aria-hidden /> {t("historyBtn")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditKey(s.key)}
                        className="btn btn-ghost btn-xs"
                      >
                        {t("editBtn")}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(s.key)}
                        className="btn btn-danger btn-xs"
                      >
                        {t("deleteBtn")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {historyKey && (
        <SecretHistoryDialog
          apiBaseUrl={`/api/orgs/${slug}/secrets/${encodeURIComponent(historyKey)}/versions`}
          secretKey={historyKey}
          onClose={() => setHistoryKey(null)}
          onRestored={() => {
            setRevealed({});
            reload();
          }}
        />
      )}
    </div>
  );
}

function SecretForm({
  slug,
  initialKey,
  onCancel,
  onSaved,
}: {
  slug: string;
  initialKey?: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("orgs.secrets");
  const [key, setKey] = useState(initialKey ?? "");
  const [value, setValue] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(initialKey);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/orgs/${slug}/secrets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value, expiresInDays }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      onSaved();
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="form-row">
        <div className="field" style={{ minWidth: 200 }}>
          <label>{t("form.keyLabel")}</label>
          <input
            required
            readOnly={isEdit}
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder="STRIPE_API_KEY"
            className="input input-mono"
          />
        </div>
        <div className="field" style={{ minWidth: 240, flex: 2 }}>
          <label>{t("form.valueLabel")}</label>
          <input
            required
            autoFocus={isEdit}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isEdit ? t("form.newValuePlaceholder") : t("form.valuePlaceholder")}
            className="input input-mono"
          />
        </div>
        <div className="field" style={{ minWidth: 160 }}>
          <label>{t("form.expiryLabel")}</label>
          <select
            value={expiresInDays ?? ""}
            onChange={(e) =>
              setExpiresInDays(e.target.value === "" ? null : Number(e.target.value))
            }
            className="input"
          >
            <option value="">{t("form.expiry.never")}</option>
            <option value="30">{t("form.expiry.30d")}</option>
            <option value="60">{t("form.expiry.60d")}</option>
            <option value="90">{t("form.expiry.90d")}</option>
            <option value="365">{t("form.expiry.1y")}</option>
          </select>
        </div>
      </div>
      <p className="help" style={{ marginTop: 6, fontSize: 12 }}>
        {t("form.expiryHint")}
      </p>
      {error && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary btn-sm"
        >
          {pending ? t("form.savingBtn") : isEdit ? t("form.updateBtn") : t("form.submitBtn")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-ghost btn-sm"
        >
          {t("form.cancelBtn")}
        </button>
      </div>
    </form>
  );
}
