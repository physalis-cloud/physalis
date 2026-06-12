import { NextResponse } from "next/server";
import { requireProjectMember } from "@/lib/api";
import { getProjectDocs, renderMarkdownSafe } from "@/lib/project-docs";

type Params = { params: Promise<{ slug: string }> };

/**
 * Docs projet en cache (readme / technique / sécurité), rendues en HTML sanitisé.
 * Auth : VIEWER+. Renvoie aussi `canRefresh` (repo + token org dispo) et la date du
 * dernier fetch (null = jamais récupéré).
 */
export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug);
  if ("error" in access) return access.error;

  const { docs, fetchedAt, canRefresh } = await getProjectDocs(access.project.id);
  const rendered = await Promise.all(
    docs.map(async (d) => ({
      kind: d.kind,
      html: await renderMarkdownSafe(d.content),
      fetchedAt: d.fetchedAt,
    })),
  );
  return NextResponse.json({ docs: rendered, fetchedAt, canRefresh });
}
