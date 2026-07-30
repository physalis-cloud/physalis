// Échelle de ré-authentification des actions irréversibles.
//
// L'enjeu de ces tests : `User.password` est NULLABLE (compte SSO/social). Une
// garde « ressaisissez votre mot de passe » y serait impossible à satisfaire —
// ces comptes seraient purement et simplement empêchés de supprimer leur
// compte. L'échelle existe pour qu'aucun compte ne soit bloqué SANS pour autant
// laisser une action irréversible sans preuve d'identité.

import { describe, expect, it, vi } from "vitest";
import {
  REAUTH_FRESHNESS_MS,
  isSessionFresh,
  reauthMethodFor,
  verifyReauth,
} from "@/lib/reauth";

describe("reauthMethodFor — l'échelle", () => {
  it("palier 1 — compte classique → mot de passe", () => {
    expect(
      reauthMethodFor({ hasPassword: true, twoFactorEnabled: false }),
    ).toBe("password");
    // 2FA active : toujours le palier mot de passe (le code s'y AJOUTE,
    // cf. verifyReauth) — ce n'est pas un palier distinct.
    expect(reauthMethodFor({ hasPassword: true, twoFactorEnabled: true })).toBe(
      "password",
    );
  });

  it("palier 2 — compte SSO avec TOTP → code seul", () => {
    expect(
      reauthMethodFor({ hasPassword: false, twoFactorEnabled: true }),
    ).toBe("totp");
  });

  it("palier 3 — compte SSO sans TOTP → fraîcheur de session", () => {
    // Rien à vérifier localement : on force le passage par l'IdP via une
    // session récente. Personne n'est bloqué, un cookie ancien échoue.
    expect(
      reauthMethodFor({ hasPassword: false, twoFactorEnabled: false }),
    ).toBe("freshness");
  });
});

describe("isSessionFresh", () => {
  const now = 1_800_000_000_000;

  it("session récente → acceptée", () => {
    expect(isSessionFresh(now - 60_000, now)).toBe(true);
  });

  it("pile sur la borne → acceptée", () => {
    expect(isSessionFresh(now - REAUTH_FRESHNESS_MS, now)).toBe(true);
  });

  it("au-delà de la borne → refusée", () => {
    expect(isSessionFresh(now - REAUTH_FRESHNESS_MS - 1, now)).toBe(false);
  });

  it("loginAt absent (token legacy) → REFUSÉE, fail-closed", () => {
    // On ne peut pas prouver la fraîcheur : sur une action irréversible, le
    // doute profite à la prudence, pas à l'appelant.
    expect(isSessionFresh(null, now)).toBe(false);
  });
});

// ── verifyReauth ────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
// bcrypt de "bon-mot-de-passe", coût 10.
const PASSWORD_HASH =
  "$2b$10$hg67QuCS0lH7tvA6QNZHNOPnR7xLAKmqSTSfwBlFeblbcyAIHQfIO";

function baseUser(over: Record<string, unknown> = {}) {
  return {
    id: "u1",
    password: null,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorIv: null,
    twoFactorTag: null,
    backupCodes: [] as string[],
    lastTotpTimeStep: null,
    ...over,
  } as Parameters<typeof verifyReauth>[0]["user"];
}

const noopDeps = {
  updateMany: vi.fn(async () => ({ count: 1 })),
  consumeBackupCode: vi.fn(async () => {}),
};

describe("verifyReauth — palier 3 (SSO sans TOTP)", () => {
  it("session fraîche → acceptée sans rien demander d'autre", async () => {
    const res = await verifyReauth({
      user: baseUser(),
      loginAt: NOW - 60_000,
      proof: {},
      now: NOW,
      ...noopDeps,
    });
    expect(res).toEqual({ ok: true, method: "freshness" });
  });

  it("session ancienne → refusée (le cookie volé de longue date échoue)", async () => {
    const res = await verifyReauth({
      user: baseUser(),
      loginAt: NOW - REAUTH_FRESHNESS_MS - 1,
      proof: {},
      now: NOW,
      ...noopDeps,
    });
    expect(res).toMatchObject({ ok: false, reason: "session_not_fresh" });
  });
});

describe("verifyReauth — palier 1 (mot de passe)", () => {
  it("bon mot de passe, pas de 2FA → accepté", async () => {
    const res = await verifyReauth({
      user: baseUser({ password: PASSWORD_HASH }),
      loginAt: null,
      proof: { password: "bon-mot-de-passe" },
      now: NOW,
      ...noopDeps,
    });
    expect(res).toEqual({ ok: true, method: "password" });
  });

  it("mauvais mot de passe → refusé", async () => {
    const res = await verifyReauth({
      user: baseUser({ password: PASSWORD_HASH }),
      loginAt: null,
      proof: { password: "mauvais" },
      now: NOW,
      ...noopDeps,
    });
    expect(res).toMatchObject({ ok: false, reason: "password_invalid" });
  });

  it("mot de passe absent → 400, pas 401", async () => {
    // Distinction utile côté UI : « il manque un champ » n'est pas « votre
    // preuve est fausse ».
    const res = await verifyReauth({
      user: baseUser({ password: PASSWORD_HASH }),
      loginAt: null,
      proof: {},
      now: NOW,
      ...noopDeps,
    });
    expect(res).toMatchObject({ ok: false, reason: "password_required", status: 400 });
  });

  it("RÉGRESSION — 2FA active : le bon mot de passe SEUL ne suffit pas", async () => {
    // C'est précisément le scénario « mot de passe fuité » que le second
    // facteur existe pour couvrir. Laisser passer ici viderait la 2FA de son
    // sens sur l'action la plus destructrice du produit.
    const res = await verifyReauth({
      user: baseUser({
        password: PASSWORD_HASH,
        twoFactorEnabled: true,
        twoFactorSecret: "x",
        twoFactorIv: "y",
        twoFactorTag: "z",
      }),
      loginAt: null,
      proof: { password: "bon-mot-de-passe" },
      now: NOW,
      ...noopDeps,
    });
    expect(res).toMatchObject({ ok: false, reason: "code_required" });
  });

  it("une session fraîche ne dispense JAMAIS un compte classique du mot de passe", async () => {
    // Le palier 3 est un repli pour les comptes qui ne peuvent rien prouver
    // d'autre — pas une porte dérobée ouverte à tous.
    const res = await verifyReauth({
      user: baseUser({ password: PASSWORD_HASH }),
      loginAt: NOW,
      proof: {},
      now: NOW,
      ...noopDeps,
    });
    expect(res.ok).toBe(false);
  });
});

describe("verifyReauth — état 2FA incohérent", () => {
  it("2FA annoncée active mais secret manquant → refus, pas de passe-droit", async () => {
    const res = await verifyReauth({
      user: baseUser({ twoFactorEnabled: true }),
      loginAt: NOW,
      proof: { code: "123456" },
      now: NOW,
      ...noopDeps,
    });
    expect(res).toMatchObject({ ok: false, reason: "twofactor_state_invalid" });
  });
});
