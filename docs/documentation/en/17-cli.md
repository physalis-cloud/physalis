---
title: CLI and the end of .env files
order: 17
icon: RiTerminalBoxLine
summary: Inject your secrets into your development commands, with no .env file on disk.
---

# CLI and the end of .env files

The `physalis` CLI replaces the `.env` files in your projects. Instead of
reading a plaintext file, your application receives its secrets **at launch**,
in its process environment variables. Nothing is written to disk.

```bash
physalis run -- npm run dev
```

## Installation

```bash
npm install -g physalis-cli
```

Node.js 18 or later. The CLI has no dependencies.

## Signing in: one session for all your projects

```bash
physalis login --url https://<your-slug>.physalis.cloud
```

1. The CLI shows a **code** (for example `BCDF-GHJK`) and opens your browser
   on the **Connect a terminal** page.
2. Check that the code shown on the page is **the same** as the one in your
   terminal, then click **Approve**.
3. The CLI receives a session valid for **12 hours**, giving access to **all
   the projects** you can access in the interface, with the same rights.

> ⚠️ Only approve a sign-in if you just ran `physalis login` yourself. Someone
> sending you an approval link is trying to get into your account.

On a machine without a browser (server, SSH), add `--no-browser` and open the
printed address from another device.

Your sessions are listed under **Account → Security → CLI sessions**, with
the device, IP address and expiry date. You can revoke a session there at any
time. `physalis logout` revokes the current terminal's session.

## Linking a project: `.physalis.json`

At the root of each project, a file **with no secrets at all**, which you can
commit:

```json
{
  "url": "https://<your-slug>.physalis.cloud",
  "project": "my-project",
  "env": "development"
}
```

The CLI looks for it in the current folder **and then in its parents**, the
way git looks for `.git`: `physalis run` works from any sub-folder of the
project.

## Running your commands

Replace your scripts with their `physalis run` version:

```json
{
  "scripts": {
    "dev": "physalis run -- next dev",
    "db:migrate": "physalis run -- prisma migrate dev",
    "test": "physalis run -- vitest run"
  }
}
```

With Docker Compose, declare the variables without a value so they come from
the shell:

```yaml
services:
  app:
    environment:
      - DATABASE_URL
      - API_KEY
```

```bash
physalis run -- docker compose up
```

If fetching the secrets fails (expired session, missing rights, network),
**the command is not started**: an application never starts with missing
secrets.

## Migrating a project that uses a `.env`

1. Create a **development** environment in the project, with development
   values only. Don't put production secrets on a development machine.
2. Import your `.env` from the environment page (**Import**).
3. Replace the file with a `.env.example` containing **only the names** of the
   variables, and delete the `.env`.
4. If a `.env` was ever committed, deleting it is not enough: look for it in
   the history (`git log --all -- .env`) and **rotate** the secrets it
   contained.

> ⚠️ Next.js and other frameworks still load `.env.local` and neighbouring
> `.env*` files if they exist, and their values then silently take precedence.
> Delete them all.

> ⚠️ `physalis export > .env` recreates exactly the plaintext file that
> `physalis run` avoids. Keep `export` for the cases that really need it.

## Working offline: `physalis pull`

`physalis run` needs the network. To code without a connection, `physalis pull`
writes the project's `.env`. It is the **only** command that writes secrets to
disk in plaintext, so it is guarded:

- **development environments only** (`development`, `dev`, `local`, `test`,
  `testing`, `sandbox`): production and `staging` are refused, by the CLI and
  by Physalis;
- **the file must be ignored by git**: otherwise the CLI refuses to write it,
  so it cannot end up committed;
- it is written readable by you only (`0600`), and every `pull` shows up in the
  audit log as an **export**.

```bash
physalis pull                 # .env at the project root
physalis pull --output .env.local
```

Delete the file as soon as you no longer need it.

## Working with an AI agent (Claude Code)

A coding agent has **its own session**, separate from yours.

```bash
physalis ai-rules            # deny rules to paste into .claude/settings.json
physalis login --ai          # run it from YOUR terminal
```

In the browser, the request is marked **AI agent**. You tick the projects and
environments the agent may read:

- **development environments only**: production and `staging` are not even
  offered;
- you can only open what you can read yourself, and your rights still apply:
  if you lose access to a project, so does the agent;
- the agent reads **read-only** and can **never** download a `.env`;
- every read is traced as coming from the agent, and the session (12 hours)
  can be revoked on its own from **Account → Security → CLI sessions**, which
  shows what it can read.

In the agent's shell (Claude Code sets `CLAUDECODE=1`), the CLI **only uses the
AI session**, never yours.

For the agent, `physalis run` **masks** the values in the output by default:
an accidental `printenv` only shows `<masqué par Physalis>`. You can enable the
same masking for yourself with `physalis run --mask` (the command then loses
its colours and interactive prompts).

> ⚠️ An agent that **transforms** a value before displaying it (base64,
> splitting) would still see it: no injection tool can prevent that. Masking
> and the deny rules prevent accidents; what really bounds the agent is its
> scope, chosen by you and limited to development.

## SSH agent: connect without a key on disk

Generate a key in **Vault → SSH keys** (or import yours, then delete it from
`~/.ssh`), copy its public key to your servers or GitHub, then:

```bash
physalis ssh-agent start
```

and, in `~/.ssh/config`, for the hosts concerned:

```
Host github.com prod-*
  IdentityAgent ~/.physalis/agent.sock
```

`ssh`, `git push` and commit signing then go through Physalis: **the private
key never leaves Physalis**, it does the signing, and every signature is
logged (key, device, target SSH account). Revoking your session cuts the
agent off at the next connection.

> ⚠️ Without a connection to Physalis, the agent cannot sign. Always keep a
> backup key outside Physalis for your critical servers.

## Several organisations, several instances

Sessions are stored **per instance**. If you work for two organisations on two
Physalis instances, sign in once to each: the `url` field of `.physalis.json`
picks the right session.

## In CI

In continuous integration, use a **machine token** (`sv_…`), created in the
interface and limited to one project and one environment, passed through the
`PHYSALIS_TOKEN` variable. It takes precedence over the stored session.

```bash
PHYSALIS_TOKEN=sv_… physalis run -p my-project -e production -- npm run build
```

A machine token **does not expire**: it stays valid until it is revoked in the
interface.

## What the CLI protects, and what it doesn't

- ✅ **No more stray `.env` file**: nothing to steal from a repository, a
  machine backup or a lost laptop.
- ✅ **Revocable, traced access**: every read shows up in the audit log,
  attributed to your account and the CLI session; revoking the session cuts
  access on the next request.
- ✅ **Same rights as in the interface**, re-checked on every read: a project
  hidden from you, or an organisation you leave, can no longer be read.
- ⚠️ **Injected secrets remain readable by your user** while the command runs
  (as with any injection tool): the CLI protects against forgotten files, not
  against active malware on your machine.
- ✅ **Your session is stored in the system keychain** (macOS; Linux with
  GNOME Keyring or KWallet): an AI agent reading `~/.physalis/config.json` will
  not find your access there. Without a keychain (server, WSL, container,
  Windows for now), it stays in that file, readable by you only (`0600`), and
  `physalis login` tells you so.
- ⚠️ The keychain protects against reading a file, not against active
  malware: on Linux, a program run by your user can query it. The session's
  short lifetime and revocation limit the impact of theft.
