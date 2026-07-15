"use client";

import { useCallback, useEffect, useState } from "react";
import { RiPlugLine, RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ConfirmDialog";

const PAGE_SIZE = 5;

type PluginToken = {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  userAgent: string | null;
  isActive: boolean;
};

export default function PluginSessionsPanel() {
  const t = useTranslations("settings.security.pluginSessions");
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<PluginToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/plugin/tokens");
    if (!res.ok) {
      setError("Erreur de chargement.");
      return;
    }
    const data = (await res.json()) as { tokens: PluginToken[] };
    setTokens(data.tokens);
    setPage(0);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function revoke(id: string) {
    if (!(await confirm({ message: t("revokeBtn"), danger: true }))) return;
    const res = await fetch(`/api/plugin/tokens/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(t("revokeError"));
      return;
    }
    reload();
  }

  const totalPages = tokens ? Math.ceil(tokens.length / PAGE_SIZE) : 0;
  const pageTokens = tokens ? tokens.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : [];

  return (
    <section className="settings-block">
      <h2 className="settings-block-title">{t("title")}</h2>
      <p className="settings-section-desc">{t("desc")}</p>

      <div className="settings-block-card">
      {error && <p className="error-text">{error}</p>}

      {tokens === null ? (
        <p className="help">Chargement…</p>
      ) : tokens.length === 0 ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <div>{t("noSessions")}</div>
        </div>
      ) : (
        <>
          <div className="row-list">
            {pageTokens.map((tok) => {
              const status = tok.isActive
                ? t("status.active")
                : tok.revokedAt
                  ? t("status.revoked")
                  : t("status.expired");
              const badgeClass = tok.isActive
                ? "badge success"
                : tok.revokedAt
                  ? "badge danger"
                  : "badge";
              return (
                <div key={tok.id} className="row">
                  <div className="row-icon"><RiPlugLine size={18} aria-hidden /></div>
                  <div className="row-info">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={badgeClass}>{status}</span>
                      {tok.userAgent && (
                        <span className="row-name" style={{ fontSize: 13 }}>
                          {tok.userAgent}
                        </span>
                      )}
                    </div>
                    <div className="row-meta code-mono">
                      {t("createdAt", { date: new Date(tok.createdAt).toLocaleString() })}
                      {" · "}{t("expires", { date: new Date(tok.expiresAt).toLocaleString() })}
                      {tok.lastUsedAt && (
                        <>
                          {" · "}{t("lastUsed", { date: new Date(tok.lastUsedAt).toLocaleString() })}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="row-actions">
                    {tok.isActive && (
                      <button
                        type="button"
                        onClick={() => revoke(tok.id)}
                        className="btn btn-danger btn-xs"
                      >
                        {t("revokeBtn")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3" style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
              <span>{tokens.length} session{tokens.length > 1 ? "s" : ""} · page {page + 1}/{totalPages}</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="btn btn-ghost btn-xs"
                  aria-label={t("prevPage")}
                >
                  <RiArrowLeftSLine size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page === totalPages - 1}
                  className="btn btn-ghost btn-xs"
                  aria-label={t("nextPage")}
                >
                  <RiArrowRightSLine size={16} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
      </div>
    </section>
  );
}
