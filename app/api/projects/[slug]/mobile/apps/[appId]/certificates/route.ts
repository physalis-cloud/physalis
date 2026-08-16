// Chantier "Déploiement mobile" — Phase 7 : gérer les certificats Apple.
// Cf. documentation/plans/deploiement-mobile.md §5.5 (garde-fous).
//
// Apple PLAFONNE les certificats de distribution (2 pour un compte individuel,
// 3 pour une organisation), et l'API ne dit pas où on en est. Sans cet écran,
// le seul recours au plafond est la console Apple — ce qui vide de son sens la
// promesse « Physalis remplace `match` ».
//
// ⚠️ Le danger de la révocation est de supprimer le certificat EN SERVICE :
// la publication casse alors sans prévenir, et le `.p12` du coffre devient
// inutilisable. D'où `inUse`, calculé en ouvrant le conteneur et en comparant
// les empreintes de CERTIFICAT (pas celles des fichiers).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { hasDevPrivileges } from "@/lib/roles";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";
import {
  AscApiError,
  ascListDistributionCertificates,
  ascRevokeCertificate,
} from "@/lib/mobile-store-api";
import { matchVaultCertificate } from "@/lib/mobile-generate";

type Params = { params: Promise<{ slug: string; appId: string }> };

const LIST_LIMIT = { max: 30, windowMs: 5 * 60_000 };

/** Charge la clé d'API ASC et le `.p12` du coffre pour cette application. */
async function loadAscContext(appId: string) {
  const rows = await prisma.mobileCredential.findMany({
    where: {
      appId,
      kind: {
        in: ["asc_api_key", "asc_key_id", "asc_issuer_id", "ios_p12", "ios_p12_password"],
      },
    },
    select: { kind: true, encryptedValue: true, iv: true, tag: true },
  });
  // Stockage TOUJOURS en base64 chiffré (§4.4).
  const raw = new Map(
    rows.map((r) => [
      r.kind,
      Buffer.from(
        decrypt({ encryptedValue: r.encryptedValue, iv: r.iv, tag: r.tag }),
        "base64",
      ),
    ]),
  );
  const p8 = raw.get("asc_api_key");
  const keyId = raw.get("asc_key_id")?.toString("utf8").trim();
  const issuerId = raw.get("asc_issuer_id")?.toString("utf8").trim();
  if (!p8 || !keyId || !issuerId) return null;
  return {
    auth: { p8Pem: p8.toString("utf8"), keyId, issuerId },
    p12: raw.get("ios_p12") ?? null,
    p12Password: raw.get("ios_p12_password")?.toString("utf8") ?? "",
  };
}

export async function GET(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  const access = await requireProjectMember(slug, "EDITOR", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const limited = rateLimit(req, "mobile-certificates", LIST_LIMIT);
  if (limited) return limited;

  const app = await prisma.mobileApp.findFirst({
    where: { id: appId, projectId: access.project.id, platform: "ios" },
    select: { id: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ctx = await loadAscContext(app.id);
  if (!ctx) {
    return NextResponse.json({ error: "asc_key_missing" }, { status: 400 });
  }

  let certificates;
  try {
    certificates = await ascListDistributionCertificates(ctx.auth);
  } catch (err) {
    if (err instanceof AscApiError) {
      return NextResponse.json(
        { error: "asc_error", detail: err.info.detail },
        { status: 502 },
      );
    }
    throw err;
  }

  // Lequel est en service ? Sans cette réponse, révoquer est un coup de dés.
  const inUse = ctx.p12
    ? await matchVaultCertificate(certificates, ctx.p12, ctx.p12Password)
    : null;

  return NextResponse.json({
    // `der` n'est PAS renvoyé : l'interface n'en a aucun usage, et un
    // certificat public reste une donnée qu'on n'expose pas sans raison.
    certificates: certificates.map((c) => ({
      id: c.id,
      name: c.name,
      expiresAt: c.expiresAt,
      inUse: inUse?.id === c.id,
    })),
    // Sert à l'UI pour dire « vous êtes au plafond » avant même de tenter.
    count: certificates.length,
  });
}

/** Révocation — l'équivalent de `match nuke`, seule façon de faire de la place. */
export async function DELETE(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  // Même barre que la génération : révoquer un certificat de distribution est
  // irréversible et affecte toute l'équipe, pas seulement ce projet.
  const access = await requireProjectMember(slug, "VIEWER", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;
  if (!(access.role === "OWNER" || hasDevPrivileges(access.orgRole))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const certificateId = (url.searchParams.get("id") ?? "").trim();
  const force = url.searchParams.get("force") === "1";
  if (!certificateId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const app = await prisma.mobileApp.findFirst({
    where: { id: appId, projectId: access.project.id, platform: "ios" },
    select: { id: true, bundleId: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ctx = await loadAscContext(app.id);
  if (!ctx) {
    return NextResponse.json({ error: "asc_key_missing" }, { status: 400 });
  }

  try {
    // Garde anti-auto-mutilation : on refuse de révoquer le certificat dont la
    // clé privée est dans le coffre, sauf demande explicite. C'est exactement
    // le geste qui casse une publication sans que personne comprenne pourquoi.
    if (!force && ctx.p12) {
      const certificates = await ascListDistributionCertificates(ctx.auth);
      const inUse = await matchVaultCertificate(
        certificates,
        ctx.p12,
        ctx.p12Password,
      );
      if (inUse?.id === certificateId) {
        return NextResponse.json(
          {
            error: "certificate_in_use",
            detail:
              "Ce certificat est celui dont la clé privée est dans le coffre : le révoquer casse les publications de cette application tant qu'un nouveau n'a pas été généré.",
          },
          { status: 409 },
        );
      }
    }

    await ascRevokeCertificate(ctx.auth, certificateId);
  } catch (err) {
    if (err instanceof AscApiError) {
      return NextResponse.json(
        { error: "asc_error", detail: err.info.detail },
        { status: 502 },
      );
    }
    throw err;
  }

  logAction({
    action: "MOBILE_CERTIFICATE_REVOKED",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileApp",
    targetId: app.id,
    // ⚠️ `forced: true` signifie qu'on a révoqué le certificat EN SERVICE.
    // C'est la trace à chercher le jour où une publication casse sans raison
    // apparente.
    metadata: { app: app.bundleId, certificateId, forced: force },
    req,
  });

  return NextResponse.json({ revoked: certificateId });
}
