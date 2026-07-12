---
title: Create a project, connect it to GitHub and deploy it
order: 1
icon: RiRocketLine
summary: From zero to a first application deployed automatically from GitHub, via OIDC — with no secret stored in your repository.
level: beginner
duration: ~30 min
published: true
---

# Create a project, connect it to GitHub and deploy it

This guide walks you end to end: create your first Physalis **project**, store
its secrets, connect it to a **GitHub** repository, and get an **automatic
deployment** on every `git push` — all without ever pasting a Physalis secret
into your repository.

We follow the simplest path here: **GitHub + a VPS over SSH**. Other providers
(GitLab, Bitbucket) follow the same logic — see
[OIDC Deployment](oidc-deployment) once you've finished this guide.

## What you'll accomplish

- A Physalis project with a `production` environment and its secrets
- A GitHub repository that deploys itself to your VPS on every push
- An **OIDC** authentication chain: your repository holds **no** Physalis secret

## Prerequisites

- A Physalis account with the **ADMIN** or **OWNER** role on your organisation
  (see [Organisations & roles](organisations-and-roles)).
- A **GitHub repository** containing a dockerised application (a `Dockerfile`
  that builds, and an image publishable to GHCR).
- A **VPS** reachable over SSH, with Docker installed.

### Notes

Some steps are done **only once**: once configured, they are reused across
**all your projects**.

- **Step 2 — Add your server** (defined at the organisation level)
- **Step 3 — Create the GitHub CI/CD connection** (defined at the organisation level)

---

## 1. Create the project

In the nav, go to **Projects** → enter your project **name** under "Create a
project", then click **"Create"**.

![Project creation form](/tutos/en/first-github-deployment-01.png)

> ⚠️ The **slug** (derived from the name) is **permanent**: it anchors
> deployment Policies and the deploy path. Changing it later breaks the
> workflows.

Your app appears in an **"ungrouped"** block by default.

![The created project, in the "ungrouped" block](/tutos/en/first-github-deployment-01.1.png)

## 2. Add your server (VPS)

The SSH server is defined **at the organisation level**. Once configured, you
can use it for **all your projects and environments** deployed on that server.

**Settings menu → Servers tab → "+ Add"**

![Add-server form](/tutos/en/first-github-deployment-02.png)

| Field           | Value                                       |
|-----------------|---------------------------------------------|
| **Name**        | e.g. "Prod VPS"                             |
| **IP**          | the VPS IP or hostname                      |
| **SSH user**    | e.g. `github-deploy`                        |
| **Private key** | the full SSH key (pasted once)             |

> ⚠️ The private key is **never readable again** after creation. If you lose it,
> delete the server and recreate it with a new key.

On the VPS, create the deployment user and authorise the public key:

```bash
sudo adduser --disabled-password --gecos "" github-deploy
sudo usermod -aG docker github-deploy
sudo -u github-deploy mkdir -p ~github-deploy/.ssh
sudo -u github-deploy bash -c 'echo "ssh-ed25519 AAAA... ci-deploy" >> ~/.ssh/authorized_keys'
sudo -u github-deploy chmod 600 ~github-deploy/.ssh/authorized_keys
```

> ⚠️ **Prepare the target folder on the VPS** before the first deployment,
> otherwise it fails. Create the `deployPath` (default
> `/srv/projets/production/<slug>`) with an empty `.env` and `docker-compose.yml`:
>
> ```bash
> sudo -u github-deploy mkdir -p /srv/projets/production/my-app
> sudo -u github-deploy touch /srv/projets/production/my-app/{.env,docker-compose.yml}
> ```
>
> Physalis will overwrite the real content on every deployment.

## 3. Create the GitHub CI/CD connection

The connection lives **at the organisation level**: **Settings menu → CI/CD tab
→ "+ New connection"**.

- **Provider**: `github`
- **OIDC issuer**: leave it **empty** (github.com is trusted by default)
- **Redeploy token**: a *fine-grained* PAT with **Contents: Read** +
  **Actions: Write** (used by the "Redeploy" button and to read your project docs)
- **Registry**: `ghcr.io` — fill in user/token **only** if your image is on a
  private registry

![Creating the GitHub CI/CD connection](/tutos/en/first-github-deployment-03.png)

## 4. Configure the production environment settings

Click your **project card**.

Three environments are created **by default**: `development`, `staging` and
`production`. You manage them in the **project settings** (gear icon ⚙️).

In this example, we deleted the `development` and `staging` environments to keep
only `production`.

Open the `production` environment → **Settings**:

- **Public URL**: the URL where the app will be reachable (optional)
- **Deploy path**: leave it **empty** → convention `/srv/projets/production/my-app`
- **Server**: choose the server created in **step 2**

![Production environment settings](/tutos/en/first-github-deployment-04.png)

### Link the CI/CD connection to the project

Project → **Settings** → **CI/CD connection**:

- select the **connection** created in step 3, then fill in the **Repo** field
  as `owner/repo` (e.g. `my-org/my-app`);
- for the **Redeploy workflow** field, keep the default value — we recommend
  keeping `redeploy.yml`;
- click **Save**.

![CI/CD connection linked to the project](/tutos/en/first-github-deployment-04.1.png)

## 5. Prepare the production environment for deployment

### Add your secrets

Still on the `production` environment → **Secrets** tab → **"+ Add a secret"**.
Enter your app's `.env` variables (API keys, DB URL, etc.), or **import your
`.env` directly** for automatic filling.

> 💡 Variables prefixed with `VITE_` are injected **at image build time** (and
> are therefore public on the browser side). Reserve them for public URLs and
> feature flags. Details: [Secrets & categories](secrets).

### Copy your docker-compose.yml

In the **Docker Compose** tab, paste your file's content then **save**.

> 💡 **`.env` and `docker-compose.yml` are regenerated on every deployment**
> from the values stored in Physalis (Physalis is the source of truth, not the
> VPS). Once the redeploy Policy and workflow are in place (steps 6-7), a
> **"Redeploy"** button appears on the environment: after changing a secret or
> your Docker Compose, one click restarts the container with the new values
> **without rebuilding the image** (about fifteen seconds), whereas a full
> deployment rebuilds and republishes the image.

## 6. Create the deployment Policy

This is the rule that authorises *this repo, on this branch, via this workflow*
to deploy to *this environment*.

> You must have **selected a CI/CD provider and filled in a repo** (step 4) to
> be able to create a Policy.

Project → **Policies** tab → **"+ Add"**. Three values to fill in:

| Field                        | Value                                          |
|------------------------------|------------------------------------------------|
| **Workflow** (`.yml` file)   | `deploy.yml` (or `production.yml`)             |
| **Branch** (exact match)     | `main` (or `production`, your branch name)     |
| **Target environment**       | `production`                                    |

> **Strict match, no wildcard**: these values must match exactly what the
> workflow declares.

You can create the **redeploy rule directly**: same values as the deploy Policy,
only changing the workflow name (`redeploy.yml` recommended).

![Creating the deploy and redeploy Policies](/tutos/en/first-github-deployment-06.png)

## 7. Add the GitHub Actions workflows

Copy both templates into your repository, under `.github/workflows/`.

### The deployment workflow (`deploy.yml`)

Copy [deploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.modele.yml)
to `.github/workflows/deploy.yml`, and adapt the variables at the top of the file:

```
VAULT_URL       https://vault.physalis.cloud
VAULT_AUDIENCE  = the vault's OIDC_AUDIENCE
VAULT_PROJECT   my-app          # the project slug
VAULT_ENV       production
```

> ⚠️ Only change **`VAULT_PROJECT`** and **`VAULT_ENV`**. Do not touch
> `VAULT_URL` or `VAULT_AUDIENCE`.

The workflow requests an OIDC token from GitHub (`id-token: write`), sends it to
`/api/deploy`, receives the bundle (secrets + SSH key + path), writes it to the
VPS and runs `docker compose up -d`.

### The redeployment workflow (`redeploy.yml`)

Copy [redeploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/redeploy.modele.yml)
to `.github/workflows/redeploy.yml` (same variables at the top). It redeploys
**without rebuilding the image** (re-fetch of secrets + `docker compose up -d`)
and powers the **"Redeploy"** button in the Physalis UI. It relies on the
`redeploy.yml` Policy created in step 6.

## 8. First deployment

Run a `git push` on `main` (or the branch name you defined). The workflow starts:

1. **build** job: fetches the `VITE_*`, builds the image, pushes it to GHCR
2. **deploy** job: fetches the bundle, writes `.env` + `docker-compose.yml` to
   the VPS, runs `docker compose up -d`

## Check that everything works

- In Physalis: organisation page → **Audit log** → you should see a
  **`DEPLOY_AUTHORIZED`** event with the repo, branch and environment.
- Your application responds at its public URL.

## Troubleshooting

The audit log records a **`DEPLOY_DENIED`** with a reason:

- **`policy_not_found`** → the (repo, workflow, branch) tuple matches no Policy.
  Check the exact spelling in **step 6**.
- **`wrong_audience`** → the workflow's `VAULT_AUDIENCE` ≠ the vault's
  `OIDC_AUDIENCE` (not to be changed in the template — see step 7).
- **`no_server`** → the environment is linked to no server. Redo **step 4**
  (**Server** field).
- **`expired`** → the job took too long before calling `/api/deploy` (re-run it).

Full list of reasons: [OIDC Deployment](oidc-deployment).

## What's next?

- Next tutorial: **Invite your team and set up SSO** *(coming soon)*
- To go further:
  - [OIDC Deployment](oidc-deployment) — GitLab, Bitbucket, Vite build args,
    "Redeploy" button
  - [Secrets & categories](secrets) — organise your variables
  - [Projects & environments](projects-and-environments) — services, application
    accounts, project members
