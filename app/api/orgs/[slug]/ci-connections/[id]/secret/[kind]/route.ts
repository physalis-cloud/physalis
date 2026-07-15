import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { requireOrgMember } from "@/lib/api";
import { CI_SECRET_KIND } from "@/lib/ci-connection";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; id: string; kind: string }> };

const KINDS = new Set<string>(Object.values(CI_SECRET_KIND));

/**
 * Reveal d'un secret de connexion CI/CD (valeur déchiffrée). DEV+ — même règle
 * que le reveal des OrgSecrets. La connexion doit appartenir à l'org.
 */
export async function GET(req: Request, { params }: Params) {
  const { slug, id, kind } = await params;
  const access = await requireOrgMember(slug, "DEV");
  if ("error" in access) return access.error;

  if (!KINDS.has(kind)) {
    return NextResponse.json({ error: "Unknown secret kind" }, { status: 400 });
  }

  // Vérifie l'appartenance de la connexion à l'org avant de lire le secret.
  const conn = await prisma.ciConnection.findFirst({
    where: { id, organizationId: access.organization.id },
    select: { id: true, name: true },
  });
  if (!conn) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const secret = await prisma.ciConnectionSecret.findUnique({
    where: { connectionId_kind: { connectionId: id, kind } },
    select: { encryptedValue: true, iv: true, tag: true },
  });
  if (!secret) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const value = decrypt({
    encryptedValue: secret.encryptedValue,
    iv: secret.iv,
    tag: secret.tag,
  });

  logAction({
    action: "ORG_SECRET_REVEAL",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.organization.id,
    targetType: "CiConnection",
    targetId: id,
    metadata: { ciConnection: conn.name, kind },
    req,
  });

  return NextResponse.json({ kind, value });
}
