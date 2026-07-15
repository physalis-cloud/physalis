"use client";

import type { CSSProperties } from "react";
import { usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import DocsSidebarNav from "./docs-sidebar-nav";
import type { DocPage } from "@/lib/docs";

export default function DocsSidebar({ pages }: { pages: DocPage[] }) {
  const t = useTranslations("docs");
  const pathname = usePathname() ?? "";
  // Hide sidebar on docs index (usePathname from next-intl is locale-stripped)
  if (/^\/docs\/?$/.test(pathname)) return null;
  return (
    <aside className="side-nav-col" style={{ "--rail-top": "124px" } as CSSProperties}>
      <nav className="side-nav" aria-label={t("title")}>
        <DocsSidebarNav pages={pages} />
      </nav>
    </aside>
  );
}
