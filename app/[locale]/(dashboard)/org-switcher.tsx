"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import type { OrgRole } from "@prisma/client";

type Org = { id: string; name: string; slug: string; role: OrgRole };

export default function OrgSwitcher({
  organizations,
  currentSlug,
}: {
  organizations: Org[];
  currentSlug: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const t = useTranslations("dashboard.orgSwitcher");
  const current = organizations.find((o) => o.slug === currentSlug);

  async function setCurrentOrg(slug: string): Promise<boolean> {
    const res = await fetch("/api/me/current-org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    return res.ok;
  }

  function switchTo(slug: string) {
    startTransition(async () => {
      if (await setCurrentOrg(slug)) {
        setOpen(false);
        // push() est no-op si on est déjà sur /dashboard → on enchaîne avec
        // refresh() pour invalider le cache RSC et que le layout re-fetch
        // currentSlug. Sur les autres pages, push() navigue + Next fetch
        // la nouvelle route, le refresh() est redondant mais inoffensif.
        router.push("/dashboard");
        router.refresh();
      }
    });
  }

  function createOrg(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch("/api/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) {
        const data = (await res.json()) as { organization: { slug: string } };
        await setCurrentOrg(data.organization.slug);
        setNewName("");
        setCreating(false);
        setOpen(false);
        router.push("/dashboard");
        router.refresh();
      }
    });
  }

  if (organizations.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="org-pill"
      >
        <span>{current?.name ?? t("placeholder")}</span>
        <span className="chev">▾</span>
      </button>

      {open && (
        <>
        <div
          className="fixed inset-0 z-10"
          onClick={() => setOpen(false)}
          aria-hidden
        />
        <div className="absolute left-0 top-full mt-2 w-72 rounded-xl border border-border bg-surface shadow-lg z-20 overflow-hidden">
          <ul className="max-h-72 overflow-auto">
            {organizations.map((org) => (
              <li
                key={org.id}
                className={`flex items-center gap-1 ${
                  org.slug === currentSlug ? "bg-accent-bg" : ""
                }`}
              >
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => switchTo(org.slug)}
                  className="flex-1 text-left px-3 py-2.5 text-sm hover:bg-code-bg transition-colors min-w-0"
                >
                  <div className="truncate font-medium">{org.name}</div>
                  <div
                    className="text-xs text-muted mt-0.5"
                    style={{ textTransform: "lowercase" }}
                  >
                    {org.role.toLowerCase()}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-border p-2 bg-bg">
            {creating ? (
              <form onSubmit={createOrg} className="flex flex-col gap-2 p-1">
                <input
                  required
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t("newOrgName")}
                  className="input"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={pending}
                    className="btn btn-primary btn-sm"
                  >
                    {t("create")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setNewName("");
                    }}
                    className="btn btn-ghost btn-sm"
                  >
                    {t("cancel")}
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full text-left text-xs px-2 py-1.5 text-muted hover:text-fg transition-colors"
              >
                {t("newOrg")}
              </button>
            )}
          </div>
        </div>
        </>
      )}
    </div>
  );
}
