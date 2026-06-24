---
title: Backups
order: 14
icon: RiDatabase2Line
summary: Automatically back up your projects' databases, encrypted, to your own server — and restore them in one click.
---

# Backups

Physalis automatically backs up your projects' **databases**, **encrypted**, to a
destination server you choose. The principle: only **encrypted content** ever
leaves your VPS — Physalis never sees your data, and never holds the decryption
key.

## How it works

When a project deploys, Physalis adds an **agent** (companion container) next to
your application. This agent:

1. connects to your database and takes a `dump`;
2. **compresses and encrypts** it locally;
3. ships it (`rsync`) to your **destination VPS**.

All connections are **outbound**: the agent calls Physalis and the destination,
nothing comes in. The plaintext dump never leaves your project's server.

## Prerequisite: the destination

The destination is set **once per client**, under **Settings → Security**: a
**destination VPS** (one of your servers) + a base **path**. All of the client's
projects write there, each in its own sub-folder.

## Enable backups for a project

In the project's **Backup** tab:

1. pick the **environment** to back up (prod by default);
2. **databases** are auto-detected (from the `docker-compose` + secrets) — review
   and adjust the list;
3. set the **schedule** (UTC hour + interval in days) and the **retention**
   (number of backups kept);
4. save.

Backups start at the project's **next deployment** (the agent is injected then).

## Encryption: GPG or KMS envelope

Two modes, chosen per project via the **"Enable KMS encryption"** /
**"Switch back to GPG"** button:

- **GPG (legacy)**: the agent generates a key pair **on your VPS**; the private
  key never leaves it. Simple, but one key per server (no central management, no
  orchestrated restore).
- **KMS envelope** (recommended): each archive is encrypted with a **unique data
  key**, itself sealed by a **master key** that never leaves the cryptographic
  vault (OpenBao). Benefits: centralized rotation, revocation and **audit**,
  **post-quantum** robustness (symmetric AES‑256 encryption), and above all
  **one-click restore** from Physalis.

Switching mode takes effect at the **next deployment**. It **does not touch your
database access** (users, passwords). Backups already produced with GPG remain
restorable.

## Force a backup

The **"Force now"** button requests an immediate backup: the agent runs it on its
next poll (within a minute). The result shows up in the history.

## History

The **Backup** tab lists backups (status, file, size, date), **paginated by 10**.
A successful entry is restorable (envelope mode).

## Restore a backup

From the history, on a successful backup: the **"Restore"** button. Two modes:

- **New DB** (safe, default): restores into a **fresh, empty** database you create
  beforehand. Ideal to **verify** a backup or start from a copy without touching
  production.
- **Replace in place**: replaces the **current database's content** with the
  backup — true **disaster recovery**. ⚠️ The current data in that database is
  **overwritten**; best done with the application stopped.

> **Restore does not touch access** (roles, users, passwords): only the
> **content** is restored. Your application reconnects normally, with the same
> credentials.

Restore is **orchestrated**: Physalis asks the agent to pull the archive, decrypt
it (via the vault, on demand and audited) and restore it **locally** on your
server. The plaintext content never passes through Physalis.

## Good to know

- **"New DB"** restore requires an **empty** target database (otherwise it is
  rejected, to prevent accidental overwrites).
- **"Replace in place"** restore relies on **envelope-mode** backups: use a
  **recent** backup (force one if needed).
- If the cryptographic vault is momentarily unavailable, a backup is **skipped**
  (resumed at the next one) — **never** an unencrypted backup.

## Security

- Only **encrypted** content leaves your server; the destination VPS stores only
  archives that are useless without the vault.
- In **KMS envelope** mode, the **master key never leaves** the vault, and each
  client is **isolated**: one client's key cannot decrypt another's backups.
- See also: [Secret rotation](rotations) — which uses the same agent.
