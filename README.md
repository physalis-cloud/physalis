# Physalis

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

**Français** · [English](README.en.md) · [Español](README.es.md)

> **Version 1.3.3** · Version hébergée et gérée : [physalis.cloud](https://physalis.cloud) · Bugs et retours : [ouvrir une issue](https://github.com/physalis-cloud/physalis/issues)

---

Gestionnaire de secrets self-hosted (Next.js + Postgres + AES-256-GCM) pour
centraliser les variables d'environnement, clés SSH et credentials de plusieurs
projets, avec authentification OIDC (GitHub, GitLab, Bitbucket) pour les
workflows de déploiement.

Multi-organisation, audit log, services & comptes chiffrés, docker-compose
servable par env, redeploy CI intégré, échange de clés hybride post-quantique
(ECDH P-256 + ML-KEM-768) pour les demandes de secrets externes.

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

**Pour les machines** — authentification OIDC GitHub Actions. Au moment du déploiement, le workflow obtient un token signé par le fournisseur CI (sans aucun secret stocké dans GitHub Secrets) et le présente à Physalis. Le vault vérifie la signature cryptographiquement, contrôle que le repo, le workflow et la branche correspondent exactement à une règle autorisée, puis retourne en une seule requête l'ensemble du bundle de déploiement : variables d'environnement déchiffrées, clé SSH du serveur cible, chemin de déploiement, docker-compose, et credentials du registry Docker.

### Cryptographie résistante au post-quantique

Les secrets sont chiffrés au repos en **AES-256-GCM** — un chiffrement symétrique déjà résistant aux ordinateurs quantiques (l'algorithme de Grover ne fait que ramener une clé de 256 bits à une sécurité effective de 128 bits).

L'échange de clés des **demandes de secrets externes** — le seul endroit où de la cryptographie asymétrique protège une valeur, et donc le seul point réellement exposé à un futur ordinateur quantique — est **hybride** : ECDH P-256 **et** ML-KEM-768 (FIPS 203), combinés par HKDF-SHA256 avec binding du transcript. Casser la clé dérivée exige de casser les deux. Les demandes créées avant cette bascule (ECDH seul) restent déchiffrables. Implémentation : [lib/hybrid-kem.ts](lib/hybrid-kem.ts) et [lib/pqc.ts](lib/pqc.ts).

### Traçabilité complète

Chaque action — lecture d'un secret, modification, connexion, déploiement, invitation — est enregistrée dans un audit log persistant avec l'acteur, l'IP, et l'horodatage. Exportable en CSV, consultable par projet ou par organisation.

---

## Ce que ça change concrètement

| Avant | Après |
|---|---|
| Un fichier `.env` par projet par serveur | Une interface unique pour tous les secrets de l'agence |
| Clés SSH et tokens dans GitHub Secrets | Aucune clé ni token dans GitHub |
| Aucune traçabilité | Chaque accès tracé avec acteur, IP et horodatage |
| Impossible de savoir qui a accès à quoi | Révocation immédiate en cas de départ d'un collaborateur |
| Déploiements manuels ou semi-automatisés | Déploiements entièrement automatisés sans intervention humaine |


📖 **Documentation technique** : [docs/physalis.md](docs/physalis.md)
📚 **Documentation utilisateur** : [docs/documentation/fr/](docs/documentation/fr/) (aussi en `en` / `es`)
🔒 **Modèle de sécurité** : [docs/security.md](docs/security.md)

---

## Quickstart

### 1. Local — stack complète (Docker)

```bash
cp .env.example .env
# Renseigner les valeurs vides : ENCRYPTION_KEY, AUTH_SECRET, NEXTAUTH_SECRET,
#   DB_PASSWORD, ADMIN_PASSWORD (ADMIN_EMAIL a un défaut).
#   ENCRYPTION_KEY = openssl rand -hex 32 ; les secrets = openssl rand -base64 32.
docker compose up -d --build
```

→ http://localhost:3001 (port par défaut ; 3000 souvent déjà pris — ajustable
via `PORT` dans `.env`, en alignant `NEXTAUTH_URL` sur le même port).

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

### 3. Production (VPS derrière un reverse proxy)

Workflow type : test → build/push registry → SSH deploy + health check. Modèle
prêt à coller : [docs/deploy.modele.yml](docs/deploy.modele.yml).

Voir [docs/physalis.md §9](docs/physalis.md) pour l'installation complète
(dossier de déploiement, clé SSH dédiée au workflow, contenu du `.env`, reverse
proxy et TLS).

---

## Utilisation côté projet client

Trois modes d'accès, du plus moderne au plus legacy :

### Mode 1 — OIDC (recommandé)

Le runner CI s'authentifie avec un JWT OIDC signé par le fournisseur (GitHub
Actions, GitLab CI, Bitbucket Pipelines). Le vault valide le claim contre une
`Policy` stricte `(repo, workflow, branch) → (project, env)` et retourne un
bundle complet.

| Endpoint | Auth | Réponse |
|---|---|---|
| `POST /api/deploy` | Bearer JWT OIDC | `{ serverIp, serverUser, sshKey, deployPath, secrets, dockerCompose, registry }` |

Aucun secret CI n'est consommé. Clé SSH et registry creds vivent chiffrés
dans le vault. Templates prêts à coller :
[docs/deploy.modele.yml](docs/deploy.modele.yml) (deploy avec rebuild),
[docs/redeploy.modele.yml](docs/redeploy.modele.yml) (redeploy sans rebuild),
[docs/deploy.gitlab-ci.modele.yml](docs/deploy.gitlab-ci.modele.yml) et
[docs/deploy.bitbucket-pipelines.modele.yml](docs/deploy.bitbucket-pipelines.modele.yml).

### Mode 2 — Bearer machine token (fallback hors CI OIDC)

Pour les contextes qui ne peuvent pas obtenir un token OIDC (cron sur VPS,
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

## Sauvegarder votre instance

**Ce dépôt ne fournit ni backup, ni réplication, ni failover** — aucun script,
aucun cron, aucun mécanisme de bascule. La sauvegarde de votre instance est
votre infrastructure, donc votre responsabilité. Au minimum :

- un **dump régulier** de la base PostgreSQL (`pg_dump`), chiffré et stocké
  hors du serveur qui l'a produit ;
- une **copie de `ENCRYPTION_KEY`** en escrow (cf. l'avertissement ci-dessus) —
  un dump sans la clé est irrécupérable, et la clé sans dump ne vaut rien ;
- un **test de restauration** périodique, sinon vous n'avez pas une sauvegarde,
  vous avez des fichiers.

L'offre hébergée [physalis.cloud](https://physalis.cloud) opère sa propre
infrastructure de résilience (réplication et sauvegardes chiffrées gérées) ;
rien de tout cela n'est inclus ni orchestré par ce dépôt.

---

## Stack

Next.js 15 (App Router) · TypeScript · Prisma 6 + PostgreSQL 16 ·
NextAuth v5 (Credentials, JWT) · bcryptjs (salt 12) · AES-256-GCM ·
ECDH P-256 + ML-KEM-768 hybride (`@noble/post-quantum`) ·
jose 6 (OIDC JWKS) · 2FA TOTP (otplib) · Tailwind 3 · Mailgun (emails
transactionnels) · Docker multi-stage (node:22-alpine).

## Tests

```bash
npm test               # unit (crypto, token, rate-limit, validation, totp,
                       #       oidc, categories, plugin-token)
npm run test:integ     # integ (bearer-auth, RBAC, DB encryption, headers,
                       #        rate-limit, 2FA, servers, policies, plugin)
```

Voir [docs/physalis.md §12](docs/physalis.md) pour le détail.
