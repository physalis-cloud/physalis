"use client";

// Modale de gestion des groupes de projets : renommer / supprimer / réordonner
// (drag-and-drop). Style global .dialog* de globals.css.

import { useRef, useState } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { RiDeleteBinLine, RiDraggable } from "@remixicon/react";
import { useConfirm } from "@/components/ConfirmDialog";
import type { GroupVM } from "./projects-board";

const NAME_MAX = 80;

type Row = { id: string; name: string; original: string };

export default function GroupsManagerDialog({
  groups,
  onClose,
  onChanged,
}: {
  groups: GroupVM[];
  onClose: () => void;
  /** Appelé après chaque rename/delete/réordonnancement réussi (router.refresh). */
  onChanged: () => void;
}) {
  const t = useTranslations("projects");
  const router = useRouter();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Row[]>(
    groups.map((g) => ({ id: g.id, name: g.name, original: g.name })),
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragIndex = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  async function rename(row: Row) {
    const name = row.name.trim();
    if (!name || name === row.original) return;
    setPendingId(row.id);
    setError(null);
    const res = await fetch(`/api/projects/groups/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setPendingId(null);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? t("createGroup.createError"));
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, name, original: name } : r)),
    );
    onChanged();
  }

  async function remove(row: Row) {
    const ok = await confirm({
      title: t("groups.delete"),
      message: t("groups.deleteConfirm", { name: row.original }),
      danger: true,
    });
    if (!ok) return;
    setPendingId(row.id);
    setError(null);
    const res = await fetch(`/api/projects/groups/${row.id}`, { method: "DELETE" });
    setPendingId(null);
    if (!res.ok) {
      setError(t("createGroup.createError"));
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    onChanged();
  }

  // Réordonne localement puis persiste l'ordre via l'API reorder (groupOrder).
  async function reorder(from: number, to: number) {
    if (from === to) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setRows(next);
    const res = await fetch("/api/projects/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupOrder: next.map((r) => r.id) }),
    });
    if (!res.ok) {
      router.refresh();
      return;
    }
    onChanged();
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t("groups.manageTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label={t("groups.close")}
          >
            ✕
          </button>
        </div>
        <div className="dialog-body">
          {rows.length === 0 ? (
            <p className="group-manage-empty">{t("groups.emptyList")}</p>
          ) : (
            rows.map((row, i) => {
              const dirty = row.name.trim() !== row.original && row.name.trim().length > 0;
              const busy = pendingId === row.id;
              return (
                <div
                  key={row.id}
                  className={`group-manage-row${overIndex === i ? " is-over" : ""}`}
                  onDragOver={(e) => {
                    if (dragIndex.current === null) return;
                    e.preventDefault();
                    setOverIndex(i);
                  }}
                  onDragLeave={() => setOverIndex((v) => (v === i ? null : v))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex.current !== null) reorder(dragIndex.current, i);
                    dragIndex.current = null;
                    setOverIndex(null);
                  }}
                >
                  <span
                    className="group-drag-handle"
                    draggable
                    title={t("groups.reorder")}
                    aria-label={t("groups.reorder")}
                    onDragStart={() => {
                      dragIndex.current = i;
                    }}
                    onDragEnd={() => {
                      dragIndex.current = null;
                      setOverIndex(null);
                    }}
                  >
                    <RiDraggable size={16} aria-hidden />
                  </span>
                  <input
                    value={row.name}
                    maxLength={NAME_MAX}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id ? { ...r, name: e.target.value } : r,
                        ),
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        rename(row);
                      }
                    }}
                    className="input"
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-primary-form"
                    disabled={!dirty || busy}
                    onClick={() => rename(row)}
                  >
                    {t("groups.save")}
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-danger group-manage-del"
                    title={t("groups.delete")}
                    aria-label={t("groups.delete")}
                    disabled={busy}
                    onClick={() => remove(row)}
                  >
                    <RiDeleteBinLine size={16} />
                  </button>
                </div>
              );
            })
          )}
          {error && <p className="error-text">{error}</p>}
        </div>
        <div className="dialog-footer">
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            {t("groups.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
