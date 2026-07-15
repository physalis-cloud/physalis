"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";

export default function AcceptInvitationButton({
  token,
  orgSlug,
}: {
  token: string;
  orgSlug: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function accept() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/invitations/${token}`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(data?.error ?? "Acceptation impossible.");
        return;
      }
      await fetch("/api/me/current-org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: orgSlug }),
      });
      router.push(`/orgs/${orgSlug}`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={accept}
        disabled={pending}
        className="btn btn-primary"
        style={{ marginTop: 6, padding: "11px 16px", justifyContent: "center" }}
      >
        {pending ? "Acceptation..." : "Accepter l'invitation"}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
