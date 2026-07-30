// Jumeau SELF-HOST de tests/lib/email-escaping.test.ts.
//
// Les assertions sont IDENTIQUES — c'est le même échappement (lib/email-layout.ts,
// synchronisé) qu'on protège. Seule la CAPTURE change : la version SaaS intercepte
// le transport HTTP `physalis-email`, qui est denylisté ici. Le self-host envoie
// via Mailgun, donc on capture en moquant `mailgun.js`.
//
// Si le jour vient où le jumeau lib/email.ts gagne un transport HTTP, préférer
// re-synchroniser le test d'origine plutôt que maintenir ce jumeau.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const XSS = `<script>alert(1)</script>`;
const BREAKOUT = `" onmouseover="alert(1)`;

let captured: { subject: string; text: string; html?: string } | null = null;

vi.mock("mailgun.js", () => ({
  default: class {
    client() {
      return {
        messages: {
          create: async (
            _domain: string,
            msg: { subject: string; text: string; html?: string },
          ) => {
            captured = msg;
            return {};
          },
        },
      };
    }
  },
}));

describe("lib/email — HTML capturé via le transport Mailgun", () => {
  beforeEach(() => {
    vi.resetModules();
    captured = null;
    process.env.EMAIL_MAILGUN_API_KEY = "k";
    process.env.EMAIL_MAILGUN_DOMAIN = "mail.test";
  });
  afterEach(() => {
    delete process.env.EMAIL_MAILGUN_API_KEY;
    delete process.env.EMAIL_MAILGUN_DOMAIN;
    vi.resetModules();
  });

  async function send(name: string, params: Record<string, unknown>) {
    const mod = await import("@/lib/email");
    await (mod as unknown as Record<string, (p: unknown) => Promise<void>>)[
      name
    ]!(params);
    return captured!;
  }

  it("invitation : nom d'org et URL échappés dans le HTML, bruts dans le texte", async () => {
    const msg = await send("sendInvitationEmail", {
      to: "victim@example.com",
      inviterEmail: `<b>admin</b>@example.com`,
      organizationName: XSS,
      acceptUrl: `https://acme.physalis.cloud/invite/tok`,
      expiresAt: new Date("2030-01-01"),
    });
    expect(msg.html).toBeDefined();
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
    expect(msg.html).not.toContain("<b>admin</b>");
    // text et subject ne sont pas du HTML : la charge y reste littérale.
    expect(msg.text).toContain(XSS);
    expect(msg.subject).toContain(XSS);
  });

  it("invitation : un guillemet dans l'URL ne sort pas de l'attribut href", async () => {
    const msg = await send("sendInvitationEmail", {
      to: "victim@example.com",
      inviterEmail: "admin@example.com",
      organizationName: "Acme",
      acceptUrl: `https://acme.physalis.cloud/invite/tok${BREAKOUT}`,
      expiresAt: new Date("2030-01-01"),
    });
    // La propriété qui compte n'est pas l'absence de la chaîne (elle reste
    // présente, inerte, DANS la valeur d'attribut) mais l'absence de SORTIE
    // d'attribut : plus aucun guillemet réel pour refermer le href.
    expect(msg.html).not.toContain(`tok" onmouseover`);
    expect(msg.html).toContain("&quot; onmouseover=&quot;");
  });

  it("demande de secret : label et description échappés", async () => {
    const msg = await send("sendSecretRequestEmail", {
      to: "owner@example.com",
      requesterEmail: "req@example.com",
      label: XSS,
      description: `<img src=x onerror=alert(1)>`,
      requestUrl: "https://acme.physalis.cloud/r/tok",
      expiresAt: new Date("2030-01-01"),
    });
    expect(msg.html).not.toContain("<script>");
    // Le gabarit contient un <img> LÉGITIME (le logo) : on cible donc la
    // charge, pas la balise en général.
    expect(msg.html).not.toContain("<img src=x");
    expect(msg.html).toContain("&lt;img");
  });

  it("partage consommé : titre et IP échappés", async () => {
    const msg = await send("sendShareConsumedEmail", {
      to: "owner@example.com",
      title: XSS,
      createdAt: new Date("2030-01-01"),
      consumedAt: new Date("2030-01-02"),
      viewedFromIp: `<i>1.2.3.4</i>`,
    });
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).not.toContain("<i>1.2.3.4</i>");
  });

  it("welcome : le markup VOULU (<strong>) survit à l'échappement", async () => {
    const msg = await send("sendWelcomeEmail", {
      to: "new@example.com",
      clientName: XSS,
      loginUrl: "https://acme.physalis.cloud/login",
      trialEndsAt: null,
      plan: "free",
    });
    // La charge est neutralisée…
    expect(msg.html).not.toContain("<script>");
    // …mais le <strong> délibéré du gabarit est toujours là (garde
    // anti-régression : un échappement aveugle de la sortie de t() le casserait).
    expect(msg.html).toContain("<strong>");
  });
});
