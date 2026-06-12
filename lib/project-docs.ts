// Cache des docs projet (readme / technique / sécurité) récupérées depuis le repo
// GitHub du projet. Réutilise le token org déjà présent (`GITHUB_DISPATCH_TOKEN`,
// celui qui sert aux redeploys ; fallback `REGISTRY_PAT`) → aucun nouveau credential.
//
// Convention de nommage des fichiers (à la racine du repo, branche par défaut) :
//   README    → endpoint /readme (insensible à la casse)
//   TECHNICAL → <slug>.md
//   SECURITY  → security.md
//
// À appeler dans un contexte tenant (session, ou withTenantSchema pour le hook deploy).

import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { prisma } from "./prisma";
import { decrypt } from "./crypto";
import type { ProjectDocKind } from "@prisma/client";

/** Markdown → HTML SANITISÉ (le contenu vient du repo de l'équipe = semi-confiance).
 *  Bloque script/style/handlers, restreint les schémas d'URL, ouvre les liens en _blank. */
export async function renderMarkdownSafe(md: string): Promise<string> {
  const raw = await marked.parse(md, { gfm: true, breaks: false });
  const clean = sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title"],
      code: ["class"],
      span: ["class"],
      "*": ["id"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" },
      }),
    },
  });

  // Retire les badges GitHub (badge.svg) : sur un repo PRIVÉ ils exigent une auth
  // → image cassée. On supprime l'<img> (et un lien wrapper devenu vide).
  return clean
    .replace(
      /<img\b[^>]*\bsrc="https?:\/\/(?:[^"]*\.)?github\.com\/[^"]*badge\.svg[^"]*"[^>]*>/gi,
      "",
    )
    .replace(/<a\b[^>]*>\s*<\/a>/gi, "");
}

const TOKEN_KEYS = ["GITHUB_DISPATCH_TOKEN", "REGISTRY_PAT"] as const;

// README : endpoint dédié (trouvé où qu'il soit). TECHNICAL/SECURITY : recherchés
// par NOM dans tout l'arbre du repo (le dossier peut changer : racine, docs/, …).
type DocSpec = { kind: ProjectDocKind; readme?: boolean; name?: (slug: string) => string };
const DOC_SPECS: DocSpec[] = [
  { kind: "README", readme: true },
  { kind: "TECHNICAL", name: (slug) => `${slug}.md` },
  { kind: "SECURITY", name: () => "security.md" },
];

/** Premier token GitHub disponible au niveau org (priorité GITHUB_DISPATCH_TOKEN). */
async function getOrgGithubToken(organizationId: string): Promise<string | null> {
  const rows = await prisma.orgSecret.findMany({
    where: { organizationId, key: { in: [...TOKEN_KEYS] } },
    select: { key: true, encryptedValue: true, iv: true, tag: true },
  });
  for (const key of TOKEN_KEYS) {
    const r = rows.find((x) => x.key === key);
    if (r) return decrypt({ encryptedValue: r.encryptedValue, iv: r.iv, tag: r.tag });
  }
  return null;
}

/** Y a-t-il un token GitHub configuré au niveau org ? (pour gating UI). */
export async function orgHasGithubToken(organizationId: string): Promise<boolean> {
  const n = await prisma.orgSecret.count({
    where: { organizationId, key: { in: [...TOKEN_KEYS] } },
  });
  return n > 0;
}

type Fetched = { status: number; content: string | null };
const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Physalis-ProjectDocs",
});
const decodeB64 = (c?: string) => (c ? Buffer.from(c, "base64").toString("utf8") : null);

/** README via l'endpoint dédié (le trouve où qu'il soit : racine, docs/, .github/). */
async function ghReadme(repo: string, token: string): Promise<Fetched> {
  const res = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: GH_HEADERS(token) });
  if (!res.ok) return { status: res.status, content: null };
  return { status: 200, content: decodeB64(((await res.json()) as { content?: string }).content) };
}

/** Branche par défaut du repo (null si erreur). */
async function getDefaultBranch(repo: string, token: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: GH_HEADERS(token) });
  if (!res.ok) return null;
  return ((await res.json()) as { default_branch?: string }).default_branch ?? null;
}

/** Arbre récursif complet du repo sur une branche ([] si erreur). */
async function getRepoTree(repo: string, branch: string, token: string): Promise<string[]> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: GH_HEADERS(token) },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { tree?: { path: string; type: string }[] };
  return (data.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
}

/** Trouve un fichier par nom (insensible à la casse) dans l'arbre ; préfère le moins profond. */
function findPathInTree(tree: string[], filename: string): string | null {
  const target = filename.toLowerCase();
  const matches = tree.filter((p) => (p.split("/").pop() ?? "").toLowerCase() === target);
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.split("/").length - b.split("/").length);
  return matches[0];
}

/** Contenu d'un fichier à un chemin donné. */
async function ghContentAtPath(repo: string, path: string, token: string): Promise<Fetched> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encoded}`, {
    headers: GH_HEADERS(token),
  });
  if (!res.ok) return { status: res.status, content: null };
  return { status: 200, content: decodeB64(((await res.json()) as { content?: string }).content) };
}

export type DocFetchOutcome = {
  kind: ProjectDocKind;
  path: string;
  status: "found" | "absent" | "error";
  httpStatus: number;
};
export type RefreshResult = {
  skipped?: boolean;
  reason?: string;
  repo?: string;
  results: DocFetchOutcome[];
};

/**
 * Récupère les 3 fichiers depuis le repo et met à jour le cache (`ProjectDoc`).
 * Upsert si présent, supprime la ligne si 404 (fichier retiré). Une erreur
 * transitoire sur un fichier ne touche pas son cache existant.
 */
export async function refreshProjectDocs(projectId: string): Promise<RefreshResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, slug: true, githubRepo: true, organizationId: true },
  });
  if (!project?.githubRepo) return { skipped: true, reason: "no-repo", results: [] };
  const token = await getOrgGithubToken(project.organizationId);
  if (!token) return { skipped: true, reason: "no-token", results: [] };
  const repo = project.githubRepo;
  const results: DocFetchOutcome[] = [];

  // Applique le résultat d'un fetch au cache + journalise le diagnostic.
  // 200+contenu → upsert ; 404 → suppression ; 401/403/etc. → on NE touche PAS au cache.
  const apply = async (kind: ProjectDocKind, path: string, f: Fetched) => {
    if (f.status === 200 && f.content !== null && f.content.trim() !== "") {
      await prisma.projectDoc.upsert({
        where: { projectId_kind: { projectId, kind } },
        create: { projectId, kind, content: f.content },
        update: { content: f.content, fetchedAt: new Date() },
      });
      results.push({ kind, path, status: "found", httpStatus: 200 });
    } else if (f.status === 404) {
      await prisma.projectDoc.deleteMany({ where: { projectId, kind } });
      results.push({ kind, path, status: "absent", httpStatus: 404 });
    } else {
      results.push({ kind, path, status: "error", httpStatus: f.status });
    }
  };

  // README : endpoint dédié.
  try {
    await apply("README", "(readme)", await ghReadme(repo, token));
  } catch {
    results.push({ kind: "README", path: "(readme)", status: "error", httpStatus: 0 });
  }

  // TECHNICAL + SECURITY : recherche par nom dans tout l'arbre du repo.
  const treeKinds = DOC_SPECS.filter((s) => !s.readme && s.name);
  try {
    const branch = await getDefaultBranch(repo, token);
    const tree = branch ? await getRepoTree(repo, branch, token) : [];
    for (const spec of treeKinds) {
      const filename = spec.name!(project.slug);
      const path = findPathInTree(tree, filename);
      if (!path) {
        await prisma.projectDoc.deleteMany({ where: { projectId, kind: spec.kind } });
        results.push({ kind: spec.kind, path: filename, status: "absent", httpStatus: 404 });
      } else {
        await apply(spec.kind, path, await ghContentAtPath(repo, path, token));
      }
    }
  } catch {
    for (const spec of treeKinds) {
      if (!results.some((r) => r.kind === spec.kind)) {
        results.push({ kind: spec.kind, path: "?", status: "error", httpStatus: 0 });
      }
    }
  }

  await prisma.project.update({ where: { id: projectId }, data: { docsFetchedAt: new Date() } });
  return { repo, results };
}

/** Docs en cache d'un projet + métadonnées pour l'UI. */
export async function getProjectDocs(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { docsFetchedAt: true, organizationId: true, githubRepo: true },
  });
  if (!project) return { docs: [], fetchedAt: null, canRefresh: false };
  const docs = await prisma.projectDoc.findMany({
    where: { projectId },
    select: { kind: true, content: true, fetchedAt: true },
  });
  const canRefresh =
    Boolean(project.githubRepo) && (await orgHasGithubToken(project.organizationId));
  return { docs, fetchedAt: project.docsFetchedAt, canRefresh };
}
