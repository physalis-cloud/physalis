// GET /api/projects/[slug]/repo-default?connection=<id> — dépôt GitHub par
// défaut pour la connexion choisie dans les paramètres du projet (C-0051) :
// `<utilisateur registry>/<slug>`. Sert de placeholder, et de valeur si le
// champ est laissé vide. La connexion peut ne pas être encore enregistrée sur
// le projet (choix en cours dans le formulaire) : elle est bornée à l'org.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireProjectMember } from "@/lib/api";
import { connectionRegistryOwner, defaultGithubRepo } from "@/lib/repo-default";

type Params = { params: Promise<{ slug: string }> };

export async function GET(req: Request, { params }: Params) {
  const { slug } = await params;
  // EDITOR+ : c'est le seuil des paramètres CI qu'il sert à remplir.
  const access = await requireProjectMember(slug, "EDITOR");
  if ("error" in access) return access.error;

  const connectionId = new URL(req.url).searchParams.get("connection") ?? "";
  if (!connectionId) return NextResponse.json({ defaultRepo: null });

  const owner = await connectionRegistryOwner(
    prisma,
    connectionId,
    access.project.organizationId,
  );
  return NextResponse.json({ defaultRepo: defaultGithubRepo(owner, access.project.slug) });
}
