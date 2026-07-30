"use client";

// Panel "Membres" du projet.
// Visible uniquement aux OWNERs (cf. project-view.tsx qui le rend conditionnellement).
// Liste tous les OrgMembers de l'org parente, SÉPARÉS en deux groupes selon leur
// accès EFFECTIF au projet (`hasAccess`, calculé serveur via effectiveProjectRole §4) :
//   - « Ont accès » : OrgADMIN/OWNER (implicite), DEV (implicite), ou ligne
//     ProjectMember non masquée. Rôle éditable + bouton « Interdire l'accès ».
//   - « N'ont pas accès » : MEMBER sans ligne (règle 5) ou ligne masquée.
//     Bouton « Autoriser l'accès » (crée/dé-masque la ligne ProjectMember).
//
// Toggle + rôle appellent PATCH /api/projects/[slug]/members/[userId].

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { ProjectRole } from "@prisma/client";

type MemberItem = {
  userId: string;
  email: string;
  orgRole: "OWNER" | "ADMIN" | "ADMIN_DEV" | "DEV" | "MEMBER";
  role: ProjectRole;
  hidden: boolean;
  source: "org_admin" | "explicit" | "default";
  editable: boolean;
  hasAccess: boolean;
};

const ROLES: ProjectRole[] = ["VIEWER", "EDITOR", "OWNER"];

// Préserve le padding-right du chevron (`.select`) que l'inline écraserait.
const SELECT_STYLE: React.CSSProperties = {
  width: "auto",
  padding: "5px 34px 5px 10px",
  fontSize: 12,
};

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

  const update = useCallback(
    (
      userId: string,
      changes: Partial<{ hidden: boolean; role: ProjectRole }>,
    ) => {
      startTransition(async () => {
        const res = await fetch(`/api/projects/${slug}/members/${userId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(changes),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          setError(data?.error ?? "Modification impossible.");
          return;
        }
        reload();
      });
    },
    [slug, reload],
  );

  if (error) return <p className="error-text">{error}</p>;
  if (members === null) return <p className="help">Chargement…</p>;

  const withAccess = members.filter((m) => m.hasAccess);
  const noAccess = members.filter((m) => !m.hasAccess);

  function renderRow(m: MemberItem) {
    return (
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
            {m.source === "org_admin" && <span>{t("orgAdmin")}</span>}
            {m.source === "explicit" && <span>{t("explicit")}</span>}
            {m.source === "default" && <span>{t("default")}</span>}
          </div>
        </div>
        <div className="row-actions">
          {!m.editable ? (
            <span
              className="role role-owner"
              title="OWNER implicite via OrgADMIN/OWNER"
            >
              OWNER
            </span>
          ) : m.hasAccess ? (
            <>
              <select
                value={m.role}
                disabled={pending}
                onChange={(e) =>
                  update(m.userId, { role: e.target.value as ProjectRole })
                }
                className="select"
                style={SELECT_STYLE}
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
                onClick={() => update(m.userId, { hidden: true })}
                className="btn btn-xs btn-danger"
              >
                {t("denyAccess")}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => update(m.userId, { hidden: false })}
              className="btn btn-xs btn-primary"
            >
              {t("allowAccess")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="section-header">
        <div>
          <h2 className="section-title">{t("title")}</h2>
          <p className="panel-subtitle">{t("desc1")}</p>
          <p className="panel-subtitle">{t("desc2")}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="panel-subtitle" style={{ fontWeight: 600 }}>
          {t("withAccessTitle")} ({withAccess.length})
        </h3>
        <div className="row-list">{withAccess.map(renderRow)}</div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="panel-subtitle" style={{ fontWeight: 600 }}>
          {t("noAccessTitle")} ({noAccess.length})
        </h3>
        {noAccess.length === 0 ? (
          <p className="help">{t("noAccessEmpty")}</p>
        ) : (
          <div className="row-list">{noAccess.map(renderRow)}</div>
        )}
      </div>
    </div>
  );
}
