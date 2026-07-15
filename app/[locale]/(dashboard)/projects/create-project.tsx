"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

export default function CreateProjectForm() {
  const t = useTranslations("projects");
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("createForm.createError"));
        return;
      }
      setName("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="create-card">
      <div className="create-card-title">{t("createForm.title")}</div>
      <div className="form-row">
        <div className="field">
          <label style={{ marginLeft: 4 }}>{t("createForm.nameLabel")}</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
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
      {error && <p className="error-text" style={{ marginTop: 6 }}>{error}</p>}
    </form>
  );
}
