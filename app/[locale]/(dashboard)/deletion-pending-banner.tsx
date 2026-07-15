"use client";

// Bandeau affiché quand le compte (tenant) est en PENDING_DELETION : la
// suppression a été demandée et interviendra à `purgeAt`. Pendant cette
// fenêtre, l'accès reste normal ; l'OWNER peut annuler la suppression
// (réactivation self-service) via /api/account/reactivate.

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { RiAlarmWarningLine } from "@remixicon/react";
import { useTranslations } from "next-intl";

export default function DeletionPendingBanner({
  isOwner,
  purgeAtIso,
}: {
  isOwner: boolean;
  purgeAtIso: string | null;
}) {
  const t = useTranslations("deletionBanner");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const purgeDate = purgeAtIso
    ? new Date(purgeAtIso).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : null;

  function reactivate() {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/account/reactivate", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("error"));
        return;
      }
      router.refresh();
    });
  }

  return (
    <div
      role="alert"
      style={{
        display: "flex",
        gap: 14,
        alignItems: "flex-start",
        padding: "16px 20px",
        borderRadius: 10,
        marginBottom: 24,
        background: "#fee2e2",
        color: "#7f1d1d",
        border: "1px solid #fecaca",
        fontSize: 14,
      }}
    >
      <RiAlarmWarningLine
        size={22}
        aria-hidden
        style={{ flexShrink: 0, marginTop: 1 }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{t("title")}</div>
        <div style={{ marginTop: 6, lineHeight: 1.5 }}>
          {purgeDate
            ? isOwner
              ? t("descOwner", { date: purgeDate })
              : t("descMember", { date: purgeDate })
            : isOwner
              ? t("descOwnerNoDate")
              : t("descMemberNoDate")}
        </div>
        {error && <div style={{ fontSize: 12, marginTop: 6 }}>{error}</div>}
      </div>
      {isOwner && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending}
          onClick={reactivate}
          style={{ flexShrink: 0 }}
        >
          {pending ? t("reactivatingBtn") : t("reactivateBtn")}
        </button>
      )}
    </div>
  );
}
