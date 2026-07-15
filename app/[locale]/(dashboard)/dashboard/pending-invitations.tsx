"use client";

// Section affichee en haut du dashboard SI l'user a des invitations in-app
// en attente. Sinon le composant ne rend rien (pas de zone vide).
//
// Boutons inline :
//   - Valider → POST /api/me/invitations/[id]/accept → switch org courante
//     vers la nouvelle, refresh
//   - Refuser → DELETE /api/me/invitations/[id] → reload la liste

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { RiMailLine } from "@remixicon/react";
import { useConfirm } from "@/components/ConfirmDialog";

type PendingInvitation = {
  id: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  expiresAt: string;
  createdAt: string;
  organization: { slug: string; name: string };
  invitedBy: { email: string };
};

export default function PendingInvitations() {
  const t = useTranslations("dashboard.invitations");
  const confirm = useConfirm();
  const router = useRouter();
  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/me/invitations");
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as { invitations: PendingInvitation[] };
    setInvitations(data.invitations);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  function accept(inv: PendingInvitation) {
    startTransition(async () => {
      const res = await fetch(`/api/me/invitations/${inv.id}/accept`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(t("acceptError"));
        return;
      }
      // Bascule l'org courante sur la nouvelle (UX : on arrive direct dedans).
      await fetch("/api/me/current-org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: inv.organization.slug }),
      }).catch(() => {});
      router.push(`/orgs/${inv.organization.slug}`);
      router.refresh();
    });
  }

  async function decline(inv: PendingInvitation) {
    if (
      !(await confirm({
        message: t("declineConfirm", { orgName: inv.organization.name }),
        danger: true,
      }))
    )
      return;
    startTransition(async () => {
      const res = await fetch(`/api/me/invitations/${inv.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(t("declineError"));
        return;
      }
      reload();
    });
  }

  if (!invitations || invitations.length === 0) {
    return null;
  }

  return (
    <section
      className="card"
      style={{
        background: "var(--accent-bg)",
        borderColor: "var(--accent-soft)",
        marginBottom: 24,
      }}
    >
      <h2
        className="section-title"
        style={{ fontSize: 15, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}
      >
        <RiMailLine size={16} aria-hidden /> {t("title", { count: invitations.length })}
      </h2>
      {error && <p className="error-text">{error}</p>}
      <div className="row-list" style={{ gap: 6 }}>
        {invitations.map((inv) => (
          <div
            key={inv.id}
            className="row"
            style={{ background: "var(--surface)" }}
          >
            <div className="row-icon"><RiMailLine size={18} aria-hidden /></div>
            <div className="row-info">
              <div className="row-name">
                {t("join")} <strong>{inv.organization.name}</strong>{" "}
                <span
                  className={`role role-${inv.role.toLowerCase()}`}
                  style={{ marginLeft: 6 }}
                >
                  {inv.role}
                </span>
              </div>
              <div className="row-meta">
                <span>{t("invitedBy", { email: inv.invitedBy.email })}</span>
                <span>
                  {t("expiresAt", { date: new Date(inv.expiresAt).toLocaleDateString() })}
                </span>
              </div>
            </div>
            <div className="row-actions">
              <button
                type="button"
                onClick={() => accept(inv)}
                disabled={pending}
                className="btn btn-primary btn-sm"
              >
                {t("acceptBtn")}
              </button>
              <button
                type="button"
                onClick={() => decline(inv)}
                disabled={pending}
                className="btn btn-ghost btn-sm"
              >
                {t("declineBtn")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
