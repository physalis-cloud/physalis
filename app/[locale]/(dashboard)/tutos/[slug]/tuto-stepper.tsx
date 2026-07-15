"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { RiArrowLeftLine, RiArrowRightLine } from "@remixicon/react";

type Step = { label: string; core: number | null; html: string };

export default function TutoStepper({
  steps,
  coreTotal,
}: {
  steps: Step[];
  coreTotal: number;
}) {
  const t = useTranslations("tutos");
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const total = steps.length;

  const go = useCallback(
    (target: number) => {
      setStep((prev) => {
        const clamped = Math.max(0, Math.min(total - 1, target));
        setDir(clamped >= prev ? 1 : -1);
        return clamped;
      });
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [total],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(step + 1);
      if (e.key === "ArrowLeft") go(step - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, go]);

  const cur = steps[step];
  const pct = total > 1 ? (step / (total - 1)) * 100 : 0;
  const headLabel =
    cur.core !== null ? t("step", { n: cur.core, total: coreTotal }) : cur.label;

  return (
    <div className="tuto">
      {/* Tracker : barre + points cliquables */}
      <div className="tuto-tracker">
        <div className="tuto-tracker-head">
          <span className="tuto-step-count">{headLabel}</span>
        </div>
        <div className="tuto-bar">
          <div className="tuto-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="tuto-dots">
          {steps.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => go(i)}
              className={[
                "tuto-dot",
                s.core === null ? "tuto-dot-framing" : "",
                i === step ? "tuto-dot-active" : i < step ? "tuto-dot-done" : "",
              ].join(" ")}
              aria-label={s.label}
              title={s.label}
            >
              {s.core ?? ""}
            </button>
          ))}
        </div>
      </div>

      {/* Contenu de l'étape (transition à chaque changement de clé) */}
      <div className="tuto-stage">
        <article
          key={step}
          className={`docs-prose tuto-slide ${dir >= 0 ? "tuto-slide-next" : "tuto-slide-prev"}`}
          dangerouslySetInnerHTML={{ __html: cur.html }}
        />
      </div>

      {/* Navigation */}
      <div className="tuto-nav">
        <button
          type="button"
          className="tuto-nav-btn"
          onClick={() => go(step - 1)}
          disabled={step === 0}
        >
          <RiArrowLeftLine size={16} aria-hidden /> {t("prev")}
        </button>
        <button
          type="button"
          className="tuto-nav-btn tuto-nav-btn-primary"
          onClick={() => go(step + 1)}
          disabled={step === total - 1}
        >
          {t("next")} <RiArrowRightLine size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
