"use client";

// #2-C — Modale « Droits d'accès » : pose les accès projet d'un membre (ou
// pré-remplit ceux d'une invitation). Case cochée = a accès, + rôle par projet.
//
// Auto-chargeante :
//   • userId fourni  → GET members/[userId]/project-access (accès courant).
//   • userId absent  → GET orgs/[slug]/projects (mode invitation).
//
// La modale ne décide RIEN : elle renvoie la sélection via onSave. Le parent
// choisit quoi en faire (PUT pour un membre, corps du POST pour une invitation).
//
// ── La case dit l'accès EFFECTIF, pas l'existence d'une ligne en base ──
// C'est le point qui rend la modale sûre. Un DEV a l'EDITOR implicite sur tout
// (règle 4) SANS aucune ligne : si on pré-cochait « les lignes explicites », il
// s'ouvrirait tout décoché alors qu'il a accès à tout, et un simple
// « Enregistrer » le bloquerait partout sans que personne ne l'ait voulu.
// On pré-coche donc `hasAccess` / `effectiveRole`, et décocher est un ordre :
//   • DEV/ADMIN_DEV : décoché → barrière (`NONE`, ligne `hidden`), le projet
//     disparaît de sa liste et l'accès est refusé.
//   • MEMBER        : décoché → `NONE` aussi, mais aucune ligne n'est écrite —
//     l'absence de ligne EST déjà le refus (règle 5).
//   • OWNER/ADMIN   : OWNER implicite partout → la modale n'a pas d'objet.
// La traduction accès voulu → ligne est faite côté serveur par
// `desiredMembershipRow` (§4), jamais ici.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { OrgRole, ProjectRole } from "@prisma/client";
import type { DesiredProjectAccess } from "@/lib/project-access";

const PROJECT_ROLES: ProjectRole[] = ["VIEWER", "EDITOR", "OWNER"];

export type ProjectAccessSelection = {
  projectId: string;
  role: DesiredProjectAccess;
};

type ProjectItem = {
  id: string;
  slug: string;
  name: string;
  hidden?: boolean;
  hasAccess?: boolean;
  effectiveRole?: ProjectRole | null;
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
      // Pré-cochage = accès EFFECTIF (mode membre), ce que l'invité OBTIENDRA
      // (mode invitation), ou la sélection déjà faite si la modale est rouverte.
      const nextChecked = new Set<string>();
      const nextRoles = new Map<string, ProjectRole>();
      const initByProject = new Map(
        (initialSelection ?? []).map((s) => [s.projectId, s.role]),
      );
      for (const p of data.projects) {
        const init = userId ? undefined : initByProject.get(p.id);
        if (init !== undefined) {
          if (init !== "NONE") {
            nextChecked.add(p.id);
            nextRoles.set(p.id, init);
          }
          continue;
        }
        // Mode invitation : pas d'accès courant à lire, on projette la règle 4
        // (un invité DEV arrivera EDITOR partout).
        const hasAccess = userId ? Boolean(p.hasAccess) : hasImplicitEditor;
        if (!hasAccess) continue;
        nextChecked.add(p.id);
        nextRoles.set(p.id, (userId ? p.effectiveRole : "EDITOR") ?? "VIEWER");
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
  }, [orgSlug, userId, isImplicitOwner, hasImplicitEditor, t]);

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
      // On envoie TOUS les projets, y compris les décochés en `NONE` : le
      // serveur converge vers ce qu'on lui décrit. N'envoyer que les cochés
      // laisserait un DEV décoché sur son accès implicite — le geste serait sans
      // effet, exactement le piège qu'on ferme.
      const selection: ProjectAccessSelection[] = (projects ?? []).map((p) => ({
        projectId: p.id,
        role: checked.has(p.id) ? (roles.get(p.id) ?? "VIEWER") : "NONE",
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
                    // Décoché sur une cible à accès implicite = barrière à
                    // poser (ou déjà posée) : on le dit, ce n'est pas neutre.
                    const willBlock = !isChecked && hasImplicitEditor;
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
                            {willBlock && <span>{t("blockedNote")}</span>}
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
