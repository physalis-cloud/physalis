import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { refreshProjectDocs } from "@/lib/project-docs";

type Params = { params: Promise<{ slug: string }> };

const MIN_INTERVAL_MS = 30_000; // anti-spam : pas de refetch GitHub si < 30 s

/**
 * Re-récupère les docs depuis le repo GitHub et met à jour le cache. Auth : EDITOR+.
 * Throttlé à 30 s pour ne pas marteler l'API GitHub.
 */
export async function POST(_req: Request, { params }: Params) {
  const { slug } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const p = await prisma.project.findUnique({
    where: { id: access.project.id },
    select: { docsFetchedAt: true },
  });
  if (p?.docsFetchedAt && Date.now() - p.docsFetchedAt.getTime() < MIN_INTERVAL_MS) {
    return NextResponse.json({ ok: true, throttled: true });
  }

  const result = await refreshProjectDocs(access.project.id);
  return NextResponse.json({ ok: true, ...result });
}
