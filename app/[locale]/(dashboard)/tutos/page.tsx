import { Link } from "@/i18n/navigation";
import { getTranslations } from "next-intl/server";
import { RiArrowRightLine, RiGraduationCapLine, RiTimeLine, RiSignalTowerLine } from "@remixicon/react";
import { listTutoPages } from "@/lib/tutos";
import { DocIcon } from "@/lib/docs-icons";

type Props = { params: Promise<{ locale: string }> };

export default async function TutosIndexPage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations("tutos");
  const tutos = await listTutoPages(locale);

  return (
    <>
      <div className="docs-hero">
        <div className="docs-hero-icon">
          <RiGraduationCapLine size={28} aria-hidden />
        </div>
        <div>
          <h1 className="docs-hero-title">{t("title")}</h1>
          <p className="docs-hero-subtitle">{t("subtitle")}</p>
        </div>
      </div>

      <div className="tuto-grid">
        {tutos.map((p) => {
          const soon = p.published === false;
          const body = (
            <>
              <div className="tuto-card-head">
                <div className="tuto-card-icon">
                  <DocIcon name={p.icon} size={22} />
                </div>
                <div className="tuto-card-title">{p.title}</div>
                {soon ? (
                  <span className="tuto-soon-badge">{t("soon")}</span>
                ) : (
                  <div className="tuto-card-arrow" aria-hidden>
                    <RiArrowRightLine size={16} />
                  </div>
                )}
              </div>
              <div className="tuto-card-meta">
                {p.level && (
                  <span className="tuto-badge">
                    <RiSignalTowerLine size={12} aria-hidden /> {p.level}
                  </span>
                )}
                {p.duration && (
                  <span className="tuto-badge">
                    <RiTimeLine size={12} aria-hidden /> {p.duration}
                  </span>
                )}
              </div>
              <div className="tuto-card-summary">{p.summary}</div>
            </>
          );

          return soon ? (
            <div key={p.slug} className="tuto-card tuto-card-soon" aria-disabled>
              {body}
            </div>
          ) : (
            <Link key={p.slug} href={`/tutos/${p.slug}`} className="tuto-card">
              {body}
            </Link>
          );
        })}
      </div>
    </>
  );
}
