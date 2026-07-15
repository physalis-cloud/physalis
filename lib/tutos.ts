// Loader pour les tutoriels de Physalis.
//
// Source : fichiers markdown dans `docs/tutos/<locale>/<slug>.md`, même
// convention de frontmatter que la doc (`lib/docs.ts`) + `level` et `duration`.
// Seul le FR existe pour l'instant → fallback vers "fr".
//
// Un tuto est découpé en **étapes** pour l'affichage « stepper » :
//   - l'intro (avant le 1er `##`) + la 1ʳᵉ section forment la slide « Présentation »
//   - chaque `##` suivant est une étape
// Chaque étape est rendue en HTML (marked), avec réécriture des liens croisés
// (`tuto:slug` → autre tuto ; slug nu → doc de référence).

import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";

export type TutoFrontmatter = {
  title: string;
  order: number;
  icon: string;
  summary: string;
  level?: string;
  duration?: string;
  /** Absent = publié. `published: false` → carte « Bientôt » inactive. */
  published?: boolean;
};

export type TutoPage = TutoFrontmatter & { slug: string };

export type TutoStep = { label: string; core: number | null; html: string };

export type TutoWithSteps = TutoPage & {
  steps: TutoStep[];
  coreTotal: number;
};

const TUTOS_ROOT = path.join(process.cwd(), "docs", "tutos");
const SLUG_PREFIX_RE = /^\d+-/;
const PRESENTATION_LABEL: Record<string, string> = {
  fr: "Présentation",
  en: "Introduction",
  es: "Introducción",
};

const listCache = new Map<string, TutoPage[]>();
const pageCache = new Map<string, TutoWithSteps>();

async function resolveLocale(locale: string): Promise<string> {
  try {
    await access(path.join(TUTOS_ROOT, locale));
    return locale;
  } catch {
    return "fr";
  }
}

function fileBaseToSlug(base: string): string {
  return base.replace(/\.md$/, "").replace(SLUG_PREFIX_RE, "");
}

function parseFrontmatter(raw: string): { meta: TutoFrontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("Frontmatter manquant : `---\\n…\\n---` requis en tête");
  const [, header, body] = match;
  const meta: Partial<TutoFrontmatter> = {};
  for (const line of header.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "order") meta.order = Number(value);
    else if (key === "published") meta.published = value !== "false";
    else if (
      key === "title" ||
      key === "icon" ||
      key === "summary" ||
      key === "level" ||
      key === "duration"
    ) {
      meta[key] = value;
    }
  }
  if (!meta.title || meta.order === undefined || !meta.icon || !meta.summary) {
    throw new Error("Frontmatter incomplet : title, order, icon, summary requis");
  }
  return { meta: meta as TutoFrontmatter, body };
}

function coreNumber(label: string): number | null {
  const m = label.match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
}

function stripRules(s: string): string {
  return s.replace(/^\s*---\s*$/gm, "").trim();
}

/** Réécrit les liens : `tuto:slug` → /locale/tutos/slug ; slug nu → /locale/docs/slug. */
function rewriteLinks(html: string, locale: string): string {
  return html.replace(/href="([^"]+)"/g, (full, href: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(href)) return full;
    if (href.startsWith("tuto:")) return `href="/${locale}/tutos/${href.slice(5)}"`;
    return `href="/${locale}/docs/${href}"`;
  });
}

/** Découpe le corps markdown en étapes { label, mdBody }. */
function buildSteps(body: string, introLabel: string): { label: string; md: string }[] {
  const intro: string[] = [];
  const sections: { label: string; buf: string[] }[] = [];
  let seenHeading = false;
  let current: { label: string; buf: string[] } | null = null;

  for (const line of body.split("\n")) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      if (current) sections.push(current);
      current = { label: h2[1].trim(), buf: [] };
      seenHeading = true;
      continue;
    }
    if (!seenHeading) {
      if (/^#\s+/.test(line)) continue; // retire le H1 (titre = frontmatter)
      intro.push(line);
    } else if (current) {
      current.buf.push(line);
    }
  }
  if (current) sections.push(current);

  const introBody = stripRules(intro.join("\n"));

  if (sections.length === 0) {
    return [{ label: introLabel, md: introBody }];
  }

  // Présentation = intro + 1ʳᵉ section (rendue en sous-titre `###`).
  const [first, ...rest] = sections;
  const presMd = [introBody, `### ${first.label}`, stripRules(first.buf.join("\n"))]
    .filter(Boolean)
    .join("\n\n");

  const steps = [{ label: introLabel, md: presMd }];
  for (const s of rest) steps.push({ label: s.label, md: stripRules(s.buf.join("\n")) });
  return steps;
}

export async function listTutoPages(locale = "fr"): Promise<TutoPage[]> {
  const resolved = await resolveLocale(locale);
  // En dev, on bypasse le cache pour voir les modifs des .md sans restart
  // (le cache mémoire ne s'invalide pas au changement de fichier). En prod le
  // contenu est figé au déploiement → cache conservé.
  const cached = listCache.get(resolved);
  if (cached && process.env.NODE_ENV === "production") return cached;

  const dir = path.join(TUTOS_ROOT, resolved);
  const entries = await readdir(dir);
  const pages: TutoPage[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const raw = await readFile(path.join(dir, file), "utf8");
    const { meta } = parseFrontmatter(raw);
    pages.push({ ...meta, slug: fileBaseToSlug(file) });
  }
  pages.sort((a, b) => a.order - b.order);
  listCache.set(resolved, pages);
  return pages;
}

export async function getTuto(
  slug: string,
  locale = "fr",
): Promise<TutoWithSteps | null> {
  const resolved = await resolveLocale(locale);
  const cacheKey = `${resolved}:${slug}`;
  // Cf. listTutoPages : bypass du cache en dev pour recharger les .md à chaud.
  const cached = pageCache.get(cacheKey);
  if (cached && process.env.NODE_ENV === "production") return cached;

  const dir = path.join(TUTOS_ROOT, resolved);
  const entries = await readdir(dir);
  const file = entries.find((f) => f.endsWith(".md") && fileBaseToSlug(f) === slug);
  if (!file) return null;

  const raw = await readFile(path.join(dir, file), "utf8");
  const { meta, body } = parseFrontmatter(raw);

  const steps: TutoStep[] = [];
  for (const s of buildSteps(body, PRESENTATION_LABEL[resolved] ?? PRESENTATION_LABEL.fr)) {
    const html = await marked.parse(`## ${s.label}\n\n${s.md}`, {
      gfm: true,
      breaks: false,
    });
    steps.push({ label: s.label, core: coreNumber(s.label), html: rewriteLinks(html, resolved) });
  }
  const coreTotal = steps.filter((s) => s.core !== null).length;

  const page: TutoWithSteps = { ...meta, slug, steps, coreTotal };
  pageCache.set(cacheKey, page);
  return page;
}

/**
 * Slug équivalent dans `toLocale` d'un slug de `fromLocale`, via le préfixe
 * numérique du fichier. Retourne `null` si le tuto n'existe pas dans la langue
 * cible (→ repli sur la galerie).
 */
export async function resolveTutoSlug(
  slug: string,
  fromLocale: string,
  toLocale: string,
): Promise<string | null> {
  const from = await resolveLocale(fromLocale);
  const to = await resolveLocale(toLocale);
  if (from === to) return slug;
  const fromFiles = await readdir(path.join(TUTOS_ROOT, from));
  const fromFile = fromFiles.find((f) => f.endsWith(".md") && fileBaseToSlug(f) === slug);
  const prefix = fromFile?.match(SLUG_PREFIX_RE)?.[0];
  if (!prefix) return null;
  const toFiles = await readdir(path.join(TUTOS_ROOT, to));
  const toFile = toFiles.find((f) => f.endsWith(".md") && f.startsWith(prefix));
  return toFile ? fileBaseToSlug(toFile) : null;
}
