// POST /api/vault/org/[orgSlug]/collections/[slug]/import
//
// Import CSV (Bitwarden / Chrome / generique) vers une TeamVaultCollection
// org-scoped. Memes formats et meme securite que /api/vault/import (perso).
// Cf. lib/team-vault-import.ts pour la logique.

import { readJson } from "@/lib/api";
import { requireOrgCollectionAccess, hasVaultRole } from "@/lib/vault-access";
import { NextResponse } from "next/server";
import {
  handleTeamVaultImport,
  type ImportBody,
} from "@/lib/team-vault-import";

type Params = { params: Promise<{ orgSlug: string; slug: string }> };

export async function POST(req: Request, { params }: Params) {
  const { orgSlug, slug } = await params;
  const accessRes = await requireOrgCollectionAccess(orgSlug, slug, "EDITOR", { feature: "team_vault" });
  if ("error" in accessRes) return accessRes.error;
  const { access } = accessRes;
  // Defense en profondeur : `requireOrgCollectionAccess` deja garanti
  // EDITOR+ via son argument, mais on re-check au cas ou la signature
  // changerait dans le futur.
  if (!hasVaultRole(access.role, "EDITOR")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await readJson(req)) as ImportBody | null;
  return handleTeamVaultImport(req, body, {
    user: { id: access.user.id, email: access.user.email },
    collectionId: access.collection.id,
    organizationId: access.organizationId,
    projectId: null,
    scope: "org",
  });
}
