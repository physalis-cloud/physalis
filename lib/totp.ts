// 2FA TOTP — helpers purs autour d'otplib v13.
//
// Le secret TOTP est chiffré au repos avec lib/crypto.ts (même ENCRYPTION_KEY
// que les secrets métier). Les backup codes sont bcrypt-hashés. Le hash et
// les opérations crypto sont gérés ici, mais l'IO DB est laissée aux routes.

import { generateSecret, generateURI, verify } from "otplib";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";

const APP_NAME = "Physalis";
const BACKUP_CODE_BYTES = 8; // 64 bits d'entropie, hex = 16 chars
/** Forme exacte produite par `generateBackupCodes` : 16 hex minuscules. */
const BACKUP_CODE_RE = /^[0-9a-f]{16}$/;
const BACKUP_CODES_COUNT = 8;
const BCRYPT_ROUNDS = 12;

// Tolérance de ±30 s autour de la fenêtre courante pour gérer la dérive
// d'horloge entre serveur et téléphone.
const EPOCH_TOLERANCE = 30;

export function generateTotpSecret(): string {
  return generateSecret();
}

export function generateOtpauthUrl(email: string, secret: string): string {
  return generateURI({
    issuer: APP_NAME,
    label: email,
    secret,
  });
}

export async function generateQrDataUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M" });
}

export type TotpVerifyResult = {
  valid: boolean;
  /** Pas de temps consommé (RFC 6238) — à persister pour l'anti-rejeu. null si invalide. */
  timeStep: number | null;
};

/**
 * Vérifie un code TOTP et **retourne le pas de temps** consommé (`timeStep`),
 * pour que l'appelant puisse implémenter l'anti-rejeu (RFC 6238 §5.2) : un code
 * est valide ~90 s (fenêtre courante + tolérance ±30 s), donc rejouable sans
 * mémoire du pas déjà utilisé.
 *
 * `afterTimeStep` (= dernier pas consommé par ce user) est passé à otplib qui
 * **rejette tout code dont le `timeStep <= afterTimeStep`** — bloque le rejeu
 * séquentiel. La persistance atomique du `timeStep` (par l'appelant, via un
 * update conditionnel) ferme la course entre deux soumissions concurrentes.
 */
export async function verifyTotp(
  code: string,
  secret: string,
  afterTimeStep?: number | null,
): Promise<TotpVerifyResult> {
  // otplib throw `TokenLengthError` si le token n'a pas la longueur attendue
  // (6 digits par défaut). Notre flow tente d'abord verifyTotp avant de
  // fallback sur les backup codes (16 chars hex). On catch les erreurs de
  // format pour retourner {valid:false} plutôt que de crasher l'auth.
  try {
    const result = await verify({
      token: code.trim(),
      secret,
      epochTolerance: EPOCH_TOLERANCE,
      ...(afterTimeStep != null ? { afterTimeStep } : {}),
    });
    // `verify` (fonctionnel, stratégie-agnostique) renvoie l'union TOTP|HOTP ;
    // `timeStep` n'existe que sur la branche TOTP. On ne passe jamais `counter`
    // (HOTP), donc c'est toujours du TOTP — le guard narrow proprement.
    return result.valid && "timeStep" in result
      ? { valid: true, timeStep: result.timeStep }
      : { valid: false, timeStep: null };
  } catch {
    return { valid: false, timeStep: null };
  }
}

type UserTimeStepUpdateMany = (args: {
  where: {
    id: string;
    OR: [{ lastTotpTimeStep: null }, { lastTotpTimeStep: { lt: number } }];
  };
  data: { lastTotpTimeStep: number };
}) => Promise<{ count: number }>;

/**
 * §2.17 — Consomme **atomiquement** un pas de temps TOTP : l'update conditionnel
 * n'écrit (donc n'accepte) que si `timeStep` est strictement supérieur au dernier
 * consommé (ou s'il n'y en a pas encore). Retourne `true` si CE call a gagné la
 * course (pas neuf → accepter), `false` si un autre l'a déjà pris (rejeu / soumission
 * concurrente du même code). `updateMany` = le délégué `user.updateMany` du client
 * courant (transaction, `prisma` tenant, ou `basePrisma`) — passé en callback pour
 * rester compatible avec les deux clients Prisma sans cast.
 */
export async function consumeTotpTimeStep(
  updateMany: UserTimeStepUpdateMany,
  userId: string,
  timeStep: number,
): Promise<boolean> {
  const { count } = await updateMany({
    where: {
      id: userId,
      OR: [{ lastTotpTimeStep: null }, { lastTotpTimeStep: { lt: timeStep } }],
    },
    data: { lastTotpTimeStep: timeStep },
  });
  return count === 1;
}

/**
 * Génère N backup codes plaintext. Format : `randomBytes(8).hex()` = 16 chars
 * lowercase, lisibles sans confusion.
 */
export function generateBackupCodes(count = BACKUP_CODES_COUNT): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(BACKUP_CODE_BYTES).toString("hex"),
  );
}

export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((c) => bcrypt.hash(c, BCRYPT_ROUNDS)));
}

/**
 * Vérifie un code candidat contre la liste de hashes en base. Retourne
 * l'index du hash qui matche (>= 0) ou -1 si aucun ne matche. Comparaisons
 * séquentielles (8 codes max → 8 × ~250 ms en pire cas).
 */
export async function findBackupCodeIndex(
  candidate: string,
  hashes: string[],
): Promise<number> {
  const trimmed = candidate.trim().toLowerCase();
  // Court-circuit de format : un candidat qui n'a pas la forme d'un backup code
  // ne peut matcher aucun hash. Sans ce filtre, un code TOTP à 6 chiffres (ou
  // n'importe quelle chaîne) consommait 8 bcrypt cost 12, soit ~2 s de CPU
  // offerts à tout appelant non authentifié sur un process mono-thread.
  if (!BACKUP_CODE_RE.test(trimmed)) return -1;
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(trimmed, hashes[i]!)) return i;
  }
  return -1;
}
