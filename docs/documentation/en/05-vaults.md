---
title: Vaults
order: 5
icon: RiSafe2Line
summary: Personal vault, team vaults, TOTP for third-party sites.
---

# Vaults

**Vaults** (`Vault`) are used to store credentials that are **not**
runtime environment variables — typically web access credentials
(Bitwarden, AWS Console, Stripe dashboard, OVH control panel…).

Three vault levels exist in Physalis:

| Vault               | Visibility                           | Use case                                     |
|---------------------|--------------------------------------|----------------------------------------------|
| **Personal**        | You only                             | Your personal access, local DBs, personal items |
| **Team (org)**      | Members added to the collection      | Shared access among tech leads of an org     |
| **Team (project)**  | Project members (`ProjectMember`)    | Access tied to a specific project            |

All vaults use the same AES-256-GCM server-side encryption as project
secrets.

## Personal vault

Accessible via **🔒 Personal vault** in the dashboard nav, at the URL
`/vault`. No one other than you can read your entries — not even the
OWNERs of your organisation.

### The four entry types

Not everything is a login on a website. The add dialog starts with a
**type** selector, and the form adapts:

| Type       | What it holds                                   | Example                     |
|------------|-------------------------------------------------|-----------------------------|
| **Login**  | URL *(optional)*, username, password, 2FA code  | AWS Console, Gmail          |
| **Secret** | A single value                                  | API key, licence number     |
| **List**   | Several labels + values                         | A bank's security questions |
| **Note**   | Free-form text                                  | Recovery procedure          |

Only the **Login** type carries a URL — so it is the only one the browser
extension offers for autofill. The other three remain readable from the
site itself.

For a **List**, labels are encrypted just like values: search does not
cover them, and the list simply shows "N secrets".

### Create an entry

1. Click **"+ Add"** on `/vault`.
2. Pick the type, then fill in:
   - **Name** — short label (e.g. "AWS prod Console"), shared by all types
   - **URL** — associated website (used by the browser extension for
     domain matching)
   - **Username** — login / email
   - **Password** — can be generated with the built-in **🎲 generator**
     (length, symbols, ambiguous character exclusion are configurable)
   - **TOTP** *(optional)* — `otpauth://...` key to generate 2FA codes
     for the third-party site (see below)
3. **Collection**, **tags** and **★ favourite** sit on the last row of
   the form.

### Change the type of an existing entry

The type selector stays active when editing, but **only conversions that
lose nothing** are offered. In practice: an entry that only has a name
and a password can become a Secret, a List or a Note — its value is
carried over automatically. If the entry still has a URL, a username or
a 2FA code, the target type is greyed out: remove the offending field
and save before converting.

A List holding several secrets converts to nothing: empty it first if
you want to change its shape.

### Password generator

The 🎲 button opens a universal generator with:

- Length (8 → 64 characters)
- Include / exclude: uppercase, lowercase, numbers, symbols
- Exclude ambiguous characters (`0`/`O`, `1`/`l`/`I`)

The generated password is inserted directly into the field — you can
regenerate it until satisfied before saving.

## Team vaults

### Team vault at the organisation level

On the org page → **🔒 Vaults** tab. Lets you create a **collection**
(e.g. "Client admin access") and add entries shared with a selected
subset of members.

#### Create a collection

> Permissions: ADMIN / OWNER of the org.

1. Click **"+ New collection"**.
2. Fill in:
   - Collection **Name**
   - Initial **Members** (from the org's member list)
3. Submit. All added members can now see the collection
   and create / read entries in it.

#### Add / remove a member

Inside the collection → **"Members"** tab → add via dropdown,
remove via the **"Revoke"** button.

> ⚠️ **Revoking does not re-encrypt** existing entries. The revoked member
> no longer has a valid session to read the entries, but you should treat
> the credentials as **potentially compromised** if they could have
> exfiltrated them during their access. Rotate anything sensitive.

### Team vault at the project level

Same principle, but scoped to a project: project page →
**🔒 Vault** tab → collection visible to `ProjectMember`s.

**RBAC is inherited** automatically: no need to manage a separate member
list — anyone with a role on the project has access to the project vault
(read access for VIEWER, write access for EDITOR/OWNER).

## TOTP for third-party sites

If you store the `otpauth://...` key of a site in a vault entry,
Physalis automatically generates **6-digit TOTP codes** every 30 seconds
(RFC 6238).

### Enter a TOTP key

The TOTP field belongs to the **Login** type — the only one that represents
an account on a site.

When you enable 2FA on an external site, you get a QR code
or an `otpauth://totp/...?secret=XXXX&...` string. Paste that string
into the **TOTP** field of the entry:

- Full `otpauth://` string → parsed automatically (account, issuer,
  algorithm, period)
- Or just the base32 secret (`JBSWY3DPEHPK3PXP`) → default period/algorithm

### Read the code

On the entry, the 6-digit code is displayed with a **countdown** of the
remaining seconds. Click it to copy to the clipboard.

The **browser extension** ([→ Browser extension](browser-extension))
goes further: it auto-fills `autocomplete="one-time-code"` fields on
websites without any manual copy-pasting.

## Move a personal entry → team or project account

If you have created a personal entry that should be shared or attached to a
project:

1. On the personal entry → click **"Move"**.
2. Choose the destination:
   - a **team collection** (org or project) that you belong to;
   - or a **project Account** (*Access* tab) — the entry becomes an application
     account. ⚠️ The username and password are kept, but the **URL and 2FA
     (TOTP) are not carried over** (accounts have no such fields); a warning
     reminds you.
3. Submit. The entry is **atomically re-encrypted and moved** — it disappears
   from your personal vault and appears in the chosen destination.

Only the **Login** and **Secret** types can be moved: their content fits
entirely into a team entry. **Lists** and **Notes** have no team-vault
equivalent yet — the "Move" button simply does not appear on them, rather
than emptying them silently.

## Import from another password manager

The personal vault's **"Import"** button accepts a CSV export from
**Bitwarden**, from **Chrome**, or a generic CSV. Bitwarden folders become
collections. A preview is shown before anything is saved.

Logins and Bitwarden **secure notes** are imported (notes become entries of
type Note). Cards and identities are skipped: no vault type represents them.

## Reading entries from the browser extension

The Physalis extension (Chrome / Firefox, see
[Browser extension](browser-extension)) reads all 3 vault sources
simultaneously:

- Personal vault
- Team vaults (org)
- Team vaults (project)

On the visited site, it suggests credentials matching the domain
(via the URLs stored in the entries). Only **Login** entries are eligible —
they are the only ones carrying a URL. Your Secrets, Lists and Notes stay
readable from the site itself, but are never offered for autofill.

## Go further

- [Browser extension](browser-extension) — auto-fill and auto-save
  vault entries on the web
- [Shares](shares) — send an entry to a third party without sharing it permanently
