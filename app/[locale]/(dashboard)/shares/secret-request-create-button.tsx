"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import SecretRequestCreateDialog from "./secret-request-create-dialog";

type Org = { id: string; name: string; slug: string };

export default function SecretRequestCreateButton({
  onCreated,
}: {
  onCreated?: () => void;
}) {
  const t = useTranslations("shares");
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function openDialog() {
    setLoading(true);
    try {
      // Charge la liste des orgs DEV+ du user à l'ouverture (lazy).
      const res = await fetch("/api/secret-requests");
      if (!res.ok) {
        setOrgs([]);
      } else {
        const data = (await res.json()) as { orgs: Org[] };
        setOrgs(data.orgs ?? []);
      }
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={loading}
        className="btn btn-primary"
      >
        {loading ? t("loading") : t("allowExternalBtn")}
      </button>
      {open && orgs && (
        <SecretRequestCreateDialog
          orgs={orgs}
          onClose={() => setOpen(false)}
          onCreated={() => {
            setOpen(false);
            onCreated?.();
          }}
        />
      )}
    </>
  );
}
