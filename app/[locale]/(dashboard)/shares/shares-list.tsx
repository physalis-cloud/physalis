"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { RiShareForward2Line } from "@remixicon/react";
import { useConfirm } from "@/components/ConfirmDialog";
import EmptyCard from "@/components/EmptyCard";
import ShareCreateButton from "../share-create-button";

type Status = "active" | "consumed" | "expired" | "revoked";

type ShareItem = {
  id: string;
  title: string | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  viewedFromIp: string | null;
  revokedAt: string | null;
  status: Status;
};

const STATUS_BADGE: Record<Status, string> = {
  active: "badge success",
  consumed: "badge",
  expired: "badge expired",
  revoked: "badge danger",
};

const STATUS_LABEL_KEY: Record<Status, string> = {
  active: "statusActive",
  consumed: "statusConsumed",
  expired: "statusExpired",
  revoked: "statusRevoked",
};

export default function SharesList() {
  const t = useTranslations("shares");
  const confirm = useConfirm();
  const [shares, setShares] = useState<ShareItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/me/shares");
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as { shares: ShareItem[] };
    setShares(data.shares);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function revoke(s: ShareItem) {
    if (!(await confirm({ message: t("revokeConfirm", { title: s.title ?? t("noTitle") }), danger: true }))) {
      return;
    }
    const res = await fetch(`/api/me/shares/${s.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(t("revokeError"));
      return;
    }
    reload();
  }

  if (error) return <p className="error-text">{error}</p>;
  if (shares === null) return <p className="help">{t("loading")}</p>;
  if (shares.length === 0) {
    return (
      <EmptyCard
        icon={<RiShareForward2Line size={22} aria-hidden />}
        title={t("noShares")}
        hint={t("noSharesHint")}
        action={<ShareCreateButton />}
      />
    );
  }

  return (
    <div className="row-list">
      {shares.map((s) => (
        <div key={s.id} className="row">
          <div className="row-icon"><RiShareForward2Line size={18} aria-hidden /></div>
          <div className="row-info">
            <div className="row-name">
              {s.title ?? <span className="text-muted">{t("noTitle")}</span>}{" "}
              <span
                className={STATUS_BADGE[s.status]}
                style={{ marginLeft: 6 }}
              >
                {t(STATUS_LABEL_KEY[s.status])}
              </span>
            </div>
            <div className="row-meta">
              <span>{t("createdAt", { date: new Date(s.createdAt).toLocaleString() })}</span>
              <span>· {t("expiresAt", { date: new Date(s.expiresAt).toLocaleString() })}</span>
              {s.consumedAt && (
                <span>
                  · {t("consumedAt", { date: new Date(s.consumedAt).toLocaleString() })}
                  {s.viewedFromIp && (
                    <>
                      {" "}{t("consumedFrom", { ip: s.viewedFromIp })}
                    </>
                  )}
                </span>
              )}
              {s.revokedAt && (
                <span>· {t("revokedAt", { date: new Date(s.revokedAt).toLocaleString() })}</span>
              )}
            </div>
          </div>
          <div className="row-actions">
            {s.status === "active" && (
              <button
                type="button"
                onClick={() => revoke(s)}
                className="btn btn-danger btn-xs"
              >
                {t("revokeBtn")}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
