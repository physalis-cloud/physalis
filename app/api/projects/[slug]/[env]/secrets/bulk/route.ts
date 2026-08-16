// PATCH /api/projects/[slug]/[env]/secrets/bulk — edition en masse de la
// METADATA d'un lot de secrets. Aujourd'hui : la categorie uniquement.
//
// Body : { keys: string[], category: string | null }
//
// Pourquoi une route dediee plutot que N appels au PATCH unitaire :
//   - une seule entree d'audit pour un geste utilisateur unique
//     (ranger 12 cles), au lieu de 12 lignes a recoller a la lecture ;
//   - un seul aller-retour, donc pas d'etat mi-range si l'onglet est
//     ferme au milieu.
//
// Le segment statique `bulk` prime sur `[key]` dans le routeur Next, sans
// collision possible : une cle de secret matche [A-Z][A-Z0-9_]{0,127},
// elle ne peut donc jamais s'ecrire `bulk` en minuscules.
//
// Pas de triggerSync ici : aucune VALEUR ne change, et la categorie n'est
// qu'une organisation d'affichage cote Physalis — rien a repousser vers
// les plateformes cibles.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireEnvironment } from "@/lib/api";
import { isValidCategory, type SecretCategory } from "@/lib/categories";
import { logAction } from "@/lib/audit";

type Params = { params: Promise<{ slug: string; env: string }> };

// Garde-fou : au-dela, c'est un script, pas un geste d'interface.
const MAX_KEYS = 500;

export async function PATCH(req: Request, { params }: Params) {
  const { slug, env } = await params;
  const access = await requireEnvironment(slug, env, "EDITOR");
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | { keys?: unknown; category?: unknown }
    | null;

  if (!body || !Array.isArray(body.keys)) {
    return NextResponse.json(
      { error: "keys (string[]) is required" },
      { status: 400 },
    );
  }
  const keys = Array.from(
    new Set(body.keys.filter((k): k is string => typeof k === "string")),
  );
  if (keys.length === 0) {
    return NextResponse.json({ error: "keys must not be empty" }, { status: 400 });
  }
  if (keys.length > MAX_KEYS) {
    return NextResponse.json(
      { error: `Too many keys (max ${MAX_KEYS})` },
      { status: 413 },
    );
  }

  // Meme regle que le PATCH unitaire : null / "" / absent → sans categorie.
  let category: SecretCategory | null = null;
  if (
    body.category !== null &&
    body.category !== "" &&
    body.category !== undefined
  ) {
    if (!isValidCategory(body.category)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    category = body.category;
  }

  // On ne touche QUE les cles de cet environnement : le `where` porte
  // l'isolation, une cle d'un autre projet passee dans le body ne
  // matchera simplement pas.
  const targets = await prisma.secret.findMany({
    where: { environmentId: access.environment.id, key: { in: keys } },
    select: { key: true, category: true },
  });
  const moved = targets.filter((s) => s.category !== category).map((s) => s.key);

  if (moved.length === 0) {
    return NextResponse.json({ updated: 0, keys: [] });
  }

  await prisma.secret.updateMany({
    where: { environmentId: access.environment.id, key: { in: moved } },
    data: { category },
  });

  logAction({
    action: "SECRET_UPDATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    environmentId: access.environment.id,
    targetType: "Secret",
    targetId: null,
    metadata: {
      bulk: true,
      changedFields: ["category"],
      category,
      updated: moved.length,
      updatedKeys: moved,
      // Cles envoyees mais absentes de l'environnement (secret supprime
      // dans un autre onglet, par exemple) — utile a l'enquete.
      missing: keys.filter((k) => !targets.some((t) => t.key === k)),
    },
    req,
  });

  return NextResponse.json({ updated: moved.length, keys: moved });
}
