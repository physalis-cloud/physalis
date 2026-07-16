# Physalis — Audit de sécurité

> Audit initial : 2026-05-01.
> Mise à jour 2026-05-15 : intègre les phases 11 (intégration tokens), 12 (rotation automatique),
> 13 (API Gateway), le timing-attack fix, l'isolation multi-tenant complète,
> les tests E2E Playwright et les nouvelles lacunes identifiées.
> Mise à jour 2026-05-30 : module Email (Physalis Email) (§3.15) — revue manuelle + durcissements
> (scoping expéditeurs au domaine, rate-limit send/reveal, historique indexé par compte).

---

## 1. Synthèse

| Domaine | État | Note |
|---|---|---|
| Chiffrement des secrets | ✅ | AES-256-GCM, IV unique par secret, auth tag vérifié. Couvre Secret, OrgSecret, Service, AppAccount, Server (clé SSH), 2FA, VaultEntry, ApiKey |
| Stockage mots de passe | ✅ | bcrypt salt 12 |
| Stockage tokens | ✅ | SHA-256 en base pour MachineToken, PluginToken, UserToken, OrgToken, ApiKey. Jamais en clair |
| Headers HTTP | ✅ | X-Frame-Options, HSTS, Permissions-Policy, CSP nonce-based |
| Réseau base de données | ✅ | DB sur réseau Docker `internal` ; port 5432 bindé pour WAL, restreint par `pg_hba.conf` à l'IP réplica |
| RBAC 4 niveaux | ✅ | MEMBER < DEV < ADMIN < OWNER (org) ; VIEWER < EDITOR < OWNER (projet). Vérifié à chaque route |
| Isolation multi-tenant | ✅ | Schema-per-tenant ; `prisma` throw si pas de contexte tenant ; zéro fallback `public` depuis Phase 4 |
| Logs (stdout) | ✅ | Aucune valeur de secret/mdp/token plaintext dans les logs |
| Audit log persistant | ✅ | Table `AccessLog` peuplée sur toutes les actions sensibles, export CSV |
| CSRF (web) | ✅ | Géré par NextAuth sur les callbacks |
| Rate limiting | ✅ | login, register, deploy, plugin-auth, plugin-vault-write, gateway-verify |
| Timing attack (login) | ✅ | Fix 2026-05-08 — dummy bcrypt hash + `rejectWithConstantTime` sur tous les chemins rapides |
| OIDC (GitHub Actions) | ✅ | Validation JWKS + iss/aud/exp stricts ; match Policy strict sans wildcard |
| 2FA TOTP | ✅ | otplib, secret chiffré AES-256-GCM, backup codes bcrypt one-shot |
| Plugin navigateur | ✅ | 2FA obligatoire, PluginToken 4h SHA-256, CORS whitelist, scope strict |
| Rotation automatique | ✅ | Phase 12 livrée — stratégies DATABASE / JWT_SECRET / REMINDER / API_KEY ; cron HMAC-signé |
| Tokens d'intégration | ✅ | UserToken + OrgToken + MachineToken ; scopes READ stricts ; audit INTEGRATION_CREDENTIALS_FETCH |
| API Gateway keys | ✅ | Format `ph_live_sk_*`, SHA-256, rate-limit verify 1000/min/IP, audit ApiLog |
| Versioning secrets | ✅ | Rétention 50 max, rollback en transaction, audit SECRET_VERSION_REVEAL / SECRET_ROLLBACK |
| Backup chiffré | ✅ | GPG RSA 4096 pull-based, escrow externe, restore-test mensuel automatisé |
| CSP | ✅ | Nonce-based (`script-src 'strict-dynamic'`), `unsafe-inline` sur styles uniquement |
| Tests sécurité automatisés | ✅ | 283 unit (25 fichiers) + 26 fichiers integ + 5 specs E2E Playwright |
| Trufflehog CI | ✅ | Scan git history sur PR + push full history (`--only-verified`) |
| Scans DAST (ZAP / Nuclei) | ✅ | À chaque push `staging` post-déploiement : OWASP ZAP baseline + Nuclei (cve/misconfig/exposure/headers). Cf. §3.16 |
| HTTP 405 | ✅ | ~80 tests integ sur les méthodes non autorisées |
| Module Email (Physalis Email) | ✅ | Config par projet, clé API chiffrée AES-256-GCM, gating allowlist fail-closed, RBAC, historique scopé par compte ; revu 2026-05-30 (§3.15) |
| npm audit / CVE CI (SCA) | ✅ | Job `npm-audit` (`--omit=dev --audit-level=high`) dans `security.yml`, bloque sur high/critical. Cf. §3.14.2 |
| Session fixation (password change / 2FA) | ⚠️ | Non vérifié — les JWT NextAuth existants sont-ils invalidés ? |
| ENCRYPTION_KEY re-keying | ✅ | Script `scripts/rekey-encryption.mjs` (dual-key, idempotent, dry-run) + procédure ops. Cf. §3.14.4 |

---

## 2. Détails par contrôle

### 2.1 Chiffrement (✅)

- **Implémentation** : [lib/crypto.ts](../lib/crypto.ts) — AES-256-GCM via `node:crypto`.
- **Clé** : `ENCRYPTION_KEY` dans l'env du conteneur (32 bytes / 64 hex). Validée en longueur à chaque appel via `getKey()`. **Jamais en DB ni dans le code.**
- **IV** : 12 bytes aléatoires par appel `encrypt`. Stocké en base avec le tag.
- **Auth tag** : 16 bytes GCM, vérifié à `decrypt` (corruption → exception).
- **Périmètre complet** : `Secret`, `OrgSecret`, `Service.encryptedData`, `AppAccount.encryptedData`, `User.twoFactorSecret`, `Server.encryptedKey`, `VaultEntry.encryptedPassword`, `VaultEntry.encryptedTotpSecret`, `TeamVaultEntry` (idem), `ApiKey` (hash SHA-256 — la valeur brute n'est jamais stockée).
- **Vérification non-fuite** : `SELECT * FROM "Secret"` retourne uniquement des chunks base64. Tests integ `db-encryption.test.ts` + `servers.test.ts`.

### 2.2 Mots de passe (✅)

- bcrypt salt 12 à la création (register, bootstrap admin).
- Comparaison via `bcrypt.compare`, jamais en plain.
- Validation : ≥ 12 chars.

### 2.3 Tokens (✅)

Cinq catégories, toutes hashées SHA-256 en base :

| Type | Préfixe | TTL | Usage |
|---|---|---|---|
| `MachineToken` | `sv_<32 hex>` | permanent (révocable) | CI/CD VPS Bearer |
| `PluginToken` | `sv_plugin_<hex>` | 4h (configurable) | Extension navigateur |
| `UserToken` | `sv_user_<hex>` | 1-365j | Intégrations user-scoped |
| `OrgToken` | `sv_org_<hex>` | optionnel | Intégrations org-scoped (N8n, Make) |
| `ApiKey` | `ph_live_sk_*` / `ph_test_sk_*` | optionnel | API Gateway clients tiers |

Tous : SHA-256(token) en base, jamais le brut. Plaintext retourné **une seule fois** à la création. Lookup en O(1) via index unique. `admin.token_index` résout quel schéma tenant contient le token (cross-tenant sans scan).

### 2.4 Headers HTTP (✅)

Définis dans [next.config.ts](../next.config.ts) :

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

### 2.5 Réseau (✅)

- Réseau Docker `db_network` (non-internal) en prod — port 5432 bindé sur l'hôte pour la réplication WAL streaming vers le VPS secondaire.
- Accès DB filtré strictement par `pg_hba.conf` : seule l'IP du VPS secondaire est autorisée en connexion de réplication (`host replication replicator <IP>/32 md5`). Toutes les autres connexions externes sont rejetées.
- App exposée uniquement via `nginx_default` (NPM fait la terminaison TLS).
- `pg_hba.conf` versionné dans le repo + synchronisé via workflow GitHub Actions à chaque déploiement.

### 2.6 RBAC (✅)

**Org** : MEMBER < DEV < ADMIN < OWNER. **Projet** : VIEWER < EDITOR < OWNER.

Helpers centraux dans [lib/api.ts](../lib/api.ts) : `requireUser`, `requireOrgMember(slug, role)`, `requireProjectMember(slug, role)`, `requireEnvironment(slug, env, role)`. Rang comparé numériquement.

Règles critiques :
- OrgADMIN/OWNER → `ProjectRole.OWNER` implicite sur tous les projets.
- OrgDEV → `ProjectRole.EDITOR` implicite, sans row `ProjectMember`.
- OrgMEMBER → accès projet uniquement si `ProjectMember` explicite.
- `User.role = ADMIN` → dieu mode global, **sauf** sur les coffres personnels (volontaire — l'admin ne peut pas lire les entrées privées des autres users).

### 2.7 Isolation multi-tenant (✅)

- Schema-per-tenant `client_<slug>`. Client Prisma `prisma` (avec extension) **throw** si pas de `tenantSlug` dans AsyncLocalStorage — aucun fallback silencieux sur `public`.
- Phase 4 exécutée : tables tenant droppées de `public` (`OrgMember`, `MachineToken`, etc.). `public` ne contient plus que `User` (SUPERADMIN) + extensions Postgres.
- Commentaire `lib/auth.ts:315` : `// public.OrgMember n'existe plus` confirme l'état post-drop.
- `admin.token_index` permet la résolution cross-tenant sans scanner toutes les bases.

### 2.8 Timing attack — login (✅)

Fix poussé 2026-05-08 (commit c076f7e).

- Dummy bcrypt hash chargé au module load (`bcrypt.hashSync` une fois au démarrage).
- Helper `rejectWithConstantTime` : sur tous les chemins rapides (tenant inconnu, user inexistant, role insuffisant), effectue un `bcrypt.compare` sur le dummy hash avant de retourner 401. Même durée que le chemin "mauvais mot de passe".
- Implémentation : [lib/auth.ts](../lib/auth.ts).
- Test : [tests/integ/account-enumeration.test.ts](../tests/integ/account-enumeration.test.ts) — vérifie que le ratio de durée mauvais-user / mauvais-mdp reste < 1.5×.

### 2.9 CSRF (✅)

NextAuth génère et valide automatiquement un token CSRF à chaque login via `/api/auth/csrf` + `/api/auth/callback/credentials`.

### 2.10 Logs (✅)

- `log: ["error", "warn"]` (dev) / `["error"]` (prod) côté Prisma.
- Les `console.error` dans les routes logguent des messages non-sensibles (erreurs DB structurées, sans valeur de secret ni token plaintext).

---

## 3. Lacunes identifiées

### 3.1 Rate limiting (⚠️ partiel)

**Implémenté** : [lib/rate-limit.ts](../lib/rate-limit.ts) — fenêtre fixe in-memory.

| Bucket | Limite | Scope |
|---|---|---|
| `login` | 5 / 15 min | IP |
| `register` | 3 / h | IP (avant toggle ALLOW_REGISTRATION) |
| `plugin-auth` | 5 / 15 min | IP |
| `plugin-vault-write` | 30 / min | user |
| `gateway-verify` | 1 000 / min | IP |

Endpoints cron (`/api/cron/*`) : gardés par `CRON_SECRET_ADMIN` (tier admin, header `Authorization: Bearer`, `timingSafeEqual` via `requireCronAuth` — `lib/cron-auth.ts`), pas de rate-limit IP (accès opérateur uniquement). Le tier bas-privilège `CRON_SECRET_REPORT` ne garde que `POST /api/admin/infra/backup`.

**Limite in-memory** : les buckets sont module-level — ils se réinitialisent à chaque redéploiement. Un attaquant peut temporiser une attaque autour d'un deploy. Phase 2 : migration vers Redis pour persistance inter-instance. Cf. [todo_v2.md](todo_v2.md).

**Non couvert** (backlog [todo_v2.md](todo_v2.md)) :
- `/api/secrets/[slug]/[env]` (Bearer machine token) — l'espace de tokens (256 bits) rend le brute-force inutile ; utile pour détecter un token compromis utilisé en boucle.
- `/api/gateway/verify` — pas de per-key rate-limit. Un attaquant avec IP unique pourrait tenter d'énumérer des clés valides. Mitigé par l'entropie des clés (`ph_live_sk_*` = 128+ bits). À surveiller si la feature devient populaire.

### 3.2 CSP (✅)

[middleware.ts](../middleware.ts) — nonce 16 bytes hex par requête :

```
default-src 'self'
script-src 'self' 'nonce-X' 'strict-dynamic'
style-src 'self' 'unsafe-inline'       ← compromis (React style={{ }})
img-src 'self' data: blob:
connect-src 'self'
frame-ancestors 'none'
form-action 'self'
base-uri 'self'
object-src 'none'
upgrade-insecure-requests
```

### 3.3 Audit log (✅)

Table `AccessLog` + helper `logAction()` non-bloquant ([lib/audit.ts](../lib/audit.ts)). FK SetNull : les logs survivent à la suppression des entités. Export CSV (`?format=csv`, RFC 4180, max 5 000 lignes).

Actions tracées : secrets, tokens machine, comptes/services, déploiement (DEPLOY_AUTHORIZED/DENIED), plugin, 2FA, coffres (VAULT_ENTRY_REVEAL / MOVE / etc.), intégrations (INTEGRATION_CREDENTIALS_FETCH), rotation (SECRET_VERSION_REVEAL / SECRET_ROLLBACK), org/projet/membre.

**Lacune documentée** : `DEPLOY_DENIED` sur JWT cryptographiquement invalide (avant résolution du tenant) n'est pas persisté en DB — le tenant n'est pas encore connu à ce stade. Traçage dans les logs console uniquement. Backlog : table `admin.deploy_denied` (clientId nullable). Cf. [todo_v2.md](todo_v2.md).

### 3.4 Tests automatisés (✅)

- **Unit** ([tests/lib/](../tests/lib/)) : **283 tests** (25 fichiers), ~11s. Couvre : crypto roundtrip + tampering, tokens (format/hash/TTL), rate-limit, validation, TOTP, OIDC, catégories, plugin-token, generate-password, otpauth-parse, password-reset, env-parser, audit-immutability (statique), secrets-no-leak (statique), next-public-audit, org-token-rbac (13 tests).
- **Intégration** ([tests/integ/](../tests/integ/)) : **26 fichiers**. Couvre : bearer-auth, RBAC, DB encryption, security headers, rate-limit HTTP réel, 2FA bout-en-bout, servers/policies/deploy, plugin, vault personnel + équipe + collections, password-reset, audit-immutability/isolation, IDOR, rbac-horizontal, access-revocation, cors-strict, search-isolation, cookie-attrs, session-forge, account-enumeration, api-gateway, secret-versioning. Tous en green sur `docker compose up -d` local.
- **E2E** ([tests/e2e/](../tests/e2e/)) : 5 specs Playwright (Chromium, 1 worker). Flows : login/logout, project CRUD, secrets CRUD, rotation (skip conditionnel si feature désactivée), API Gateway bout-en-bout. **11 ✓ / 2 skipped** (rotation désactivée pour l'org de test) en ~24s. Guide anti-pièges : [tests/e2e/SPEC_GUIDE.md](../tests/e2e/SPEC_GUIDE.md).
- **CI** : `.github/workflows/security.yml` — jobs `trufflehog` (scan git history) + `http-methods` (405 sur ~80 routes) + `test` (unit + integ, nécessite Postgres). E2E conditionnel sur `vars.E2E_ENABLED=true`.

### 3.5 Rotation automatique des secrets (✅)

Phase 12 livrée (2026-05-13). Stratégies :

| Stratégie | Mécanisme |
|---|---|
| `DATABASE` | N8n change le mdp DB (alternating user pattern), callback HMAC vers Physalis, redeploy |
| `JWT_SECRET` | Génération locale `crypto.randomBytes(64)`, écriture en DB, redeploy GitHub Actions |
| `REMINDER` | Notification sans changement automatique |
| `API_KEY` | Révocation ancienne clé + génération nouvelle, redeploy GitHub Actions |
| `WEBHOOK` | Dispatch vers URL webhook externe |

Auth cron : `POST /api/cron/rotation` gardé par `CRON_SECRET_ADMIN` (tier admin, `Authorization: Bearer`, `timingSafeEqual` via `requireCronAuth`). Callback N8n : HMAC-SHA256 avec `ROTATION_HMAC_KEY`, fenêtre ±1h, token à usage unique (stocké `rotationToken` sur Secret, effacé après validation).

**Robustesse V2 en backlog** : retries N8n, pattern write-ahead. Cf. [todo_v2.md](todo_v2.md).

### 3.6 OIDC `/api/deploy` (✅)

- `jose v6` `createRemoteJWKSet` (cache JWKS in-process) + `jwtVerify`.
- Issuer `https://token.actions.githubusercontent.com` (constante, jamais override en prod).
- Audience `OIDC_AUDIENCE` (défaut `vault.physalis.cloud`).
- Match `Policy` strict : (repo, workflow, branch, project, environment) — aucune wildcard.
- Registry credentials séparés de `secrets` dans le bundle (ne touchent jamais le `.env` du conteneur).
- Audit `DEPLOY_AUTHORIZED` / `DEPLOY_DENIED` sur tous les chemins traçables.

### 3.7 2FA TOTP (✅)

Secret TOTP chiffré AES-256-GCM. 8 backup codes 64 bits bcrypt one-shot. Single-step UX (pas de session intermédiaire). Machine tokens non affectés. Tolérance horloge ±30s.

### 3.8 Plugin navigateur (✅)

2FA obligatoire (403 explicite si non activée). CORS `PLUGIN_ALLOWED_ORIGIN` (défaut : endpoints retournent 403 si non définie). Match domaine strict `URL().hostname`. Scope : credentials uniquement (jamais `Secret`, jamais `OrgSecret`, jamais `sshKey`). `chrome.storage.session` côté extension (effacé à fermeture). Rate-limit 5/15min/IP.

### 3.9 Endpoint admin rotation `/api/rotation/admin/secret-value` (✅)

Endpoint consommé par N8n pour lire/écrire la valeur d'un secret DB avant/après rotation.

- **Auth** : `Authorization: Bearer <CRON_SECRET_ADMIN>` (tier admin) — comparaison `timingSafeEqual` via le helper partagé `requireCronAuth(req, "admin")` (`lib/cron-auth.ts`, Phase 1 cron-secret-hardening). Header standardisé pour tous les endpoints opérateur.
- **Pas de rate-limit IP** — accès opérateur uniquement (N8n interne). `CRON_SECRET_ADMIN` doit être ≥ 32 bytes hex aléatoires.
- **Réponses d'erreur génériques** (fix 2026-05-15) : les blocs catch (Prisma et déchiffrement) retournent `{ error: "Internal server error" }` sans `err.message`. L'erreur brute reste dans `console.error` (opérateur uniquement).
- **ROTATION_HMAC_KEY** : clé critique — si elle fuite, un attaquant peut forger des callbacks N8n et écrire n'importe quelle valeur dans un secret DB via `PATCH`. À traiter avec la même rigueur que `ENCRYPTION_KEY`. Voir §3.14.

### 3.10 Tokens d'intégration — UserToken / OrgToken (✅)

- **UserToken** (`sv_user_<hex>`) : scopé user, multi-projets via membership. Expiration 1-365j obligatoire, max 20 actifs/user. RBAC : vérification `ProjectMember` pour chaque accès. Quota DEV : max 10, expiration ≤ 90j, projets ⊆ ses memberships.
- **OrgToken** (`sv_org_<hex>`) : scopé org, scopes `SECRETS_READ / SERVICES_READ / ACCOUNTS_READ / PROJECTS_LIST`. `allProjects: Boolean` + `allowedProjectIds: String[]`. Max 50 actifs/org. Scope enforced sur chaque appel `/api/integrations/credentials`.
- Tous deux indexés dans `admin.token_index` pour résolution cross-tenant. Audit `INTEGRATION_CREDENTIALS_FETCH` par appel.
- **OrgToken RBAC DEV** : gardé dans [lib/org-token-rbac.ts](../lib/org-token-rbac.ts) — pas de `allProjects`, projets ⊆ ses memberships, expiration ≤ 90j, quota 10/user. 13 tests unit dédiés.

### 3.11 API Gateway keys (✅)

- Format `ph_live_sk_<hex>` / `ph_test_sk_<hex>`. Hash SHA-256, préfixe tronqué affiché en UI.
- Affichage one-shot à la création (bandeau, jamais re-affiché).
- Vérification publique via `POST /api/gateway/verify` (rate-limit 1000/min/IP, log `ApiLog`).
- Rotation stratégie `API_KEY` : révoque l'ancienne clé + génère une nouvelle + redeploy GitHub Actions.
- **Pas de per-key rate-limit** sur `verify` : un attaquant avec IP unique pourrait tenter de deviner des clés. Entropie suffisante (128+ bits) rend le brute-force computationnellement impossible. À surveiller si usage public intensif.

### 3.12 Backup chiffré (✅)

Pull-based, GPG RSA 4096, escrow externe, vérification d'intégrité à chaque pull, restore-test mensuel automatisé. Voir [security.md §2.9 original] et [doc-install-backup.md](steps-docs/doc-install-backup.md).

### 3.13 Non couvert (backlog)

- **Rate-limit Bearer machine** (`/api/secrets/[slug]/[env]`) — faible priorité (brute-force sur 256 bits impraticable). Cf. [todo_v2.md](todo_v2.md).
- **DEPLOY_DENIED hors tenant** — JWT invalide avant résolution du tenant → pas d'audit DB. Table `admin.deploy_denied` envisagée en V2.
- **Monitoring infrastructure** — état serveurs / replica / backups sur `/admin`. Cf. [todo_v2.md](todo_v2.md).

> Note : les **scans DAST automatiques** (OWASP ZAP + Nuclei), initialement listés ici comme différés, sont en fait **livrés** et tournent à chaque push `staging` — voir §3.16.

### 3.14 Nouvelles lacunes identifiées (2026-05-15)

#### 3.14.1 ROTATION_HMAC_KEY — criticité (⚠️)

`ROTATION_HMAC_KEY` est utilisée pour signer les callbacks N8n vers `POST /api/cron/rotation` (HMAC-SHA256, fenêtre ±1h, token à usage unique). Si cette clé fuite :

1. Un attaquant peut forger un callback N8n valide pour n'importe quel secret.
2. `PATCH /api/rotation/admin/secret-value` (protégé par `CRON_SECRET_ADMIN` / `timingSafeEqual`) peut être appelé directement si `CRON_SECRET_ADMIN` est aussi compromis.
3. Résultat : écriture arbitraire de valeur chiffrée dans un `Secret` tenant.

**Traitement requis** : `ROTATION_HMAC_KEY` doit être traitée avec la même rigueur que `ENCRYPTION_KEY` — jamais en repo, uniquement dans les secrets opérateur (`.env` VPS / GitHub Secrets). Renouvellement manuel en cas de suspicion de compromission (réécrire la valeur dans l'env + redéployer).

#### 3.14.2 npm audit / CVE scanning (✅ — livré 2026-05-30)

Scan SCA des dépendances en CI. Les packages suivants sont critiques pour la sécurité :

| Package | Rôle |
|---|---|
| `next` | Framework — vulnérabilités régulières (XSS, path traversal, SSRF) |
| `@prisma/client` | ORM — injection SQL si mal utilisé |
| `jose` | Validation JWT OIDC — CVE sur `jwtVerify` historiquement |
| `bcryptjs` | Hash mots de passe |
| `otplib` | TOTP 2FA |

**Livré** : job `npm-audit` dans [.github/workflows/security.yml](../.github/workflows/security.yml) — `npm audit --omit=dev --audit-level=high` sur chaque push (`main`/`staging`) et PR, **bloque sur high/critical**. Cible les dépendances de production (runtime) pour rester actionnable ; les advisories dev-only ne bloquent pas. Complémentaire des scans DAST (§3.16) : SCA = vulnérabilités des packages, DAST = app en exécution.

#### 3.14.3 Session fixation après changement de mot de passe / révocation 2FA (⚠️ non vérifié)

NextAuth v5 émet des JWT sessionToken avec expiration. Après un changement de mot de passe ou une révocation 2FA, les JWT existants restent cryptographiquement valides jusqu'à leur expiration naturelle — il n'existe pas de mécanisme de révocation JWT intrinsèque.

**Non vérifié** : est-ce que l'app invalide explicitement les sessions actives (via `sessionToken` en DB ou rotation de `NEXTAUTH_SECRET`) après ces opérations ?

**Risque** : si un attaquant vole un sessionToken avant que la victime change son mot de passe, il garde l'accès jusqu'à l'expiration du JWT.

**Action recommandée** : vérifier [lib/auth.ts](../lib/auth.ts) et les routes `/api/auth/reset-password`, `/api/user/2fa/disable`. Si pas d'invalidation, documenter la fenêtre de risque et envisager une table `SessionRevocation` ou un champ `sessionVersion` sur `User`.

#### 3.14.4 ENCRYPTION_KEY re-keying (✅ — script + procédure livrés 2026-06-24)

Procédure de rotation de la clé maître `ENCRYPTION_KEY` (rotation planifiée **ou** récupération après compromission). Tous les secrets serveur (`Secret`/`SecretVersion`, `OrgSecret`/`OrgSecretVersion`, `Service` (2 triplets), `AppAccount`, `Server`, `VaultEntry`/`TeamVaultEntry` (2 triplets), `User.twoFactor*`, `Api.jwtSecret*`, `CiConnectionSecret`, `ProjectEmailConfig`, `ProjectBackupConfig.agentToken*`) sont chiffrés AES-256-GCM avec cette clé unique, **sans versioning dans le payload** → faire tourner la clé EXIGE un re-keying (déchiffrer sous l'ancienne, re-chiffrer sous la nouvelle).

**Mécanisme dual-key** ([lib/crypto.ts](../../lib/crypto.ts)) : si `ENCRYPTION_KEY_OLD` est définie, `decrypt()` y retombe quand la clé courante échoue. Pendant la migration, les lignes encore sous l'ancienne clé ET les nouvelles restent lisibles → **zéro downtime**. Absente, le comportement est strictement inchangé.

**Script** : [scripts/rekey-encryption.mjs](../../scripts/rekey-encryption.mjs). Idempotent/reprenable (saute ce qui est déjà sous la nouvelle clé), transaction par lot, **dry-run par défaut**, robuste au drift de schéma (table/colonne absente sautée), parcourt tous les schémas `client_*` (+`public` via `--include-public`).

> **Exclus du re-keying** (zero-knowledge — le serveur ne peut pas déchiffrer) : `OneTimeShare` (chiffré navigateur) et `SecretRequest` (hybride ECDH/ML-KEM, déchiffré par le destinataire). Invariant : un champ re-keyable côté serveur possède une colonne `tag` GCM.

**Procédure ops** (à lancer **en conteneur** — `node` direct, l'image runtime n'a ni npm ni npx) :
1. **Backup DB** (le script réécrit des données ; il ne touche PAS au schéma).
2. Générer la nouvelle clé : `openssl rand -hex 32` → `K2`.
3. Déployer avec `ENCRYPTION_KEY=K2` **et** `ENCRYPTION_KEY_OLD=K1` (ancienne). L'app reste pleinement fonctionnelle (fallback dual-key).
4. **Dry-run** (lecture seule, compte les lignes à migrer) :
   `docker compose exec app node scripts/rekey-encryption.mjs --include-public`
5. **Appliquer** : ajouter `--apply` (confirmation interactive, ou `--yes` en non-interactif).
6. **Vérifier** : relancer le dry-run → doit afficher `0 à migrer | … déjà K2 | 0 erreurs`.
7. **Retirer `ENCRYPTION_KEY_OLD`** du déploiement et redéployer (une fois le « 0 à migrer » confirmé). `K1` est alors révoquée.

> ⚠️ Ne PAS retirer `ENCRYPTION_KEY_OLD` avant que le dry-run ne confirme `0 à migrer` : toute ligne restée sous K1 deviendrait illisible. Une ligne illisible sous K1 ET K2 est loguée et laissée **intacte** (jamais d'écrasement aveugle).

Garde-fous tests : [tests/lib/rekey-script-interop.test.ts](../../tests/lib/rekey-script-interop.test.ts) (interop crypto script↔lib) + [tests/lib/rekey-registry.test.ts](../../tests/lib/rekey-registry.test.ts) (le registre couvre exactement les triplets GCM des schémas → détecte tout nouveau champ chiffré oublié). Cf. [todo_v2.md](todo_v2.md). Migration future de ce socle vers OpenBao Transit : gated par la HA OpenBao ([ha-openbao.md](steps-docs/todo/ha-openbao.md)).

#### 3.14.5 Middleware locale routing — cross-domain caveat (⚠️ mitigation applicative)

Le middleware `routing locale` ([middleware.ts](../middleware.ts), cf. `physalis.md §6.4`) redirige toute requête HTML sans préfixe `/{locale}/` vers `/{locale}/{path}`. L'URL absolue du redirect est construite à partir de `req.url`. Derrière Cloudflare avec rewrite du Host header (cas de l'infra prod où les sous-domaines tenants `<slug>.physalis.cloud` partagent un même origin), `req.url` peut perdre le host original — le `Location` du 307 pointe alors vers `vault.physalis.cloud` au lieu de `<slug>.physalis.cloud`.

**Impact** : un utilisateur connecté sur son sous-domaine tenant qui clique sur un `<Link href="/projects">` ou `router.push("/projects")` (path sans préfixe locale) est éjecté vers le portail partagé. Le tenant-guard l'envoie alors vers `/{locale}/login?callbackUrl=...`, et selon les cookies, peut boucler.

**Pas un risque de fuite d'info** : aucun secret n'est révélé, la session NextAuth (cookie domain `.physalis.cloud`) reste valide. Le risque est purement UX (rupture de flow, boucle de login) et de **confusion sur l'origine d'auth** : un utilisateur formé à reconnaître `<slug>.physalis.cloud` comme son contexte légitime se retrouve déstabilisé sur `vault.physalis.cloud`.

**Mitigation actuelle** (livrée 2026-05-29, commits `64fb653`, `6e031ab`, `c6dadfa`) :
- Helper `@/i18n/navigation` (next-intl) qui préfixe automatiquement la locale active dans tous les `<Link>` / `useRouter().push` côté client — 36 composants migrés (dashboard + auth)
- `getTenantLoginUrl(plan, slug, { ..., locale? })` accepte la locale en option, passée par les callers user-facing (login-resolve API, dashboard logout, signup action)
- Fix client-side dans `login-form.tsx` qui préfixe `data.url` retourné par `/api/login-resolve` avant `window.location.href`, defense-in-depth

**Limite du mitigant** : un futur `<Link>` ou `router.push("/foo")` ajouté par erreur (oubli de l'import depuis `@/i18n/navigation`) recrée le bug silencieusement. Pas de garde-fou compilation/lint — la convention est documentée mais reposée sur la discipline. Cf. `todo_v2.md → i18n — root cause cross-domain` pour le fix à la source (utiliser `x-forwarded-host` côté middleware).

### 3.15 Module Email (Physalis Email) (✅ — revu 2026-05-30)

Module permettant à chaque projet d'envoyer ses emails via Physalis Email (serveur d'envoi auto-hébergé, repo séparé). Physalis dialogue avec Physalis Email via la **management API** (header `X-Service-Key`, hors chemin runtime) ; l'app cliente envoie via `POST /v1/send` avec la **clé API du projet** (`ph_live_sk_…`).

**Architecture & stockage**
- Config **par projet** dans `ProjectEmailConfig` (tenant schema) : domaine, IDs PF, **clé API chiffrée AES-256-GCM** (`encryptedKey/iv/tag`), DNS en JSON. Activation **par org** dans `OrgEmailConfig` (`enabled`, `accountId` PF partagé).
- Variables runtime (`PHYSALIS_EMAIL_API_KEY`, `PHYSALIS_EMAIL_DOMAIN`, `PHYSALIS_EMAIL_URL`) injectées dans le `.env` de chaque environnement **au déploiement** ([app/api/deploy/route.ts](../app/api/deploy/route.ts)) — jamais stockées en `Secret` éditable.
- Rotation auto **blue/green** de la clé API ([lib/rotators/physalis-email.ts](../lib/rotators/physalis-email.ts)) : nouvelle clé + redeploy, révocation de l'ancienne différée d'un cycle (fenêtre de grâce). Branchée sur le cron de rotation existant, gated `org.rotationFeatureEnabled`.

**Contrôles d'accès**
- **Gating fail-closed** : `isEmailModuleEnabled(email)` = `PHYSALIS_EMAIL_ENABLED === "true"` **ou** email ∈ `PHYSALIS_EMAIL_ALLOWED_EMAILS`. Routes → **404** si non autorisé (masque l'existence). Le rôle SUPERADMIN n'est pas porté par la session tenant — d'où le choix de l'allowlist par email.
- **RBAC** : lecture VIEWER, mutations EDITOR, activation org ADMIN, rotation EDITOR + feature org. Toutes les routes passent par `requireProjectMember`/`requireOrgMember` (→ 401 sans session).
- **Pas d'IDOR** : `accountId` (org) et `domainId` (projet) sont dérivés côté serveur depuis la config du projet autorisé, jamais pris du client.
- **Révélation de la clé** (`POST /email/reveal`) : EDITOR + **auditée** (`SECRET_REVEAL`) + rate-limitée (30/min/user). Bouton masqué aux non-EDITOR côté UI.

**Audit 2026-05-30 — findings traités**
- **#1 (moyen)** Mutation d'expéditeur scopée au **domaine** et non plus seulement au compte (Physalis Email `getSender` + check `domainId`) — empêchait un projet de muter l'expéditeur d'un autre projet du même compte.
- **#2 (faible)** Rate-limit par utilisateur sur `/email/send` (20/min) et `/email/reveal` (30/min).
- **#3** Historique des envois indexé **par compte** (liste Redis `accounts:<id>:emails` écrite best-effort par le worker, bornée à 500) → scoping natif par compte, découplé de la rétention globale de la queue. L'endpoint **admin** Physalis Email a aussi été re-scopé sur le compte du JWT (corrige une exposition cross-compte du filtre par domaine seul).
- **#4 / #5** Bouton Révéler masqué aux non-EDITOR ; renommage d'expéditeur audité.

**Isolation** : client `prisma` strict (search_path par tenant), rotator cron via `withTenantSchema`/`getTenantPrisma`. Pas de SSRF (URL construite sur `PHYSALIS_EMAIL_SERVICE_URL` de confiance + `encodeURIComponent`). `X-Service-Key` jamais loggée ni renvoyée.

**Résidus / à surveiller avant ouverture large (au-delà de l'allowlist)**
- La revue des findings ci-dessus est **manuelle** ; la surface déployée est par ailleurs scannée à chaque push `staging` par **OWASP ZAP + Nuclei** (§3.16).
- Les `details` d'erreur renvoient le texte d'erreur upstream Physalis Email (pas de secret ; acceptable pour outil admin).
- CSRF : routes mutantes via `fetch` + cookie SameSite, modèle identique au reste de l'app (§2.9).

### 3.16 Scans dynamiques (DAST) — OWASP ZAP + Nuclei (✅)

Exécutés automatiquement à chaque push sur `staging`, après le déploiement, dans [.github/workflows/deploy-staging.yml](../.github/workflows/deploy-staging.yml) (jobs `zap`, `nuclei`, `e2e` — tous `needs: deploy-staging`, ciblant `E2E_BASE_URL` = l'environnement staging réel).

- **OWASP ZAP** — `zaproxy/action-baseline@v0.14.0`, scan **passif** (baseline) de la surface staging. Règles ajustées via [.zap/rules.tsv](../.zap/rules.tsv) ; rapport en artefact (`zap-report`), `allow_issue_writing: false`.
- **Nuclei** — `projectdiscovery/nuclei-action@v3`, `-severity medium,high,critical`, `-tags cve,misconfig,exposure,headers`, `-exclude-tags dos,fuzz`. Couvre CVE connues, misconfigs, expositions et headers sur l'app déployée.
- **Playwright E2E** (`e2e`) — valide les flows UI critiques post-déploiement.

**Portée** : DAST = test de l'app **en cours d'exécution** (boîte noire). Complète mais ne remplace **pas** le scan **SCA des dépendances** (`npm audit` / CVE des packages), qui reste ❌ en CI (§3.14.2) — les deux couvrent des surfaces différentes.

---

## 4. Procédure de revue

Avant chaque livraison touchant à l'auth, au chiffrement, ou aux routes API :

1. Vérifier qu'aucune valeur de secret ne transite par les logs (`grep "console" lib/ app/api/`).
2. Confirmer que les nouvelles routes appellent `requireUser` / `requireOrgMember` / `requireProjectMember` avec le bon rôle — ou `validateIntegrationToken` pour les endpoints intégration.
3. Vérifier que les nouveaux endpoints opérateur appellent bien le helper partagé `requireCronAuth(req, tier)` (`lib/cron-auth.ts`) avec le bon tier (`"report"` pour le bas-privilège, `"admin"` sinon) — jamais de vérif inline copiée-collée.
4. Lancer `npm test && npm run test:integ` (docker compose up -d au préalable). Tout vert avant merge.
5. Lancer `npm audit --audit-level=high` — zéro high/critical avant merge. (En attendant l'intégration CI, cf. §3.14.2.)
6. Tests manuels critiques :
   - Token machine sur mauvais env → 403.
   - Token machine révoqué → 401.
   - Lecture SQL directe d'un `Secret` → uniquement base64.
   - `/api/deploy` sans Bearer → 401 ; Bearer invalide → 401 + audit `DEPLOY_DENIED`.
   - OrgToken avec scope insuffisant → 403 (Forbidden scope).
7. Vérifier headers HTTP : `curl -I https://vault.physalis.cloud/`.
8. Pour toute route publique intentionnelle (ex. `/api/public/secret-requests/*`) : documenter dans ce fichier pourquoi elle est sans auth.

Avant chaque livraison touchant au backup :

1. `bash -n` sur tous les scripts modifiés.
2. Vérifier qu'aucun secret sensible n'est ajouté à un fichier qui transite (logs, HTTP responses, `.env`).
3. Confirmer que la rétention ne supprime jamais le backup le plus récent.
