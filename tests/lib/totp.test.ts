import { describe, it, expect } from "vitest";
import { generate } from "otplib";
import {
  generateTotpSecret,
  generateOtpauthUrl,
  generateBackupCodes,
  hashBackupCodes,
  findBackupCodeIndex,
  verifyTotp,
} from "@/lib/totp";

describe("lib/totp", () => {
  describe("generateTotpSecret", () => {
    it("retourne un secret base32 non vide", () => {
      const secret = generateTotpSecret();
      expect(secret).toBeTypeOf("string");
      expect(secret.length).toBeGreaterThan(10);
      // base32 = A-Z et 2-7
      expect(secret).toMatch(/^[A-Z2-7]+$/);
    });

    it("génère des secrets uniques", () => {
      const set = new Set<string>();
      for (let i = 0; i < 50; i++) set.add(generateTotpSecret());
      expect(set.size).toBe(50);
    });
  });

  describe("generateOtpauthUrl", () => {
    it("retourne une URI otpauth valide", () => {
      const secret = generateTotpSecret();
      const url = generateOtpauthUrl("user@example.com", secret);
      expect(url).toMatch(/^otpauth:\/\/totp\//);
      expect(url).toContain("user%40example.com");
      expect(url).toContain(`secret=${secret}`);
      expect(url).toContain("issuer=Physalis");
    });
  });

  describe("verifyTotp", () => {
    it("accepte un code valide et retourne son timeStep", async () => {
      const secret = generateTotpSecret();
      const code = await generate({ secret });
      const res = await verifyTotp(code, secret);
      expect(res.valid).toBe(true);
      expect(res.timeStep).toBeTypeOf("number");
    });

    it("refuse un code invalide (valid:false, timeStep:null)", async () => {
      const secret = generateTotpSecret();
      const res = await verifyTotp("000000", secret);
      expect(res.valid).toBe(false);
      expect(res.timeStep).toBeNull();
    });

    it("refuse un code généré avec un autre secret", async () => {
      const a = generateTotpSecret();
      const b = generateTotpSecret();
      const codeA = await generate({ secret: a });
      expect((await verifyTotp(codeA, b)).valid).toBe(false);
    });

    it("trim les espaces autour du code", async () => {
      const secret = generateTotpSecret();
      const code = await generate({ secret });
      expect((await verifyTotp(`  ${code}  `, secret)).valid).toBe(true);
    });

    // §2.17 — anti-rejeu (RFC 6238 §5.2).
    it("REJETTE un code déjà consommé quand afterTimeStep = son timeStep", async () => {
      const secret = generateTotpSecret();
      const code = await generate({ secret });
      const first = await verifyTotp(code, secret);
      expect(first.valid).toBe(true);
      // Rejeu du MÊME code, en passant le pas déjà consommé → otplib rejette
      // (timeStep <= afterTimeStep). C'est le cœur du fix §2.17.
      const replay = await verifyTotp(code, secret, first.timeStep);
      expect(replay.valid).toBe(false);
      expect(replay.timeStep).toBeNull();
    });

    it("accepte encore le code courant si afterTimeStep est un pas ANTÉRIEUR", async () => {
      const secret = generateTotpSecret();
      const code = await generate({ secret });
      const res = await verifyTotp(code, secret);
      // Un pas plus ancien ne doit pas bloquer le code courant.
      const again = await verifyTotp(code, secret, (res.timeStep ?? 1) - 1);
      expect(again.valid).toBe(true);
    });
  });

  // bcrypt cost 12 est LENT PAR CONSTRUCTION (~200 ms par hash, c'est le but
  // d'un KDF). Ces cas en enchaînent plusieurs et dépassaient le délai par
  // défaut de 5 s quand la machine est chargée — d'où un échec qui apparaissait
  // et disparaissait d'une exécution à l'autre. Ce n'est pas le test qui est
  // lent à tort : c'est le délai qui est trop serré pour du bcrypt.
  describe("backup codes", { timeout: 30_000 }, () => {
    it("generateBackupCodes retourne 8 codes hex 16-chars uniques", () => {
      const codes = generateBackupCodes();
      expect(codes).toHaveLength(8);
      for (const c of codes) {
        expect(c).toMatch(/^[0-9a-f]{16}$/);
      }
      expect(new Set(codes).size).toBe(8);
    });

    it("hashBackupCodes produit autant de hash que de codes", async () => {
      const codes = generateBackupCodes(3);
      const hashes = await hashBackupCodes(codes);
      expect(hashes).toHaveLength(3);
      for (const h of hashes) {
        // bcrypt hash : commence par $2a$, $2b$, ou $2y$.
        expect(h).toMatch(/^\$2[aby]\$\d+\$/);
      }
    });

    it("findBackupCodeIndex retourne l'index du code matchant", async () => {
      const codes = generateBackupCodes(3);
      const hashes = await hashBackupCodes(codes);
      expect(await findBackupCodeIndex(codes[1]!, hashes)).toBe(1);
      expect(await findBackupCodeIndex(codes[2]!, hashes)).toBe(2);
    });

    it("findBackupCodeIndex retourne -1 si aucun ne matche", async () => {
      const codes = generateBackupCodes(3);
      const hashes = await hashBackupCodes(codes);
      expect(await findBackupCodeIndex("nope-not-a-code", hashes)).toBe(-1);
    });

    // §2.10 — sans le filtre de format, tout candidat consommait 8 bcrypt
    // cost 12 (~2 s CPU mono-thread) offerts à un appelant non authentifié.
    it("findBackupCodeIndex court-circuite un candidat au mauvais format", async () => {
      const codes = generateBackupCodes(8);
      const hashes = await hashBackupCodes(codes);
      const started = Date.now();
      // Un code TOTP à 6 chiffres : format impossible pour un backup code.
      expect(await findBackupCodeIndex("123456", hashes)).toBe(-1);
      expect(await findBackupCodeIndex("", hashes)).toBe(-1);
      expect(await findBackupCodeIndex("z".repeat(16), hashes)).toBe(-1);
      // 3 rejets ; sans court-circuit ce serait 24 bcrypt cost 12 (≫ 1 s).
      expect(Date.now() - started).toBeLessThan(200);
    });

    it("findBackupCodeIndex est insensible à la casse + espaces", async () => {
      const codes = generateBackupCodes(2);
      const hashes = await hashBackupCodes(codes);
      const c = codes[0]!;
      expect(await findBackupCodeIndex(c.toUpperCase(), hashes)).toBe(0);
      expect(await findBackupCodeIndex(`  ${c}  `, hashes)).toBe(0);
    });
  });
});
