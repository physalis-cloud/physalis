"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { OrgRole } from "@prisma/client";
import RoleInfoDialog from "./role-info-dialog";
import ProjectAccessModal, {
  type ProjectAccessSelection,
} from "./project-access-modal";
import { useConfirm } from "@/components/ConfirmDialog";

type Member = {
  id: string;
  role: OrgRole;
  createdAt: string;
  user: { id: string; email: string };
};

type Invitation = {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
  createdAt: string;
  inviteeUserId: string | null;
  invitedBy: { email: string };
};

type Candidate = {
  id: string;
  email: string;
  sharedOrgs: { name: string; slug: string }[];
};

const ORG_ROLE_RANK: Record<OrgRole, number> = {
  MEMBER: 1,
  DEV: 2,
  ADMIN_DEV: 3,
  ADMIN: 4,
  OWNER: 5,
};

const ROLES: OrgRole[] = ["MEMBER", "DEV", "ADMIN_DEV", "ADMIN", "OWNER"];

/** Libellé affiché d'un rôle (les enums sont bruts sauf ADMIN_DEV → "AdminDev"). */
function roleLabel(r: OrgRole): string {
  return r === "ADMIN_DEV" ? "AdminDev" : r;
}

function initials(email: string): string {
  const local = email.split("@")[0] || email;
  return local.slice(0, 2).toUpperCase();
}

export default function OrgMembersPanel({
  slug,
  role,
}: {
  slug: string;
  role: OrgRole;
}) {
  const t = useTranslations("orgs.members");
  const confirm = useConfirm();
  const canManage = ORG_ROLE_RANK[role] >= ORG_ROLE_RANK.ADMIN;
  const isOwner = role === "OWNER";
  // Filtre d'affichage par rôle. Défaut = rôle de l'utilisateur connecté.
  const [roleFilter, setRoleFilter] = useState<OrgRole | "ALL">(role);

  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("MEMBER");
  const [pending, startTransition] = useTransition();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [roleInfoOpen, setRoleInfoOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"members" | "invitations">(
    "members",
  );
  const [candidateUserId, setCandidateUserId] = useState<string>("");
  // #2-D — modale « Droits d'accès ». Ouverte soit pour un membre existant
  // (mode édition → PUT), soit pour l'invitation en cours (mode invitation →
  // sélection mémorisée, envoyée dans le POST).
  const [accessModal, setAccessModal] = useState<
    | { mode: "member"; userId: string; email: string; orgRole: OrgRole }
    | { mode: "invite" }
    | null
  >(null);
  const [inviteProjectAccess, setInviteProjectAccess] = useState<
    ProjectAccessSelection[]
  >([]);
  // Feedback par invitation pour le bouton "Renvoyer" : "sent" pendant 5s
  // (coche verte), puis "cooldown" 5s (bouton disabled) avant retour normal.
  // Map par id pour ne pas bloquer les autres lignes.
  const [resendFeedback, setResendFeedback] = useState<
    Record<string, "sent" | "cooldown">
  >({});

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/orgs/${slug}/members`);
    if (!res.ok) {
      setError(t("loadError"));
      return;
    }
    const data = (await res.json()) as {
      members: Member[];
      invitations: Invitation[];
    };
    setMembers(data.members);
    setInvitations(data.invitations);
  }, [slug]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Charge les candidats in-app a l'ouverture du form. Refraichi a chaque
  // ouverture pour rester a jour si quelqu'un a ete ajoute / invite ailleurs.
  useEffect(() => {
    if (!inviting || !canManage) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/orgs/${slug}/members/candidates`);
      if (cancelled || !res.ok) return;
      const data = (await res.json()) as { candidates: Candidate[] };
      setCandidates(data.candidates);
    })();
    return () => {
      cancelled = true;
    };
  }, [inviting, canManage, slug]);

  function onInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      // Si l'user a selectionne un candidat → invitation in-app, sinon
      // fallback email-based avec l'input email. #2-D : on joint les accès
      // projet pré-attribués (ignorés côté serveur pour un OWNER/ADMIN).
      const access =
        inviteProjectAccess.length > 0
          ? { projectAccess: inviteProjectAccess }
          : {};
      const body = candidateUserId
        ? { targetUserId: candidateUserId, role: inviteRole, ...access }
        : { email: inviteEmail, role: inviteRole, ...access };
      const res = await fetch(`/api/orgs/${slug}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? "Invitation impossible.");
        return;
      }
      setInviteEmail("");
      setInviteRole("MEMBER");
      setCandidateUserId("");
      setInviteProjectAccess([]);
      setInviting(false);
      reload();
    });
  }

  // #2-D — PUT en bloc des accès projet d'un membre existant.
  async function saveMemberAccess(
    userId: string,
    selection: ProjectAccessSelection[],
  ) {
    setError(null);
    const res = await fetch(`/api/orgs/${slug}/members/${userId}/project-access`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectAccess: selection }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      setError(data?.error ?? t("access.loadError"));
      return;
    }
    reload();
  }

  async function changeRole(userId: string, newRole: OrgRole) {
    const res = await fetch(`/api/orgs/${slug}/members/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      setError(data?.error ?? "Modification impossible.");
      return;
    }
    reload();
  }

  async function remove(userId: string, email: string) {
    if (!(await confirm({ message: t("removeConfirm", { email }), danger: true }))) return;
    const res = await fetch(`/api/orgs/${slug}/members/${userId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      setError(data?.error ?? t("removeError"));
      return;
    }
    reload();
  }

  function resendInvitation(invitationId: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/orgs/${slug}/invitations/${invitationId}/resend`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? "Renvoi impossible.");
        return;
      }
      // Feedback : ✓ pendant 5s, puis cooldown 5s, puis retour normal.
      setResendFeedback((f) => ({ ...f, [invitationId]: "sent" }));
      setTimeout(() => {
        setResendFeedback((f) => ({ ...f, [invitationId]: "cooldown" }));
        setTimeout(() => {
          setResendFeedback((f) => {
            const next = { ...f };
            delete next[invitationId];
            return next;
          });
        }, 5000);
      }, 5000);
      reload();
    });
  }

  async function deleteInvitation(invitationId: string, email: string) {
    if (!(await confirm({ message: t("deleteConfirm", { email }), danger: true }))) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/orgs/${slug}/invitations/${invitationId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("deleteError"));
        return;
      }
      reload();
    });
  }

  // Garde-fou UI : une org doit garder ≥ 1 OWNER (le PATCH renvoie déjà 409,
  // on désactive le select en amont pour le rendre visible).
  const ownerCount = (members ?? []).filter((m) => m.role === "OWNER").length;

  // Rôles présents parmi les membres → chips de filtre (pas de filtre vide).
  const presentRoles = ROLES.filter((r) =>
    (members ?? []).some((m) => m.role === r),
  );
  const visibleMembers =
    members === null
      ? null
      : roleFilter === "ALL"
        ? members
        : members.filter((m) => m.role === roleFilter);

  // Invitations en attente : on masque celles dont l'email est déjà membre
  // (invitation re-créée pour quelqu'un ayant déjà accepté → doublon affiché).
  const memberEmails = new Set(
    (members ?? []).map((m) => m.user.email.toLowerCase()),
  );
  const visibleInvitations = (invitations ?? []).filter(
    (inv) => !memberEmails.has(inv.email.toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-6">
      {roleInfoOpen && <RoleInfoDialog onClose={() => setRoleInfoOpen(false)} />}
      {accessModal && (
        <ProjectAccessModal
          orgSlug={slug}
          userId={accessModal.mode === "member" ? accessModal.userId : undefined}
          targetOrgRole={
            accessModal.mode === "member" ? accessModal.orgRole : inviteRole
          }
          title={
            accessModal.mode === "member" ? accessModal.email : inviteEmail || undefined
          }
          initialSelection={
            accessModal.mode === "invite" ? inviteProjectAccess : undefined
          }
          onSave={async (sel) => {
            if (accessModal.mode === "member") {
              await saveMemberAccess(accessModal.userId, sel);
            } else {
              setInviteProjectAccess(sel);
            }
          }}
          onClose={() => setAccessModal(null)}
        />
      )}
      <button
        type="button"
        onClick={() => setRoleInfoOpen(true)}
        className="card"
        style={{
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          textAlign: "left",
          cursor: "pointer",
          border: "1px solid var(--border)",
          background: "var(--accent-bg)",
        }}
      >
        <span style={{ fontSize: 18 }}>ℹ️</span>
        <span style={{ flex: 1, fontSize: 13 }}>
          <strong>{t("infoBtn")}</strong>
        </span>
        <span className="help" style={{ fontSize: 12 }}>→</span>
      </button>
      <section>
        <div className="section-header">
          <h2 className="section-title">{t("title")}</h2>
          {canManage && !inviting && (
            <button
              type="button"
              onClick={() => setInviting(true)}
              className="btn btn-primary btn-sm"
            >
              {t("inviteBtn")}
            </button>
          )}
        </div>

        {inviting && canManage && (
          <form onSubmit={onInvite} className="create-card">
            {/* Section : invitation in-app via candidat existant */}
            {candidates && candidates.length > 0 && (
              <div className="field" style={{ marginBottom: 12 }}>
                <label>{t("existingLabel")}</label>
                <select
                  value={candidateUserId}
                  onChange={(e) => setCandidateUserId(e.target.value)}
                  className="select"
                >
                  <option value="">{t("addTitle")}</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.email} —{" "}
                      {c.sharedOrgs.map((o) => o.name).join(", ")}
                    </option>
                  ))}
                </select>
                <div className="help" style={{ marginTop: 4 }}>
                  {t("inviteInAppNote")}
                </div>
              </div>
            )}

            <div className="form-row">
              <div className="field" style={{ minWidth: 240 }}>
                <label>{t("emailLabel")}</label>
                <input
                  type="email"
                  required={!candidateUserId}
                  disabled={Boolean(candidateUserId)}
                  autoFocus={!candidates || candidates.length === 0}
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="email@exemple.com"
                  className="input"
                />
              </div>
              <div className="field" style={{ maxWidth: 160 }}>
                <label>{t("roleLabel")}</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                  className="select"
                >
                  {ROLES.filter((r) => r !== "OWNER" || isOwner).map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
              </div>
              {/* #2-D — accès projet pré-attribués. À droite du select rôle,
                  même hauteur (.form-row aligne en flex-end). Masqué pour
                  OWNER/ADMIN (OWNER implicite partout). */}
              {inviteRole !== "OWNER" && inviteRole !== "ADMIN" && (
                <button
                  type="button"
                  onClick={() => setAccessModal({ mode: "invite" })}
                  className="btn btn-ghost"
                  style={{
                    padding: "10px 14px",
                    fontSize: 14,
                    // .btn impose line-height 1.2 → bouton plus court que le
                    // .select (qui hérite ~1.5). On aligne sur le select.
                    lineHeight: 1.5,
                    borderRadius: 10,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("access.openBtn")}
                  {inviteProjectAccess.length > 0
                    ? ` (${inviteProjectAccess.length})`
                    : ""}
                </button>
              )}
            </div>
            {error && (
              <p className="error-text" style={{ marginTop: 8 }}>
                {error}
              </p>
            )}
            <p className="help" style={{ marginTop: 10 }}>
              {candidateUserId
                ? t("inviteInAppNote")
                : t("inviteEmailNote")}
            </p>
            <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
              <button
                type="submit"
                disabled={
                  pending ||
                  (!candidateUserId && inviteEmail.trim().length === 0)
                }
                className="btn btn-primary btn-sm"
              >
                {pending
                  ? "Envoi..."
                  : candidateUserId
                    ? t("inviteInAppBtn")
                    : t("inviteEmailBtn")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setInviting(false);
                  setError(null);
                  setCandidateUserId("");
                  setInviteEmail("");
                }}
                className="btn btn-ghost btn-sm"
              >
                Annuler
              </button>
            </div>
          </form>
        )}

        {error && !inviting && (
          <p className="error-text" style={{ marginTop: 8 }}>
            {error}
          </p>
        )}

        <div className="tab-bar" style={{ display: "flex", marginBottom: 12 }}>
          <button
            type="button"
            className={`tab ${activeTab === "members" ? "active" : ""}`}
            onClick={() => setActiveTab("members")}
          >
            {t("membersTab")} ({members?.length ?? 0})
          </button>
          <button
            type="button"
            className={`tab ${activeTab === "invitations" ? "active" : ""}`}
            onClick={() => setActiveTab("invitations")}
          >
            {t("invitationsTab")} ({visibleInvitations.length})
          </button>
        </div>

        {activeTab === "members" && (
        <>
        {members && members.length > 0 && (
          <div
            className="flex"
            style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}
          >
            <button
              type="button"
              onClick={() => setRoleFilter("ALL")}
              className="role"
              style={{
                cursor: "pointer",
                border: "none",
                fontFamily: "inherit",
                background: "var(--code-bg)",
                color: "var(--muted)",
                opacity: roleFilter === "ALL" ? 1 : 0.45,
                boxShadow:
                  roleFilter === "ALL" ? "0 0 0 2px var(--accent)" : "none",
              }}
            >
              {t("filterAll")}
            </button>
            {presentRoles.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRoleFilter(r)}
                className={`role role-${r.toLowerCase()}`}
                style={{
                  cursor: "pointer",
                  border: "none",
                  fontFamily: "inherit",
                  opacity: roleFilter === r ? 1 : 0.45,
                  boxShadow:
                    roleFilter === r ? "0 0 0 2px var(--accent)" : "none",
                }}
              >
                {roleLabel(r)}
              </button>
            ))}
          </div>
        )}
        {members === null ? (
          <p className="help">Chargement…</p>
        ) : members.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">{t("empty")}</div>
          </div>
        ) : visibleMembers && visibleMembers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">{t("filterEmpty")}</div>
          </div>
        ) : (
          <div className="row-list">
            {(visibleMembers ?? []).map((m) => (
              <div key={m.id} className="row">
                <div className="row-icon">{initials(m.user.email)}</div>
                <div className="row-info">
                  <div className="row-name">{m.user.email}</div>
                  <div className="row-meta">
                    <span>
                      {t("since", { date: new Date(m.createdAt).toLocaleDateString() })}
                    </span>
                  </div>
                </div>
                <div className="row-actions">
                  {canManage ? (
                    <select
                      value={m.role}
                      onChange={(e) =>
                        changeRole(m.user.id, e.target.value as OrgRole)
                      }
                      // Dernier OWNER : verrouillé (une org garde ≥ 1 OWNER).
                      disabled={m.role === "OWNER" && ownerCount <= 1}
                      title={
                        m.role === "OWNER" && ownerCount <= 1
                          ? t("lastOwnerLock")
                          : undefined
                      }
                      className="select"
                      // Réserve à droite pour le chevron custom (.select pose
                      // padding-right: 40px ; le shorthand `padding` l'écrasait
                      // → chevron mal placé). On garde le padding compact mais
                      // avec la gouttière du chevron.
                      style={{ padding: "5px 32px 5px 8px", fontSize: 12, width: "auto" }}
                    >
                      {ROLES.filter((r) => r !== "OWNER" || isOwner).map(
                        (r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ),
                      )}
                    </select>
                  ) : (
                    <span className={`role role-${m.role.toLowerCase()}`}>
                      {roleLabel(m.role)}
                    </span>
                  )}
                  {canManage && m.role !== "OWNER" && m.role !== "ADMIN" && (
                    <button
                      type="button"
                      onClick={() =>
                        setAccessModal({
                          mode: "member",
                          userId: m.user.id,
                          email: m.user.email,
                          orgRole: m.role,
                        })
                      }
                      className="btn btn-ghost btn-xs"
                    >
                      {t("access.openBtn")}
                    </button>
                  )}
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => remove(m.user.id, m.user.email)}
                      className="btn btn-danger btn-xs"
                    >
                      {t("removeBtn")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        </>
        )}
      </section>

      {activeTab === "invitations" && (
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">{t("pendingTitle")}</h2>
          </div>
          {visibleInvitations.length === 0 ? (
            <p className="help">{t("pendingEmpty")}</p>
          ) : (
          <div className="row-list">
            {visibleInvitations.map((inv) => {
              const expired = new Date(inv.expiresAt).getTime() < Date.now();
              return (
                <div key={inv.id} className="row">
                  <div className="row-icon">
                    {inv.inviteeUserId ? "📨" : initials(inv.email)}
                  </div>
                  <div className="row-info">
                    <div className="row-name">
                      {inv.email}
                      {inv.inviteeUserId && (
                        <span
                          className="chip"
                          style={{ marginLeft: 6, fontSize: 10 }}
                        >
                          {t("badgeInApp")}
                        </span>
                      )}
                      {expired && (
                        <span
                          className="chip"
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            background: "var(--danger-bg)",
                            color: "var(--danger-fg)",
                          }}
                          title={t("expiredNote")}
                        >
                          {t("badgeExpired")}
                        </span>
                      )}
                    </div>
                    <div className="row-meta">
                      <span className={`role role-${inv.role.toLowerCase()}`}>
                        {roleLabel(inv.role)}
                      </span>
                      <span>· {t("invitedBy", { email: inv.invitedBy.email })}</span>
                      <span>
                        · {new Date(inv.expiresAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  {canManage && (
                    <div className="row-actions">
                      {(() => {
                        const fb = resendFeedback[inv.id];
                        const isSent = fb === "sent";
                        return (
                          <button
                            type="button"
                            onClick={() => resendInvitation(inv.id)}
                            disabled={pending || fb !== undefined}
                            className="btn btn-ghost btn-xs"
                            style={
                              isSent
                                ? {
                                    background: "var(--success)",
                                    color: "#fff",
                                    borderColor: "var(--success)",
                                    opacity: 1,
                                  }
                                : undefined
                            }
                            title={
                              inv.inviteeUserId
                                ? t("resendNoteInApp")
                                : t("resendNoteEmail")
                            }
                          >
                            {isSent
                              ? t("resendSent")
                              : fb === "cooldown"
                                ? t("resendSent")
                                : t("resendBtn")}
                          </button>
                        );
                      })()}
                      <button
                        type="button"
                        onClick={() => deleteInvitation(inv.id, inv.email)}
                        disabled={pending}
                        className="btn btn-danger btn-xs"
                      >
                        {t("deleteBtn")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}
        </section>
      )}
    </div>
  );
}
