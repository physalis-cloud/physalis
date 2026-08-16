// Chantier "Déploiement mobile" — Phase 1 (socle credentials).
// Cf. documentation/plans/deploiement-mobile.md §4.4.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withTenantSchema } from "@/lib/tenant";
import { encrypt } from "@/lib/crypto";
import { requireProjectMember, readJson } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";
import { createMobileCredentialVersion } from "@/lib/mobile-versioning";
import { extractExpiresAt } from "@/lib/mobile-expiry";
import {
  MOBILE_CREDENTIAL_MAX_BYTES,
  MOBILE_EXPIRY_KINDS,
  isStrictBase64,
  isValidMobileCredentialKind,
} from "@/lib/mobile-credentials";
import { sha256Hex } from "@/lib/mobile-fingerprint";

type Params = { params: Promise<{ slug: string; appId: string }> };

async function loadApp(projectId: string, appId: string) {
  return prisma.mobileApp.findFirst({
    where: { id: appId, projectId },
    select: { id: true },
  });
}

/** Métadonnées seulement — jamais encryptedValue/iv/tag (même discipline que
 *  GET /secrets). */
export async function GET(_req: Request, { params }: Params) {
  const { slug, appId } = await params;
  const access = await requireProjectMember(slug, "VIEWER", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const app = await loadApp(access.project.id, appId);
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const credentials = await prisma.mobileCredential.findMany({
    where: { appId: app.id },
    select: {
      id: true,
      kind: true,
      filename: true,
      sizeBytes: true,
      sha256: true,
      expiresAt: true,
      expiryAlertedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { kind: "asc" },
  });

  return NextResponse.json({ credentials });
}

/**
 * Import ou remplacement (upsert par `(appId, kind)`), avec versioning de
 * l'ancienne valeur si elle existe — même schéma que POST /secrets.
 */
export async function POST(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  const access = await requireProjectMember(slug, "EDITOR", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const app = await loadApp(access.project.id, appId);
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req)) as
    | {
        kind?: string;
        valueBase64?: string;
        filename?: string | null;
        passphrase?: string;
      }
    | null;

  if (
    !body ||
    typeof body.kind !== "string" ||
    typeof body.valueBase64 !== "string" ||
    !body.valueBase64
  ) {
    return NextResponse.json(
      { error: "kind and valueBase64 are required" },
      { status: 400 },
    );
  }
  if (!isValidMobileCredentialKind(body.kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }

  // La valeur est TOUJOURS du base64 (plan §4.4), y compris pour un champ
  // texte — un seul chemin de codage. On décode pour mesurer/hasher/extraire
  // l'expiration, mais c'est bien la chaîne base64 d'origine qui est chiffrée.
  // Validation AVANT décodage : `Buffer.from(…, "base64")` ne lève jamais, il
  // ignore silencieusement les caractères invalides — un `try/catch` autour
  // n'attrapait donc rien et laissait passer une valeur tronquée.
  if (!isStrictBase64(body.valueBase64)) {
    return NextResponse.json({ error: "valueBase64 is not valid base64" }, { status: 400 });
  }
  const decoded = Buffer.from(body.valueBase64, "base64");
  if (decoded.length === 0) {
    return NextResponse.json({ error: "valueBase64 is empty" }, { status: 400 });
  }
  if (decoded.length > MOBILE_CREDENTIAL_MAX_BYTES) {
    return NextResponse.json(
      { error: `Value exceeds the ${MOBILE_CREDENTIAL_MAX_BYTES} bytes cap` },
      { status: 413 },
    );
  }

  const existing = await prisma.mobileCredential.findUnique({
    where: { appId_kind: { appId: app.id, kind: body.kind } },
    select: { id: true, encryptedValue: true, iv: true, tag: true },
  });

  const payload = encrypt(body.valueBase64);
  const sha256 = sha256Hex(decoded);
  const expiresAt = await extractExpiresAt(body.kind, decoded, body.passphrase);

  const credential = await withTenantSchema(access.tenantSlug, async (tx) => {
    if (existing) {
      await createMobileCredentialVersion({
        tx,
        credentialId: existing.id,
        encryptedValue: existing.encryptedValue,
        iv: existing.iv,
        tag: existing.tag,
        createdById: access.user.id,
      });
    }
    return tx.mobileCredential.upsert({
      where: { appId_kind: { appId: app.id, kind: body.kind! } },
      create: {
        appId: app.id,
        kind: body.kind!,
        filename: body.filename?.trim() || null,
        sizeBytes: decoded.length,
        sha256,
        expiresAt,
        ...payload,
      },
      update: {
        filename: body.filename?.trim() || null,
        sizeBytes: decoded.length,
        sha256,
        expiresAt,
        // Un remplacement efface l'alerte d'expiration précédente : la
        // nouvelle valeur a sa propre échéance, l'ancien rappel ne s'applique
        // plus (même motif que ProjectBackupConfig.overdueAlertedAt).
        expiryAlertedAt: null,
        ...payload,
      },
      select: {
        id: true,
        kind: true,
        filename: true,
        sizeBytes: true,
        sha256: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  logAction({
    action: existing ? "MOBILE_CREDENTIAL_REPLACE" : "MOBILE_CREDENTIAL_IMPORT",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileCredential",
    targetId: credential.id,
    metadata: { appId: app.id, kind: credential.kind, sha256: credential.sha256 },
    req,
  });

  // L'import RÉUSSIT même quand la date n'a pas pu être lue (le matériel est
  // stocké et chiffré) — mais il faut le dire, sinon l'absence de date se
  // confond avec « ce type n'en a pas ». Cas typique : passphrase du .p12
  // absente ou erronée, `Mac verify error` côté openssl.
  const expiryUnread =
    MOBILE_EXPIRY_KINDS.has(credential.kind) && credential.expiresAt === null;

  return NextResponse.json(
    { credential, expiryUnread },
    { status: existing ? 200 : 201 },
  );
}
