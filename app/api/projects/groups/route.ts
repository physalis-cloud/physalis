import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getCurrentOrgSlug,
  readJson,
  requireOrgMember,
  requireUser,
} from "@/lib/api";
import { logAction } from "@/lib/audit";

// GET /api/projects/groups[?org=<slug>] — liste les groupes de l'org courante.
export async function GET(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const url = new URL(req.url);
  const orgSlug = url.searchParams.get("org") ?? (await getCurrentOrgSlug(user.id));
  if (!orgSlug) return NextResponse.json({ groups: [], orgSlug: null });

  const access = await requireOrgMember(orgSlug);
  if ("error" in access) return access.error;

  const groups = await prisma.projectGroup.findMany({
    where: { organizationId: access.organization.id },
    select: {
      id: true,
      name: true,
      position: true,
      _count: { select: { projects: true } },
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ groups, orgSlug });
}

// POST /api/projects/groups — crée un groupe. Body : { name, organization? }.
export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const body = (await readJson(req)) as
    | { name?: string; organization?: string }
    | null;
  if (!body || typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  const name = body.name.trim().slice(0, 80);

  const orgSlug = body.organization?.trim() || (await getCurrentOrgSlug(user.id));
  if (!orgSlug) {
    return NextResponse.json(
      { error: "No organization context" },
      { status: 400 },
    );
  }

  // MEMBER+ peut créer un groupe (aligné sur la création de projet).
  const access = await requireOrgMember(orgSlug, "MEMBER");
  if ("error" in access) return access.error;

  const agg = await prisma.projectGroup.aggregate({
    where: { organizationId: access.organization.id },
    _max: { position: true },
  });
  const position = (agg._max.position ?? -1) + 1;

  const group = await prisma.projectGroup.create({
    data: { name, organizationId: access.organization.id, position },
    select: { id: true, name: true, position: true },
  });

  logAction({
    action: "PROJECT_GROUP_CREATE",
    actor: { kind: "user", userId: user.id, email: user.email },
    organizationId: access.organization.id,
    targetType: "ProjectGroup",
    targetId: group.id,
    metadata: { name: group.name },
    req,
  });

  return NextResponse.json({ group }, { status: 201 });
}
