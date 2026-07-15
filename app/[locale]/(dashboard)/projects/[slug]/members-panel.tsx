"use client";

// Panel "Membres" du projet.
// Visible uniquement aux OWNERs (cf. project-view.tsx qui le rend conditionnellement).
// Liste tous les OrgMembers de l'org parente avec leur etat effectif :
//   - OWNER (admin de l'org) : non-editable, OWNER implicite
//   - explicit ProjectMember : role choisi + visible/cache toggle
//   - default : pas de ligne, VIEWER implicite, peut etre masque ou
//     promu (creation auto de la ligne)
//
// Toggle visibilite + select role appellent PATCH /api/projects/[slug]/members/[userId].

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { ProjectRole } from "@prisma/client";

type MemberItem = {
  userId: string;
  email: string;
  orgRole: "OWNER" | "ADMIN" | "MEMBER";
  role: ProjectRole;
  hidden: boolean;
  source: "org_admin" | "explicit" | "default";
  editable: boolean;
};

const ROLES: ProjectRole[] = ["VIEWER", "EDITOR", "OWNER"];

function initials(email: string): string {
  const local = email.split("@")[0] || email;
  return local.slice(0, 2).toUpperCase();
}

export default function MembersPanel({ slug }: { slug: string }) {
  const t = useTranslations("projects.members");
  const [members, setMembers] = useState<MemberItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/projects/${slug}/members`);
    if (!res.ok) {
      setError("Erreur de chargement.");
      return;
    }
    const data = (await res.json()) as { members: MemberItem[] };
    setMembers(data.members);
  }, [slug]);

  useEffect(() => {
    reload();
  }, [reload]);

  function update(
    userId: string,
    changes: Partial<{ hidden: boolean; role: ProjectRole }>,
  ) {
    startTransition(async () => {
      const res = await fetch(`/api/projects/${slug}/members/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? "Modification impossible.");
        return;
      }
      reload();
    });
  }

  if (error) return <p className="error-text">{error}</p>;
  if (members === null) return <p className="help">Chargement…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="section-header">
        <div>
          <h2 className="section-title">{t("title")}</h2>
          <p className="panel-subtitle">{t("desc1")}</p>
          <p className="panel-subtitle">{t("desc2")}</p>
        </div>
      </div>

      <div className="row-list">
        {members.map((m) => (
          <div key={m.userId} className="row">
            <div className="row-icon">{initials(m.email)}</div>
            <div className="row-info">
              <div className="row-name">
                {m.email}
                {m.source === "org_admin" && (
                  <span
                    className={`role role-${m.orgRole.toLowerCase()}`}
                    style={{ marginLeft: 6 }}
                    title={t("orgRoleTitle")}
                  >
                    {m.orgRole}
                  </span>
                )}
              </div>
              <div className="row-meta">
                {m.source === "org_admin" && (
                  <span>{t("orgAdmin")}</span>
                )}
                {m.source === "explicit" && (
                  <span>{t("explicit")}</span>
                )}
                {m.source === "default" && (
                  <span>{t("default")}</span>
                )}
              </div>
            </div>
            <div className="row-actions">
              {m.editable ? (
                <>
                  <select
                    value={m.role}
                    disabled={pending || m.hidden}
                    onChange={(e) =>
                      update(m.userId, {
                        role: e.target.value as ProjectRole,
                      })
                    }
                    className="select"
                    style={{ width: "auto", padding: "5px 8px", fontSize: 12 }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => update(m.userId, { hidden: !m.hidden })}
                    className={`btn btn-xs ${m.hidden ? "btn-danger" : "btn-ghost"}`}
                  >
                    {m.hidden ? `🚫 ${t("hidden")}` : `👁 ${t("visible")}`}
                  </button>
                </>
              ) : (
                <span
                  className="role role-owner"
                  title="OWNER implicite via OrgADMIN/OWNER"
                >
                  OWNER
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
