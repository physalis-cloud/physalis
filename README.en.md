# Physalis

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[Français](README.md) · **English** · [Español](README.es.md)

> **Version 1.3.3** · Hosted, managed version: [physalis.cloud](https://physalis.cloud) · Bugs and feedback: [open an issue](https://github.com/physalis-cloud/physalis/issues)

---

Self-hosted secrets manager (Next.js + Postgres + AES-256-GCM) that centralises
the environment variables, SSH keys and credentials of all your projects, with
OIDC authentication (GitHub, GitLab, Bitbucket) for deployment workflows.

Multi-organisation, audit log, encrypted services & accounts, per-environment
docker-compose serving, built-in CI redeploy, hybrid post-quantum key exchange
(ECDH P-256 + ML-KEM-768) for external secret requests.

**Physalis** is a self-hosted secrets manager built to centralise every
environment variable of a web agency on its own servers, without depending on a
third-party cloud service.

---

## The problem it solves

In an agency running several projects across several VPS, environment variables
(database passwords, API keys, tokens) end up scattered across `.env` files on
each server, in GitHub Secrets, in personal notes. Changing one variable means
connecting to each server by hand. When a developer leaves the team, there is no
way to know what they had access to.

---

## What Physalis does

### Encrypted centralisation

Every variable is stored in a PostgreSQL database, encrypted with AES-256-GCM
before it is written. Even with direct access to the database, the values are
unreadable without the encryption key — which only ever lives in the server's
environment variables.

### Multi-organisation and access control

The application supports several isolated organisations, each with its own
projects and members. Permissions are granular across three levels —
organisation, project, environment — with distinct roles (viewer, editor,
owner). Email invitations with a signed link, and automatic revocation when a
member leaves the team.

### Two ways to consume secrets

**For humans** — a web interface secured by password and, optionally, TOTP
two-factor authentication. Secret values are never displayed in bulk: each
reveal is an explicit, one-at-a-time action, recorded in the audit log.

**For machines** — OIDC authentication. At deploy time the workflow obtains a
token signed by the CI provider (with no secret stored in GitHub Secrets) and
presents it to Physalis. The vault verifies the signature cryptographically,
checks that the repository, workflow and branch match an authorised rule
exactly, then returns the whole deployment bundle in a single request: decrypted
environment variables, target server SSH key, deploy path, docker-compose file,
and Docker registry credentials.

### Post-quantum resistant cryptography

Secrets are encrypted at rest with **AES-256-GCM** — a symmetric cipher already
considered resistant to quantum computers, since Grover's algorithm only reduces
a 256-bit key to 128 bits of effective security.

The key exchange used by **external secret requests** — the only place where
asymmetric cryptography protects a value, and therefore the only part genuinely
exposed to a future quantum computer — is **hybrid**: ECDH P-256 **and**
ML-KEM-768 (FIPS 203), combined through HKDF-SHA256 with transcript binding.
Breaking the derived key requires breaking both. Requests created before this
change (ECDH only) remain decryptable. Implementation:
[lib/hybrid-kem.ts](lib/hybrid-kem.ts) and [lib/pqc.ts](lib/pqc.ts).

### Full traceability

Every action — reading a secret, editing it, logging in, deploying, inviting —
is recorded in a persistent audit log with the actor, the IP address and the
timestamp. Exportable as CSV, browsable per project or per organisation.

---

## What it changes in practice

| Before | After |
|---|---|
| One `.env` file per project per server | A single interface for every secret in the agency |
| SSH keys and tokens in GitHub Secrets | No key and no token in GitHub |
| No traceability | Every access recorded with actor, IP and timestamp |
| No way to know who has access to what | Immediate revocation when someone leaves |
| Manual or semi-automated deployments | Fully automated deployments, no human step |


📖 **Technical documentation** : [docs/physalis.md](docs/physalis.md) (French)
📚 **User documentation** : [docs/documentation/en/](docs/documentation/en/) (also in `fr` / `es`)
🔒 **Security model** : [docs/security.md](docs/security.md) (French)

---

## Quickstart

### 1. Local — full stack (Docker)

```bash
cp .env.example .env
# Fill in the empty values: ENCRYPTION_KEY, AUTH_SECRET, NEXTAUTH_SECRET,
#   DB_PASSWORD, ADMIN_PASSWORD (ADMIN_EMAIL has a default).
#   ENCRYPTION_KEY = openssl rand -hex 32 ; the secrets = openssl rand -base64 32.
docker compose up -d --build
```

→ http://localhost:3001 (default port; 3000 is often already taken — adjustable
through `PORT` in `.env`, keeping `NEXTAUTH_URL` on the same port).

The first start applies the Prisma migrations and creates the admin account
defined by `ADMIN_EMAIL` / `ADMIN_PASSWORD`
([scripts/bootstrap-admin.mjs](scripts/bootstrap-admin.mjs)).

### 2. Local — native dev (hot reload)

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres only (port 5434)
npm install
npx prisma migrate dev
npm run bootstrap-admin
npm run dev                                       # http://localhost:3000
```

### 3. Production (VPS behind a reverse proxy)

Typical workflow: test → build/push registry → SSH deploy + health check.
Ready-to-paste template: [docs/deploy.modele.yml](docs/deploy.modele.yml).

See [docs/physalis.md §9](docs/physalis.md) for the full installation
(deployment directory, dedicated SSH key for the workflow, `.env` contents,
reverse proxy and TLS).

---

## Consuming secrets from a project

Three access modes, from the most modern to the most legacy:

### Mode 1 — OIDC (recommended)

The CI runner authenticates with an OIDC JWT signed by the provider (GitHub
Actions, GitLab CI, Bitbucket Pipelines). The vault validates the claim against
a strict `Policy` — `(repo, workflow, branch) → (project, env)` — and returns a
complete bundle.

| Endpoint | Auth | Response |
|---|---|---|
| `POST /api/deploy` | Bearer OIDC JWT | `{ serverIp, serverUser, sshKey, deployPath, secrets, dockerCompose, registry }` |

No CI secret is consumed. SSH key and registry credentials live encrypted in the
vault. Ready-to-paste templates:
[docs/deploy.modele.yml](docs/deploy.modele.yml) (deploy with rebuild),
[docs/redeploy.modele.yml](docs/redeploy.modele.yml) (redeploy without rebuild),
[docs/deploy.gitlab-ci.modele.yml](docs/deploy.gitlab-ci.modele.yml) and
[docs/deploy.bitbucket-pipelines.modele.yml](docs/deploy.bitbucket-pipelines.modele.yml).

### Mode 2 — Bearer machine token (fallback outside OIDC CI)

For contexts that cannot obtain an OIDC token (cron on a VPS, another CI, manual
scripts):

| Endpoint | Auth | Response |
|---|---|---|
| `GET /api/secrets/[slug]/[env]` | `Bearer sv_<hex>` | `{ secrets: { KEY: value, … } }` |
| `GET /api/compose/[slug]/[env]` | `Bearer sv_<hex>` | raw contents of the configured `docker-compose.yml` |

The token is scoped to one `(project, env)` pair; any other combination returns
403. Managed from the project page → env tab → "Machine tokens".

### Mode 3 — local script

[scripts/inject-secrets.sh](scripts/inject-secrets.sh) — a bash wrapper around
the Bearer endpoint, useful when the same logic is called from several scripts
on the same VPS.

---

## Generating the secrets needed at init

```bash
openssl rand -hex 32        # ENCRYPTION_KEY
openssl rand -base64 32     # AUTH_SECRET / NEXTAUTH_SECRET
```

> ⚠️ `ENCRYPTION_KEY`: **never in the database, never in code** — only in the
> container's environment. Losing it permanently means the secrets are
> unrecoverable, even with a full database dump. Keep a copy in a shared
> password manager (escrow).

---

## Backing up your instance

**This repository provides no backup, no replication and no failover** — no
script, no cron job, no switchover mechanism. Backing up your instance is your
infrastructure, and therefore your responsibility. At a minimum:

- a **regular dump** of the PostgreSQL database (`pg_dump`), encrypted and
  stored off the server that produced it;
- a **copy of `ENCRYPTION_KEY`** in escrow (see the warning above) — a dump
  without the key is unrecoverable, and the key without a dump is worthless;
- a **periodic restore test**, otherwise you do not have a backup, you have
  files.

The hosted offering at [physalis.cloud](https://physalis.cloud) runs its own
resilience infrastructure (managed replication and encrypted backups); none of
that is included in or orchestrated by this repository.

---

## Stack

Next.js 15 (App Router) · TypeScript · Prisma 6 + PostgreSQL 16 ·
NextAuth v5 (Credentials, JWT) · bcryptjs (salt 12) · AES-256-GCM ·
hybrid ECDH P-256 + ML-KEM-768 (`@noble/post-quantum`) ·
jose 6 (OIDC JWKS) · TOTP 2FA (otplib) · Tailwind 3 · Mailgun (transactional
email) · multi-stage Docker (node:22-alpine).

## Tests

```bash
npm test               # unit (crypto, tokens, rate-limit, validation, totp,
                       #       oidc, categories, plugin-token)
npm run test:integ     # integration (bearer-auth, RBAC, DB encryption, headers,
                       #              rate-limit, 2FA, servers, policies, plugin)
```

See [docs/physalis.md §12](docs/physalis.md) for details.
