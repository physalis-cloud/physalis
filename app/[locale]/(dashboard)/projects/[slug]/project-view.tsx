"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { ProjectRole } from "@prisma/client";
import { hasDevPrivileges } from "@/lib/roles";
import SecretsPanel from "./secrets-panel";
import TokensPanel from "./tokens-panel";
import ComposePanel from "./compose-panel";
import InfosPanel from "./infos-panel";
import PoliciesPanel from "./policies-panel";
import MembersPanel from "./members-panel";
import SettingsDialog from "./settings-dialog";
import TeamVaultPanel from "../../team-vault-panel";

type EnvSummary = {
  id: string;
  name: string;
  url: string | null;
  serverId: string | null;
  deployPath: string | null;
  secretCount: number;
};

const ROLE_RANK: Record<ProjectRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

const ENV_ORDER = ["test", "development", "staging", "production", "main"];
const ENV_DISPLAY_NAMES: Record<string, string> = {};


function envDisplay(name: string): string {
  return ENV_DISPLAY_NAMES[name] ?? name;
}

function sortEnvs(a: EnvSummary, b: EnvSummary): number {
  const ai = ENV_ORDER.indexOf(a.name);
  const bi = ENV_ORDER.indexOf(b.name);
  if (ai === -1 && bi === -1) return 0; // preserve creation order
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

type MainTab =
  | { kind: "access" }
  | { kind: "vault" }
  | { kind: "policies" }
  | { kind: "members" }
  | { kind: "env"; envName: string };

export default function ProjectView({
  projectName,
  slug,
  orgSlug,
  githubRepo,
  githubWorkflow,
  ciConnectionId,
  ciRepo,
  environments,
  role,
  orgRole,
}: {
  projectName: string;
  slug: string;
  orgSlug: string;
  githubRepo: string | null;
  githubWorkflow: string | null;
  ciConnectionId: string | null;
  ciRepo: string | null;
  environments: EnvSummary[];
  role: ProjectRole;
  /** OrgRole transversal — OrgDEV peut gérer les policies au même titre
   *  qu'un ProjectOWNER, contrairement à un ProjectEDITOR explicite. */
  orgRole: "OWNER" | "ADMIN" | "ADMIN_DEV" | "DEV" | "MEMBER" | null;
}) {
  const t = useTranslations("projects");
  const sortedEnvs = [...environments].sort(sortEnvs);
  const [tab, setTab] = useState<MainTab>({ kind: "access" });
  const [envSubTab, setEnvSubTab] = useState<
    "secrets" | "tokens" | "compose"
  >("secrets");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Gestion des membres : reste OWNER-only (gestion d'acces).
  const canManageMembers = role === "OWNER";
  // Edition des parametres techniques (name, slug, github config) :
  // ouvert a EDITOR+. La suppression du projet reste OWNER cote backend.
  const canEditProjectSettings = ROLE_RANK[role] >= ROLE_RANK.EDITOR;
  const canManagePolicies = role === "OWNER" || hasDevPrivileges(orgRole);
  const canRedeploy = ROLE_RANK[role] >= ROLE_RANK.EDITOR;

  const activeEnvName = tab.kind === "env" ? tab.envName : null;
  const activeEnv = activeEnvName
    ? sortedEnvs.find((e) => e.name === activeEnvName)
    : null;

  return (
    <div>
      {/* Tab bar */}
      <div className="tab-bar" style={{ display: "flex", alignItems: "stretch" }}>
        {/* Left group */}
        <div style={{ flex: 1, display: "flex" }}>
          <button
            type="button"
            className={`tab ${tab.kind === "access" ? "active" : ""}`}
            onClick={() => setTab({ kind: "access" })}
          >
            {t("tabs.access")}
          </button>
          <button
            type="button"
            className={`tab ${tab.kind === "vault" ? "active" : ""}`}
            onClick={() => setTab({ kind: "vault" })}
          >
            🔒 {t("tabs.vault")}
          </button>
        </div>

        {/* Center group — env tabs */}
        <div style={{ display: "flex" }}>
          {sortedEnvs.map((env) => (
            <button
              key={env.id}
              type="button"
              className={`tab ${
                tab.kind === "env" && tab.envName === env.name ? "active" : ""
              }`}
              onClick={() => setTab({ kind: "env", envName: env.name })}
            >
              {envDisplay(env.name)}{" "}
              <span className="text-muted" style={{ fontSize: 11 }}>
                ({env.secretCount})
              </span>
            </button>
          ))}
        </div>

        {/* Right group */}
        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
          {canManageMembers && (
            <button
              type="button"
              className={`tab ${tab.kind === "members" ? "active" : ""}`}
              onClick={() => setTab({ kind: "members" })}
            >
              {t("tabs.members")}
            </button>
          )}
          <button
            type="button"
            className={`tab ${tab.kind === "policies" ? "active" : ""}`}
            onClick={() => setTab({ kind: "policies" })}
          >
            {t("tabs.policies")}
          </button>
          {canEditProjectSettings && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="tab"
              aria-label={t("settingsAriaLabel")}
              title={t("settingsTitle")}
              style={{ padding: "10px 14px" }}
            >
              <SettingsIcon />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {tab.kind === "access" ? (
        <InfosPanel
          slug={slug}
          role={role}
          environments={sortedEnvs}
          rotationFeatureEnabled={false}
        />
      ) : tab.kind === "vault" ? (
        <TeamVaultPanel
          scope={{ kind: "project", projectSlug: slug }}
          canCreate={canRedeploy}
          rotationFeatureEnabled={false}
        />
      ) : tab.kind === "policies" ? (
        <PoliciesPanel
          slug={slug}
          role={role}
          canManage={canManagePolicies}
          environments={sortedEnvs}
          defaultGithubRepo={githubRepo}
        />
      ) : tab.kind === "members" ? (
        canManageMembers ? (
          <MembersPanel slug={slug} />
        ) : null
      ) : activeEnv ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="subtab-bar">
              <button
                type="button"
                className={`subtab ${envSubTab === "secrets" ? "active" : ""}`}
                onClick={() => setEnvSubTab("secrets")}
              >
                Secrets
              </button>
              <button
                type="button"
                className={`subtab ${envSubTab === "compose" ? "active" : ""}`}
                onClick={() => setEnvSubTab("compose")}
              >
                {t("tabs.docker")}
              </button>
              <button
                type="button"
                className={`subtab ${envSubTab === "tokens" ? "active" : ""}`}
                onClick={() => setEnvSubTab("tokens")}
              >
                {t("tabs.tokens")}
              </button>
            </div>
            {canRedeploy && (
              <RedeployButton
                slug={slug}
                envName={activeEnv.name}
                githubRepo={githubRepo}
              />
            )}
          </div>

          {envSubTab === "secrets" && (
            <SecretsPanel
              slug={slug}
              env={activeEnv.name}
              role={role}
              rotationFeatureEnabled={false}
              orgSlug={orgSlug}
            />
          )}
          {envSubTab === "tokens" && (
            <TokensPanel slug={slug} env={activeEnv.name} role={role} />
          )}
          {envSubTab === "compose" && (
            <ComposePanel slug={slug} env={activeEnv.name} role={role} />
          )}
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-state-title">{t("noEnvTitle")}</div>
          <div>{t("noEnvHint")}</div>
        </div>
      )}

      {settingsOpen && canEditProjectSettings && (
        <SettingsDialog
          slug={slug}
          orgSlug={orgSlug}
          projectName={projectName}
          githubRepo={githubRepo}
          githubWorkflow={githubWorkflow}
          ciConnectionId={ciConnectionId}
          ciRepo={ciRepo}
          environments={sortedEnvs}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function RedeployButton({
  slug,
  envName,
  githubRepo,
}: {
  slug: string;
  envName: string;
  githubRepo: string | null;
}) {
  const t = useTranslations("projects");
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | null
  >(null);
  const disabled = !githubRepo;

  function handleConfirm() {
    setConfirm(false);
    setFeedback(null);
    startTransition(async () => {
      const res = await fetch(`/api/projects/${slug}/redeploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment: envName }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        ok?: boolean;
      } | null;
      if (!res.ok) {
        setFeedback({
          kind: "error",
          message: data?.error ?? t("redeploy.error"),
        });
        return;
      }
      setFeedback({ kind: "success", message: t("redeploy.success") });
      setTimeout(() => setFeedback(null), 4000);
    });
  }

  return (
    <>
      {confirm && (
        <div className="dialog-overlay">
          <div className="dialog">
            <div className="dialog-header">
              <h2 className="dialog-title">{t("redeploy.confirm", { name: envName })}</h2>
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="dialog-close"
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="btn btn-ghost btn-sm"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="btn btn-accent btn-sm"
              >
                {t("redeploy.triggerBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        {feedback && (
          <span
            className={
              feedback.kind === "success" ? "success-text" : "error-text"
            }
          >
            {feedback.message}
          </span>
        )}
        <button
          type="button"
          onClick={() => { setFeedback(null); setConfirm(true); }}
          disabled={disabled || pending}
          className="btn btn-accent btn-sm"
        >
          {pending ? t("redeploy.triggeringBtn") : t("redeploy.btn")}
        </button>
      </div>
    </>
  );
}

function SettingsIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
