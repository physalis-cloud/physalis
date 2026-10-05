"use client";

// Onglet « Installation » (C-0051, Phase 4) — guide pas à pas jusqu'au premier
// déploiement réussi. Cf. documentation/plans/guide-installation-projet.md §4.
//
// Rien n'est coché à la main : chaque étape reflète l'état réel du projet,
// recalculé côté serveur (lib/project-setup.ts) à chaque lecture.

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { SetupState, SetupStep, SetupStepId } from "@/lib/project-setup";
import type { CheckStatus, VerifyResult } from "@/lib/project-verify";

const POLL_MS = 30_000;

/** Modèles publiés dans le dépôt public (cf. scripts/build-public.mjs). */
const TEMPLATE_BASE = "https://github.com/physalis-cloud/physalis/blob/main/docs";
const TEMPLATES: Record<string, { file: string; path: string }[]> = {
  github: [
    { file: "deploy.modele.yml", path: ".github/workflows/deploy.yml" },
    { file: "redeploy.modele.yml", path: ".github/workflows/redeploy.yml" },
  ],
  gitlab: [{ file: "deploy.gitlab-ci.modele.yml", path: ".gitlab-ci.yml" }],
  bitbucket: [
    { file: "deploy.bitbucket-pipelines.modele.yml", path: "bitbucket-pipelines.yml" },
  ],
};

export type SetupNav = {
  openSettings: () => void;
  openPolicies: () => void;
  openEnv: (env: string, sub?: "secrets" | "deployments") => void;
};

export default function SetupPanel({
  slug,
  orgSlug,
  canEdit,
  nav,
  onHidden,
}: {
  slug: string;
  orgSlug: string;
  canEdit: boolean;
  nav: SetupNav;
  /** Appelé quand l'utilisateur masque le guide : l'onglet disparaît. */
  onHidden: () => void;
}) {
  const t = useTranslations("projects.setup");
  const locale = useLocale();
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  /** Étape choisie dans la barre (null = la première à faire). */
  const [opened, setOpened] = useState<SetupStepId | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${slug}/setup`);
      if (!res.ok) throw new Error(String(res.status));
      setState((await res.json()) as SetupState);
      setError(null);
    } catch {
      setError(t("loadError"));
    }
  }, [slug, t]);

  useEffect(() => {
    load();
  }, [load]);

  // On rafraîchit tant que le guide attend un événement venu du pipeline
  // (premier appel, premier rapport) : c'est là que l'utilisateur regarde
  // l'écran en attendant son run.
  const policyDone = state?.steps.find((s) => s.id === "policy")?.status === "done";
  const waiting = !!state && !state.completedAt && policyDone;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, load]);

  async function hide() {
    setHiding(true);
    const res = await fetch(`/api/projects/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupGuide: "hidden" }),
    });
    setHiding(false);
    if (res.ok) onHidden();
    else setError(t("hideError"));
  }

  if (error) return <p className="error-text">{error}</p>;
  if (!state) return <p className="help">{t("loading")}</p>;

  const doneCount = state.steps.filter((s) => s.status === "done").length;
  const current = state.steps.find((s) => s.status === "todo")?.id ?? null;
  // Une seule étape affichée : celle choisie dans la barre, sinon la première
  // à faire, sinon la dernière (tout est fait).
  const selected: SetupStepId = opened ?? current ?? state.steps[state.steps.length - 1].id;
  const selectedIndex = state.steps.findIndex((s) => s.id === selected);
  const selectedStep = state.steps[selectedIndex];
  const provider = state.provider in TEMPLATES ? state.provider : "github";

  return (
    <div className="flex flex-col gap-4">
      <div className="section-header">
        <h2 className="section-title">{t("title")}</h2>
        <span className="help">
          {t("progress", { done: doneCount, total: state.steps.length })}
        </span>
      </div>

      {/* Barre d'étapes : les bulles posées sur une ligne, un libellé court sous
          chacune. La ligne se colore jusqu'à l'étape sélectionnée. Un clic
          affiche l'étape — une seule à la fois. */}
      <nav aria-label={t("trailLabel")} className="setup-trail">
        <div className="setup-trail-line" aria-hidden>
          <div
            className="setup-trail-line-fill"
            style={{
              width: `${(selectedIndex / Math.max(state.steps.length - 1, 1)) * 100}%`,
            }}
          />
        </div>
        <ol>
          {state.steps.map((step, i) => (
            <li key={step.id}>
              <button
                type="button"
                className={`setup-trail-step is-${step.status}${
                  step.id === selected ? " is-selected" : ""
                }${step.id === current ? " is-current" : ""}`}
                aria-current={step.id === selected ? "step" : undefined}
                title={`${i + 1}. ${t(`steps.${step.id}.title`)} — ${t(`status.${step.status}`)}`}
                onClick={() => setOpened(step.id)}
              >
                <span className="setup-trail-bubble" aria-hidden>
                  {step.status === "done" ? "✓" : i + 1}
                </span>
                <span className="setup-trail-label">{t(`steps.${step.id}.short`)}</span>
                <span className="sr-only">
                  {t(`steps.${step.id}.title`)} — {t(`status.${step.status}`)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {state.completedAt ? (
        <div className="card" style={{ borderLeft: "3px solid var(--success)" }}>
          <strong>{t("completedTitle")}</strong>
          <p className="help" style={{ margin: "4px 0 0" }}>
            {t("completedText", {
              date: new Date(state.completedAt).toLocaleDateString(locale),
            })}
          </p>
        </div>
      ) : verifyResult ? (
        // La vérification a classé le projet (setupLegacy retiré côté serveur) :
        // le bandeau d'entrée disparaît, son résultat reste lisible jusqu'au
        // prochain chargement de la page. Rien à relancer.
        <div className="card" style={{ borderLeft: "3px solid var(--accent)" }}>
          <VerifyResultView result={verifyResult} />
        </div>
      ) : state.legacy ? (
        <div className="card" style={{ borderLeft: "3px solid var(--accent)" }}>
          <strong>{t("legacyTitle")}</strong>
          <p className="help" style={{ margin: "4px 0 0" }}>
            {t("legacyText")}
          </p>
          {canEdit && (
            <LegacyVerify
              slug={slug}
              onResult={(r) => {
                setVerifyResult(r);
                load();
              }}
            />
          )}
        </div>
      ) : (
        <p className="help" style={{ margin: 0 }}>
          {t("intro")}
        </p>
      )}

      {/* Retour utilisateur du 2026-10-03 : le guide n'a pas encore été validé par
          de vrais déploiements (Phase 2) — on le dit. */}
      <div
        role="note"
        className="card"
        style={{ borderLeft: "3px solid var(--danger)", background: "var(--danger-bg)" }}
      >
        <strong style={{ color: "var(--danger-fg)" }}>{t("previewTitle")}</strong>
        <p className="help" style={{ margin: "4px 0 0" }}>
          {t("previewText")}
        </p>
      </div>

      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        <StepCard
          key={selectedStep.id}
          slug={slug}
          index={selectedIndex + 1}
          step={selectedStep}
          current={selectedStep.id === current}
          opened
          reload={load}
          state={state}
          provider={provider}
          orgSlug={orgSlug}
          canEdit={canEdit}
          nav={nav}
        />
      </ol>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={selectedIndex === 0}
          onClick={() => setOpened(state.steps[selectedIndex - 1].id)}
        >
          ← {t("prevStep")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={selectedIndex === state.steps.length - 1}
          onClick={() => setOpened(state.steps[selectedIndex + 1].id)}
        >
          {t("nextStep")} →
        </button>
      </div>

      {canEdit && !state.completedAt && (
        <p className="help" style={{ margin: 0 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={hide}
            disabled={hiding}
          >
            {t("hide")}
          </button>{" "}
          {t("hideHint")}
        </p>
      )}
    </div>
  );
}

const STATUS_MARK: Record<SetupStep["status"], string> = {
  done: "✓",
  todo: "•",
  optional: "○",
  manual: "?",
};

function StepCard({
  slug,
  index,
  step,
  current,
  opened,
  reload,
  state,
  provider,
  orgSlug,
  canEdit,
  nav,
}: {
  slug: string;
  index: number;
  step: SetupStep;
  current: boolean;
  opened: boolean;
  reload: () => void;
  state: SetupState;
  provider: string;
  orgSlug: string;
  canEdit: boolean;
  nav: SetupNav;
}) {
  const t = useTranslations("projects.setup");
  const done = step.status === "done";
  const expanded = !done || current || opened;
  const firstEnv = state.deployableEnvs[0] ?? null;

  return (
    <li
      id={`setup-step-${step.id}`}
      className="card"
      aria-current={current ? "step" : undefined}
      style={{
        opacity: done && !current && !opened ? 0.75 : 1,
        borderLeft: `3px solid ${
          done ? "var(--success)" : current ? "var(--accent)" : "var(--border)"
        }`,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <span
          aria-hidden
          className="code-mono"
          style={{ minWidth: 18, color: done ? "var(--success)" : "var(--muted)" }}
        >
          {STATUS_MARK[step.status]}
        </span>
        <div style={{ flex: 1 }}>
          <strong>
            {index}. {t(`steps.${step.id}.title`)}
          </strong>
          <span className="text-muted" style={{ fontSize: 11, marginLeft: 8 }}>
            {t(`status.${step.status}`)}
          </span>
          {/* Le détail n'est déroulé que pour l'étape en cours et les étapes
              non faites : une liste de 8 explications complètes noierait
              celle qui compte. */}
          {expanded && (
            <div className="help" style={{ marginTop: 4 }}>
              <StepBody id={step.id} state={state} provider={provider} />
              {step.id === "repo" && canEdit ? (
                <RepoCheck slug={slug} state={state} reload={reload} />
              ) : null}
              {step.id === "workflow" && state.policies.length > 0 ? (
                <WorkflowTemplates slug={slug} state={state} provider={provider} />
              ) : null}
              {canEdit ? (
                <StepActions
                  id={step.id}
                  orgSlug={orgSlug}
                  nav={nav}
                  firstEnv={firstEnv}
                  provider={provider}
                  hasPolicy={state.policies.length > 0}
                />
              ) : (
                <p style={{ margin: "6px 0 0" }}>{t("askEditor")}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function StepBody({
  id,
  state,
  provider,
}: {
  id: SetupStepId;
  state: SetupState;
  provider: string;
}) {
  const t = useTranslations("projects.setup");
  const locale = useLocale();
  const text = <p style={{ margin: 0 }}>{t(`steps.${id}.text.${provider}` as never)}</p>;

  if (id === "policy" || id === "workflow" || id === "firstCall") {
    return (
      <>
        {text}
        {state.policies.length > 0 && (
          <table className="table" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>{t("policyRepo")}</th>
                <th>{t(`policyKey.${provider}` as never)}</th>
                <th>{t("policyBranch")}</th>
                <th>{t("policyEnv")}</th>
                {id === "workflow" && <th>{t("policyFile")}</th>}
                {id === "workflow" && <th>{t("policyReport")}</th>}
                {id === "firstCall" && <th>{t("lastRun")}</th>}
              </tr>
            </thead>
            <tbody>
              {state.policies.map((p) => (
                <tr key={`${p.workflow}-${p.branch}-${p.environment}`}>
                  <td className="code-mono">{state.repo ?? "—"}</td>
                  <td className="code-mono">{p.workflow || "—"}</td>
                  <td className="code-mono">{p.branch}</td>
                  <td className="code-mono">{p.environment}</td>
                  {id === "workflow" && (
                    <td>{t(`fileStatus.${p.file?.status ?? "unreadable"}`)}</td>
                  )}
                  {id === "firstCall" && (
                    <td>
                      {t(`runState.${p.lastRun?.state ?? "unknown"}`)}
                      {p.lastRun?.at && (
                        <span className="text-muted">
                          {" "}
                          · {new Date(p.lastRun.at).toLocaleString(locale)}
                        </span>
                      )}
                      {p.lastRun?.url && (
                        <>
                          {" "}
                          <a href={p.lastRun.url} target="_blank" rel="noopener noreferrer">
                            {t("openRun")}
                          </a>
                        </>
                      )}
                    </td>
                  )}
                  {id === "workflow" && (
                    <td>
                      {p.file?.hasReport == null
                        ? "—"
                        : p.file.hasReport
                          ? t("reportYes")
                          : t("reportNo")}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {id === "firstCall" &&
          // Un run terminé chez la plateforme sans qu'aucun appel n'ait atteint
          // ce projet : refusé avant la policy, ou échoué avant d'appeler Physalis.
          (state.policies.some((p) => p.lastRun?.state === "failure") ? (
            <p style={{ margin: "6px 0 0" }}>
              <strong>{t("runFailedNoCall")}</strong> {t("firstCallDenied")}
            </p>
          ) : (
            <p style={{ margin: "6px 0 0" }}>{t("firstCallDenied")}</p>
          ))}
      </>
    );
  }

  if (id === "firstSuccess" && state.lastDeployment) {
    const s = state.lastDeployment.status;
    // Workflows lus dans le dépôt (étape 6) qui n'envoient PAS de rapport : un
    // déploiement lancé par eux restera « en cours » puis « expiré ». C'est la
    // cause la plus fréquente d'une attente sans fin — on la nomme.
    // … et seulement si Physalis ne peut PAS lire l'issue du run lui-même
    // (connexion sans jeton) : sinon, il la constate sans rapport.
    const noReport = state.policies
      .filter((p) => p.file?.hasReport === false && p.lastRun?.state === "unknown")
      .map((p) => p.workflow || p.environment);
    return (
      <>
        {text}
        <p style={{ margin: "6px 0 0" }}>
          {s === "failed"
            ? t("lastFailed", { env: state.lastDeployment.environment })
            : s === "requested"
              ? noReport.length > 0
                ? t("lastWaitingNoReport", {
                    env: state.lastDeployment.environment,
                    workflows: [...new Set(noReport)].join(", "),
                  })
                : t("lastWaiting", { env: state.lastDeployment.environment })
              : null}
        </p>
      </>
    );
  }

  return text;
}

function StepActions({
  id,
  orgSlug,
  nav,
  firstEnv,
  provider,
  hasPolicy,
}: {
  id: SetupStepId;
  orgSlug: string;
  nav: SetupNav;
  firstEnv: string | null;
  provider: string;
  hasPolicy: boolean;
}) {
  const t = useTranslations("projects.setup");
  const row = (children: React.ReactNode) => (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>{children}</div>
  );
  const settings = (
    <button type="button" className="btn btn-ghost btn-sm" onClick={nav.openSettings}>
      {t("actions.settings")}
    </button>
  );

  switch (id) {
    case "connection":
      return row(
        <>
          <Link href={`/orgs/${orgSlug}?tab=cicd`} className="btn btn-ghost btn-sm">
            {t("actions.createConnection")}
          </Link>
          {settings}
        </>,
      );
    case "repo":
      return row(settings);
    case "server":
      return row(
        <>
          <Link href={`/orgs/${orgSlug}?tab=servers`} className="btn btn-ghost btn-sm">
            {t("actions.createServer")}
          </Link>
          {settings}
        </>,
      );
    case "secrets":
      return firstEnv
        ? row(
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => nav.openEnv(firstEnv, "secrets")}
            >
              {t("actions.secrets", { env: firstEnv })}
            </button>,
          )
        : null;
    case "policy":
      return row(
        <button type="button" className="btn btn-ghost btn-sm" onClick={nav.openPolicies}>
          {t("actions.policies")}
        </button>,
      );
    case "workflow":
      // Avec une policy, les modèles PRÉ-REMPLIS sont proposés au-dessus ; les
      // modèles bruts ne servent que tant qu'il n'y en a aucune.
      if (hasPolicy) return null;
      return row(
        <>
          {(TEMPLATES[provider] ?? TEMPLATES.github).map((tpl) => (
            <a
              key={tpl.file}
              href={`${TEMPLATE_BASE}/${tpl.file}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
            >
              {t("actions.template", { path: tpl.path })}
            </a>
          ))}
        </>,
      );
    case "firstCall":
    case "firstSuccess":
      return firstEnv
        ? row(
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => nav.openEnv(firstEnv, "deployments")}
            >
              {t("actions.deployments", { env: firstEnv })}
            </button>,
          )
        : null;
    default:
      return null;
  }
}

/** Un modèle par policy. GitHub : le nom du fichier de la policy EST le nom du
 *  workflow, donc une policy `redeploy.yml` appelle le modèle de redéploiement
 *  et toute autre celui de déploiement. */
function templateFor(provider: string, workflow: string): string | null {
  if (provider === "github") return /redeploy/i.test(workflow) ? "redeploy" : "deploy";
  if (provider === "gitlab" || provider === "bitbucket") return provider;
  return null;
}

/** Modèle pré-rempli pour une policy du projet (Phase 5). */
function WorkflowTemplates({
  slug,
  state,
  provider,
}: {
  slug: string;
  state: SetupState;
  provider: string;
}) {
  const t = useTranslations("projects.setup");
  const [open, setOpen] = useState<{ key: string; content: string; path: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function show(policyId: string, template: string) {
    setError(null);
    setCopied(false);
    const key = `${policyId}:${template}`;
    if (open?.key === key) return setOpen(null);
    const res = await fetch(
      `/api/projects/${slug}/setup/template?policy=${encodeURIComponent(policyId)}&template=${template}`,
    );
    if (!res.ok) {
      setOpen(null);
      setError(t("templateError"));
      return;
    }
    const data = (await res.json()) as { content: string; path: string };
    setOpen({ key, ...data });
  }

  async function copy() {
    if (!open) return;
    try {
      await navigator.clipboard.writeText(open.content);
      setCopied(true);
    } catch {
      setError(t("copyError"));
    }
  }

  function download() {
    if (!open) return;
    const blob = new Blob([open.content], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = open.path.split("/").pop() ?? "workflow.yml";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div style={{ marginTop: 6 }}>
      <p style={{ margin: "0 0 4px" }}>{t("templateIntro")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {state.policies.map((p) => {
            const tpl = templateFor(provider, p.workflow);
            if (!tpl) return null;
            const key = `${p.id}:${tpl}`;
            return (
              <button
                key={key}
                type="button"
                className={`btn btn-sm ${open?.key === key ? "btn-primary" : "btn-ghost"}`}
                onClick={() => show(p.id, tpl)}
              >
                {t(`templateName.${tpl}` as never)} · {p.environment}
                {provider === "github" ? ` (${p.workflow})` : ""}
              </button>
            );
          })}
      </div>
      {error && <p className="error-text">{error}</p>}
      {open && (
        <div style={{ marginTop: 8 }}>
          <p style={{ margin: "0 0 4px" }}>
            {t("templatePath")} <span className="code-mono">{open.path}</span>
          </p>
          <textarea
            readOnly
            value={open.content}
            spellCheck={false}
            className="textarea textarea-mono"
            style={{ minHeight: 280, background: "var(--code-bg)", width: "100%" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={copy}>
              {copied ? t("copied") : t("copy")}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={download}>
              {t("download")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const CHECK_MARK: Record<CheckStatus, string> = { ok: "✓", ko: "✗", unknown: "?" };

/** Vérification d'un projet antérieur au guide (Phase 4 bis, plan §4.6).
 *  Un seul lancement : elle retire le marqueur « antérieur » du projet, qui suit
 *  ensuite le guide normal. */
function LegacyVerify({
  slug,
  onResult,
}: {
  slug: string;
  onResult: (r: VerifyResult) => void;
}) {
  const t = useTranslations("projects.setup.verify");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/setup/verify`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      onResult((await res.json()) as VerifyResult);
    } catch {
      setError(t("error"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" className="btn btn-primary btn-sm" onClick={run} disabled={running}>
        {running ? t("running") : t("run")}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function VerifyResultView({ result }: { result: VerifyResult }) {
  const t = useTranslations("projects.setup.verify");
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale) : "—");
  const unreadable = result.checks.reportStep === "unknown";

  return (
    <div>
      <strong>{t("resultTitle")}</strong>
      <p style={{ margin: "4px 0 6px" }}>
        {t(`outcome.${result.outcome}`, {
          date: fmt(result.lastAuthorizedAt),
          since: fmt(result.auditSince),
        })}
      </p>
      <ul className="help" style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
        {(["config", "deployed", "workflowFile", "reportStep"] as const).map((k) => (
          <li key={k}>
            <span className="code-mono" aria-hidden>
              {CHECK_MARK[result.checks[k]]}
            </span>{" "}
            {t(`check.${k}`, {
              path: result.file?.path ?? "—",
              branch: result.file?.branch ?? "—",
              date: fmt(result.lastAuthorizedAt),
              since: fmt(result.auditSince),
            })}{" "}
            <span className="text-muted">({t(`status.${result.checks[k]}`)})</span>
          </li>
        ))}
      </ul>
      {result.snippet && (
        <div style={{ marginTop: 8 }}>
          <p className="help" style={{ margin: "0 0 4px" }}>
            {unreadable ? t("snippetUnreadable") : t("snippetIntro")}
          </p>
          <textarea
            readOnly
            value={result.snippet}
            spellCheck={false}
            className="textarea textarea-mono"
            style={{ minHeight: 200, background: "var(--code-bg)", width: "100%" }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginTop: 6 }}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(result.snippet ?? "");
                setCopied(true);
              } catch {
                setError(t("error"));
              }
            }}
          >
            {copied ? t("copied") : t("copy")}
          </button>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Étape « dépôt » : dépôt introuvable, ou dépôt par défaut à adopter en un clic. */
function RepoCheck({
  slug,
  state,
  reload,
}: {
  slug: string;
  state: SetupState;
  reload: () => void;
}) {
  const t = useTranslations("projects.setup.repo");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.repo && state.repoExists === "no") {
    return <p style={{ margin: "6px 0 0" }}>{t("notFound", { repo: state.repo })}</p>;
  }
  const d = state.defaultRepo;
  if (!d) return null;
  if (d.exists === "no") {
    return <p style={{ margin: "6px 0 0" }}>{t("defaultNotFound", { repo: d.repo })}</p>;
  }

  async function adopt() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/projects/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubRepo: d!.repo }),
    });
    setSaving(false);
    if (res.ok) reload();
    else setError(t("saveError"));
  }

  return (
    <div style={{ marginTop: 6 }}>
      <p style={{ margin: "0 0 4px" }}>
        {d.exists === "yes" ? t("defaultFound", { repo: d.repo }) : t("defaultUnverified", { repo: d.repo })}
      </p>
      <button type="button" className="btn btn-primary btn-sm" onClick={adopt} disabled={saving}>
        {t("useDefault", { repo: d.repo })}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
