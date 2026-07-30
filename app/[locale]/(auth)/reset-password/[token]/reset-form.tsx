"use client";

import { useActionState, useState } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { resetPassword, type ResetResult } from "./actions";

export default function ResetForm({ token }: { token: string }) {
  const t = useTranslations("auth.resetPassword");
  const tCommon = useTranslations("auth.common");
  const router = useRouter();
  const [state, action, pending] = useActionState<
    ResetResult | null,
    FormData
  >(resetPassword, null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  if (state?.ok) {
    return (
      <div className="login-form" style={{ gap: 12 }}>
        <p className="help" style={{ textAlign: "center" }}>
          {t("successMessage")}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => router.push("/login")}
          style={{ padding: "11px 16px", justifyContent: "center" }}
        >
          {tCommon("signIn")}
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="login-form">
      <input type="hidden" name="token" value={token} />
      <div className="field">
        <label htmlFor="reset-password">{t("newPasswordLabel")}</label>
        <input
          id="reset-password"
          type="password"
          name="password"
          required
          autoComplete="new-password"
          minLength={12}
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
        />
      </div>
      <div className="field">
        <label htmlFor="reset-confirm">{t("confirmPasswordLabel")}</label>
        <input
          id="reset-confirm"
          type="password"
          name="confirm"
          required
          autoComplete="new-password"
          minLength={12}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="input"
        />
      </div>
      <p className="help" style={{ fontSize: 13 }}>
        {t("minLength")}
      </p>
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
        disabled={pending || password.length < 12 || password !== confirm}
        style={{ padding: "11px 16px", justifyContent: "center" }}
      >
        {pending ? t("pendingButton") : t("submitButton")}
      </button>
      <Link
        href="/login"
        className="btn btn-ghost btn-sm"
        style={{ alignSelf: "center" }}
      >
        {tCommon("cancel")}
      </Link>
    </form>
  );
}
