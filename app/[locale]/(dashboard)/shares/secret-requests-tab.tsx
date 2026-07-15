"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { RiMailLine } from "@remixicon/react";
import { useConfirm } from "@/components/ConfirmDialog";
import EmptyCard from "@/components/EmptyCard";
import SecretRequestRevealDialog from "./secret-request-reveal-dialog";
import SecretRequestCreateButton from "./secret-request-create-button";

type Status =
  | "pending"
  | "received"
  | "imported"
  | "revoked"
  | "expired";

type Org = { id: string; name: string; slug: string };

type SecretRequest = {
  id: string;
  label: string;
  description: string | null;
  requestedByEmail: string;
  recipientEmail: string | null;
  organization: { name: string; slug: string };
  project: { name: string; slug: string } | null;
  environmentName: string | null;
  secretKey: string | null;
  submittedAt: string | null;
  viewedAt: string | null;
  importedAt: string | null;
  revokedAt: string | null;
  expiresAt: string;
  createdAt: string;
  status: Status;
};

const STATUS_ICON: Record<Status, string> = {
  pending: "⏳",
  received: "✅",
  imported: "📥",
  revoked: "❌",
  expired: "⌛",
};

const STATUS_CHIP: Record<Status, string> = {
  pending: "role-trial",
  received: "role-active",
  imported: "role-active",
  revoked: "role-cancelled",
  expired: "role-cancelled",
};

type SharesT = ReturnType<typeof useTranslations<"shares">>;

function timeUntil(iso: string, t: SharesT): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return t("timeExpired");
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return t("timeDays", { n: Math.floor(h / 24) });
  if (h >= 1) return t("timeHours", { n: h });
  const m = Math.max(1, Math.floor(ms / 60_000));
  return t("timeMins", { n: m });
}

function timeAgo(iso: string, t: SharesT): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return t("timeAgoMins", { n: Math.max(1, m) });
  const h = Math.floor(m / 60);
  if (h < 24) return t("timeAgoHours", { n: h });
  return t("timeAgoDays", { n: Math.floor(h / 24) });
}

export default function SecretRequestsTab({
  refreshKey = 0,
}: {
  /** Bump cette key depuis le parent pour forcer un reload (ex: après
   *  création d'une demande via le bouton du tab-bar). */
  refreshKey?: number;
}) {
  const t = useTranslations("shares");
  const confirm = useConfirm();
  const [requests, setRequests] = useState<SecretRequest[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgFilter, setOrgFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (orgFilter) params.set("org", orgFilter);
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/secret-requests?${params.toString()}`);
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as {
      requests: SecretRequest[];
      orgs: Org[];
    };
    setRequests(data.requests);
    setOrgs(data.orgs);
  }, [orgFilter, statusFilter, t]);

  useEffect(() => {
    reload();
  }, [reload, refreshKey]);

  async function copyLink(id: string) {
    void id;
    await confirm({ message: t("requestLinkOnce"), confirmLabel: "OK" });
  }

  async function revoke(id: string, label: string) {
    if (!(await confirm({ message: t("requestRevoke", { label }), danger: true }))) return;
    const res = await fetch(`/api/secret-requests/${id}`, { method: "DELETE" });
    if (res.ok) reload();
    else setError(t("requestRevokeError"));
  }

  const reveal = revealId ? requests?.find((r) => r.id === revealId) : null;

  // Selects de filtre affichés seulement s'il y a des demandes — ou si un
  // filtre est actif (sinon on piégerait l'user sur un résultat filtré vide).
  const hasFilters = Boolean(orgFilter || statusFilter);
  const showFilters =
    requests !== null && (requests.length > 0 || hasFilters);

  return (
    <div className="flex flex-col gap-4">
      {reveal && (
        <SecretRequestRevealDialog
          requestId={reveal.id}
          label={reveal.label}
          canImport={Boolean(
            reveal.environmentName &&
              reveal.secretKey &&
              reveal.project &&
              !reveal.importedAt,
          )}
          envName={reveal.environmentName}
          secretKey={reveal.secretKey}
          onClose={() => setRevealId(null)}
          onChanged={() => reload()}
        />
      )}

      {showFilters && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <select
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            className="select"
            style={{ maxWidth: 200 }}
          >
            <option value="">{t("requestAllOrgs")}</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.slug}>
                {o.name}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="select"
            style={{ maxWidth: 200 }}
          >
            <option value="">{t("requestAllStatuses")}</option>
            <option value="pending">{t("requestStatus.pending")}</option>
            <option value="received">{t("requestStatus.received")}</option>
            <option value="imported">{t("requestStatus.imported")}</option>
            <option value="revoked">{t("requestStatus.revoked")}</option>
            <option value="expired">{t("requestStatus.expired")}</option>
          </select>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {requests === null ? (
        <p className="help">{t("loading")}</p>
      ) : requests.length === 0 ? (
        <EmptyCard
          icon={<RiMailLine size={22} aria-hidden />}
          title={t("externalEmpty")}
          hint={t("externalEmptyHint")}
          action={<SecretRequestCreateButton onCreated={reload} />}
        />
      ) : (
        <div className="row-list">
          {requests.map((r) => (
            <div key={r.id} className="row" id={`req-${r.id}`}>
              <div className="row-icon" title={t(`requestStatus.${r.status}`)}>
                {STATUS_ICON[r.status]}
              </div>
              <div className="row-info">
                <div
                  className="row-name"
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    whiteSpace: "normal",
                  }}
                >
                  <span>{r.label}</span>
                  <span className={`role ${STATUS_CHIP[r.status]}`}>
                    {t(`requestStatus.${r.status}`)}
                  </span>
                </div>
                <div className="row-meta">
                  <span>{r.organization.name}</span>
                  {r.project && <span>· {r.project.name}</span>}
                  {r.environmentName && r.secretKey && (
                    <span>
                      · <code className="code-mono">{r.environmentName}/{r.secretKey}</code>
                    </span>
                  )}
                  <span>· {t("requestBy", { email: r.requestedByEmail })}</span>
                </div>
                <div
                  className="row-meta"
                  style={{ marginTop: 2, fontSize: 12 }}
                >
                  {r.status === "pending" && (
                    <span>{t("requestExpiresIn", { time: timeUntil(r.expiresAt, t) })}</span>
                  )}
                  {r.status === "received" && r.submittedAt && (
                    <span>{t("requestReceivedAt", { time: timeAgo(r.submittedAt, t) })}</span>
                  )}
                  {r.status === "imported" && r.importedAt && (
                    <span>{t("requestImportedAt", { time: timeAgo(r.importedAt, t) })}</span>
                  )}
                  {r.status === "revoked" && r.revokedAt && (
                    <span>{t("requestRevokedAt", { time: timeAgo(r.revokedAt, t) })}</span>
                  )}
                  {r.status === "expired" && (
                    <span>{t("requestExpiredAt", { time: timeAgo(r.expiresAt, t) })}</span>
                  )}
                </div>
              </div>
              <div className="row-actions">
                {r.status === "pending" && (
                  <button
                    type="button"
                    onClick={() => copyLink(r.id)}
                    className="btn btn-ghost btn-xs"
                    title={t("requestLinkOnce")}
                  >
                    ⓘ
                  </button>
                )}
                {(r.status === "received" || r.status === "imported") && (
                  <button
                    type="button"
                    onClick={() => setRevealId(r.id)}
                    className="btn btn-ghost btn-xs"
                  >
                    {t("requestRevealBtn")}
                  </button>
                )}
                {r.status !== "revoked" && r.status !== "imported" && (
                  <button
                    type="button"
                    onClick={() => revoke(r.id, r.label)}
                    className="btn btn-danger btn-xs"
                  >
                    {t("requestRevokeBtn")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
