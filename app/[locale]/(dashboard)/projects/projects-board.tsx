"use client";

import { useEffect, useRef, useState } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { RiDraggable } from "@remixicon/react";
import ProjectStatusIcons, {
  type ProjectStatusData,
} from "@/components/ProjectStatusIcons";

export type ProjectVM = {
  id: string;
  name: string;
  slug: string;
  groupId: string | null;
  position: number;
  services: number;
  accounts: number;
  environments: number;
  secrets: number;
  status: ProjectStatusData;
  lastDeploy: { at: string; envName: string | null } | null;
};

export type GroupVM = { id: string; name: string; position: number };

const UNGROUPED = "__ungrouped__";

export default function ProjectsBoard({
  projects,
  groups: initialGroups,
  canEdit,
}: {
  projects: ProjectVM[];
  groups: GroupVM[];
  canEdit: boolean;
}) {
  const t = useTranslations("projects");
  const router = useRouter();

  const [items, setItems] = useState<ProjectVM[]>(projects);
  const [groups, setGroups] = useState<GroupVM[]>(initialGroups);
  const dragId = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  // Reconcilie l'état local quand les props serveur changent (après refresh).
  useEffect(() => setItems(projects), [projects]);
  useEffect(() => setGroups(initialGroups), [initialGroups]);

  function byPos(a: ProjectVM, b: ProjectVM) {
    return a.position - b.position;
  }

  function projectsOf(groupId: string | null): ProjectVM[] {
    return items.filter((p) => p.groupId === groupId).sort(byPos);
  }

  async function persist(next: ProjectVM[]) {
    const assignments = next.map((p) => ({
      projectId: p.id,
      groupId: p.groupId,
      position: p.position,
    }));
    const res = await fetch("/api/projects/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignments }),
    });
    if (!res.ok) router.refresh(); // réconciliation en cas d'échec
  }

  // Déplace le projet en cours de drag dans `targetGroupId`, inséré avant
  // `beforeId` (ou à la fin si null). Recalcule les positions du groupe cible.
  function move(targetGroupId: string | null, beforeId: string | null) {
    const id = dragId.current;
    if (!id || id === beforeId) return;
    const dragged = items.find((p) => p.id === id);
    if (!dragged) return;

    const rest = items.filter((p) => p.id !== id);
    const target = rest.filter((p) => p.groupId === targetGroupId).sort(byPos);
    const others = rest.filter((p) => p.groupId !== targetGroupId);

    const idx = beforeId ? target.findIndex((p) => p.id === beforeId) : -1;
    const insertAt = idx < 0 ? target.length : idx;
    target.splice(insertAt, 0, { ...dragged, groupId: targetGroupId });

    const repositioned = target.map((p, i) => ({ ...p, position: i }));
    const next = [...others, ...repositioned];
    setItems(next);
    persist(next);
  }

  function onCardDragStart(e: React.DragEvent, id: string) {
    dragId.current = id;
    setDragging(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }
  function onDragEnd() {
    dragId.current = null;
    setDragging(null);
    setOverKey(null);
  }

  function relativeTime(iso: string): string {
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return t("relTime.justNow");
    const min = Math.floor(sec / 60);
    if (min < 60) return t("relTime.minutesAgo", { n: min });
    const hr = Math.floor(min / 60);
    if (hr < 24) return t("relTime.hoursAgo", { n: hr });
    const day = Math.floor(hr / 24);
    if (day < 30) return t("relTime.daysAgo", { n: day });
    const month = Math.floor(day / 30);
    if (month < 12) return t("relTime.monthsAgo", { n: month });
    return t("relTime.yearsAgo", { n: Math.floor(day / 365) });
  }

  function card(p: ProjectVM) {
    return (
      <Link
        key={p.id}
        href={`/projects/${p.slug}`}
        className={`card card-link project-card${dragging === p.id ? " is-dragging" : ""}${
          overKey === p.id ? " is-drop-target" : ""
        }`}
        style={{ position: "relative" }}
        draggable={canEdit}
        onDragStart={canEdit ? (e) => onCardDragStart(e, p.id) : undefined}
        onDragEnd={canEdit ? onDragEnd : undefined}
        onDragOver={
          canEdit
            ? (e) => {
                if (!dragId.current || dragId.current === p.id) return;
                e.preventDefault();
                setOverKey(p.id);
              }
            : undefined
        }
        onDragLeave={canEdit ? () => setOverKey((k) => (k === p.id ? null : k)) : undefined}
        onDrop={
          canEdit
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                move(p.groupId, p.id);
                onDragEnd();
              }
            : undefined
        }
      >
        {canEdit && (
          <span className="project-drag-handle" aria-hidden>
            <RiDraggable size={16} />
          </span>
        )}
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 8,
          }}
        >
          {p.lastDeploy && (
            <span
              title={p.lastDeploy.at}
              style={{
                fontSize: 11,
                fontWeight: 500,
                padding: "3px 8px",
                borderRadius: 999,
                background: "#fde9c8",
                color: "#8a4b00",
                whiteSpace: "nowrap",
              }}
            >
              {p.lastDeploy.envName ? `${p.lastDeploy.envName} · ` : ""}
              {relativeTime(p.lastDeploy.at)}
            </span>
          )}
          <ProjectStatusIcons data={p.status} />
        </div>
        <div className="project-name" style={{ paddingRight: 110 }}>
          {p.name}
        </div>
        <div className="project-slug">/{p.slug}</div>
        <div className="project-stats">
          <span>
            <span className="stat-icon">●</span>
            <strong>{p.services}</strong> {t("card.services")}
          </span>
          <span>
            <span className="stat-icon">●</span>
            <strong>{p.accounts}</strong> {t("card.accounts")}
          </span>
          <span>
            <span className="stat-icon">●</span>
            <strong>{p.environments}</strong> {t("card.env")}
          </span>
          <span>
            <span className="stat-icon">●</span>
            <strong>{p.secrets}</strong> {t("card.secrets")}
          </span>
        </div>
      </Link>
    );
  }

  function section(opts: {
    key: string;
    groupId: string | null;
    title: React.ReactNode | null;
  }) {
    const list = projectsOf(opts.groupId);
    const dropKey = `zone:${opts.key}`;
    return (
      <section
        key={opts.key}
        className={`project-group${overKey === dropKey ? " is-drop-target" : ""}`}
        onDragOver={
          canEdit
            ? (e) => {
                if (!dragId.current) return;
                e.preventDefault();
                setOverKey(dropKey);
              }
            : undefined
        }
        onDragLeave={canEdit ? () => setOverKey((k) => (k === dropKey ? null : k)) : undefined}
        onDrop={
          canEdit
            ? (e) => {
                e.preventDefault();
                move(opts.groupId, null); // drop sur la zone = fin du groupe
                onDragEnd();
              }
            : undefined
        }
      >
        {opts.title !== null && (
          <div className="project-group-head">
            <div className="project-group-title">
              {opts.title}
              <span className="project-group-count">{list.length}</span>
            </div>
          </div>
        )}
        {list.length === 0 ? (
          <div className="project-group-empty">{t("groups.dropHint")}</div>
        ) : (
          <div className="projects-grid">{list.map(card)}</div>
        )}
      </section>
    );
  }

  const ungrouped = projectsOf(null);
  const sortedGroups = [...groups].sort((a, b) => a.position - b.position);
  // Un groupe vide n'est affiché QUE pendant un drag (cible de drop) ; au repos
  // on masque les sections vides, « Sans groupe » compris.
  const dragActive = dragging !== null;

  return (
    <div className="projects-board">
      {(ungrouped.length > 0 || dragActive) &&
        section({
          key: UNGROUPED,
          groupId: null,
          // Pas de groupe créé → on masque le header « Sans groupe » + la
          // pastille de compte (redondant : tous les projets sont ici).
          title: sortedGroups.length > 0 ? t("groups.ungrouped") : null,
        })}
      {sortedGroups.map((g) =>
        projectsOf(g.id).length > 0 || dragActive
          ? section({ key: g.id, groupId: g.id, title: g.name })
          : null,
      )}
    </div>
  );
}
