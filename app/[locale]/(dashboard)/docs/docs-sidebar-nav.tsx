"use client";

import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { RiBookOpenLine } from "@remixicon/react";
import { DocIcon } from "@/lib/docs-icons";
import type { DocPage } from "@/lib/docs";

export default function DocsSidebarNav({ pages }: { pages: DocPage[] }) {
  const t = useTranslations("docs");
  const pathname = usePathname() ?? "";

  // usePathname from next-intl returns the path WITHOUT locale prefix.
  const docsBase = `/docs`;
  const isHome = pathname === docsBase || pathname === `${docsBase}/`;
  const activeSlug = pathname.startsWith(`${docsBase}/`)
    ? pathname.slice(`${docsBase}/`.length).split("/")[0]
    : null;

  return (
    <>
      <Link
        href="/docs"
        className={`side-nav-item${isHome ? " active" : ""}`}
        aria-current={isHome ? "page" : undefined}
      >
        <span className="side-nav-icon">
          <RiBookOpenLine size={16} aria-hidden />
        </span>
        <span className="side-nav-label">{t("title")}</span>
      </Link>
      {pages.map((p) => {
        const active = activeSlug === p.slug;
        return (
          <Link
            key={p.slug}
            href={`/docs/${p.slug}`}
            className={`side-nav-item${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="side-nav-icon">
              <DocIcon name={p.icon} size={16} />
            </span>
            <span className="side-nav-label">{p.title}</span>
          </Link>
        );
      })}
    </>
  );
}
