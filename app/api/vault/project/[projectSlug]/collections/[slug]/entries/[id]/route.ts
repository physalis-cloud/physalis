import { requireProjectCollectionAccess } from "@/lib/vault-access";
import {
  revealEntry,
  patchEntry,
  deleteEntry,
} from "@/lib/vault-entry-handlers";

type Params = {
  params: Promise<{ projectSlug: string; slug: string; id: string }>;
};

export async function GET(req: Request, { params }: Params) {
  const { projectSlug, slug, id } = await params;
  const access = await requireProjectCollectionAccess(projectSlug, slug, "VIEWER");
  if ("error" in access) return access.error;
  return revealEntry(access.access, id, req);
}

export async function PATCH(req: Request, { params }: Params) {
  const { projectSlug, slug, id } = await params;
  const access = await requireProjectCollectionAccess(projectSlug, slug, "EDITOR", { feature: "team_vault" });
  if ("error" in access) return access.error;
  return patchEntry(access.access, id, req);
}

export async function DELETE(req: Request, { params }: Params) {
  const { projectSlug, slug, id } = await params;
  const access = await requireProjectCollectionAccess(projectSlug, slug, "EDITOR");
  if ("error" in access) return access.error;
  return deleteEntry(access.access, id, req);
}
