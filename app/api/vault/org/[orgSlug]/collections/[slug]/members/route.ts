// /api/vault/org/[orgSlug]/collections/[slug]/members — liste/ajout des
// membres explicites d'une collection org. Reserve aux OWNER de la
// collection (qui inclut OrgADMIN+ via implicite).
//
// Note : les TeamVaultMember n'existent que pour les collections ORG.
// Sur les collections projet, le RBAC est herite — les routes /project/*
// n'exposent meme pas cet endpoint.

import { NextResponse } from "next/server";
import type { VaultRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireOrgCollectionAccess } from "@/lib/vault-access";

type Params = { params: Promise<{ orgSlug: string; slug: string }> };

const VALID_ROLES = new Set<VaultRole>(["OWNER", "EDITOR", "VIEWER"]);

export async function GET(_req: Request, { params }: Params) {
  const { orgSlug, slug } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "OWNER");
  if ("error" in access) return access.error;

  const members = await prisma.teamVaultMember.findMany({
    where: { collectionId: access.access.collection.id },
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { id: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    members: members.map((m) => ({
      id: m.id,
      userId: m.user.id,
      email: m.user.email,
      role: m.role,
      createdAt: m.createdAt,
    })),
  });
}

export async function POST(req: Request, { params }: Params) {
  const { orgSlug, slug } = await params;
  const access = await requireOrgCollectionAccess(orgSlug, slug, "OWNER", { feature: "team_vault" });
  if ("error" in access) return access.error;

  const body = (await readJson(req)) as
    | { email?: string; role?: string }
    | null;
  const email = String(body?.email ?? "").trim().toLowerCase();
  const role = String(body?.role ?? "VIEWER") as VaultRole;
  if (!email || !VALID_ROLES.has(role)) {
    return NextResponse.json(
      { error: "email and role (OWNER|EDITOR|VIEWER) required" },
      { status: 400 },
    );
  }

  // L'utilisateur a inviter doit deja etre dans l'organisation.
  const target = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      organizations: {
        where: { organizationId: access.access.organizationId! },
        select: { id: true },
      },
    },
  });
  if (!target || target.organizations.length === 0) {
    return NextResponse.json(
      { error: "User is not a member of this organization" },
      { status: 400 },
    );
  }

  const conflict = await prisma.teamVaultMember.findUnique({
    where: {
      collectionId_userId: {
        collectionId: access.access.collection.id,
        userId: target.id,
      },
    },
    select: { id: true },
  });
  if (conflict) {
    return NextResponse.json(
      { error: "User is already a member of this collection" },
      { status: 409 },
    );
  }

  const member = await prisma.teamVaultMember.create({
    data: {
      collectionId: access.access.collection.id,
      userId: target.id,
      role,
    },
    select: {
      id: true,
      role: true,
      createdAt: true,
      user: { select: { id: true, email: true } },
    },
  });

  logAction({
    action: "VAULT_MEMBER_ADD",
    actor: {
      kind: "user",
      userId: access.access.user.id,
      email: access.access.user.email,
    },
    organizationId: access.access.organizationId,
    targetType: "TeamVaultMember",
    targetId: member.id,
    metadata: {
      collectionId: access.access.collection.id,
      collectionName: access.access.collection.name,
      addedUserEmail: email,
      role,
    },
    req,
  });

  return NextResponse.json(
    {
      member: {
        id: member.id,
        userId: member.user.id,
        email: member.user.email,
        role: member.role,
        createdAt: member.createdAt,
      },
    },
    { status: 201 },
  );
}
