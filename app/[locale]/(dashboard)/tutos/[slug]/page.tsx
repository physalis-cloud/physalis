import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RiArrowLeftLine, RiTimeLine, RiSignalTowerLine } from "@remixicon/react";
import { Link } from "@/i18n/navigation";
import { getTuto } from "@/lib/tutos";
import TutoStepper from "./tuto-stepper";

type Params = { params: Promise<{ locale: string; slug: string }> };

export default async function TutoDetailPage({ params }: Params) {
  const { locale, slug } = await params;
  const t = await getTranslations("tutos");
  const tuto = await getTuto(slug, locale);
  if (!tuto) notFound();

  return (
    <>
      <Link href="/tutos" className="docs-backlink">
        <RiArrowLeftLine size={14} aria-hidden /> {t("back")}
      </Link>

      <div className="tuto-header">
        <div className="tuto-eyebrow-row">
          <span className="tuto-eyebrow">🎓 {t("eyebrow")}</span>
          <div className="tuto-meta">
            {tuto.level && (
              <span className="tuto-badge">
                <RiSignalTowerLine size={13} aria-hidden /> {tuto.level}
              </span>
            )}
            {tuto.duration && (
              <span className="tuto-badge">
                <RiTimeLine size={13} aria-hidden /> {tuto.duration}
              </span>
            )}
          </div>
        </div>
        <h1 className="tuto-title">{tuto.title}</h1>
      </div>

      <TutoStepper steps={tuto.steps} coreTotal={tuto.coreTotal} />
    </>
  );
}
