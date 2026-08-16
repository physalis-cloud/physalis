// Chantier "Déploiement mobile" — Phase 2 : validation d'accréditation.
// Cf. documentation/plans/deploiement-mobile.md §7.
//
// « Un credential mal doté échoue AU PREMIER DÉPLOIEMENT, c'est-à-dire au pire
// moment » (§7). Ce module répond à la question avant, sur demande : le matériel
// déposé est-il cohérent entre lui, et les clés d'API ont-elles réellement le
// droit de publier cette application ?
//
// Deux moitiés, délibérément séparées :
//   - hors ligne (lib/mobile-inspect.ts) : l'alias existe-t-il dans le keystore,
//     le profil couvre-t-il ce bundle id, le certificat du .p12 est-il celui que
//     le profil embarque. Déterministe, sans réseau, toujours exécutée.
//   - en ligne (lib/mobile-store-api.ts) : le périmètre réel chez Google/Apple.
//     Optionnelle — une console injoignable dégrade le rapport, ne le casse pas.
//
// Partagé par la route SaaS et son jumeau self-host, comme lib/mobile-bundle.ts :
// seule la RÉSOLUTION diffère entre les deux, pas la vérification.
//
// ⚠️ SERVER-ONLY (openssl + fetch sortant). Le panneau, qui est un composant
// client, ne doit importer d'ici que des TYPES.

import { decrypt } from "./crypto";
import { MOBILE_FILE_KINDS } from "./mobile-credentials";
import {
  inspectPkcs12,
  inspectProvisioningProfile,
  profileCoversBundleId,
} from "./mobile-inspect";
import { probeAscAccess, probePlayAccess } from "./mobile-store-api";
import type { StoreProbe } from "./mobile-store-api";

/** Le sous-ensemble de Prisma dont ce module a besoin. Typage STRUCTUREL et
 *  volontairement lâche — même motif que `Db` dans lib/ci-connection.ts. Un
 *  `Pick<PrismaClient, "mobileCredential">` ne conviendrait PAS : la route SaaS
 *  passe le client tenant-aware ÉTENDU (`$extends`), dont les signatures
 *  génériques ne sont pas assignables à celles du client nu, tandis que le
 *  jumeau self-host passe un client simple. */
type MobileCredentialReader = {
  mobileCredential: {
    findMany: (args: {
      where: { appId: string };
      select: Record<string, unknown>;
    }) => Promise<unknown>;
  };
};

type CredentialRow = {
  kind: string;
  encryptedValue: string;
  iv: string;
  tag: string;
};

/** Catégorie d'une vérification — sert de regroupement et d'icône dans l'UI.
 *  Plusieurs constats peuvent partager une catégorie. */
export type MobileCheckId =
  | "completeness"
  | "keystore"
  | "certificate"
  | "profile"
  | "play"
  | "asc";

/**
 *  - `fail`    : ce déploiement échouera. C'est la raison d'être du geste.
 *  - `warn`    : ça publiera, mais quelque chose mérite un regard.
 *  - `skipped` : pas assez de matériel pour conclure — DISTINCT de `ok`. Un
 *                contrôle qui n'a pas tourné ne doit jamais ressembler à un
 *                contrôle qui a réussi (leçon du `.p12` sans date, §5.4).
 */
export type MobileCheckStatus = "ok" | "warn" | "fail" | "skipped";

/** Un constat. `code` est une CLÉ i18n, jamais une phrase : le panneau est
 *  trilingue (fr/en/es) et la traduction n'appartient pas au serveur.
 *
 *  Les codes sont GLOBALEMENT uniques, pas scopés par catégorie : « illisible »
 *  ne veut pas dire la même chose pour un keystore (mot de passe / JKS legacy),
 *  un `.p12` (RC2-40) et un profil (CMS). Des codes partagés auraient forcé des
 *  phrases vagues, c'est-à-dire inutiles. Seuls les quatre constats d'échéance
 *  sont réellement génériques et restent partagés. */
export type MobileCheck = {
  id: MobileCheckId;
  status: MobileCheckStatus;
  code: string;
  params?: Record<string, string | number>;
};

export type MobileVerifyReport = {
  checkedAt: string;
  /** true si les sondes réseau ont tourné ; false = rapport hors ligne. */
  network: boolean;
  checks: MobileCheck[];
};

/** Matériel indispensable à une publication, par plateforme. */
const REQUIRED_KINDS: Record<string, string[]> = {
  android: [
    "android_keystore",
    "android_keystore_password",
    "android_key_alias",
    "play_service_account",
  ],
  ios: [
    "ios_p12",
    "ios_p12_password",
    "ios_profile",
    "asc_api_key",
    "asc_key_id",
    "asc_issuer_id",
  ],
};

/** Seuil du rappel « ça expire bientôt » — aligné sur le J-30 de la Phase 4. */
const EXPIRY_WARN_DAYS = 30;

function daysUntil(date: Date): number {
  return Math.floor((date.getTime() - Date.now()) / 86_400_000);
}

function shortDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Traduit une issue de sonde en constat, sans dupliquer la table de codes. */
function probeCheck(id: "play" | "asc", probe: StoreProbe): MobileCheck {
  if (probe.ok) {
    return {
      id,
      status: "ok",
      // Le périmètre est le BUT du geste : quand on l'a, on le dit.
      code: probe.scope.length > 0 ? `${id}_ok_scope` : `${id}_ok`,
      params: {
        identity: probe.identity ?? "—",
        ...(probe.scope.length > 0 ? { scope: probe.scope.join(", ") } : {}),
      },
    };
  }
  // `unreachable` n'est PAS un échec du credential : c'est un échec de notre
  // sonde. Le dire autrement enverrait le client réémettre une clé correcte.
  return {
    id,
    status: probe.code === "unreachable" ? "warn" : "fail",
    code: `${id}_${probe.code}`,
  };
}

/**
 * Vérifie le matériel d'une application déjà résolue et autorisée.
 *
 * @param db  client Prisma DÉJÀ scopé au bon tenant — ce module ne résout ni
 *            tenant ni droits, exactement comme lib/mobile-bundle.ts.
 * @param opts.network  false = sondes magasin sautées (rapport hors ligne).
 *
 * Ne lève jamais : un rapport partiel vaut mieux qu'une erreur 500 sur un geste
 * de diagnostic.
 */
export async function verifyMobileApp(
  db: MobileCredentialReader,
  app: { id: string; platform: string; bundleId: string; vendorTeamId: string | null },
  opts: { network?: boolean } = {},
): Promise<MobileVerifyReport> {
  const network = opts.network !== false;
  const checks: MobileCheck[] = [];

  const rows = (await db.mobileCredential.findMany({
    where: { appId: app.id },
    select: { kind: true, encryptedValue: true, iv: true, tag: true },
  })) as CredentialRow[];

  // Le stockage est TOUJOURS du base64 chiffré (§4.4) : un fichier redevient
  // des octets, un texte redevient une chaîne.
  const files = new Map<string, Buffer>();
  const texts = new Map<string, string>();
  for (const r of rows) {
    const base64 = decrypt({
      encryptedValue: r.encryptedValue,
      iv: r.iv,
      tag: r.tag,
    });
    const raw = Buffer.from(base64, "base64");
    if (MOBILE_FILE_KINDS.has(r.kind)) files.set(r.kind, raw);
    else texts.set(r.kind, raw.toString("utf8"));
  }
  const present = new Set([...files.keys(), ...texts.keys()]);

  // ── Complétude ───────────────────────────────────────────────────────────
  const required = REQUIRED_KINDS[app.platform] ?? [];
  const missing = required.filter((k) => !present.has(k));
  checks.push(
    missing.length === 0
      ? { id: "completeness", status: "ok", code: "complete" }
      : {
          id: "completeness",
          status: "fail",
          code: "missing",
          params: { kinds: missing.join(", "), count: missing.length },
        },
  );

  if (app.platform === "android") {
    await verifyAndroid(checks, app, files, texts, network);
  } else if (app.platform === "ios") {
    await verifyIos(checks, app, files, texts, network);
  }

  return { checkedAt: new Date().toISOString(), network, checks };
}

async function verifyAndroid(
  checks: MobileCheck[],
  app: { bundleId: string },
  files: Map<string, Buffer>,
  texts: Map<string, string>,
  network: boolean,
): Promise<void> {
  // ── Keystore : le contrôle qui aurait attrapé le keystore incomplet ──────
  const keystore = files.get("android_keystore");
  const storePass = texts.get("android_keystore_password") ?? "";
  const alias = (texts.get("android_key_alias") ?? "").trim();

  if (!keystore) {
    checks.push({ id: "keystore", status: "skipped", code: "keystore_absent" });
  } else {
    const info = await inspectPkcs12(keystore, storePass);
    if (!info.readable) {
      // Deux causes indissociables côté openssl (mauvais mot de passe / octets
      // altérés), plus une troisième bien réelle : un keystore JKS antérieur à
      // Java 9, qu'openssl ne sait pas lire du tout.
      checks.push({ id: "keystore", status: "fail", code: "keystore_unreadable" });
    } else {
      if (!alias) {
        checks.push({ id: "keystore", status: "fail", code: "keystore_alias_missing" });
      } else if (
        // keytool normalise les alias en minuscules : comparer sensiblement à
        // la casse produirait un faux négatif sur un keystore parfaitement bon.
        info.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())
      ) {
        checks.push({
          id: "keystore",
          status: "ok",
          code: "keystore_alias_ok",
          params: { alias },
        });
      } else {
        checks.push({
          id: "keystore",
          status: "fail",
          code: "keystore_alias_absent",
          params: {
            alias,
            found: info.aliases.length > 0 ? info.aliases.join(", ") : "—",
          },
        });
      }

      // Gradle exige `keyPassword` pour ouvrir la clé ; un conteneur PKCS12
      // n'en accepte qu'un, égal au mot de passe du magasin. Deux valeurs
      // différentes passent l'import, ouvrent le keystore… et cassent la
      // signature au build. Avertissement, pas échec : un keystore JKS
      // converti peut légitimement en porter deux.
      const keyPass = texts.get("android_key_password");
      if (keyPass !== undefined && keyPass !== storePass) {
        checks.push({
          id: "keystore",
          status: "warn",
          code: "keystore_key_password_differs",
        });
      }

      pushExpiry(checks, "keystore", info.notAfter);
    }
  }

  // ── Accréditation Play ───────────────────────────────────────────────────
  const sa = files.get("play_service_account");
  if (!sa) {
    checks.push({ id: "play", status: "skipped", code: "play_absent" });
  } else if (!network) {
    checks.push({ id: "play", status: "skipped", code: "play_offline" });
  } else {
    checks.push(probeCheck("play", await probePlayAccess(sa.toString("utf8"), app.bundleId)));
  }
}

async function verifyIos(
  checks: MobileCheck[],
  app: { bundleId: string; vendorTeamId: string | null },
  files: Map<string, Buffer>,
  texts: Map<string, string>,
  network: boolean,
): Promise<void> {
  // ── Certificat de distribution ───────────────────────────────────────────
  const p12 = files.get("ios_p12");
  let certSha: string | null = null;
  if (!p12) {
    checks.push({ id: "certificate", status: "skipped", code: "p12_absent" });
  } else {
    const info = await inspectPkcs12(p12, texts.get("ios_p12_password") ?? "");
    if (!info.readable) {
      checks.push({ id: "certificate", status: "fail", code: "p12_unreadable" });
    } else {
      certSha = info.sha256;
      checks.push({
        id: "certificate",
        status: "ok",
        code: "p12_readable",
        params: { subject: info.subject ?? "—" },
      });
      pushExpiry(checks, "certificate", info.notAfter);
    }
  }

  // ── Profil de provisioning ───────────────────────────────────────────────
  const profile = files.get("ios_profile");
  if (!profile) {
    checks.push({ id: "profile", status: "skipped", code: "profile_absent" });
  } else {
    const info = await inspectProvisioningProfile(profile);
    if (!info.readable) {
      checks.push({ id: "profile", status: "fail", code: "profile_unreadable" });
    } else {
      // Le contrôle décisif : un profil ne signe QUE les bundle ids qu'il
      // couvre. Un profil pris pour une autre app est l'erreur la plus banale
      // et la plus opaque — Xcode répond « no matching provisioning profile ».
      if (profileCoversBundleId(info.appIdPattern, app.bundleId)) {
        checks.push({
          id: "profile",
          status: "ok",
          code: "profile_bundle_ok",
          params: { pattern: info.appIdPattern ?? "—" },
        });
      } else {
        checks.push({
          id: "profile",
          status: "fail",
          code: "profile_bundle_mismatch",
          params: { pattern: info.appIdPattern ?? "—", bundleId: app.bundleId },
        });
      }

      // Un profil de DÉVELOPPEMENT est accepté à l'import, produit un build
      // signé, et se fait refuser au téléversement. Autant le dire ici.
      if (info.isDevelopment) {
        checks.push({ id: "profile", status: "fail", code: "profile_development" });
      } else if (info.hasProvisionedDevices) {
        // Pas de `get-task-allow` mais une liste d'appareils = profil ad hoc :
        // distribution hors magasin, jamais App Store.
        checks.push({ id: "profile", status: "fail", code: "profile_adhoc" });
      }

      // Corrélation certificat ↔ profil : un profil n'autorise QUE les
      // certificats qu'il embarque. Renouveler le .p12 sans régénérer le
      // profil est le grand classique du vendredi de release.
      if (certSha && info.certificateSha256.length > 0) {
        checks.push(
          info.certificateSha256.includes(certSha)
            ? { id: "profile", status: "ok", code: "profile_cert_match" }
            : { id: "profile", status: "fail", code: "profile_cert_mismatch" },
        );
      }

      if (
        app.vendorTeamId &&
        info.teamId &&
        info.teamId !== app.vendorTeamId
      ) {
        checks.push({
          id: "profile",
          status: "warn",
          code: "profile_team_mismatch",
          params: { expected: app.vendorTeamId, found: info.teamId },
        });
      }

      pushExpiry(checks, "profile", info.expiresAt);
    }
  }

  // ── Accréditation App Store Connect ──────────────────────────────────────
  const p8 = files.get("asc_api_key");
  const keyId = (texts.get("asc_key_id") ?? "").trim();
  const issuerId = (texts.get("asc_issuer_id") ?? "").trim();
  if (!p8 || !keyId || !issuerId) {
    checks.push({ id: "asc", status: "skipped", code: "asc_absent" });
  } else if (!network) {
    checks.push({ id: "asc", status: "skipped", code: "asc_offline" });
  } else {
    checks.push(
      probeCheck(
        "asc",
        await probeAscAccess(p8.toString("utf8"), keyId, issuerId, app.bundleId),
      ),
    );
  }
}

/** Constat d'échéance commun aux trois porteurs de date. `null` = date non lue,
 *  ce qui est un `skipped` explicite et non un silence (cf. §5.4). */
function pushExpiry(
  checks: MobileCheck[],
  id: MobileCheckId,
  notAfter: Date | null,
): void {
  if (!notAfter) {
    checks.push({ id, status: "skipped", code: "expiry_unknown" });
    return;
  }
  const days = daysUntil(notAfter);
  if (days < 0) {
    checks.push({
      id,
      status: "fail",
      code: "expired",
      params: { date: shortDate(notAfter) },
    });
  } else if (days <= EXPIRY_WARN_DAYS) {
    checks.push({
      id,
      status: "warn",
      code: "expiring",
      params: { date: shortDate(notAfter), days },
    });
  } else {
    checks.push({
      id,
      status: "ok",
      code: "valid_until",
      params: { date: shortDate(notAfter) },
    });
  }
}
