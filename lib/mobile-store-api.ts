// Chantier "Déploiement mobile" — Phase 2 : sondes d'ACCRÉDITATION auprès des
// magasins. Cf. documentation/plans/deploiement-mobile.md §7.
//
// Le plan est explicite : à l'import, il faut « appeler réellement l'API
// concernée et afficher le périmètre obtenu ("cette clé peut publier sur :
// internal, alpha") plutôt qu'un simple "enregistré". Un credential mal doté
// échoue sinon AU PREMIER DÉPLOIEMENT, c'est-à-dire au pire moment. »
//
// Ce module ne fait que LIRE. Il ne crée pas de version, ne promeut rien, ne
// téléverse rien — il répond « avec quoi cette clé a-t-elle le droit de
// travailler ». La seule écriture est l'edit Play, qui est un brouillon
// obligatoire pour lister les pistes, et qui est SUPPRIMÉ tout de suite après.
//
// ⚠️ Ces appels ne sont JAMAIS sur le chemin critique d'un déploiement — c'est
// le piège déjà évité pour le numéro de build (§4.5 du plan) et pour l'email
// dans /api/deploy. Ils ne tournent que sur demande explicite d'un humain.

import { SignJWT, importPKCS8 } from "jose";

/** Plafond dur : une console qui tousse ne doit pas faire pendre la requête de
 *  vérification. Volontairement court — c'est un diagnostic, pas un job. */
const HTTP_TIMEOUT_MS = 8_000;

// ⚠️ SSRF — les endpoints sont des CONSTANTES, jamais des valeurs lues dans le
// credential importé. Un JSON de compte de service porte un champ `token_uri`
// qu'il serait naturel d'honorer : ce serait donner à quiconque peut importer
// un credential le pouvoir de faire fetcher une URL arbitraire par le serveur
// central (métadonnées cloud, KMS, réseau interne — cf. lib/safe-fetch.ts et
// failles.md §6). Google n'a qu'un endpoint de jetons ; on l'écrit en dur et on
// ignore le champ. Même discipline côté Apple.
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const PLAY_API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const ASC_API_BASE = "https://api.appstoreconnect.apple.com/v1";

/**
 * Issue d'une sonde. `ok` porte le PÉRIMÈTRE obtenu (le but du geste) ; les
 * autres cas nomment la cause avec assez de précision pour que l'utilisateur
 * sache quoi corriger — « invité mais sans droit sur cette app » et « clé
 * invalide » n'appellent pas la même action.
 */
export type StoreProbe =
  | { ok: true; identity: string | null; scope: string[] }
  | {
      ok: false;
      code:
        | "invalid_key"
        | "unauthorized"
        | "forbidden"
        | "app_not_found"
        | "unreachable";
      /** Détail court, pour le log serveur — jamais un corps de réponse brut. */
      detail?: string;
    };

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

/** Réduit un corps d'erreur à quelque chose de loggable : borné, sur une ligne. */
function briefly(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

// ── Google Play ────────────────────────────────────────────────────────────

type ServiceAccount = { clientEmail: string; privateKey: string };

function parseServiceAccount(json: string): ServiceAccount | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const clientEmail = typeof o.client_email === "string" ? o.client_email : "";
  // Le JSON de Google porte les sauts de ligne échappés ; selon le chemin par
  // lequel le fichier a transité (copier-coller, variable d'env, éditeur), ils
  // peuvent être restés littéraux. `importPKCS8` exige de VRAIS sauts de ligne.
  const privateKey =
    typeof o.private_key === "string" ? o.private_key.replace(/\\n/g, "\n") : "";
  if (!clientEmail || !privateKey.includes("BEGIN PRIVATE KEY")) return null;
  return { clientEmail, privateKey };
}

/** Jeton d'accès OAuth2 par assertion JWT (flux « compte de service »). */
async function googleAccessToken(sa: ServiceAccount): Promise<string | null> {
  let assertion: string;
  try {
    const key = await importPKCS8(sa.privateKey, "RS256");
    const now = Math.floor(Date.now() / 1000);
    assertion = await new SignJWT({ scope: PLAY_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.clientEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
  } catch {
    return null;
  }

  const res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: unknown };
  return typeof body.access_token === "string" ? body.access_token : null;
}

/**
 * Sonde Play : ce compte de service peut-il publier cette application, et sur
 * quelles pistes ?
 *
 * L'API Play n'expose la liste des pistes qu'à l'intérieur d'un « edit »
 * (brouillon transactionnel). On en ouvre donc un, on lit, on le SUPPRIME —
 * un edit jamais validé (`commit`) ne change rien au magasin, mais un edit
 * abandonné traînerait dans la console. Le `delete` est en `finally`.
 */
export async function probePlayAccess(
  serviceAccountJson: string,
  packageName: string,
): Promise<StoreProbe> {
  const sa = parseServiceAccount(serviceAccountJson);
  if (!sa) return { ok: false, code: "invalid_key" };

  let token: string | null;
  try {
    token = await googleAccessToken(sa);
  } catch (err) {
    return { ok: false, code: "unreachable", detail: String(err) };
  }
  if (!token) return { ok: false, code: "invalid_key" };

  const auth = { authorization: `Bearer ${token}` };
  const appUrl = `${PLAY_API_BASE}/applications/${encodeURIComponent(packageName)}`;

  let editId: string | null = null;
  try {
    const insert = await fetchWithTimeout(`${appUrl}/edits`, {
      method: "POST",
      headers: auth,
    });
    if (insert.status === 401) return { ok: false, code: "unauthorized" };
    // 403 = la clé est valide, mais ce compte de service n'est pas invité dans
    // la Play Console, ou n'a pas le droit « Publier » SUR CETTE application.
    // C'est le cas le plus fréquent, et le plus difficile à diagnostiquer dans
    // un log de CI — il mérite son propre code.
    if (insert.status === 403) {
      return { ok: false, code: "forbidden", detail: briefly(await insert.text()) };
    }
    if (insert.status === 404) return { ok: false, code: "app_not_found" };
    if (!insert.ok) {
      return { ok: false, code: "unreachable", detail: `edits.insert ${insert.status}` };
    }
    const edit = (await insert.json()) as { id?: unknown };
    editId = typeof edit.id === "string" ? edit.id : null;
    if (!editId) return { ok: false, code: "unreachable", detail: "edits.insert sans id" };

    const tracksRes = await fetchWithTimeout(`${appUrl}/edits/${editId}/tracks`, {
      headers: auth,
    });
    if (!tracksRes.ok) {
      return { ok: false, code: "forbidden", detail: `tracks.list ${tracksRes.status}` };
    }
    const tracks = (await tracksRes.json()) as { tracks?: unknown };
    const scope = Array.isArray(tracks.tracks)
      ? tracks.tracks
          .map((t) => (t && typeof t === "object" ? (t as { track?: unknown }).track : null))
          .filter((t): t is string => typeof t === "string" && t.length > 0)
          .sort()
      : [];
    return { ok: true, identity: sa.clientEmail, scope };
  } catch (err) {
    return { ok: false, code: "unreachable", detail: String(err) };
  } finally {
    if (editId) {
      // Best-effort : un edit non supprimé est inoffensif (il expire), mais il
      // encombre la console. L'échec du ménage ne doit pas changer le verdict.
      await fetchWithTimeout(`${appUrl}/edits/${editId}`, {
        method: "DELETE",
        headers: auth,
      }).catch(() => undefined);
    }
  }
}

// ── App Store Connect ──────────────────────────────────────────────────────

/**
 * Jeton d'API App Store Connect. Lève si la clé, le Key ID ou l'Issuer ID sont
 * inexploitables — l'appelant traduit en `invalid_key`.
 *
 * ⚠️ Apple REFUSE tout jeton dont la durée de vie dépasse 20 minutes ; on reste
 * très en deçà. Le `kid` va dans l'EN-TÊTE (pas dans le corps), l'`iss` est
 * l'Issuer ID de l'équipe : intervertir les deux produit un 401 indiscernable
 * d'une clé révoquée, d'où la sonde `probeAscAccess` qui les distingue.
 */
async function ascJwt(
  p8Pem: string,
  keyId: string,
  issuerId: string,
): Promise<string> {
  const key = await importPKCS8(p8Pem, "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
    .setIssuer(issuerId)
    .setAudience("appstoreconnect-v1")
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(key);
}

/**
 * Sonde ASC : cette clé d'API voit-elle l'application, et sous quel nom ?
 *
 * Trois issues à ne pas confondre, et c'est tout l'intérêt de la sonde :
 *   - 401             → la clé, le Key ID ou l'Issuer ID sont faux ;
 *   - 200 + data vide → la clé est BONNE mais ne voit pas ce bundle id (rôle
 *                       trop étroit, ou app pas encore créée dans ASC) ;
 *   - 200 + une app   → tout est en place.
 * Sans cette distinction, les trois se ressemblent : « ça ne marche pas ».
 */
export async function probeAscAccess(
  p8Pem: string,
  keyId: string,
  issuerId: string,
  bundleId: string,
): Promise<StoreProbe> {
  let jwt: string;
  try {
    jwt = await ascJwt(p8Pem, keyId, issuerId);
  } catch {
    return { ok: false, code: "invalid_key" };
  }

  try {
    const url = `${ASC_API_BASE}/apps?filter%5BbundleId%5D=${encodeURIComponent(
      bundleId,
    )}&limit=1`;
    const res = await fetchWithTimeout(url, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    if (res.status === 401) return { ok: false, code: "unauthorized" };
    if (res.status === 403) {
      return { ok: false, code: "forbidden", detail: briefly(await res.text()) };
    }
    if (!res.ok) {
      return { ok: false, code: "unreachable", detail: `apps ${res.status}` };
    }
    const body = (await res.json()) as { data?: unknown };
    const first = Array.isArray(body.data) ? body.data[0] : null;
    if (!first) return { ok: false, code: "app_not_found" };
    const attrs =
      first && typeof first === "object"
        ? ((first as { attributes?: Record<string, unknown> }).attributes ?? {})
        : {};
    const name = typeof attrs.name === "string" ? attrs.name : null;
    return { ok: true, identity: name, scope: [] };
  } catch (err) {
    return { ok: false, code: "unreachable", detail: String(err) };
  }
}

// ── App Store Connect — ÉMISSION (Phase 7, §5.5 du plan) ───────────────────
//
// Ce qui suit ne sonde plus, ça CRÉE : certificat de distribution et profil de
// provisioning, à partir de la seule clé `.p8`. C'est la moitié réseau de la
// chaîne « générer sans Mac ». Aucune de ces opérations n'a besoin de Xcode.

/** Identité ASC utilisée par toutes les opérations d'émission. */
export type AscAuth = { p8Pem: string; keyId: string; issuerId: string };

export type AscError = {
  /** Code HTTP, ou 0 si l'appel n'a même pas abouti. */
  status: number;
  /** Titre/détail renvoyé par Apple, borné — Apple est explicite et utile ici,
   *  contrairement à Google : on garde le message pour le rendre à l'utilisateur. */
  detail: string;
};

export class AscApiError extends Error {
  constructor(public readonly info: AscError) {
    super(`App Store Connect ${info.status}: ${info.detail}`);
    this.name = "AscApiError";
  }
}

/** Appel JSON:API authentifié. Lève `AscApiError` sur tout échec. */
async function ascCall(
  auth: AscAuth,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  let jwt: string;
  try {
    jwt = await ascJwt(auth.p8Pem, auth.keyId, auth.issuerId);
  } catch {
    throw new AscApiError({ status: 0, detail: "clé .p8 / Key ID / Issuer ID invalides" });
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`${ASC_API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${jwt}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw new AscApiError({ status: 0, detail: `App Store Connect injoignable (${String(err)})` });
  }

  if (res.status === 204) return {};
  const text = await res.text();
  if (!res.ok) {
    // Apple répond `{errors:[{title, detail}]}`. Le `detail` est la phrase la
    // plus actionnable de toute l'API (« There is no App ID with ID ... »),
    // c'est elle qu'on remonte plutôt qu'un code nu.
    let detail = briefly(text);
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ title?: string; detail?: string }> };
      const first = parsed.errors?.[0];
      if (first) detail = briefly(first.detail || first.title || text);
    } catch {
      // Corps non-JSON : on garde le texte borné.
    }
    throw new AscApiError({ status: res.status, detail });
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AscApiError({ status: res.status, detail: "réponse illisible" });
  }
}

function attrs(node: unknown): Record<string, unknown> {
  return node && typeof node === "object"
    ? ((node as { attributes?: Record<string, unknown> }).attributes ?? {})
    : {};
}

function idOf(node: unknown): string | null {
  const v = node && typeof node === "object" ? (node as { id?: unknown }).id : null;
  return typeof v === "string" ? v : null;
}

export type AscCertificate = {
  id: string;
  name: string;
  type: string;
  expiresAt: string | null;
  /** DER du certificat. Absent des listes, présent à la création. */
  der: Buffer | null;
};

function toCertificate(node: unknown): AscCertificate | null {
  const id = idOf(node);
  if (!id) return null;
  const a = attrs(node);
  const content = typeof a.certificateContent === "string" ? a.certificateContent : null;
  return {
    id,
    name: typeof a.name === "string" ? a.name : "",
    type: typeof a.certificateType === "string" ? a.certificateType : "",
    expiresAt: typeof a.expirationDate === "string" ? a.expirationDate : null,
    der: content ? Buffer.from(content, "base64") : null,
  };
}

/**
 * Certificats de distribution existants.
 *
 * ⚠️ Garde-fou §5.5 : Apple PLAFONNE le nombre de certificats de distribution
 * (2 à 3 selon le type de compte). Générer sans jamais lister ni révoquer
 * cognerait le mur — et c'est un mur qu'on ne peut pas franchir depuis l'API,
 * seulement en révoquant. Tout parcours de génération doit donc lister d'abord.
 */
export async function ascListDistributionCertificates(
  auth: AscAuth,
): Promise<AscCertificate[]> {
  const body = await ascCall(
    auth,
    "/certificates?filter%5BcertificateType%5D=DISTRIBUTION&limit=200",
  );
  const data = Array.isArray(body.data) ? body.data : [];
  return data.map(toCertificate).filter((c): c is AscCertificate => c !== null);
}

/**
 * Étape 2 de la chaîne : la CSR part, le certificat de distribution revient.
 * C'est l'appel que tout le monde croit réservé à Xcode.
 */
export async function ascCreateDistributionCertificate(
  auth: AscAuth,
  csrPem: string,
): Promise<AscCertificate> {
  const body = await ascCall(auth, "/certificates", {
    method: "POST",
    body: {
      data: {
        type: "certificates",
        attributes: { certificateType: "DISTRIBUTION", csrContent: csrPem },
      },
    },
  });
  const cert = toCertificate(body.data);
  if (!cert || !cert.der) {
    throw new AscApiError({ status: 0, detail: "certificat créé mais contenu absent" });
  }
  return cert;
}

/** Révocation (l'équivalent de `match nuke`) — la seule façon de faire de la
 *  place sous le plafond Apple. */
export async function ascRevokeCertificate(auth: AscAuth, certificateId: string): Promise<void> {
  await ascCall(auth, `/certificates/${encodeURIComponent(certificateId)}`, {
    method: "DELETE",
  });
}

/**
 * Résout un bundle id TEXTE ("fr.argoweb.app") en identifiant de RESSOURCE ASC.
 *
 * Étape facile à manquer : l'API des profils ne veut pas de la chaîne, elle
 * veut l'id opaque de la ressource `bundleIds`. Un `null` ici signifie que
 * l'App ID n'est pas enregistré dans le compte développeur — cause n°1 d'échec
 * de création de profil, et un message bien plus clair qu'un 409 d'Apple.
 */
export async function ascFindBundleIdResource(
  auth: AscAuth,
  bundleId: string,
): Promise<string | null> {
  const body = await ascCall(
    auth,
    `/bundleIds?filter%5Bidentifier%5D=${encodeURIComponent(bundleId)}&limit=200`,
  );
  const data = Array.isArray(body.data) ? body.data : [];
  // Le filtre d'Apple se comporte comme un « contient » : `fr.argoweb.app`
  // remonterait aussi `fr.argoweb.app.extension`. On exige l'égalité stricte,
  // sinon on fabriquerait un profil pour l'extension au lieu de l'app.
  for (const node of data) {
    if (attrs(node).identifier === bundleId) return idOf(node);
  }
  return null;
}

export type AscProfile = {
  id: string;
  name: string;
  expiresAt: string | null;
  /** Le `.mobileprovision` lui-même. */
  content: Buffer;
};

/**
 * Étape 4 de la chaîne : le profil de provisioning App Store.
 *
 * `IOS_APP_STORE` ne prend PAS de liste d'appareils (contrairement à un profil
 * ad hoc ou de développement) — c'est précisément ce qui rend l'opération
 * faisable sans Mac et sans device enregistré.
 */
export async function ascCreateAppStoreProfile(
  auth: AscAuth,
  opts: { name: string; bundleIdResourceId: string; certificateIds: string[] },
): Promise<AscProfile> {
  const body = await ascCall(auth, "/profiles", {
    method: "POST",
    body: {
      data: {
        type: "profiles",
        attributes: { name: opts.name, profileType: "IOS_APP_STORE" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: opts.bundleIdResourceId } },
          certificates: {
            data: opts.certificateIds.map((id) => ({ type: "certificates", id })),
          },
        },
      },
    },
  });
  const id = idOf(body.data);
  const a = attrs(body.data);
  const content = typeof a.profileContent === "string" ? a.profileContent : null;
  if (!id || !content) {
    throw new AscApiError({ status: 0, detail: "profil créé mais contenu absent" });
  }
  return {
    id,
    name: typeof a.name === "string" ? a.name : opts.name,
    expiresAt: typeof a.expirationDate === "string" ? a.expirationDate : null,
    content: Buffer.from(content, "base64"),
  };
}
