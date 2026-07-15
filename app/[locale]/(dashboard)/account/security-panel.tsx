"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";

type SetupData = {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
};

type Step = "idle" | "setup" | "backup-codes" | "disable";

export default function SecurityPanel({
  initialEnabled,
  initialBackupCount,
}: {
  initialEnabled: boolean;
  initialBackupCount: number;
}) {
  const t = useTranslations("settings.security.twoFactor");
  const [enabled, setEnabled] = useState(initialEnabled);
  const [backupCount, setBackupCount] = useState(initialBackupCount);
  const [step, setStep] = useState<Step>("idle");
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  function reset() {
    setStep("idle");
    setSetupData(null);
    setCode("");
    setError(null);
    setBackupCodes(null);
  }

  function startSetup() {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/me/2fa/setup", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("setupError"));
        return;
      }
      setSetupData((await res.json()) as SetupData);
      setStep("setup");
    });
  }

  function verifySetup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/me/2fa/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("codeInvalid"));
        return;
      }
      const data = (await res.json()) as { backupCodes: string[] };
      setBackupCodes(data.backupCodes);
      setBackupCount(data.backupCodes.length);
      setEnabled(true);
      setSetupData(null);
      setCode("");
      setStep("backup-codes");
    });
  }

  function disable(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/me/2fa", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("disableError"));
        return;
      }
      setEnabled(false);
      setBackupCount(0);
      reset();
    });
  }

  function copyAll() {
    if (!backupCodes) return;
    navigator.clipboard.writeText(backupCodes.join("\n")).catch(() => {
      // ignore
    });
  }

  if (step === "backup-codes" && backupCodes) {
    return (
      <section className="settings-block">
        <h2 className="settings-block-title">{t("backupCodesTitle")}</h2>
        <div
          className="settings-block-card"
          style={{ background: "var(--accent-bg)", borderColor: "var(--accent-soft)" }}
        >
        <p className="settings-section-desc">
          {t.rich("backupCodesHint", { strong: (c) => <strong>{c}</strong> })}
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 8,
            marginTop: 4,
          }}
        >
          {backupCodes.map((c) => (
            <div
              key={c}
              className="code-mono"
              style={{
                padding: "8px 12px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 14,
              }}
            >
              {c}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2" style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={copyAll}
            className="btn btn-primary btn-sm"
          >
            {t("backupCodesCopy")}
          </button>
          <button
            type="button"
            onClick={reset}
            className="btn btn-ghost btn-sm"
          >
            {t("backupCodesSaved")}
          </button>
        </div>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-block">
      <h2 className="settings-block-title">{t("title")}</h2>
      <div className="settings-block-card flex flex-col gap-3">
        {/* État + action principale (alignée à droite) */}
        {step === "idle" && (
          <div className="settings-block-row">
            <p className="help" style={{ margin: 0 }}>
              {enabled ? t("enabled", { count: backupCount }) : t("disabled")}
            </p>
            {enabled ? (
              <button
                type="button"
                onClick={() => setStep("disable")}
                className="btn btn-danger btn-sm"
              >
                {t("disableBtn")}
              </button>
            ) : (
              <button
                type="button"
                onClick={startSetup}
                disabled={pending}
                className="btn btn-primary btn-sm"
              >
                {pending ? "..." : t("enableBtn")}
              </button>
            )}
          </div>
        )}

      {!enabled && step === "setup" && setupData && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-sm" style={{ fontWeight: 500 }}>
              {t("step1")}
            </p>
            <div
              style={{
                display: "inline-block",
                marginTop: 8,
                padding: 8,
                background: "#fff",
                border: "1px solid var(--border)",
                borderRadius: 10,
              }}
            >
              <Image
                src={setupData.qrDataUrl}
                alt={t("qrCodeAlt")}
                width={200}
                height={200}
                unoptimized
              />
            </div>
            <p className="help" style={{ marginTop: 8 }}>
              {t("manualSecret")}{" "}
              <code className="code-mono select-all">{setupData.secret}</code>
            </p>
          </div>
          <form onSubmit={verifySetup} className="flex flex-col gap-2">
            <label className="text-sm">
              {t("step2")}
            </label>
            <div className="flex items-center gap-2">
              <input
                required
                autoFocus
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                placeholder="123456"
                className="input input-mono"
                style={{ width: 140 }}
              />
              <button
                type="submit"
                disabled={pending || code.length !== 6}
                className="btn btn-primary btn-sm"
              >
                {pending ? "..." : t("confirmBtn")}
              </button>
              <button
                type="button"
                onClick={reset}
                className="btn btn-ghost btn-sm"
              >
                {t("cancelBtn")}
              </button>
            </div>
            {error && <p className="error-text">{error}</p>}
          </form>
        </div>
      )}

      {enabled && step === "disable" && (
        <form onSubmit={disable} className="flex flex-col gap-2">
          <p className="text-sm">
            {t("disablePrompt")}
          </p>
          <div className="flex items-center gap-2">
            <input
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="input input-mono"
              style={{ maxWidth: 260 }}
            />
            <button
              type="submit"
              disabled={pending || !code}
              className="btn btn-danger btn-sm"
            >
              {pending ? "..." : t("disableBtn")}
            </button>
            <button
              type="button"
              onClick={reset}
              className="btn btn-ghost btn-sm"
            >
              {t("cancelBtn")}
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}
        </form>
      )}
      </div>
    </section>
  );
}
