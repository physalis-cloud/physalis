"use client";

import { useActionState, useState } from "react";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { requestPasswordReset, type ForgotResult } from "./actions";

export default function ForgotForm() {
  const t = useTranslations("auth.forgotPassword");
  const tCommon = useTranslations("auth.common");
  const [state, action, pending] = useActionState<
    ForgotResult | null,
    FormData
  >(requestPasswordReset, null);
  const [email, setEmail] = useState("");

  if (state?.ok) {
    return (
      <div className="login-form" style={{ gap: 12 }}>
        <p className="help" style={{ textAlign: "center" }}>
          {t("successMessage")}
        </p>
        <p className="help" style={{ textAlign: "center", fontSize: 13 }}>
          {t("checkSpam")}
        </p>
        <Link
          href="/login"
          className="btn btn-ghost btn-sm"
          style={{ alignSelf: "center" }}
        >
          {tCommon("backToLogin")}
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="login-form">
      <p className="help" style={{ textAlign: "center" }}>
        {t("formHelp")}
      </p>
      <div className="field">
        <label htmlFor="forgot-email">{tCommon("emailLabel")}</label>
        <input
          id="forgot-email"
          type="email"
          name="email"
          required
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
        />
      </div>
      {state?.ok === false && (
        <div
          className="help"
          style={{ color: "var(--danger)", textAlign: "center" }}
        >
          {state.error}
        </div>
      )}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !email}
        style={{ padding: "11px 16px", justifyContent: "center" }}
      >
        {pending ? t("pendingButton") : t("sendButton")}
      </button>
      <Link
        href="/login"
        className="btn btn-ghost btn-sm"
        style={{ alignSelf: "center" }}
      >
        {tCommon("backToLogin")}
      </Link>
    </form>
  );
}
