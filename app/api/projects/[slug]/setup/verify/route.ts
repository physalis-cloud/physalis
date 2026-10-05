// POST /api/projects/[slug]/setup/verify — vérification d'un projet antérieur
// au guide d'installation (C-0051, Phase 4 bis). Cf. lib/project-verify.ts.
//
// POST et non GET : elle interroge l'API de la plateforme CI avec le jeton de
// la connexion — une action, pas une lecture qu'on rejoue au rafraîchissement.
// EDITOR+ (c'est un éditeur qui corrigera le workflow) et rate-limitée.

import { NextResponse } from "next/server";
import { requireProjectMember } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { verifyLegacyProject } from "@/lib/project-verify";

type Params = { params: Promise<{ slug: string }> };

const RATE_LIMIT = { max: 10, windowMs: 60_000 };

export async function POST(req: Request, { params }: Params) {
  const limited = rateLimit(req, "setup-verify", RATE_LIMIT);
  if (limited) return limited;

  const { slug } = await params;
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const result = await verifyLegacyProject(access.project.id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(result);
}
