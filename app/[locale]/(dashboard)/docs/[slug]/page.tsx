import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RiBookOpenLine } from "@remixicon/react";
import { getDocPage } from "@/lib/docs";
import { DocIcon } from "@/lib/docs-icons";

type Params = { params: Promise<{ locale: string; slug: string }> };

// Rendu dynamique (comme la liste et tout le dashboard) : la page vit sous le
// layout `(dashboard)` qui utilise la session → pas de pré-génération statique
// possible. Un `generateStaticParams` ici déclenchait `DYNAMIC_SERVER_USAGE`
// (getTranslations lit les headers sans setRequestLocale) → 500.

export default async function DocsPage({ params }: Params) {
  const { locale, slug } = await params;
  const t = await getTranslations("docs");
  const page = await getDocPage(slug, locale);
  if (!page) notFound();

  return (
    <>
      <div className="docs-hero">
        <div className="docs-hero-icon">
          <RiBookOpenLine size={28} aria-hidden />
        </div>
        <div>
          <h1 className="docs-hero-title">{t("title")}</h1>
          <div
            className="docs-page-eyebrow"
            style={{ marginTop: 6, marginBottom: 0 }}
          >
            <span className="docs-page-icon">
              <DocIcon name={page.icon} size={14} />
            </span>
            <span>{page.title}</span>
          </div>
        </div>
      </div>
      <article
        className="docs-prose"
        dangerouslySetInnerHTML={{ __html: page.html }}
      />
    </>
  );
}
