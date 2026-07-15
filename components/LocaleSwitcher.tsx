"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { routing } from "@/i18n/routing";

const LOCALE_LABELS: Record<string, string> = {
  en: "EN",
  fr: "FR",
  es: "ES",
};

export default function LocaleSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  async function switchTo(next: string) {
    if (next === locale) return;
    // Persist locale preference in cookie so detectLocale() picks it up.
    document.cookie = `NEXT_LOCALE=${next};path=/;max-age=31536000;SameSite=Lax`;

    // Pages docs/tutos : le slug est localisé (`premiers-pas` ↔ `getting-started`)
    // → le remapper vers son équivalent dans la langue cible, sinon 404. `null`
    // (page absente dans la langue cible) → repli sur la liste.
    const m = pathname.match(/^\/[^/]+\/(docs|tutos)\/([^/]+)\/?$/);
    if (m) {
      const [, type, slug] = m;
      try {
        const res = await fetch(
          `/api/i18n/resolve-slug?type=${type}&slug=${encodeURIComponent(slug)}&from=${locale}&to=${next}`,
        );
        const data = (await res.json()) as { slug: string | null };
        router.push(data.slug ? `/${next}/${type}/${data.slug}` : `/${next}/${type}`);
      } catch {
        router.push(`/${next}/${type}`);
      }
      return;
    }

    const withoutLocale = pathname.replace(/^\/[^/]+/, "");
    router.push(`/${next}${withoutLocale}`);
  }

  return (
    <div className="flex items-center gap-1" style={{ fontSize: 12 }}>
      {routing.locales.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => void switchTo(l)}
          disabled={l === locale}
          style={{
            padding: "2px 6px",
            borderRadius: 4,
            border: "1px solid var(--border)",
            background: l === locale ? "var(--accent-bg)" : "transparent",
            color: l === locale ? "var(--accent)" : "var(--text-muted)",
            fontWeight: l === locale ? 600 : 400,
            cursor: l === locale ? "default" : "pointer",
            fontSize: 11,
            lineHeight: 1.4,
          }}
          aria-current={l === locale ? "true" : undefined}
        >
          {LOCALE_LABELS[l] ?? l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
