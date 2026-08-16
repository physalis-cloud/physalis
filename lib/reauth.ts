// Ré-authentification des actions IRRÉVERSIBLES — « prouver que c'est bien
// vous », par opposition à la phrase à recopier qui prouve seulement que le
// geste est délibéré.
//
// ⚠️ Les deux contrôles ne se remplacent PAS. La phrase à recopier est affichée
// à l'écran : quiconque détient une session volée la lit et la recopie. Elle
// défend contre l'accident, jamais contre l'usurpation. Voir
// documentation/plans/suppression-compte.md § « Deux contrôles distincts ».
//
// N'appliquer QUE sur l'irréversible : une action récupérable (demande de
// suppression avec fenêtre de 30 j, réactivation…) n'a pas à payer ce coût.
//
// ── Provisoire, et assumé comme tel ────────────────────────────────────────
// Ce module est une MARCHE vers le step-up / sudo-mode de `failles.md §28.3`
// (proof signé à TTL court, réutilisable par toutes les actions sensibles,
// re-play IdP pour les comptes fédérés). Quand ce mécanisme arrivera, on
// remplacera l'implémentation de `verifyReauth` — PAS ses appelants. D'où le
// helper unique : aucune vérification ne doit être recopiée dans un endpoint.

import bcrypt from "bcryptjs";
import { decrypt } from "@/lib/crypto";
import { findBackupCodeIndex, verifyTotp, consumeTotpTimeStep } from "@/lib/totp";

/**
 * Fenêtre de fraîcheur du palier 3. 15 min : assez court pour qu'un cookie volé
 * de longue date échoue, assez long pour ne pas re-demander l'IdP entre deux
 * clics d'un même parcours.
 */
export const REAUTH_FRESHNESS_MS = 15 * 60 * 1000;

/**
 * Quelle preuve d'identité CE compte est capable de fournir.
 *
 * `User.password` est **nullable** : un compte SSO/social n'a pas de mot de
 * passe Physalis. Une garde « ressaisissez votre mot de passe » y serait
 * impossible à satisfaire — d'où l'échelle.
 */
export type ReauthMethod = "password" | "totp" | "freshness";

export function reauthMethodFor(user: {
  hasPassword: boolean;
  twoFactorEnabled: boolean;
}): ReauthMethod {
  // Palier 1 — compte classique. Le mot de passe reste la preuve la plus forte
  // dont on dispose ; la 2FA s'y ajoute quand elle est active (cf. verifyReauth).
  if (user.hasPassword) return "password";
  // Palier 2 — compte fédéré qui a activé la 2FA : le TOTP est une preuve de
  // possession, indépendante de l'IdP.
  if (user.twoFactorEnabled) return "totp";
  // Palier 3 — compte fédéré sans second facteur : rien à vérifier localement.
  // On exige une session FRAÎCHE, ce qui oblige à repasser par l'IdP. C'est un
  // re-play du fournisseur d'identité au rabais, sans mécanisme nouveau.
  return "freshness";
}

/** Palier 3 : la session est-elle assez récente ? `loginAt` vient du JWT. */
export function isSessionFresh(
  loginAt: number | null,
  now: number = Date.now(),
): boolean {
  // `null` = token legacy (antérieur au champ) : on NE peut pas prouver la
  // fraîcheur, donc on refuse. Fail-closed — c'est une action irréversible.
  if (loginAt == null) return false;
  return now - loginAt <= REAUTH_FRESHNESS_MS;
}

export type ReauthProof = {
  /** Palier 1. */
  password?: string;
  /** Paliers 1 (si 2FA active) et 2. Accepte aussi un backup code. */
  code?: string;
};

export type ReauthResult =
  | { ok: true; method: ReauthMethod }
  | { ok: false; method: ReauthMethod; reason: string; status: 400 | 401 };

type ReauthUser = {
  id: string;
  password: string | null;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  twoFactorIv: string | null;
  twoFactorTag: string | null;
  backupCodes: string[];
  lastTotpTimeStep: number | null;
};

/** Le délégué `user.updateMany` du client Prisma courant (tenant ou base). */
type UserUpdateMany = Parameters<typeof consumeTotpTimeStep>[0];

/**
 * Retire DÉFINITIVEMENT un backup code (son hash) de la liste de l'user.
 * Passé en callback pour que ce module reste sans dépendance à un client
 * Prisma — comme `updateMany`.
 *
 * ⚠️ L'implémentation DOIT être atomique (`array_remove`, §2.20c) et non un
 * read-modify-write : deux consommations concurrentes de codes DIFFÉRENTS
 * laisseraient sinon le code du « perdant » encore valide.
 */
type ConsumeBackupCode = (userId: string, codeHash: string) => Promise<void>;

/**
 * Vérifie la preuve d'identité selon le palier applicable au compte.
 *
 * L'appelant reste responsable de la preuve d'INTENTION (phrase à recopier) et
 * du rate-limiting — ce module ne fait qu'une chose.
 */
export async function verifyReauth(opts: {
  user: ReauthUser;
  loginAt: number | null;
  proof: ReauthProof;
  updateMany: UserUpdateMany;
  consumeBackupCode: ConsumeBackupCode;
  now?: number;
}): Promise<ReauthResult> {
  const { user, loginAt, proof } = opts;
  const method = reauthMethodFor({
    hasPassword: user.password !== null,
    twoFactorEnabled: user.twoFactorEnabled,
  });

  if (method === "freshness") {
    return isSessionFresh(loginAt, opts.now)
      ? { ok: true, method }
      : {
          ok: false,
          method,
          reason: "session_not_fresh",
          status: 401,
        };
  }

  if (method === "password") {
    if (!proof.password) {
      return { ok: false, method, reason: "password_required", status: 400 };
    }
    const okPassword = await bcrypt.compare(proof.password, user.password!);
    if (!okPassword) {
      return { ok: false, method, reason: "password_invalid", status: 401 };
    }
    // 2FA active → le mot de passe seul ne suffit pas : c'est exactement le
    // scénario « mot de passe fuité » que le second facteur existe pour couvrir.
    if (!user.twoFactorEnabled) return { ok: true, method };
  }

  // Reste : palier 2, ou palier 1 avec 2FA active. Dans les deux cas un code
  // est exigé.
  if (!proof.code) {
    return { ok: false, method, reason: "code_required", status: 400 };
  }
  if (!user.twoFactorSecret || !user.twoFactorIv || !user.twoFactorTag) {
    // 2FA annoncée active mais champs manquants : état incohérent, on refuse
    // plutôt que de laisser passer.
    return { ok: false, method, reason: "twofactor_state_invalid", status: 401 };
  }

  const secret = decrypt({
    encryptedValue: user.twoFactorSecret,
    iv: user.twoFactorIv,
    tag: user.twoFactorTag,
  });

  // §2.17 — `afterTimeStep` rejette un code déjà consommé, et la consommation
  // atomique ferme la course entre deux soumissions concurrentes. Contrairement
  // au flux « désactiver la 2FA » (idempotent), ici le rejeu apporterait un
  // gain réel à un attaquant : il faut donc bien CONSOMMER le pas de temps.
  const totpRes = await verifyTotp(proof.code, secret, user.lastTotpTimeStep);
  if (totpRes.valid && totpRes.timeStep != null) {
    const won = await consumeTotpTimeStep(
      opts.updateMany,
      user.id,
      totpRes.timeStep,
    );
    if (!won) {
      return { ok: false, method, reason: "code_replayed", status: 401 };
    }
    return { ok: true, method };
  }

  const idx = await findBackupCodeIndex(proof.code, user.backupCodes);
  if (idx >= 0) {
    // §2.20c — le code est BRÛLÉ ici. Contrairement au flux « désactiver la
    // 2FA » (qui vide de toute façon la liste juste après), un backup code
    // accepté pour une ré-auth et non consommé resterait réutilisable
    // indéfiniment : ce serait un credential permanent, exactement ce que la
    // ré-auth est censée empêcher.
    await opts.consumeBackupCode(user.id, user.backupCodes[idx]);
    return { ok: true, method };
  }

  return { ok: false, method, reason: "code_invalid", status: 401 };
}
