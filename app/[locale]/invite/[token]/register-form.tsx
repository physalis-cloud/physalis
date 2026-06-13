"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useTranslations } from "next-intl";
import RateLimitAlert from "@/components/RateLimitAlert";

export default function InvitationRegisterForm({
  token,
  email,
  organizationName,
  organizationSlug,
  inviterEmail,
  role,
}: {
  token: string;
  email: string;
  organizationName: string;
  organizationSlug: string;
  inviterEmail: string;
  role: string;
}) {
  const t = useTranslations("invite");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setRateLimited(false);
    if (password !== confirm) {
      setError(t("passwordsMismatch"));
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/invitations/${token}/register-and-accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? t("createFailed"));
        return;
      }
      // Le compte est créé. Auto-signIn avec les credentials.
      let signed: Awaited<ReturnType<typeof signIn>> | null = null;
      try {
        signed = await signIn("credentials", {
          email,
          password,
          redirect: false,
        });
      } catch {
        // signIn() peut throw "Failed to construct URL" quand la response
        // n'est pas le JSON attendu (ex. 429 HTML).
        setRateLimited(true);
        return;
      }
      if (!signed || signed.error) {
        // Auto-signIn KO (rate limit, ou autre). Redirige vers le login.
        router.push("/login");
        return;
      }
      await fetch("/api/me/current-org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: organizationSlug }),
      });
      router.push(`/orgs/${organizationSlug}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="login-form">
      <div className="help" style={{ textAlign: "center" }}>
        {t.rich("invitationLine", {
          inviter: inviterEmail,
          organization: organizationName,
          role,
          strong: (c) => <strong>{c}</strong>,
          rolebadge: (c) => (
            <span className={`role role-${role.toLowerCase()}`}>{c}</span>
          ),
        })}
      </div>
      <div
        className="help code-mono"
        style={{
          textAlign: "center",
          padding: 8,
          background: "var(--code-bg)",
          borderRadius: 8,
        }}
      >
        {email}
      </div>

      <div className="field">
        <label>{t("passwordLabel")}</label>
        <input
          type="password"
          required
          minLength={12}
          autoFocus
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
        />
      </div>

      <div className="field">
        <label>{t("confirmPasswordLabel")}</label>
        <input
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="input"
        />
      </div>

      {rateLimited && <RateLimitAlert />}
      {!rateLimited && error && <p className="error-text">{error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="btn btn-primary"
        style={{ marginTop: 6, padding: "11px 16px", justifyContent: "center" }}
      >
        {pending ? t("creating") : t("createAndAccept")}
      </button>
    </form>
  );
}
