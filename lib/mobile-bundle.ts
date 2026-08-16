// Chantier "Déploiement mobile" — Phase 2 : construction du bundle de signature.
//
// Déchiffre le matériel d'une application et l'agence en une charge utile
// destinée au CI. Partagé par la route SaaS et son jumeau self-host — la seule
// chose qui diffère entre les deux est la RÉSOLUTION (quel client Prisma, quel
// gate), pas la construction du bundle une fois l'app connue.
//
// ⚠️ C'est le SEUL endroit qui rend en clair le matériel de signature. Rien ici
// ne le journalise, ne le met en cache, ne le renvoie ailleurs que dans la
// réponse HTTP TLS à un pipeline déjà autorisé par sa policy.

import { decrypt } from "./crypto";
import { MOBILE_FILE_KINDS } from "./mobile-credentials";
import type { PrismaClient } from "@prisma/client";

/** Le sous-ensemble de Prisma dont ce module a besoin — accepte aussi bien un
 *  client tenant (getTenantPrisma) que le client unique du self-host, sans les
 *  coupler ni tirer l'un dans le build de l'autre. */
type MobileCredentialReader = Pick<PrismaClient, "mobileCredential">;
type MobileAppWriter = Pick<PrismaClient, "mobileApp">;

/** Une entrée du bundle. `encoding` dit au CI quoi faire de `value` :
 *   - "base64" (kinds fichier) : à écrire tel quel dans un fichier binaire ;
 *   - "utf8"   (kinds texte)   : un mot de passe / identifiant, déjà décodé. */
export type MobileBundleEntry = {
  kind: string;
  value: string;
  encoding: "base64" | "utf8";
  filename: string | null;
  sha256: string;
  expiresAt: string | null;
};

export type MobileBundle = {
  app: {
    id: string;
    platform: string;
    bundleId: string;
    displayName: string;
    vendorTeamId: string | null;
  };
  credentials: MobileBundleEntry[];
};

/**
 * Construit le bundle d'une application déjà résolue et autorisée.
 *
 * @param db      client Prisma DÉJÀ scopé au bon tenant (getTenantPrisma côté
 *                SaaS, client unique côté self-host) — ce module ne résout ni
 *                tenant ni droits, il fait confiance à l'appelant.
 * @param app     métadonnées de l'app (issues de la résolution de policy).
 * @returns le bundle, ou `null` si l'app n'a AUCUN credential — un pipeline qui
 *          ne peut rien signer doit recevoir un échec clair, pas un bundle vide
 *          qui casserait plus loin, au moment du build.
 */
export async function buildMobileBundle(
  db: MobileCredentialReader,
  app: {
    id: string;
    platform: string;
    bundleId: string;
    displayName: string;
    vendorTeamId: string | null;
  },
): Promise<MobileBundle | null> {
  const rows = await db.mobileCredential.findMany({
    where: { appId: app.id },
    select: {
      kind: true,
      filename: true,
      sha256: true,
      expiresAt: true,
      encryptedValue: true,
      iv: true,
      tag: true,
    },
    orderBy: { kind: "asc" },
  });
  if (rows.length === 0) return null;

  const credentials: MobileBundleEntry[] = rows.map((r) => {
    // La valeur stockée est TOUJOURS la chaîne base64 d'origine, chiffrée.
    const base64 = decrypt({
      encryptedValue: r.encryptedValue,
      iv: r.iv,
      tag: r.tag,
    });
    const isFile = MOBILE_FILE_KINDS.has(r.kind);
    return {
      kind: r.kind,
      // Un fichier repart en base64 (le CI l'écrit tel quel) ; un texte est
      // décodé — le CI reçoit le mot de passe / l'identifiant directement.
      value: isFile ? base64 : Buffer.from(base64, "base64").toString("utf8"),
      encoding: isFile ? "base64" : "utf8",
      filename: r.filename,
      sha256: r.sha256,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    };
  });

  return {
    app: {
      id: app.id,
      platform: app.platform,
      bundleId: app.bundleId,
      displayName: app.displayName,
      vendorTeamId: app.vendorTeamId,
    },
    credentials,
  };
}

/**
 * Consomme le prochain numéro de build de l'application, ATOMIQUEMENT.
 *
 * `buildNumber + 1` en une seule écriture SQL (`increment`) : deux
 * déploiements concurrents reçoivent deux numéros distincts, jamais le même.
 * Retourne le nouveau numéro et la version marketing courante. Compteur LOCAL
 * (repli §4.5 du plan) : un échec de build après cet appel « brûle » un numéro,
 * ce qui est sans conséquence — un numéro de build doit croître, pas être
 * contigu. À n'appeler qu'APRÈS avoir vérifié qu'un bundle existe (sinon on
 * incrémenterait pour un déploiement qui ne peut rien produire).
 */
export async function consumeBuildNumber(
  db: MobileAppWriter,
  appId: string,
): Promise<{ buildNumber: number; versionName: string | null }> {
  const app = await db.mobileApp.update({
    where: { id: appId },
    data: { buildNumber: { increment: 1 } },
    select: { buildNumber: true, versionName: true },
  });
  return app;
}
