"use client";

// Accueil de la page Projets : barre de recherche (nom, slug) + boutons
// « Créer un projet » / « Créer un groupe ». Un clic sur un bouton affiche le
// formulaire À LA PLACE de la liste ; un second clic (ou la création) y revient.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { RiAddLine, RiFolderAddLine, RiSearchLine } from "@remixicon/react";
import CreateProjectForm, { type SettableMember } from "./create-project";
import CreateGroupForm from "./create-group";
import ProjectsBoard, { type GroupVM, type ProjectVM } from "./projects-board";

type Mode = "list" | "project" | "group";

/** Minuscules, sans accents : « Événements » se trouve en tapant « even ». */
function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export default function ProjectsHome({
  projects,
  groups,
  members,
  canEdit,
}: {
  projects: ProjectVM[];
  groups: GroupVM[];
  members: SettableMember[];
  canEdit: boolean;
}) {
  const t = useTranslations("projects");
  const [mode, setMode] = useState<Mode>("list");
  const [query, setQuery] = useState("");

  const q = normalize(query.trim());
  const filtered = useMemo(
    () =>
      q
        ? projects.filter(
            (p) => normalize(p.name).includes(q) || normalize(p.slug).includes(q),
          )
        : projects,
    [projects, q],
  );

  function toggle(target: Exclude<Mode, "list">) {
    setMode((m) => (m === target ? "list" : target));
  }

  const backToList = () => setMode("list");

  return (
    <>
      <div className="projects-toolbar">
        <div className="projects-search">
          <RiSearchLine size={16} aria-hidden className="projects-search-icon" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMode("list");
            }}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="input"
          />
        </div>
        <div className="projects-toolbar-actions">
          <button
            type="button"
            onClick={() => toggle("project")}
            className={`btn btn-sm ${mode === "project" ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={mode === "project"}
          >
            <RiAddLine size={14} aria-hidden /> {t("createForm.title")}
          </button>
          <button
            type="button"
            onClick={() => toggle("group")}
            className={`btn btn-sm ${mode === "group" ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={mode === "group"}
          >
            <RiFolderAddLine size={14} aria-hidden /> {t("createGroup.title")}
          </button>
        </div>
      </div>

      {mode === "project" ? (
        <CreateProjectForm members={members} onCreated={backToList} />
      ) : mode === "group" ? (
        <CreateGroupForm groups={groups} canEdit={canEdit} onCreated={backToList} />
      ) : projects.length === 0 && groups.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">{t("empty")}</div>
          <div>{t("emptyHint")}</div>
        </div>
      ) : filtered.length === 0 && q ? (
        <div className="empty-state">
          <div className="empty-state-title">
            {t("searchNoMatch", { query: query.trim() })}
          </div>
        </div>
      ) : (
        <ProjectsBoard
          // Glisser-déposer coupé pendant une recherche : les positions sont
          // recalculées sur les seuls projets visibles du groupe, ce qui
          // écraserait celles des projets masqués par le filtre.
          canEdit={canEdit && !q}
          groups={groups}
          projects={filtered}
        />
      )}
    </>
  );
}
