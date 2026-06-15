---
title: OIDC Deployment
order: 7
icon: RiCloudLine
summary: Deploy from GitHub Actions, GitLab CI/CD or Bitbucket Pipelines with no stored secrets, using OIDC tokens signed by the CI provider.
---

# OIDC Deployment

Physalis replaces the old "stored PAT + CI secrets" flows with **OIDC**
(OpenID Connect) authentication based on **tokens signed by your CI
provider** itself.

Three providers are supported, all using the **same** mechanism:

- **GitHub Actions**
- **GitLab CI/CD** (gitlab.com or self-hosted instance)
- **Bitbucket Pipelines**

**Result**: your repository has **no** secrets linked to Physalis. The
identity proof is the OIDC token that the CI runner automatically issues on
every job run. Physalis verifies it against a **Policy** before returning
the deployment bundle (secrets + SSH key + path).

## End-to-end diagram

```
┌─────────────────┐      ┌──────────────────────────┐      ┌────────────┐
│  CI runner      │ OIDC │ /api/deploy of Physalis  │ SSH  │   VPS      │
│  (GH/GL/BB)     │─────▶│ - verifies OIDC token    │─────▶│ /srv/...   │
│                 │      │ - lookup Connection+Policy│      │            │
│                 │◀─────│ - returns bundle         │      │            │
└─────────────────┘      └──────────────────────────┘      └────────────┘
        │                                                         ▲
        │   POST .env + docker-compose + docker login + restart   │
        └─────────────────────────────────────────────────────────┘
```

The CI runner, the VPS and the SSH bundle are **identical** regardless of
provider. Only these change: the repo identifier format, the claim used as
the Policy's 3rd dimension, and the way the token is requested.

## The 4 objects to configure

Before triggering a deployment, you need **4 objects** in Physalis:

1. A **Server** at the organisation level (SSH key of the target VPS)
2. An **Environment** linked to that Server (with a `deployPath`)
3. A **CI/CD Connection** at the organisation level (provider + OIDC issuer
   + optional registry / redeploy credentials)
4. A **Policy** that says *"this repo, on this branch, via this job, can
   deploy to project P, environment E"*

## Per-provider reference table

Keep this table handy: it sums up everything that differs between the three
providers. The rest of the doc refers back to it.

| Aspect | GitHub | GitLab | Bitbucket |
|---|---|---|---|
| **Repo identifier** (Policy + project) | `owner/repo` | `project_path` (e.g. `acme/web`, `acme/team/web`) | `repositoryUuid` (`{11111111-…}`) |
| **Policy's 3rd dimension** | workflow file (`deploy.yml`) | job's `environment: name:` | step's `deployment:` |
| **Branch claim** | `ref` | `$CI_COMMIT_BRANCH` | `branchName` |
| **Audience (`aud`)** | required, must match `OIDC_AUDIENCE` | required, must match `OIDC_AUDIENCE` | not supported → not required |
| **Issuer (on the connection)** | empty for github.com | empty for gitlab.com; instance URL if self-hosted | **required**: workspace OIDC URL |
| **Template** | [deploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.modele.yml) | [deploy.gitlab-ci.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.gitlab-ci.modele.yml) | [deploy.bitbucket-pipelines.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.bitbucket-pipelines.modele.yml) |

> **Note**: only the GitHub template embeds a **`build` job** that builds the
> Docker image and injects `VITE_*` as `--build-arg` (see
> [§ Vite build args](#vite-build-args-build-job)). The GitLab and Bitbucket
> templates are **deploy-only**: they assume the image is already built and
> published to a registry, and simply pull + restart.

## 1. Create a Server

> Permissions: ADMIN / OWNER of the org.

Organisation page → **"Servers"** tab → **"+ New server"**.

| Field           | Description                                                                |
|-----------------|----------------------------------------------------------------------------|
| **Name**        | Internal label (e.g. "Hetzner prod VPS")                                   |
| **IP**          | IPv4 or hostname resolving the VPS                                         |
| **SSH user**    | The Linux user on the VPS side (typically `deploy` or `ci-deploy`)        |
| **Private key** | The **full** SSH key (PEM, OpenSSH) — pasted only once                     |

> ⚠️ The **private key is never readable again** from the UI after creation —
> it is only used at runtime by `/api/deploy` to be included in the bundle.
> If you lose it, delete the Server and create a new one with a new key.

### Preparing the VPS on the SSH side

On the VPS, create the deployment user and authorise the public key:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo -u deploy mkdir -p ~deploy/.ssh
sudo -u deploy bash -c 'echo "ssh-ed25519 AAAA... ci-deploy" >> ~/.ssh/authorized_keys'
sudo -u deploy chmod 600 ~deploy/.ssh/authorized_keys
```

The `deployPath` (default `/srv/projets/<env>/<slug>`) must exist and be
owned by `deploy:deploy`.

## 2. Link the Environment to the Server

On the project page → environment → **Settings** → **Server** field. Choose
the server created in step 1, adjust the `deployPath` if needed (otherwise
the `defaultDeployPath` convention is applied).

See [Projects & environments](projets-et-environnements) for details.

## 3. Create a CI/CD Connection

The **provider**, the **OIDC issuer** and the **infra credentials** (redeploy
token, private registry access) live in a **CI/CD Connection** at the
organisation level — the **"CI/CD"** tab. Each project selects one in its
Settings.

A connection holds:

| Field                 | Role                                                                |
|-----------------------|---------------------------------------------------------------------|
| **Provider**          | `github` \| `gitlab` \| `bitbucket`                                 |
| **OIDC issuer**       | see below — determines which signing authority is accepted          |
| **Redeploy token**    | PAT for the "Redeploy" button (dispatch) — *GitHub only*            |
| **Registry — URL**    | defaults to `ghcr.io`                                                |
| **Registry — user/token** | for `docker login` on the VPS (private registry)                |

### Setting the issuer per provider

- **GitHub** — leave the issuer **empty** (github.com is trusted by default,
  issuer `https://token.actions.githubusercontent.com`).
- **GitLab** — leave **empty** for gitlab.com. For a self-hosted instance,
  set the instance URL (e.g. `https://gitlab.mycompany.com`).
- **Bitbucket** — **required**: the workspace OIDC URL, found in
  *Workspace settings → OpenID Connect*, of the form
  `https://api.bitbucket.org/2.0/workspaces/<ws>/pipelines-config/identity/oidc`.

> **Why the issuer matters**: Physalis only accepts a token if its issuer is
> known. For dynamic instances (self-hosted GitLab, each Bitbucket workspace),
> the issuer must be **explicitly registered** in a connection, otherwise the
> token is rejected with `untrusted_issuer`.

The registry creds are returned by `/api/deploy` under a separate `registry`
key, distinct from `secrets[]` — they do **not** pollute the container's
`.env`, they are only used for the remote `docker login`. Everything is
encrypted (AES-256-GCM) and never shown again.

> **Migration**: the old reserved `OrgSecret`s (`GITHUB_DISPATCH_TOKEN`,
> `REGISTRY_PAT/USER/URL`) are automatically converted into a "GitHub"
> connection on upgrade — nothing to re-enter.

Once the connection is created, link it to the project and set the **repo**
in the format expected by the provider (see the reference table): project →
**Settings** → **CI/CD Connection** + **Repo** field.

## 4. Create a Policy

This is the **authorisation rule**: who (OIDC claims from the job) can deploy
where (Physalis project + env).

On the project page → **"Policies"** tab → **"+ New Policy"**.

Fields (all required, **strict match, no wildcards**):

| Field             | GitHub                | GitLab                  | Bitbucket               |
|-------------------|-----------------------|-------------------------|-------------------------|
| **Repo**          | `argo-web/physalis`   | `acme/web`              | `{11111111-…}`          |
| **Workflow / CI env** | `deploy.yml`      | `production` (`environment: name:`) | `production` (`deployment:`) |
| **Branch**        | `main`                | `main`                  | `main`                  |
| **Environment**   | an existing env in the project | same           | same                    |

The **"Workflow / CI env"** column is the 3rd dimension: it is a workflow
file on GitHub, but the **CI environment name declared by the job** on GitLab
(`environment: name:`) and Bitbucket (`deployment:`). The Policy field must
match **exactly** what the job declares.

> The **"Edit"** button on an existing Policy lets you adjust the fields
> (a collision is detected if another identical tuple already exists).

### What this means in practice

When a job runs, the provider issues an OIDC token. Physalis verifies its
**signature** (the provider's JWKS), extracts `(repo, 3rd dimension, branch)`,
looks for a Policy that matches **exactly**, and only triggers the deployment
if the `(project, environment)` in the request body matches.

Example claims per provider:

```json
// GitHub
{
  "repository": "argo-web/physalis",
  "workflow_ref": ".../.github/workflows/deploy.yml@refs/heads/main",
  "ref": "refs/heads/main",
  "aud": "vault.physalis.cloud"
}

// GitLab
{
  "project_path": "acme/web",
  "environment": "production",
  "ref": "main",
  "aud": "vault.physalis.cloud"
}

// Bitbucket
{
  "repositoryUuid": "{11111111-...}",
  "deploymentEnvironment": "production",
  "branchName": "main"
  // no aud: Bitbucket does not allow configuring it
}
```

## 5. The template workflow / pipeline

Copy the template matching your provider into your repo and adapt the
variables at the top of the file:

| Provider  | Template to copy | Location in the repo |
|---|---|---|
| GitHub    | [deploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.modele.yml) | `.github/workflows/deploy.yml` |
| GitLab    | [deploy.gitlab-ci.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.gitlab-ci.modele.yml) | `.gitlab-ci.yml` |
| Bitbucket | [deploy.bitbucket-pipelines.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.bitbucket-pipelines.modele.yml) | `bitbucket-pipelines.yml` |

The common variables to adapt:

```
VAULT_URL       Physalis URL (e.g. https://vault.physalis.cloud)
VAULT_AUDIENCE  OIDC audience = vault's OIDC_AUDIENCE (GitHub/GitLab; ignored on Bitbucket)
VAULT_PROJECT   project slug in Physalis
VAULT_ENV       target Physalis environment (production, staging, ...)
```

### How each provider requests its OIDC token

- **GitHub** — `permissions: id-token: write` on the job, then
  `core.getIDToken(audience)`:

  ```yaml
  permissions:
    id-token: write    # REQUIRED for core.getIDToken()
    contents: read
    packages: write    # to push to GHCR with GITHUB_TOKEN (build job)
  ```

- **GitLab** — `id_tokens` keyword, the `aud` must match `OIDC_AUDIENCE`:

  ```yaml
  deploy:
    environment:
      name: production           # = Policy's 3rd dimension
    id_tokens:
      VAULT_OIDC_TOKEN:
        aud: "$VAULT_AUDIENCE"
  ```

- **Bitbucket** — `oidc: true` on the step; the token lands in
  `$BITBUCKET_STEP_OIDC_TOKEN`. No audience to configure:

  ```yaml
  - step:
      oidc: true
      deployment: production     # = Policy's 3rd dimension
  ```

In all three cases, the job then calls `POST /api/deploy` with the token as
`Authorization: Bearer`, receives the bundle, writes `.env` (+ optional
`docker-compose.yml`) to the VPS via SCP, then `docker compose pull && up -d`.

## Vite build args (build job)

> Applies to the **GitHub template** only. The GitLab and Bitbucket templates
> are deploy-only and assume the image is already built.

Any environment secret prefixed with `VITE_` is retrieved in the `build` job
and passed to `docker build` as `--build-arg`. In your frontend `Dockerfile`,
declare the corresponding `ARG`s:

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app

ARG VITE_VAULT_URL
ARG VITE_API_URL
ENV VITE_VAULT_URL=$VITE_VAULT_URL
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

> ⚠️ Vite **inlines** `VITE_*` into the final JS bundle → public on the
> browser side. Reserve these for public URLs, feature flags, etc. See
> [Secrets & categories](secrets) for the full convention.

## Building and publishing the image (GitLab / Bitbucket)

The GitLab and Bitbucket templates are **deploy-only**: they pull an
already-published image. It is up to you to **build and push** it to a registry
upstream of the deploy job (a build job that can also fetch `VITE_*` via the
same `/api/deploy`). Two distinct steps, **two sets of credentials**:

| Step | Where it runs | Credentials | Configured where |
|---|---|---|---|
| **Build + push** | in CI | **write** access to the registry | CI variables (`$CI_REGISTRY_*` on GitLab, *repository variables* on Bitbucket) |
| **Pull** | on the VPS (`docker compose pull`) | **read** access to the registry | the **Registry** fields of the CI/CD Connection |

**Which registry?** Any of them:

- **GitLab** — the simplest is the built-in **Container Registry**
  (`registry.gitlab.com/<group>/<project>`), with `$CI_REGISTRY`,
  `$CI_REGISTRY_USER` and `$CI_JOB_TOKEN` already available in the job — the
  equivalent of the GHCR + `GITHUB_TOKEN` combo on GitHub.
- **Bitbucket** — no built-in registry: use an external one (Docker Hub
  `docker.io`, GHCR, AWS ECR…) and store the push creds as *Repository
  variables*.

> ⚠️ The **Registry** fields of the CI/CD Connection (URL / user / token) are
> **not** used for the build. They are returned in the `/api/deploy` bundle and
> used **on the VPS** for `docker login` + `docker compose pull`. Fill them in
> **only if the image is on a private registry**; for a public image, leave
> them empty.

Build-push and pull can target the **same** registry account — but they remain
two separate configurations (CI side to push, Connection side for the VPS to
pull).

## 6. First deployment

1. Push to `main` → the pipeline starts
2. *(GitHub)* `build` job: fetches `VITE_*`, builds the image, pushes to GHCR
3. `deploy` job: fetches the bundle, writes `.env` + `docker-compose.yml`
   to the VPS, runs `docker compose up -d`
4. Check the Physalis **audit log** (org page) → you will see
   `DEPLOY_AUTHORIZED` with the details (repo, 3rd dimension, branch, env)

### In case of failure

The Physalis audit log records `DEPLOY_DENIED` with a diagnosable reason:

| `reason`               | Likely cause                                                                  |
|------------------------|-------------------------------------------------------------------------------|
| `wrong_audience`       | `VAULT_AUDIENCE` in the job ≠ `OIDC_AUDIENCE` in the vault (GitHub/GitLab)     |
| `wrong_issuer`         | The token's issuer is unknown / unsupported                                   |
| `untrusted_issuer`     | Dynamic issuer (self-hosted GitLab / Bitbucket workspace) not registered in a connection |
| `expired`              | The job ran too long before calling `/api/deploy`                             |
| `policy_not_found`     | No Policy matches `(repo, 3rd dimension, branch)`                             |
| `policy_match_failed`  | Policy found but `(project, env)` in the body does not match                  |
| `no_server`            | The env exists but is not linked to any Server                                |

> **Common pitfall (GitLab/Bitbucket)**: a `policy_not_found` often comes from
> a mismatch on the 3rd dimension — the `environment: name:` (GitLab) or
> `deployment:` (Bitbucket) declared in the job does not match, character for
> character, the Policy's "CI env" field.

## "Redeploy" button (workflow_dispatch)

> **GitHub only** for now.

If you want to trigger a redeployment **from the Physalis UI** without a push,
set the **redeploy token** on the project's CI/CD connection (org "CI/CD" tab —
a PAT with `repo` scope or a GitHub App token) and the **"Redeploy"** button
will appear on each environment.

On click, Physalis calls `POST /repos/{owner}/{repo}/actions/workflows/{wf}/dispatches`
which triggers the `redeploy.yml` workflow on the environment's branch. This
workflow **does not rebuild images** — it re-fetches the `.env` bundle, writes
it to the VPS, and restarts the containers via `docker compose up -d`. This is
sufficient for secrets loaded at runtime (environment variables, keys passed
via `.env`).

Copy [docs/redeploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/redeploy.modele.yml)
into `.github/workflows/redeploy.yml` in your repo and adapt the variables at
the top of the file.

> **Secrets injected at build time** (e.g. `VITE_*`) — If your secret is
> passed as a Docker `--build-arg` during the image build, a simple redeploy
> is not enough. You need to trigger the full build workflow (`deploy.yml`).
> Physalis handles this automatically via the **"Full build required"** option
> in the secret's rotation configuration (see [Secret rotation](rotations)).

## Going further

- [Secrets & categories](secrets) — how your `VITE_*` and other env variables
  end up in the bundle
- [Organisations & roles](organisations-et-roles) — who can manage Servers,
  CI/CD Connections and Policies
