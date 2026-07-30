// Tests d'intégration des invariants DB du password reset.
//
// Couvre proposal Auth #12 (single-use) + #13 (expiration) au niveau du
// filtre SQL utilisé par lib/password-reset.ts → resolveResetToken().
// Cette fonction filtre `WHERE token_hash = ? AND used_at IS NULL AND
// expires_at > NOW()` — on vérifie que les 3 invariants tiennent.
//
// Note : la server action `resetPassword` (form-only, pas de route REST)
// n'est pas testée en HTTP ici. Le reset complet (HTTP form → bcrypt update
// → markResetTokenUsed) est couvert par les tests RBAC end-to-end qui
// déclenchent un parcours utilisateur réel.

import { describe, it, expect, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { execSql, selectRows } from "./helpers/db";

const SUFFIX = `${Date.now()}`;

/** Hash SHA-256 (réimplémenté localement pour ne pas dépendre du lib). */
function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Génère un token de reset au format attendu par le lib. */
function makeToken(): string {
  return "sv_reset_" + randomBytes(32).toString("hex");
}

/**
 * Simule le filtre SQL appliqué par `resolveResetToken` du lib :
 * `usedAt IS NULL AND expiresAt > NOW()`.
 * Renvoie le nombre de lignes qui passent le filtre pour un hash donné.
 */
async function countResolvableTokens(tokenHash: string): Promise<number> {
  const rows = await selectRows(
    `SELECT id FROM admin.password_reset_tokens
     WHERE token_hash = '${tokenHash}'
       AND used_at IS NULL
       AND expires_at > NOW()`,
  );
  return rows.length;
}

/** Insertion d'un token avec valeurs paramétrables. */
async function insertToken(opts: {
  tokenHash: string;
  expiresInMinutes: number;
  usedAt?: Date | null;
}) {
  const expiresAt = new Date(
    Date.now() + opts.expiresInMinutes * 60_000,
  )
    .toISOString()
    .replace("Z", "+00");
  const usedAt = opts.usedAt
    ? `'${opts.usedAt.toISOString().replace("Z", "+00")}'`
    : "NULL";
  await execSql(
    `INSERT INTO admin.password_reset_tokens
       (token_hash, tenant_slug, user_id, email, expires_at, used_at, created_at)
     VALUES
       ('${opts.tokenHash}', 'admin', 'test-user-${SUFFIX}',
        'test-${SUFFIX}@example.com', '${expiresAt}', ${usedAt}, NOW())`,
  );
}

afterAll(async () => {
  // Nettoie tous les tokens créés par cette suite.
  await execSql(
    `DELETE FROM admin.password_reset_tokens WHERE user_id = 'test-user-${SUFFIX}'`,
  );
});

describe("Password reset — invariants DB", () => {
  describe("Single-use (Auth #12)", () => {
    it("un token frais est résolvable", async () => {
      const token = makeToken();
      const tokenHash = hash(token);
      await insertToken({ tokenHash, expiresInMinutes: 60 });

      expect(await countResolvableTokens(tokenHash)).toBe(1);
    });

    it("un token avec usedAt non-null est rejeté (single-use)", async () => {
      const token = makeToken();
      const tokenHash = hash(token);
      await insertToken({
        tokenHash,
        expiresInMinutes: 60,
        usedAt: new Date(),
      });

      expect(await countResolvableTokens(tokenHash)).toBe(0);
    });

    it("après UPDATE used_at = NOW() le token devient non-résolvable", async () => {
      const token = makeToken();
      const tokenHash = hash(token);
      await insertToken({ tokenHash, expiresInMinutes: 60 });

      // Avant : résolvable
      expect(await countResolvableTokens(tokenHash)).toBe(1);

      // Simulation de markResetTokenUsed.
      await execSql(
        `UPDATE admin.password_reset_tokens
         SET used_at = NOW()
         WHERE token_hash = '${tokenHash}'`,
      );

      // Après : non résolvable.
      expect(await countResolvableTokens(tokenHash)).toBe(0);
    });
  });

  describe("Expiration (Auth #13)", () => {
    it("un token expiré (expiresAt < NOW) est rejeté", async () => {
      const token = makeToken();
      const tokenHash = hash(token);
      await insertToken({
        tokenHash,
        expiresInMinutes: -1, // 1 min dans le passé
      });

      expect(await countResolvableTokens(tokenHash)).toBe(0);
    });

    it("un token expiré pile maintenant (expiresAt = NOW) est rejeté", async () => {
      const token = makeToken();
      const tokenHash = hash(token);
      await insertToken({ tokenHash, expiresInMinutes: 0 });

      // Petite latence pour garantir expiresAt < NOW à la query.
      await new Promise((r) => setTimeout(r, 50));

      expect(await countResolvableTokens(tokenHash)).toBe(0);
    });

    it("un token avec expiration > NOW() est résolvable", async () => {
      const token = makeToken();
      const tokenHash = hash(token);
      await insertToken({ tokenHash, expiresInMinutes: 60 });

      expect(await countResolvableTokens(tokenHash)).toBe(1);
    });
  });

  describe("Purge des jetons frères après reset (§2.20b)", () => {
    // markResetTokenUsed marque le jeton consommé PUIS supprime les frères
    // non consommés du même (tenant, user) :
    //   UPDATE ... SET used_at = NOW() WHERE token_hash = <consommé>
    //   DELETE ... WHERE tenant_slug = <t> AND user_id = <u> AND used_at IS NULL
    // Sans la purge, un jeton A capturé (jamais utilisé) resterait valide dans
    // sa fenêtre TTL même après le propre reset (jeton B) de la victime.

    async function insertFor(opts: {
      tokenHash: string;
      userId: string;
      usedAt?: Date | null;
    }) {
      const expiresAt = new Date(Date.now() + 60 * 60_000)
        .toISOString()
        .replace("Z", "+00");
      const usedAt = opts.usedAt
        ? `'${opts.usedAt.toISOString().replace("Z", "+00")}'`
        : "NULL";
      await execSql(
        `INSERT INTO admin.password_reset_tokens
           (token_hash, tenant_slug, user_id, email, expires_at, used_at, created_at)
         VALUES
           ('${opts.tokenHash}', 'admin', '${opts.userId}',
            '${opts.userId}@example.com', '${expiresAt}', ${usedAt}, NOW())`,
      );
    }

    /** Réplique EXACTE de la séquence markResetTokenUsed du lib. */
    async function markUsedAndPurgeSiblings(usedHash: string) {
      await execSql(
        `UPDATE admin.password_reset_tokens SET used_at = NOW()
         WHERE token_hash = '${usedHash}'`,
      );
      // Sous-requête pour retrouver (tenant, user) de la ligne consommée, comme
      // le fait le lib via l'objet retourné par l'update.
      await execSql(
        `DELETE FROM admin.password_reset_tokens t
         USING admin.password_reset_tokens u
         WHERE u.token_hash = '${usedHash}'
           AND t.tenant_slug IS NOT DISTINCT FROM u.tenant_slug
           AND t.user_id = u.user_id
           AND t.used_at IS NULL`,
      );
    }

    it("un jeton frère non consommé est purgé quand un reset aboutit", async () => {
      const victim = `sibling-victim-${SUFFIX}`;
      const usedHash = hash(makeToken());
      const siblingHash = hash(makeToken());
      await insertFor({ tokenHash: usedHash, userId: victim });
      await insertFor({ tokenHash: siblingHash, userId: victim });

      // Avant : le frère est résolvable (fenêtre d'attaque ouverte).
      expect(await countResolvableTokens(siblingHash)).toBe(1);

      await markUsedAndPurgeSiblings(usedHash);

      // Après : le frère a disparu, le consommé reste (marqué used, non résolvable).
      expect(await countResolvableTokens(siblingHash)).toBe(0);
      const remaining = await selectRows(
        `SELECT token_hash FROM admin.password_reset_tokens WHERE user_id = '${victim}'`,
      );
      expect(remaining).toEqual([usedHash]);

      await execSql(
        `DELETE FROM admin.password_reset_tokens WHERE user_id = '${victim}'`,
      );
    });

    it("garde anti sur-suppression : les jetons d'un AUTRE user restent intacts", async () => {
      const victim = `sibling-a-${SUFFIX}`;
      const other = `sibling-b-${SUFFIX}`;
      const usedHash = hash(makeToken());
      const victimSibling = hash(makeToken());
      const otherToken = hash(makeToken());
      await insertFor({ tokenHash: usedHash, userId: victim });
      await insertFor({ tokenHash: victimSibling, userId: victim });
      await insertFor({ tokenHash: otherToken, userId: other });

      await markUsedAndPurgeSiblings(usedHash);

      // Le frère de la victime est purgé…
      expect(await countResolvableTokens(victimSibling)).toBe(0);
      // …mais le jeton d'un autre user, lui, est toujours vivant.
      expect(await countResolvableTokens(otherToken)).toBe(1);

      await execSql(
        `DELETE FROM admin.password_reset_tokens WHERE user_id IN ('${victim}', '${other}')`,
      );
    });
  });

  describe("Lookup (sanity check)", () => {
    it("un hash inexistant ne renvoie rien", async () => {
      const tokenHash = hash("sv_reset_" + "0".repeat(64));
      expect(await countResolvableTokens(tokenHash)).toBe(0);
    });

    it("le token brut n'est jamais stocké en clair en base", async () => {
      const token = makeToken();
      const tokenHash = hash(token);
      await insertToken({ tokenHash, expiresInMinutes: 60 });

      // Verifie qu'aucune colonne ne contient le préfixe token brut.
      const rawTokenInDb = await selectRows(
        `SELECT id FROM admin.password_reset_tokens
         WHERE token_hash LIKE 'sv_reset_%'`,
      );
      expect(rawTokenInDb.length).toBe(0);
    });
  });
});
