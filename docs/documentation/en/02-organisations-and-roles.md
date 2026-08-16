---
title: Organisations & roles
order: 2
icon: RiTeamLine
summary: Invite members, understand the 4 roles, manage permissions.
---

# Organisations & roles

An **organisation** is the main grouping unit in Physalis:
it contains **members**, **projects**, **global secrets**
(`OrgSecret`), SSH **servers**, and **team vaults**.

A single client organisation can contain multiple internal organisations
(e.g. an agency with several teams), and the same user can belong to
multiple organisations — they switch between them via the selector in
the top-left corner of the dashboard.

## The 4 organisation roles

Physalis uses a 4-level hierarchy: `MEMBER` < `DEV` < `ADMIN` < `OWNER`.

| Permission                                   | MEMBER | DEV | ADMIN | OWNER |
|----------------------------------------------|:------:|:---:|:-----:|:-----:|
| Read **organisation secrets**                |   —    | ✅  |  ✅   |  ✅   |
| Read **SSH servers**                         |   —    | ✅  |  ✅   |  ✅   |
| See all **projects** by default              |   —    | ✅* |  ✅   |  ✅   |
| Manage **deployment Policies**               |   —    | ✅  |  ✅   |  ✅   |
| View the full **audit log**                  |   —    |  —  |  ✅   |  ✅   |
| View filtered audit log (own actions)        |   —    | ✅  |  —    |  —    |
| Invite / revoke **members**                  |   —    |  —  |  ✅   |  ✅   |
| Manage **global secrets** (creation)         |   —    |  —  |  ✅   |  ✅   |
| Rename / delete the organisation             |   —    |  —  |   —   |  ✅   |

> ✅* For DEV, visibility is **implicit EDITOR** on all projects in the
> organisation: they can see everything, create/edit secrets and environments,
> but cannot delete a project or invite ProjectMembers.

### Restricting a DEV to specific projects

That default access is adjustable project by project. Unchecking a project for
a DEV **really denies it**: the project disappears from their list, access is
refused, and their machine tokens on that project are revoked.

Three places to do it, depending on when:

- **At invitation time** — the "Access rights" button next to the role, in the
  invite form. The new member arrives already scoped.
- **When creating a project** — the "Member access rights" section of the
  creation form. This is the one moment where forgetting is impossible: a new
  project is otherwise visible to every DEV in the org right away.
- **Later on** — `/orgs/<slug>` → "Members" tab → "Access rights" next to the
  member, or the project's own "Members" tab.

The checkboxes always reflect the member's **actual** access: a DEV opens with
everything checked, because that is what they have.

### When to use which role?

- **MEMBER** → a non-technical employee who only needs access to a specific
  team vault (e.g. sales staff sharing an internal Vaultwarden).
  No project is visible until they are explicitly added as a
  `ProjectMember`.
- **DEV** → a developer. They can read all secrets across all projects,
  manage OIDC deployments, but cannot touch organisation admin (members,
  global secrets, deletion).
- **ADMIN** → a lead developer / technical manager. Everything DEV can do,
  plus member invitations, global secrets, and full audit log.
- **OWNER** → the organisation owner. The only one who can delete or rename it.
  Ideally there should be 2 OWNERs to avoid a single point of failure.

## Invite a member

> Available to **ADMIN** and **OWNER** roles only.

1. Go to `/orgs/<slug>` (from the org selector in the top-left corner).
2. **"Members"** tab → **"+ Invite"** button.
3. Fill in:
   - **Email** of the recipient
   - **Role** in the organisation
4. Submit. An email is sent via Mailgun with an activation link
   **valid for 48 hours**.

If the recipient does not yet have a Physalis account, they create one by
accepting the invitation. If they already have one (another organisation on
the same platform), they are added to the new org in one click.

> 💡 **Quotas**: your client plan defines a maximum number of members
> (`maxUsers`). If you reach it, the invitation form is disabled — you
> need to either revoke a member or ask the super-admin for a plan upgrade.

## Change a member's role

**"Members"** tab → member row → **role** dropdown →
select the new role. The change takes effect immediately; the member may
need to log back in to see their new permissions active.

> ⚠️ You cannot **downgrade yourself** if you are the only OWNER.
> Designate another OWNER first.

## Revoke a member

Same tab → **"Revoke"** button. The member:

- Immediately loses access to this organisation's dashboard
- Loses access to all projects linked to this organisation
- **Keeps** their Physalis account (usable in their other organisations)
- **Can no longer** decrypt secrets they previously had access to — their
  account has no valid session anymore

The audit log retains a full record of all actions performed by that member
during their time in the organisation.

## Organisation global secrets (`OrgSecret`)

**OrgSecrets** are secrets shared across all projects in the organisation.
Typically used for:

- Third-party API tokens (`SENTRY_DSN`, `STRIPE_KEY`…) common to all projects
- **Physalis reserved conventions**:
  - `GITHUB_DISPATCH_TOKEN` — for the "Redeploy" button that triggers
    a `workflow_dispatch` on GitHub
  - `REGISTRY_PAT`, `REGISTRY_USER`, `REGISTRY_URL` — to authenticate
    `docker pull` from a private registry during OIDC deployment
    (see [OIDC Deployment](oidc-deployment))

Create / edit: **"Global secrets"** tab on the organisation page.
Reserved to ADMIN / OWNER (DEV can read).

## Delete an organisation

> Available to the **OWNER** role only.

**"Settings"** tab → **"Danger zone"** section. Deletion:

- Destroys **all** linked projects, environments, secrets, vaults, and
  policies
- Is **irreversible** (encrypted data is deleted from the DB)
- Detaches all members (who remain registered on Physalis)

Confirmation by typing the organisation name is required.

## Go further

- [Projects & environments](projects-and-environments) — create your
  first project and add secrets to it
- [Vaults](vaults) — create a shared team vault
- [OIDC Deployment](oidc-deployment) — configure Server + Policy
