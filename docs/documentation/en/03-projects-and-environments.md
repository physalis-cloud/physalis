---
title: Projects & environments
order: 3
icon: RiFolderOpenLine
summary: Create a project, manage its environments, link a deployment server.
---

# Projects & environments

In Physalis, each deployed application is represented as a **project**
attached to an organisation. A project contains:

- A list of **environments** (`production`, `staging`, `main`…), each
  with its own secrets
- **Services** and **application accounts** (databases, third-party services,
  admin access) stored encrypted
- OIDC **deployment policies** (who can deploy what)
- Optionally, a **team vault** scoped to the project

## Create a project

> Permissions: **ADMIN** or **OWNER** of the organisation. **DEV**
> can see all projects but cannot create them.

1. Go to `/projects` (**Projects** tab in the nav).
2. Under **"Create a project"**, enter your project **name**, then click
   **"Create"**.
3. The project appears in an **"ungrouped"** block by default. Its **slug**
   (URL-safe identifier used in `/projects/<slug>` and the deployment bundle)
   is **derived from the name**.

> ⚠️ The **slug is permanent**: it serves as the anchor for OIDC
> deployment Policies. Changing it later will break all workflows that
> reference it.

## Create an environment

When a project is created, **three environments are created by default**:
`development`, `staging` and `production`. You manage them from the **project
settings** — **"Environments"** tab — and can **add** more with the
**"+ New environment"** button.

Environment fields:

| Field            | Description                                                                 |
|------------------|-----------------------------------------------------------------------------|
| **Name**         | `production`, `staging`, `main`, `preview`… (lowercase by convention)      |
| **Public URL**   | URL where the app will be accessible (displayed in the dashboard, optional) |
| **Server**       | Target SSH server (see below)                                               |
| **Deploy path**  | Absolute path on the VPS where the app will be deployed (auto default, see below) |
| **Docker Compose** | Full YAML of the `docker-compose.yml` pushed at deployment time (optional) |

### `defaultDeployPath` convention

If you leave **Deploy path** empty, Physalis automatically applies the
convention:

```
/srv/projets/<env>/<slug>
```

For example, the `physalis` project in the `production` environment will
be deployed to `/srv/projets/production/physalis` on the VPS.

This is the recommended convention — you only need to enter a custom path
if you have an unusual VPS infrastructure.

### Server ↔ Environment link

The **Server** is defined at the organisation level (one SSH server = one
encrypted key = one target). Each environment points to **one server**,
but **one server can host multiple environments**
(e.g. both `staging` and `preview` on the same test VPS).

Create / edit servers: org page → **"Servers"** tab.
See [OIDC Deployment](oidc-deployment) for full configuration.

### Embedded Docker Compose

If you fill in a `docker-compose.yml` in Physalis, it will be **pushed at
deployment** by the OIDC workflow to the VPS, into the `deployPath`.
Handy for driving the whole stack from one place (Physalis becomes the
source of truth).

If you leave it empty, your VPS must already have a local `docker-compose.yml`
— Physalis will only update the `.env`.

## Edit an environment

Click on an environment in the list to open its detail page.
There you will find:

- **Secrets** — the list of all encrypted `.env` variables
  ([→ Secrets](secrets))
- **Settings** — the fields above, editable
- **"Redeploy" button** — triggers a `workflow_dispatch` GitHub
  Actions on the associated branch (requires `GITHUB_DISPATCH_TOKEN` as
  an OrgSecret, see [Organisations & roles](organisations-and-roles))

## "Access" tab of the project

This tab groups **non-secret references** related to the project:

- **Environment cards** — visual summary per environment (URL, server, last
  deployment seen in the audit log)
- **Services** — entries for services tied to the project. Two uses:
  - *third-party service* (Sentry, Stripe…): encrypted **username + password**;
  - *backend service*: often **just a URL** (username/password **optional**),
    which can carry the **account rotation hook** for its linked accounts.
- **Application accounts** (`AppAccount`) — encrypted credentials for
  application users (Strapi admin, PostgreSQL super-user…). An account can be
  **linked to an environment** (frontend) or a **service** (backend): its URL
  follows from the link (the extension then offers it on the right page).

This is where you document "how to connect to this project manually",
without polluting the runtime-injected secrets.

> Services and accounts can also be **rotated** (assisted reminder, or
> **webhook** for accounts via the linked backend service's hook) — see
> [Secret rotation](rotations).

## Per-project permissions (`ProjectMember`)

At the top level, **organisation roles are sufficient**:

- ADMIN / OWNER → implicit OWNER on all projects
- DEV → implicit EDITOR on all projects
- MEMBER → **no project visible** without an explicit `ProjectMember`

To give a MEMBER access to a specific project (or to restrict a DEV,
or to promote a DEV to project OWNER):

1. Project page → **"Members"** tab.
2. **"+ Add"** → choose the user (already a member of the org) and
   their role:
   - **VIEWER** — read-only
   - **EDITOR** — can edit secrets, environments, services
   - **OWNER** — everything EDITOR can do, plus project deletion and member management

> 💡 `ProjectMember` roles **never downgrade** an existing role: an org OWNER
> remains a project OWNER even if added as VIEWER. The effective role is
> the **maximum** between the implicit org role and the explicit project role.

## Delete a project

> Available to the **project OWNER** role (or ADMIN/OWNER of the org via inheritance).

**"Settings"** tab → **"Danger zone"** section. Deletion:

- Destroys all environments and their secrets
- Destroys all linked OIDC Policies (associated GitHub Actions workflows
  will no longer be able to deploy)
- Is **irreversible**

## Go further

- [Secrets](secrets) — manage the `.env` variables of an environment
- [OIDC Deployment](oidc-deployment) — configure Server, Policy,
  and the GitHub Actions workflow
- [Vaults](vaults) — create a team vault scoped to the project to
  share non-runtime credentials
