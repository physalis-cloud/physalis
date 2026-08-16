// Chantier "Déploiement mobile" — Phase 7 : générer le matériel de signature.
// Cf. documentation/plans/deploiement-mobile.md §5.5.
//
// Android : autonome, aucun compte, aucun appel réseau.
// iOS : à partir de la SEULE clé `.p8` déjà importée — Apple ne l'émet que dans
// son portail, c'est le point d'amorçage irréductible. Tout le reste (paire,
// CSR, certificat de distribution, `.p12`, profil) se fait sans Mac.
//
// ⚠️ Écriture DESTRUCTIVE par nature : elle remplace du matériel de signature.
// D'où le `replace` explicite exigé quand du matériel existe déjà — et
// l'avertissement asymétrique de §6.1 : côté Android il s'agit de la clé
// d'UPLOAD (réinitialisable par Google si Play App Signing est actif), pas de
// la clé de signature d'app.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withTenantSchema } from "@/lib/tenant";
import { encrypt, decrypt } from "@/lib/crypto";
import { requireProjectMember, readJson } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { hasDevPrivileges } from "@/lib/roles";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";
import { createMobileCredentialVersion } from "@/lib/mobile-versioning";
import { extractExpiresAt } from "@/lib/mobile-expiry";
import { sha256Hex } from "@/lib/mobile-fingerprint";
import {
  AscApiError,
  generateAndroidUploadKeystore,
  generateIosSigningMaterial,
  matchVaultCertificate,
  regenerateIosProfile,
} from "@/lib/mobile-generate";
import { ascListDistributionCertificates } from "@/lib/mobile-store-api";
import type { GeneratedCredential } from "@/lib/mobile-generate";

type Params = { params: Promise<{ slug: string; appId: string }> };

/** Générer coûte de la crypto, et côté iOS un SLOT de certificat Apple (2 ou 3
 *  par compte). Le plafond est volontairement bas : c'est un geste rare. */
const GENERATE_LIMIT = { max: 5, windowMs: 10 * 60_000 };

/** Le matériel dont l'existence rend la génération destructive, par plateforme. */
const PIVOT_KIND: Record<string, string> = {
  android: "android_keystore",
  ios: "ios_p12",
};

export async function POST(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  // Plus haut que l'import (EDITOR) : générer REMPLACE le matériel de signature
  // d'une application publiée, et côté iOS consomme un slot de certificat chez
  // Apple. Même barre que la création d'une policy — OWNER projet ou OrgDEV.
  const access = await requireProjectMember(slug, "VIEWER", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;
  if (!(access.role === "OWNER" || hasDevPrivileges(access.orgRole))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = rateLimit(req, "mobile-generate", GENERATE_LIMIT);
  if (limited) return limited;

  const app = await prisma.mobileApp.findFirst({
    where: { id: appId, projectId: access.project.id },
    select: {
      id: true,
      platform: true,
      bundleId: true,
      displayName: true,
      vendorTeamId: true,
    },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await readJson(req)) as {
    replace?: boolean;
    alias?: string;
    /** "full" (défaut) = tout le matériel ; "profile" = RÉUTILISER le
     *  certificat en service et ne régénérer que le profil (iOS seulement). */
    mode?: string;
  } | null;
  const replace = body?.replace === true;
  const profileOnly = body?.mode === "profile";

  const pivot = PIVOT_KIND[app.platform];
  if (!pivot) {
    return NextResponse.json(
      { error: "Génération non supportée pour cette plateforme" },
      { status: 400 },
    );
  }

  // Garde anti-écrasement. Un remplacement reste POSSIBLE (une clé compromise
  // doit pouvoir être remplacée), mais jamais par accident : l'ancienne valeur
  // part en version, et l'appelant doit l'avoir demandé explicitement.
  const existingPivot = await prisma.mobileCredential.findUnique({
    where: { appId_kind: { appId: app.id, kind: pivot } },
    select: { id: true },
  });
  if (existingPivot && !replace && !profileOnly) {
    return NextResponse.json(
      {
        error: "already_provisioned",
        // Message porté par l'UI, mais on le dit aussi ici : cette route est
        // appelable par un humain avec curl, et l'avertissement compte.
        detail:
          app.platform === "android"
            ? "Cette application a déjà un keystore. En générer un nouveau ne change PAS la clé de signature d'app détenue par Google, seulement la clé d'upload — mais tout pipeline gardant l'ancienne échouera."
            : "Cette application a déjà un certificat de distribution. En générer un nouveau consomme un slot chez Apple et invalide les profils liés à l'ancien.",
      },
      { status: 409 },
    );
  }

  let generated: GeneratedCredential[];
  let summary: Record<string, string>;

  try {
    if (app.platform === "android") {
      const result = await generateAndroidUploadKeystore({
        displayName: app.displayName,
        bundleId: app.bundleId,
        alias: body?.alias,
      });
      generated = result.credentials;
      summary = { ...result.summary };
    } else {
      // Le `.p8` est le seul point d'amorçage : Apple ne l'émet que dans son
      // portail, jamais par API. Sans lui, la chaîne ne peut pas démarrer.
      const auth = await loadAscAuth(app.id);
      if (!auth) {
        return NextResponse.json(
          {
            error: "asc_key_missing",
            detail:
              "Importez d'abord la clé d'API App Store Connect (.p8), son Key ID et son Issuer ID. Apple ne les émet que dans son portail.",
          },
          { status: 400 },
        );
      }
      if (profileOnly) {
        // Réemploi (§5.5) : le cas le plus fréquent, et celui qui évite de
        // brûler un slot. Un profil vaut 1 an, un certificat aussi, mais leurs
        // dates ne coïncident pas — quand seul le profil expire, tout
        // régénérer consommerait un certificat pour rien.
        const p12 = await loadCredential(app.id, "ios_p12");
        const p12Password =
          (await loadCredential(app.id, "ios_p12_password"))?.toString("utf8") ?? "";
        if (!p12) {
          return NextResponse.json(
            {
              error: "no_certificate_to_reuse",
              detail:
                "Aucun certificat de distribution dans le coffre : il n'y a rien à réutiliser. Générez le matériel complet.",
            },
            { status: 400 },
          );
        }
        const certificates = await ascListDistributionCertificates(auth);
        const inUse = await matchVaultCertificate(certificates, p12, p12Password);
        if (!inUse) {
          // Le `.p12` du coffre ne correspond à aucun certificat vivant du
          // compte : il a été révoqué, ou émis ailleurs. Réutiliser son id
          // serait impossible — Apple refuserait le profil.
          return NextResponse.json(
            {
              error: "no_certificate_to_reuse",
              detail:
                "Le certificat du coffre ne correspond à aucun certificat actif de ce compte Apple (révoqué, ou émis sur un autre compte).",
            },
            { status: 409 },
          );
        }
        const result = await regenerateIosProfile(
          auth,
          { displayName: app.displayName, bundleId: app.bundleId },
          inUse.id,
        );
        generated = result.credentials;
        summary = result.summary;
      } else {
        const result = await generateIosSigningMaterial(auth, {
          displayName: app.displayName,
          bundleId: app.bundleId,
        });
        if (!result.ok) {
          return NextResponse.json(
            { error: result.reason, certificates: result.certificates ?? [] },
            { status: 409 },
          );
        }
        generated = result.credentials;
        summary = { ...result.summary };
      }
    }
  } catch (err) {
    // Apple est explicite et actionnable ("There is no App ID with ID ...") :
    // son message vaut mieux que n'importe quelle reformulation de notre part.
    if (err instanceof AscApiError) {
      return NextResponse.json(
        { error: "asc_error", detail: err.info.detail },
        { status: 502 },
      );
    }
    console.error("[mobile-generate] échec de génération:", err);
    return NextResponse.json({ error: "generation_failed" }, { status: 500 });
  }

  const written = await persistGenerated(
    access.tenantSlug,
    app.id,
    access.user.id,
    generated,
  );

  logAction({
    action: "MOBILE_CREDENTIAL_GENERATE",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileApp",
    targetId: app.id,
    // Empreintes et métadonnées seulement — jamais une valeur, jamais la
    // passphrase générée (elle ne sort d'ici que chiffrée, vers le CI).
    metadata: {
      platform: app.platform,
      mode: profileOnly ? "profile" : "full",
      replaced: Boolean(existingPivot),
      kinds: written.map((w) => w.kind).join(","),
      ...summary,
    },
    req,
  });

  return NextResponse.json({ credentials: written, summary }, { status: 201 });
}

/** Valeur en clair d'un credential unique, ou null. Stockage TOUJOURS en
 *  base64 chiffré (§4.4) → on rend les OCTETS décodés. */
async function loadCredential(appId: string, kind: string): Promise<Buffer | null> {
  const row = await prisma.mobileCredential.findUnique({
    where: { appId_kind: { appId, kind } },
    select: { encryptedValue: true, iv: true, tag: true },
  });
  if (!row) return null;
  return Buffer.from(
    decrypt({ encryptedValue: row.encryptedValue, iv: row.iv, tag: row.tag }),
    "base64",
  );
}

/** Clé d'API ASC déjà déposée sur l'application (le point d'amorçage). */
async function loadAscAuth(
  appId: string,
): Promise<{ p8Pem: string; keyId: string; issuerId: string } | null> {
  const rows = await prisma.mobileCredential.findMany({
    where: {
      appId,
      kind: { in: ["asc_api_key", "asc_key_id", "asc_issuer_id"] },
    },
    select: { kind: true, encryptedValue: true, iv: true, tag: true },
  });
  const byKind = new Map(
    rows.map((r) => [
      r.kind,
      // Stockage TOUJOURS en base64 chiffré (§4.4) → octets → utf8.
      Buffer.from(
        decrypt({ encryptedValue: r.encryptedValue, iv: r.iv, tag: r.tag }),
        "base64",
      ).toString("utf8"),
    ]),
  );
  const p8Pem = byKind.get("asc_api_key");
  const keyId = byKind.get("asc_key_id")?.trim();
  const issuerId = byKind.get("asc_issuer_id")?.trim();
  if (!p8Pem || !keyId || !issuerId) return null;
  return { p8Pem, keyId, issuerId };
}

/**
 * Écrit le matériel généré, avec versionnement de l'ancien — exactement le
 * schéma de l'import (POST /credentials), en boucle et dans UNE transaction :
 * un keystore sans son mot de passe serait un état inutilisable.
 */
async function persistGenerated(
  tenantSlug: string | null,
  appId: string,
  userId: string,
  generated: GeneratedCredential[],
) {
  const prepared = await Promise.all(
    generated.map(async (g) => {
      const decoded = Buffer.from(g.valueBase64, "base64");
      return {
        kind: g.kind,
        filename: g.filename,
        sizeBytes: decoded.length,
        sha256: sha256Hex(decoded),
        // Le matériel généré porte ses dates comme n'importe quel import : on
        // les extrait par le même chemin, plutôt que de faire confiance à ce
        // que la génération croit avoir produit.
        expiresAt: await extractExpiresAt(g.kind, decoded, findPassphrase(generated, g.kind)),
        payload: encrypt(g.valueBase64),
      };
    }),
  );

  return withTenantSchema(tenantSlug, async (tx) => {
    const out: Array<{ kind: string; sha256: string; expiresAt: Date | null }> = [];
    for (const p of prepared) {
      const existing = await tx.mobileCredential.findUnique({
        where: { appId_kind: { appId, kind: p.kind } },
        select: { id: true, encryptedValue: true, iv: true, tag: true },
      });
      if (existing) {
        await createMobileCredentialVersion({
          tx,
          credentialId: existing.id,
          encryptedValue: existing.encryptedValue,
          iv: existing.iv,
          tag: existing.tag,
          createdById: userId,
        });
      }
      const row = await tx.mobileCredential.upsert({
        where: { appId_kind: { appId, kind: p.kind } },
        create: {
          appId,
          kind: p.kind,
          filename: p.filename,
          sizeBytes: p.sizeBytes,
          sha256: p.sha256,
          expiresAt: p.expiresAt,
          ...p.payload,
        },
        update: {
          filename: p.filename,
          sizeBytes: p.sizeBytes,
          sha256: p.sha256,
          expiresAt: p.expiresAt,
          expiryAlertedAt: null,
          ...p.payload,
        },
        select: { kind: true, sha256: true, expiresAt: true },
      });
      out.push(row);
    }
    return out;
  });
}

/** La passphrase du conteneur vient d'être générée : elle est dans le lot.
 *  Sans elle, `extractExpiresAt` ne saurait pas ouvrir le PKCS12 et laisserait
 *  `expiresAt` null — la surveillance d'expiration serait morte à la naissance. */
function findPassphrase(
  generated: GeneratedCredential[],
  kind: string,
): string | undefined {
  const passKind =
    kind === "android_keystore"
      ? "android_keystore_password"
      : kind === "ios_p12"
        ? "ios_p12_password"
        : null;
  if (!passKind) return undefined;
  const entry = generated.find((g) => g.kind === passKind);
  return entry
    ? Buffer.from(entry.valueBase64, "base64").toString("utf8")
    : undefined;
}
