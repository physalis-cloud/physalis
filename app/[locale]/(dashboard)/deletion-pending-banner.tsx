"use client";

// Bandeau affiché quand le compte (tenant) est en PENDING_DELETION : la
// suppression a été demandée et interviendra à `purgeAt`. Pendant cette
// fenêtre, l'accès reste normal ; l'OWNER peut annuler la suppression
// (réactivation self-service) via /api/account/reactivate.

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { RiAlarmWarningLine, RiDownloadLine } from "@remixicon/react";
import { useTranslations } from "next-intl";
import PurgeNowDialog from "./purge-now-dialog";

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
  const [purgeOpen, setPurgeOpen] = useState(false);

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
      {/* Récupération des données — offerte à TOUT LE MONDE, pas seulement à
          l'owner. Sans elle, le bandeau annonçait aux membres la destruction de
          leur coffre en les renvoyant vers le propriétaire, sans leur donner le
          moindre moyen d'emporter leurs données. L'export est auto-scopé :
          chacun n'obtient que ce à quoi il a accès. */}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        // Même motif que account/export-button.tsx : le serveur pose
        // Content-Disposition, le navigateur gère le download. Pas un <Link>,
        // ce n'est pas une navigation de page.
        onClick={() => {
          window.location.href = "/api/me/export";
        }}
        style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <RiDownloadLine size={16} aria-hidden />
        {t("downloadBtn")}
      </button>
      {isOwner && (
        <>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending}
            onClick={reactivate}
            style={{ flexShrink: 0 }}
          >
            {pending ? t("reactivatingBtn") : t("reactivateBtn")}
          </button>
          {/* Raccourci vers l'irréversible : gardé par le plancher côté
              serveur, qui protège les membres n'ayant pas encore récupéré
              leurs données. */}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={pending}
            onClick={() => setPurgeOpen(true)}
            style={{ flexShrink: 0 }}
          >
            {t("purgeNow.openBtn")}
          </button>
        </>
      )}
      {purgeOpen && <PurgeNowDialog onClose={() => setPurgeOpen(false)} />}
    </div>
  );
}
