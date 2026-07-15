"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { ProjectRole } from "@prisma/client";
import { RiSettings3Line, RiShieldCheckLine } from "@remixicon/react";
import EmptyCard from "@/components/EmptyCard";
import { useConfirm } from "@/components/ConfirmDialog";

type PolicyListItem = {
  id: string;
  provider: string;
  repo: string;
  workflow: string;
  branch: string;
  environment: string;
  environmentId: string;
  createdAt: string;
};

type ProjectCiContext = {
  provider: string;
  repo: string;
  connectionConfigured: boolean;
};

type EnvSummary = { id: string; name: string };

const PROVIDER_LABEL: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

const ROLE_RANK: Record<ProjectRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

export default function PoliciesPanel({
  slug,
  role,
  canManage,
  environments,
  defaultGithubRepo,
}: {
  slug: string;
  role: ProjectRole;
  /** Override canManage venant du parent (orgRole=DEV ou ProjectRole=OWNER).
   *  Si non fourni, fallback sur role >= OWNER. */
  canManage?: boolean;
  environments: EnvSummary[];
  defaultGithubRepo: string | null;
}) {
  const t = useTranslations("projects.policies");
  const confirm = useConfirm();
  const [policies, setPolicies] = useState<PolicyListItem[] | null>(null);
  const [projectCtx, setProjectCtx] = useState<ProjectCiContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const effectiveCanManage =
    canManage ?? ROLE_RANK[role] >= ROLE_RANK.OWNER;

  const reload = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/projects/${slug}/policies`);
    if (!res.ok) {
      setError("Erreur de chargement.");
      return;
    }
    const data = (await res.json()) as {
      policies: PolicyListItem[];
      project: ProjectCiContext;
    };
    setPolicies(data.policies);
    setProjectCtx(data.project);
  }, [slug]);

  // Pour créer une policy il faut une connexion CI reliée ET un repo configuré.
  const repoConfigured = projectCtx?.repo || defaultGithubRepo || "";
  const provider = projectCtx?.provider ?? "github";
  const canAddPolicy =
    Boolean(repoConfigured) && (projectCtx?.connectionConfigured ?? false);

  useEffect(() => {
    setPolicies(null);
    setAdding(false);
    reload();
  }, [reload]);

  async function remove(p: PolicyListItem) {
    if (
      !(await confirm({
        message: t("deleteConfirm", { repo: p.repo, workflow: p.workflow, branch: p.branch, environment: p.environment }),
        danger: true,
      }))
    )
      return;
    const res = await fetch(`/api/projects/${slug}/policies/${p.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(t("deleteError"));
      return;
    }
    reload();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="section-header">
        <div>
          <h2 className="section-title">{t("title")}</h2>
          <p className="panel-subtitle">{t("desc")}</p>
          <p className="panel-subtitle">{t("desc2")}</p>
        </div>
        {effectiveCanManage && !adding && policies && policies.length > 0 && (
          canAddPolicy ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="btn btn-primary btn-sm"
            >
              {t("addBtn")}
            </button>
          ) : (
            <span className="help">{t("repoRequired")}</span>
          )
        )}
      </div>

      {adding && effectiveCanManage && (
        <div className="create-card">
          <PolicyForm
            slug={slug}
            provider={provider}
            environments={environments}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {policies === null ? (
        <p className="help">Chargement…</p>
      ) : policies.length === 0 && !adding ? (
        <EmptyCard
          icon={<RiShieldCheckLine size={22} aria-hidden />}
          title={t("empty")}
          hint={t("emptyHint")}
          action={
            effectiveCanManage && !adding ? (
              canAddPolicy ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setAdding(true)}
                >
                  {t("addBtn")}
                </button>
              ) : (
                <span className="help">{t("repoRequired")}</span>
              )
            ) : undefined
          }
        />
      ) : (
        <div className="row-list">
          {policies.map((p) =>
            editingId === p.id ? (
              <div key={p.id} className="card">
                <PolicyForm
                  slug={slug}
                  provider={p.provider}
                  environments={environments}
                  initial={p}
                  onCancel={() => setEditingId(null)}
                  onSaved={() => {
                    setEditingId(null);
                    reload();
                  }}
                />
              </div>
            ) : (
              <div key={p.id} className="row">
                <div className="row-icon"><RiSettings3Line size={18} aria-hidden /></div>
                <div className="row-info">
                  <div className="row-name code-mono">
                    {p.workflow} <span className="text-muted">@</span> {p.branch}{" "}
                    → <span className="text-accent">{p.environment}</span>
                  </div>
                  <div className="row-meta code-mono">
                    <span>
                      <span className="text-muted">
                        {PROVIDER_LABEL[p.provider] ?? p.provider}
                      </span>{" "}
                      {p.repo}
                    </span>
                  </div>
                </div>
                <div className="row-actions">
                  {effectiveCanManage && (
                    <>
                      <button
                        type="button"
                        onClick={() => setEditingId(p.id)}
                        className="btn btn-ghost btn-xs"
                      >
                        Modifier
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(p)}
                        className="btn btn-danger btn-xs"
                      >
                        Supprimer
                      </button>
                    </>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function PolicyForm({
  slug,
  provider,
  environments,
  initial,
  onCancel,
  onSaved,
}: {
  slug: string;
  /** Provider CI du projet — adapte le champ workflow (fichier .yml pour
   *  github, nom d'environment CI pour gitlab/bitbucket). */
  provider: string;
  environments: EnvSummary[];
  /** Mode édition : on PATCH /policies/[id] avec uniquement les champs
   *  changés. Si non fourni, mode création (POST). */
  initial?: PolicyListItem;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("projects.policies");
  const isGithub = provider === "github";
  const [workflow, setWorkflow] = useState(
    initial?.workflow ?? (isGithub ? "deploy.yml" : ""),
  );
  const [branch, setBranch] = useState(initial?.branch ?? "main");
  const [environment, setEnvironment] = useState(
    initial?.environment ?? environments[0]?.name ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(initial);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const url = isEdit
        ? `/api/projects/${slug}/policies/${initial!.id}`
        : `/api/projects/${slug}/policies`;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow, branch, environment }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(
          data?.error ??
            (isEdit ? t("updateError") : t("createError")),
        );
        return;
      }
      onSaved();
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="form-row">
        <div className="field">
          <label>
            {isGithub ? t("form.workflowLabel") : t("form.envCiLabel")}
          </label>
          <input
            required={isGithub}
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            placeholder={isGithub ? "deploy.yml" : t("form.envCiPlaceholder")}
            className="input input-mono"
          />
        </div>
        <div className="field">
          <label>{t("form.branchLabel")}</label>
          <input
            required
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            className="input input-mono"
          />
        </div>
        <div className="field">
          <label>{t("form.envLabel")}</label>
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            required
            className="select"
          >
            {environments.map((e) => (
              <option key={e.id} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <p className="error-text" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary btn-sm"
        >
          {isEdit ? t("form.updateBtn") : t("form.submitBtn")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-ghost btn-sm"
        >
          Annuler
        </button>
      </div>
    </form>
  );
}
