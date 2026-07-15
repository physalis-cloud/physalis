import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { RiArrowRightLine, RiBookOpenLine, RiGraduationCapLine } from "@remixicon/react";
import { listDocPages } from "@/lib/docs";
import { DocIcon } from "@/lib/docs-icons";

type Props = { params: Promise<{ locale: string }> };

export default async function DocsIndexPage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations("docs");
  const tt = await getTranslations("tutos");
  const pages = await listDocPages(locale);

  return (
    <>
      <div className="docs-hero">
        <div className="docs-hero-icon">
          <RiBookOpenLine size={28} aria-hidden />
        </div>
        <div>
          <h1 className="docs-hero-title">{t("title")}</h1>
          <p className="docs-hero-subtitle">{t("subtitle")}</p>
        </div>
      </div>

      <Link href="/tutos" className="tuto-banner">
        <div className="tuto-banner-icon">
          <RiGraduationCapLine size={30} aria-hidden />
        </div>
        <div className="tuto-banner-body">
          <div className="tuto-banner-title">{tt("bannerTitle")}</div>
          <p className="tuto-banner-text">{tt("bannerText")}</p>
        </div>
        <span className="tuto-banner-cta">
          {tt("bannerCta")} <RiArrowRightLine size={16} aria-hidden />
        </span>
      </Link>

      <div className="docs-grid">
        {pages.map((p, idx) => (
          <Link key={p.slug} href={`/docs/${p.slug}`} className="docs-card">
            <div className="docs-card-icon">
              <DocIcon name={p.icon} size={22} />
            </div>
            <div className="docs-card-body">
              <div className="docs-card-eyebrow">
                {t("section")} {String(idx + 1).padStart(2, "0")}
              </div>
              <div className="docs-card-title">{p.title}</div>
              <div className="docs-card-summary">{p.summary}</div>
            </div>
            <div className="docs-card-arrow" aria-hidden>
              <RiArrowRightLine size={16} />
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
