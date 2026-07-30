"use client";

// #2-C — Modale « Droits d'accès » : pose les accès projet d'un membre (ou
// pré-remplit ceux d'une invitation). Cochage par projet + rôle par projet.
//
// Auto-chargeante :
//   • userId fourni  → GET members/[userId]/project-access (accès courant).
//   • userId absent  → GET orgs/[slug]/projects (mode invitation, tout vierge).
//
// La modale ne décide RIEN : elle renvoie la sélection via onSave. Le parent
// choisit quoi en faire (PUT pour un membre, corps du POST pour une invitation).
//
// Distinction clé rendue lisible (cf. #2-B) :
//   • MEMBER    : décocher = AUCUN accès.
//   • DEV/ADMIN_DEV : décocher = retombe sur l'EDITOR implicite (règle 4), pas
//     une barrière. Les projets non cochés y sont marqués « implicite ».
//   • OWNER/ADMIN : OWNER implicite partout → la modale n'a pas d'objet.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { OrgRole, ProjectRole } from "@prisma/client";

const PROJECT_ROLES: ProjectRole[] = ["VIEWER", "EDITOR", "OWNER"];

export type ProjectAccessSelection = { projectId: string; role: ProjectRole };

type ProjectItem = {
  id: string;
  slug: string;
  name: string;
  explicit?: boolean;
  explicitRole?: ProjectRole | null;
  hidden?: boolean;
  hasAccess?: boolean;
};

export default function ProjectAccessModal({
  orgSlug,
  userId,
  targetOrgRole,
  title,
  initialSelection,
  onSave,
  onClose,
}: {
  orgSlug: string;
  /** Membre existant (mode édition) ; absent = mode invitation. */
  userId?: string;
  /** Rôle d'org (courant ou choisi dans le formulaire d'invitation). */
  targetOrgRole: OrgRole;
  /** Libellé affiché (email du membre, ou email/invitation en cours). */
  title?: string;
  /** Mode invitation : sélection déjà faite, pour la réouverture (pas de
   *  source serveur — l'invitation n'existe pas encore). Ignoré si userId. */
  initialSelection?: ProjectAccessSelection[];
  onSave: (selection: ProjectAccessSelection[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const t = useTranslations("orgs.members.access");
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Map<string, ProjectRole>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isImplicitOwner = targetOrgRole === "OWNER" || targetOrgRole === "ADMIN";
  const hasImplicitEditor =
    targetOrgRole === "DEV" || targetOrgRole === "ADMIN_DEV";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (isImplicitOwner) {
      setProjects([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadError(null);
      const url = userId
        ? `/api/orgs/${orgSlug}/members/${userId}/project-access`
        : `/api/orgs/${orgSlug}/projects`;
      const res = await fetch(url);
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(t("loadError"));
        return;
      }
      const data = (await res.json()) as { projects: ProjectItem[] };
      setProjects(data.projects);
      // Pré-cochage : lignes explicites non masquées (mode membre) OU sélection
      // déjà faite (mode invitation, réouverture).
      const nextChecked = new Set<string>();
      const nextRoles = new Map<string, ProjectRole>();
      const initByProject = new Map(
        (initialSelection ?? []).map((s) => [s.projectId, s.role]),
      );
      for (const p of data.projects) {
        if (!userId && initByProject.has(p.id)) {
          nextChecked.add(p.id);
          nextRoles.set(p.id, initByProject.get(p.id)!);
        } else if (p.explicit) {
          nextChecked.add(p.id);
          nextRoles.set(p.id, p.explicitRole ?? "VIEWER");
        }
      }
      setChecked(nextChecked);
      setRoles(nextRoles);
    })();
    return () => {
      cancelled = true;
    };
    // `initialSelection` est un snapshot lu à l'ouverture (la modale est
    // remontée à chaque ouverture) — l'ajouter aux deps ne changerait rien
    // au comportement mais brouillerait l'intention « charger une fois ».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug, userId, isImplicitOwner, t]);

  function toggle(projectId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else {
        next.add(projectId);
        setRoles((r) => {
          if (r.has(projectId)) return r;
          const nr = new Map(r);
          nr.set(projectId, "VIEWER");
          return nr;
        });
      }
      return next;
    });
  }

  function setRole(projectId: string, role: ProjectRole) {
    setRoles((r) => new Map(r).set(projectId, role));
  }

  async function save() {
    setSaving(true);
    try {
      const selection: ProjectAccessSelection[] = [...checked].map((id) => ({
        projectId: id,
        role: roles.get(id) ?? "VIEWER",
      }));
      await onSave(selection);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560 }}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{t("title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("closeLabel")}
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          {title && (
            <p className="help" style={{ marginTop: 0 }}>
              {title}
            </p>
          )}

          {isImplicitOwner ? (
            <div className="empty-state">
              <div className="empty-state-title">{t("implicitOwner")}</div>
            </div>
          ) : (
            <>
              <p className="help" style={{ fontSize: 13 }}>
                {hasImplicitEditor ? t("noteDev") : t("noteMember")}
              </p>

              {loadError ? (
                <p className="error-text">{loadError}</p>
              ) : projects === null ? (
                <p className="help">{t("loading")}</p>
              ) : projects.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-title">{t("noProjects")}</div>
                </div>
              ) : (
                <div
                  className="row-list"
                  style={{ maxHeight: 320, overflowY: "auto" }}
                >
                  {projects.map((p) => {
                    const isChecked = checked.has(p.id);
                    const implicit =
                      !isChecked && hasImplicitEditor && !p.hidden;
                    return (
                      <label
                        key={p.id}
                        className="row"
                        style={{ cursor: "pointer", gap: 10 }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggle(p.id)}
                          style={{ width: 16, height: 16, flexShrink: 0 }}
                        />
                        <div className="row-info">
                          <div className="row-name">{p.name}</div>
                          <div className="row-meta">
                            {implicit && <span>{t("implicitEditor")}</span>}
                            {p.hidden && <span>{t("hiddenNote")}</span>}
                          </div>
                        </div>
                        {isChecked && (
                          <select
                            value={roles.get(p.id) ?? "VIEWER"}
                            onClick={(e) => e.preventDefault()}
                            onChange={(e) =>
                              setRole(p.id, e.target.value as ProjectRole)
                            }
                            className="select"
                            style={{
                              padding: "5px 32px 5px 8px",
                              fontSize: 12,
                              width: "auto",
                            }}
                          >
                            {PROJECT_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div
          className="dialog-footer"
          style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
        >
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            {t("cancel")}
          </button>
          {!isImplicitOwner && (
            <button
              type="button"
              onClick={save}
              disabled={saving || projects === null || Boolean(loadError)}
              className="btn btn-primary btn-sm"
            >
              {saving ? t("saving") : t("save")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
