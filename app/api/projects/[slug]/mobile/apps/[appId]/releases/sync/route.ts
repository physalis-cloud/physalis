// Chantier "Déploiement mobile" — Phase 5 : reprise d'état depuis le magasin.
// Cf. documentation/plans/deploiement-mobile.md §5.3 / §9.
//
// Le registre sait ce que le CI a RAPPORTÉ. Il ne sait pas ce que le magasin a
// fait ensuite : une revue peut refuser, un déploiement progressif peut être
// suspendu, un binaire peut échouer au traitement — tout cela sans qu'aucun
// pipeline ne repasse. Cette route va le demander.
//
// ⚠️ Geste EXPLICITE à la demande, comme la vérification d'accréditation : il
// part avec les clés du client vers Google et Apple. Un cron cross-tenant qui
// interrogerait les magasins pour tous les projets, toutes les heures, serait
// une autre décision — plus lourde, et pas nécessaire pour répondre à « quelle
// version est en ligne ? ».
//
// `statusSource` passe alors de "reported" (déclaratif, le CI l'a dit) à
// "store" (constaté). La distinction n'est pas cosmétique : elle dit au lecteur
// si l'information vient de celui qui publie ou de celui qui héberge.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withTenantSchema } from "@/lib/tenant";
import { decrypt } from "@/lib/crypto";
import { requireProjectMember } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";
import {
  ascStateToRelease,
  playStatusToRelease,
  readAscBuildStates,
  readPlayTrackStates,
} from "@/lib/mobile-store-read";

type Params = { params: Promise<{ slug: string; appId: string }> };

/** Une synchronisation = plusieurs appels sortants. Rare par nature. */
const SYNC_LIMIT = { max: 20, windowMs: 5 * 60_000 };

/** Valeurs en clair des credentials d'une app, par kind. */
async function loadCredentials(appId: string): Promise<Map<string, string>> {
  const rows = await prisma.mobileCredential.findMany({
    where: { appId },
    select: { kind: true, encryptedValue: true, iv: true, tag: true },
  });
  return new Map(
    rows.map((r) => [
      r.kind,
      // Stockage TOUJOURS en base64 chiffré (§4.4) → octets → utf8.
      Buffer.from(
        decrypt({ encryptedValue: r.encryptedValue, iv: r.iv, tag: r.tag }),
        "base64",
      ).toString("utf8"),
    ]),
  );
}

export async function POST(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  // EDITOR, comme la vérification : l'appel révèle l'état du compte magasin et
  // consomme du quota d'API chez Google et Apple.
  const access = await requireProjectMember(slug, "EDITOR", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return access.error;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return off;

  const limited = rateLimit(req, "mobile-release-sync", SYNC_LIMIT);
  if (limited) return limited;

  const app = await prisma.mobileApp.findFirst({
    where: { id: appId, projectId: access.project.id },
    select: { id: true, platform: true, bundleId: true },
  });
  if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const creds = await loadCredentials(app.id);

  /**
   * `buildNumber|piste` → état, tels que le MAGASIN les voit.
   *
   * ⚠️ La clé porte la PISTE, et pas seulement le numéro. Après une promotion,
   * Play garde le build sur la piste d'origine ET sur la nouvelle : indexer par
   * le seul numéro faisait s'écraser les deux entrées, et c'est l'ordre de
   * retour de Google qui décidait laquelle gagnait. Une ligne « alpha » se
   * retrouvait décrite par l'état de « internal ». Constaté en prod le
   * 2026-08-17.
   */
  const observed = new Map<string, { status: string; detail: string | null }>();
  const key = (build: string, track: string) => `${build}|${track}`;

  if (app.platform === "android") {
    const sa = creds.get("play_service_account");
    if (!sa) return NextResponse.json({ error: "play_key_missing" }, { status: 400 });
    const tracks = await readPlayTrackStates(sa, app.bundleId);
    if (!tracks) return NextResponse.json({ error: "store_unreachable" }, { status: 502 });
    for (const t of tracks) {
      for (const code of t.versionCodes) {
        observed.set(key(String(code), t.track), {
          status: playStatusToRelease(t.status),
          // Le détail ne répète PAS le nom de la piste — la colonne le porte
          // déjà. Il ne sert qu'à l'information que la colonne n'a pas : la
          // fraction d'un déploiement progressif. `null` quand il n'y en a
          // pas, plutôt qu'un « 100 % » qui ferait croire à un échelonnement.
          detail:
            t.userFraction !== null && t.userFraction < 1
              ? `${Math.round(t.userFraction * 100)} %`
              : null,
        });
      }
    }
  } else if (app.platform === "ios") {
    const p8 = creds.get("asc_api_key");
    const keyId = creds.get("asc_key_id")?.trim();
    const issuerId = creds.get("asc_issuer_id")?.trim();
    if (!p8 || !keyId || !issuerId) {
      return NextResponse.json({ error: "asc_key_missing" }, { status: 400 });
    }
    const builds = await readAscBuildStates({ p8Pem: p8, keyId, issuerId }, app.bundleId);
    if (!builds) return NextResponse.json({ error: "store_unreachable" }, { status: 502 });
    for (const b of builds) {
      // Apple n'a pas de piste au sens de Play : un build est unique par
      // version, et nos lignes iOS portent `testflight` ou `appstore`.
      observed.set(key(b.version, "testflight"), {
        status: ascStateToRelease(b.processingState),
        detail: b.expired ? "expiré chez Apple" : null,
      });
    }
  } else {
    return NextResponse.json({ error: "unsupported_platform" }, { status: 400 });
  }

  // On ne crée AUCUNE ligne ici : un build présent au magasin mais absent du
  // registre n'a pas transité par Physalis (téléversement manuel), et
  // l'inventer donnerait l'illusion d'une traçabilité qui n'existe pas. On ne
  // met à jour que ce qu'on a réellement servi.
  const rows = await prisma.mobileRelease.findMany({
    where: { appId: app.id },
    select: { id: true, buildNumber: true, track: true, status: true },
  });

  const now = new Date();
  const changed: Array<{ buildNumber: string; from: string; to: string }> = [];

  await withTenantSchema(access.tenantSlug, async (tx) => {
    for (const r of rows) {
      const seen = observed.get(key(r.buildNumber, r.track));
      if (!seen) continue;
      await tx.mobileRelease.update({
        where: { id: r.id },
        data: {
          status: seen.status,
          statusDetail: seen.detail,
          statusSource: "store",
          storeSyncedAt: now,
        },
      });
      if (seen.status !== r.status) {
        changed.push({ buildNumber: r.buildNumber, from: r.status, to: seen.status });
      }
    }
  });

  logAction({
    action: "MOBILE_RELEASE_SYNCED",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileApp",
    targetId: app.id,
    metadata: {
      app: app.bundleId,
      platform: app.platform,
      observed: observed.size,
      matched: rows.filter((r) => observed.has(key(r.buildNumber, r.track))).length,
      changed: changed.length,
    },
    req,
  });

  return NextResponse.json({
    observed: observed.size,
    matched: rows.filter((r) => observed.has(key(r.buildNumber, r.track))).length,
    changed,
  });
}
