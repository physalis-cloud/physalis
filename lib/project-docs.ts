// Cache des docs projet (readme / technique / sécurité) récupérées depuis le repo
// du projet. MULTI-PROVIDER : GitHub (API REST), GitLab (API v4), Bitbucket (API
// 2.0). Réutilise le token API de la connexion CI (redeploy_token, fallback PAT
// registry) → aucun nouveau credential. Token OPTIONNEL : un repo public se lit
// sans token ; un repo privé nécessite que la connexion porte un token de lecture.
//
// Convention de nommage des fichiers (à la racine du repo / docs/, branche défaut) :
//   README    → README(.md) (GitHub : endpoint dédié ; GitLab : arbre ; Bitbucket : probe)
//   TECHNICAL → <slug>.md
//   SECURITY  → security.md
//
// À appeler dans un contexte tenant (session, ou withTenantSchema pour le hook deploy).

import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { prisma } from "./prisma";
import { loadProjectCiSecrets, bitbucketAuthHeader } from "./ci-connection";
import { effectiveRepo } from "./ci-provider";
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

  // Retire les badges (badge.svg) : sur un repo PRIVÉ ils exigent une auth
  // → image cassée. On supprime l'<img> (et un lien wrapper devenu vide).
  return clean
    .replace(
      /<img\b[^>]*\bsrc="https?:\/\/(?:[^"]*\.)?github\.com\/[^"]*badge\.svg[^"]*"[^>]*>/gi,
      "",
    )
    .replace(/<a\b[^>]*>\s*<\/a>/gi, "");
}

type DocSpec = { kind: ProjectDocKind; readme?: boolean; name?: (slug: string) => string };
const DOC_SPECS: DocSpec[] = [
  { kind: "README", readme: true },
  { kind: "TECHNICAL", name: (slug) => `${slug}.md` },
  { kind: "SECURITY", name: () => "security.md" },
];

type ProjectRepoMeta = { provider: string; repo: string; issuer: string | null };

/** Provider + repo effectif + issuer du projet (sans déchiffrement). */
async function loadProjectRepoMeta(projectId: string): Promise<ProjectRepoMeta | null> {
  const p = (await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      githubRepo: true,
      ciRepo: true,
      ciConnection: { select: { provider: true, issuer: true } },
    },
  })) as {
    githubRepo: string | null;
    ciRepo: string | null;
    ciConnection: { provider: string; issuer: string | null } | null;
  } | null;
  if (!p) return null;
  const provider = p.ciConnection?.provider ?? "github";
  return {
    provider,
    repo: effectiveRepo(provider, p.githubRepo, p.ciRepo),
    issuer: p.ciConnection?.issuer ?? null,
  };
}

/** Auth API d'un projet pour lire le repo : redeploy_token de la connexion, à
 *  défaut le PAT registry (token null → lecture publique seulement) ; + identité
 *  Basic auth Bitbucket. */
async function projectApiAuth(
  projectId: string,
): Promise<{ token: string | null; identity: string | null }> {
  const { redeployToken, registry, apiIdentity } = await loadProjectCiSecrets(
    prisma,
    projectId,
  );
  return { token: redeployToken ?? registry?.pat ?? null, identity: apiIdentity };
}

type Fetched = { status: number; content: string | null };
const decodeB64 = (c?: string) => (c ? Buffer.from(c, "base64").toString("utf8") : null);

/** Trouve un fichier par nom (insensible à la casse) dans un arbre ; préfère le moins profond. */
function findPathInTree(tree: string[], filename: string): string | null {
  const target = filename.toLowerCase();
  const matches = tree.filter((p) => (p.split("/").pop() ?? "").toLowerCase() === target);
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.split("/").length - b.split("/").length);
  return matches[0];
}
/** Premier fichier dont le nom commence par "readme" (le moins profond). */
function findReadmeInTree(tree: string[]): string | null {
  const matches = tree.filter((p) =>
    (p.split("/").pop() ?? "").toLowerCase().startsWith("readme"),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.split("/").length - b.split("/").length);
  return matches[0];
}

// ─── GitHub (API REST) ───────────────────────────────────────────────────────
const GH_HEADERS = (token: string | null) => ({
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Physalis-ProjectDocs",
});
async function ghReadme(repo: string, token: string | null): Promise<Fetched> {
  const res = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: GH_HEADERS(token) });
  if (!res.ok) return { status: res.status, content: null };
  return { status: 200, content: decodeB64(((await res.json()) as { content?: string }).content) };
}
async function ghDefaultBranch(repo: string, token: string | null): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: GH_HEADERS(token) });
  if (!res.ok) return null;
  return ((await res.json()) as { default_branch?: string }).default_branch ?? null;
}
async function ghTree(repo: string, branch: string, token: string | null): Promise<string[]> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: GH_HEADERS(token) },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { tree?: { path: string; type: string }[] };
  return (data.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
}
async function ghFile(repo: string, path: string, token: string | null): Promise<Fetched> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encoded}`, {
    headers: GH_HEADERS(token),
  });
  if (!res.ok) return { status: res.status, content: null };
  return { status: 200, content: decodeB64(((await res.json()) as { content?: string }).content) };
}

// ─── GitLab (API v4) ─────────────────────────────────────────────────────────
const GL_HOST = (issuer: string | null) =>
  issuer?.trim() ? issuer.trim().replace(/\/+$/, "") : "https://gitlab.com";
const GL_HEADERS = (token: string | null): Record<string, string> =>
  token ? { "PRIVATE-TOKEN": token } : {};
const glBase = (issuer: string | null, repo: string) =>
  `${GL_HOST(issuer)}/api/v4/projects/${encodeURIComponent(repo)}`;
async function glDefaultBranch(issuer: string | null, repo: string, token: string | null): Promise<string | null> {
  const res = await fetch(glBase(issuer, repo), { headers: GL_HEADERS(token) });
  if (!res.ok) return null;
  return ((await res.json()) as { default_branch?: string }).default_branch ?? null;
}
async function glTree(issuer: string | null, repo: string, branch: string, token: string | null): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const url = `${glBase(issuer, repo)}/repository/tree?recursive=true&ref=${encodeURIComponent(branch)}&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: GL_HEADERS(token) });
    if (!res.ok) break;
    const data = (await res.json()) as { path: string; type: string }[];
    for (const e of data) if (e.type === "blob") out.push(e.path);
    if (data.length < 100) break;
  }
  return out;
}
async function glFile(issuer: string | null, repo: string, path: string, branch: string, token: string | null): Promise<Fetched> {
  const url = `${glBase(issuer, repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: GL_HEADERS(token) });
  if (!res.ok) return { status: res.status, content: null };
  return { status: 200, content: await res.text() };
}

// ─── Bitbucket (API 2.0) ─────────────────────────────────────────────────────
// repo = repositoryUuid {..} ; workspace extrait de l'issuer
// (https://api.bitbucket.org/2.0/workspaces/<ws>/pipelines-config/identity/oidc).
const BB_HEADERS = (token: string | null, identity: string | null) => ({
  Accept: "application/json",
  ...(token ? bitbucketAuthHeader(token, identity) : {}),
});
function bbWorkspace(issuer: string | null): string | null {
  const m = (issuer ?? "").match(/\/workspaces\/([^/]+)\//);
  return m ? m[1] : null;
}
const bbBase = (ws: string, repo: string) =>
  `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(repo)}`;
async function bbDefaultBranch(ws: string, repo: string, token: string | null, identity: string | null): Promise<string | null> {
  const res = await fetch(bbBase(ws, repo), { headers: BB_HEADERS(token, identity) });
  if (!res.ok) return null;
  return ((await res.json()) as { mainbranch?: { name?: string } }).mainbranch?.name ?? null;
}
async function bbFile(ws: string, repo: string, path: string, branch: string, token: string | null, identity: string | null): Promise<Fetched> {
  const encPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${bbBase(ws, repo)}/src/${encodeURIComponent(branch)}/${encPath}`, {
    headers: BB_HEADERS(token, identity),
  });
  if (!res.ok) return { status: res.status, content: null };
  return { status: 200, content: await res.text() };
}
/** Essaie une liste de chemins, renvoie le 1er 200 non vide ; sinon 404 (tous absents) ou la 1re erreur. */
async function probe(candidates: string[], fn: (path: string) => Promise<Fetched>): Promise<{ path: string; f: Fetched }> {
  let firstErr: Fetched | null = null;
  for (const c of candidates) {
    const f = await fn(c);
    if (f.status === 200 && f.content !== null && f.content.trim() !== "") return { path: c, f };
    if (f.status !== 404 && firstErr === null) firstErr = f;
  }
  return { path: candidates[0], f: firstErr ?? { status: 404, content: null } };
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
 * transitoire (401/403/5xx) ne touche pas le cache existant.
 */
export async function refreshProjectDocs(projectId: string): Promise<RefreshResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, slug: true },
  });
  if (!project) return { skipped: true, reason: "no-project", results: [] };
  const meta = await loadProjectRepoMeta(projectId);
  if (!meta || meta.repo === "") return { skipped: true, reason: "no-repo", results: [] };
  const { token, identity } = await projectApiAuth(projectId);
  const results: DocFetchOutcome[] = [];

  // 200+contenu → upsert ; 404 → suppression ; autre → on NE touche PAS au cache.
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

  const treeSpecs = DOC_SPECS.filter((s) => !s.readme && s.name);

  try {
    if (meta.provider === "gitlab") {
      const branch = await glDefaultBranch(meta.issuer, meta.repo, token);
      const tree = branch ? await glTree(meta.issuer, meta.repo, branch, token) : [];
      const readmePath = findReadmeInTree(tree);
      await apply(
        "README",
        readmePath ?? "(readme)",
        readmePath && branch ? await glFile(meta.issuer, meta.repo, readmePath, branch, token) : { status: 404, content: null },
      );
      for (const spec of treeSpecs) {
        const path = findPathInTree(tree, spec.name!(project.slug));
        await apply(
          spec.kind,
          path ?? spec.name!(project.slug),
          path && branch ? await glFile(meta.issuer, meta.repo, path, branch, token) : { status: 404, content: null },
        );
      }
    } else if (meta.provider === "bitbucket") {
      const ws = bbWorkspace(meta.issuer);
      if (!ws) return { skipped: true, reason: "no-workspace", results: [] };
      const branch = (await bbDefaultBranch(ws, meta.repo, token, identity)) ?? "main";
      const get = (p: string) => bbFile(ws, meta.repo, p, branch, token, identity);
      const rd = await probe(["README.md", "readme.md", "README", "docs/README.md", ".github/README.md"], get);
      await apply("README", rd.path, rd.f);
      const slug = project.slug;
      const tech = await probe([`${slug}.md`, `docs/${slug}.md`], get);
      await apply("TECHNICAL", tech.path, tech.f);
      const sec = await probe(["security.md", "SECURITY.md", "docs/security.md", ".github/SECURITY.md"], get);
      await apply("SECURITY", sec.path, sec.f);
    } else {
      // github (défaut) : endpoint /readme + arbre récursif.
      await apply("README", "(readme)", await ghReadme(meta.repo, token));
      const branch = await ghDefaultBranch(meta.repo, token);
      const tree = branch ? await ghTree(meta.repo, branch, token) : [];
      for (const spec of treeSpecs) {
        const path = findPathInTree(tree, spec.name!(project.slug));
        await apply(
          spec.kind,
          path ?? spec.name!(project.slug),
          path ? await ghFile(meta.repo, path, token) : { status: 404, content: null },
        );
      }
    }
  } catch {
    for (const spec of DOC_SPECS) {
      if (!results.some((r) => r.kind === spec.kind)) {
        results.push({ kind: spec.kind, path: "?", status: "error", httpStatus: 0 });
      }
    }
  }

  await prisma.project.update({ where: { id: projectId }, data: { docsFetchedAt: new Date() } });
  return { repo: meta.repo, results };
}

/** Docs en cache d'un projet + métadonnées pour l'UI. */
export async function getProjectDocs(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { docsFetchedAt: true },
  });
  if (!project) return { docs: [], fetchedAt: null, canRefresh: false };
  const docs = await prisma.projectDoc.findMany({
    where: { projectId },
    select: { kind: true, content: true, fetchedAt: true },
  });
  // canRefresh dès qu'un repo est configuré (token optionnel → repo public OK).
  const meta = await loadProjectRepoMeta(projectId);
  const canRefresh = Boolean(meta && meta.repo !== "");
  return { docs, fetchedAt: project.docsFetchedAt, canRefresh };
}
