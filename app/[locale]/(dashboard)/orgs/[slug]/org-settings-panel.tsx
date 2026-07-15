"use client";

import { useState, useTransition } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import type { OrgRole } from "@prisma/client";
import { useConfirm } from "@/components/ConfirmDialog";

// Onglet « Paramètres » de l'organisation (ex-modale OrgSettingsDialog,
// convertie en panneau inline pour cohérence avec les autres onglets de
// /orgs/[slug]). Nom, rotation des secrets, et zone danger (OWNER).
export default function OrgSettingsPanel({
  slug,
  initialName,
  role,
  isPrimary,
  rotationFeatureEnabled,
  rotationPaidPlan,
}: {
  slug: string;
  initialName: string;
  role: OrgRole;
  isPrimary: boolean;
  rotationFeatureEnabled: boolean;
  /** Le plan permet-il la rotation ? (FREE = non → toggle masqué). */
  rotationPaidPlan: boolean;
}) {
  const t = useTranslations("orgs.settings");
  const confirm = useConfirm();
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [rotationEnabled, setRotationEnabled] = useState(rotationFeatureEnabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = name.trim() !== initialName && name.trim().length > 0;
  const isOwner = role === "OWNER";

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/orgs/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      router.refresh();
    });
  }

  async function deleteOrg() {
    const confirm1 = prompt(
      `Pour supprimer l'organisation, tapez son nom : "${initialName}"`,
    );
    if (confirm1 !== initialName) return;
    if (!(await confirm({ message: t("deleteConfirm"), danger: true }))) return;

    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/orgs/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("deleteError"));
        return;
      }
      router.push("/dashboard");
      router.refresh();
    });
  }

  return (
    <div
      style={{
        border: "1px solid var(--accent-soft)",
        background: "var(--accent-bg)",
        borderRadius: 12,
        padding: 16,
        display: "grid",
        gap: 14,
      }}
    >
      <section className="card" style={{ padding: 20 }}>
        <h3 className="section-title" style={{ fontSize: 14, marginBottom: 8 }}>
          {t("nameSection")}
        </h3>
        <form onSubmit={save} className="form-row">
          <div className="field" style={{ minWidth: 220 }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="input"
            />
          </div>
          <button
            type="submit"
            disabled={!dirty || pending}
            className="btn btn-primary btn-primary-form"
          >
            {pending ? t("savingBtn") : t("saveBtn")}
          </button>
        </form>
        <p className="help" style={{ marginTop: 6 }}>
          {t("slugNote")} (<code className="code-mono">/{slug}</code>)
        </p>
      </section>

      {rotationPaidPlan && (
      <section className="card" style={{ padding: 20 }}>
        <h3 className="section-title" style={{ fontSize: 14, marginBottom: 8 }}>
          {t("advancedSection")}
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={rotationEnabled}
              onChange={(e) => {
                const next = e.target.checked;
                setRotationEnabled(next);
                startTransition(async () => {
                  const res = await fetch(`/api/orgs/${slug}/rotation/settings`, {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ enabled: next }),
                  });
                  if (!res.ok) {
                    setRotationEnabled(!next);
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    setError(data?.error ?? t("saveError"));
                    return;
                  }
                  router.refresh();
                });
              }}
            />
            {t("rotationLabel")}
          </label>
        </div>
        <p className="help" style={{ marginTop: 6 }}>
          {t("rotationDesc")}
        </p>
      </section>
      )}

      {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}

      {isOwner && (
        <section className="card" style={{ padding: 20 }}>
          <h3
            className="section-title"
            style={{ fontSize: 14, color: "var(--danger)", marginBottom: 8 }}
          >
            {t("dangerSection")}
          </h3>
          {isPrimary ? (
            // L'org principale est l'ancre du tenant : pas de suppression
            // isolée. La fermeture passe par la suppression du compte.
            <p className="help" style={{ marginBottom: 0 }}>
              {t.rich("primaryUndeletable", {
                link: (chunks) => (
                  <Link href="/account" className="link">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          ) : (
            <>
              <p className="help" style={{ marginBottom: 12 }}>
                {t("deleteDesc")}
              </p>
              <button
                type="button"
                onClick={deleteOrg}
                disabled={pending}
                className="btn btn-danger btn-sm"
              >
                {t("deleteBtn")}
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
