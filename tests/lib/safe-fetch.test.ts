import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ipIsPrivate,
  validateHookUrlSyntax,
  safeFetchHook,
  HookUrlError,
  type HostResolver,
} from "@/lib/safe-fetch";

// Le comportement de la garde dépend de NODE_ENV : en prod les cibles internes
// sont refusées, en dev elles sont autorisées (hooks locaux légitimes). On force
// "production" pour la plupart des cas et on restaure ensuite.
const ORIGINAL_ENV = process.env.NODE_ENV;
function setEnv(v: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (v === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = v;
}
beforeEach(() => setEnv("production"));
afterEach(() => setEnv(ORIGINAL_ENV));

describe("ipIsPrivate — plages internes", () => {
  const privateIps = [
    "127.0.0.1", "127.1.2.3", "0.0.0.0",
    "10.0.0.5", "10.255.255.255",
    "172.16.0.1", "172.20.10.5", "172.31.255.255",
    "192.168.0.1", "192.168.1.10",
    "169.254.169.254", // métadonnées cloud
    "100.64.0.1", "100.127.255.255", // CGNAT
    "224.0.0.1", "255.255.255.255", // multicast / broadcast
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", // IPv4-mappées
  ];
  for (const ip of privateIps) {
    it(`refuse ${ip}`, () => expect(ipIsPrivate(ip)).toBe(true));
  }

  const publicIps = [
    "8.8.8.8", "1.1.1.1", "93.184.216.34",
    "172.32.0.1", // hors 172.16/12 → public (piège classique)
    "172.15.255.255", // idem
    "100.63.255.255", "100.128.0.1", // hors CGNAT
    "192.169.0.1", "11.0.0.1",
    "2606:4700:4700::1111", "::ffff:8.8.8.8",
  ];
  for (const ip of publicIps) {
    it(`autorise ${ip}`, () => expect(ipIsPrivate(ip)).toBe(false));
  }

  it("refuse une chaîne qui n'est pas une IP (prudence)", () => {
    expect(ipIsPrivate("pas-une-ip")).toBe(true);
  });
});

describe("validateHookUrlSyntax — en production", () => {
  it("refuse un hôte sans point (nom Docker)", () => {
    // en https on isole le motif « interne » (http échouerait d'abord sur le protocole)
    expect(validateHookUrlSyntax("https://openbao:8200/v1/x")).toMatch(/interne/i);
    expect(validateHookUrlSyntax("https://app/x")).toMatch(/interne/i);
    expect(validateHookUrlSyntax("http://app:3000/x")).toBeTruthy(); // rejeté (protocole)
  });
  it("refuse une IP littérale interne (toutes notations résolues côté IP)", () => {
    expect(validateHookUrlSyntax("https://127.0.0.1/x")).toMatch(/interne/i);
    expect(validateHookUrlSyntax("http://169.254.169.254/latest/")).toBeTruthy();
    expect(validateHookUrlSyntax("https://[::1]/x")).toMatch(/interne/i);
  });
  it("refuse http:// (exige https en prod)", () => {
    expect(validateHookUrlSyntax("http://api.client.com/rotate")).toMatch(/https/i);
  });
  it("refuse des identifiants inline", () => {
    expect(validateHookUrlSyntax("https://user:pass@api.client.com/x")).toMatch(/identifiants/i);
  });
  it("refuse une URL non parsable", () => {
    expect(validateHookUrlSyntax("pas une url")).toBeTruthy();
  });
  it("accepte un domaine public en https (la résolution DNS est vérifiée à l'appel)", () => {
    expect(validateHookUrlSyntax("https://api.client.com/rotate")).toBeNull();
    expect(validateHookUrlSyntax("https://172.32.0.1/x")).toBeNull(); // IP publique littérale
  });
});

describe("validateHookUrlSyntax — en dev, tout est permis", () => {
  it("autorise les cibles internes hors production", () => {
    setEnv("development");
    expect(validateHookUrlSyntax("http://app:3000/x")).toBeNull();
    expect(validateHookUrlSyntax("http://127.0.0.1/x")).toBeNull();
  });
});

describe("safeFetchHook — enforcement à l'appel", () => {
  // Résolveur injecté : pas de DNS réel, mappage déterministe.
  const resolver: HostResolver = async (host) => {
    const map: Record<string, string[]> = {
      "public.example": ["93.184.216.34"],
      "evil.example": ["10.0.0.5"], // domaine public qui résout en interne
      "mixed.example": ["93.184.216.34", "10.0.0.5"], // un pied dedans
      "redir.example": ["93.184.216.34"],
    };
    if (host in map) return map[host];
    throw new Error(`unknown host ${host}`);
  };

  it("refuse un domaine qui résout vers une IP interne (rebinding / DNS menteur)", async () => {
    await expect(
      safeFetchHook("https://evil.example/hook", { method: "POST" }, { resolve: resolver }),
    ).rejects.toBeInstanceOf(HookUrlError);
  });

  it("refuse si UNE des IP résolues est interne", async () => {
    await expect(
      safeFetchHook("https://mixed.example/hook", { method: "POST" }, { resolve: resolver }),
    ).rejects.toBeInstanceOf(HookUrlError);
  });

  it("refuse un nom d'hôte interne avant toute résolution", async () => {
    await expect(
      safeFetchHook("http://app:3000/hook", { method: "POST" }, { resolve: resolver }),
    ).rejects.toThrow(HookUrlError);
  });
});

// Cas positif sur un serveur local réel (mode dev, 127.0.0.1 autorisé) :
// prouve que l'en-tête Authorization et le corps sont bien transmis à la cible.
describe("safeFetchHook — appel réel (serveur local, dev)", () => {
  let server: Server;
  let base: string;
  let receivedAuth: string | undefined;
  let receivedBody = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      receivedAuth = req.headers["authorization"] as string | undefined;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        receivedBody = body;
        res.writeHead(418);
        res.end("REPONSE-CIBLE");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("atteint la cible et transmet en-tête + corps", async () => {
    setEnv("development"); // 127.0.0.1 autorisé hors production
    const res = await safeFetchHook(`${base}/ok`, {
      method: "POST",
      headers: { Authorization: "Bearer tok-123", "Content-Type": "application/json" },
      body: JSON.stringify({ secretKey: "K", newValue: "V" }),
    });
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("REPONSE-CIBLE");
    expect(receivedAuth).toBe("Bearer tok-123");
    expect(JSON.parse(receivedBody)).toEqual({ secretKey: "K", newValue: "V" });
  });
});

// Re-validation des redirections : fetch mocké + résolveur injecté, en prod.
// Prouve que chaque saut est validé (fetch ne suit pas la Location aveuglément).
describe("safeFetchHook — redirections re-validées (fetch mocké, prod)", () => {
  const resolver: HostResolver = async (host) => {
    const map: Record<string, string[]> = {
      "public.example": ["93.184.216.34"],
      "good-redirect.example": ["93.184.216.34"],
      "evil-redirect.example": ["10.0.0.5"], // cible de redirection interne
    };
    if (host in map) return map[host];
    throw new Error(`unknown host ${host}`);
  };
  afterEach(() => vi.unstubAllGlobals());

  it("suit une redirection vers une cible publique et renvoie la réponse finale", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "https://public.example/hook") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://good-redirect.example/final" },
          });
        }
        return new Response("OK-FINAL", { status: 200 });
      }),
    );
    const res = await safeFetchHook("https://public.example/hook", { method: "POST" }, { resolve: resolver });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK-FINAL");
    expect(calls).toEqual(["https://public.example/hook", "https://good-redirect.example/final"]);
  });

  it("bloque une redirection dont la cible résout en interne", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil-redirect.example/x" },
        });
      }),
    );
    await expect(
      safeFetchHook("https://public.example/hook", { method: "POST" }, { resolve: resolver }),
    ).rejects.toBeInstanceOf(HookUrlError);
    // La cible interne n'a jamais été fetchée : bloquée à la validation du saut.
    expect(calls).toEqual(["https://public.example/hook"]);
  });

  it("plafonne le nombre de redirections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, { status: 302, headers: { location: "https://public.example/loop" } }),
      ),
    );
    await expect(
      safeFetchHook("https://public.example/hook", { method: "POST" }, { resolve: resolver, maxRedirects: 2 }),
    ).rejects.toBeInstanceOf(HookUrlError);
  });
});
