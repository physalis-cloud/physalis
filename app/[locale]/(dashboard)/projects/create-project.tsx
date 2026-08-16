"use client";

// Formulaire de création de projet, avec les droits d'accès des autres membres
// réglés DANS le même geste.
//
// Pourquoi ici plutôt qu'un rappel après coup : un projet neuf est accessible
// d'emblée à tous les DEV/ADMIN_DEV de l'org (EDITOR implicite, règle 4). Un
// avertissement « pensez à ajuster les droits » se fait cliquer sans être lu, et
// le projet reste ouvert entre-temps. Le seul moment où l'oubli est impossible,
// c'est la création.
//
// La case dit l'accès EFFECTIF (comme la modale « Droits d'accès ») : un DEV
// arrive coché en Éditeur puisque c'est ce qu'il aura, un MEMBER décoché. La
// traduction en ligne `ProjectMember` — barrière `hidden` pour un DEV décoché,
// rien du tout pour un MEMBER décoché — est faite côté serveur par
// `desiredMembershipRow` (§4).

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import type { OrgRole, ProjectRole } from "@prisma/client";
import type { DesiredProjectAccess } from "@/lib/project-access";

const PROJECT_ROLES: ProjectRole[] = ["VIEWER", "EDITOR", "OWNER"];

export type SettableMember = {
  userId: string;
  email: string;
  orgRole: OrgRole;
};

/** Ce que le membre obtiendrait sans qu'on touche à rien (règles 4 et 5). */
function implicitAccess(orgRole: OrgRole): ProjectRole | null {
  return orgRole === "DEV" || orgRole === "ADMIN_DEV" ? "EDITOR" : null;
}

function initials(email: string): string {
  const local = email.split("@")[0] || email;
  return local.slice(0, 2).toUpperCase();
}

export default function CreateProjectForm({
  members = [],
}: {
  members?: SettableMember[];
}) {
  const t = useTranslations("projects");
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [showAccess, setShowAccess] = useState(false);
  // Révélation progressive du bloc « Droits d'accès » : ce formulaire est
  // affiché en permanence sur la page projets, le bloc n'a donc rien à y faire
  // tant qu'aucune création n'est engagée. Le seuil est le MÊME que celui qui
  // active le bouton « Créer » (nom non vide) et que celui du serveur
  // (`api/projects` refuse le seul nom vide) : un seuil distinct — 3 caractères
  // par exemple — laisserait créer un projet nommé `ab` sans jamais pouvoir en
  // régler les accès.
  //
  // ALLER SIMPLE : une fois révélé, le bloc ne se referme pas si on efface le
  // nom. Sinon il apparaît, disparaît et réapparaît pendant la frappe, et la
  // page saute sous le curseur. Remis à zéro par `reset()` après création.
  const [nameEverFilled, setNameEverFilled] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(members.filter((m) => implicitAccess(m.orgRole)).map((m) => m.userId)),
  );
  const [roles, setRoles] = useState<Map<string, ProjectRole>>(
    () =>
      new Map(
        members
          .map((m) => [m.userId, implicitAccess(m.orgRole)] as const)
          .filter((e): e is readonly [string, ProjectRole] => e[1] !== null),
      ),
  );

  function toggle(userId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else {
        next.add(userId);
        setRoles((r) => (r.has(userId) ? r : new Map(r).set(userId, "VIEWER")));
      }
      return next;
    });
  }

  function reset() {
    setName("");
    setChecked(
      new Set(members.filter((m) => implicitAccess(m.orgRole)).map((m) => m.userId)),
    );
    setShowAccess(false);
    setNameEverFilled(false);
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      // On envoie TOUS les membres réglables, décochés compris (`NONE`) : le
      // serveur ne pose une ligne que là où elle change quelque chose.
      const memberAccess: Array<{
        userId: string;
        role: DesiredProjectAccess;
      }> = members.map((m) => ({
        userId: m.userId,
        role: checked.has(m.userId) ? (roles.get(m.userId) ?? "VIEWER") : "NONE",
      }));
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          ...(memberAccess.length > 0 ? { memberAccess } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("createForm.createError"));
        return;
      }
      reset();
      router.refresh();
    });
  }

  const blockedCount = members.filter(
    (m) => !checked.has(m.userId) && implicitAccess(m.orgRole) !== null,
  ).length;

  return (
    <form onSubmit={onSubmit} className="create-card">
      <div className="create-card-title">{t("createForm.title")}</div>
      <div className="form-row">
        <div className="field">
          <label style={{ marginLeft: 4 }}>{t("createForm.nameLabel")}</label>
          <input
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim().length > 0) setNameEverFilled(true);
            }}
            placeholder={t("createForm.namePlaceholder")}
            className="input"
          />
        </div>
        <button
          type="submit"
          disabled={pending || name.trim().length === 0}
          className="btn btn-primary btn-primary-form"
        >
          {pending ? t("createForm.creatingBtn") : t("createForm.submitBtn")}
        </button>
      </div>

      {members.length > 0 && nameEverFilled && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            onClick={() => setShowAccess((v) => !v)}
            className="btn btn-ghost btn-sm"
            aria-expanded={showAccess}
          >
            {showAccess ? "▾" : "▸"} {t("createForm.accessTitle")} (
            {t("createForm.accessSummary", {
              granted: checked.size,
              total: members.length,
            })}
            )
          </button>

          {showAccess && (
            <div style={{ marginTop: 8 }}>
              <p className="help" style={{ fontSize: 13, marginTop: 0 }}>
                {t("createForm.accessNote")}
              </p>
              <div className="row-list" style={{ maxHeight: 260, overflowY: "auto" }}>
                {members.map((m) => {
                  const isChecked = checked.has(m.userId);
                  return (
                    <label
                      key={m.userId}
                      // `row-checkable` : cette ligne a QUATRE enfants (case,
                      // icône, infos, select) et `.row` n'a que 3 colonnes.
                      className="row row-checkable"
                      style={{ cursor: "pointer", gap: 10 }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggle(m.userId)}
                        style={{ width: 16, height: 16, flexShrink: 0 }}
                      />
                      <div className="row-icon" aria-hidden>
                        {initials(m.email)}
                      </div>
                      <div className="row-info">
                        <div className="row-name">
                          {m.email}
                          <span
                            className={`role role-${m.orgRole.toLowerCase()}`}
                            style={{ marginLeft: 6 }}
                          >
                            {m.orgRole}
                          </span>
                        </div>
                        <div className="row-meta">
                          {!isChecked && implicitAccess(m.orgRole) && (
                            <span>{t("createForm.accessBlocked")}</span>
                          )}
                        </div>
                      </div>
                      {isChecked && (
                        <select
                          value={roles.get(m.userId) ?? "VIEWER"}
                          onClick={(e) => e.preventDefault()}
                          onChange={(e) =>
                            setRoles((r) =>
                              new Map(r).set(
                                m.userId,
                                e.target.value as ProjectRole,
                              ),
                            )
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
              {blockedCount > 0 && (
                <p className="help" style={{ fontSize: 12 }}>
                  {t("createForm.accessBlockedSummary", { count: blockedCount })}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="error-text" style={{ marginTop: 6 }}>{error}</p>}
    </form>
  );
}
