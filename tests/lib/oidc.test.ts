import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { _resetJwksCache, verifyGithubOidcToken } from "@/lib/oidc";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "secretvault.test.local";

let server: Server;
let jwksUrl: string;
let privateKey: CryptoKey;
let kid: string;

beforeAll(async () => {
  // Genere une paire RS256 et expose la cle publique sur un serveur local.
  const keyPair = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = keyPair.privateKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  kid = "test-key-1";
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  jwksUrl = `http://127.0.0.1:${addr.port}/jwks`;

  process.env.OIDC_JWKS_URL = jwksUrl;
  process.env.OIDC_AUDIENCE = AUDIENCE;
});

afterAll(async () => {
  delete process.env.OIDC_JWKS_URL;
  delete process.env.OIDC_AUDIENCE;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  _resetJwksCache();
});

type Claims = {
  repository?: string;
  job_workflow_ref?: string;
  ref?: string;
  ref_name?: string;
  /** "branch" | "tag" — claim GitHub qui désambiguïse le type de ref (§2.5). */
  ref_type?: string;
  iss?: string;
  aud?: string;
  exp?: number;
};

async function signToken(claims: Claims, opts?: { wrongAlg?: boolean }) {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    repository: claims.repository,
    job_workflow_ref: claims.job_workflow_ref,
    ref: claims.ref,
    ref_name: claims.ref_name,
  })
    .setProtectedHeader({ alg: opts?.wrongAlg ? "RS256" : "RS256", kid })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(claims.exp ?? now + 600);
  return builder.sign(privateKey);
}

describe("verifyGithubOidcToken", () => {
  it("rejette un token absent", async () => {
    const r = await verifyGithubOidcToken(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_token");
  });

  it("valide un token bien forme et extrait les claims", async () => {
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/deploy.yml@refs/heads/main",
      ref: "refs/heads/main",
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.repository).toBe("argo-web/voyages");
      expect(r.claims.workflowFile).toBe("deploy.yml");
      expect(r.claims.branch).toBe("main");
    }
  });

  it("prefere ref_name s'il est present", async () => {
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/deploy.yml@refs/heads/release/2026",
      ref: "refs/heads/release/2026",
      ref_name: "release/2026",
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.branch).toBe("release/2026");
  });

  // §2.5 — Les policies ne s'expriment qu'en branches. Un TAG ne doit JAMAIS
  // produire de claim `branch` : sinon un dev sans droit de push sur `main`
  // pousse un tag NOMMÉ `main` et matche la policy (les tags ne sont pas
  // couverts par les rulesets de branche côté forge) → secrets prod + clé SSH.
  it("REFUSE un tag (ne le confond pas avec une branche)", async () => {
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/release.yml@refs/tags/v1.2.3",
      ref: "refs/tags/v1.2.3",
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ref_not_branch");
  });

  it("REFUSE un tag homonyme d'une branche protégée (le scénario d'attaque)", async () => {
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/deploy.yml@refs/tags/main",
      ref: "refs/tags/main",
      ref_type: "tag",
      ref_name: "main", // GitHub pose ref_name pour un tag aussi → piège
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ref_not_branch");
  });

  it("accepte une branche avec ref_type explicite", async () => {
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/deploy.yml@refs/heads/main",
      ref: "refs/heads/main",
      ref_type: "branch",
      ref_name: "main",
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.branch).toBe("main");
      expect(r.claims.workflowFile).toBe("deploy.yml");
    }
  });

  it("rejette un mauvais issuer", async () => {
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/deploy.yml@refs/heads/main",
      ref: "refs/heads/main",
      iss: "https://evil.example.com",
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(false);
    // Depuis le refactor multi-provider, un issuer https inconnu (non
    // github.com / gitlab.com / bitbucket) est traité comme un issuer dynamique
    // non allowlisté → `untrusted_issuer` (toujours rejeté, plus précis).
    if (!r.ok) expect(r.reason).toBe("untrusted_issuer");
  });

  it("rejette une mauvaise audience", async () => {
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/deploy.yml@refs/heads/main",
      ref: "refs/heads/main",
      aud: "another-service.example.com",
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_audience");
  });

  it("rejette un token expire", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/deploy.yml@refs/heads/main",
      ref: "refs/heads/main",
      exp: past,
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejette une signature corrompue", async () => {
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/deploy.yml@refs/heads/main",
      ref: "refs/heads/main",
    });
    // Tamper sur la signature (dernier segment).
    const parts = token.split(".");
    parts[2] =
      parts[2]!.slice(0, -4) + (parts[2]!.endsWith("AAAA") ? "BBBB" : "AAAA");
    const r = await verifyGithubOidcToken(parts.join("."));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("rejette des claims manquants", async () => {
    const token = await signToken({
      // pas de repository
      job_workflow_ref:
        "argo-web/voyages/.github/workflows/deploy.yml@refs/heads/main",
      ref: "refs/heads/main",
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_claims");
  });

  it("rejette un job_workflow_ref non parsable", async () => {
    const token = await signToken({
      repository: "argo-web/voyages",
      job_workflow_ref: "argo-web/voyages/refs/heads/main",
      ref: "refs/heads/main",
    });
    const r = await verifyGithubOidcToken(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_claims");
  });
});
