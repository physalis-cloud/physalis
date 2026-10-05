// Chantier "Déploiement mobile" — Phase 5 : lecture des magasins.
// Cf. documentation/plans/deploiement-mobile.md §4.5.
//
// Deux usages, aux exigences opposées :
//
//   1. LE NUMÉRO DE BUILD, lu au moment où le bundle part. `versionCode` doit
//      être strictement croissant chez Play, `CFBundleVersion` unique par
//      version marketing chez Apple — et un compteur maison DÉRIVE dès qu'un
//      humain téléverse une fois à la main depuis Xcode ou la console.
//      ⚠️ Cet appel est sur le CHEMIN CRITIQUE d'un déploiement : timeout court,
//      et repli silencieux sur le compteur local. Jamais un échec de livraison
//      parce que l'API de Google tousse (§4.5, même piège que le relais email
//      dans /api/deploy).
//
//   2. L'ÉTAT DES LIVRAISONS, lu à la demande. Là, rien n'est urgent : on peut
//      se permettre le timeout normal et remonter les erreurs.
//
// Ce module ne fait que LIRE. Promouvoir, échelonner ou suspendre est la
// Phase 6, et vit ailleurs — la séparation est délibérée : ces opérations-là
// sont irréversibles sur une application publiée.

import {
  ascCall,
  ascFindAppResource,
  googleAccessToken,
  parseServiceAccount,
  playFetch,
  PLAY_API_BASE,
} from "./mobile-store-api";

/** Plafond dur pour la lecture SUR LE CHEMIN CRITIQUE. Volontairement bas :
 *  au-delà, le repli sur le compteur local coûte moins cher que l'attente. */
const CRITICAL_READ_TIMEOUT_MS = 4_000;

/** Un numéro de build lu au magasin, ou `null` si indisponible. `null` n'est
 *  PAS une erreur : c'est le signal du repli. */
export type StoreBuildNumber = number | null;

function numericMax(values: Array<string | number | undefined | null>): number | null {
  let max: number | null = null;
  for (const v of values) {
    // `CFBundleVersion` peut valoir "1.2.3" : non comparable à un entier, donc
    // ignoré. Mieux vaut retomber sur le compteur local que d'inventer un
    // numéro à partir d'une chaîne qu'on ne sait pas ordonner.
    const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
    if (!Number.isFinite(n) || String(v).includes(".")) continue;
    if (max === null || n > max) max = n;
  }
  return max;
}

// ── Google Play ────────────────────────────────────────────────────────────

/**
 * Plus haut `versionCode` déjà téléversé sur ce package.
 *
 * Lu dans `edits.bundles.list` et non dans les pistes : un AAB téléversé mais
 * jamais affecté à une piste n'apparaît pas dans `tracks.list`, et Play refuse
 * pourtant de réutiliser son numéro. Ne pas le voir ferait servir un numéro
 * déjà pris — exactement le symptôme qu'on cherche à supprimer.
 */
export async function readPlayLatestVersionCode(
  serviceAccountJson: string,
  packageName: string,
  timeoutMs = CRITICAL_READ_TIMEOUT_MS,
): Promise<StoreBuildNumber> {
  const sa = parseServiceAccount(serviceAccountJson);
  if (!sa) return null;

  const appUrl = `${PLAY_API_BASE}/applications/${encodeURIComponent(packageName)}`;
  let editId: string | null = null;
  try {
    const token = await googleAccessToken(sa, timeoutMs);
    if (!token) return null;
    const auth = { authorization: `Bearer ${token}` };

    const insert = await playFetch(`${appUrl}/edits`, { method: "POST", headers: auth }, timeoutMs);
    if (!insert.ok) return null;
    const edit = (await insert.json()) as { id?: unknown };
    editId = typeof edit.id === "string" ? edit.id : null;
    if (!editId) return null;

    const res = await playFetch(`${appUrl}/edits/${editId}/bundles`, { headers: auth }, timeoutMs);
    if (!res.ok) return null;
    const body = (await res.json()) as { bundles?: Array<{ versionCode?: number }> };
    return numericMax((body.bundles ?? []).map((b) => b.versionCode));
  } catch {
    // Toute panne = repli. Ce chemin est critique : il ne journalise même pas
    // en erreur, seulement en information, pour ne pas polluer les alertes.
    console.info("[mobile-store-read] Play injoignable — repli sur le compteur local");
    return null;
  } finally {
    if (editId) {
      // Un edit non validé n'altère rien, mais encombre la console.
      await playFetch(
        `${appUrl}/edits/${editId}`,
        { method: "DELETE", headers: {} },
        timeoutMs,
      ).catch(() => undefined);
    }
  }
}

/** État d'une piste Play, tel que le magasin le voit. */
export type PlayTrackState = {
  track: string;
  versionCodes: number[];
  /** `completed` | `inProgress` | `halted` | `draft` */
  status: string;
  /** Fraction d'utilisateurs servie, pour un déploiement progressif. */
  userFraction: number | null;
};

export async function readPlayTrackStates(
  serviceAccountJson: string,
  packageName: string,
): Promise<PlayTrackState[] | null> {
  const sa = parseServiceAccount(serviceAccountJson);
  if (!sa) return null;

  const appUrl = `${PLAY_API_BASE}/applications/${encodeURIComponent(packageName)}`;
  let editId: string | null = null;
  try {
    const token = await googleAccessToken(sa);
    if (!token) return null;
    const auth = { authorization: `Bearer ${token}` };

    const insert = await playFetch(`${appUrl}/edits`, { method: "POST", headers: auth });
    if (!insert.ok) return null;
    const edit = (await insert.json()) as { id?: unknown };
    editId = typeof edit.id === "string" ? edit.id : null;
    if (!editId) return null;

    const res = await playFetch(`${appUrl}/edits/${editId}/tracks`, { headers: auth });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      tracks?: Array<{
        track?: string;
        releases?: Array<{
          status?: string;
          userFraction?: number;
          versionCodes?: string[];
        }>;
      }>;
    };

    const out: PlayTrackState[] = [];
    for (const t of body.tracks ?? []) {
      for (const r of t.releases ?? []) {
        out.push({
          track: t.track ?? "",
          // Play rend les versionCodes en CHAÎNES dans les releases (et en
          // nombres dans les bundles) — incohérence de leur API, pas de la nôtre.
          versionCodes: (r.versionCodes ?? [])
            .map((v) => Number.parseInt(String(v), 10))
            .filter((n) => Number.isFinite(n)),
          status: r.status ?? "",
          userFraction: typeof r.userFraction === "number" ? r.userFraction : null,
        });
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    if (editId) {
      await playFetch(`${appUrl}/edits/${editId}`, {
        method: "DELETE",
        headers: {},
      }).catch(() => undefined);
    }
  }
}

// ── App Store Connect ──────────────────────────────────────────────────────

/**
 * Plus haut `CFBundleVersion` déjà téléversé pour ce bundle id.
 *
 * ⚠️ Apple accepte des versions non entières ("1.2.3"). `numericMax` les ignore
 * : sans ordre total, mieux vaut le repli local qu'un numéro inventé.
 */
export async function readAscLatestBuildVersion(
  auth: { p8Pem: string; keyId: string; issuerId: string },
  bundleId: string,
  timeoutMs = CRITICAL_READ_TIMEOUT_MS,
): Promise<StoreBuildNumber> {
  try {
    const appId = await ascFindAppResource(auth, bundleId, timeoutMs);
    if (!appId) return null;
    const body = await ascCall(
      auth,
      `/builds?filter%5Bapp%5D=${encodeURIComponent(appId)}&limit=200&sort=-uploadedDate`,
      { timeoutMs },
    );
    const data = Array.isArray(body.data) ? body.data : [];
    return numericMax(
      data.map((b) =>
        b && typeof b === "object"
          ? ((b as { attributes?: { version?: string } }).attributes?.version ?? null)
          : null,
      ),
    );
  } catch {
    console.info("[mobile-store-read] ASC injoignable — repli sur le compteur local");
    return null;
  }
}

/** État d'un build chez Apple. */
export type AscBuildState = {
  version: string;
  /** `PROCESSING` | `VALID` | `FAILED` | `INVALID` */
  processingState: string;
  expired: boolean;
};

export async function readAscBuildStates(
  auth: { p8Pem: string; keyId: string; issuerId: string },
  bundleId: string,
): Promise<AscBuildState[] | null> {
  try {
    const appId = await ascFindAppResource(auth, bundleId);
    if (!appId) return null;
    const body = await ascCall(
      auth,
      `/builds?filter%5Bapp%5D=${encodeURIComponent(appId)}&limit=200&sort=-uploadedDate`,
    );
    const data = Array.isArray(body.data) ? body.data : [];
    return data
      .map((b) => {
        const a =
          b && typeof b === "object"
            ? ((b as { attributes?: Record<string, unknown> }).attributes ?? {})
            : {};
        return {
          version: typeof a.version === "string" ? a.version : "",
          processingState:
            typeof a.processingState === "string" ? a.processingState : "",
          expired: a.expired === true,
        };
      })
      .filter((b) => b.version !== "");
  } catch {
    return null;
  }
}

// ── Traduction vers le vocabulaire du registre ─────────────────────────────

/**
 * État Play → état `MobileRelease`.
 *
 * `inProgress` devient `live` et non un état à part : du point de vue de
 * l'utilisateur, une release échelonnée EST en ligne — simplement pas pour
 * tout le monde. La fraction, elle, est portée par `statusDetail`.
 *
 * ⚠️ LIMITE CONNUE, constatée en production le 2026-08-17 : `completed` devient
 * `live`, mais l'API Play **n'expose nulle part l'état de la REVUE**. Une
 * release peut être `completed` sur sa piste ET refusée par la conformité
 * Google (« Violation des exigences de Play Console »), ce que seule la console
 * montre. Notre `en ligne` est donc « publié sur la piste », pas « approuvé ».
 * Il n'y a pas d'endpoint pour le savoir ; la console reste l'autorité sur les
 * revues. Même famille que le cas Apple ci-dessous, à ceci près qu'ici on ne
 * peut pas faire mieux.
 */
export function playStatusToRelease(status: string): string {
  switch (status) {
    case "completed":
    case "inProgress":
      return "live";
    case "halted":
      return "halted";
    case "draft":
      return "uploaded";
    default:
      return "uploaded";
  }
}

/**
 * État Apple → état `MobileRelease`.
 *
 * ⚠️ `VALID` signifie « le binaire est traité et exploitable », PAS « en ligne ».
 * Le passage en revue puis en vente relève d'`appStoreVersions`, que cette
 * phase ne lit pas — annoncer `live` ici serait un mensonge confortable.
 */
export function ascStateToRelease(processingState: string): string {
  switch (processingState) {
    case "PROCESSING":
      return "processing";
    case "VALID":
      return "uploaded";
    case "FAILED":
      return "failed";
    case "INVALID":
      return "rejected";
    default:
      return "uploaded";
  }
}

// ── Plancher magasin, à partir d'un bundle déjà construit ──────────────────

/**
 * Plus haut numéro publié au magasin, déduit du bundle qui part au CI.
 *
 * Les credentials sont pris dans le bundle plutôt que relus en base : ils y
 * sont déjà déchiffrés, et un aller-retour de plus sur le chemin critique
 * serait gratuit.
 *
 * Ne lève jamais et n'est jamais bloquant : `null` déclenche le repli sur le
 * compteur local (§4.5).
 */
export async function readStoreFloor(
  platform: string,
  bundleId: string,
  credentials: Array<{ kind: string; value: string; encoding: string }>,
): Promise<StoreBuildNumber> {
  const get = (kind: string): string | null => {
    const c = credentials.find((x) => x.kind === kind);
    if (!c) return null;
    // Un kind FICHIER ressort en base64, un kind TEXTE est déjà décodé.
    return c.encoding === "base64"
      ? Buffer.from(c.value, "base64").toString("utf8")
      : c.value;
  };

  try {
    if (platform === "android") {
      const sa = get("play_service_account");
      return sa ? await readPlayLatestVersionCode(sa, bundleId) : null;
    }
    if (platform === "ios") {
      const p8 = get("asc_api_key");
      const keyId = get("asc_key_id")?.trim();
      const issuerId = get("asc_issuer_id")?.trim();
      if (!p8 || !keyId || !issuerId) return null;
      return await readAscLatestBuildVersion({ p8Pem: p8, keyId, issuerId }, bundleId);
    }
    return null;
  } catch {
    return null;
  }
}
