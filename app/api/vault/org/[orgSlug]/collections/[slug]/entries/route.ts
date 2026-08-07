import { requireOrgCollectionAccess } from "@/lib/vault-access";
import { listEntries, createEntry } from "@/lib/vault-entry-handlers";

type Params = { params: Promise<{ orgSlug: string; slug: string }> };

export async function GET(req: Request, { params }: Params) {
  const { orgSlug, slug } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "VIEWER");
  if ("error" in access) return access.error;
  return listEntries(access.access, req);
}

export async function POST(req: Request, { params }: Params) {
  const { orgSlug, slug } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "EDITOR", { feature: "team_vault" });
  if ("error" in access) return access.error;
  return createEntry(access.access, req);
}
