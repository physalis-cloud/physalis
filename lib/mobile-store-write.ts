// Chantier "Déploiement mobile" — Phase 6 : actions sur les magasins.
// Cf. documentation/plans/deploiement-mobile.md §9.
//
// ⚠️ CE MODULE EST LE SEUL DU CHANTIER QUI MODIFIE L'ÉTAT PUBLIC D'UNE
// APPLICATION. Tout le reste lit, sert du matériel, ou enregistre. Ici on
// promeut une version vers la production, on change la fraction d'utilisateurs
// servie, on suspend une diffusion. Ces gestes atteignent de vrais
// utilisateurs, et aucun n'a de « annuler ».
//
// Trois conséquences sur l'écriture de ce fichier :
//
//   1. Aucune valeur par défaut « pratique ». Une piste, une fraction, un
//      numéro de build : tout est explicite. Un défaut mal choisi ici se
//      traduirait par une version poussée en production sans que personne
//      l'ait demandé.
//   2. Les préconditions sont vérifiées AVANT d'ouvrir un edit Play. Un edit
//      abandonné est inoffensif, mais un `commit` partiel ne l'est pas.
//   3. Le vocabulaire reste celui du plan (§3.3) : « promouvoir sur une
//      piste », « suspendre la diffusion » — jamais « déployer ».

import {
  ascCall,
  ascFindAppResource,
  googleAccessToken,
  parseServiceAccount,
  playFetch,
  PLAY_API_BASE,
} from "./mobile-store-api";
import { AscApiError } from "./mobile-store-api";

/** Pistes Play sur lesquelles une promotion a un sens. `production` y est, et
 *  c'est précisément celle qui demande le plus de précautions côté appelant. */
export const PLAY_PROMOTABLE_TRACKS = [
  "internal",
  "alpha",
  "beta",
  "production",
] as const;

export function isPlayTrack(v: string): boolean {
  return (PLAY_PROMOTABLE_TRACKS as readonly string[]).includes(v);
}

/**
 * Une fraction d'utilisateurs valide pour Play.
 *
 * Bornes STRICTES des deux côtés : `0` ne suspend pas une diffusion (c'est
 * `halt` qui le fait) et Play rejette la valeur ; `1` n'est pas un
 * échelonnement mais une diffusion complète, qui s'exprime par le statut
 * `completed`. Accepter l'un ou l'autre ici produirait une erreur d'API
 * incompréhensible plusieurs étapes plus loin.
 */
export function isValidUserFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1;
}

export class StoreActionError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "StoreActionError";
  }
}

// ── Google Play ────────────────────────────────────────────────────────────

type PlayRelease = {
  versionCodes: string[];
  status: string;
  userFraction?: number;
};

/**
 * Applique une release à une piste, puis VALIDE l'edit.
 *
 * L'API Play est transactionnelle : `edits.insert` ouvre un brouillon, les
 * modifications s'y accumulent, et `edits.commit` les publie d'un bloc. Tant
 * que le commit n'a pas eu lieu, rien n'a changé pour personne — c'est ce qui
 * permet d'échouer proprement à mi-chemin.
 *
 * ⚠️ Après le commit, en revanche, c'est fait. Il n'existe pas d'annulation :
 * revenir en arrière signifie promouvoir à nouveau une version antérieure, ce
 * que Play refuse si son versionCode est plus bas.
 */
async function playApplyRelease(
  serviceAccountJson: string,
  packageName: string,
  track: string,
  release: PlayRelease,
): Promise<void> {
  const sa = parseServiceAccount(serviceAccountJson);
  if (!sa) throw new StoreActionError("invalid_key", "compte de service illisible");

  const token = await googleAccessToken(sa);
  if (!token) throw new StoreActionError("invalid_key", "authentification Google refusée");
  const auth = { authorization: `Bearer ${token}` };
  const appUrl = `${PLAY_API_BASE}/applications/${encodeURIComponent(packageName)}`;

  let editId: string | null = null;
  let committed = false;
  try {
    const insert = await playFetch(`${appUrl}/edits`, { method: "POST", headers: auth });
    if (!insert.ok) {
      throw new StoreActionError("store_error", `edits.insert ${insert.status}`);
    }
    const edit = (await insert.json()) as { id?: unknown };
    editId = typeof edit.id === "string" ? edit.id : null;
    if (!editId) throw new StoreActionError("store_error", "edits.insert sans id");

    const put = await playFetch(
      `${appUrl}/edits/${editId}/tracks/${encodeURIComponent(track)}`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ track, releases: [release] }),
      },
    );
    if (!put.ok) {
      // Le corps de Google est explicite ici (« Version code 41 has already
      // been used », « Track production is not enabled »). On le remonte.
      throw new StoreActionError(
        "store_error",
        (await put.text()).replace(/\s+/g, " ").trim().slice(0, 300),
      );
    }

    const commit = await playFetch(`${appUrl}/edits/${editId}:commit`, {
      method: "POST",
      headers: auth,
    });
    if (!commit.ok) {
      throw new StoreActionError(
        "store_error",
        `commit ${commit.status} ${(await commit.text()).slice(0, 200)}`,
      );
    }
    committed = true;
  } finally {
    // Un edit VALIDÉ ne doit surtout pas être supprimé — il n'existe plus en
    // tant que brouillon. On ne nettoie que le cas d'échec.
    if (editId && !committed) {
      await playFetch(`${appUrl}/edits/${editId}`, {
        method: "DELETE",
        headers: auth,
      }).catch(() => undefined);
    }
  }
}

/**
 * Promeut un build sur une piste.
 *
 * @param userFraction si fourni, la diffusion démarre ÉCHELONNÉE (`inProgress`)
 *   à cette fraction. Sinon elle est complète (`completed`).
 */
export async function playPromote(
  serviceAccountJson: string,
  packageName: string,
  opts: { versionCode: number; track: string; userFraction?: number },
): Promise<void> {
  if (!isPlayTrack(opts.track)) {
    throw new StoreActionError("invalid_track", opts.track);
  }
  const staged = opts.userFraction !== undefined;
  if (staged && !isValidUserFraction(opts.userFraction)) {
    throw new StoreActionError("invalid_fraction", String(opts.userFraction));
  }
  await playApplyRelease(serviceAccountJson, packageName, opts.track, {
    versionCodes: [String(opts.versionCode)],
    // `userFraction` n'est accepté qu'avec `inProgress` : le poser sur une
    // release `completed` fait échouer l'API avec un message qui ne l'explique
    // pas. On ne l'envoie donc que dans le cas où il a un sens.
    ...(staged
      ? { status: "inProgress", userFraction: opts.userFraction }
      : { status: "completed" }),
  });
}

/** Fait varier la fraction d'un déploiement déjà échelonné. */
export async function playSetUserFraction(
  serviceAccountJson: string,
  packageName: string,
  opts: { versionCode: number; track: string; userFraction: number },
): Promise<void> {
  if (!isPlayTrack(opts.track)) throw new StoreActionError("invalid_track", opts.track);
  if (!isValidUserFraction(opts.userFraction)) {
    throw new StoreActionError("invalid_fraction", String(opts.userFraction));
  }
  await playApplyRelease(serviceAccountJson, packageName, opts.track, {
    versionCodes: [String(opts.versionCode)],
    status: "inProgress",
    userFraction: opts.userFraction,
  });
}

/**
 * Suspend la diffusion d'une version.
 *
 * ⚠️ « Suspendre » n'est pas « retirer » : les utilisateurs qui ont DÉJÀ reçu la
 * version la gardent. Play arrête simplement de la servir aux autres. Il
 * n'existe aucun moyen de reprendre une mise à jour déjà installée — le seul
 * remède est de publier une version corrigée, avec un versionCode supérieur.
 */
export async function playHalt(
  serviceAccountJson: string,
  packageName: string,
  opts: { versionCode: number; track: string },
): Promise<void> {
  if (!isPlayTrack(opts.track)) throw new StoreActionError("invalid_track", opts.track);
  await playApplyRelease(serviceAccountJson, packageName, opts.track, {
    versionCodes: [String(opts.versionCode)],
    status: "halted",
  });
}

// ── App Store Connect : groupes TestFlight ─────────────────────────────────

export type BetaGroup = { id: string; name: string; internal: boolean };

export async function ascListBetaGroups(
  auth: { p8Pem: string; keyId: string; issuerId: string },
  bundleId: string,
): Promise<BetaGroup[]> {
  const appId = await ascFindAppResource(auth, bundleId);
  if (!appId) throw new StoreActionError("app_not_found", bundleId);
  const body = await ascCall(
    auth,
    `/betaGroups?filter%5Bapp%5D=${encodeURIComponent(appId)}&limit=200`,
  );
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .map((g) => {
      const o = g as { id?: unknown; attributes?: Record<string, unknown> };
      return {
        id: typeof o.id === "string" ? o.id : "",
        name: typeof o.attributes?.name === "string" ? o.attributes.name : "",
        internal: o.attributes?.isInternalGroup === true,
      };
    })
    .filter((g) => g.id !== "");
}

/** Identifiant de RESSOURCE d'un build, à partir de son `CFBundleVersion`. */
export async function ascFindBuild(
  auth: { p8Pem: string; keyId: string; issuerId: string },
  bundleId: string,
  version: string,
): Promise<string | null> {
  const appId = await ascFindAppResource(auth, bundleId);
  if (!appId) return null;
  const body = await ascCall(
    auth,
    `/builds?filter%5Bapp%5D=${encodeURIComponent(appId)}` +
      `&filter%5Bversion%5D=${encodeURIComponent(version)}&limit=10`,
  );
  const data = Array.isArray(body.data) ? body.data : [];
  const first = data[0] as { id?: unknown } | undefined;
  return typeof first?.id === "string" ? first.id : null;
}

/**
 * Ajoute un build à un groupe TestFlight — c'est ce qui le rend disponible aux
 * testeurs de ce groupe.
 *
 * ⚠️ Pour un groupe EXTERNE, Apple exige que le build ait passé la revue
 * TestFlight. L'ajout réussit quand même, mais rien n'est distribué tant que la
 * revue n'est pas accordée : l'appelant ne doit donc pas annoncer « distribué »
 * sur la seule foi d'un 2xx.
 */
export async function ascAddBuildToGroup(
  auth: { p8Pem: string; keyId: string; issuerId: string },
  buildResourceId: string,
  groupId: string,
): Promise<void> {
  await ascCall(auth, `/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`, {
    method: "POST",
    body: { data: [{ type: "builds", id: buildResourceId }] },
  });
}

export { AscApiError };
