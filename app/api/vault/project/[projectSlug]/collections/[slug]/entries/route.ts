import { requireProjectCollectionAccess } from "@/lib/vault-access";
import { listEntries, createEntry } from "@/lib/vault-entry-handlers";

type Params = {
  params: Promise<{ projectSlug: string; slug: string }>;
};

export async function GET(req: Request, { params }: Params) {
  const { projectSlug, slug } = await params;
  const access = await requireProjectCollectionAccess(projectSlug, slug, "VIEWER");
  if ("error" in access) return access.error;
  return listEntries(access.access, req);
}

export async function POST(req: Request, { params }: Params) {
  const { projectSlug, slug } = await params;
  const access = await requireProjectCollectionAccess(projectSlug, slug, "EDITOR", { feature: "team_vault" });
  if ("error" in access) return access.error;
  return createEntry(access.access, req);
}
