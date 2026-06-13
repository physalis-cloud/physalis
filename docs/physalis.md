# Physalis — Documentation Technique

> Ce fichier documente l'architecture, les entités, les API, les composants et l'infrastructure de Physalis.
> Il sert de contexte pour toute IA travaillant sur le projet.

> Migration depuis SecretVault : le rebrand `secretvault → physalis` a été achevé en Phase 0.2 (cf. [phase-0.2-rename-runbook.md](steps-docs/done/phase-0.2-rename-runbook.md)). Le projet a aussi évolué d'un produit self-hosted mono-tenant vers une **plateforme SaaS multi-tenant** (Phase 1+ → 6, plans FREE/SHARED/DEDICATED).

---

## 1. Vue d'ensemble

Gestionnaire de secrets multi-tenant proposé en SaaS (vault.physalis.cloud) ou self-hosted, analogue à Doppler/HashiCorp Vault simplifié, organisé autour des **clients** (= tenants) et de leurs **organisations**.

- Centralise les variables d'environnement de tous les projets dans une base PostgreSQL chiffrée AES-256-GCM.
- **Architecture schema-per-tenant** : chaque client a son propre schéma PostgreSQL `client_<slug>` qui contient toutes ses données (Organizations, Projects, Secrets, AccessLog, coffres, etc.). Un schéma `admin` séparé contient les métadonnées plateforme (Client, Subscription, AuditLog admin, TokenIndex, OidcPolicy).
- **Trois plans** : FREE (1 org / 1 siège, gratuit-permanent), SHARED (1 org / 5 sièges, 7€/mois après 14j d'essai), DEDICATED (2 orgs / 5 sièges, 29€/mois — instance + DB dédiées, à venir). Add-ons : organisation supplémentaire (7€, bundle isolé 2 serveurs / 10 OIDC / 2 sièges confinés), siège global (5€), serveur (5€), projet OIDC (3€), packs email (+5k/+15k/+30k à 5/12/20€). **Modèle de cloisonnement orgs (org principale `isPrimary` + sièges 2 niveaux + quotas isolés) et grille email détaillés dans [steps-docs/changement_pricing_orga.md](steps-docs/changement_pricing_orga.md).**
- **Multi-organisation par tenant** : à l'intérieur d'un tenant, chaque user appartient à une ou plusieurs organisations ; les projets, secrets et machine tokens sont scopés à une organisation. Invitations par email avec lien signé (TTL 48 h).
- Deux modes d'accès :
  - **Web (humains)** : NextAuth (Credentials), gestion fine via UI, switcher d'org dans le header. Login via `vault.physalis.cloud/login?tenant=<slug>` (FREE/legacy) ou via `<slug>.physalis.cloud` (SHARED/DEDICATED).
  - **Machine (VPS / CI)** : Bearer token, endpoint unique qui retourne tous les secrets d'un env autorisé.
- Extension navigateur Chrome + Firefox (repo séparé `secretvault-extension`) pour l'auto-fill et l'auto-save des credentials Service/AppAccount.
- Déploiement Docker Compose derrière Nginx Proxy Manager.

Chaque secret est chiffré au moment de l'écriture (API serveur) ; la `ENCRYPTION_KEY` ne quitte jamais les variables d'environnement du conteneur. Les valeurs ne transitent en clair qu'au moment de la révélation explicite (UI, une clé à la fois) ou de la récupération machine (token Bearer).

---

## 2. Stack

| Couche | Technologie | Version |
|---|---|---|
| Frontend / Backend | Next.js App Router | 15.5 |
| Langage | TypeScript | 5 |
| ORM | Prisma | 6.19 |
| Base de données | PostgreSQL | 16 (alpine) |
| Auth | NextAuth.js (Auth.js) | 5 (beta) |
| Hash mots de passe | bcryptjs (salt 12) | 3 |
| Chiffrement | Node `crypto` AES-256-GCM | natif |
| UI | Tailwind CSS v3 | 3.4 |
| Runtime conteneur | node:22-alpine | — |
| Reverse proxy (prod) | Nginx Proxy Manager | externe |

---

## 3. Modèle de données (Prisma)

### 3.0 Architecture multi-schéma

**Deux clients Prisma**, deux fichiers schéma :

- **[prisma/schema.prisma](../prisma/schema.prisma)** — schéma `admin` (multiSchema), client généré dans `node_modules/.prisma/admin-client`. Métadonnées plateforme : `Client`, `Subscription`, `AuditLog` (admin), `TokenIndex`, `OidcPolicy`. Les modèles sont annotés `@@schema("admin")`.
- **[prisma/tenant-schema.prisma](../prisma/tenant-schema.prisma)** — schéma tenant **sans** multiSchema, client généré dans le path par défaut `@prisma/client`. Émet du SQL non-qualifié (`SELECT * FROM "User"`). Le routage par tenant se fait via `SET LOCAL search_path TO "client_<slug>", "public"` dans une transaction.

**Trois clients exposés** depuis [lib/prisma.ts](../lib/prisma.ts) :

| Client | Description |
|---|---|
| `prisma` | **Tenant strict** — chaque opération est interceptée et exécutée dans une transaction qui pose `SET LOCAL search_path` à partir du slug lu dans `AsyncLocalStorage` (cf. [lib/tenant-context.ts](../lib/tenant-context.ts)). Throw si pas de contexte tenant — pas de fallback silencieux sur `public`. |
| `basePrisma` | Tenant brut, sans extension. Utilisé par `withTenantSchema(slug, fn)` pour poser le search_path manuellement, ou hors contexte tenant (auth.ts authorize, lib/provisioning.ts, scripts). |
| `adminPrisma` | Client ADMIN, émet du SQL qualifié (`"admin"."clients"`). Aucun lien avec le contexte tenant — séparation stricte. |

Helper [lib/tenant.ts `withTenantSchema(slug \| null, fn)`](../lib/tenant.ts) : démarre une transaction, pose `SET LOCAL search_path TO "client_<slug>", "public"` si slug, exécute `fn(tx)`. Si slug=null, search_path reste celui du user Postgres (mode legacy `public` pour les tenants pas encore migrés).

Chaque tenant créé déclenche [lib/provisioning.ts `provisionClientSchema(slug)`](../lib/provisioning.ts) : `CREATE SCHEMA "client_<slug>"` puis replay de toutes les migrations Prisma (en filtrant la liste `ADMIN_ONLY_MIGRATIONS`). À la suppression : pg_dump archive (best-effort) puis `DROP SCHEMA CASCADE`.

### 3.1 Modèles ADMIN (`admin` schema)

| Modèle | Rôle | Champs clés |
|---|---|---|
| `Client` | Tenant de la plateforme (= un schéma `client_<slug>`) | `slug` (unique, sert de sous-domaine), `plan` (`Plan`), `maxOrgs` / `maxUsers` (override des defaults par plan, éditables via `/admin/clients/[id]`), `status` (`ClientStatus`), `trialEndsAt` (nullable, null pour FREE), `comped` (Boolean — abonnement offert, skip facturation), `compedReason` (text 255), `stripeCustomerId`. **Add-ons (quantités sync depuis le webhook Stripe)** : `extraOrgs`, `extraUsers`, `extraServers`, `extraOidcProjects`, `extraEmail5k`/`extraEmail15k`/`extraEmail30k` (packs email empilables ×5000/15000/30000). `emailUsageResetAt` (borne de période pour le reset du compteur email relais) |
| `Subscription` | Historique des abonnements Stripe par client | `plan`, `status` (`SubscriptionStatus`), `stripeSubscriptionId`, périodes — alimenté par les webhooks Stripe |
| `AuditLog` (admin) | Actions plateforme (création client, suspension, provisioning…) | `action` (string ouvert : `client.created`, `schema.provisioned`, `client.quotas_updated`, `client.comped_toggled`, …), `clientId` (SetNull), `actor` (email superadmin ou `system`), `metadata` JSON |
| `TokenIndex` | Mapping `tokenHash → tenantSlug` (Phase 6.A) | `tokenHash` (PK), `tenantSlug`, `kind` (`TokenKind` : MACHINE / PLUGIN / SHARE / SECRET_REQUEST / USER / ORG / API_KEY). Permet de résoudre quel schéma `client_<slug>` contient le token, sans scanner toutes les bases. |
| `OidcPolicy` | Policy OIDC GitHub indexée global (Phase 6.B) | `(repo, workflow, branch, tenantSlug, projectId, environmentId)` unique + index `(repo, workflow, branch)`. Sert au lookup hot-path de `/api/deploy` pour résoudre la cible (tenant + projet + env) avant de switcher vers le schéma tenant. |
| `LifecycleEmail` | Traçabilité emails lifecycle (trial expiry…) | `clientId` (Cascade), `type` (`"overage_J7"` / `"overage_J30"`, extensible), `sentAt`. Utilisé par le cron trial-expiry pour éviter le doublon. |
| `StripeEventLog` | Idempotence des webhooks Stripe | `id` (= `event.id` Stripe), `type`, `payload` JSON, `receivedAt`. Le handler check si l'event est déjà traité avant tout traitement. |
| `PasswordResetToken` | Token de reset de mot de passe cross-tenant | `tokenHash` (SHA-256 unique), `tenantSlug` (pour withTenantSchema), `userId` (cuid du User dans le schéma tenant), `email` (dénormalisé), `expiresAt` (1h), `usedAt` (single-use). Token brut `sv_reset_<32hex>`. |

**Plans + features** : voir [lib/plans.ts](../lib/plans.ts) — `PLAN_QUOTAS`, `PLAN_FEATURES` (custom_domain, multi_users, server_management, github_actions_oidc, dedicated_instance, support, backups), `canUseFeature(plan, feature)`, `getTenantLoginUrl(plan, slug, opts)`, `planHasTrial(plan)`, constantes add-ons (`ADDON_*_PRICE_CENTS`, `ADDON_ORG_BUNDLE`, `ADDON_EMAIL_*`, `extraEmailsFromPacks`).

**Quotas (refonte cloisonnement orgs)** — [lib/quotas.ts](../lib/quotas.ts) :
- **Orgs** : `Client.maxOrgs + extraOrgs` (tenant-wide).
- **Sièges à 2 niveaux** : `checkGlobalSeatQuota` (sièges **globaux** = membres de l'org principale `isPrimary`, max = `Client.maxUsers + extraUsers`) vs `checkOrgSeatQuota(orgId)` (sièges **confinés** d'une org ajoutée = membres non-globaux, max = `Organization.maxSeats`). `checkSeatForOrgAdd` arbitre à l'invitation.
- **Serveurs / OIDC scopés PAR ORG** : `checkServerQuota(slug, orgId)` / `checkOidcProjectQuota(slug, orgId)` — org principale → `PLAN_QUOTAS[plan] + Client.extra*` ; org ajoutée → bundle stocké sur l'`Organization`.
- `getPrimaryOrgId(slug)` résout l'org principale (`isPrimary`, fallback la plus ancienne).

> `getTenantLoginUrl` accepte un `opts.locale` optionnel (`fr` / `en` / `es`) qui préfixe l'URL retournée (`https://<slug>.physalis.cloud/{locale}/login`). À fournir depuis les callers user-facing (login-resolve API, dashboard logout, signup) pour préserver la langue active de l'utilisateur et éviter le 307 cross-domain du middleware locale. Omettre la `locale` côté admin (création client, emails superadmin) où le destinataire final est inconnu — le middleware route alors selon son `Accept-Language`. Cf. §6.5.

### 3.2 Modèles TENANT (`client_<slug>` schema)

Voir [prisma/tenant-schema.prisma](../prisma/tenant-schema.prisma).

| Modèle | Rôle | Champs clés |
|---|---|---|
| `User` | Compte humain | `email` (unique), `password` (bcrypt), `role` (ADMIN \| MEMBER), 2FA optionnelle (`twoFactorEnabled` + `twoFactorSecret`/`Iv`/`Tag` chiffrés AES-256-GCM + `backupCodes` String[] bcrypt) |
| `Organization` | Espace isolé multi-tenant ; l'org **`isPrimary`** = compte général du tenant | `slug` (unique), `name`, **`isPrimary`** (Boolean — org principale, ses quotas sont dérivés du plan ; les orgs ajoutées portent un bundle isolé), quotas isolés des orgs ajoutées : `maxServers` / `maxOidcProjects` / `maxSeats` (sièges confinés) / `maxEmailsPerMonth` / `extraEmails` (defaults = `ADDON_ORG_BUNDLE`), relations members/projects/invitations/secrets. Cf. [steps-docs/changement_pricing_orga.md](steps-docs/changement_pricing_orga.md) |
| `OrgMember` | Membership d'un user dans une org | `(userId, organizationId)` unique ; `role` (OWNER \| ADMIN \| ADMIN_DEV \| DEV \| MEMBER) |
| `OrgSecret` | Secret global org (ex. `GITHUB_DISPATCH_TOKEN`) | `(organizationId, key)` unique ; chiffré AES-256-GCM comme `Secret` |
| `ClientEmailConfig` | Activation du service email Pink-Floyd au niveau **CLIENT** (singleton par tenant) | `tenantSlug` unique ; `enabled Boolean`, `accountId?` (compte Pink-Floyd **partagé par TOUS les projets/orgs du client**). Le métrage/quota email est au niveau client, pas par org (cf. §4.20). |
| `Invitation` | Invitation par email (TTL 48 h) | `tokenHash` (sha256, unique) ; `email`, `role`, `expiresAt`, `acceptedAt`, `invitedById` |
| `AccessLog` | Audit log persistant (append-only) | `action` (enum `AccessAction`), `actorUser*` / `actorToken*` (dénormalisé), `organizationId`/`projectId`/`environmentId` (FK SetNull), `secretKey`, `ipAddress`, `userAgent`, `metadata` (JSON) |
| `Project` | Conteneur applicatif | `slug` (unique global, **éditable**), `name`, **`organizationId`** (FK), `githubRepo` (`owner/repo`), `githubWorkflow` (par défaut `redeploy.yml`), relations envs/tokens/members/services/appAccounts/policies |
| `Server` | VPS au niveau org pour les déploiements OIDC | `(organizationId, name)` unique ; `ip`, `sshUser`, clé SSH privée chiffrée AES-256-GCM (`encryptedKey`/`iv`/`tag`) — **jamais relisible après création** |
| `Policy` | Liaison stricte (repo, workflow, branch) → (project, environment) pour `/api/deploy` | `(repo, workflow, branch, projectId, environmentId)` unique ; index sur `(repo, workflow, branch)` pour le hot path. Aucune wildcard |
| `Environment` | Bucket dans un projet (production, staging, …) | `(projectId, name)` unique ; `url` (URL déployée, optionnel), `dockerCompose` (contenu YAML, optionnel), **`serverId`** (FK Server, SetNull) + **`deployPath`** (chemin de deploy sur le VPS) |
| `Secret` | Paire clé/valeur chiffrée (env-level) | `(environmentId, key)` unique ; `encryptedValue`/`iv`/`tag` base64 ; `category` (text nullable) ; `tags String[]` (filtrage intégrations) ; champs rotation : `rotationEnabled Boolean`, `rotationStrategy RotationStrategy?` (DATABASE / JWT_SECRET / WEBHOOK / REMINDER / API_KEY), `rotationIntervalDays Int?`, `rotationNextAt DateTime?`, `rotationLastStatus String?`, `dbHost/Port/Name/Type/User?` (pour DATABASE), `rotationWebhookUrl?` (pour WEBHOOK), `apiKeyId?` → `ApiKey` (pour API_KEY) |
| `Service` | Service tiers du projet (Stripe, Firebase…) | `name`, `url?`, blob chiffré JSON `{user, password}` (`encryptedData`/`iv`/`tag`) ; lié au projet |
| `ProjectEmailConfig` | Config email Pink-Floyd au niveau projet | `projectId` unique ; `domain`, `domainId`, `keyId`, **clé API chiffrée** (`encryptedKey`/`iv`/`tag`), `verified Boolean`, `dnsRecords Json` ; rotation blue/green : `rotationEnabled`, `rotationIntervalDays?`, `rotationNextAt?`, `rotationLastAt?`, `rotationLastStatus?`, `pendingRevokeKeyId?`. Injecté dans le `.env` de chaque env au déploiement. Cf. §4.20 |
| `AppAccount` | Compte de test pour login dans l'app | `name`, blob chiffré JSON `{user, password}` ; lié au projet |
| `ClientBackupConfig` | Activation + **destination** du backup au niveau client | `tenantSlug` unique ; `enabled` ; `backupServerId?` → Server (`BackupDest`) + `backupPath?` (chemin de base ; chemin projet = `{base}/{slug}`). Cf. §4.21 |
| `ProjectBackupConfig` | Config backup d'un projet | `projectId` unique ; `enabled`, `environmentName`, planning (`scheduleHour`/`intervalDays`/`backupNextAt`/`backupLastAt`/`backupLastStatus`/`forceRequestedAt`), rétention (`retentionDaily`/`Weekly`/`Monthly`), GPG (`gpgPublicKey?`/`gpgKeyId?`/`agentRegisteredAt?` — **pubkey only**), token agent (`agentTokenHash?` + chiffré `agentTokenEnc/Iv/Tag?`), `overdueAlertedAt?`. Cf. §4.21 |
| `ProjectBackupDatabase` | DB d'un projet à sauvegarder (**1-N**) | `configId` (Cascade) ; `dbType`, `dbName`, `dbHost`, `dbUser`, `passwordSecretKey?` (clé du secret `.env`), `port?`, `enabled`. Détectée depuis le compose + `.env`, éditable. Cf. §4.21 |
| `ProjectBackupEntry` | Historique d'un backup (rempli par l'agent) | `configId`/`projectId` ; `filename`, `sizeBytes?`, `dbType`, `dbName`, `environmentName`, `destLocation`, `status` (PENDING/SUCCESS/FAILED), `errorMessage?`. Cf. §4.21 |
| `MachineToken` | Token Bearer pour VPS | `tokenHash` (sha256, unique) ; lié à `(project, environment)` ; **`createdById`** (FK User, SetNull si user supprimé) ; `revokedAt` pour soft-delete |
| `PluginToken` | Session 4h pour l'extension navigateur | `tokenHash` (sha256, unique) ; lié à un `User` ; `expiresAt`, `revokedAt`, `lastUsedAt`, `userAgent`. Préfixe `sv_plugin_<hex>`. Cf. §4.8c |
| `UserToken` | Token Bearer scopé à un User (Phase 11a) | `tokenHash` (SHA-256 unique), `prefix` (12 premiers chars), `userId` (Cascade), `name`, `expiresAt?`, `lastUsedAt?`, `revokedAt?`. Préfixe `sv_user_<32hex>`. Accès READ aux projets dont l'user est ProjectMember. Cf. §4.11 |
| `OrgToken` | Token Bearer scopé à une Organisation (Phase 11c) | `tokenHash` (SHA-256 unique), `prefix`, `organizationId` (Cascade), `createdById` (SetNull — survit au départ du user), `name`, `description?`, `allProjects Boolean`, `allowedProjectIds String[]`, `allowedScopes OrgTokenScope[]`, `expiresAt?`, `revokedAt?`. Préfixe `sv_org_<32hex>`. Cf. §4.11 |
| `SecretVersion` | Historique des valeurs d'un Secret (Phase 10) | `secretId` (Cascade), `version` Int, `encryptedValue/iv/tag`, `createdById` (SetNull). Unique `(secretId, version)`. Rétention 50 max par secret. Cf. §4.14 |
| `OrgSecretVersion` | Historique des valeurs d'un OrgSecret | Même structure que `SecretVersion` mais pour `OrgSecret.id`. |
| `SecretRequest` | Demande de secret externe via lien chiffré (Phase 12.5) | `tokenHash` (SHA-256 unique), `label`, `description?`, `requestedById/Email`, `recipientEmail?`, `organizationId` (Cascade), `projectId?` (SetNull), `environmentName?`, `secretKey?`, `publicKeyJwk` (ECDH P-256), `encryptedSecret?/iv?/ephemeralPublicKey?` (rempli après soumission), TTL `expiresAt` (48h). Cf. §4.12 |
| `Api` | API Gateway — définition d'une API (Phase 13) | `projectId` (Cascade), `name`, `mode` (`REMOTE` \| `JWT`), `jwtSecret/iv/tag?`, `defaultRateLimit?`, `defaultRateLimitWindow` (`"1m"`), `liveEnvId?`/`testEnvId?` (envs de secrets associés). Cf. §4.13 |
| `ApiKey` | Clé d'accès à une API Gateway | `apiId` (Cascade), `keyHash` (SHA-256 unique), `keyPrefix` (12 chars), `name`, `scopes String[]`, `rateLimit?`, `expiresAt?`, `revokedAt?`, `createdById` (SetNull), `meta Json?`. Liée optionnellement à un `Secret` pour la rotation `API_KEY`. Préfixe `ph_live_sk_*`/`ph_test_sk_*`. |
| `ApiLog` | Log de chaque appel à `/api/gateway/verify` | `apiId`, `keyId?`, `keyPrefix?`, `method`, `path?`, `ipAddress?`, `userAgent?`, `valid Boolean`, `reason?`, `statusCode?`, `latencyMs?`. |
| `VaultEntry` | Coffre personnel (privé par user) | `userId` (FK Cascade), `name`, `url?`, `username?`, `encryptedPassword?` (AES-256-GCM, 3 colonnes), `encryptedTotpSecret?` (TOTP du site cible, 3 colonnes), `tags String[]`, `favorite Boolean`. Aucun partage en V1 |
| `TeamVaultCollection` | Coffre d'équipe org OU projet | `name`, `slug`, EXACTEMENT un parmi `organizationId?` et `projectId?` (CHECK constraint DB). Unique `(organizationId, slug)` et `(projectId, slug)`. Cascade depuis l'org / le projet. Cf. §4.10 |
| `TeamVaultEntry` | Entrée d'une collection d'équipe | Mêmes colonnes que `VaultEntry` mais `collectionId` au lieu de `userId` |
| `TeamVaultMember` | Membre explicite d'une collection ORG | `(collectionId, userId)` unique ; `role` (`VaultRole` : OWNER \| EDITOR \| VIEWER). Inutilisé pour les collections projet (héritage RBAC projet, validation app-level refuse l'ajout) |
| `ProjectMember` | Membership projet | `(userId, projectId)` unique ; `role` (OWNER \| EDITOR \| VIEWER) |

Cascades : `onDelete: Cascade` sur Organization → OrgMember/Project/Invitation/OrgSecret/Server, Project → Environment/Service/AppAccount/MachineToken/Policy, Environment → Secret/Policy, User → ProjectMember/OrgMember/Invitation, MachineToken.createdBy → SetNull, Environment.server → SetNull (la suppression d'un serveur détache l'environnement, deploy bloqué tant qu'aucun serveur n'est réassigné).

### 3.3 Rôles applicatifs

**Trois niveaux** : Global User → Organization → Project.

| Rôle | Périmètre |
|---|---|
| `User.role = SUPERADMIN` | Opérateur plateforme Physalis : accès `/admin`. Hérite des pouvoirs ADMIN tenant (test/dépannage). `isPlatformAdmin` = ADMIN ou SUPERADMIN ; `isSuperadmin` strictement réservé aux gates `/admin` (cf. `lib/roles.ts`) |
| `User.role = ADMIN` | Global tenant. Donne **OrgRole OWNER implicite sur toutes les orgs** (admin god mode, legacy testing) |
| `OrgRole.OWNER` | Tout faire dans l'org : gérer membres, supprimer l'org, créer/supprimer projets, accès OWNER projet implicite |
| `OrgRole.ADMIN` | Gérer membres (sauf grant OWNER), créer/supprimer projets, accès OWNER projet implicite |
| `OrgRole.ADMIN_DEV` | **Droits DEV** (EDITOR implicite sur les projets, vault DEV…) **+ CRUD serveurs et secrets d'org** (accès cross-org). Entre DEV et ADMIN dans `ORG_ROLE_RANK`. Helper `hasDevPrivileges()` (`lib/roles.ts`). Ne gère pas les membres |
| `OrgRole.DEV` | Développeur de l'org. **EDITOR implicite sur tous les projets** sans avoir à être inscrit comme ProjectMember. Accès EDITOR aux collections org. Ne peut pas gérer les membres ni supprimer des projets |
| `OrgRole.MEMBER` | Voir l'org, créer des projets ; **accès aux projets uniquement si ProjectMember explicite** |
| `ProjectRole.OWNER` | Gérer le projet (delete, future : membres projet) |
| `ProjectRole.EDITOR` | CRUD secrets + gestion machine tokens |
| `ProjectRole.VIEWER` | Liste des clés + reveal une-à-une |

**Règle clé** : un Org OWNER/ADMIN obtient automatiquement un `ProjectRole.OWNER` effectif sur tous les projets de l'org. Un Org DEV obtient `ProjectRole.EDITOR` implicite sur tous les projets (sans row ProjectMember). Un Org MEMBER doit être inscrit explicitement comme ProjectMember pour accéder à un projet.

Helpers de comparaison dans [lib/api.ts](../lib/api.ts) :
- `ORG_ROLE_RANK = { MEMBER: 1, DEV: 2, ADMIN: 3, OWNER: 4 }` — le rang DEV (2) est entre MEMBER et ADMIN
- `PROJECT_ROLE_RANK = { VIEWER: 1, EDITOR: 2, OWNER: 3 }`

### 3.4 Cycle de vie d'un tenant

1. **Self-signup** (`/signup`, public) ou création admin (`/admin/clients/new`, superadmin) → ligne `admin.clients` (status TRIAL pour SHARED/DEDICATED, ACTIVE+trialEndsAt=null pour FREE) → `provisionClientSchema(slug)` (CREATE SCHEMA + replay migrations) → `createTenantAdminUser(slug, email, hash)` → email de bienvenue. URL de login dérivée du plan via `getTenantLoginUrl`.
2. Le tenant est ensuite vu par l'app uniquement via son schéma `client_<slug>` ; les flows Web et machine y entrent via `withTenantSchema(slug, ...)` ou `prisma.*` (extension auto, slug lu depuis la session).
3. Suppression : `/admin/clients/[id]` → archive pg_dump + `DROP SCHEMA CASCADE` + `deleteMany` sur `admin.tokenIndex` + `admin.oidcPolicy` filtrés par `tenantSlug` + `delete` de la ligne client. L'historique audit reste (FK SetNull).

### 3.5 Cycle de vie d'un user (à l'intérieur d'un tenant)

1. **Bootstrap admin** ([scripts/bootstrap-admin.mjs](../scripts/bootstrap-admin.mjs)) ou register POST → User créé + Organization auto-créée (slug = handle email, déduplication automatique) + OrgMember(OWNER).
2. Invitation : `POST /api/orgs/[slug]/members { email, role }` génère un `Invitation` (token random 32B hex, hash SHA-256 stocké, TTL 48 h) et envoie un email avec le lien `/invite/<token>`. Refus 403 si quota `Client.maxUsers` atteint.
3. Acceptation : l'invité doit avoir un compte avec l'email exact ; visite la page, clique Accepter → POST `/api/invitations/[token]` → upsert OrgMember + `acceptedAt`.
4. Retrait d'un membre : `DELETE /api/orgs/[slug]/members/[userId]` supprime ses ProjectMember dans l'org **et révoque tous ses MachineToken** (transaction). **Purge prudente de l'orphelin** : si le user n'appartient plus à aucune org **ET** que son coffre perso est vide (`VaultEntry`/`VaultCollection` = 0), son compte `User` est supprimé (évite un compte fantôme + libère le siège) ; sinon conservé (un coffre perso non vide n'est jamais détruit par un retrait). Tracé en audit (`orphanUserPurged`/`orphanUserKept`). Garde-fou : impossible de retirer/rétrograder le dernier OWNER.

### 3.6 Tenant courant (routing)

Le slug du tenant est résolu côté login-form ([app/(auth)/login/login-form.tsx](../app/(auth)/login/login-form.tsx)) selon priorité :

1. URL param `?tenant=<slug>` (mode shared portal `vault.physalis.cloud/login?tenant=<slug>` — utilisé par les FREE et la rétrocompat des SHARED legacy)
2. Subdomain `<slug>.physalis.cloud` (mode SHARED/DEDICATED — détection via `window.location.hostname.endsWith('.physalis.cloud')`)
3. Reserved subs (`vault`, `www`, `admin`, `api`, `mail`, `static`) → tenantSlug=null (mode legacy `public`)

Le slug détecté est envoyé en credential `tenantSlug` à `signIn()` et propagé dans la session JWT (callback `jwt`/`session` dans [lib/auth.config.ts](../lib/auth.config.ts)). À chaque requête, le client `prisma` lit `session.user.tenantSlug` (via fallback `auth()` si AsyncLocalStorage vide en RSC) et pose le search_path en conséquence.

### 3.7 Org courante (cookie)

Cookie httpOnly `sv-current-org=<slug>`. Lu par [lib/api.ts `getCurrentOrgSlug(userId)`](../lib/api.ts) avec validation de membership. Fallback : première org du user (créée le plus tôt). Switcher : `POST /api/me/current-org { slug }`.

---

## 4. API REST

Toutes les routes web (cookie session) passent par les helpers `requireUser` / `requireOrgMember(slug, role)` / `requireProjectMember(slug, role)` / `requireEnvironment(slug, env, role)` ([lib/api.ts](../lib/api.ts)). La route machine `/api/secrets/[slug]/[env]` utilise `validateToken` ([lib/auth-token.ts](../lib/auth-token.ts)) sur le header `Authorization: Bearer …`.

### 4.0 Admin (superadmin uniquement)

Routes ADMIN sous `/admin/*` — gardées par `isSuperadmin(role) && tenantSlug === null` ([app/admin/layout.tsx](../app/admin/layout.tsx)). Les server actions sont dans `app/admin/clients/[id]/actions.ts`.

| Méthode | Route | Description |
|---|---|---|
| GET | `/admin/clients` | Liste tenants (slug, plan, status, comped, quotas, échéance trial). Filtres `?q=&plan=&status=` |
| GET | `/admin/clients/[id]` | Détail tenant : URL d'accès selon plan, schéma, abonnements, audit log, actions |
| GET / POST | `/admin/clients/new` | Création manuelle d'un client (alternative au signup public) |
| Server action | `changePlan` | Reset les quotas aux defaults du nouveau plan + ajuste le trial (FREE → null, autre → 14j) |
| Server action | `updateQuotas` | Override `maxOrgs` + `maxUsers` (soft cap : pas de delete des rows existantes au-dessus) |
| Server action | `toggleComped` | Passe le client en "abonnement offert" (status TRIAL → ACTIVE + trialEndsAt=null à l'activation, pas de change au désactivation) |
| Server action | `toggleSuspend` | Suspend/réactive un tenant (refuse CANCELLED) |
| Server action | `extendTrial` | +14j sur `trialEndsAt` (refuse FREE) |
| Server action | `deleteClient` | Archive pg_dump + DROP SCHEMA + cleanup `token_index` / `policies` orphelins + delete row |

Public signup : `POST /signup` (server action `signupTenant` dans [app/(auth)/signup/actions.ts](../app/(auth)/signup/actions.ts)). Rate-limit 5/h/IP. Plan DEDICATED désactivé côté UI tant que l'infra dédiée n'est pas livrée.

### 4.1 Authentification

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET / POST | `/api/auth/[...nextauth]` | — | Handlers NextAuth (login, callback, csrf, session). **Rate-limit** sur `/callback/credentials` : 5/15min/IP. Champ `totpCode` optionnel pour le 2e facteur |
| POST | `/api/auth/register` | — | Inscription publique (gardée par `ALLOW_REGISTRATION=true`). Mot de passe min 12 chars, hash bcrypt salt 12. **Rate-limit** : 3/h/IP (avant le check ALLOW_REGISTRATION). Crée auto une Org + OrgMember(OWNER) |
| GET | `/api/me/2fa` | session | État 2FA du user courant (`enabled`, `backupCodesRemaining`) |
| POST | `/api/me/2fa/setup` | session | Génère un secret TOTP, le chiffre et stocke avec `enabled=false`. Retourne `{ secret, otpauthUrl, qrDataUrl }`. 409 si déjà active |
| POST | `/api/me/2fa/verify` | session | Body : `{ code }`. Si valide, active la 2FA et renvoie 8 backup codes plaintext **une seule fois** (puis bcrypt-hashés) |
| DELETE | `/api/me/2fa` | session | Body : `{ code }` (TOTP ou backup). Désactive et efface secret + backup codes |

### 4.2 Organisations

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/orgs` | session | Liste les orgs dont je suis membre (avec mon role) |
| POST | `/api/orgs` | session | Crée une org. Body : `{ name }`. Auteur devient OWNER |
| GET | `/api/orgs/[slug]` | OrgMember | Détail (counts) + role effectif |
| PATCH | `/api/orgs/[slug]` | OrgADMIN | Rename. Body : `{ name }` |
| DELETE | `/api/orgs/[slug]` | OrgOWNER | Cascade delete (projets, membres, invitations, org secrets) |
| GET | `/api/orgs/[slug]/secrets` | OrgADMIN | Liste les org secrets (clés uniquement) |
| POST | `/api/orgs/[slug]/secrets` | OrgADMIN | Upsert. Body : `{ key, value }` (`key` matche `^[A-Z][A-Z0-9_]*$`) |
| GET | `/api/orgs/[slug]/secrets/[key]` | OrgADMIN | Reveal valeur (déchiffré) |
| DELETE | `/api/orgs/[slug]/secrets/[key]` | OrgADMIN | Supprime |

### 4.2b Serveurs (org-level)

VPS cibles pour les déploiements OIDC. La clé SSH privée est chiffrée AES-256-GCM avec la même `ENCRYPTION_KEY` que les secrets ; **jamais relue** par l'API ni l'UI après création (rotation = supprimer/recréer le serveur). Les environnements y sont attachés via `serverId` + `deployPath`.

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/orgs/[slug]/servers` | OrgADMIN | Liste (sans la clé) |
| POST | `/api/orgs/[slug]/servers` | OrgADMIN | Body : `{ name, ip, sshUser, sshPrivateKey }`. Validation PEM/OpenSSH minimale, refus si nom déjà pris dans l'org |
| GET | `/api/orgs/[slug]/servers/[id]` | OrgADMIN | Détail + liste des environnements liés (sans la clé) |
| PATCH | `/api/orgs/[slug]/servers/[id]` | OrgADMIN | Body partiel : `{ name?, ip?, sshUser? }`. La clé SSH n'est **pas** modifiable ici |
| DELETE | `/api/orgs/[slug]/servers/[id]` | OrgADMIN | SetNull sur `Environment.serverId` (deploy bloqué tant qu'on ne réassigne pas) |

### 4.3 Membres & invitations

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/orgs/[slug]/members` | OrgMember | Liste membres + invitations en attente + mon role |
| POST | `/api/orgs/[slug]/members` | OrgADMIN | Invite par email. Body : `{ email, role }`. Génère token (TTL 48h), envoie email via `lib/email.ts`. Seul un OWNER peut inviter en OWNER |
| PATCH | `/api/orgs/[slug]/members/[userId]` | OrgADMIN | Change rôle. Refus si tentative de rétrograder le dernier OWNER |
| DELETE | `/api/orgs/[slug]/members/[userId]` | OrgADMIN | Retire le membre. **Cascade** : delete ProjectMember dans l'org + révoque MachineToken créés par le user dans l'org. Refus si dernier OWNER |
| GET | `/api/invitations/[token]` | — (public) | Preview anonyme : email, role, org, inviteur, expiresAt |
| POST | `/api/invitations/[token]` | session | Accepte. L'email de la session doit matcher (case-insensitive) celui de l'invitation |

### 4.4 Org courante (switcher)

| Méthode | Route | Rôle | Description |
|---|---|---|---|
| GET | `/api/me/orgs` | session | Données pour le switcher : liste mes orgs + slug courant |
| POST | `/api/me/current-org` | session | Set le cookie `sv-current-org=<slug>`. Vérifie membership |

### 4.5 Projets

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/projects` | session | Liste les projets de l'org courante (cookie) ou de `?org=<slug>` |
| POST | `/api/projects` | OrgMember | Crée projet dans l'org courante (ou `body.organization`) + 3 envs (`production`/`staging`/`development`) + ProjectMember(OWNER) pour l'auteur. Body : `{ name, slug?, environments?, organization? }` |
| GET | `/api/projects/[slug]` | ProjectVIEWER ou OrgADMIN+ | Détail projet + envs (counts) + role effectif |
| PATCH | `/api/projects/[slug]` | ProjectOWNER | Update. Body partiel : `{ name?, slug?, githubRepo?, githubWorkflow? }`. Le slug est éditable (validation `slugify`, conflit 409). Le rename casse les scripts qui hardcodent l'URL Bearer mais le token reste valide. |
| DELETE | `/api/projects/[slug]` | ProjectOWNER ou OrgADMIN+ | Cascade delete |

### 4.5b Environnements (CRUD)

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| POST | `/api/projects/[slug]/environments` | EDITOR | Crée un env. Body : `{ name, url?, serverId?, deployPath? }`. Validation `^[a-z][a-z0-9-]{0,30}$`. `serverId` doit appartenir à la même org que le projet (sinon 400). `deployPath` optionnel : si null, `/api/deploy` applique la convention `/srv/projets/<env>/<slug>` au runtime |
| GET | `/api/projects/[slug]/environments/[name]` | VIEWER | Lit l'env avec son `dockerCompose`, `serverId` et `deployPath` |
| PATCH | `/api/projects/[slug]/environments/[name]` | EDITOR (OWNER si rename) | Update. Body partiel : `{ name?, url?, dockerCompose?, serverId?, deployPath? }`. `serverId: null` détache le serveur, `deployPath: ""` ou `null` revient au défaut conventionnel (suit ensuite les renames d'env/projet automatiquement) |
| DELETE | `/api/projects/[slug]/environments/[name]` | OWNER | Cascade delete (secrets + tokens) |

### 4.5c Services & Comptes (Accès)

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/projects/[slug]/services` | VIEWER | Liste sans credentials (id, name, url) |
| POST | `/api/projects/[slug]/services` | EDITOR | Crée. Body : `{ name, url?, user, password }`. user+password chiffrés en blob JSON |
| GET | `/api/projects/[slug]/services/[id]` | VIEWER | **Reveal** un service (user+password déchiffrés) |
| PATCH | `/api/projects/[slug]/services/[id]` | EDITOR | Update partiel. Si user OU password change, re-chiffre le blob (l'autre champ est préservé) |
| DELETE | `/api/projects/[slug]/services/[id]` | EDITOR | Supprime |
| GET | `/api/projects/[slug]/accounts` | VIEWER | Liste sans credentials (id, name) |
| POST | `/api/projects/[slug]/accounts` | EDITOR | Crée. Body : `{ name, user, password }` |
| GET | `/api/projects/[slug]/accounts/[id]` | VIEWER | Reveal un compte |
| PATCH | `/api/projects/[slug]/accounts/[id]` | EDITOR | Update partiel |
| DELETE | `/api/projects/[slug]/accounts/[id]` | EDITOR | Supprime |

### 4.x Audit log

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/orgs/[slug]/audit` | OrgADMIN+ | Liste paginée (cursor) des entrées `AccessLog` de l'org. Query : `?action=<enum>` filtre par action, `?project=<slug>` filtre par projet, `?limit=<n>` (max 200), `?cursor=<id>` pour la page suivante |
| GET | `/api/orgs/[slug]/audit?format=csv` | OrgADMIN+ | Export CSV (RFC 4180, max 5000 lignes) |
| GET | `/api/projects/[slug]/audit` | ProjectEDITOR+ ou OrgADMIN+ | Idem, scope projet |
| GET | `/api/projects/[slug]/audit?format=csv` | ProjectEDITOR+ ou OrgADMIN+ | Export CSV scope projet |

### 4.6 Secrets (UI)

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/projects/[slug]/[env]/secrets` | VIEWER | Liste **clés uniquement** (pas de valeurs) + `category` |
| POST | `/api/projects/[slug]/[env]/secrets` | EDITOR | Upsert. Body : `{ key, value, category? }`. `key` doit matcher `^[A-Z][A-Z0-9_]{0,127}$`. `category` optionnelle (null/absente/`""` → sans catégorie), sinon doit être ∈ liste hardcodée [lib/categories.ts](../lib/categories.ts) |
| GET | `/api/projects/[slug]/[env]/secrets/[key]` | VIEWER | **Reveal** d'une clé unique (déchiffré) |
| PATCH | `/api/projects/[slug]/[env]/secrets/[key]` | EDITOR | Update partiel. Pour l'instant uniquement `{ category: string \| null }` — recategorise sans toucher à la valeur (pas de decrypt/re-encrypt). No-op si la catégorie est inchangée |
| DELETE | `/api/projects/[slug]/[env]/secrets/[key]` | EDITOR | Supprime |

**Catégories** ([lib/categories.ts](../lib/categories.ts)) — liste hardcodée + ordre d'affichage figé : `ports`, `database`, `auth`, `services`, `email`, `infra`, `application`. Les secrets sans catégorie tombent dans une section « Sans catégorie » en fin de liste. Pour ajouter une catégorie : édit du fichier + redéploiement, aucune migration DB nécessaire (le champ `Secret.category` est text libre validé app-level).

### 4.7 Machine tokens

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/tokens?project=<slug>[&env=<name>]` | EDITOR | Liste tokens (sans hash) |
| POST | `/api/tokens` | EDITOR | Crée token. Body : `{ project, environment, name }`. Trace `createdById` pour le cascade revoke. Réponse contient `token` plaintext **une seule fois** + métadonnées |
| DELETE | `/api/tokens/[id]` | EDITOR | Soft-revoke : `revokedAt = now()` |

### 4.7b Redeploy (GitHub Actions)

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| POST | `/api/projects/[slug]/redeploy` | EDITOR | Body : `{ environment }`. Lit l'org secret `GITHUB_DISPATCH_TOKEN`, déclenche `workflow_dispatch` sur `repos/{githubRepo}/actions/workflows/{githubWorkflow}/dispatches` avec `{ ref: "main", inputs: { environment } }`. 400 si `githubRepo` ou token absent ; 502 si GitHub refuse |

### 4.7c Policies (OIDC)

Mapping strict (repo, workflow, branch) → (project, environment). Consulté en hot path par `/api/deploy` après validation du JWT. Aucune wildcard sur les claims (par design : limite la surface d'attaque en cas de fuite de token OIDC).

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/projects/[slug]/policies` | ProjectVIEWER+ | Liste les policies du projet (tous environnements) |
| POST | `/api/projects/[slug]/policies` | ProjectOWNER | Body : `{ repo, workflow, branch, environment }`. Validation `^owner/repo$`, `*.yml`/`*.yaml`, branche conforme `git-check-ref-format`. 409 si duplicat, 400 si env inconnu |
| DELETE | `/api/projects/[slug]/policies/[id]` | ProjectOWNER | Supprime |

### 4.8 Endpoints Bearer (VPS)

Auth : `Authorization: Bearer sv_<hex>` (jamais via cookie session). Validation par `validateToken` ([lib/auth-token.ts](../lib/auth-token.ts)) ; le token doit correspondre au `slug` ET au nom de l'env demandé (sinon 403). Token révoqué → 401 immédiat. `lastUsedAt` mis à jour de manière asynchrone (non-bloquant).

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/secrets/[slug]/[env]` | Retourne `{ secrets: { KEY: value, … } }` (JSON, déchiffré) |
| GET | `/api/compose/[slug]/[env]` | Retourne le `dockerCompose` de l'env en `text/plain` (`Content-Disposition: attachment; filename="docker-compose.yml"`, `Cache-Control: no-store`). 404 si non configuré |

### 4.8b Endpoint OIDC (`/api/deploy`)

Auth : `Authorization: Bearer <jwt>` où `<jwt>` est un token OIDC GitHub Actions (`actions/github-script` avec `core.getIDToken('<audience>')`). Aucun cookie ni machine token accepté.

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/deploy` | Body : `{ project: "<slug>", environment: "<name>" }`. Vérifie le JWT contre le JWKS GitHub (cache jose interne), valide `iss`/`aud`/`exp`, extrait `repository`/`workflowFile`/`branch` des claims. Match contre `Policy` en DB. Si OK + serveur configuré, retourne `{ project, environment, serverIp, serverUser, sshKey, deployPath, secrets: { ... }, dockerCompose: string \| null, registry: { url, user, pat } \| null }`. Le `deployPath` est toujours non-null dans la réponse : valeur explicite si saisie, sinon convention `/srv/projets/<env>/<slug>`. Le `dockerCompose` est `null` si non configuré. Le `registry` est résolu depuis les OrgSecrets réservés `REGISTRY_PAT` + `REGISTRY_USER` (+ optionnel `REGISTRY_URL`, défaut `ghcr.io`) — null si l'un des deux obligatoires manque, jamais inclus dans `secrets` (séparation infra ↔ app) |

Codes de retour spécifiques :
- `401` — token absent, expiré, signature invalide, mauvais issuer ou audience
- `403` — token valide mais aucune `Policy` ne correspond à (repo, workflow, branch, project, environment)
- `422` — policy OK mais l'environnement n'a pas de serveur configuré (le `deployPath` n'est plus bloquant : si null, fallback automatique sur `/srv/projets/<env>/<slug>`)
- `429` — rate-limit (30/min/IP)

Le bundle `deployPath` est résolu côté serveur : si `Environment.deployPath` est explicitement saisi → cette valeur ; sinon → `defaultDeployPath(envName, projectSlug)` (convention argoweb dans [lib/validation.ts](../lib/validation.ts)). L'audit `DEPLOY_AUTHORIZED` indique `usedDefaultDeployPath: true|false` pour tracer si le défaut a été appliqué. Avantage : un rename de projet ou d'environnement met à jour automatiquement le path pour les envs qui n'ont pas de path explicite.

Audit (`AccessAction`) : `DEPLOY_AUTHORIZED` (succès) ou `DEPLOY_DENIED` (échec, sauf `missing_token`/`wrong_aud`/`wrong_iss` non logués pour éviter le bruit des probes). Tous incluent dans `metadata` les claims observés et le `reason` du déni.

Variables d'environnement :
- `OIDC_AUDIENCE` (par défaut `vault.physalis.cloud`) — audience attendue dans le JWT. **Recommandation** : utiliser le hostname public du vault pour empêcher la replay d'un token OIDC destiné à un autre service.
- `OIDC_JWKS_URL` (par défaut le JWKS GitHub Actions) — override pour les tests uniquement.

### 4.8c Endpoints extension navigateur (`/api/plugin/*`)

Consommés par l'extension Chrome/Firefox Physalis (repo séparé `secretvault-extension`, à renommer plus tard ; nom du package `physalis-extension`). Auth en deux temps : email+password+TOTP → token de session 4h (`PluginToken`) utilisé en Bearer pour les requêtes suivantes. Aucune dépendance à une session NextAuth (l'extension est sur origin `chrome-extension://<id>`, les cookies vault ne suivent pas). Le `host_permissions` du manifest couvre `*.physalis.cloud` + legacy `secretvault.argoweb.fr` (compat).

| Méthode | Route | Auth | Description |
|---|---|---|---|
| OPTIONS | `/api/plugin/auth` | — | Preflight CORS. Retourne 204 + headers si origin whitelistée |
| POST | `/api/plugin/auth` | email + password + totp | Body : `{ email, password, totp, ttl? }`. **2FA obligatoire** côté user (sinon 403 explicite). `ttl` optionnel : si présent, doit appartenir à la liste fermée `[3600, 14400, 28800]` (1h / 4h / 8h) — sinon 400. Si absent, fallback sur `PLUGIN_SESSION_TTL` env (défaut 14400). Retourne `{ sessionToken: "sv_plugin_<hex>", expiresAt: <unix> }`. Rate-limit : 5/15min/IP. Audit `PLUGIN_AUTH_SUCCESS` (metadata `{ acceptedVia, ttlSeconds, ttlSource: "body" \| "env" }`) / `PLUGIN_AUTH_FAILURE` |
| OPTIONS | `/api/plugin/match` | — | Preflight CORS |
| GET | `/api/plugin/match?domain=<hostname>` | Bearer `sv_plugin_<hex>` | Retourne `{ services, accounts, vault }` pour le hostname. Match strict `URL().hostname`. Services via `Service.url`, AppAccounts via `Environment.url` du projet parent. `vault[]` agrège coffre perso + équipe (cf. §4.10.3). Audit `PLUGIN_CREDENTIALS_FETCH` |
| OPTIONS | `/api/plugin/vault` | — | Preflight CORS |
| POST | `/api/plugin/vault` | Bearer `sv_plugin_<hex>` | Auto-save d'un credential depuis l'extension (cf. §4.10.5). Body : `{ action: "create"\|"update", id?, target: "personal"\|"team_org"\|"team_project", orgSlug?, projectSlug?, collectionSlug?, name, url?, username?, password, tags? }`. Rate-limit : 30/min/user. Audit `VAULT_ENTRY_CREATE`/`UPDATE` avec `metadata.origin: "plugin_autosave"` + `metadata.domain` |
| GET | `/api/plugin/tokens` | session NextAuth | Liste les PluginTokens du user connecté (pour la page `/settings/security`). Pas de `tokenHash` ni de brut renvoyés, juste les métadonnées (createdAt, expiresAt, lastUsedAt, revokedAt, userAgent, isActive) |
| DELETE | `/api/plugin/tokens/[id]` | session NextAuth | Révocation manuelle. `revokedAt = now()`. Audit `PLUGIN_TOKEN_REVOKED`. Idempotent. 404 si l'id n'appartient pas au user (pas 403 — on ne leak pas l'existence) |

**Variables d'environnement** :

- `PLUGIN_SESSION_TTL` (défaut `14400` = 4h) — durée de vie d'un PluginToken en secondes
- `PLUGIN_ALLOWED_ORIGIN` (**obligatoire** pour activer ces endpoints) — `chrome-extension://<id>`. Plusieurs valeurs séparées par virgule autorisées (ex. dev + prod). Si non définie, tous les endpoints `/api/plugin/*` répondent 403

**Schéma `PluginToken`** ([prisma/schema.prisma](../prisma/schema.prisma)) : `tokenHash` (SHA-256 unique), `userId` (FK Cascade), `expiresAt`, `createdAt`, `lastUsedAt` (mis à jour async à chaque match), `revokedAt`, `userAgent` (dénormalisé pour identifier la session côté UI). Aucune valeur en clair n'est jamais persistée.

**Spec produit** complète dans [navigateurs-extension.md](navigateurs-extension.md) ; repo de l'extension : `/home/gael/projets/argoweb/secretvault-extension/CLAUDE.md`.

### 4.10 Coffres (personnel + équipe)

Spec produit complète : [docs/coffres.md](coffres.md). Implémentation en 3 sous-PRs :
- **Sub-PR1 — Coffre personnel** (livré) : routes `/api/vault/entries/*`
- **Sub-PR2 — Coffres d'équipe** : routes `/api/vault/org/*` + `/api/vault/project/*`
- **Sub-PR3 — Plugin match étendu** : agrégation vault perso + org + projet dans le bundle `/api/plugin/match`

#### 4.10.1 Coffre personnel (`/api/vault/entries`) — Sub-PR1 ✅

Visible uniquement par `req.user`. Aucun partage. Mots de passe chiffrés AES-256-GCM avec la même `ENCRYPTION_KEY`.

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/vault/entries` | Liste (sans password). Query : `?tag=<tag>`, `?favorite=true`, `?search=<term>` (case-insensitive sur name/url/username) |
| POST | `/api/vault/entries` | Crée. Body : `{ name, url?, username?, password?, tags?, favorite? }`. `tags` : array de strings, max 20 entrées de 50 chars. Limites : name 200, url 2048, username 200, password 4096 chars |
| GET | `/api/vault/entries/[id]` | **Reveal** : retourne `password` déchiffré. Audit `VAULT_ENTRY_REVEAL` |
| PATCH | `/api/vault/entries/[id]` | Update partiel. Si `password` présent, re-encrypt ; si `null`/`""`, efface |
| DELETE | `/api/vault/entries/[id]` | Supprime |

**Audit** : `VAULT_ENTRY_CREATE` / `_UPDATE` / `_DELETE` / `_REVEAL` avec `metadata: { source: "personal" }`. Le `source` permet de distinguer les actions perso vs org/projet dans une même requête de logs.

**RBAC** : 404 si l'entrée n'appartient pas au user demandeur (jamais 403, pour ne pas leak l'existence). Un admin global (`User.role = ADMIN`) **ne** peut **pas** lire les coffres d'autres users — c'est le seul cas où le god mode admin ne s'applique pas.

**Générateur de mot de passe** : [lib/generate-password.ts](../lib/generate-password.ts) — universel (Node + browser via Web Crypto API). Format base64url, longueur configurable 12-64, défaut 24.

#### 4.10.2 Coffres d'équipe — Sub-PR2 ✅

Modèle `TeamVaultCollection` + `TeamVaultEntry` + `TeamVaultMember` (cf. §3). Chaque collection est scopée à une organisation OU un projet (XOR strict, CHECK constraint Postgres `((organizationId IS NULL) <> (projectId IS NULL))` — un INSERT bypassant la validation app-level échoue côté DB).

**Org collection** : droits via `TeamVaultMember` explicite + accès OWNER implicite pour OrgADMIN/OWNER. **Project collection** : droits **hérités** du RBAC projet (VIEWER/EDITOR/OWNER projet → même rôle sur la collection) — `TeamVaultMember` n'est jamais consulté ici. Les routes `/project/*` n'exposent même pas l'endpoint members.

**RBAC global ADMIN** : god mode habituel — `User.role = ADMIN` donne OWNER implicite sur toutes les collections (org ET projet). Cf. lib/vault-access.ts.

**404 anti-leak** : tout accès refusé sur les collections retourne 404 (pas 403), pour ne pas leak l'existence d'une collection à un user non autorisé.

##### Routes — Org collections

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/vault/org/[orgSlug]/collections` | OrgMember | Liste : OrgADMIN+ voient tout, OrgMEMBER ne voit que les collections où il est `TeamVaultMember` |
| POST | `/api/vault/org/[orgSlug]/collections` | OrgADMIN | Body : `{ name }`. Slug auto via `slugify`. Conflit 409 |
| PATCH | `/api/vault/org/[orgSlug]/collections/[slug]` | OWNER collection | Rename (recalcule slug, gère conflit) |
| DELETE | `/api/vault/org/[orgSlug]/collections/[slug]` | OWNER collection | Cascade (entries + members) |

##### Routes — Org members

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/vault/org/[orgSlug]/collections/[slug]/members` | OWNER collection | Liste membres explicites |
| POST | `/api/vault/org/[orgSlug]/collections/[slug]/members` | OWNER collection | Body : `{ email, role }`. Le user à inviter doit déjà être OrgMember (sinon 400). Conflit 409 |
| PATCH | `/api/vault/org/[orgSlug]/collections/[slug]/members/[userId]` | OWNER collection | Body : `{ role }` |
| DELETE | `/api/vault/org/[orgSlug]/collections/[slug]/members/[userId]` | OWNER collection | Retire |

##### Routes — Org entries

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/vault/org/[orgSlug]/collections/[slug]/entries` | VIEWER collection | Liste sans password. Query : `?tag=`, `?favorite=true`, `?search=` |
| POST | `/api/vault/org/[orgSlug]/collections/[slug]/entries` | EDITOR collection | Crée |
| GET | `/api/vault/org/[orgSlug]/collections/[slug]/entries/[id]` | VIEWER collection | Reveal password |
| PATCH | `/api/vault/org/[orgSlug]/collections/[slug]/entries/[id]` | EDITOR collection | Update partiel |
| DELETE | `/api/vault/org/[orgSlug]/collections/[slug]/entries/[id]` | EDITOR collection | Supprime |

##### Routes — Project collections

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/vault/project/[projectSlug]/collections` | ProjectVIEWER | Liste toutes les collections du projet (le RBAC projet donne déjà accès à tout) |
| POST | `/api/vault/project/[projectSlug]/collections` | ProjectEDITOR | Crée (le créateur est OWNER via héritage) |
| PATCH | `/api/vault/project/[projectSlug]/collections/[slug]` | ProjectOWNER | Rename |
| DELETE | `/api/vault/project/[projectSlug]/collections/[slug]` | ProjectOWNER | Cascade |

##### Routes — Project entries

Identiques aux org entries mais accès via `requireProjectCollectionAccess` (RBAC hérité). **Aucune route members** — pas applicable au scope projet.

##### Audit

`VAULT_COLLECTION_CREATE` / `VAULT_COLLECTION_DELETE` / `VAULT_MEMBER_ADD` / `VAULT_MEMBER_REMOVE` / `VAULT_MEMBER_ROLE_CHANGE` + les `VAULT_ENTRY_*` du sub-PR1, avec `metadata.source: "org" | "project"` pour distinguer le scope.

##### UI

Composant partagé [app/(dashboard)/team-vault-panel.tsx](../app/(dashboard)/team-vault-panel.tsx) avec un prop `scope: { kind: "org" | "project", ... }`. Un seul rendu pour les deux contextes — la section « Membres » est conditionnelle (uniquement scope org). Plugue dans :
- `/orgs/[slug]` : nouvel onglet « 🔒 Coffre d'équipe » à côté de Membres / Secrets globaux / Serveurs
- `/projects/[slug]` : nouvel onglet « 🔒 Coffre » entre Accès et Policies

#### 4.10.3 Plugin match étendu — Sub-PR3 ✅

`/api/plugin/match?domain=<hostname>` retourne `{ services, accounts, vault }`. Le tableau `vault[]` agrège les 3 sources de coffre accessibles au user du `PluginToken`. Format aligné sur le contrat de l'extension (`target` + slugs au lieu de noms libres, pour identification stable) :

```json
{
  "services": [...],
  "accounts": [...],
  "vault": [
    {
      "id": "ck...",
      "target": "personal",
      "name": "Gmail perso",
      "url": "https://gmail.com",
      "username": "gael@gmail.com",
      "password": "...",
      "totpSecret": "JBSWY3DPEHPK3PXP",
      "tags": ["perso"]
    },
    {
      "id": "ck...",
      "target": "team_org",
      "orgSlug": "argoweb",
      "collectionSlug": "outils-internes",
      "name": "Notion agence",
      "url": "https://notion.so",
      "username": "admin@argoweb.fr",
      "password": "...",
      "totpSecret": null,
      "tags": []
    },
    {
      "id": "ck...",
      "target": "team_project",
      "projectSlug": "voyages",
      "collectionSlug": "comptes-test",
      "name": "Compte staging",
      "url": "https://staging.voyages.fr",
      "username": "test@voyages.fr",
      "password": "...",
      "totpSecret": null,
      "tags": []
    }
  ]
}
```

- `totpSecret` : secret base32 du TOTP du site cible si configuré (cf. §4.10.6), sinon `null`. L'extension calcule le code 6 chiffres localement.
- `tags` : array de tags (peut être vide).

**Logique de match** (identique pour les 3 sources) :
- Hostname strict via `URL().hostname` — `portal.stripe.com` ≠ `stripe.com`
- `VaultEntry.url` (perso) et `TeamVaultEntry.url` (équipe) sont la source de vérité
- L'absence de `url` ou un parse failed → entrée écartée silencieusement

**Logique d'accès** ([lib/vault-access.ts](../lib/vault-access.ts) `getAccessibleCollectionIds`) :
- `target: "personal"` → uniquement `VaultEntry.userId === session.userId` (le user du token plugin)
- `target: "team_org"` / `"team_project"` → `TeamVaultEntry` des collections accessibles via les 4 voies habituelles : global ADMIN / OrgADMIN+ (sur l'org parente) / TeamVaultMember explicite / ProjectMember (héritage RBAC pour collections projet)
- Aucune jointure ne fuite — un user MEMBER d'une org sans `TeamVaultMember` sur une collection ne voit aucune de ses entrées

**Audit `PLUGIN_CREDENTIALS_FETCH`** : `metadata` contient `vault_count`, `vault_personal`, `vault_org`, `vault_project` en plus de `services_count` / `accounts_count`. Permet de tracer la provenance des credentials utilisés par l'extension.

#### 4.10.4 Move : déplacer une entrée du coffre perso vers une collection d'équipe ✅

Permet à l'utilisateur de **promouvoir** une entrée perso vers un coffre d'équipe (org ou projet). Sens unique — le reverse (équipe → perso) reste hors V1 pour éviter les faux sentiments de propriété sur des secrets potentiellement déjà copiés par d'autres membres.

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/vault/destinations` | Arborescence orgs + projets accessibles avec leurs collections EDITOR+. Pré-rempli pour le dialog "Déplacer vers..." |
| POST | `/api/vault/entries/[id]/move` | Body : `{ target: "team_org"\|"team_project", orgSlug?, projectSlug?, collectionSlug }`. Vérifie ownership source + EDITOR+ cible, transaction Prisma : create `TeamVaultEntry` (re-encrypt password + totpSecret avec nouvel IV) → delete `VaultEntry`. Audit `VAULT_ENTRY_MOVE` avec `metadata.from`/`fromEntryId`/`to`/`collectionId` |

**UI** : bouton "Déplacer" sur chaque entrée du coffre perso ouvrant un dialog avec sélecteurs en cascade (scope org/projet → parent → collection).

#### 4.10.5 Plugin auto-save (`POST /api/plugin/vault`) ✅

Endpoint consommé par la fonctionnalité auto-save de l'extension : quand l'utilisateur soumet un formulaire de login détecté, l'extension propose de créer/mettre à jour le credential dans son coffre. Tout est sauvegardé dans le **coffre personnel par défaut** (la promotion vers une collection d'équipe se fait ensuite via §4.10.4 — séparation volontaire pour réduire le risque de mis-clic au moment du save).

**Body** :

```json
{
  "action": "create" | "update",
  "id": "ck...",                  // requis si action=update
  "target": "personal" | "team_org" | "team_project",
  "orgSlug": "argoweb",            // requis si target=team_org
  "projectSlug": "voyages",        // requis si target=team_project
  "collectionSlug": "outils",      // requis si target=team_*
  "name": "gmail.com",
  "url": "https://gmail.com",
  "username": "gael@gmail.com",
  "password": "...",
  "tags": []
}
```

**Réponse** : `{ id, created: boolean }` (201 si create, 200 si update).

**RBAC** :
- `target=personal` → toujours autorisé pour le user du token
- `target=team_org` → résolution org + collection (OWNER/ADMIN org → OWNER implicite, sinon `TeamVaultMember`), refuse si role < EDITOR
- `target=team_project` → résolution projet + collection (héritage RBAC projet), refuse si role < EDITOR
- 404 silencieux si org/projet/collection inconnu (anti-leak), 403 si VIEWER

**Rate limit** : 30 écritures / 60s / user (anti-abus form submit en boucle), key `plugin-vault-write:{userId}`.

**Audit** : `VAULT_ENTRY_CREATE` ou `VAULT_ENTRY_UPDATE` avec :
- `metadata.source` inchangé (`"personal" | "org" | "project"`)
- `metadata.origin: "plugin_autosave"` (nouveau, distingue de l'UI web)
- `metadata.domain: <hostname>` extrait de l'URL

**Implémentation** : [app/api/plugin/vault/route.ts](../app/api/plugin/vault/route.ts). CORS check + Bearer plugin token + résolution scope inline (pas de partage avec la web UI car la web utilise `requireUser()` session NextAuth, le plugin a un user ID direct via le `PluginToken`).

#### 4.10.6 TOTP des sites tiers ✅

L'utilisateur peut stocker, en plus du mot de passe, le **secret TOTP du site cible** (Gmail, GitHub, AWS...). L'extension calcule le code 6 chiffres localement et le copie / l'auto-fill dans les champs `autocomplete="one-time-code"`. C'est ce que font Bitwarden / 1Password / Proton Pass.

**Schema** : `VaultEntry` et `TeamVaultEntry` reçoivent 3 colonnes optionnelles :

```
encryptedTotpSecret  TEXT
totpSecretIv         TEXT
totpSecretTag        TEXT
```

Même infrastructure de chiffrement que `password` (AES-256-GCM, `ENCRYPTION_KEY`). Migration `20260504060000_vault_entry_totp`.

**Tradeoff sécurité connu** : stocker mdp + 2FA dans le même coffre dilue la promesse "2 facteurs distincts" — si Physalis est compromis (clé maître leakée, vol d'un poste avec session valide), les deux facteurs tombent. C'est le compromis adopté par toute l'industrie (le marché a tranché côté praticité). L'option reste **par entrée** : le champ TOTP est optionnel, on n'ajoute pas le 2FA des comptes les plus sensibles (banque, prod) et on garde Authy à côté.

**Validation** : [lib/otpauth-parse.ts](../lib/otpauth-parse.ts) accepte deux formats utilisateur :
1. Secret base32 brut (avec ou sans espaces/tirets, casse libre) — ex. `JBSWY3DPEHPK3PXP`
2. URI complète `otpauth://totp/...?secret=...&issuer=...` (parse + extract)

V1 : algo SHA-1 / 6 digits / 30s par défaut (>99% des sites). Les options `algorithm`/`digits`/`period` des URI otpauth sont ignorées en V1.

**API** :
- `POST /api/vault/entries` + `PATCH /api/vault/entries/[id]` (perso) acceptent un champ `totpSecret` optionnel
- Idem pour les routes team (`/api/vault/org/.../entries`, `/api/vault/project/.../entries`)
- `GET /api/vault/entries/[id]` (reveal) retourne `totpSecret: string | null`
- Liste : pas de secret en clair, juste un booléen `hasTotpSecret` (badge "🔐 2FA" dans l'UI)
- Plugin match : champ `totpSecret` dans le bundle (cf. §4.10.3)

**Côté extension** : [src/lib/totp.ts](../../secretvault-extension/src/lib/totp.ts) — générateur TOTP RFC 6238 pur Web Crypto (HMAC-SHA1, base32 decode inline). Vérifié par les 4 vecteurs RFC officiels. Le popup affiche `287 082 · 18s` avec countdown live + boutons Copier / Remplir. L'auto-fill cible en priorité `input[autocomplete="one-time-code"]` (standard W3C) puis fallback heuristique sur `name|id` contenant `otp/totp/2fa/verification`.

### 4.11 Tokens d'intégration (Phase 11)

Deux types de tokens Bearer pour les intégrations tierces (N8n, Make, Zapier) — distincts des `MachineToken` (scopés project+env).

#### UserToken (`sv_user_<32hex>`)

Scopé à un `User`. Donne accès en lecture aux projets dont l'user est ProjectMember (au rôle effectif). Le token survit tant que l'user existe. Indexé dans `admin.TokenIndex (kind=USER)`.

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/user-tokens` | session | Liste mes UserTokens (sans hash, juste prefix + métadonnées) |
| POST | `/api/user-tokens` | session | Crée. Body : `{ name, expiresAt? }`. Token brut retourné **une seule fois**. Indexé dans TokenIndex. |
| DELETE | `/api/user-tokens/[id]` | session | Soft-revoke. Audit `USER_TOKEN_REVOKED` |

**Consommation** : `GET /api/secrets/[slug]/[env]` accepte `Authorization: Bearer sv_user_<hex>`. Validation via `validateUserToken()` → vérifie VIEWER+ effectif sur le projet/env. Audit `SECRET_FETCH_BULK` avec `actorTokenName`.

#### OrgToken (`sv_org_<32hex>`)

Scopé à une `Organization`. Survit au départ du user créateur (FK `createdById` SetNull). Scopes : `SECRETS_READ` (seul scope V1). Périmètre projets : `allProjects=true` ou `allowedProjectIds=[...]`. Indexé dans `admin.TokenIndex (kind=ORG)`.

| Méthode | Route | Auth requis | Description |
|---|---|---|---|
| GET | `/api/orgs/[slug]/org-tokens` | OrgADMIN | Liste (sans hash) |
| POST | `/api/orgs/[slug]/org-tokens` | OrgADMIN | Body : `{ name, description?, allProjects, allowedProjectIds?, allowedScopes, expiresAt? }`. Token brut **une seule fois**. |
| PATCH | `/api/orgs/[slug]/org-tokens/[id]` | OrgADMIN | Update partiel `{ name?, description?, allProjects?, allowedProjectIds?, allowedScopes?, expiresAt? }` |
| DELETE | `/api/orgs/[slug]/org-tokens/[id]` | OrgADMIN | Soft-revoke |
| POST | `/api/orgs/[slug]/org-tokens/[id]/regenerate` | OrgADMIN | Regénère le token. Le nouveau brut est retourné une seule fois ; `TokenIndex` est mis à jour. |

**Consommation** : `GET /api/secrets/[slug]/[env]` accepte `Authorization: Bearer sv_org_<hex>`. Validation via `validateOrgToken()` → vérifie scope `SECRETS_READ` + accès au projet/env (allProjects ou liste). Les OrgSecrets (`/api/orgs/[slug]/secrets`) ne sont **jamais** accessibles via OrgToken.

> **RBAC DEV guard** : la création d'OrgToken est gardée côté API par un check `OrgRole >= ADMIN`. Les rôles DEV/MEMBER ne peuvent pas créer de tokens org (ils ont des UserTokens).

---

### 4.12 SecretRequest (Phase 12.5)

Flux pour collecter un secret auprès d'un tiers externe sans l'exposer en clair.

**Flux** :
1. Admin crée une demande → reçoit `{ requestUrl, privateKey }`. La `privateKey` ECDH P-256 est retournée **une seule fois** (à stocker dans son propre coffre).
2. Le lien `https://vault.physalis.cloud/request/<token>` est envoyé au tiers.
3. Le tiers ouvre le lien (public, pas de compte requis), entre la valeur → chiffrée ECDH côté client → `POST /api/public/secret-requests/[token]/submit`.
4. Admin ouvre la demande dans l'UI → `POST /api/secret-requests/[id]/reveal` (fournit sa `privateKey`, déchiffrement côté client) → valeur plaintext.
5. Import en un clic → `POST /api/secret-requests/[id]/import`.

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/secret-requests` | session DEV+ | Liste les demandes (scope orgs du user). Query : `?org=`, `?project=`, `?status=` |
| POST | `/api/secret-requests` | session DEV+ | Crée. Body : `{ label, organizationId, projectId?, environmentName?, secretKey?, recipientEmail? }`. Retourne `{ id, requestUrl, privateKey, expiresAt }`. Si `recipientEmail`, envoie email auto. |
| GET | `/api/secret-requests/[id]` | session DEV+ | Détail (statut dérivé, pas la valeur chiffrée) |
| POST | `/api/secret-requests/[id]/reveal` | session DEV+ | Body : `{ privateKey }`. Déchiffrement ECDH côté serveur → retourne `{ value }`. Pose `viewedAt`. |
| POST | `/api/secret-requests/[id]/import` | session DEV+ | Importe la valeur dans `(project, env, secretKey)`. Pose `importedAt`. Efface le ciphertext de la DB. |
| DELETE | `/api/secret-requests/[id]` | session DEV+ | Révoque (pose `revokedAt`, efface ciphertext). |
| GET | `/api/public/secret-requests/[token]/public` | — (public) | Lecture pour la page externe : `{ label, description, expiresAt, publicKeyJwk }`. 404 si expiré/révoqué. |
| POST | `/api/public/secret-requests/[token]/submit` | — (public) | Body : `{ encryptedSecret, secretIv, ephemeralPublicKey }`. Pose `submittedAt`. Rate-limit 5/5min/IP. |

Statuts dérivés (pas stockés en DB) : `pending` → `received` → `imported` / `revoked` / `expired`.

**Sécurité post-quantique** (Phase 1, livrée 2026-06-07) : l'échange de clés est désormais **hybride ECDH P-256 + ML-KEM-768** (combineur HKDF-SHA256 avec binding du transcript, pas de XOR) — résistant à un futur ordinateur quantique. La `privateKey` retournée est **composite** `{v, ecdh, mlkem}`. Rétro-compatible : les demandes pré-PQC (ECDH seul) restent déchiffrables (`hybridVersion=null`). Fichiers : [lib/pqc.ts](../lib/pqc.ts) (ML-KEM-768 via `@noble/post-quantum`), [lib/hybrid-kem.ts](../lib/hybrid-kem.ts), migration `20260605120000_secret_request_pqc` (colonnes `mlkemPublicKey`/`mlkemCiphertext`/`hybridVersion`). Détail : [steps-docs/done/securite-post-quantique.md](steps-docs/done/securite-post-quantique.md).

---

### 4.13 API Gateway (Phase 13)

Proxy de validation de clés API pour les services exposés par les projets. Deux modes : `REMOTE` (clés SHA-256 hashées dans Physalis) et `JWT` (validation d'un JWT signé avec un secret chiffré dans l'Api).

**Modèles** : `Api` / `ApiKey` / `ApiLog` dans le schéma tenant. Clés préfixées `ph_live_sk_*` (env live) ou `ph_test_sk_*` (env test) — format similaire Stripe.

#### Routes de gestion (UI interne)

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/gateway/apis` | ProjectEDITOR+ | Liste les APIs du projet. Query : `?project=<slug>` |
| POST | `/api/gateway/apis` | ProjectEDITOR | Crée. Body : `{ name, projectId, mode?, description?, url?, liveEnvId?, testEnvId?, defaultRateLimit?, defaultRateLimitWindow?, jwtSecret? }` |
| GET | `/api/gateway/apis/[id]` | ProjectEDITOR | Détail API + liste clés actives (sans hash) |
| PATCH | `/api/gateway/apis/[id]` | ProjectEDITOR | Update partiel |
| DELETE | `/api/gateway/apis/[id]` | ProjectEDITOR | Supprime (cascade keys + logs) |
| GET | `/api/gateway/apis/[id]/keys` | ProjectEDITOR | Liste clés actives (prefix, name, scopes, rateLimit, lastUsedAt, revokedAt) |
| POST | `/api/gateway/apis/[id]/keys` | ProjectEDITOR | Crée clé. Body : `{ name, description?, scopes?, rateLimit?, expiresAt? }`. Clé brute retournée **une seule fois**. Indexée dans `TokenIndex (kind=API_KEY)`. |
| GET | `/api/gateway/apis/[id]/logs` | ProjectEDITOR | Logs paginés. Query : `?limit=`, `?cursor=` |
| GET | `/api/gateway/apis/[id]/stats` | ProjectEDITOR | Compteurs (total calls, valid/invalid, par clé) |
| PATCH | `/api/gateway/keys/[id]` | ProjectEDITOR | Update clé (name, scopes, rateLimit) |
| DELETE | `/api/gateway/keys/[id]` | ProjectEDITOR | Soft-revoke |

#### Endpoint de vérification (client externe)

| Méthode | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/gateway/verify` | `Authorization: Bearer ph_live_sk_*` (dans body ou header) | Body : `{ apiId, key, scope? }`. Valide la clé → retourne `{ valid: true, keyId, scopes }` ou `{ valid: false, reason }`. Log l'appel dans `ApiLog`. Rate-limit 1000/min/IP (global, pas par clé). |

Retours : `200 { valid: true }` | `200 { valid: false, reason }` | `400` (body invalide) | `404` (Api inconnue) | `429` (rate-limit).

**Rotation API_KEY** : un `Secret` peut être lié à un `ApiKey` (champ `apiKeyId`). Le cron de rotation déclenche la stratégie `API_KEY` → révoque l'ancienne clé, crée une nouvelle via `POST /api/gateway/apis/[id]/keys`, stocke la nouvelle valeur dans le secret.

---

### 4.14 Versioning (Phase 10)

Chaque mise à jour d'un `Secret` ou `OrgSecret` crée une ligne dans `SecretVersion`/`OrgSecretVersion` avant l'écrasement. Rétention 50 versions max (cleanup automatique à l'INSERT).

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| GET | `/api/projects/[slug]/[env]/secrets/[key]/versions` | VIEWER | Liste les versions (sans valeur, avec `version` Int + `createdAt` + `createdBy`) |
| GET | `/api/projects/[slug]/[env]/secrets/[key]/versions/[version]` | VIEWER | Reveal d'une version (valeur déchiffrée) |
| POST | `/api/projects/[slug]/[env]/secrets/[key]/versions/[version]/rollback` | EDITOR | Restaure la version comme valeur courante (transaction : crée une nouvelle version de l'actuelle + écrase). Audit `SECRET_ROLLBACK` |
| GET | `/api/orgs/[slug]/secrets/[key]/versions` | OrgADMIN | Idem pour OrgSecret |
| GET | `/api/orgs/[slug]/secrets/[key]/versions/[version]` | OrgADMIN | Reveal version OrgSecret |
| POST | `/api/orgs/[slug]/secrets/[key]/versions/[version]/rollback` | OrgADMIN | Rollback OrgSecret |

---

### 4.15 Import `.env`

| Méthode | Route | Rôle requis | Description |
|---|---|---|---|
| POST | `/api/projects/[slug]/[env]/secrets/import` | EDITOR | Body : `{ content: string }` (contenu d'un fichier `.env`). Parse `KEY=VALUE` (commentaires `#` ignorés, multiline `"..."` supporté), chiffre et upsert chaque paire. Retourne `{ imported: N, skipped: M }`. |

---

### 4.16 Reset de mot de passe

| Méthode | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/forgot-password` | — (public) | Body : `{ email, tenant }`. Si l'user existe, crée un `PasswordResetToken` (TTL 1h) dans `admin`, envoie email avec lien `/reset-password/<token>`. Toujours 200 (anti-enumération). Rate-limit 3/h/IP. |
| POST | `/api/auth/reset-password` | — (public) | Body : `{ token, password }`. Valide le hash dans `admin.PasswordResetToken`, applique `bcrypt.hash` + update dans le schéma tenant via `withTenantSchema`, pose `usedAt`. |

---

### 4.17 Facturation Stripe (Phase 5 — LIVE depuis 2026-05-09)

Routes sous `/api/billing/*` — gardées par `requireUser()` + `requireOrgMember(slug, "OWNER")` implicite.

| Méthode | Route | Description |
|---|---|---|
| GET/POST | `/api/billing/preview` | Prévisualisation du prorata. Types : `addons`, `plan`, **`cart`** (plan + add-ons en une fois, pour la modale d'abonnement) |
| POST | `/api/billing/checkout` | Body : **panier** `{ plan, extraOrgs?, extraUsers?, extraServers?, extraOidcProjects?, extraEmail5k?, extraEmail15k?, extraEmail30k? }`. Crée une Stripe Checkout Session **multi line_items** (plan + add-ons) et retourne `{ url }`. Garde-fou FREE porté sur le **plan choisi** ; rejette seulement s'il existe déjà un abonnement Stripe **actif** |
| POST | `/api/billing/portal` | Crée une Stripe Customer Portal Session et retourne `{ url }` |
| POST | `/api/billing/change-plan` | Changement de plan self-service. **DB-only** si pas d'abonnement Stripe actif (TRIAL, FREE, ou ACTIVE ex-offert sans Stripe) ; sinon `subscription.update` proraté |
| POST | `/api/billing/update-addons` | Mise à jour des add-ons (orgs/sièges/serveurs/OIDC + **packs email** 5k/15k/30k) sur l'abonnement existant |
| POST | `/api/billing/update-subscription` | **Plan + add-ons en un seul `subscription.update`** (proration `always_invoice`). Utilisé par la modale d'abonnement en mode modification |
| POST | `/api/billing/downgrade-to-free` | Rétrograde au plan FREE (annule l'abonnement Stripe, reset add-ons inclus packs email, revient aux quotas FREE) |
| POST | `/api/webhook/stripe` | Webhook Stripe (signature HMAC `Stripe-Signature`). Idempotent via `StripeEventLog`. Gère `checkout.session.completed`, `customer.subscription.*`, `invoice.payment_failed`. **`parseAddonsFromItems`** synchronise plan + quantités d'add-ons (dont packs email) sur le `Client` |

**Modale d'abonnement « panier »** ([account/subscription-modal.tsx](../app/[locale]/(dashboard)/account/subscription-modal.tsx)) : ouverte depuis `BillingActions`. Cards plans (Shared / Dedicated grisé « Bientôt » via `dedicatedAvailable`) + compteurs add-ons + total live. Deux modes selon **`hasActiveSubscription`** (existence d'une `Subscription` ACTIVE, ≠ `stripeCustomerId`) : **création** (→ `/checkout` → redirection Stripe) ou **modification** (→ preview `cart` prorata → `/update-subscription`). Cohabite avec `PlanSelector` + `AddonControls`. Constantes prix/quotas dans [lib/plans.ts](../lib/plans.ts) (`PLAN_PRICE_CENTS`, `ADDON_*_PRICE_CENTS`, `ADDON_EMAIL_*`, `ADDON_ORG_BUNDLE`, `extraEmailsFromPacks`).

---

### 4.18 Cron

| Méthode | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/cron/rotation` | `X-Cron-Secret` | Déclenche la rotation automatique. Itère tous les tenants ACTIVE/TRIAL, cherche les `Secret` avec `rotationEnabled=true` et `rotationNextAt ≤ now`, **puis** les `ProjectEmailConfig` dus (rotation blue/green de la clé API email, cf. §4.20). Cf. §12. |
| POST | `/api/cron/trial-expiry` | `X-Cron-Secret` | Expire les tenants dont `trialEndsAt ≤ now` (TRIAL → SUSPENDED) + envoie emails J-7 / J-30. Skip les clients `comped=true`. |
| POST | `/api/cron/overage-reminders` | `X-Cron-Secret` | Envoie des rappels si quota orgs/users dépassé. |
| POST | `/api/cron/email-usage` | `X-Cron-Secret` | Resync le quota email (plan + packs) au relais + reset du compteur au passage de cycle (`emailUsageResetAt`). Quotidien (06:10 UTC). Cf. §4.20. |

Auth : `timingSafeEqual(sha256(X-Cron-Secret), sha256(CRON_SECRET))` — rejet 401 si absent ou invalide.

---

### 4.19 RGPD — export user

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/me/export` | session | Exporte les données personnelles du user connecté en JSON (profil, orgs, projets dont il est membre, coffre personnel, audit log). **`?scope=personal`** → profil + coffre perso uniquement (pour les membres non owner/admin, qui n'exportent pas les données du client). Utilisé par la section « Mes données » de `/account`. |

---

### 4.20 Email Pink-Floyd

Module permettant à chaque **projet** d'envoyer ses emails via **Pink-Floyd** (serveur d'envoi auto-hébergé, repo séparé `argo-web/pink-floyd`). 1 service email par projet, activé au niveau org.

**Quota & métrage (niveau CLIENT)** : le quota d'envoi est **au niveau du compte client / tenant** (un seul compte Pink-Floyd par tenant, `ClientEmailConfig`), **pas par org**. Quota effectif = `PLAN_QUOTAS[plan].maxEmailsPerMonth` (**Free 3 000 / Shared 12 000 / Dedicated 15 000**/mois) **+ packs email** souscrits (`extraEmailsFromPacks(client)` : +5000·extraEmail5k + 15000·extraEmail15k + 30000·extraEmail30k). Calcul dans [lib/email-usage.ts](../lib/email-usage.ts) `monthlyEmailQuota(plan, packs)` → poussé au relais via `setEmailQuota` (au connect + cron quotidien `/api/cron/email-usage`, qui resette le compteur au passage de cycle `emailUsageResetAt`). Le compteur `used` vit côté relais. *(Isolation email par org = sous-chantier différé ; `Organization.maxEmailsPerMonth`/`extraEmails` posés mais non branchés. Cap journalier Free 100/j à venir côté relais — cf. [todo_v2.md](todo_v2.md).)*

**Architecture**
- Physalis dialogue avec la **management API** de Pink-Floyd (header `X-Service-Key`, hors chemin runtime) : création de compte, domaines, clés, expéditeurs, historique.
- L'app cliente **envoie** via `POST /v1/send` (header `x-api-key` = clé du projet).
- Stockage : `ClientEmailConfig` (activation + compte Pink-Floyd partagé par tenant) et `ProjectEmailConfig` (domaine + **clé API chiffrée** + DNS). Les variables runtime (`PINK_FLOYD_API_KEY`, `PINK_FLOYD_DOMAIN`, `PINK_FLOYD_URL`) sont injectées dans le `.env` de chaque environnement **au déploiement** ([app/api/deploy/route.ts](../app/api/deploy/route.ts)), jamais stockées en `Secret` éditable.
- **Gating** (phase de test) : `isEmailModuleEnabled(email)` = `PINK_FLOYD_EMAIL_ENABLED === "true"` **ou** email ∈ `PINK_FLOYD_EMAIL_ALLOWED_EMAILS` ; routes → 404 si non autorisé (fail-closed).

**Routes org**

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/orgs/[slug]/email` | session, MEMBER | État du service (configuré / activé / compte). |
| POST | `/api/orgs/[slug]/email` | session, ADMIN | Active : crée/lie le compte Pink-Floyd (idempotent via `externalRef = org.slug`). |
| DELETE | `/api/orgs/[slug]/email` | session, ADMIN | Désactive (conserve compte + configs projet). |

**Routes projet**

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/projects/[slug]/email` | session, VIEWER | État : connecté, vérifié, domaine, DNS (toujours), variables, rotation. |
| POST | `/api/projects/[slug]/email/connect` | session, EDITOR | Enregistre le domaine (gère 409) + génère la clé API (persistée puis révoquée si l'écriture échoue). |
| POST | `/api/projects/[slug]/email/verify` | session, EDITOR | Vérifie les DNS, persiste `verified`. |
| DELETE | `/api/projects/[slug]/email` | session, EDITOR | Déconnecte : révoque la clé + supprime la config projet. |
| POST | `/api/projects/[slug]/email/send` | session, EDITOR | Envoi via `/v1/send` (rate-limit 20/min/user). `from` = expéditeur enregistré. |
| GET/POST | `/api/projects/[slug]/email/senders` | VIEWER / EDITOR | Liste / crée un expéditeur autorisé. |
| PUT/DELETE | `/api/projects/[slug]/email/senders/[id]` | session, EDITOR | Renomme / supprime un expéditeur. |
| GET | `/api/projects/[slug]/email/history` | session, VIEWER | Historique des envois du domaine (index par compte). |
| POST | `/api/projects/[slug]/email/reveal` | session, EDITOR | Révèle la clé API (audité `SECRET_REVEAL`, rate-limit 30/min/user). |
| PATCH | `/api/projects/[slug]/email/rotation` | session, EDITOR | Active/règle la rotation auto (gated `org.rotationFeatureEnabled`). |

**Rotation blue/green** : l'app lit la clé depuis son `.env` (propagé au redeploy), donc la révocation de l'ancienne clé est **différée d'un cycle** (fenêtre de grâce). Le cron (§4.18) crée la nouvelle clé + déclenche un redeploy, puis révoque l'ancienne au cycle suivant. Cf. [lib/rotators/pink-floyd-email.ts](../lib/rotators/pink-floyd-email.ts).

UI : onglet **Email** au niveau projet (à droite de Coffre), 4 sous-onglets Détails / Envoi / Expéditeurs / Historique. Sécurité : cf. [security.md §3.15](security.md).

---

### 4.21 Backup automatisé des projets

Sauvegarde automatique et **chiffrée GPG** des bases de données d'un projet, **zéro-touch** : aucun script à installer, aucune action manuelle sur les VPS, **sans changer la posture sécurité** (Physalis ne sort jamais en SSH, ne voit jamais les données en clair, ne détient jamais de clé privée). Validé en prod (2026-06-01). Spec : [steps-docs/backups-auto.md](steps-docs/backups-auto.md) ; contrat agent : [steps-docs/backup-agent-contract.md](steps-docs/backup-agent-contract.md).

**Principe — livraison par FUSION.** À `POST /api/deploy`, si un backup est activé pour l'environnement déployé, Physalis **fusionne** un service `physalis-backup-agent` dans le `dockerCompose` qu'il sert déjà ([lib/compose-merge.ts](../lib/compose-merge.ts)). L'agent monte au `docker compose up` habituel, rejoint **le réseau du service DB** (résolution par nom), et n'a aucun port exposé. Désactivation propagée : si le backup est coupé, le service n'est plus fusionné → l'agent disparaît au prochain deploy.

**Détection.** [lib/compose-detect.ts](../lib/compose-detect.ts) — `detectDatabases(dockerCompose, secrets)` repère les services DB (image postgres/mysql/mariadb), leur hôte (= nom du service), nom, user, et la **clé du secret mot de passe** (`POSTGRES_PASSWORD`…). Multi-DB. Pré-remplit le formulaire (champs éditables). Route `GET /api/projects/[slug]/backup/detect`.

**Posture / secrets.** Les mots de passe DB sont **déjà** dans le `.env` du projet → l'agent les **référence** (`${VAR}`), Physalis ne les duplique pas. Physalis n'ajoute au `.env` servi que `BACKUP_TOKEN` (token agent) + `BACKUP_DEST_KEY_B64` (clé SSH destination, base64). La **paire GPG est générée par l'agent sur le VPS** ; la privée ne sort jamais ; Physalis ne stocke que la **pubkey** + fingerprint. Le token agent est stocké chiffré (injection) **et** hashé (vérification).

**Modèle de données** (schéma tenant) : `ClientBackupConfig` (activation + **destination au niveau client** : `backupServerId` → Server + `backupPath` ; chemin effectif d'un projet = `{base}/{slug}`), `ProjectBackupConfig` (env source, planning, rétention, état, token agent), `ProjectBackupDatabase` (**1-N** : dbType/dbName/dbHost/dbUser/passwordSecretKey/port/enabled), `ProjectBackupEntry` (historique rempli par l'agent). Enums `BackupDbType`/`BackupEntryStatus`, actions `AccessAction` `BACKUP_*`.

**Agent** (repo dédié `argo-web/physalis-backup-service`, image `ghcr.io/argo-web/physalis-backup-agent`) : sidecar alpine. 1ᵉʳ boot → génère la clé GPG (batch `%no-protection`) + publie la pubkey. Boucle (~60 s) : poll planning + `force` ; à l'échéance, pour chaque DB → `pg_dump`/`mysqldump | gzip | gpg --encrypt(pub) | rsync --mkpath` vers le VPS de destination, puis report. **Un agent par projet** (cloisonnement : chaque agent n'a que son réseau + ses secrets + son token).

**Protocole agent ↔ Physalis** (auth `Authorization: Bearer sv_backup_*`, hors session) :

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/backup/agent/register` | Publie la pubkey GPG + fingerprint (1ʳᵉ exécution). |
| GET | `/api/backup/agent/plan` | Planning (enabled, schedule, interval, retention, force) + liste DBs. Poll. |
| POST | `/api/backup/agent/report` | Résultat d'un backup → `ProjectBackupEntry` + maj config + audit. |

**API REST (UI)** : `GET/PATCH/DELETE /api/projects/[slug]/backup`, `POST …/backup/enable`, `POST …/backup/force`, `GET …/backup/entries`, `GET …/backup/detect`, `POST …/backup/agent-token` (révéler une fois — fallback hors-Physalis) ; `GET/POST/DELETE/PATCH /api/account/backup` (activation + destination, niveau client). **Watchdog** : [lib/backup-cron.ts](../lib/backup-cron.ts) (dead-man's switch — alerte si un backup attendu ne remonte pas ; n'exécute rien). Gating visibilité UI : `isBackupModuleEnabled(email)` (`BACKUP_ENABLED` ou allowlist `BACKUP_ALLOWED_EMAILS`).

**Prérequis destination** (one-time par VPS de backup, comme un serveur de déploiement) : (a) clé SSH du `Server` autorisée pour l'utilisateur SSH ; (b) **chemin de base inscriptible** par cet utilisateur (`chown`). Durcissement prévu (V1.1) : clé en forced-command **`rrsync` append-only**.

UI : onglet **Backup** au niveau projet (select env + table multi-DB éditable, « Forcer » avec loader + auto-refresh, historique) ; activation + destination au niveau client dans **Paramètres → Sécurité**.

---

### 4.9 Codes de retour

| Code | Cas |
|---|---|
| 200 | OK |
| 201 | Création |
| 400 | Body invalide |
| 401 | Pas de session, token absent, token invalide ou révoqué |
| 403 | Role insuffisant, ou token machine sur mauvais (slug, env) |
| 404 | Projet/env/secret/token introuvable, registration off |
| 409 | Slug projet déjà pris, email déjà inscrit, policy duplicate |
| 422 | Endpoint OIDC : policy OK mais env sans serveur/deployPath |
| 429 | Rate-limit (login, register, deploy) |

---

## 5. Chiffrement

[lib/crypto.ts](../lib/crypto.ts).

```
algorithm:  AES-256-GCM
key:        ENCRYPTION_KEY (env, 32 bytes / 64 hex)
iv:         12 bytes random par chiffrement
auth tag:   16 bytes
storage:    encryptedValue/iv/tag en base64
```

Tables qui stockent des données chiffrées avec ce schéma :

- `Secret` (env-level) : la valeur seule chiffrée, clé en clair
- `OrgSecret` (org-level) : idem, ex. `GITHUB_DISPATCH_TOKEN`
- `Service` : blob JSON `{user, password}` (champs `encryptedData`/`iv`/`tag`)
- `AppAccount` : blob JSON `{user, password}`
- `User` : `twoFactorSecret`/`Iv`/`Tag` (TOTP de Physalis lui-même, cf. §6.2)
- `Server` : `encryptedKey`/`Iv`/`Tag` (clé SSH privée des VPS cibles)
- `VaultEntry` (coffre perso) : `encryptedPassword`/`Iv`/`Tag` + `encryptedTotpSecret`/`Iv`/`Tag`
- `TeamVaultEntry` (coffres d'équipe) : idem que `VaultEntry`
- `Api` (mode JWT) : `jwtSecret`/`iv`/`tag`
- `SecretVersion` / `OrgSecretVersion` : snapshot chiffré (même schéma AES-256-GCM)

**Pas chiffré AES-256-GCM** : `ApiKey` (hash SHA-256 du token brut via `TokenIndex`, jamais reconstruit), `UserToken` / `OrgToken` (idem — uniquement hash stocké).

Génération de la clé : `openssl rand -hex 32`.

Invariants :

- **IV unique par appel** (donc deux chiffrements de la même valeur produisent des stockages différents).
- **Auth tag GCM** vérifié à la lecture (corruption du payload ou du tag → exception au déchiffrement).
- La clé est lue à chaque appel d'`encrypt`/`decrypt` via `getKey()`, qui valide la longueur 32B avant utilisation. Si `ENCRYPTION_KEY` change entre deux runs, les anciens secrets deviennent illisibles (pas de re-keying automatique).

### 5.1 Backups plateforme — chiffrement par enveloppe (OpenBao)

Le backup de Physalis lui-même (primaire → secondaire, `scripts/backup/`) est passé du chiffrement **GPG** (clé privée colocalisée avec les archives sur le secondaire) à un **chiffrement par enveloppe** adossé à un **KMS self-hosté** (OpenBao, moteur `transit`). **Cutover terminé (2026-06-13)** : physalis + nginx sont chiffrés par enveloppe, la clé GPG est **retirée du secondaire** (en escrow, password manager) — le secondaire ne détient plus aucune clé de déchiffrement sur disque, et le restore-test reste automatique (auth machine OpenBao). Détail : [steps-docs/todo/openbao.md](steps-docs/todo/openbao.md) + [backup-pilote-openbao-plan.md](steps-docs/done/backup-pilote-openbao-plan.md).

- **Principe** : DEK AES-256 aléatoire **par archive** (format `.db.penv` = AES-256-CTR + HMAC-SHA256, *encrypt-then-MAC* — `openssl enc -aes-256-gcm` exclu car tag GCM non géré en CLI), wrappée par OpenBao (`transit/datakey`). Le **primaire** a la capacité `datakey` **seule** → il chiffre **sans pouvoir déchiffrer** ses backups ; le **secondaire** a `decrypt` **seule** → il déchiffre via `transit/decrypt`. La DEK ne touche **jamais** le disque. **PQ-safe** (wrap symétrique AES-256).
- **Identités** : AppRole CIDR-bound, token TTL court ; `secret_id` en fichier `0600` livré en response-wrapping ; cert OpenBao **épinglé**.
- **Scripts** : `scripts/backup/lib/penv.sh` (AEAD), `primary/physalis-dump-penv.sh`, `secondary/{penv-openbao.sh, physalis-pull-backup-penv.sh, physalis-restore-penv.sh, physalis-test-restore-penv.sh}`. Monitoring seal-status : `scripts/failover/secondary/secretvault-check-openbao.sh` (un reboot **rescelle** OpenBao single-node → backups muets sinon).
- **À distinguer** des **backups projets clients** (§4.21, système ①, GPG) : ici c'est le backup **de la plateforme** (système ②). Même direction enveloppe+KMS prévue pour ① ensuite.
- **Cible long terme** : OpenBao remplace aussi la `ENCRYPTION_KEY` statique (ci-dessus) — audit, rotation et scellement de la clé maîtresse — par migration champ par champ.

---

## 6. Authentification

### 6.1 Web (NextAuth v5)

Split en deux fichiers pour respecter Edge runtime du middleware :

- [lib/auth.config.ts](../lib/auth.config.ts) — config minimale Edge-compatible (jwt/session callbacks). Importée par `middleware.ts`.
- [lib/auth.ts](../lib/auth.ts) — config complète Node-only (provider `Credentials`, bcrypt, otplib, decrypt). Importée par les routes API et server components.

Connexion : email + mot de passe → `bcrypt.compare`. Si le user a `twoFactorEnabled`, exige aussi un `totpCode` (TOTP 6 digits OU backup code 16 hex). Le credential additionnel `tenantSlug` (string) est dérivé côté client (URL param `?tenant=` ou subdomain `<slug>.physalis.cloud`) et envoyé dans le corps du `signIn()` — `authorize()` valide que le tenant existe et qu'il n'est ni SUSPENDED ni CANCELLED, puis route le lookup user via `withTenantSchema(tenantSlug, ...)`. Si tenantSlug=null (`vault.physalis.cloud` sans `?tenant=` ou autre origine), `authorize()` reste en mode legacy `public`.

Erreurs spécifiques surfacées via `CredentialsSignin.code` (NextAuth v5) :

- `"2fa_required"` : password OK mais 2FA active et pas de code → frontend affiche le champ TOTP
- `"2fa_invalid"` : code TOTP / backup invalide

Single-step UX : un seul formulaire avec champ TOTP qui apparaît dynamiquement à la 2e tentative si `code === "2fa_required"`. Pas de session intermédiaire `pending2FA`, pas de page `/login/2fa` séparée.

Backup codes : 8 codes de 16 hex chars (64 bits), bcrypt-hashés en base, **one-shot** (le code utilisé est retiré de l'array). Validation séquentielle O(N) — acceptable à 8 codes (~2 s pire cas).

**Durée de session** : `session.maxAge = 8h` (28800s). Le JWT et le cookie expirent simultanément. Auth.js v5 force toujours un `expires` sur le cookie (hardcodé dans `@auth/core`), donc on ne peut pas avoir un vrai cookie session-only — mais avec 8h, le cas typique "je me reconnecte le matin" est couvert : après 8h, `auth()` rejette le JWT côté serveur et l'user est redirigé vers `/login` même si le cookie existe encore.

### 6.2 2FA TOTP

[lib/totp.ts](../lib/totp.ts) — wrapper otplib v13 + helpers backup codes.

- Secret TOTP : généré via `otplib.generateSecret()` (base32, ~32 chars), chiffré au repos avec la même `ENCRYPTION_KEY` que les Secrets métier (3 colonnes `twoFactorSecret`/`Iv`/`Tag`).
- QR code : généré côté serveur via `qrcode` (data URL inline) — le secret ne quitte pas le serveur via query string.
- Tolérance horloge : ±30 s autour de la fenêtre courante (`epochTolerance: 30`) pour gérer la dérive.
- `verifyTotp` catch les erreurs `TokenLengthError` d'otplib (quand on tente avec un backup code de 16 chars) et retourne false → fallback propre vers la vérification backup.

Les machine tokens ne sont **pas** affectés par la 2FA — c'est uniquement pour le flow web.

### 6.3 Machine (Bearer token)

[lib/auth-token.ts](../lib/auth-token.ts).

- `generateToken()` → `sv_<32 random hex bytes>` (préfixe `sv_` pour identification dans les logs / scans de secrets).
- Stockage : SHA-256(token) dans `MachineToken.tokenHash` (jamais le token brut).
- `validateToken(token)` :
  1. Préfixe `sv_` requis (rejet immédiat sinon).
  2. Lookup par hash, rejette si `revokedAt != null`.
  3. Met à jour `lastUsedAt` en arrière-plan (non bloquant).
  4. Retourne le token avec `project` et `environment` includés.

### 6.4 Middleware

[middleware.ts](../middleware.ts) — fait trois choses sur chaque requête HTML (matcher exclut `/api`, `/_next/*`, fichiers image et `.zip`, et skippe les prefetches RSC) :

1. **Routing locale** (i18n) : si le path n'a **pas** de préfixe `/fr/`, `/en/` ou `/es/`, redirige vers `/{locale}/{path}` où `locale` est résolu par cookie `NEXT_LOCALE`, sinon Accept-Language, sinon `defaultLocale` (`en`). Indispensable pour le routing App Router `[locale]/...`. La detection de tenant subdomain est faite séparément côté login-form (cf. §3.6) — le middleware ne fait aucune resolution de tenant.
2. **Auth check** : si la route préfixée `/dashboard`, `/projects`, `/orgs`, `/settings` (après strip du préfixe locale) ET pas de session → redirect `/{locale}/login?callbackUrl=…`. Le préfixe locale est préservé pour ne pas perdre la langue de l'utilisateur.
3. **Génère un nonce** (16 bytes hex via Web Crypto), construit le header `Content-Security-Policy` strict (cf. §8.1), pose le nonce sur le header de requête `x-nonce` pour que Next.js l'applique aux scripts d'hydration, et met le CSP sur la response (y compris les responses de redirect).

Utilise [lib/auth.config.ts](../lib/auth.config.ts) (Edge-compatible) — pas d'import de bcrypt/otplib qui ne tournent pas en Edge runtime.

> **Caveat cross-domain** : le redirect 307 du routing locale construit l'URL absolue à partir de `req.url`. Derrière Cloudflare avec rewrite de Host header, l'URL absolue peut pointer vers le mauvais host (typiquement `vault.physalis.cloud` au lieu du sous-domaine tenant), éjectant l'utilisateur de son tenant. C'est pourquoi tout `router.push("/foo")` ou `<Link href="/foo">` interne doit passer par les helpers `@/i18n/navigation` qui préfixent la locale côté client (cf. §6.5) — un path préfixé `/fr/foo` ne déclenche jamais le routing locale et reste sur le bon host.

### 6.5 Internationalisation (next-intl)

L'app est trilingue **FR / EN / ES** via [next-intl](https://next-intl.dev/) v3. Toutes les pages utilisateur vivent sous `app/[locale]/...` et le segment `[locale]` est résolu par le middleware (cf. §6.4).

#### Configuration

| Fichier | Rôle |
|---|---|
| [i18n/routing.ts](../i18n/routing.ts) | `defineRouting({ locales: ["en","fr","es"], defaultLocale: "en", localePrefix: "always" })`. La constante `routing` est consommée par le middleware ET par le helper de navigation. `localePrefix: "always"` signifie qu'aucune URL ne s'affiche sans préfixe — `/projects` est toujours redirigé vers `/{locale}/projects`. |
| [i18n/request.ts](../i18n/request.ts) | `getRequestConfig` qui résout la locale active côté server components + charge le bundle de messages correspondant. |
| [i18n/navigation.ts](../i18n/navigation.ts) | **Helper de navigation à utiliser dans tout le code client** (cf. plus bas). |
| [messages/{en,fr,es}.json](../messages/) | Bundles de messages, structure imbriquée par namespace (`auth.login.*`, `dashboard.layout.*`, `projects.access.*`, etc.). FR fait foi (source de vérité), EN/ES doivent rester alignés. |

Le bundle EN est volontairement notre `defaultLocale` côté next-intl — c'est la langue de fallback quand `Accept-Language` ne matche pas FR ou ES.

#### Helper `@/i18n/navigation`

**Règle de fer** : tout import depuis `next/link` ou `next/navigation` dans un composant `"use client"` rendu sous `app/[locale]/...` doit passer par `@/i18n/navigation`. Le helper expose :

```ts
import { Link, useRouter, usePathname, redirect, getPathname } from "@/i18n/navigation";
```

Ces wrappers préfixent automatiquement la locale courante :

- `<Link href="/projects">` rend `<a href="/fr/projects">` quand la locale active est `fr`.
- `router.push("/dashboard")` navigue vers `/fr/dashboard`.
- `usePathname()` renvoie le path **sans** préfixe locale (utile pour les comparaisons d'active route).

**Pourquoi c'est critique** : un `<Link>` ou un `router.push` venant de `next/link` / `next/navigation` ne préfixe rien et émet un path nu (`/projects`). Le middleware locale routing le redirige (`307 → /fr/projects`), mais le calcul de l'URL absolue derrière Cloudflare peut perdre le host original et envoyer l'utilisateur sur `vault.physalis.cloud` au lieu de son sous-domaine `<slug>.physalis.cloud`. La page `/fr/dashboard` rendue depuis vault déclenche alors le tenant-guard, l'éjecte vers `/fr/login` et boucle. La migration vers `@/i18n/navigation` (commit `6e031ab`) a corrigé 29 composants dashboard + 7 composants auth.

**Exceptions** : `useSearchParams`, `useParams`, `notFound`, `redirect` (server actions) restent sur `next/navigation` — ils n'ont pas d'équivalent dans le helper. `next/image` reste tel quel.

#### Côté server (RSC + server actions)

```ts
import { getLocale, getTranslations } from "next-intl/server";

const locale = await getLocale();
const t = await getTranslations("dashboard.layout");
return <h1>{t("title")}</h1>;
```

Les fonctions qui construisent des URLs externes côté tenant doivent passer la locale :

- `getTenantLoginUrl(plan, slug, { tenantDomain, sharedPortal, locale })` (cf. [lib/plans.ts](../lib/plans.ts)) — `locale` est optionnelle. Quand fournie (callers user-facing : login-resolve, dashboard logout, signup), l'URL retournée contient `/{locale}/login` au lieu de `/login` brut. Sans cette précaution, l'URL `https://<slug>.physalis.cloud/login` déclenche le routing locale du middleware + le caveat Cloudflare → éjection vers le portail partagé.
- Pour les contextes admin multi-destinataires (création client, emails superadmin), `locale` est omise volontairement : le destinataire final peut être dans une langue différente, le middleware résoudra à partir de son `Accept-Language`.

#### Côté client (composants)

```tsx
"use client";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";

export default function MyComponent() {
  const t = useTranslations("dashboard.nav");
  const locale = useLocale();
  const router = useRouter();
  return <Link href="/projects">{t("projects")}</Link>;
}
```

Pour les redirects entre sous-domaines (ex. extension auto-login `vault.* → <slug>.physalis.cloud`), construire l'URL avec la locale du composant : `https://${tenantSlug}.physalis.cloud/${locale}/login?autoLogin=1` plutôt que `/login` brut. Cf. [plugin-login-proposal.tsx:53](../app/[locale]/(auth)/login/plugin-login-proposal.tsx#L53).

#### Sélecteur de langue

[components/LocaleSwitcher.tsx](../components/LocaleSwitcher.tsx) — composant client partagé, affiché dans :

- Le header du layout dashboard ([app/[locale]/(dashboard)/layout.tsx](../app/[locale]/(dashboard)/layout.tsx#L124))
- Le coin haut-droit du layout auth ([app/[locale]/(auth)/layout.tsx](../app/[locale]/(auth)/layout.tsx)) — utile pour switcher avant de se connecter

Au clic : pose un cookie `NEXT_LOCALE=<lang>` (TTL 1 an, `SameSite=Lax`, path `/`) **avant** de naviguer, pour que le middleware route correctement aux requêtes suivantes. Navigation via `router.push("/${next}${pathnameWithoutLocale}")` — le path conserve la page courante traduite.

#### Ajouter une nouvelle clé

1. Ajouter dans `messages/fr.json` (source de vérité) avec la structure imbriquée appropriée.
2. Ajouter dans `messages/en.json` et `messages/es.json` la traduction correspondante au **même chemin imbriqué** (sinon next-intl renvoie la clé brute à l'exécution).
3. Consommer avec `useTranslations("namespace")` côté client ou `await getTranslations("namespace")` côté server.

Pour les chaînes paramétrées : `t("auth.welcome", { name: "Gael" })` avec `"welcome": "Bienvenue {name}"`. ICU MessageFormat supporté par défaut (plurals, sélecteurs, etc.).

---

## 7. Composants UI

Pages App Router sous `app/`.

| Path | Type | Rôle |
|---|---|---|
| `(auth)/layout.tsx` | server | Layout centré (flex centered, sans `max-w` global, chaque page choisit sa largeur) |
| `(auth)/login/page.tsx` | server | Layout flex `items-stretch` : image (logo PNG, `next/image fill`) à gauche, form à droite (même largeur `w-80`, hauteur de l'image étirée à celle du form). Lit `ALLOW_REGISTRATION` et le passe à `LoginForm` |
| `(auth)/login/login-form.tsx` | client | Form login, appelle `signIn("credentials", { redirect: false })` |
| `(auth)/register/page.tsx` | server | 404 si inscription off |
| `(auth)/register/register-form.tsx` | client | Form register → POST `/api/auth/register` puis auto-signIn |
| `(dashboard)/layout.tsx` | server | Header : logo + **org switcher** + nav + lien email→sécurité + bouton déconnexion |
| `(dashboard)/settings/security/page.tsx` | server | Page de gestion 2FA (lit l'état utilisateur) |
| `(dashboard)/settings/security/security-panel.tsx` | client | Wizard 3 étapes : activation (QR + secret), confirmation code, affichage backup codes ; désactivation avec code de confirmation |
| `(dashboard)/org-switcher.tsx` | client | Dropdown : liste mes orgs, switch via `POST /api/me/current-org`, création inline |
| `(dashboard)/dashboard/page.tsx` | server | Stats agrégées scopées sur l'org courante |
| `(dashboard)/projects/page.tsx` | server | Liste projets de l'org courante (cards : nom, slug, secrets count, tokens actifs) + `CreateProjectForm` |
| `(dashboard)/projects/create-project.tsx` | client | Form de création |
| `(dashboard)/projects/[slug]/page.tsx` | server | Fetch project + envs, vérifie membership (project ou org), passe à `ProjectView` |
| `(dashboard)/projects/[slug]/project-view.tsx` | client | **Tab bar grid 3 colonnes** : `[Accès]` à gauche, **envs centrés** (production/staging/développement, ordre figé), `[⚙]` à droite (OWNER seulement). Sous-onglets par env : Secrets / Machine tokens / docker-compose. Bouton ↻ Redeploy par env (EDITOR+) |
| `(dashboard)/projects/[slug]/access-panel.tsx` | client | Onglet Accès : 3 sections — cards d'env cliquables (URL grisé si non configurée) ; Services CRUD ; Comptes CRUD |
| `(dashboard)/projects/[slug]/secrets-panel.tsx` | client | Liste clés masquées + reveal (1×1) + ajout/édition/suppression |
| `(dashboard)/projects/[slug]/tokens-panel.tsx` | client | Création (token affiché 1 fois + Copier) + révocation |
| `(dashboard)/projects/[slug]/compose-panel.tsx` | client | Textarea YAML monospace, dirty-tracking, save/cancel ; lecture seule pour VIEWER |
| `(dashboard)/projects/[slug]/settings-dialog.tsx` | client | Modal OWNER : Identité (nom + slug, warning sur rename), GitHub Actions (repo + workflow), Environnements (CRUD inline avec URL) |
| `(dashboard)/orgs/[slug]/page.tsx` | server | En-tête org + lien Audit log + `OrgPanels` |
| `(dashboard)/orgs/[slug]/org-panels.tsx` | client | Tabs `Membres / Secrets globaux` + icône ⚙ → `OrgSettingsDialog` |
| `(dashboard)/orgs/[slug]/members-panel.tsx` | client | Liste membres, change rôle, retire (avec confirm), invitations en attente, form d'invite |
| `(dashboard)/orgs/[slug]/org-secrets-panel.tsx` | client | CRUD des org secrets (clé/valeur chiffrée, reveal one-by-one). ADMIN+ |
| `(dashboard)/orgs/[slug]/org-settings-dialog.tsx` | client | Modal : édit nom + zone dangereuse (delete avec double-confirm typant le nom) |
| `(dashboard)/orgs/[slug]/audit/page.tsx` | server | Page audit log de l'org (ADMIN+) |
| `(dashboard)/projects/[slug]/audit/page.tsx` | server | Page audit log du projet (EDITOR+) |
| `components/AuditLogTable.tsx` | client | Table paginée + filtre par action + bouton « Exporter CSV » + drawer metadata |
| `invite/[token]/page.tsx` | server | Preview invitation : 5 cas (invalide/expirée/déjà acceptée, non connecté + pas de compte → form register, non connecté + compte existe → login, mauvais email, OK) |
| `invite/[token]/accept-button.tsx` | client | Accepte → POST `/api/invitations/[token]` → switch org + redirect |
| `invite/[token]/register-form.tsx` | client | Crée le compte + accepte l'invitation (`POST /api/invitations/[token]/register-and-accept`) + auto-signIn |
| `app/page.tsx` | server | Redirige `/dashboard` ou `/login` selon session |
| `(dashboard)/dashboard/extension-install-prompt.tsx` | client | Détection de l'extension Physalis via marqueur DOM (`document.documentElement.dataset.secretvaultExt`, nom historique conservé) + event `secretvault-extension-ready` (poll 500ms × 6 essais ~3s). Si non installée, affiche un bouton "🧩 Installer l'extension" qui ouvre un modal avec détection navigateur (Chrome/Firefox via UA), instructions étape par étape spécifiques et lien de téléchargement vers `/physalis-extension-<version>-{chrome,firefox}.zip` (versionné, à bumper avec la constante `EXTENSION_VERSION` du composant) |
| `(dashboard)/dashboard/page.tsx` | server | Tableau de bord avec actions rapides, "Projets récents" (3 derniers déploiements), 3 cards stats (Organisation/Projets/Secrets) et "Activité récente" paginée + filtrée par catégorie (searchParams `?activity_filter=&activity_page=`) |

**Principe UX** : aucune valeur de secret n'est jamais transmise en masse au client. Chaque révélation déclenche un appel ciblé `GET /api/.../secrets/[key]`.

---

## 8. Sécurité

### 8.1 Headers HTTP

[next.config.ts](../next.config.ts) applique sur toutes les routes :

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

**CSP nonce-based** ([middleware.ts](../middleware.ts), cf. §6.4) appliqué sur toutes les routes HTML :

```
default-src 'self'
script-src 'self' 'nonce-<random>' 'strict-dynamic'   ← strict, pas d'unsafe-inline
style-src  'self' 'unsafe-inline'                     ← compromis (style="..." React)
img-src    'self' data: blob:                         ← data: pour le QR 2FA
font-src   'self'
connect-src 'self'
frame-ancestors 'none'
form-action 'self'
base-uri 'self'
object-src 'none'
upgrade-insecure-requests
```

Compromis explicite : `style-src 'unsafe-inline'` reste car React inline les attributs `style={{...}}` (utilisés un peu partout pour le fine-tuning) et les attributs HTML ne supportent pas les nonces. L'XSS via styles est nettement moins dangereuse qu'XSS scripts. En dev, `'unsafe-eval'` est ajouté à `script-src` pour HMR (retiré en prod).

### 8.2 Validation des entrées

| Champ | Regex / contrainte |
|---|---|
| Slug projet | `slugify()` : NFD, strip diacritiques, `[^a-z0-9]+ → -`, ≤ 60 chars |
| Nom env | `^[a-z][a-z0-9-]{0,30}$` |
| Clé secret | `^[A-Z][A-Z0-9_]{0,127}$` (compatible `.env`) |
| Mot de passe | ≥ 12 chars, hash bcrypt salt 12 |
| Email | regex simple + `.toLowerCase().trim()` |

### 8.3 Stockage

- Mots de passe : bcrypt 12 rounds.
- Tokens machine : SHA-256(token), jamais en clair.
- Secrets : AES-256-GCM, IV par secret, auth tag vérifié.
- DB sur réseau Docker `internal` (sans port exposé en prod).

### 8.4 RBAC

Vérifié à chaque route via `requireUser` → `requireOrgMember(slug, role)` ou `requireProjectMember(slug, role)` → `requireEnvironment(slug, env, role)`. Role rank comparé numériquement. Cf. §3.1 pour les niveaux global/org/project.

### 8.5 Rate limiting

[lib/rate-limit.ts](../lib/rate-limit.ts) — fenêtre fixe in-memory, clé `${scope}:${ip}`, cleanup auto 60s. Headers 429 standard (`Retry-After`, `X-RateLimit-*`). Détection IP via `x-forwarded-for` puis `x-real-ip`. Buckets actuels :

- `login` (`/api/auth/callback/credentials`) : 5 / 15 min / IP
- `register` (`/api/auth/register`) : 3 / h / IP, appliqué **avant** le toggle `ALLOW_REGISTRATION`
- `plugin-auth` (`/api/plugin/auth`) : 5 / 15 min / IP
- `plugin-vault-write` (`/api/plugin/vault`) : 30 / min / user (auto-save extension)
- `gateway-verify` (`/api/gateway/verify`) : 1000 / min / IP (global — pas par clé ; cf. §8.9)

État au niveau module : adapté pour 1 instance ; à swapper pour Postgres / Redis si scaling horizontal.

### 8.6 Cascade à la révocation d'un membre

Quand un OrgADMIN/OWNER retire un membre via `DELETE /api/orgs/[slug]/members/[userId]`, en transaction :
1. `ProjectMember.deleteMany` pour les projets de l'org.
2. `MachineToken.updateMany` : `revokedAt = now()` pour les tokens où `createdById = userId` ET `projectId in org.projects`.
3. `OrgMember.delete`.
4. **Purge prudente de l'orphelin** : si le user n'a plus aucun `OrgMember` ET un coffre perso vide → `User.delete` (sinon conservé). Cf. §3.5.

Garde-fou : refus 409 si tentative de retirer/rétrograder le dernier OWNER de l'org.

### 8.7 Logs (stdout)

Aucun `console.log` ne touche aux valeurs de secrets, tokens plaintext, ou mots de passe. `log: ["error", "warn"]` (dev) / `["error"]` (prod) côté Prisma.

### 8.8 Audit log persistant

Table `AccessLog` ([prisma/schema.prisma](../prisma/schema.prisma)) + helper [lib/audit.ts](../lib/audit.ts) `logAction()` (non-bloquant, fire-and-forget). Toutes les routes mutantes appellent `logAction()` avec :
- l'acteur (user OR machine token, dénormalisé via `actorUserEmail`/`actorTokenName`),
- la cible (organizationId/projectId/environmentId via FK SetNull, `secretKey` pour les actions sur secret),
- IP (`x-forwarded-for` → `x-real-ip`),
- metadata libre (par ex. ancien/nouveau rôle, count de tokens révoqués en cascade).

Actions tracées (cf. enum `AccessAction`) :

- **Secrets** : `SECRET_CREATE`, `SECRET_UPDATE`, `SECRET_DELETE`, `SECRET_REVEAL`, `SECRET_FETCH_BULK`
- **Machine tokens** : `TOKEN_CREATE`, `TOKEN_REVOKE`, `TOKEN_USE_FAILED`
- **Compose** : `COMPOSE_FETCHED` (récupération via Bearer)
- **Membres / invitations** : `MEMBER_INVITE`, `MEMBER_INVITE_ACCEPT`, `MEMBER_ROLE_CHANGE`, `MEMBER_REMOVE`
- **Projet** : `PROJECT_CREATE`, `PROJECT_UPDATE` (rename + slug + github fields), `PROJECT_DELETE`
- **Environnement** : `ENVIRONMENT_CREATE`, `ENVIRONMENT_UPDATE`, `ENVIRONMENT_DELETE`
- **Organisation** : `ORG_CREATE`, `ORG_UPDATE`, `ORG_DELETE`
- **Org secrets** : `ORG_SECRET_CREATE`, `ORG_SECRET_UPDATE`, `ORG_SECRET_DELETE`, `ORG_SECRET_REVEAL`
- **Services / comptes** : `SERVICE_CREATE`/`UPDATE`/`DELETE`/`REVEAL`, `ACCOUNT_CREATE`/`UPDATE`/`DELETE`/`REVEAL`
- **Redeploy** : `REDEPLOY_TRIGGERED` (status `success`/`failed` dans metadata)
- **Login** : `LOGIN_SUCCESS` (acteur user, metadata `{ provider: "credentials", twoFactor: bool }`), `LOGIN_FAILURE` (acteur `anonymous`, metadata `{ reason, email }` où `reason` ∈ `missing_credentials` \| `user_not_found` \| `invalid_password` \| `2fa_state_inconsistent`). Câblé dans `authorize()` côté NextAuth Credentials provider. Les logs liés à un user existant (succès, mauvais mdp) sont rattachés à la première org du user pour apparaître dans `/orgs/[slug]/audit` ; ceux sans user (user inexistant, credentials vides) ont `organizationId = null`
- **2FA** : `TWO_FACTOR_ENABLED` (activation OK), `TWO_FACTOR_DISABLED` (désactivation OK, metadata `acceptedVia` ∈ `totp` \| `backup`), `TWO_FACTOR_SUCCESS` (validation au login), `TWO_FACTOR_FAILURE` (code invalide à login ou désactivation), `BACKUP_CODE_USED` (login via backup, metadata `remaining`)
- **Coffres** : `VAULT_ENTRY_CREATE` / `_UPDATE` / `_DELETE` / `_REVEAL` / `_MOVE`, `VAULT_COLLECTION_CREATE` / `_DELETE`, `VAULT_MEMBER_ADD` / `_REMOVE` / `_ROLE_CHANGE`. Metadata `source` ∈ `personal` \| `org` \| `project` (scope) ; pour les actions issues de l'extension auto-save, `metadata.origin = "plugin_autosave"` + `metadata.domain` permet de filtrer les saves automatiques vs UI manuelle. `_MOVE` porte `metadata.from`/`fromEntryId`/`to`/`collectionId`
- **Plugin extension** : `PLUGIN_AUTH_SUCCESS` / `_FAILURE`, `PLUGIN_TOKEN_REVOKED`, `PLUGIN_CREDENTIALS_FETCH` (metadata `domain`/`services_count`/`accounts_count`/`vault_count`/`vault_personal`/`vault_org`/`vault_project`)

Consultation via UI (`/orgs/[slug]/audit`, `/projects/[slug]/audit`) ou API (`?format=csv` pour export RFC 4180). FK SetNull = les logs survivent à la suppression des entités.

### 8.9 Non couvert

Items en backlog (détails et statut à jour dans [todo_v2.md](todo_v2.md)) :

- **Rate limiting sur l'endpoint Bearer machine** (`/api/secrets/[slug]/[env]`) — token déjà 256 bits, brute-force impraticable. Utile pour détecter un token compromis en boucle. Faible priorité.
- **Rate limiting sur le login 2FA** — héritera du rate-limit global sur `/callback/credentials` ; une couche dédiée par utilisateur serait plus stricte. Non priorisé.
- **Rate limiting par clé API Gateway** (`/api/gateway/verify`) — actuellement 1000/min/IP global. Pas de limite par clé individuelle. Acceptable vu l'entropie (256 bits), mais un token compromis peut stresser le système.
- **Audit `DEPLOY_DENIED` hors tenant** — les tentatives avec JWT invalide avant résolution du tenant ne sont pas auditées (probes externes trop bruyantes). Une table `admin.deploy_denied` pourrait tracer les abus répétés.
- **Monitoring infrastructure** sur `/admin` (état serveurs, backups, replica WAL).
- **Scans automatiques** OWASP ZAP / nuclei — actifs en CI (`deploy-staging.yml`, jobs `zap` et `nuclei`, lancés après chaque deploy staging).

---

## 9. Infrastructure

### 9.1 Dockerfile

[Dockerfile](../Dockerfile) — multi-stage `node:22-alpine` :

1. `deps` — `npm ci` complet pour le build.
2. `prod-deps` — `npm ci --omit=dev` (inclut prisma CLI + ses transitives, ex. `effect`, qui ne sont pas tracées par le bundler standalone).
3. `builder` — `prisma generate` + `next build` (output `standalone`).
4. `runner` — copie le bundle standalone, override `node_modules` par `prod-deps` + `.prisma` du builder, copie le schema + `scripts/`. Tourne en user `nextjs:nodejs`.

CMD : `prisma migrate deploy && auto-apply-tenant-migrations.mjs && bootstrap-admin.mjs && node server.js`.

`auto-apply-tenant-migrations.mjs` ([scripts/auto-apply-tenant-migrations.mjs](../scripts/auto-apply-tenant-migrations.mjs)) — rejoue les migrations Prisma sur tous les schémas `client_*` existants au démarrage. Indispensable lors d'un déploiement qui ajoute des colonnes au schéma tenant (sinon les tenants non-provisionnés après la migration ont un schéma obsolète).

> **Caveat bootstrap** : si `_tenant_migration_log` d'un tenant est vide (première exécution), le script marque TOUTES les migrations actuelles comme appliquées sans les exécuter — il suppose que le tenant a été provisionné avec le schéma courant. Les tenants créés avant certaines migrations (ex. rotation 20260513+, api-gateway 20260515+) auront des colonnes manquantes. Symptôme : Prisma renvoie `P2022` sur des colonnes absentes (le `RETURNING *` implicite des `delete()`/`update()` sans `select` liste toutes les colonnes du modèle). Fix : appliquer manuellement les `ALTER TABLE` manquants via psql, puis les marquer dans `_tenant_migration_log`. Pour les nouveaux tenants : toujours les provisionner APRÈS que les migrations aient tourné sur le schéma template.

### 9.2 Docker Compose

| Fichier | Usage |
|---|---|
| [docker-compose.yml](../docker-compose.yml) | Stack locale complète : `app` (port 3001 sur l'hôte, build local) + `db` (réseau `internal`) |
| [docker-compose.dev.yml](../docker-compose.dev.yml) | Postgres seul (port 5434 hôte) pour `npm run dev` natif |
| [vps/production/docker-compose.yml](../vps/production/docker-compose.yml) | Stack prod : `app` tire l'image GHCR (`${IMAGE}`), branché sur `nginx_default` (NPM) + `internal`, hardening (`read_only`, `no-new-privileges`, limites CPU/mem/pids) |
| `vps/production/.env` | Configuration prod (gitignored), créé manuellement sur le VPS |

**Choix de ports en local** :

- App sur **3001** (3000 souvent occupé par Grafana sur l'hôte gael).
- Postgres dev sur **5434** (5432/5433 occupés par Postgres natif).

### 9.3 Variables d'environnement

| Variable | Usage | Génération |
|---|---|---|
| `DATABASE_URL` | URL Postgres | overridée par compose en prod |
| `DB_PASSWORD` | Postgres `POSTGRES_PASSWORD` | mot de passe fort |
| `ENCRYPTION_KEY` | AES-256, 32B hex. **Jamais en DB ni dans le code**, uniquement env du conteneur. Chiffre Secret/OrgSecret/Service/AppAccount/User.twoFactor**/Server.encryptedKey | `openssl rand -hex 32` |
| `OIDC_AUDIENCE` | Audience attendue dans le JWT GitHub OIDC (cf. `/api/deploy`). Recommandation : hostname public du vault | défaut `vault.physalis.cloud` |
| `PHYSALIS_TENANT_DOMAIN` | Domaine hôte des subdomains tenants (SHARED/DEDICATED) | défaut `physalis.cloud` |
| `PHYSALIS_SHARED_PORTAL` | Hostname du portail partagé pour les FREE et la rétrocompat SHARED | défaut `vault.physalis.cloud` |
| `OIDC_JWKS_URL` | Override du JWKS GitHub. **Tests uniquement** | défaut JWKS GitHub Actions |
| `PLUGIN_ALLOWED_ORIGIN` | Origin autorisée pour les endpoints `/api/plugin/*` (extension nav). Format `chrome-extension://<id>`. Plusieurs origins séparées par virgule. **Si non définie, les endpoints plugin retournent 403 — désactivation par défaut** | non définie (plugin désactivé) |
| `PLUGIN_SESSION_TTL` | Durée de vie d'un PluginToken en secondes | défaut `14400` (4h) |
| `NEXTAUTH_SECRET` / `AUTH_SECRET` | JWT NextAuth | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | URL canonique (https). Fallback pour `buildAcceptUrl` si pas de `Host` header | — |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Bootstrap 1er admin | utilisé si `User` table vide |
| `ALLOW_REGISTRATION` | `"true"` ouvre `/register` | défaut `"false"` |
| `EMAIL_PINKFLOYD_URL` | URL du relay pink-floyd (active le transport principal). Sans cette var, fallback automatique vers Mailgun puis stub | `https://pink-floyd.argoweb.fr` |
| `EMAIL_PINKFLOYD_API_KEY` | Clé API pink-floyd (`ph_live_sk_*`) — header `x-api-key` | côté pink-floyd, à régénérer en cas de fuite |
| `EMAIL_MAILGUN_API_KEY` | Clé API Mailgun (fallback historique, conservé pendant la transition) | dashboard Mailgun |
| `EMAIL_MAILGUN_DOMAIN` | Domaine vérifié Mailgun (ex. `mail.physalis.cloud`) | dashboard Mailgun (DNS SPF + DKIM actifs) |
| `EMAIL_MAILGUN_HOST` | Endpoint API Mailgun | `api.mailgun.net` (US) ou `api.eu.mailgun.net` (EU) |
| `EMAIL_FROM` | Adresse expéditeur. pink-floyd **exige un email pur** (`contact@physalis.cloud`), pas le format RFC `Name <addr>`. Mailgun accepte les deux | défaut `contact@physalis.cloud` |
| `CRON_SECRET` | Auth `X-Cron-Secret` sur `/api/cron/*` et routes rotation admin N8n. Comparaison en `timingSafeEqual`. | `openssl rand -hex 32` (≥ 32 bytes recommandé) |
| `ROTATION_HMAC_KEY` | Signature HMAC-SHA256 des tokens callback N8n (window ±1h). Partagé entre Physalis et le workflow N8n. | `openssl rand -hex 32` |
| `ROTATION_N8N_WEBHOOK_URL` | URL du webhook N8n pour la stratégie `DATABASE` | URL du workflow N8n |
| `STRIPE_SECRET_KEY` | Clé secrète Stripe (sk_live_* ou sk_test_*) | Dashboard Stripe |
| `STRIPE_WEBHOOK_SECRET` | Secret de validation des webhooks Stripe (`whsec_*`) | Dashboard Stripe → Webhooks |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Clé publiable Stripe (exposée côté client) | Dashboard Stripe |
| `STRIPE_PRICE_SHARED_MONTHLY` | Price ID Stripe pour le plan SHARED mensuel | Dashboard Stripe |
| `STRIPE_PRICE_DEDICATED_MONTHLY` | Price ID Stripe pour le plan DEDICATED mensuel | Dashboard Stripe |
| `NEXT_PUBLIC_PHYSALIS_MARKETING_URL` | URL du site marketing (liens "En savoir plus" sur les plans) | défaut `https://physalis.cloud` |
| `PROJECT_NAME` | Nom du project Docker Compose (préfixe des containers/volumes). Conservé `secretvault` sur le VPS prod pour compatibilité des volumes existants. | défaut dans compose : `secretvault` |

### 9.4 Bootstrap admin

[scripts/bootstrap-admin.mjs](../scripts/bootstrap-admin.mjs) — appelé par le CMD du runtime. Si la table `User` est vide : crée le 1er user avec `User.role = ADMIN` ET son organisation par défaut (slug = handle email, déduplication automatique en cas de collision) avec un OrgMember(OWNER). No-op sinon.

### 9.5 Email transport (pink-floyd + Mailgun fallback)

[lib/email.ts](../lib/email.ts) expose `sendEmail()` et `sendInvitationEmail()`. Le transport est sélectionné au runtime selon les variables d'environnement présentes (premier match) :

1. `EMAIL_PINKFLOYD_URL` + `EMAIL_PINKFLOYD_API_KEY` → **pink-floyd** (provider actif en prod depuis 2026-05)
2. `EMAIL_MAILGUN_API_KEY` + `EMAIL_MAILGUN_DOMAIN` → **Mailgun** (fallback de transition)
3. *(rien)* → stdout stub (dev par défaut, log le message au lieu de l'envoyer)

L'instance du transport est mise en cache au niveau module (lazy + une seule fois pour la durée du process). Retirer les 2 env vars `EMAIL_PINKFLOYD_*` rollback vers Mailgun sans modifier le code ni redéployer l'image.

#### pink-floyd

Relay HTTP self-hosted (Nodemailer + Redis derrière) sur `https://pink-floyd.argoweb.fr`. Permet de couper la dépendance Mailgun, d'utiliser un sender propre (`contact@physalis.cloud`) et de centraliser la délivrabilité avec les autres services Argoweb.

- Endpoint : `POST ${EMAIL_PINKFLOYD_URL}/v1/send`
- Auth : header `x-api-key: <key>`
- Body : `{ from, to, subject, text, html? }` — `from` doit être un email pur (pas le format RFC `Display Name <addr>`), validation Zod stricte côté pink-floyd
- Succès : `202 Accepted` + `{ success: true, messageId, queued: true }` — l'email est enfilé dans Redis, l'envoi réel est asynchrone
- Erreurs : `400` sender non enregistré, `401` clé invalide, `500` backend down

#### Mailgun (fallback)

- `mailgun.js` + `form-data` (deps déclarées en runtime).
- Endpoint : `https://${EMAIL_MAILGUN_HOST}` (`api.mailgun.net` par défaut, `api.eu.mailgun.net` pour la région EU).
- Format `From:` : `EMAIL_FROM` si défini, sinon `Physalis <noreply@${EMAIL_MAILGUN_DOMAIN}>`.
- Email d'invitation : version texte + HTML (template léger inline, bouton CTA).

Pour ajouter d'autres providers (Resend, SMTP…), implémenter une nouvelle fonction `xxxTransport()` et l'ajouter à la chaîne de sélection dans `transport()` ; le reste de l'app appelle `sendEmail()` sans connaître le provider.

Les URLs d'invitation sont dérivées du `Host` header de la requête HTTP (cf. `buildAcceptUrl(token, req)` dans [lib/invitations.ts](../lib/invitations.ts)) — fonctionne quel que soit le mode d'accès (localhost, IP WSL, domaine prod).

Prérequis délivrabilité (vrai pour les deux providers) :

- Domaine `physalis.cloud` configuré avec SPF + DKIM côté provider (pink-floyd : DNS sur le relay ; Mailgun : statut « Active »).
- Pour Gmail : ajouter un record DMARC `p=none` minimum (sinon les premiers emails partent en Promotions ou en Spam).
- Sender utilisé : `contact@physalis.cloud` (pas de display name dans `EMAIL_FROM`, pink-floyd ajoute lui-même le nom d'expéditeur côté backend si configuré).

---

## 10. Workflow d'utilisation

### 10.1 Local (dev natif)

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres seul
cp .env.example .env                              # remplir ENCRYPTION_KEY etc
npm install
npx prisma migrate dev
npm run bootstrap-admin                            # crée le 1er admin
npm run dev                                        # http://localhost:3000
```

### 10.2 Local (stack complète)

```bash
cp .env.example .env                               # remplir les secrets
docker compose up -d --build                        # http://localhost:3001
```

### 10.3 Production (VPS + NPM)

Déploiement automatique via GitHub Actions sur push `main` ([.github/workflows/deploy.yml](../.github/workflows/deploy.yml)) :

1. Job `test` — install + `prisma generate` + `tsc --noEmit` + lint.
2. Job `deploy` — build l'image Docker, push sur GHCR (`ghcr.io/<owner>/<repo>:latest` + `:${SHA}`), SSH login GHCR sur le VPS, **scp du compose file** (`vps/production/docker-compose.yml` → `/srv/projets/production/secretvault/docker-compose.yml`), `docker compose pull app && up -d`, health check sur `/login`, prune des images dangling.

Le VPS n'a **pas besoin de git** : le compose est synchronisé à chaque deploy par le workflow, l'image vient de GHCR, et le seul état persistant côté VPS est `.env` (créé une fois manuellement) et le volume Postgres.

Setup initial du VPS (une fois) :

```bash
# 1. Creer le dossier
sudo mkdir -p /srv/projets/production/secretvault
sudo chown -R gael:gael /srv/projets
cd /srv/projets/production/secretvault

# 2. Reseau Nginx Proxy Manager (s'il n'existe pas deja)
docker network create nginx_default 2>/dev/null || true

# 3. Generer la cle SSH dediee au workflow GitHub
ssh-keygen -t ed25519 -C "github-actions-secretvault" \
  -f ~/.ssh/github_actions_secretvault -N ""
cat ~/.ssh/github_actions_secretvault.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/github_actions_secretvault   # contenu = SSH_PRIVATE_KEY (secret GitHub)

# 4. Creer .env (jamais transmis par le workflow, jamais commite)
nano .env
# Contenu minimum :
#   IMAGE=ghcr.io/<owner-lowercase>/<repo-lowercase>:latest   ← match exact le path GHCR pousse par le workflow
#   PROJECT_NAME=secretvault                                  # conserve par compat des volumes Docker (cf. phase-0.2)
#   DATABASE_URL=postgresql://physalis:<DB_PASSWORD>@db:5432/physalis
#   DB_PASSWORD=<strong>
#   ENCRYPTION_KEY=$(openssl rand -hex 32)
#   NEXTAUTH_SECRET=$(openssl rand -base64 32)
#   AUTH_SECRET=$(openssl rand -base64 32)
#   NEXTAUTH_URL=https://vault.physalis.cloud          # PAS de slash final
#   PHYSALIS_TENANT_DOMAIN=physalis.cloud
#   PHYSALIS_SHARED_PORTAL=vault.physalis.cloud
#   OIDC_AUDIENCE=vault.physalis.cloud
#   ADMIN_EMAIL=<votre email>
#   ADMIN_PASSWORD=<strong, >= 12 chars>
#   ALLOW_REGISTRATION=false
#   EMAIL_MAILGUN_API_KEY=<...>
#   EMAIL_MAILGUN_DOMAIN=<...>
#   EMAIL_MAILGUN_HOST=api.eu.mailgun.net   # ou api.mailgun.net pour US
#   EMAIL_FROM=Physalis <noreply@<domaine>>

# 5. Configurer les 3 secrets GitHub puis pousser sur main.
#    Le workflow scp'era le docker-compose.yml et lancera le 1er deploy.

# 6. Configurer NPM :
#    - vault.physalis.cloud → http://secretvault_app:3000 (cert Let's Encrypt HTTP-01)
#    - *.physalis.cloud (wildcard) → http://secretvault_app:3000 (cert wildcard via DNS-01 Cloudflare,
#      pour servir les sous-domaines tenants <slug>.physalis.cloud)
#    Force SSL + HTTP/2 + HSTS sur les deux.
#    Container DB : `physalis-db` (cf. vps/production/docker-compose.yml).
```

Secrets GitHub à créer (Settings → Secrets and variables → Actions) :

| Secret | Contenu |
|---|---|
| `SSH_PRIVATE_KEY` | contenu de `~/.ssh/github_actions_secretvault` (clé privée du VPS) |
| `SERVER_IP` | IP ou hostname du VPS |
| `GHCR_PAT` | Personal Access Token GitHub avec scopes `read:packages` + `write:packages` (Settings → Developer settings → Tokens classic) |

### 10.4 Staging & merge vers production

Le workflow de mise en production passe par la branche `staging` avant `main`.

**1. Push sur `staging`** → déclenche `deploy-staging.yml` ([.github/workflows/deploy-staging.yml](../.github/workflows/deploy-staging.yml)) :

| Job | Description |
|---|---|
| `test` | Install + `prisma generate` + `tsc --noEmit` + lint + unit tests |
| `build` | Build image Docker, push sur GHCR (tags `:${SHA}` et `:staging`) |
| `deploy-staging` | SSH sur le VPS : pull image, `prisma migrate deploy` + `auto-apply-tenant-migrations.mjs`, `docker compose up -d`, health check `staging.physalis.cloud` |
| `e2e` | Suite Playwright (5 specs, ~13 tests) contre `staging.physalis.cloud` — rapport artifact 7 jours |
| `zap` | OWASP ZAP baseline scan (passif) contre l'URL staging |
| `nuclei` | Scan CVE + misconfigs (severity ≥ medium) |

Les jobs `e2e`, `zap` et `nuclei` tournent en parallèle après `deploy-staging`.

**2. Merge `staging` → `main`** via PR GitHub :

- S'assurer que les jobs `e2e`, `zap` et `nuclei` sont verts sur le dernier commit staging.
- La PR peut être mergée dès que la pipeline staging est entièrement verte — aucune étape manuelle supplémentaire requise côté code.
- La DB de production n'est **pas** partagée avec staging : les migrations Prisma s'appliquent indépendamment sur chaque env au démarrage du conteneur.

**3. Push sur `main`** → déclenche `deploy.yml` (pipeline prod) : test → build (tags `:${SHA}` + `:latest`) → deploy prod (même mécanique SSH, sans E2E ni scans).

> **Sécurité des tenants lors d'un déploiement** : `auto-apply-tenant-migrations.mjs` rejoue toutes les migrations sur les schémas `client_*` existants. Si un tenant a été provisionné avant l'ajout d'une migration, s'assurer qu'il n'a pas été bootstrappé sans que ses migrations aient tourné (cf. [§9.1](#91-dockerfile) — caveat bootstrap).

### 10.5 Côté projet client (consommer les secrets)

[scripts/inject-secrets.sh](../scripts/inject-secrets.sh) — injection au moment du `docker compose up` :

```bash
# Sur le VPS du projet :
export SECRET_VAULT_TOKEN=sv_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export SECRET_VAULT_URL=https://secrets.example.com

./inject-secrets.sh mon-projet production > .env
docker compose up -d
```

Sortie : `KEY="value"` avec échappement complet (`\\`, `\"`, `\$`, `` \` ``). Le `.env` est éphémère, à ajouter au `.gitignore` du projet client.

Codes retour : 0 OK, 1 mauvais usage, 2 token absent, 3 erreur réseau / API.

### 10.6 Migration OIDC d'un workflow GitHub

Approche **post-Megalodon** : aucune clé ni PAT dans GitHub Secrets. Le runner s'authentifie par OIDC, le vault valide une `Policy` stricte avant de retourner le bundle de déploiement.

Template prêt à copier : [docs/deploy-oidc.yml](deploy-oidc.yml). Fonctionnement détaillé en [§4.8b](#48b-endpoint-oidc-apideploy).

**Étapes côté Physalis** (admin org) :

1. **Serveur** : `/orgs/<slug>` → onglet « Serveurs » → + Ajouter. Coller la clé SSH privée `github-deploy` du VPS cible. La clé n'est jamais relisible après création — la rotation se fait par suppression/recréation.
2. **Environnement** : `/projects/<slug>` → ⚙ Paramètres → édite l'env cible → choisir le serveur + remplir `deployPath` (ex. `/srv/projets/voyages`).
3. **Policy** : `/projects/<slug>` → onglet « Policies » → + Ajouter avec `(repo, workflow, branch, environment)`. Match strict, aucune wildcard. Une policy par couple (workflow, branche cible).
4. **Registry credentials** (org-level, une seule fois) : `/orgs/<slug>` → onglet « Secrets globaux » → ajouter `REGISTRY_USER` (login GitHub propriétaire du PAT) + `REGISTRY_PAT` (PAT classic scope `read:packages` uniquement). Optionnel : `REGISTRY_URL` (défaut `ghcr.io`). Ces 3 clés sont **réservées** et exposées sous `bundle.registry.{url,user,pat}` à toutes les workflows OIDC autorisées de l'org — jamais dans `.env`, jamais dans le conteneur.

**Étapes côté repo GitHub** :

1. Copier [docs/deploy-oidc.yml](deploy-oidc.yml) dans `.github/workflows/deploy.yml` du repo applicatif. Adapter le bloc `env:` (`VAULT_URL`, `VAULT_AUDIENCE`, `VAULT_PROJECT`, `VAULT_ENV`).
2. Settings → Secrets and variables → Actions → **supprimer** les anciens : `VAULT_TOKEN`, `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PROJECT_PATH`. Aucun secret GitHub n'est nécessaire pour ce workflow.
3. Vérifier que le repo a `Settings → Actions → General → Workflow permissions = Read and write` (ou au minimum que `id-token: write` est autorisé).
4. Push sur `main` ou déclencher manuellement → vérifier dans `/projects/<slug>/audit` qu'un `DEPLOY_AUTHORIZED` apparaît avec les bons claims.

**Validation** : un seul échec côté vault audite un `DEPLOY_DENIED` avec le `reason`. Les `wrong_aud` / `wrong_iss` / `missing_token` ne sont **pas** audités (probes externes). Si rien n'apparaît dans l'audit, c'est que le workflow ne joint pas le vault — vérifier l'`OIDC_AUDIENCE` exacte des deux côtés et l'accessibilité réseau.

**Cleanup d'un repo migré** :

| Avant | Après |
|---|---|
| `secrets.VAULT_TOKEN` (machine token) | supprimé |
| `secrets.VPS_SSH_KEY` (clé SSH dans GitHub) | supprimée — vit chiffrée dans le vault |
| `secrets.VPS_HOST/USER/PROJECT_PATH` | supprimés — exposés par le bundle `/api/deploy` |
| `secrets.GHCR_PAT` (PAT registry dans GitHub) | supprimé — déplacé en `REGISTRY_PAT` org-level |
| Secrets env `GHCR_*` (transition phase) | supprimés — remplacés par `bundle.registry` au niveau org |
| Workflow `deploy.yml` ancien | remplacé par [docs/deploy-oidc.yml](deploy-oidc.yml) |

### 10.7 Backup chiffré & Failover

Deux mécanismes complémentaires sont en place sur l'infra prod (Ginko ↔ VPS secondaire) :

1. **Réplication WAL streaming** ([replication-wal.md](replication-wal.md)) — RPO < 1s, RTO < 5min. Hot standby PostgreSQL en streaming replication, le secondaire est à jour en quasi-temps-réel. Permet un basculement rapide en cas de panne du primaire.
2. **Backup GPG quotidien** — RPO 24h, archives chiffrées historiques (7 daily + 12 monthly). Protège contre la corruption logique (un `DROP TABLE` accidentel sur le primaire est répliqué vers le secondaire en quelques ms, donc seul un backup historique sauve dans ce cas) et donne un escrow déchiffrable hors ligne.

Les deux coexistent et se complètent. La doc `replication-wal.md` détaille la mise en place WAL ; le reste de cette section décrit le backup historique.

```
PRIMARY (Ginko)              ──WAL stream──▶  SECONDARY (vault-backup)
PostgreSQL PRIMARY                            PostgreSQL STANDBY (hot)
  │                                                   │
  │           ←── ssh forced-command ──               │
  └─ physalis-dump.sh                                 ├─ physalis-pull-backup.sh   (cron 3h00)
     pg_dump | gzip | gpg                             ├─ physalis-rotate.sh        (cron 3h30)
     --encrypt --recipient                            ├─ physalis-restore.sh       (manuel failover)
     backup@argoweb.fr                                ├─ physalis-test-restore.sh  (cron mensuel)
                                                      └─ physalis-promote-replica.sh (manuel failover)
```

Le forced-command côté primary passe par `/usr/local/bin/backup-dispatch.sh` qui reconnaît la commande `dump-physalis` et délègue à `/usr/local/bin/physalis-dump.sh` (defaults : container `physalis-db`, user/db `physalis`). Le secondary stocke les archives sous `/srv/backups/physalis/physalis-YYYY-MM-DD.db.gz.gpg` et logge dans `/var/log/physalis-backup.log`.

| Élément | Valeur |
|---|---|
| **Réplication WAL** | streaming, RPO < 1s, RTO < 5min |
| **Backup GPG** quotidien | 3h00, RPO 24h, RTO 5-20 min (restore DB) + propagation DNS |
| Rétention backups | 7 daily + 12 monthly = 18 fichiers max |
| Chiffrement | GPG RSA 4096 dédié backup, sans passphrase + FS hardening |
| Vérif intégrité | à chaque pull (decrypt + gunzip + grep entête) |
| Test restauration | mensuel automatisé (DB Postgres scratch, count rows + 5 tables sentinelles) |
| Monitoring | healthchecks.io (heartbeat externe, alerte si silence > 25h) |
| Escrow | `ENCRYPTION_KEY` + clé GPG privée dans Vaultwarden partagé |

Scripts livrés dans [scripts/backup/](../scripts/backup/) (`primary/` + `secondary/`) avec [README d'install](../scripts/backup/README.md). Procédure complète + runbook de basculement dans [todo-backup-failover.md](steps-docs/done/todo-backup-failover.md). État de l'install actuelle dans [doc-install-backup.md](doc-install-backup.md). Réplication WAL dans [replication-wal.md](replication-wal.md).

---

## 11. Tests

Deux tiers indépendantes, chacune avec sa config vitest.

### 11.1 Unit (`npm test`)

283 tests, ~8 s, 25 fichiers. Aucune dépendance externe (pas de DB, pas d'app live). Couvre :
- `lib/crypto.ts` — roundtrip AES-256-GCM, IV unique, tampering détection
- `lib/auth-token.ts` — format `sv_<hex>`, hash SHA-256 stable + déterministe, entropie
- `lib/rate-limit.ts` — fenêtre fixe, headers RFC, isolation IP/scope
- `lib/validation.ts` — slugify, secret/env/email/server/repo/workflow/branch, defaultDeployPath
- `lib/totp.ts` — TOTP roundtrip, backup codes bcrypt
- `lib/oidc.ts` — JWT verify avec faux issuer in-process (signature, iss, aud, exp, claims)
- `lib/categories.ts` — validation des catégories de secret
- `lib/plugin-token.ts` — format `sv_plugin_<hex>`, hash, validation TTL env var, isAllowedTtl whitelist
- `lib/generate-password.ts` — base64url, longueur, entropie, bornes 12-64
- `lib/otpauth-parse.ts` — base32 valide, parser otpauth:// totp, normalisation casse/espaces, rejet hotp
- `lib/integration-token.ts` — UserToken / OrgToken : format, hash, scope enforcement
- `lib/secret-request.ts` / `lib/secret-request-crypto.ts` — ECDH keypair, hash, TTL, statuts dérivés
- `lib/rotation-*.ts` — validation intervalles, HMAC callback, stratégies
- Divers : account-enumeration (timing attack), audit, billing helpers

Config : [vitest.config.ts](../vitest.config.ts) — include `tests/lib/**/*.test.ts`.

Lancé automatiquement en CI (job `test` du workflow).

### 11.2 Intégration (`npm run test:integ`)

26 fichiers, ~30 s. Nécessite la stack docker compose **up** :

```bash
docker compose up -d
npm run test:integ
```

Les tests appellent l'app sur `localhost:3001` (override avec `TEST_BASE_URL=…`) et inspectent la DB via `docker compose exec db psql` pour les vérifications bas niveau (chiffrement en base, hash des tokens).

Config : [vitest.integ.config.ts](../vitest.integ.config.ts) — include `tests/integ/**/*.test.ts`. Séquentiel pour partager la stack live ; chaque file utilise un préfixe de noms unique + `X-Forwarded-For` fictif pour isoler les buckets de rate-limit.

Couverture : auth Bearer (14), RBAC (9), DB encryption (4), headers (3), rate-limit (3), 2FA (17), servers + env link (12), policies + /api/deploy denial paths (10), integration tokens UserToken/OrgToken, rotation, API Gateway, secret-requests, versioning.

**Pas en CI pour l'instant** — nécessiterait un job qui spin up Docker dans le runner. À ajouter quand l'infra CI sera prête.

### 11.3 E2E (`npm run test:e2e`)

5 specs Playwright (Chromium), 11 tests ✓ / 2 skipped. Séquentielles (01→05) — chaque spec dépend de la précédente :

| Spec | Description |
|---|---|
| `01-auth.spec.ts` | Login / logout, redirect si non authentifié |
| `02-project-crud.spec.ts` | Crée le projet `e2e-test` (utilisé par 03-04-05) |
| `03-secrets.spec.ts` | CRUD secrets sur projet e2e-test |
| `04-rotation-config.spec.ts` | Configuration rotation DATABASE (skip si feature désactivée) |
| `05-api-gateway.spec.ts` | Flow complet API → clé → suppression ; cleanup projet en `afterAll` |

Config : [playwright.config.ts](../playwright.config.ts). Variables d'env : `TEST_TENANT_SLUG`, `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD`, `E2E_PROJECT_SLUG`. Guide des anti-patterns : [tests/e2e/SPEC_GUIDE.md](../tests/e2e/SPEC_GUIDE.md).

Lancé localement avec la stack docker compose up — `npm run test:e2e`.

**En CI** — les E2E tournent automatiquement à chaque push sur `staging` (job `e2e` dans `deploy-staging.yml`), après le deploy et le health check. Variables injectées depuis les GitHub Secrets (`E2E_BASE_URL`, `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD`, `TEST_TENANT_SLUG`, `E2E_PROJECT_SLUG`, `E2E_ENV`). Le rapport Playwright est uploadé comme artifact (7 jours de rétention).

---

## 12. Rotation automatique des secrets (Phase 12)

### 12.1 Vue d'ensemble

Rotation des mots de passe DB et secrets applicatifs selon un intervalle configurable, orchestrée via N8n. Chaque secret peut être configuré indépendamment.

**Stratégies disponibles :**

| Stratégie | Catégorie principale | Mécanisme |
|-----------|---------------------|-----------|
| `DATABASE` | `database` | N8n se connecte en DB, applique le pattern alternating-user, rappelle Physalis via callback HMAC |
| `JWT_SECRET` | `infra` | Rotation locale en DB (nouveau `crypto.randomBytes(64)`), déclenche un `workflow_dispatch` GitHub Actions si `Project.githubRepo` configuré |
| `WEBHOOK` | toutes | Physalis appelle `Secret.rotationWebhookUrl` (payload signé HMAC) ; le service externe applique la rotation et rappelle le callback |
| `REMINDER` | toutes | Rappel sans changement automatique (audit + email si configuré) |
| `API_KEY` | (API Gateway) | Révoque l'`ApiKey` liée, crée une nouvelle clé via l'API Gateway, met à jour la valeur du `Secret` |

> Le bouton "Rotation" est visible dans `secrets-panel.tsx` pour les secrets `category = database` dont la clé contient `password`, et pour tous les secrets `category = infra`. La stratégie `API_KEY` s'affiche uniquement si le secret est lié à une `ApiKey` (`apiKeyId` non null).

### 12.2 Engine cron

[lib/rotation-cron.ts](../lib/rotation-cron.ts) — appelé toutes les heures via `POST /api/cron/rotation` (auth `X-Cron-Secret`). Itère tous les clients ACTIVE/TRIAL, entre dans chaque schéma tenant, sélectionne les secrets avec `rotationNextAt ≤ now` et `rotationEnabled = true`.

**Cron N8n** : workflow Schedule Trigger (toutes les heures) → HTTP POST `/api/cron/rotation`.

> ⚠️ **Point de vigilance en croissance** : le cron itère séquentiellement tous les tenants ACTIVE/TRIAL. Sur PostgreSQL multi-tenant avec des dizaines de schémas, la durée totale d'exécution peut croître linéairement. Ce n'est pas problématique à court terme, mais à surveiller. Pistes d'amélioration : index composite `(rotationEnabled, rotationNextAt)` dans chaque schéma tenant + limite de concurrence dans la boucle (`Promise.allSettled` sur N tenants en parallèle plutôt que `for…of` séquentiel).

### 12.3 Pattern alternating user (DATABASE / PostgreSQL)

```
1. Connexion en tant que <databaseUser> (mdp actuel depuis Physalis)
2. CREATE USER physalis_temp_<ts> WITH SUPERUSER PASSWORD '<tempPassword>'
3. Connexion en tant que physalis_temp → ALTER USER <databaseUser> WITH PASSWORD '<newPassword>'
4. Connexion en tant que <databaseUser> (nouveau mdp) → DROP USER physalis_temp_<ts>
5. PATCH /api/rotation/admin/secret-value → chiffre + stocke newPassword
6. POST callbackUrl (HMAC token) → Physalis marque rotationLastStatus = 'success'
7. Si Project.githubRepo configuré → POST GitHub workflow_dispatch (redeploy)
```

MySQL et MariaDB suivent le même pattern (`GRANT ALL PRIVILEGES WITH GRANT OPTION` pour le temp user).

**Sécurité des mots de passe générés** : charset `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~` (RFC 3986 unreserved — jamais besoin d'encoder dans `DATABASE_URL`).

### 12.4 Redeploy automatique post-rotation

Commun aux stratégies DATABASE et JWT_SECRET. L'URL est dérivée automatiquement depuis `Project.githubRepo` + `Project.githubWorkflow` :

```
https://api.github.com/repos/<githubRepo>/actions/workflows/<githubWorkflow>/dispatches
```

`GITHUB_DISPATCH_TOKEN` lu depuis les OrgSecrets du client au moment du trigger (décrypté AES-256-GCM, jamais stocké sur Secret).

- **DATABASE** : inclus dans le payload envoyé à N8n, qui déclenche lui-même le `workflow_dispatch` avec `Authorization: Bearer <token>`.
- **JWT_SECRET** : déclenché directement par `lib/rotators/jwt.ts` après écriture en DB. Le `ref` est `"main"` si `envName = "production"`, sinon le nom de l'environnement.

### 12.5 Variables d'environnement

| Variable | Usage |
|----------|-------|
| `CRON_SECRET` | Auth `X-Cron-Secret` sur `/api/cron/rotation` + auth N8n admin routes |
| `ROTATION_HMAC_KEY` | Signature des tokens callback N8n (window ±1h) |
| `ROTATION_N8N_WEBHOOK_URL` | URL du webhook N8n pour la stratégie DATABASE |
| `GITHUB_DISPATCH_TOKEN` | Stocké dans OrgSecrets Physalis (pas en env app) |

### 12.6 Points d'extension connus

Voir [todo_v2.md](todo_v2.md) pour les fonctionnalités planifiées.
