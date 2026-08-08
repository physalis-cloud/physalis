// /api/secret-requests/[id]/import
//
// Body : { value }
// Importe le secret déchiffré (par l'admin localement). Chiffre via
// ENCRYPTION_KEY (pattern standard), marque importedAt et efface le ciphertext.
//
// DEUX destinations, selon ce qui a été renseigné à la création :
//
//   projet + environnement + clé  → le Secret d'environnement (upsert).
//   projet seul                   → le coffre du PROJET, dans une collection
//                                   dédiée créée à la volée.
//
// Le projet, lui, est toujours requis : c'est lui qui porte l'autorisation.
// Une demande sans projet reste consultable (« Révéler ») mais n'a pas de
// destination — c'est le cas « je veux juste lire ce secret ».
//
// ⚠️ Les deux branches n'ont PAS la même garde. Écrire un secret
// d'environnement passe par `requireEnvironment` (rôle projet) ; écrire dans un
// coffre d'équipe passe par `requireProjectScope` + le gate de plan
// `team_vault`. Les deux droits ne se recouvrent pas, d'où le préflight
// `/api/secret-requests/vault-target` que le dialogue de création interroge
// AVANT d'annoncer la destination à l'utilisateur.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { readJson, requireEnvironment, requireUser } from "@/lib/api";
import { requireProjectScope } from "@/lib/vault-access";
import {
  IMPORT_COLLECTION_NAME,
  IMPORT_COLLECTION_SLUG,
} from "@/lib/secret-request";
import { isValidSecretKey } from "@/lib/validation";
import { logAction } from "@/lib/audit";
import { deleteTokenIndex } from "@/lib/token-index";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const userRes = await requireUser();
  if ("error" in userRes) return userRes.error;
  const { id } = await params;

  const body = (await readJson(req)) as { value?: string } | null;
  if (!body || typeof body.value !== "string" || body.value.length === 0) {
    return NextResponse.json({ error: "value is required" }, { status: 400 });
  }
  const value = body.value;

  const sr = await prisma.secretRequest.findUnique({
    where: { id },
    select: {
      id: true,
      tokenHash: true,
      label: true,
      organizationId: true,
      projectId: true,
      project: { select: { id: true, name: true, slug: true } },
      environmentName: true,
      secretKey: true,
      importedAt: true,
      revokedAt: true,
      submittedAt: true,
    },
  });
  if (!sr) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (sr.revokedAt) {
    return NextResponse.json({ error: "Revoked" }, { status: 410 });
  }
  if (!sr.submittedAt) {
    return NextResponse.json(
      { error: "Secret not yet submitted" },
      { status: 400 },
    );
  }
  // Le PROJET reste obligatoire : c'est lui qui porte l'autorisation, quelle
  // que soit la destination. Sans projet, la demande est en lecture seule.
  if (!sr.projectId || !sr.project) {
    return NextResponse.json(
      { error: "Import target (project) not specified at creation" },
      { status: 400 },
    );
  }
  // Une cible d'environnement à moitié renseignée n'est pas une cible : on
  // refuse plutôt que de deviner. Le dialogue de création l'interdit désormais,
  // mais des demandes antérieures peuvent être dans cet état.
  if (Boolean(sr.environmentName) !== Boolean(sr.secretKey)) {
    return NextResponse.json(
      { error: "Import target incomplete (environment and key go together)" },
      { status: 400 },
    );
  }
  // Idempotence : `importedAt` marque la fin de vie de la demande. Sans cette
  // garde, un second appel dupliquerait l'entrée dans le coffre du projet (la
  // branche environnement, elle, est un upsert donc naturellement idempotente).
  if (sr.importedAt) {
    return NextResponse.json({ error: "Already imported" }, { status: 409 });
  }

  const payload = encrypt(value);

  // Cleanup commun aux deux destinations : on n'a plus besoin du ciphertext.
  const closeRequest = prisma.secretRequest.update({
    where: { id: sr.id },
    data: {
      importedAt: new Date(),
      encryptedSecret: null,
      secretIv: null,
      ephemeralPublicKey: null,
    },
  });

  if (sr.environmentName && sr.secretKey) {
    // ─── Destination 1 : secret d'environnement ──────────────────────────
    if (!isValidSecretKey(sr.secretKey)) {
      return NextResponse.json(
        { error: "Invalid stored secretKey format" },
        { status: 400 },
      );
    }

    // Autorisation : importer un secret EST une écriture projet → même garde que
    // toute autre écriture de secret. requireEnvironment applique
    // requireProjectMember(EDITOR) — `hidden` compris (règle 2) — puis résout
    // l'environnement cible. L'ancien check org-role (OWNER/ADMIN/DEV de l'org,
    // `hidden` jamais lu) laissait un DEV MASQUÉ du projet écrire un secret dans
    // un projet que l'UI lui ferme : élévation de privilège.
    const access = await requireEnvironment(
      sr.project.slug,
      sr.environmentName,
      "EDITOR",
    );
    if ("error" in access) return access.error;
    const env = access.environment;

    await prisma.$transaction([
      prisma.secret.upsert({
        where: {
          environmentId_key: {
            environmentId: env.id,
            key: sr.secretKey,
          },
        },
        create: {
          key: sr.secretKey,
          environmentId: env.id,
          ...payload,
        },
        update: payload,
      }),
      closeRequest,
    ]);

    await afterImport(sr.tokenHash);
    logAction({
      action: "SECRET_REQUEST_IMPORTED",
      actor: { kind: "user", userId: userRes.user.id, email: userRes.user.email },
      organizationId: sr.organizationId,
      projectId: sr.projectId,
      targetType: "Secret",
      secretKey: sr.secretKey,
      metadata: {
        label: sr.label,
        environmentName: sr.environmentName,
        secretRequestId: sr.id,
        destination: "environment",
      },
      req,
    });

    return NextResponse.json({ ok: true, destination: "environment" });
  }

  // ─── Destination 2 : coffre du PROJET ─────────────────────────────────
  // Repli quand la demande n'a pas de cible d'environnement. Autorisation
  // DIFFÉRENTE de la branche ci-dessus : écrire dans un coffre d'équipe passe
  // par `requireProjectScope` (EDITOR + gate de plan `team_vault`), pas par
  // `requireEnvironment`. Les deux droits ne se recouvrent pas — d'où le
  // préflight du dialogue de création, qui vérifie CELUI-CI avant de promettre
  // la destination.
  const scope = await requireProjectScope(sr.project.slug, "EDITOR", {
    feature: "team_vault",
  });
  if ("error" in scope) return scope.error;

  // Collection dédiée, créée à la volée au premier import qui en a besoin.
  // `upsert` plutôt que find-then-create : deux imports concurrents sur un
  // projet neuf se battraient sinon sur la contrainte d'unicité.
  const collection = await prisma.teamVaultCollection.upsert({
    where: {
      projectId_slug: {
        projectId: scope.projectId,
        slug: IMPORT_COLLECTION_SLUG,
      },
    },
    create: {
      projectId: scope.projectId,
      slug: IMPORT_COLLECTION_SLUG,
      name: IMPORT_COLLECTION_NAME,
    },
    update: {},
    select: { id: true, name: true, slug: true },
  });

  // Le coffre d'équipe n'a pas de charge utile libre (pas de type NOTE/LIST,
  // contrairement au coffre perso) : le secret va dans le champ mot de passe,
  // et le label de la demande sert de nom d'entrée.
  await prisma.$transaction([
    prisma.teamVaultEntry.create({
      data: {
        collectionId: collection.id,
        name: sr.label,
        encryptedPassword: payload.encryptedValue,
        passwordIv: payload.iv,
        passwordTag: payload.tag,
      },
    }),
    closeRequest,
  ]);

  await afterImport(sr.tokenHash);
  logAction({
    action: "SECRET_REQUEST_IMPORTED",
    actor: { kind: "user", userId: userRes.user.id, email: userRes.user.email },
    organizationId: sr.organizationId,
    projectId: sr.projectId,
    targetType: "TeamVaultEntry",
    metadata: {
      label: sr.label,
      collectionSlug: collection.slug,
      secretRequestId: sr.id,
      destination: "project_vault",
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    destination: "project_vault",
    collectionName: collection.name,
  });
}

/** Cleanup admin.token_index — l'import marque la fin de vie du token. */
async function afterImport(tokenHash: string): Promise<void> {
  await deleteTokenIndex(tokenHash).catch((err) => {
    console.error("[secret-requests] failed to delete token_index:", err);
  });
}
