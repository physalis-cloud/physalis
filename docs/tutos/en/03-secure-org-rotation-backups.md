---
title: Secure your org: auto-rotation + encrypted backups
order: 3
icon: RiShieldCheckLine
summary: Move to a production posture: automatically renew a secret, and back up your databases encrypted to your own server — with one-click restore.
level: advanced
duration: ~20 min
published: true
---

# Secure your org: auto-rotation + encrypted backups

This guide moves your organisation to a **production posture**: first the
**automatic rotation** of a secret (no more credentials lingering for years),
then **encrypted backups** of your databases to your own server, with
orchestrated restore.

## What you'll accomplish

- Rotation **enabled** for your organisation, and a first secret that renews on
  its own
- A project's databases **backed up, encrypted**, to your destination VPS
- A **tested restore** (into a fresh database, without touching production)

## Prerequisites

- A **paid plan**: rotation and backups are advanced features.
- The **ADMIN** or **OWNER** role of the organisation.
- An **already-deployed project** (see [Create a project…](tuto:first-github-deployment))
  with at least one database.
- A **destination VPS** (among your servers) to receive the backups.

### Notes

Some settings are **global** and are done **only once**:

- **Step 1 — Enable rotation** (organisation level)
- **Step 4 — Set the backup destination** (client level, reused by all projects)

---

## 1. Enable rotation for the organisation

Rotation is **opt-in** at the organisation level.

Open the **Settings → Info tab** menu and enable rotation. While it's disabled,
no rotation button appears.

![Enabling rotation in the organisation settings](/tutos/en/secure-org-rotation-backups-01.png)

> Rotation is automatically suspended when a project is **paused**.

## 2. Configure a secret's rotation

On an environment secret (a project's **Secrets** tab), click **Rotation**. The
modal groups the **configuration** (enable + interval in days + strategy) and
the **immediate rotation**.

Choose the **strategy** based on the secret:

| Secret | Strategy | What Physalis does |
|--------|----------|--------------------|
| `JWT_SECRET`, `SESSION_SECRET`… | **JWT Secret** | generates a new value, redeploys — 100% automatic |
| a **database** password (PG/MySQL role) | **Database** | self-rotation `ALTER … PASSWORD`, no admin credential |
| a key issued by the Physalis **API Gateway** | **API key** | new key + revocation of the old one |
| third-party key (Stripe, Mailgun…) | **Reminder** | notifies you; you change it at the source then save |

Physalis pre-selects a **smart default** based on the secret's name (a
`*_PASSWORD` → **Database**, a `JWT_SECRET` → **JWT Secret**, everything else →
**Reminder**).

### Our example: rotating the database password

We take the most **complete** case — and the most useful in production. On the
password secret (e.g. `DATABASE_PASSWORD`), open **Rotation**, enable it, set the
**interval** (in days) and choose the **Database** strategy. Fill in the
**target**:

| Field | Value |
|-------|-------|
| `dbType` | `POSTGRESQL` or `MYSQL` |
| `dbHost` | the DB's **Docker service name** (e.g. `db`, `postgres`) — stays on the internal network |
| `dbPort` | `5432`, `3306`… |
| `dbName` | database name |
| `dbUser` | the user **whose password is rotated** |

Leave the **execution mode** on **Agent on the VPS** *(the default)* — that's the
one we use here, and that's where the **agent** comes in:

- Physalis injects a **companion container (the agent)** at deploy time, next to
  your application. It's the one that, **locally on your server**, connects to
  the database via its **Docker service name** (never exposed externally), runs
  the password change, then **reports** the new value back to Physalis.
- **No database port to open to the outside**, and it's the **same agent** that
  handles backups (step 5).

![Rotation modal in Database strategy, Agent mode](/tutos/en/secure-org-rotation-backups-02.png)

> **Managed database?** If your database is a **managed service reachable over
> TCP+SSL** (Supabase, RDS, Neon…), pick the **Direct** mode instead: Physalis
> connects to it itself, without an agent. The rest of the form is identical.

> **Self-rotation, no admin account.** The executor connects **as the user being
> rotated**, with its current password (read from the injected `.env`), and runs
> `ALTER … PASSWORD` on itself — no superuser is stored or used. The new value is
> written only **after** the change is confirmed at the source.

**The "Full build required" checkbox.** Leave it **unchecked** for a database
password: it's a *runtime* secret, a simple redeploy is enough. Only check it if
the value is baked **at build time** (`VITE_*`, `NEXT_PUBLIC_*`, compiled into
the bundle).

### Deploy the agent — once per project

The Agent mode relies on an **agent**: a small **companion container** that
Physalis runs **next to your application**, on your server. It runs the rotation
**locally** — and it's **the same agent** that will run the **backups**
(step 5). Installing it once covers **both features**.

A single action to install it: after saving the rotation, click **once** on
**Redeploy** (the project's button). Physalis adds the agent service to the
served `docker-compose`, and it starts at the usual `docker compose up` —
**nothing to do on your side** on the server.

- **A simple Redeploy is enough** (no rebuild needed): the served compose already
  contains the agent.
- **Only once per project**: once in place, the agent then handles **all** the
  project's rotations *and* backups; each rotation triggers its own redeploy.
- **To be redone for each project** where you enable rotation or backups: the
  agent is **created per project** (one agent container = one project).

> Redeploy relies on the **CI/CD connection** (`workflow_dispatch`) set up at the
> [first deployment](tuto:first-github-deployment). Without it, no redeploy
> (simple or full) can fire.

## 3. Force a rotation to test

To **validate** the rotation, we won't wait for the deadline: we **force** it.
Two places let you trigger a password rotation.

**From the project**, on the secret itself: reopen the **Rotation** modal and use
**"Force"** (the *immediate rotation* section).

![The "Force" button in the secret's rotation modal](/tutos/en/secure-org-rotation-backups-03.png)

**From Settings → Rotation tab**, where you find **all the organisation's enabled
rotations, grouped by project**: each row has its own button to force the
rotation.

![Organisation's Rotation tab, rotations grouped by project](/tutos/en/secure-org-rotation-backups-04.png)

In both cases, the value is changed at the source according to the strategy (in
**Agent** mode, the agent applies the change on its next poll, within a minute),
the old value is archived in the versioning, then a **redeploy** reloads the
`.env`.

> A notification is sent to the ADMIN/OWNER on the **first failure** only. Every
> rotation is traced in the audit log.

## 4. Set up backup for the organisation

The service must be **enabled once**, and the destination is set **once per
client**. Go to **Account & billing → Services tab** and tick **"Enable
automated backup for this client"**.

Then choose a **destination VPS** (among your servers) and a base **path**. All
projects will write there, each in its own subfolder.

![Enabling automated backup and setting the destination (Account & billing → Services)](/tutos/en/secure-org-rotation-backups-05.png)

> Only **encrypted content** leaves your VPS: Physalis never sees your data and
> doesn't hold the decryption key.

## 5. Enable backup for the project

In the project's **Backup** tab:

1. click **"Configure backup"**;
2. choose the **environment** to back up (prod by default) and check the list of
   **automatically detected databases**;
3. set the **schedule**: the **interval** in days (`1` = every day) and the **UTC
   hour** of the run (default **3 h UTC**);
4. set the **retention** — how many backups to keep, across three tiers
   **Daily / Weekly / Monthly** (default **7 / 4 / 3**): Physalis keeps the last
   7 **daily** backups, 4 **weekly** and 3 **monthly**. You thus get
   **fine-grained** history over the recent days and more **spread-out** over the
   months, without keeping everything;
5. save.

![Configuring a project's backup](/tutos/en/secure-org-rotation-backups-06.png)

> **Same agent as rotation.** The backup runs via the **agent** injected at the
> **next deployment**. If you already **deployed it for rotation (step 2)**, it's
> the **same container** — nothing to redo. Otherwise, a **Redeploy** installs it
> (same procedure as in step 2, *once per project*).

## 6. Switch to KMS Envelope encryption

In the **Backup** tab, click **"Enable KMS encryption"**.

The **KMS Envelope** (recommended over GPG) encrypts each archive with a unique
data key, sealed by a **master key** that never leaves the cryptographic vault.

Benefits: centralised rotation/revocation/**audit**, and above all **one-click
restore** from Physalis.

> **A Redeploy is required.** The encryption change takes effect at the **next
> deployment**: that's when Physalis injects the **KMS identity** into the
> agent's environment. So click **Redeploy** — otherwise the agent keeps its
> current scheme (the next backup **alone** doesn't switch). After that
> deployment, **all** backups move to envelope encryption. This doesn't touch
> your database's access, and the GPG backups already produced remain restorable.

## 7. Force a backup

Click the **"Force now"** button: the agent runs the backup on its next poll
(within a minute).

The result appears in the **history** (status, file, size, date).

![Backup history after a forced backup](/tutos/en/secure-org-rotation-backups-07.png)

## 8. Restore (test into a fresh database)

On a successful backup in the history → **"Restore"** button, **New DB** mode
(the safest):

1. create a **fresh, empty** database beforehand;
2. launch the restore into that database.

![Restoring a backup](/tutos/en/secure-org-rotation-backups-08.png)

Physalis orchestrates: the agent pulls the archive, **decrypts it locally** (via
the vault, on demand and audited) and restores it. The plaintext content never
passes through Physalis.

> The **"Replace in place"** mode is the real disaster recovery (it
> **overwrites** the current database) — reserve it for real incidents,
> preferably with the app stopped.

## Check that everything works

- **Rotation**: in the org's Rotation tab, the secret shows
  `rotationLastStatus = success` and a **next deadline**.
- **Backup**: the history shows a **successful** backup, in envelope mode.
- **Restore**: your test database indeed contains the restored data.

## Troubleshooting

- **No rotation button** → the feature isn't enabled on the org (step 1), or the
  secret's name isn't recognised as a credential (`PORT`, URL, flag… :
  intentional).
- **No automatic rotation fires** → the cron runs at an off-peak hour (default
  2 h UTC); use **"Force"** to test on demand.
- **The "new DB" restore is refused** → the target database must be **empty**
  (anti-overwrite safety).
- **A backup is "skipped"** → the cryptographic vault was momentarily
  unavailable; resumes at the next one — never a plaintext backup.

## What's next?

- Next tutorial: [Configure the email service](tuto:configure-email-service)
- To go further:
  - [Secret rotation](rotations) — Webhook strategy (app accounts), app-side
    hooks, managed-database accounts
  - [Backups](backups) — GPG vs Envelope, retention, security
  - [Vaults](vaults) — share non-runtime credentials with your team
