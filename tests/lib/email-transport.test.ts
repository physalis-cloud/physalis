// §2.25e — le stub stdout d'email est un piège à deux détentes :
//   1. il n'envoie RIEN, donc le laisser dégrader silencieusement en prod perd
//      les mails transactionnels (reset, invitation) sans le moindre signal ;
//   2. son `console.log` imprimait `msg.text`, qui porte les liens bruts
//      (resetUrl → sv_reset_<64hex>, acceptUrl, requestUrl) → fuite de jeton.
//
// On vérifie ici : (a) hors dev/test, l'absence de provider fait ÉCHOUER l'envoi
// (fail-closed) plutôt que dégrader ; (b) en dev, le stub ne loggue jamais le
// corps du message.

import { describe, it, expect, vi, afterEach } from "vitest";

const SECRET_TEXT =
  "Réinitialisez : https://acme.physalis.cloud/reset/sv_reset_" +
  "a".repeat(64);

function clearProviders() {
  delete process.env.EMAIL_PHYSALIS_URL;
  delete process.env.EMAIL_PHYSALIS_API_KEY;
  delete process.env.EMAIL_MAILGUN_API_KEY;
  delete process.env.EMAIL_MAILGUN_DOMAIN;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("lib/email — transport fail-closed (§2.25e)", () => {
  it("hors développement, aucun provider configuré → sendEmail échoue (pas de dégradation silencieuse)", async () => {
    vi.resetModules();
    clearProviders();
    vi.stubEnv("NODE_ENV", "production");
    const { sendEmail } = await import("@/lib/email");
    await expect(
      sendEmail({ to: "a@b.tld", subject: "x", text: SECRET_TEXT }),
    ).rejects.toThrow(/provider email/i);
  });

  it("en développement, le stub s'active mais n'imprime JAMAIS msg.text (pas de fuite de jeton)", async () => {
    vi.resetModules();
    clearProviders();
    vi.stubEnv("NODE_ENV", "development");
    const logs: string[] = [];
    vi.stubGlobal(
      "console",
      { ...console, log: (...a: unknown[]) => logs.push(a.join(" ")) },
    );
    const { sendEmail } = await import("@/lib/email");
    await sendEmail({ to: "a@b.tld", subject: "reset", text: SECRET_TEXT });

    const joined = logs.join("\n");
    expect(joined).toContain("[email:stub]"); // le stub a bien tourné
    expect(joined).toContain("to=a@b.tld"); // métadonnées OK
    expect(joined).not.toContain("sv_reset_"); // mais AUCUN jeton
    expect(joined).not.toContain(SECRET_TEXT);
  });
});
