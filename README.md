> **⚠️ Pré-release — version 0.6.1**
>
> Ce repo de self-host est en **cours de test** et n'a pas encore été
> validé en production. L'API, le schéma de base de données et le flux
> d'installation peuvent encore évoluer sans préavis.
>
> À utiliser pour **évaluer le produit** ; pas encore recommandé pour
> stocker des secrets critiques.
>
> Pour la version stable hébergée : [physalis.cloud](https://physalis.cloud).
> Bugs / feedback bienvenus : [github.com/argo-web/physalis-vault/issues](https://github.com/argo-web/physalis-vault/issues).

---

# Physalis

Gestionnaire de secrets self-hosted (Next.js + Postgres + AES-256-GCM) pour
centraliser les variables d'environnement, clés SSH et credentials de plusieurs
projets, avec authentification GitHub OIDC pour les workflows de déploiement.

Multi-organisation, audit log, services & comptes chiffrés, docker-compose
servable par env, redeploy GitHub Actions intégré, backup chiffré GPG avec
warm-standby sur VPS secondaire.

# Physalis — Résumé

**Physalis** est un gestionnaire de secrets self-hosted conçu pour centraliser toutes les variables d'environnement d'une agence web sur ses propres serveurs, sans dépendre d'un service cloud tiers.

---

## Le problème qu'il résout

Dans une agence qui gère plusieurs projets sur plusieurs VPS, les variables d'environnement (mots de passe de bases de données, clés API, tokens) finissent éparpillées dans des fichiers `.env` sur chaque serveur, dans des GitHub Secrets, dans des notes personnelles. Changer une variable implique de se connecter manuellement sur chaque serveur. Quand un développeur quitte l'équipe, il est impossible de savoir à quoi il avait accès.

---

## Ce que fait Physalis

### Centralisation chiffrée

Toutes les variables sont stockées dans une base PostgreSQL, chiffrées en AES-256-GCM avant écriture. Même avec un accès direct à la base de données, les valeurs sont illisibles sans la clé de chiffrement qui ne vit que dans les variables d'environnement du serveur.

### Multi-organisation et contrôle d'accès

L'application supporte plusieurs organisations isolées, chacune avec ses propres projets et membres. Les droits sont granulaires à trois niveaux — organisation, projet, environnement — avec des rôles distincts (lecteur, éditeur, propriétaire). Invitations par email avec lien signé, révocation automatique des accès quand un membre quitte l'équipe.

### Deux façons de consommer les secrets

**Pour les humains** — une interface web sécurisée par mot de passe et optionnellement par double authentification TOTP. Les valeurs des secrets ne sont jamais affichées en masse : chaque révélation est une action explicite, unitaire, tracée dans l'audit log.

**Pour les machines** — authentification OIDC GitHub Actions. Au moment du déploiement, le workflow GitHub obtient un token signé par GitHub (sans aucun secret stocké dans GitHub Secrets) et le présente à Physalis. Le vault vérifie la signature cryptographiquement, contrôle que le repo, le workflow et la branche correspondent exactement à une règle autorisée, puis retourne en une seule requête l'ensemble du bundle de déploiement : variables d'environnement déchiffrées, clé SSH du serveur cible, chemin de déploiement, docker-compose, et credentials du registry Docker.

### Envoi d'emails par projet (Pink-Floyd)

Chaque projet peut être relié à **Pink-Floyd**, un serveur d'envoi d'emails auto-hébergé, pour envoyer ses emails depuis son propre domaine. L'organisation active le service une fois (compte partagé), puis chaque projet connecte son domaine, configure les DNS (SPF/DKIM/DMARC) et gère ses expéditeurs autorisés depuis l'interface — onglet **Email** avec sous-sections Détails, Envoi, Expéditeurs, Historique. La clé API est chiffrée au repos et injectée automatiquement dans le `.env` de chaque environnement au déploiement, avec **rotation automatique** optionnelle (blue/green). Physalis n'est jamais dans le chemin runtime d'envoi.

### Traçabilité complète

Chaque action — lecture d'un secret, modification, connexion, déploiement, invitation — est enregistrée dans un audit log persistant avec l'acteur, l'IP, et l'horodatage. Exportable en CSV, consultable par projet ou par organisation.

### Résilience

Un VPS secondaire reçoit chaque nuit une copie chiffrée de la base de données via un mécanisme pull-based — le serveur secondaire tire les données depuis le primaire, jamais l'inverse. Les backups sont chiffrés avec une clé GPG dont seul le secondaire possède la partie privée : un attaquant qui compromettrait le serveur principal ne pourrait pas déchiffrer les sauvegardes historiques. En cas de panne, le basculement prend moins de 20 minutes.

---

## Ce que ça change concrètement

| Avant | Après |
|---|---|
| Un fichier `.env` par projet par serveur | Une interface unique pour tous les secrets de l'agence |
| Clés SSH et tokens dans GitHub Secrets | Aucune clé ni token dans GitHub |
| Aucune traçabilité | Chaque accès tracé avec acteur, IP et horodatage |
| Impossible de savoir qui a accès à quoi | Révocation immédiate en cas de départ d'un collaborateur |
| Déploiements manuels ou semi-automatisés | Déploiements entièrement automatisés sans intervention humaine |


📖 **Documentation technique complète** : [docs/physalis.md](docs/physalis.md)
🔒 **Audit sécurité** : [docs/security.md](docs/security.md)
🗺️ **Roadmap** : [docs/todo.md](docs/todo.md)
💾 **Backup & Failover** : [docs/todo-backup-failover.md](docs/todo-backup-failover.md) · [docs/doc-install-backup.md](docs/doc-install-backup.md)

---

## Quickstart

### 1. Local — stack complète (Docker)

```bash
cp .env.example .env
# Renseigner ENCRYPTION_KEY, AUTH_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
docker compose up -d --build
```

→ http://localhost:3001 (3000 réservé sur certains hôtes ; ajustable dans
[docker-compose.yml](docker-compose.yml)).

Le premier démarrage applique les migrations Prisma et crée l'admin défini par
`ADMIN_EMAIL` / `ADMIN_PASSWORD` ([scripts/bootstrap-admin.mjs](scripts/bootstrap-admin.mjs)).

### 2. Local — dev natif (hot-reload)

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres seul (port 5434)
npm install
npx prisma migrate dev
npm run bootstrap-admin
npm run dev                                       # http://localhost:3000
```

### 3. Production (VPS derrière Nginx Proxy Manager)

Déploiement automatique sur push `main` via [.github/workflows/deploy.yml](.github/workflows/deploy.yml) :
test → build/push GHCR → SSH deploy + health check.

Voir [docs/physalis.md §10.3](docs/physalis.md) pour le setup VPS initial
(création du dossier, génération de la clé SSH dédiée au workflow, contenu de
`.env`, secrets GitHub à créer).

---

## Utilisation côté projet client

Trois modes d'accès, du plus moderne au plus legacy :

### Mode 1 — OIDC (recommandé, post-Megalodon)

Le runner GitHub Actions s'authentifie avec un JWT OIDC signé par GitHub. Le
vault valide le claim contre une `Policy` stricte `(repo, workflow, branch)
→ (project, env)` et retourne un bundle complet.

| Endpoint | Auth | Réponse |
|---|---|---|
| `POST /api/deploy` | Bearer JWT OIDC GitHub | `{ serverIp, serverUser, sshKey, deployPath, secrets, dockerCompose, registry }` |

Aucun secret GitHub n'est consommé. Clé SSH et registry creds vivent chiffrés
dans le vault. Template prêt à coller : [docs/deploy-oidc.yml](docs/deploy-oidc.yml)
(deploy avec rebuild) ou [docs/redeploy-oidc.yml](docs/redeploy-oidc.yml)
(redeploy sans rebuild). Migration détaillée en
[docs/physalis.md §10.6](docs/physalis.md).

### Mode 2 — Bearer machine token (fallback hors GitHub)

Pour les contextes qui ne peuvent pas obtenir un OIDC GitHub (cron sur VPS,
autre CI, scripts manuels) :

| Endpoint | Auth | Réponse |
|---|---|---|
| `GET /api/secrets/[slug]/[env]` | `Bearer sv_<hex>` | `{ secrets: { KEY: value, … } }` |
| `GET /api/compose/[slug]/[env]` | `Bearer sv_<hex>` | contenu brut du `docker-compose.yml` configuré |

Token scopé à un `(projet, env)` ; toute autre combinaison renvoie 403. Géré
via la page projet → onglet env → « Machine tokens ».

### Mode 3 — script local

[scripts/inject-secrets.sh](scripts/inject-secrets.sh) — wrapper bash autour
du Bearer endpoint, utile si la même logique est appelée depuis plusieurs
scripts sur un même VPS.

---

## Génération des secrets utiles à l'init

```bash
openssl rand -hex 32        # ENCRYPTION_KEY
openssl rand -base64 32     # AUTH_SECRET / NEXTAUTH_SECRET
```

> ⚠️ `ENCRYPTION_KEY` : **jamais en DB ni en code**, uniquement env du
> conteneur. Une perte définitive = secrets non-récupérables même avec
> dump DB. À mettre dans un password manager partagé (escrow).

---

## Backup & Failover

Backup quotidien chiffré GPG, **pull-based** (le secondaire tire depuis le
primaire), rotation 7 daily + 12 monthly, restore-test mensuel automatisé.
Monitoring externe via healthchecks.io.

```
PRIMARY (vault.argoweb.fr)  ←── ssh forced-cmd ──  SECONDARY (vault-backup.argoweb.fr)
                              dump | gzip | gpg
                                                   /srv/backups/secretvault/<date>.db.gz.gpg
```

Scripts ready-to-deploy : [scripts/backup/](scripts/backup/) avec
[README d'install](scripts/backup/README.md).

RPO 24h, RTO 5-20 min (restore DB) + propagation DNS. Failover manuel
(DNS-flip chez le registrar) — runbook complet en
[docs/todo-backup-failover.md](docs/todo-backup-failover.md).

---

## Stack

Next.js 15 (App Router) · TypeScript · Prisma 6 + PostgreSQL 16 ·
NextAuth v5 (Credentials, JWT) · bcryptjs (salt 12) · AES-256-GCM ·
jose 6 (OIDC JWKS) · 2FA TOTP (otplib) · Tailwind 3 · Mailgun · Docker
multi-stage (node:22-alpine) · intégration Pink-Floyd (emails par projet).

## Tests

121 unit tests (~8s) + 70+ integration tests (~35s, stack docker requise).

```bash
npm test               # unit (crypto, token, rate-limit, validation, totp,
                       #       oidc, categories, plugin-token)
npm run test:integ     # integ (bearer-auth, RBAC, DB encryption, headers,
                       #        rate-limit, 2FA, servers, policies, plugin)
```

Voir [docs/physalis.md §11](docs/physalis.md) pour le détail.
