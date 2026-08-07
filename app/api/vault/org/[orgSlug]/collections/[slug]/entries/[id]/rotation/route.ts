import { requireOrgCollectionAccess } from "@/lib/vault-access";
import {
  getEntryRotation,
  patchEntryRotation,
  rotateEntry,
} from "@/lib/vault-entry-handlers";

type Params = {
  params: Promise<{ orgSlug: string; slug: string; id: string }>;
};

// Rotation REMINDER d'une entrée de coffre ORG. GET/PATCH = config ; POST = assisté.
export async function GET(req: Request, { params }: Params) {
  const { orgSlug, slug, id } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "VIEWER");
  if ("error" in access) return access.error;
  return getEntryRotation(access.access, id);
}

export async function PATCH(req: Request, { params }: Params) {
  const { orgSlug, slug, id } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "EDITOR", { feature: "team_vault" });
  if ("error" in access) return access.error;
  return patchEntryRotation(access.access, id, req);
}

export async function POST(req: Request, { params }: Params) {
  const { orgSlug, slug, id } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "EDITOR", { feature: "team_vault" });
  if ("error" in access) return access.error;
  return rotateEntry(access.access, id, req);
}
