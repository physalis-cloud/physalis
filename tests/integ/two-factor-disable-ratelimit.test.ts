// §2.21 — DELETE /api/me/2fa vérifie un code (TOTP/backup) qui DÉTRUIT le second
// facteur, sans aucun frein : ni rate-limit, ni compteur d'échec. Les 2 autres
// surfaces TOTP (login, plugin/auth) sont limitées, pas celle-ci. Sans backup
// codes l'espace TOTP tient dans la fenêtre du JWT, et chaque essai 16-hex coûte
// ~2 s de CPU (bcrypt) → amplification DoS.
//
// Le fix pose un rate-limit PAR USER (max 5 / 15 min) placé AVANT le parsing du
// body : toute tentative consomme le bucket, y compris une requête sans code.
// On prouve donc la borne sans avoir besoin d'un compte 2FA armé.

import { describe, it, expect, beforeAll } from "vitest";
import { Session, adminSession, deleteReq } from "./helpers/api";

let admin: Session;

beforeAll(async () => {
  admin = await adminSession();
});

describe("§2.21 — DELETE /api/me/2fa est rate-limité (max 5 / 15 min, par user)", () => {
  it("la 6ᵉ tentative dans la fenêtre renvoie 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await deleteReq(admin, "/api/me/2fa");
      statuses.push(res.status);
    }
    // Les 5 premières passent la garde (400 « Code requis » faute de body, ou 409
    // si 2FA inactive) — jamais 429. La 6ᵉ est bloquée.
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
