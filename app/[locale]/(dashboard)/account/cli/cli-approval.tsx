"use client";

// Approbation d'une connexion `physalis login` — C-0050, phase 2.
//
// On montre la demande (appareil, IP, heure) AVANT les boutons : le flux
// d'appareil a un seul point faible, l'hameçonnage (« clique ce lien et
// approuve »). L'utilisateur doit reconnaître SA demande, et l'avertissement
// le lui dit.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type Device = {
  userCode: string;
  kind: "HUMAN" | "AI";
  deviceName: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
};

type State =
  | { step: "idle" }
  | { step: "loading" }
  | { step: "invalid" }
  | { step: "notFound" }
  | { step: "found"; device: Device; selectable: Selectable[] }
  | { step: "done"; approved: boolean }
  | { step: "error" };

type Selectable = { slug: string; name: string; environments: string[] };

const CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

export default function CliApproval({ initialCode }: { initialCode: string }) {
  const t = useTranslations("cliDevice");
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [state, setState] = useState<State>({ step: "idle" });
  const [pending, setPending] = useState(false);
  // Session « agent IA » : couples cochés, clé `projet/environnement`.
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const lookup = useCallback(async (value: string) => {
    const normalized = value.toUpperCase().replace(/[^A-Z]/g, "");
    if (!CODE_RE.test(normalized)) {
      setState({ step: "invalid" });
      return;
    }
    setState({ step: "loading" });
    const res = await fetch(`/api/cli/device?code=${encodeURIComponent(normalized)}`);
    if (res.status === 404) return setState({ step: "notFound" });
    if (res.status === 400) return setState({ step: "invalid" });
    if (!res.ok) return setState({ step: "error" });
    const data = (await res.json()) as { device: Device; selectable?: Selectable[] };
    setPicked(new Set());
    setState({ step: "found", device: data.device, selectable: data.selectable ?? [] });
  }, []);

  useEffect(() => {
    if (initialCode) lookup(initialCode);
  }, [initialCode, lookup]);

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Les cases cochées, regroupées par projet, au format attendu par l'API. */
  function scopeOf(selected: Set<string>) {
    const byProject = new Map<string, string[]>();
    for (const key of selected) {
      const [project, env] = key.split("/");
      byProject.set(project!, [...(byProject.get(project!) ?? []), env!]);
    }
    return [...byProject].map(([project, environments]) => ({ project, environments }));
  }

  async function decide(device: Device, approve: boolean) {
    setPending(true);
    try {
      const res = await fetch("/api/cli/device/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: device.userCode,
          approve,
          ...(approve && device.kind === "AI" ? { scope: scopeOf(picked) } : {}),
        }),
      });
      if (res.status === 404) return setState({ step: "notFound" });
      if (!res.ok) return setState({ step: "error" });
      setState({ step: "done", approved: approve });
    } finally {
      setPending(false);
    }
  }

  if (state.step === "done") {
    return (
      <div className="card" style={{ padding: 20 }}>
        <p>{state.approved ? t("approved") : t("denied")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" style={{ maxWidth: 560 }}>
      <form
        className="card"
        style={{ padding: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          lookup(code);
        }}
      >
        <div className="form-row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="cli-code">{t("codeLabel")}</label>
            <input
              id="cli-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="BCDF-GHJK"
              className="input code-mono"
              autoComplete="off"
              spellCheck={false}
              autoFocus={!initialCode}
            />
          </div>
          <button type="submit" className="btn" disabled={state.step === "loading"}>
            {state.step === "loading" ? t("loading") : t("lookupBtn")}
          </button>
        </div>
        {state.step === "invalid" && <p className="error-text">{t("invalidCode")}</p>}
        {state.step === "notFound" && <p className="error-text">{t("notFound")}</p>}
        {state.step === "error" && <p className="error-text">{t("error")}</p>}
      </form>

      {state.step === "found" && (
        <div className="card" style={{ padding: 20 }}>
          {state.device.kind === "AI" && (
            <div className="info-box" style={{ marginBottom: 12 }}>
              <strong>{t("aiTitle")}</strong> {t("aiIntro")}
            </div>
          )}
          <div className="info-box danger" style={{ marginBottom: 16 }}>
            {t("warning")}
          </div>
          <dl className="flex flex-col gap-2" style={{ margin: 0 }}>
            <div className="flex gap-2">
              <dt className="help" style={{ minWidth: 140 }}>{t("device")}</dt>
              <dd className="code-mono" style={{ margin: 0 }}>{state.device.deviceName ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="help" style={{ minWidth: 140 }}>{t("ip")}</dt>
              <dd className="code-mono" style={{ margin: 0 }}>{state.device.ip ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="help" style={{ minWidth: 140 }}>{t("requestedAt")}</dt>
              <dd style={{ margin: 0 }}>{new Date(state.device.createdAt).toLocaleString()}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="help" style={{ minWidth: 140 }}>{t("expiresAt")}</dt>
              <dd style={{ margin: 0 }}>{new Date(state.device.expiresAt).toLocaleString()}</dd>
            </div>
          </dl>
          {state.device.kind === "AI" ? (
            <fieldset style={{ marginTop: 16, border: 0, padding: 0 }}>
              <legend className="help" style={{ marginBottom: 8 }}>{t("aiScopeLegend")}</legend>
              {state.selectable.length === 0 ? (
                <p className="help">{t("aiNothingSelectable")}</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {state.selectable.map((p) => (
                    <div key={p.slug}>
                      <div style={{ fontWeight: 500 }}>{p.name}</div>
                      <div className="flex gap-3 flex-wrap">
                        {p.environments.map((env) => {
                          const key = `${p.slug}/${env}`;
                          return (
                            <label key={key} className="flex items-center gap-1 code-mono" style={{ fontSize: 13 }}>
                              <input
                                type="checkbox"
                                checked={picked.has(key)}
                                onChange={() => toggle(key)}
                              />
                              {env}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="help" style={{ marginTop: 12 }}>{t("aiGrants")}</p>
            </fieldset>
          ) : (
            <p className="help" style={{ marginTop: 16 }}>{t("grants")}</p>
          )}
          <div className="flex gap-2" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || (state.device.kind === "AI" && picked.size === 0)}
              onClick={() => decide(state.device, true)}
            >
              {t("approveBtn")}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={pending}
              onClick={() => decide(state.device, false)}
            >
              {t("denyBtn")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
