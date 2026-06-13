"use client";

import { useState, useTransition } from "react";
import { RiLockLine } from "@remixicon/react";
import { useTranslations } from "next-intl";
import { encryptForRecipient } from "@/lib/secret-request-crypto";

export default function RequestForm({
  token,
  label,
  description,
  requestedByEmail,
  publicKeyJwk,
  expiresAt,
}: {
  token: string;
  label: string;
  description: string | null;
  requestedByEmail: string;
  publicKeyJwk: string;
  expiresAt: string;
}) {
  const t = useTranslations("secretRequest");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!secret || secret.length === 0) {
      setError(t("errors.emptySecret"));
      return;
    }
    if (secret.length > 50_000) {
      setError(t("errors.tooLong"));
      return;
    }
    startTransition(async () => {
      try {
        // Chiffrement local — le secret ne sort jamais du navigateur en clair.
        const payload = await encryptForRecipient(secret, publicKeyJwk);
        const res = await fetch(`/api/public/secret-requests/${token}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          if (res.status === 410) {
            setError(t("errors.linkGone"));
          } else if (res.status === 429) {
            setError(t("errors.rateLimit"));
          } else {
            setError(t("errors.generic"));
          }
          return;
        }
        // Vide le champ dès succès, par précaution.
        setSecret("");
        setSubmitted(true);
      } catch (err) {
        console.error(err);
        setError(t("errors.encryptFailed"));
      }
    });
  }

  if (submitted) {
    return (
      <div className="login-form" style={{ gap: 12, textAlign: "center" }}>
        <div style={{ fontSize: 32 }}>✅</div>
        <p className="help">
          {t.rich("successMessage", {
            email: requestedByEmail,
            strong: (c) => <strong>{c}</strong>,
          })}
        </p>
        <p className="help" style={{ fontSize: 13 }}>
          {t("successNote")}
        </p>
      </div>
    );
  }

  const expires = new Date(expiresAt).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
  });

  return (
    <form onSubmit={onSubmit} className="login-form">
      <p className="help" style={{ textAlign: "center" }}>
        {t.rich("askLine", {
          email: requestedByEmail,
          strong: (c) => <strong>{c}</strong>,
        })}
      </p>
      <div
        style={{
          padding: "10px 14px",
          background: "var(--code-bg)",
          borderRadius: 8,
          textAlign: "center",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      {description && (
        <p
          className="help"
          style={{
            textAlign: "center",
            fontSize: 13,
            whiteSpace: "pre-wrap",
          }}
        >
          {description}
        </p>
      )}

      <div className="field">
        <label>{t("secretLabel")}</label>
        <textarea
          required
          autoFocus
          rows={3}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          className="input"
          style={{ fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
          placeholder="sk_live_…"
        />
      </div>

      {error && <p className="error-text">{error}</p>}

      <button
        type="submit"
        disabled={pending || !secret}
        className="btn btn-primary"
        style={{ marginTop: 6, padding: "11px 16px", justifyContent: "center" }}
      >
        {pending ? (
          t("sending")
        ) : (
          <>
            <RiLockLine size={14} aria-hidden /> {t("sendSecurely")}
          </>
        )}
      </button>

      <p
        className="help"
        style={{ textAlign: "center", fontSize: 12, marginTop: 6 }}
      >
        {t("encryptionNotice")}
        <br />
        {t("expiresOn", { date: expires })}
      </p>
    </form>
  );
}
