"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ConfirmDialog";
import { generatePassword } from "@/lib/generate-password";
import { maskedInputProps } from "@/lib/masked-input";

// Section « Rotation immédiate » embarquée dans une modale de config rotation
// (REMINDER / manuel). Génère/saisit la nouvelle valeur, confirme (bloquant)
// qu'elle a bien été appliquée À LA SOURCE, puis l'enregistre. Indépendant du
// rappel configuré au-dessus. i18n : `rotationAssisted`.
//
// `endpoint` = POST cible ; `payloadKey` = champ du body ("newValue" pour les
// secrets, "newPassword" pour service/compte/coffre). `onDone` = recharger après.
export default function ImmediateRotationSection({
  endpoint,
  payloadKey,
  onDone,
}: {
  endpoint: string;
  payloadKey: "newValue" | "newPassword";
  onDone?: () => void;
}) {
  const t = useTranslations("rotationAssisted");
  const confirm = useConfirm();
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  async function run() {
    setError(null);
    if (!(await confirm({ message: t("sourceConfirm") }))) return;
    startTransition(async () => {
      const trimmed = value.trim();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trimmed ? { [payloadKey]: value } : {}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("saveError"));
        return;
      }
      setValue("");
      setDone(true);
      onDone?.();
    });
  }

  return (
    <div className="field" style={{ borderTop: "1px solid var(--border, rgba(0,0,0,0.1))", paddingTop: 12, marginTop: 4 }}>
      <label>{t("immediateHeading")}</label>
      <p className="help" style={{ fontSize: 11, marginTop: 0, marginBottom: 6 }}>{t("immediateHint")}</p>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          {...maskedInputProps(reveal)}
          name="immediate-rotation-value"
          value={value}
          onChange={(e) => { setValue(e.target.value); setDone(false); }}
          placeholder={t("valuePlaceholder")}
          disabled={pending}
          autoComplete="off"
          style={{ flex: 1 }}
        />
        <button type="button" onClick={() => setReveal((r) => !r)} className="btn btn-ghost btn-xs" disabled={pending}>
          {reveal ? t("hide") : t("reveal")}
        </button>
        <button type="button" onClick={() => { setValue(generatePassword(24)); setReveal(true); setDone(false); }} className="btn btn-ghost btn-xs" disabled={pending}>
          {t("generate")}
        </button>
      </div>
      {error && <p className="error-text" style={{ marginTop: 6 }}>{error}</p>}
      <button type="button" onClick={run} disabled={pending} className="btn btn-secondary btn-sm" style={{ marginTop: 8 }}>
        {pending ? t("savingBtn") : t("immediateBtn")}
      </button>
      {done && !pending && <span className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>✓</span>}
    </div>
  );
}
