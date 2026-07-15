"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { RiEdit2Line } from "@remixicon/react";
import GroupsManagerDialog from "./groups-manager-dialog";
import type { GroupVM } from "./projects-board";

export default function CreateGroupForm({
  groups,
  canEdit,
}: {
  groups: GroupVM[];
  canEdit: boolean;
}) {
  const t = useTranslations("projects");
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [manageOpen, setManageOpen] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/projects/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("createGroup.createError"));
        return;
      }
      setName("");
      router.refresh();
    });
  }

  return (
    <>
      <form onSubmit={onSubmit} className="create-card create-group-card">
        <div className="create-group-head">
          <div className="create-group-head-left">
            <div className="create-card-title">{t("createGroup.title")}</div>
            <label htmlFor="create-group-name">{t("createGroup.nameLabel")}</label>
          </div>
          {canEdit && groups.length > 0 && (
            <button
              type="button"
              className="icon-btn"
              title={t("groups.manageTitle")}
              aria-label={t("groups.manageTitle")}
              onClick={() => setManageOpen(true)}
            >
              <RiEdit2Line size={15} />
            </button>
          )}
        </div>
        <div className="form-row">
          <div className="field">
            <input
              id="create-group-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("createGroup.namePlaceholder")}
              className="input"
            />
          </div>
          <button
            type="submit"
            disabled={pending || name.trim().length === 0}
            className="btn btn-primary btn-primary-form"
          >
            {pending ? t("createGroup.creatingBtn") : t("createGroup.submitBtn")}
          </button>
        </div>
        {error && <p className="error-text" style={{ marginTop: 6 }}>{error}</p>}
      </form>
      {manageOpen && (
        <GroupsManagerDialog
          groups={groups}
          onClose={() => setManageOpen(false)}
          onChanged={() => router.refresh()}
        />
      )}
    </>
  );
}
