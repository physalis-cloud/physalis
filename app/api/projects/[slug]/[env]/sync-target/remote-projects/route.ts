// Picker : liste les projets distants accessibles par le token d'une connexion
// de sync (ex. GET /v9/projects côté Vercel). Réservé OWNER projet (config).
//   GET ?connectionId=<ciConnectionId>
//
// Garde-fou #1 : on ne liste que les projets que le token possède déjà (le choix
// de externalProjectId est donc borné au périmètre du token).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { requireEnvironment } from "@/lib/api";
import { getConnector } from "@/lib/sync/connectors";
import { isSyncProvider, syncTokenKind } from "@/lib/sync/types";

type Params = { params: Promise<{ slug: string; env: string }> };

export async function GET(req: Request, { params }: Params) {
  const { slug, env } = await params;
  const access = await requireEnvironment(slug, env, "OWNER", { feature: "outbound_sync" });
  if ("error" in access) return access.error;

  const connectionId = new URL(req.url).searchParams.get("connectionId")?.trim();
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId requis" }, { status: 400 });
  }

  const conn = await prisma.ciConnection.findFirst({
    where: { id: connectionId, organizationId: access.project.organizationId },
    select: {
      provider: true,
      issuer: true,
      secrets: { select: { kind: true, encryptedValue: true, iv: true, tag: true } },
    },
  });
  if (!conn || !isSyncProvider(conn.provider)) {
    return NextResponse.json({ error: "Connexion de sync invalide" }, { status: 400 });
  }

  const connector = getConnector(conn.provider);
  if (!connector) {
    return NextResponse.json({ error: "Provider non supporté" }, { status: 400 });
  }

  const kind = syncTokenKind(conn.provider)!;
  const tokenRow = conn.secrets.find((s) => s.kind === kind);
  if (!tokenRow) {
    return NextResponse.json({ error: "Token absent sur la connexion" }, { status: 400 });
  }
  const token = decrypt({
    encryptedValue: tokenRow.encryptedValue,
    iv: tokenRow.iv,
    tag: tokenRow.tag,
  });

  try {
    // Providers multi-niveaux (Railway) : renvoyer l'arbre projet→env→service.
    if (connector.listResourceTree) {
      const tree = await connector.listResourceTree(token, { teamId: conn.issuer });
      return NextResponse.json({ tree });
    }
    const projects = await connector.listProjects(token, { teamId: conn.issuer });
    return NextResponse.json({ projects });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log serveur (diagnostic) : le message exact de la plateforme (ex. Railway).
    console.error(`[sync] remote-projects ${conn.provider} error:`, msg);
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 502 });
  }
}
