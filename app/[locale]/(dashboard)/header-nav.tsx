"use client";

import { useEffect, useRef, useState } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import {
  RiBookOpenLine,
  RiFolderOpenLine,
  RiMenuLine,
  RiCloseLine,
  RiSafe2Line,
  RiSettings3Line,
  RiShareForward2Line,
  type RemixiconComponentType,
} from "@remixicon/react";

type NavItem = {
  href: string;
  label: string;
  shortLabel?: string;
  Icon?: RemixiconComponentType;
};

export default function HeaderNav({ currentSlug }: { currentSlug: string | null }) {
  const t = useTranslations("dashboard.nav");
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Ferme le menu au changement de route (clic sur un lien) ET au clic
  // hors du wrapper + a la touche Escape (UX dropdown standard).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // « Paramètres » mène à la page de l'organisation courante (réglages org).
  // Fallback /dashboard si aucune org courante (cas limite : user sans org).
  const settingsHref = currentSlug ? `/orgs/${currentSlug}` : "/dashboard";

  const items: NavItem[] = [
    { href: "/projects", label: t("projects"), Icon: RiFolderOpenLine },
    { href: "/vault", label: t("vault"), shortLabel: t("vaultShort"), Icon: RiSafe2Line },
    { href: "/shares", label: t("shares"), Icon: RiShareForward2Line },
    { href: "/docs", label: t("docs"), Icon: RiBookOpenLine },
    { href: settingsHref, label: t("parameters"), Icon: RiSettings3Line },
  ];

  function isActive(href: string): boolean {
    if (href === "/projects") return pathname.startsWith("/projects");
    if (href === "/vault") return pathname === "/vault";
    if (href === "/shares") return pathname === "/shares";
    if (href === "/docs") return pathname.startsWith("/docs");
    if (href === settingsHref) return pathname.startsWith("/orgs");
    return pathname === href;
  }

  return (
    <div className="app-nav-wrap" ref={wrapRef}>
      <button
        type="button"
        className="app-nav-toggle"
        aria-expanded={open}
        aria-controls="app-nav-menu"
        aria-label={open ? t("closeMenu") : t("openMenu")}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <RiCloseLine size={20} aria-hidden /> : <RiMenuLine size={20} aria-hidden />}
      </button>
      <nav
        id="app-nav-menu"
        className={`app-nav${open ? " is-open" : ""}`}
        aria-label={t("ariaLabel")}
      >
        {items.map(({ href, label, shortLabel, Icon }) => (
          <Link
            key={href}
            href={href}
            className={isActive(href) ? "active" : ""}
          >
            {Icon && <Icon size={15} aria-hidden />}
            {shortLabel ? (
              <>
                <span className="nav-label-full">{label}</span>
                <span className="nav-label-short">{shortLabel}</span>
              </>
            ) : (
              label
            )}
          </Link>
        ))}
      </nav>
    </div>
  );
}
