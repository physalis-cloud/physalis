"use client";

// Sessions CLI (`physalis login`) de l'utilisateur — C-0050, phase 2. Même
// forme que le panneau des sessions de l'extension (plugin-sessions-panel).

import { useCallback, useEffect, useState } from "react";
import { RiTerminalBoxLine, RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ConfirmDialog";

const PAGE_SIZE = 5;

type CliSession = {
  id: string;
  kind: string;
  deviceName: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  aiScope: string[] | null;
  isActive: boolean;
};

export default function CliSessionsPanel() {
  const t = useTranslations("settings.security.cliSessions");
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<CliSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/cli/sessions");
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as { sessions: CliSession[] };
    setSessions(data.sessions);
    setPage(0);
  }, [t]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function revoke(id: string) {
    if (!(await confirm({ message: t("revokeBtn"), danger: true }))) return;
    const res = await fetch(`/api/cli/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(t("revokeError"));
      return;
    }
    reload();
  }

  const totalPages = sessions ? Math.ceil(sessions.length / PAGE_SIZE) : 0;
  const pageSessions = sessions ? sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : [];

  return (
    <section className="settings-block">
      <h2 className="settings-block-title">{t("title")}</h2>
      <p className="settings-section-desc">{t("desc")}</p>

      <div className="settings-block-card">
      {error && <p className="error-text">{error}</p>}

      {sessions === null ? (
        <p className="help">{t("loading")}</p>
      ) : sessions.length === 0 ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <div>{t("noSessions")}</div>
        </div>
      ) : (
        <>
          <div className="row-list">
            {pageSessions.map((s) => {
              const status = s.isActive
                ? t("status.active")
                : s.revokedAt
                  ? t("status.revoked")
                  : t("status.expired");
              const badgeClass = s.isActive
                ? "badge success"
                : s.revokedAt
                  ? "badge danger"
                  : "badge";
              return (
                <div key={s.id} className="row">
                  <div className="row-icon"><RiTerminalBoxLine size={18} aria-hidden /></div>
                  <div className="row-info">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={badgeClass}>{status}</span>
                      <span className="badge">{t(s.kind === "AI" ? "kind.AI" : "kind.HUMAN")}</span>
                      <span className="row-name" style={{ fontSize: 13 }}>
                        {s.deviceName ?? t("unknownDevice")}
                      </span>
                    </div>
                    {s.aiScope && (
                      <div className="row-meta code-mono">
                        {t("aiScope", { scope: s.aiScope.join(", ") || "—" })}
                      </div>
                    )}
                    <div className="row-meta code-mono">
                      {t("createdAt", { date: new Date(s.createdAt).toLocaleString() })}
                      {s.ip && <>{" "}{t("ip", { ip: s.ip })}</>}
                      {" · "}{t("expires", { date: new Date(s.expiresAt).toLocaleString() })}
                      {s.lastUsedAt && (
                        <>
                          {" · "}{t("lastUsed", { date: new Date(s.lastUsedAt).toLocaleString() })}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="row-actions">
                    {s.isActive && (
                      <button
                        type="button"
                        onClick={() => revoke(s.id)}
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
              <span>{page + 1}/{totalPages}</span>
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
