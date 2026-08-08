"use client";

// Fiche d'une demande de secret externe.
//
// Remplace un détournement de `useConfirm` : le bouton ⓘ ouvrait une modale
// intitulée « Confirmation » qui ne portait QUE l'avertissement sur le lien à
// usage unique — ni le titre de la demande, ni son destinataire, ni sa cible.
// L'information la plus utile (à qui ai-je demandé quoi, pour quel projet)
// n'était lisible que dans la ligne de liste, tronquée.
//
// Purement consultatif : aucune action, aucun appel réseau. Les données
// viennent de la ligne déjà chargée par l'onglet.

import { useEffect } from "react";
import { useTranslations } from "next-intl";

type Status = "pending" | "received" | "imported" | "revoked" | "expired";

export type SecretRequestDetails = {
  label: string;
  description: string | null;
  requestedByEmail: string;
  recipientEmail: string | null;
  organization: { name: string };
  project: { name: string } | null;
  environmentName: string | null;
  secretKey: string | null;
  submittedAt: string | null;
  importedAt: string | null;
  revokedAt: string | null;
  expiresAt: string;
  createdAt: string;
  status: Status;
};

/** Une ligne « libellé / valeur ». Rend `null` si la valeur est absente —
 *  une fiche ne doit pas afficher de champs vides. */
function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  if (children === null || children === undefined || children === false) {
    return null;
  }
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "baseline",
        padding: "6px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: "var(--muted)",
          flex: "0 0 38%",
          minWidth: 0,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13, flex: 1, minWidth: 0, wordBreak: "break-word" }}>
        {children}
      </span>
    </div>
  );
}

export default function SecretRequestDetailsDialog({
  request,
  statusLabel,
  formatDate,
  onClose,
}: {
  request: SecretRequestDetails;
  /** Libellé traduit du statut — déjà résolu par l'onglet, on ne le re-dérive pas. */
  statusLabel: string;
  /** Formatage de date fourni par l'onglet, pour rester cohérent avec la liste. */
  formatDate: (iso: string) => string;
  onClose: () => void;
}) {
  const t = useTranslations("shares.detailsDialog");
  const r = request;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Destination d'import : environnement + clé si renseignés, sinon le coffre
  // du projet — et rien du tout sans projet (la demande est en lecture seule).
  const destination =
    r.environmentName && r.secretKey ? (
      <code className="code-mono">
        {r.environmentName}/{r.secretKey}
      </code>
    ) : r.project ? (
      t("destinationProjectVault")
    ) : (
      t("destinationNone")
    );

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, width: "92vw" }}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{r.label}</h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("closeBtn")}
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          {r.description && (
            <p className="help" style={{ fontSize: 13, marginTop: 0 }}>
              {r.description}
            </p>
          )}

          <div style={{ marginTop: 4 }}>
            <Row label={t("statusLabel")}>{statusLabel}</Row>
            <Row label={t("requestedByLabel")}>{r.requestedByEmail}</Row>
            <Row label={t("recipientLabel")}>
              {r.recipientEmail ?? t("recipientManual")}
            </Row>
            <Row label={t("orgLabel")}>{r.organization.name}</Row>
            <Row label={t("projectLabel")}>{r.project?.name ?? t("noProject")}</Row>
            <Row label={t("destinationLabel")}>{destination}</Row>
            <Row label={t("createdLabel")}>{formatDate(r.createdAt)}</Row>
            <Row label={t("expiresLabel")}>{formatDate(r.expiresAt)}</Row>
            {r.submittedAt && (
              <Row label={t("submittedLabel")}>{formatDate(r.submittedAt)}</Row>
            )}
            {r.importedAt && (
              <Row label={t("importedLabel")}>{formatDate(r.importedAt)}</Row>
            )}
            {r.revokedAt && (
              <Row label={t("revokedLabel")}>{formatDate(r.revokedAt)}</Row>
            )}
          </div>

          <p
            className="help"
            style={{ fontSize: 12, marginTop: 14, lineHeight: 1.6 }}
          >
            {t("linkOnce")}
          </p>

          <div
            style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}
          >
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost btn-sm"
            >
              {t("closeBtn")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
