// POST /api/vault/project/[projectSlug]/collections/[slug]/import
//
// Import CSV (Bitwarden / Chrome / generique) vers une TeamVaultCollection
// project-scoped. Memes formats et meme securite que /api/vault/import
// (perso). Cf. lib/team-vault-import.ts pour la logique.

import { readJson } from "@/lib/api";
import {
  requireProjectCollectionAccess,
  hasVaultRole,
} from "@/lib/vault-access";
import { NextResponse } from "next/server";
import {
  handleTeamVaultImport,
  type ImportBody,
} from "@/lib/team-vault-import";

type Params = { params: Promise<{ projectSlug: string; slug: string }> };

export async function POST(req: Request, { params }: Params) {
  const { projectSlug, slug } = await params;
  const accessRes = await requireProjectCollectionAccess(
    projectSlug,
    slug,
    "EDITOR",
    { feature: "team_vault" },
  );
  if ("error" in accessRes) return accessRes.error;
  const { access } = accessRes;
  if (!hasVaultRole(access.role, "EDITOR")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await readJson(req)) as ImportBody | null;
  return handleTeamVaultImport(req, body, {
    user: { id: access.user.id, email: access.user.email },
    collectionId: access.collection.id,
    organizationId: access.organizationId,
    projectId: access.projectId,
    scope: "project",
  });
}
