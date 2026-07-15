import type { ReactNode } from "react";
import { listDocPages } from "@/lib/docs";
import DocsSidebar from "./docs-sidebar";

type Props = { children: ReactNode; params: Promise<{ locale: string }> };

export default async function DocsLayout({ children, params }: Props) {
  const { locale } = await params;
  const pages = await listDocPages(locale);
  return (
    <div className="side-shell">
      <DocsSidebar pages={pages} />
      <div className="side-content">
        <div className="page">
          <div className="page-content">{children}</div>
        </div>
      </div>
    </div>
  );
}
