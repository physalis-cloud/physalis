// Chantier "Déploiement mobile" — Phase 6 : agir sur le magasin.
// Cf. documentation/plans/deploiement-mobile.md §9.
//
// ⚠️ SEULE SURFACE DU CHANTIER QUI MODIFIE L'ÉTAT PUBLIC D'UNE APPLICATION.
// Promouvoir en production, faire varier la fraction servie, suspendre une
// diffusion : ces gestes atteignent de vrais utilisateurs et n'ont pas
// d'annulation. D'où quatre gardes en série, dans cet ordre :
//
//   1. OWNER projet ou OrgDEV — même barre que générer ou révoquer ;
//   2. la feature de plan, vérifiée à l'exploitation ;
//   3. `Project.mobileEnabled` ;
//   4. `MobileApp.deployPaused` — ⚠️ le coupe-circuit VETO ces actions aussi.
//      Il serait absurde qu'une app dont on a gelé les publications puisse
//      encore être promue en production depuis le même écran. Le coupe-circuit
//      veut dire « plus rien ne sort », pas « plus rien ne se construit ».
//
// GET rend les groupes TestFlight (iOS) : l'écran en a besoin pour proposer
// une cible, et c'est une lecture pure.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withTenantSchema } from "@/lib/tenant";
import { decrypt } from "@/lib/crypto";
import { requireProjectMember, readJson } from "@/lib/api";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { hasDevPrivileges } from "@/lib/roles";
import { requireProjectMobileEnabled } from "@/lib/mobile-guard";
import {
  AscApiError,
  ascAddBuildToGroup,
  ascFindBuild,
  ascListBetaGroups,
  isValidUserFraction,
  playHalt,
  playPromote,
  playSetUserFraction,
  StoreActionError,
} from "@/lib/mobile-store-write";

type Params = { params: Promise<{ slug: string; appId: string }> };

/** Volontairement bas : promouvoir ou suspendre est un geste rare et réfléchi,
 *  pas quelque chose qu'on répète. */
const ACTION_LIMIT = { max: 10, windowMs: 10 * 60_000 };

async function loadCredentials(appId: string): Promise<Map<string, string>> {
  const rows = await prisma.mobileCredential.findMany({
    where: { appId },
    select: { kind: true, encryptedValue: true, iv: true, tag: true },
  });
  return new Map(
    rows.map((r) => [
      r.kind,
      Buffer.from(
        decrypt({ encryptedValue: r.encryptedValue, iv: r.iv, tag: r.tag }),
        "base64",
      ).toString("utf8"),
    ]),
  );
}

function ascAuthFrom(creds: Map<string, string>) {
  const p8 = creds.get("asc_api_key");
  const keyId = creds.get("asc_key_id")?.trim();
  const issuerId = creds.get("asc_issuer_id")?.trim();
  if (!p8 || !keyId || !issuerId) return null;
  return { p8Pem: p8, keyId, issuerId };
}

/** Gardes communes au GET et au POST. */
async function guard(slug: string, appId: string, mutating: boolean) {
  const access = await requireProjectMember(slug, "VIEWER", {
    feature: "mobile_deploy",
  });
  if ("error" in access) return { error: access.error } as const;
  const off = requireProjectMobileEnabled(access.project);
  if (off) return { error: off } as const;
  if (mutating && !(access.role === "OWNER" || hasDevPrivileges(access.orgRole))) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  }

  const app = await prisma.mobileApp.findFirst({
    where: { id: appId, projectId: access.project.id },
    select: { id: true, platform: true, bundleId: true, deployPaused: true },
  });
  if (!app) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
  }
  if (mutating && app.deployPaused) {
    return {
      error: NextResponse.json(
        {
          error: "deploy_paused",
          detail:
            "Les publications de cette application sont en pause. Reprenez-les avant d'agir sur le magasin.",
        },
        { status: 403 },
      ),
    } as const;
  }
  return { access, app } as const;
}

/** Groupes TestFlight disponibles (iOS). */
export async function GET(_req: Request, { params }: Params) {
  const { slug, appId } = await params;
  const g = await guard(slug, appId, false);
  if ("error" in g) return g.error;
  if (g.app.platform !== "ios") return NextResponse.json({ groups: [] });

  const auth = ascAuthFrom(await loadCredentials(g.app.id));
  if (!auth) return NextResponse.json({ error: "asc_key_missing" }, { status: 400 });

  try {
    return NextResponse.json({ groups: await ascListBetaGroups(auth, g.app.bundleId) });
  } catch (err) {
    if (err instanceof AscApiError) {
      return NextResponse.json({ error: "asc_error", detail: err.info.detail }, { status: 502 });
    }
    if (err instanceof StoreActionError) {
      return NextResponse.json({ error: err.code, detail: err.detail }, { status: 502 });
    }
    throw err;
  }
}

export async function POST(req: Request, { params }: Params) {
  const { slug, appId } = await params;
  const g = await guard(slug, appId, true);
  if ("error" in g) return g.error;
  const { access, app } = g;

  const limited = rateLimit(req, "mobile-store-action", ACTION_LIMIT);
  if (limited) return limited;

  const body = (await readJson(req)) as {
    action?: string;
    buildNumber?: string | number;
    track?: string;
    userFraction?: number;
    groupId?: string;
  } | null;

  const action = String(body?.action ?? "").trim();
  const buildNumber = String(body?.buildNumber ?? "").trim();
  if (!action || !buildNumber) {
    return NextResponse.json({ error: "action and buildNumber are required" }, { status: 400 });
  }

  // ⚠️ La version doit être une livraison CONNUE DU REGISTRE. Sans cette
  // vérification, l'écran pourrait promouvoir un versionCode arbitraire — donc
  // un binaire que Physalis n'a jamais servi et dont il ne sait rien.
  const release = await prisma.mobileRelease.findFirst({
    where: { appId: app.id, buildNumber },
    select: { id: true, track: true },
  });
  if (!release) {
    return NextResponse.json({ error: "unknown_release" }, { status: 404 });
  }

  const creds = await loadCredentials(app.id);
  const track = String(body?.track ?? "").trim();

  try {
    if (app.platform === "android") {
      const sa = creds.get("play_service_account");
      if (!sa) return NextResponse.json({ error: "play_key_missing" }, { status: 400 });
      const versionCode = Number.parseInt(buildNumber, 10);
      if (!Number.isFinite(versionCode)) {
        return NextResponse.json({ error: "invalid_build_number" }, { status: 400 });
      }

      if (action === "promote") {
        await playPromote(sa, app.bundleId, {
          versionCode,
          track,
          // `undefined` (et non `null`) : c'est ce qui distingue une diffusion
          // complète d'un échelonnement, cf. lib/mobile-store-write.
          userFraction: isValidUserFraction(body?.userFraction)
            ? body!.userFraction
            : undefined,
        });
      } else if (action === "rollout") {
        if (!isValidUserFraction(body?.userFraction)) {
          return NextResponse.json({ error: "invalid_fraction" }, { status: 400 });
        }
        await playSetUserFraction(sa, app.bundleId, {
          versionCode,
          track,
          userFraction: body!.userFraction!,
        });
      } else if (action === "halt") {
        await playHalt(sa, app.bundleId, { versionCode, track });
      } else {
        return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
      }
    } else if (app.platform === "ios") {
      if (action !== "testflight") {
        return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
      }
      const auth = ascAuthFrom(creds);
      if (!auth) return NextResponse.json({ error: "asc_key_missing" }, { status: 400 });
      const groupId = String(body?.groupId ?? "").trim();
      if (!groupId) return NextResponse.json({ error: "group_required" }, { status: 400 });

      const buildId = await ascFindBuild(auth, app.bundleId, buildNumber);
      if (!buildId) return NextResponse.json({ error: "build_not_at_store" }, { status: 404 });
      await ascAddBuildToGroup(auth, buildId, groupId);
    } else {
      return NextResponse.json({ error: "unsupported_platform" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof StoreActionError) {
      return NextResponse.json({ error: err.code, detail: err.detail }, { status: 502 });
    }
    if (err instanceof AscApiError) {
      return NextResponse.json({ error: "asc_error", detail: err.info.detail }, { status: 502 });
    }
    console.error("[mobile-store-action] échec:", err);
    return NextResponse.json({ error: "store_error" }, { status: 502 });
  }

  // Le registre reflète le geste tout de suite, sans attendre la prochaine
  // synchronisation — mais reste marqué `reported` : c'est NOTRE action qu'on
  // enregistre, pas encore un état constaté au magasin.
  const nextStatus =
    action === "halt" ? "halted" : action === "testflight" ? "uploaded" : "live";
  await withTenantSchema(access.tenantSlug, (tx) =>
    tx.mobileRelease.update({
      where: { id: release.id },
      data: {
        status: nextStatus,
        statusSource: "reported",
        ...(track ? { track } : {}),
        ...(action === "rollout" || (action === "promote" && body?.userFraction)
          ? { statusDetail: `${track} · ${Math.round((body!.userFraction ?? 1) * 100)} %` }
          : {}),
      },
    }),
  );

  logAction({
    action: "MOBILE_STORE_ACTION",
    actor: { kind: "user", userId: access.user.id, email: access.user.email },
    organizationId: access.project.organizationId,
    projectId: access.project.id,
    targetType: "MobileRelease",
    targetId: release.id,
    metadata: {
      app: app.bundleId,
      platform: app.platform,
      storeAction: action,
      buildNumber,
      track: track || null,
      userFraction: body?.userFraction ?? null,
      groupId: body?.groupId ?? null,
    },
    req,
  });

  return NextResponse.json({ ok: true, action, buildNumber, track: track || null });
}
