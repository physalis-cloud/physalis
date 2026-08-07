# Physalis — Documentation technique (self-host)

> Ce document décrit l'architecture de l'édition **self-host** de Physalis :
> l'application que contient ce dépôt, telle qu'elle tourne sur votre
> infrastructure. Il ne décrit pas l'offre hébergée
> [physalis.cloud](https://physalis.cloud), dont le plan de contrôle
> (multi-tenant, facturation, supervision du parc) ne fait pas partie de ce
> dépôt.

---

## 1. Vue d'ensemble

Gestionnaire de secrets auto-hébergé, analogue à un Doppler / HashiCorp Vault
simplifié, organisé autour des **organisations**, des **projets** et de leurs
**environnements**.

- Centralise les variables d'environnement de tous vos projets dans une base
  PostgreSQL, chiffrées en AES-256-GCM.
- **Multi-organisation** : chaque utilisateur appartient à une ou plusieurs
  organisations ; projets, secrets, serveurs et tokens sont scopés à une
  organisation. Invitations par email avec lien signé (TTL 48 h).
- **Une seule base, un seul schéma.** L'instance sert une organisation racine
  et ses membres — il n'y a pas de notion de tenant, pas de sous-domaines par
  client, pas de plan ni de quota.
- Deux modes d'accès :
  - **Web (humains)** — NextAuth (Credentials), 2FA TOTP optionnelle, switcher
    d'organisation dans le header.
  - **Machine (VPS / CI)** — token Bearer ou OIDC, endpoint unique qui retourne
    tous les secrets d'un environnement autorisé.
- Extension navigateur Chrome + Firefox (dépôt séparé) pour l'auto-fill et
  l'auto-save des credentials.
- Déploiement Docker Compose derrière le reverse proxy de votre choix.

Chaque secret est chiffré au moment de l'écriture, côté serveur. La
`ENCRYPTION_KEY` ne quitte jamais les variables d'environnement du conteneur.
Les valeurs ne transitent en clair qu'au moment d'une révélation explicite
(UI, une clé à la fois) ou d'une récupération machine authentifiée.

---

## 2. Stack

| Couche | Technologie | Version |
|---|---|---|
| Frontend / Backend | Next.js App Router | 15.5 |
| Langage | TypeScript | 5 |
| ORM | Prisma | 6.19 |
| Base de données | PostgreSQL | 16 (alpine) |
| Auth | NextAuth.js (Auth.js) | 5 |
| Hash mots de passe | bcryptjs (salt 12) | 3 |
| Chiffrement symétrique | Node `crypto` AES-256-GCM | natif |
| Chiffrement post-quantique | `@noble/post-quantum` (ML-KEM-768) | 0.6 |
| UI | Tailwind CSS | 3.4 |
| Runtime conteneur | node:22-alpine | — |
| Reverse proxy | nginx / Traefik / Caddy | externe |

---

## 3. Modèle de données

Schéma unique, source de vérité : [prisma/schema.prisma](../prisma/schema.prisma).
Un seul client Prisma est exposé depuis [lib/prisma.ts](../lib/prisma.ts).

### 3.1 Identité et organisations

| Modèle | Rôle | Champs clés |
|---|---|---|
| `User` | Compte humain | `email` (unique), `password` (bcrypt), `role` (`ADMIN` \| `MEMBER`), 2FA optionnelle (`twoFactorEnabled` + secret chiffré AES-256-GCM + `backupCodes` bcrypt) |
| `UserSocialIdentity` | Compte externe lié (login social) | `(provider, providerAccountId)` unique, `userId` |
| `Organization` | Espace isolé | `slug` (unique), `name`, relations members / projects / invitations / secrets / servers |
| `OrgMember` | Membership d'un user dans une org | `(userId, organizationId)` unique ; `role` (`OWNER` \| `ADMIN` \| `ADMIN_DEV` \| `DEV` \| `MEMBER`) |
| `Invitation` | Invitation par email (TTL 48 h) | `tokenHash` (SHA-256, unique), `email`, `role`, `expiresAt`, `acceptedAt` |
| `OrgSecret` | Secret global d'organisation | `(organizationId, key)` unique ; chiffré comme `Secret` |
| `OrgSecretVersion` | Historique des valeurs d'un `OrgSecret` | idem `SecretVersion` |

### 3.2 Projets, environnements, secrets

| Modèle | Rôle | Champs clés |
|---|---|---|
| `Project` | Conteneur applicatif | `slug` (unique, éditable), `organizationId`, `githubRepo`, `githubWorkflow` |
| `ProjectGroup` | Regroupement de projets dans l'UI | `name`, `organizationId`, ordre |
| `ProjectMember` | Membership projet | `(userId, projectId)` unique ; `role` (`OWNER` \| `EDITOR` \| `VIEWER`), `hidden` |
| `Environment` | Bucket dans un projet (production, staging…) | `(projectId, name)` unique ; `url?`, `dockerCompose?`, `serverId?`, `deployPath?` |
| `Secret` | Paire clé/valeur chiffrée | `(environmentId, key)` unique ; `encryptedValue`/`iv`/`tag` ; `category?`, `tags[]` ; champs de rotation (cf. §11) |
| `SecretVersion` | Historique des valeurs d'un `Secret` | `(secretId, version)` unique ; rétention 50 versions |
| `Service` | Service tiers du projet (Stripe, Firebase…) | `name`, `url?`, blob chiffré `{user, password}` |
| `AppAccount` | Compte de test applicatif | `name`, blob chiffré `{user, password}` |
| `ProjectDoc` | Documentation du projet importée depuis le dépôt | `projectId`, `kind`, contenu |
| `Server` | VPS de l'organisation, cible des déploiements | `(organizationId, name)` unique ; `ip`, `sshUser`, clé SSH privée chiffrée — **jamais relisible après création** |
| `Policy` | Liaison stricte `(repo, workflow, branch) → (project, environment)` | unique + index sur le hot path ; aucune wildcard |
| `CiConnection` / `CiConnectionSecret` | Connexion CI d'organisation (GitHub / GitLab / Bitbucket) | credentials chiffrés, utilisés pour le redeploy et la lecture des docs projet |
| `EnvironmentSyncTarget` | Cible de synchronisation sortante des secrets | plateforme + credentials chiffrés (cf. §10) |

### 3.3 Coffres

| Modèle | Rôle |
|---|---|
| `VaultEntry` | Entrée du coffre **personnel** (privé par utilisateur) : `name`, `url?`, `username?`, mot de passe chiffré, secret TOTP chiffré, `tags[]`, `favorite` |
| `VaultCollection` | Collection du coffre personnel |
| `TeamVaultCollection` | Coffre d'équipe, rattaché à **exactement un** parmi `organizationId` / `projectId` (contrainte CHECK en base) |
| `TeamVaultEntry` | Entrée d'un coffre d'équipe |
| `TeamVaultMember` | Membre explicite d'une collection d'organisation ; `role` (`OWNER` \| `EDITOR` \| `VIEWER`). Les collections **projet** héritent du RBAC projet |

### 3.4 Tokens et partage

| Modèle | Rôle | Préfixe |
|---|---|---|
| `MachineToken` | Token Bearer scopé à `(projet, environnement)` | `sv_` |
| `UserToken` | Token Bearer scopé à un utilisateur (lecture des projets dont il est membre) | `sv_user_` |
| `OrgToken` | Token Bearer scopé à une organisation, avec liste de projets et de scopes autorisés | `sv_org_` |
| `PluginToken` | Session 4 h de l'extension navigateur | `sv_plugin_` |
| `TokenIndex` | Index des hash de tokens par famille (`TokenKind`), résolution en un lookup | — |
| `OneTimeShare` | Partage de secret à usage unique, chiffré, avec TTL | — |
| `SecretRequest` | Demande de secret à un tiers via lien chiffré (cf. §5.2) | — |
| `PasswordResetToken` | Reset de mot de passe, single-use, TTL 1 h | `sv_reset_` |
| `OidcPolicy` | Index des policies OIDC pour le hot path de `/api/deploy` | — |

Tous les tokens sont stockés **hashés en SHA-256** ; la valeur brute n'est
affichée qu'une seule fois, à la création.

### 3.5 Audit

`AccessLog` — journal append-only. Chaque ligne porte l'action (enum
`AccessAction`), l'acteur (utilisateur **ou** token, dénormalisé pour survivre
à la suppression), les FK org / projet / environnement en `SetNull`, la clé de
secret concernée, l'IP, le user-agent et un blob `metadata` JSON. Exportable en
CSV depuis l'UI.

### 3.6 Rôles

Trois niveaux : utilisateur global → organisation → projet.

| Rôle | Périmètre |
|---|---|
| `User.role = ADMIN` | Administrateur de l'instance. `OrgRole.OWNER` implicite sur toutes les organisations |
| `OrgRole.OWNER` | Tout faire dans l'org, y compris la supprimer. `ProjectRole.OWNER` implicite |
| `OrgRole.ADMIN` | Gérer les membres (sauf attribuer OWNER), créer/supprimer des projets. `ProjectRole.OWNER` implicite |
| `OrgRole.ADMIN_DEV` | Droits DEV + CRUD des serveurs et des secrets d'organisation. Ne gère pas les membres |
| `OrgRole.DEV` | `ProjectRole.EDITOR` implicite sur tous les projets de l'org, sans ligne `ProjectMember` |
| `OrgRole.MEMBER` | Voit l'org, crée des projets ; accès à un projet **uniquement** s'il en est `ProjectMember` explicite |
| `ProjectRole.OWNER` | Gérer le projet |
| `ProjectRole.EDITOR` | CRUD des secrets, gestion des machine tokens |
| `ProjectRole.VIEWER` | Liste des clés + révélation une à une |

**Barrière `ProjectMember.hidden`** : `hidden = true` n'est pas un confort
d'affichage mais une **barrière d'accès** — la ligne existe (donc le rôle est
préservé) mais l'accès est refusé en 403. Un OrgADMIN / OWNER ignore `hidden` ;
pour un DEV ou un MEMBER, une ligne masquée bloque sans retomber sur l'EDITOR
implicite du DEV.

> **Invariant** : tout calcul d'accès projet doit dériver du prédicat central
> `accessibleProjectsWhere(orgId, userId, orgRole)` de [lib/api.ts](../lib/api.ts),
> ou passer par `requireProjectMember`. Ne jamais re-dériver l'autorisation à la
> main depuis `ProjectMember` sans lire `hidden`.

### 3.7 Tables présentes mais inutilisées

Le schéma contient quelques modèles rattachés à des fonctionnalités de l'offre
hébergée qui **ne sont pas livrées** dans cette édition : `ClientBackupConfig`,
`ProjectBackupConfig`, `ProjectBackupDatabase`, `ProjectBackupEntry`,
`ProjectBackupRestore`, `ClientEmailConfig`, `ProjectEmailConfig`, `Api`,
`ApiKey`, `ApiLog`. Les tables sont créées par les migrations mais aucun code
de cette édition ne les alimente. Vous pouvez les ignorer.

---

## 4. API REST

Les routes web (session par cookie) passent par les helpers `requireUser` /
`requireOrgMember(slug, role)` / `requireProjectMember(slug, role)` /
`requireEnvironment(slug, env, role)` de [lib/api.ts](../lib/api.ts). Les routes
machine valident un header `Authorization: Bearer …` via
[lib/auth-token.ts](../lib/auth-token.ts). Le gate de rôle exact de chaque route
est lisible dans son handler.

### 4.1 Consommation machine

| Méthode | Route | Auth | Réponse |
|---|---|---|---|
| POST | `/api/deploy` | JWT OIDC (GitHub Actions, GitLab CI, Bitbucket Pipelines) | Bundle complet : `{ serverIp, serverUser, sshKey, deployPath, secrets, dockerCompose, registry }` |
| GET | `/api/secrets/[slug]/[env]` | `Bearer sv_…` | `{ secrets: { KEY: value, … } }` |
| GET | `/api/compose/[slug]/[env]` | `Bearer sv_…` | Contenu brut du `docker-compose.yml` configuré |
| GET | `/api/health` | — | Sonde de santé |

`/api/deploy` valide la signature du JWT contre le JWKS du fournisseur, puis
résout `(repo, workflow, branch)` contre une `Policy` stricte. Aucune wildcard :
une combinaison non déclarée est refusée. `OIDC_AUDIENCE` doit correspondre à
l'audience demandée côté runner.

### 4.2 Organisations

`/api/orgs`, `/api/orgs/[slug]`, `/api/orgs/[slug]/audit`,
`/api/orgs/[slug]/members` (+ `/[userId]`, `/[userId]/project-access`,
`/candidates`), `/api/orgs/[slug]/invitations/[id]` (+ `/resend`),
`/api/orgs/[slug]/projects`, `/api/orgs/[slug]/servers` (+ `/[id]`),
`/api/orgs/[slug]/secrets` (+ `/[key]`, `/versions`, `/versions/[version]`,
`/rollback`), `/api/orgs/[slug]/org-tokens` (+ `/[id]`, `/regenerate`),
`/api/orgs/[slug]/ci-connections` (+ `/[id]`, `/secret/[kind]`).

### 4.3 Projets et secrets

`/api/projects`, `/api/projects/[slug]`, `/api/projects/groups` (+ `/[id]`),
`/api/projects/reorder`, `/api/projects/[slug]/environments` (+ `/[name]`),
`/api/projects/[slug]/members` (+ `/[userId]`), `/api/projects/[slug]/policies`
(+ `/[id]`), `/api/projects/[slug]/audit`, `/api/projects/[slug]/redeploy`,
`/api/projects/[slug]/docs` (+ `/refresh`), `/api/projects/[slug]/services`
(+ `/[id]`, `/rotation`), `/api/projects/[slug]/accounts` (+ `/[id]`,
`/rotation`, `/rotation/force`), `/api/projects/[slug]/rotation/pause`.

Secrets d'environnement : `/api/projects/[slug]/[env]/secrets` (+ `/[key]`,
`/versions`, `/versions/[version]`, `/rollback`), `/export`, `/import`,
`/db-detect`.

Synchronisation sortante : `/api/projects/[slug]/[env]/sync-target` (+ `/[id]`,
`/resync`, `/remote-projects`).

### 4.4 Coffres

Coffre personnel : `/api/vault/entries` (+ `/[id]`, `/move`),
`/api/vault/collections` (+ `/[id]`), `/api/vault/import`,
`/api/vault/destinations`.

Coffres d'équipe, côté organisation : `/api/vault/org/[orgSlug]/collections`
(+ `/[slug]`, `/entries`, `/entries/[id]`, `/entries/[id]/rotation`, `/import`,
`/members`, `/members/[userId]`). Côté projet :
`/api/vault/project/[projectSlug]/collections` (+ `/[slug]`, `/entries`,
`/entries/[id]`, `/entries/[id]/rotation`, `/import`).

### 4.5 Compte, tokens, partage

`/api/me/2fa` (+ `/setup`, `/verify`), `/api/me/current-org`, `/api/me/orgs`,
`/api/me/invitations` (+ `/[id]`, `/accept`), `/api/me/shares` (+ `/[id]`,
`/send`), `/api/me/export`, `/api/me/delete` (+ `/cancel`, `/now`).

`/api/tokens` (+ `/[id]`) — machine tokens. `/api/user-tokens` (+ `/[id]`).
`/api/share` (+ `/[token]`) — partage à usage unique.

Demandes de secret : `/api/secret-requests` (+ `/[id]`, `/reveal`, `/import`)
côté demandeur, `/api/public/secret-requests/[token]/public` et `/submit` côté
tiers (non authentifié, protégé par le token du lien).

### 4.6 Extension navigateur

`/api/plugin/auth`, `/api/plugin/issue`, `/api/plugin/match`,
`/api/plugin/vault`, `/api/plugin/tokens` (+ `/[id]`).

Tous ces endpoints répondent **403** si `PLUGIN_ALLOWED_ORIGIN` n'est pas
configuré (cf. §9.2).

### 4.7 Divers

`/api/auth/[...nextauth]`, `/api/auth/register`, `/api/invitations/[token]`
(+ `/register-and-accept`), `/api/signup/check-slug`, `/api/i18n/resolve-slug`,
`/api/integrations/{credentials,projects,tags}`, `/api/support/tickets`
(+ `/[ref]`, `/[ref]/messages`, actif seulement si `SUPPORT_SERVICE_URL` et
`SUPPORT_SERVICE_TOKEN` sont renseignés).

---

## 5. Chiffrement

### 5.1 Secrets au repos — AES-256-GCM

[lib/crypto.ts](../lib/crypto.ts). Chaque valeur sensible est chiffrée en
AES-256-GCM sous `ENCRYPTION_KEY` (32 octets, fournie en hexadécimal) et
persistée en trois colonnes : `encryptedValue`, `iv`, `tag`. Un IV aléatoire de
12 octets est tiré à chaque écriture. Le tag GCM authentifie le ciphertext :
une valeur altérée en base échoue au déchiffrement au lieu de rendre des
octets arbitraires.

Sont chiffrés de cette façon : les secrets d'environnement et d'organisation,
les clés SSH des serveurs, les blobs `{user, password}` des services et comptes
applicatifs, les secrets TOTP, les entrées de coffre, les credentials des
connexions CI et des cibles de synchronisation.

AES-256 est un chiffrement **symétrique** : il est déjà considéré comme
résistant aux ordinateurs quantiques, l'algorithme de Grover ne ramenant une
clé de 256 bits qu'à une sécurité effective de 128 bits.

> **Invariant de revue** : ne jamais persister un triplet
> `{encryptedValue, iv, tag}` que l'on n'a pas produit soi-même via `encrypt()`
> dans la même requête — sauf pour snapshoter un secret vers sa **propre**
> version. Toute copie vers une autre ligne située derrière une frontière
> d'accès différente doit faire decrypt → encrypt (nouvel IV), jamais un
> transplant d'octets chiffrés. Un test de non-régression garde cet invariant.

### 5.2 Demandes de secret — hybride post-quantique

Une **demande de secret** permet de réclamer une valeur à un tiers qui n'a pas
de compte : il reçoit un lien, saisit la valeur dans son navigateur, et celle-ci
est chiffrée **côté client** avant d'atteindre le serveur. C'est le seul endroit
du produit où de la cryptographie asymétrique protège une valeur — donc le seul
réellement exposé à un futur ordinateur quantique.

L'échange de clés y est **hybride** ([lib/hybrid-kem.ts](../lib/hybrid-kem.ts),
[lib/pqc.ts](../lib/pqc.ts)) :

- **ECDH P-256** (WebCrypto) — protège si ML-KEM s'avérait immature ;
- **ML-KEM-768** (FIPS 203, via `@noble/post-quantum`) — protège contre un
  adversaire quantique ;
- les deux secrets partagés sont combinés par **HKDF-SHA256** — pas un XOR, qui
  n'est pas un combineur sûr — sur la concaténation des deux secrets **et** du
  transcript (ciphertext ML-KEM + clé publique éphémère ECDH), ce qui lie la clé
  dérivée à toute la transcription et ferme les attaques de re-binding.

La sortie est une clé AES-256-GCM de 32 octets. Casser la valeur exige de casser
les **deux** primitives. La clé privée rendue au demandeur est composite
(`{v, ecdh, mlkem}`). Les demandes créées avant la bascule (ECDH seul,
`hybridVersion = null`) restent déchiffrables.

### 5.3 Rotation de `ENCRYPTION_KEY`

[scripts/rekey-encryption.mjs](../scripts/rekey-encryption.mjs) re-chiffre
l'intégralité des colonnes chiffrées sous une nouvelle clé, en mode dual-key
(ancienne clé acceptée en lecture pendant la bascule). À exécuter instance
arrêtée ou en fenêtre de maintenance, avec un dump préalable.

---

## 6. Authentification

### 6.1 Session web

NextAuth v5, provider **Credentials**. Mot de passe hashé bcrypt (salt 12).
Session JWT signée par `AUTH_SECRET` / `NEXTAUTH_SECRET`. `NEXTAUTH_URL` doit
correspondre exactement à l'URL publique **et au port réel** de l'instance,
sinon les cookies de session sont rejetés.

Inscription publique fermée par défaut : `ALLOW_REGISTRATION="false"`. Le
premier administrateur est créé au premier démarrage à partir de `ADMIN_EMAIL`
et `ADMIN_PASSWORD` ([scripts/bootstrap-admin.mjs](../scripts/bootstrap-admin.mjs)).

### 6.2 2FA TOTP

RFC 6238 via `otplib`. Le secret est chiffré en base. 8 codes de secours
à usage unique, hashés bcrypt, sont générés à l'activation. Une réauthentifi-
cation est exigée pour les actions sensibles ([lib/reauth.ts](../lib/reauth.ts)).

### 6.3 OIDC pour la CI

[lib/oidc.ts](../lib/oidc.ts) valide les JWT émis par GitHub Actions, GitLab CI
et Bitbucket Pipelines : signature vérifiée contre le JWKS du fournisseur,
issuer et audience contrôlés, puis résolution de la `Policy`. Aucun secret n'est
stocké côté CI — c'est tout l'intérêt du mode OIDC.

### 6.4 Tokens Bearer

Quatre familles, toutes stockées hashées en SHA-256, toutes révocables
(`revokedAt`), avec `lastUsedAt` pour l'audit :

| Famille | Portée |
|---|---|
| `MachineToken` (`sv_…`) | Un couple `(projet, environnement)`. Toute autre combinaison → 403 |
| `UserToken` (`sv_user_…`) | Lecture des projets dont l'utilisateur est membre |
| `OrgToken` (`sv_org_…`) | Une organisation, avec liste blanche de projets et de scopes |
| `PluginToken` (`sv_plugin_…`) | Session de 4 h de l'extension navigateur |

---

## 7. Interface

App Router avec segments localisés `app/[locale]/…` — français, anglais,
espagnol. L'essentiel de l'UI vit dans `app/[locale]/(dashboard)/` : projets
(secrets, environnements, services, comptes, membres, policies, documentation),
organisations (membres, serveurs, secrets d'org, connexions CI, audit), coffres
personnels et d'équipe, compte utilisateur.

Les valeurs de secrets ne sont jamais rendues en masse : chaque révélation est
une action explicite, unitaire, tracée dans l'audit log.

---

## 8. Sécurité

- **En-têtes** ([next.config.ts](../next.config.ts)) : `X-Frame-Options: DENY`,
  `Strict-Transport-Security`, `Content-Security-Policy`, plus les en-têtes de
  durcissement usuels.
- **Rate limiting** ([lib/rate-limit.ts](../lib/rate-limit.ts),
  [lib/machine-rate-limit.ts](../lib/machine-rate-limit.ts)) : login (30 / 15 min
  par IP **et** 5 / 15 min par compte), inscription, reset de mot de passe,
  `/api/deploy`, authentification de l'extension, endpoints publics. Détail des
  seuils dans [security.md §8](security.md).
- **`TRUST_PROXY_HOPS`** : nombre de reverse proxies **de confiance** devant
  l'app. La chaîne `X-Forwarded-For` est lue par la droite ; seuls les N
  derniers segments sont posés par votre infrastructure, les autres sont
  forgeables. Cette valeur sert de clé à **tous** les rate-limits — mal réglée,
  elle les rend contournables ou trop agressifs. Le comptage n'est sain que si
  l'app n'est **pas** joignable en direct.
- **SSRF** ([lib/safe-fetch.ts](../lib/safe-fetch.ts)) : les URL fournies par
  l'utilisateur (webhooks de rotation, cibles de synchronisation) passent par un
  fetch qui refuse les adresses privées et de loopback.
- **CORS de l'extension** ([lib/plugin-cors.ts](../lib/plugin-cors.ts)) : les
  routes `/api/plugin/*` n'acceptent que l'origine déclarée dans
  `PLUGIN_ALLOWED_ORIGIN`, et répondent 403 si la variable est absente.
- **Audit** : toute action sensible est journalisée avec acteur, IP et
  horodatage, y compris les accès par token.
- **Suppression de compte** : soft-delete avec fenêtre de récupération, puis
  purge ([lib/deletion-window.ts](../lib/deletion-window.ts)).

L'analyse de sécurité détaillée est dans [security.md](security.md).

---

## 9. Installation et exploitation

### 9.1 Démarrage

```bash
cp .env.example .env
# renseigner ENCRYPTION_KEY, AUTH_SECRET, NEXTAUTH_SECRET, DB_PASSWORD,
# ADMIN_PASSWORD
docker compose up -d --build
```

Au premier démarrage, le conteneur applique les migrations Prisma puis crée le
compte administrateur. Les migrations suivantes s'appliquent automatiquement au
démarrage après une mise à jour d'image.

### 9.2 Configuration

Le fichier [.env.example](../.env.example) fait référence. Points d'attention :

| Variable | Rôle |
|---|---|
| `ENCRYPTION_KEY` | Clé AES-256 en hexadécimal (`openssl rand -hex 32`). **Sa perte rend les secrets définitivement irrécupérables**, même avec un dump complet de la base. À conserver en escrow, hors de l'instance |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | Signature des sessions (`openssl rand -base64 32`) |
| `NEXTAUTH_URL` | URL publique, **sans slash final**, alignée sur le port hôte réel |
| `PORT` | Port hôte (3001 par défaut ; le conteneur écoute toujours 3000 en interne) |
| `ALLOW_REGISTRATION` | Inscription publique. `false` par défaut |
| `TRUST_PROXY_HOPS` | Reverse proxies de confiance (cf. §8) |
| `OIDC_AUDIENCE` | Requis seulement si vous utilisez `/api/deploy` |
| `PLUGIN_ALLOWED_ORIGIN` | `chrome-extension://<id>`, séparées par virgule. Sans elle, l'extension est désactivée. Ajouter le token `moz-extension://*` pour accepter Firefox (uuid non épinglable) |
| `EMAIL_MAILGUN_*`, `EMAIL_FROM` | Emails transactionnels (invitations, reset). Facultatif : sans ces variables, l'app démarre, les emails sont simplement désactivés |

### 9.3 Reverse proxy

Placez l'app derrière nginx, Traefik ou Caddy, avec TLS, HTTP/2 et HSTS. Le
conteneur ne doit pas être joignable en direct depuis Internet — sinon le
comptage `TRUST_PROXY_HOPS` devient contournable (cf. §8).

### 9.4 Sauvegarde de votre instance

**Ce dépôt ne fournit ni backup, ni réplication, ni mécanisme de bascule.**
La résilience de votre instance est votre infrastructure. Au minimum :

- un dump régulier de PostgreSQL (`pg_dump`), chiffré et stocké hors du serveur
  qui l'a produit ;
- une copie de `ENCRYPTION_KEY` en escrow — un dump sans la clé est
  irrécupérable, et la clé sans dump ne vaut rien ;
- un test de restauration périodique.

### 9.5 Mise à jour

L'API, le schéma de base de données et le flux d'installation suivent le
versioning sémantique : un changement cassant passe par une version majeure.
Prenez un dump avant toute montée de version — les migrations s'appliquent
automatiquement au démarrage et ne sont pas conçues pour être annulées.

---

## 10. Synchronisation sortante

[lib/sync/](../lib/sync/) pousse les secrets d'un environnement vers une
plateforme d'hébergement tierce, pour garder Physalis comme source de vérité :
connecteurs **Vercel**, **Railway** et **Render**. La cible est déclarée par
environnement (`EnvironmentSyncTarget`), ses credentials sont chiffrés au repos,
et la synchronisation est rejouable à la demande.

---

## 11. Rotation automatique des secrets

[lib/rotation-agent.ts](../lib/rotation-agent.ts) et
[lib/rotators/](../lib/rotators/). Un secret peut porter une stratégie de
rotation (`RotationStrategy`), un intervalle en jours et une échéance :

| Stratégie | Comportement |
|---|---|
| `DATABASE` | Rotation du mot de passe d'un compte PostgreSQL / MySQL, en direct sur la base cible |
| `JWT_SECRET` | Regénération d'un secret aléatoire |
| `WEBHOOK` | Appel d'un webhook applicatif qui effectue la rotation et renvoie la nouvelle valeur |
| `API_KEY` | Rotation d'une clé d'API |
| `REMINDER` | Aucune action automatique : rappel daté pour une rotation manuelle |

La nouvelle valeur est chiffrée et versionnée comme n'importe quelle écriture ;
l'ancienne reste dans l'historique. Un échec est journalisé dans
`rotationLastStatus` sans casser le cycle suivant. La rotation d'un projet peut
être mise en pause.

---

## 12. Tests

```bash
npm test               # unit : crypto, tokens, rate-limit, validation, TOTP,
                       #        OIDC, catégories, tokens d'extension, KEM hybride
npm run test:integ     # intégration : auth Bearer, RBAC, chiffrement en base,
                       #               en-têtes, rate-limit, 2FA, serveurs,
                       #               policies, extension
```

Les tests d'intégration nécessitent la stack Docker démarrée.
