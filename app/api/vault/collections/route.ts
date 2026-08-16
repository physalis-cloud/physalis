// /api/vault/collections — liste/création des collections perso V2.0.
//
// Strict scoping : un user ne voit JAMAIS les collections d'un autre.
// Pas de partage (mirror simplifié de TeamVaultCollection sans members).
// Cf. documentation/plans/done/coffre-personnel-v2.md §Collections.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser, slugify } from "@/lib/api";
import { logAction } from "@/lib/audit";

const NAME_MAX = 80;

export async function GET() {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const collections = await prisma.vaultCollection.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { entries: true } },
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      entryCount: c._count.entries,
    })),
  });
}

export async function POST(req: Request) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { user } = userRes;

  const body = (await readJson(req)) as { name?: string } | null;
  const name = String(body?.name ?? "").trim();
  if (!name || name.length > NAME_MAX) {
    return NextResponse.json(
      { error: `name required (1-${NAME_MAX} chars)` },
      { status: 400 },
    );
  }

  const slug = slugify(name);
  if (!slug) {
    return NextResponse.json(
      { error: "name produces an empty slug" },
      { status: 400 },
    );
  }

  const conflict = await prisma.vaultCollection.findUnique({
    where: { userId_slug: { userId: user.id, slug } },
    select: { id: true },
  });
  if (conflict) {
    return NextResponse.json(
      { error: "A collection with this name already exists" },
      { status: 409 },
    );
  }

  const created = await prisma.vaultCollection.create({
    data: { userId: user.id, name, slug },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  logAction({
    action: "VAULT_PERSONAL_COLLECTION_CREATE",
    actor: { kind: "user", userId: user.id, email: user.email },
    targetType: "VaultCollection",
    targetId: created.id,
    metadata: { name, slug },
    req,
  });

  return NextResponse.json(
    { collection: { ...created, entryCount: 0 } },
    { status: 201 },
  );
}
