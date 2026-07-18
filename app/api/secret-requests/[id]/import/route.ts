// /api/secret-requests/[id]/import
//
// Body : { value }
// Importe le secret déchiffré (par l'admin localement) dans le Secret cible
// du projet/environnement/clé. Chiffre via ENCRYPTION_KEY (pattern standard).
// Marque importedAt + efface le ciphertext (cleanup post-import).
//
// Pré-requis : la SecretRequest doit avoir projectId + environmentName +
// secretKey définis. Sinon 400 (l'admin choisit explicitement la cible
// au moment de la création).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { readJson, requireEnvironment, requireUser } from "@/lib/api";
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
  if (!sr.projectId || !sr.project || !sr.environmentName || !sr.secretKey) {
    return NextResponse.json(
      { error: "Import target (project + environment + key) not specified at creation" },
      { status: 400 },
    );
  }
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

  const payload = encrypt(value);

  // Upsert le Secret + cleanup la SecretRequest dans une transaction.
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
    prisma.secretRequest.update({
      where: { id: sr.id },
      data: {
        importedAt: new Date(),
        // Cleanup post-import : on n'a plus besoin du ciphertext.
        encryptedSecret: null,
        secretIv: null,
        ephemeralPublicKey: null,
      },
    }),
  ]);

  // Cleanup admin.token_index — l'import marque la fin de vie du token.
  await deleteTokenIndex(sr.tokenHash).catch((err) => {
    console.error("[secret-requests] failed to delete token_index:", err);
  });

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
    },
    req,
  });

  return NextResponse.json({ ok: true });
}
