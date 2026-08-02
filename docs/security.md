# Physalis — Modèle de sécurité (self-host)

> Ce document décrit les protections de l'édition **self-host** — celles que
> contient ce dépôt — et, tout aussi important, **ce qui reste à votre charge**.
> Il ne décrit pas l'infrastructure de l'offre hébergée
> [physalis.cloud](https://physalis.cloud).

---

## 1. Partage des responsabilités

Physalis protège les secrets **dans l'application et dans la base**. Tout ce qui
est autour reste votre travail.

| Assuré par l'application | À votre charge |
|---|---|
| Chiffrement au repos des secrets et credentials | Conservation et escrow de `ENCRYPTION_KEY` |
| Hachage des mots de passe et des tokens | Terminaison TLS et configuration du reverse proxy |
| RBAC à trois niveaux, audit log | Ne pas exposer le conteneur en direct sur Internet |
| Rate limiting applicatif | Réglage de `TRUST_PROXY_HOPS` cohérent avec votre infra |
| En-têtes HTTP de durcissement | Sauvegardes, réplication, bascule (rien n'est fourni — cf. §11) |
| Validation OIDC stricte | Mises à jour de l'image et des dépendances hôte |

---

## 2. Chiffrement des secrets

**AES-256-GCM** ([lib/crypto.ts](../lib/crypto.ts)), via `node:crypto`.

- **Clé** : `ENCRYPTION_KEY`, 32 octets fournis en 64 caractères hexadécimaux,
  lue dans l'environnement du conteneur. Sa longueur est validée à chaque appel.
  **Jamais en base, jamais dans le code.**
- **IV** : 12 octets aléatoires tirés à *chaque* chiffrement, stockés à côté du
  ciphertext.
- **Tag d'authentification** : 16 octets GCM, vérifiés au déchiffrement — une
  valeur altérée en base lève une exception au lieu de rendre des octets
  arbitraires.
- **Périmètre** : `Secret`, `OrgSecret`, `Service.encryptedData`,
  `AppAccount.encryptedData`, `User.twoFactorSecret`, `Server.encryptedKey`
  (clé SSH), `VaultEntry` (mot de passe + secret TOTP), `TeamVaultEntry`,
  credentials des connexions CI et des cibles de synchronisation.
- **Vérification** : un `SELECT * FROM "Secret"` ne rend que du base64. Couvert
  par les tests d'intégration.

**Rotation de la clé** : [scripts/rekey-encryption.mjs](../scripts/rekey-encryption.mjs)
re-chiffre toutes les colonnes sous une nouvelle clé, en mode dual-key
(l'ancienne clé reste acceptée en lecture pendant la bascule), idempotent, avec
un mode `--dry-run`. À lancer en fenêtre de maintenance, dump préalable pris.

> **Invariant de revue — pas d'AAD.** Le chiffrement n'utilise pas de données
> authentifiées additionnelles : un triplet `{encryptedValue, iv, tag}` se
> déchiffre correctement dans n'importe quelle ligne. Rien dans le ciphertext ne
> le lie à son enregistrement d'origine. La règle qui tient cet invariant :
> **ne jamais persister un triplet que l'on n'a pas produit soi-même via
> `encrypt()` dans la même requête**, sauf pour snapshoter un secret vers *sa
> propre* version. Toute copie vers une ligne située derrière une autre
> frontière d'accès doit faire decrypt → encrypt avec un nouvel IV, jamais un
> transplant d'octets. Un test de non-régression garde la règle.

---

## 3. Mots de passe et sessions

- **Mots de passe** : bcrypt, salt 12, comparaison via `bcrypt.compare`.
  Minimum 12 caractères, contrôle de robustesse à la saisie
  ([lib/password-strength.ts](../lib/password-strength.ts)).
- **Sessions** : JWT NextAuth, durée de vie **8 h**, signés par `AUTH_SECRET`.
- **Invalidation anticipée** ([lib/session-validity.ts](../lib/session-validity.ts)) :
  chaque JWT est estampillé de son instant d'émission et l'utilisateur porte une
  borne `sessionsValidFrom`. Un reset de mot de passe ou une désactivation de la
  2FA avance la borne — tous les JWT antérieurs sont refusés, sans attendre leur
  expiration naturelle.
- **Attaque temporelle au login** ([lib/auth.ts](../lib/auth.ts)) : un hash
  bcrypt factice est calculé au chargement du module, et `rejectWithConstantTime`
  effectue une comparaison sur ce hash sur **tous** les chemins rapides
  (utilisateur inexistant, compte sans mot de passe). Un attaquant ne peut pas
  distinguer « email inconnu » de « mauvais mot de passe » au chronomètre.
- **CSRF** : géré par NextAuth sur les callbacks de connexion.

---

## 4. Double authentification (TOTP)

RFC 6238 via `otplib` ([lib/totp.ts](../lib/totp.ts)). Le secret est chiffré en
base en AES-256-GCM. **8 codes de secours** de 64 bits d'entropie sont générés à
l'activation, hachés en bcrypt, à usage unique. Une réauthentification est
exigée pour les actions sensibles ([lib/reauth.ts](../lib/reauth.ts)).

La 2FA est **obligatoire** pour utiliser l'extension navigateur.

---

## 5. Tokens

Quatre familles, toutes stockées **hachées en SHA-256**. La valeur brute n'est
retournée qu'une seule fois, à la création. Toutes révocables (`revokedAt`),
toutes horodatées (`lastUsedAt`).

| Famille | Préfixe | Durée | Portée |
|---|---|---|---|
| `MachineToken` | `sv_<hex>` | permanent, révocable | Un couple `(projet, environnement)` — toute autre combinaison renvoie 403 |
| `PluginToken` | `sv_plugin_<hex>` | 4 h | Session de l'extension navigateur |
| `UserToken` | `sv_user_<hex>` | 1 à 365 j | Lecture des projets dont l'utilisateur est membre |
| `OrgToken` | `sv_org_<hex>` | optionnelle | Une organisation, avec liste blanche de projets et de scopes |

Le lookup se fait en O(1) sur un index unique du hash. Un token révoqué renvoie
401 ; un token valide hors de sa portée renvoie 403, et le refus est journalisé.

---

## 6. Contrôle d'accès

Deux échelles de rangs, comparées numériquement :
**organisation** MEMBER < DEV < ADMIN_DEV < ADMIN < OWNER, **projet**
VIEWER < EDITOR < OWNER.

Helpers centraux dans [lib/api.ts](../lib/api.ts) : `requireUser`,
`requireOrgMember(slug, role)`, `requireProjectMember(slug, role)`,
`requireEnvironment(slug, env, role)`. Toute route passe par l'un d'eux.

Règles critiques :

- Org ADMIN / OWNER → `ProjectRole.OWNER` implicite sur tous les projets de
  l'org.
- Org DEV → `ProjectRole.EDITOR` implicite, sans ligne `ProjectMember`.
- Org MEMBER → accès à un projet **uniquement** s'il en est `ProjectMember`
  explicite.
- `User.role = ADMIN` → administrateur de l'instance, **sauf** sur les coffres
  personnels : c'est délibéré, un administrateur ne peut pas lire les entrées
  privées des autres utilisateurs.

### Barrière `ProjectMember.hidden` — invariant

`hidden = true` sur une ligne `ProjectMember` est une **barrière d'accès**
(403), pas un confort d'affichage : elle masque un projet à un membre donné tout
en préservant sa ligne, donc son rôle.

L'invariant : **tout calcul d'accès projet doit dériver du prédicat central
`accessibleProjectsWhere(orgId, userId, orgRole)`**, miroir strict des règles de
`requireProjectMember`. Ne jamais re-dériver l'autorisation à la main depuis
`ProjectMember` (`members[0]?.role`, `members: { some }`) en oubliant `hidden`.

Sémantique : Org ADMIN / OWNER **ignorent** `hidden` ; une ligne masquée
**bloque** un DEV ou un MEMBER **sans** retomber sur l'EDITOR implicite du DEV.

> Pourquoi l'invariant est fragile : le middleware **exclut `/api`** — il n'y a
> pas de goulot central côté API — et `hidden` n'apparaît nulle part ailleurs
> que dans `lib/api.ts`. Toute **nouvelle** surface d'accès projet doit passer
> par `requireProjectMember` / `requireEnvironment` / `accessibleProjectsWhere`.

---

## 7. En-têtes HTTP

Deux couches. Les en-têtes statiques sont posés par
[next.config.ts](../next.config.ts) :

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

HSTS est posé par l'**application** et pas seulement par le reverse proxy : une
erreur de configuration du proxy ne doit pas faire disparaître l'en-tête
silencieusement.

Sur les réponses HTML, [middleware.ts](../middleware.ts) génère un **nonce** par
requête et pose une CSP stricte : `script-src` avec `'nonce-…'` et
`'strict-dynamic'` — aucun script inline non-noncé n'est exécuté.
`'unsafe-inline'` ne subsiste que sur `style-src`, les attributs de style HTML ne
supportant pas les nonces. `frame-ancestors 'none'`, `object-src 'none'`,
`base-uri 'self'`, `form-action 'self'`.

---

## 8. Rate limiting

[lib/rate-limit.ts](../lib/rate-limit.ts) — fenêtre fixe, **en mémoire du
processus**.

| Portée | Limite | Clé |
|---|---|---|
| `login` | 30 / 15 min | IP |
| `login` (par compte) | 5 / 15 min | email |
| `register`, `signup` | 5 / h | IP |
| `forgot-password`, `reset-password` | 5 / h | IP |
| `invitation-register` | limité | IP |
| `deploy` | 30 / min | IP |
| `plugin-auth` | 5 / 15 min | IP |
| `share-consume` | 30 / min | IP |
| `secret-request-submit` | 5 / h | IP |
| `signup-check-slug` | 30 / min | IP |

### `TRUST_PROXY_HOPS` — le réglage qui décide de tout

Toutes ces limites sont clefées sur l'IP client, extraite de la chaîne
`X-Forwarded-For`. Cette chaîne se lit **par la droite** : les segments de
gauche viennent de l'appelant et sont donc forgeables ; seuls les N derniers
sont posés par votre infrastructure. `TRUST_PROXY_HOPS` déclare ce N.

- Application exposée en direct, ou un seul reverse proxy → `1` (défaut)
- Reverse proxy + CDN qui ajoute aussi l'IP (Cloudflare…) → `2`

Mal réglée, cette valeur rend **tous** les rate-limits contournables (valeur trop
haute : l'appelant contrôle le segment lu) ou trop agressifs (valeur trop basse :
tous vos utilisateurs partagent la même clé).

> ⚠️ Le comptage n'est sain que si l'application n'est **pas** joignable en
> direct. Sinon un appelant qui court-circuite le proxy raccourcit la chaîne d'un
> cran, et le segment lu redevient une valeur qu'il contrôle. Bindez le conteneur
> sur la boucle locale, ou filtrez au pare-feu.

---

## 9. Surfaces réseau et entrées non authentifiées

- **Base de données** : à garder sur le réseau Docker interne. N'exposez le port
  5432 sur l'hôte que si vous en avez un besoin explicite, et filtrez-le.
- **SSRF** ([lib/safe-fetch.ts](../lib/safe-fetch.ts)) : toute URL fournie par un
  utilisateur — webhook de rotation, cible de synchronisation, connexion CI —
  passe par un fetch qui refuse les adresses privées, de bouclage et de
  métadonnées cloud.
- **Extension navigateur** ([lib/plugin-cors.ts](../lib/plugin-cors.ts)) : les
  routes `/api/plugin/*` n'acceptent que l'origine déclarée dans
  `PLUGIN_ALLOWED_ORIGIN`. Variable absente ⇒ **403 sur tous ces endpoints**,
  fail-closed.
- **Routes publiques intentionnelles** : `/api/public/secret-requests/[token]/…`
  (soumission d'un secret par un tiers) et la consommation d'un partage à usage
  unique. Elles sont sans session par conception — l'autorisation est portée par
  le token du lien, à entropie élevée, à durée de vie courte et à usage unique.
- **Inscription publique** : `ALLOW_REGISTRATION="false"` par défaut. Ne
  l'activez que si votre instance est destinée à accueillir des inscriptions
  libres.

---

## 10. Journal d'audit

Table `AccessLog`, append-only. Chaque action sensible y est écrite avec
l'acteur (utilisateur **ou** token, dénormalisé pour survivre à la suppression
de la ligne d'origine), les identifiants d'organisation / projet /
environnement, la clé de secret concernée, l'IP, le user-agent et un blob
`metadata`. Les refus sont journalisés au même titre que les succès. Export CSV
depuis l'interface.

Côté journaux applicatifs : aucune valeur de secret, de mot de passe ou de token
en clair n'est écrite sur la sortie standard. Prisma est configuré en
`["error"]` en production.

---

## 11. Limites connues

Autant les énoncer que les laisser découvrir.

- **Le rate limiting est en mémoire du processus.** Les compteurs repartent de
  zéro à chaque redémarrage du conteneur, et ne sont pas partagés entre
  plusieurs instances. Un attaquant patient peut temporiser autour d'un
  redéploiement. Suffisant pour une instance unique ; à compléter par une
  limitation au niveau du reverse proxy si vous exposez l'instance largement.
- **Pas de liaison cryptographique entre un ciphertext et sa ligne** (absence
  d'AAD, cf. §2). Aucun chemin applicatif ne l'exploite aujourd'hui, mais
  l'invariant repose sur une règle de revue, pas sur le système de types.
- **Pas de rate limit sur `/api/secrets/[slug]/[env]`** (Bearer machine). Le
  brute-force est impraticable — 256 bits d'entropie — mais un token compromis
  utilisé en boucle ne déclenche aucun seuil ; c'est l'audit log qui doit le
  révéler.
- **Aucune sauvegarde, réplication ni bascule n'est fournie** (cf. §12).
- **Emails optionnels** : sans configuration Mailgun, l'application démarre mais
  les invitations et les réinitialisations de mot de passe ne partent pas. Le
  premier administrateur est créé par variables d'environnement, donc l'instance
  reste utilisable.

---

## 12. Sauvegarde et continuité

Ce dépôt ne fournit **ni backup, ni réplication, ni mécanisme de bascule** —
aucun script, aucun cron. C'est votre infrastructure. Au minimum :

1. un dump régulier de PostgreSQL (`pg_dump`), chiffré, stocké **hors** du
   serveur qui l'a produit ;
2. une copie de `ENCRYPTION_KEY` en escrow, séparée des dumps — un dump sans la
   clé est irrécupérable, et la clé sans dump ne vaut rien ;
3. un test de restauration périodique, sinon vous n'avez pas une sauvegarde,
   vous avez des fichiers.

Stocker la clé au même endroit que les archives annule l'essentiel du bénéfice :
qui obtient les unes obtient l'autre.

---

## 13. Procédure de revue

Avant toute livraison touchant à l'authentification, au chiffrement ou aux
routes d'API :

1. Vérifier qu'aucune valeur de secret ne transite par les journaux.
2. Confirmer que les nouvelles routes appellent `requireUser` /
   `requireOrgMember` / `requireProjectMember` / `requireEnvironment` avec le bon
   rôle. **Toute dérivation d'accès projet écrite à la main doit lire la barrière
   `hidden`** — préférer les helpers ou `accessibleProjectsWhere` (§6).
3. Lancer `npm test && npm run test:integ` (stack Docker démarrée). Tout vert
   avant merge.
4. Lancer `npm audit --audit-level=high` — zéro vulnérabilité haute ou critique.
5. Contrôles manuels utiles :
   - token machine sur un mauvais environnement → 403 ;
   - token machine révoqué → 401 ;
   - lecture SQL directe d'un `Secret` → uniquement du base64 ;
   - `/api/deploy` sans Bearer → 401 ; Bearer invalide → 401 + entrée d'audit ;
   - `OrgToken` avec un scope insuffisant → 403.
6. Vérifier les en-têtes HTTP servis par votre instance : `curl -I https://<votre-domaine>/`.
7. Pour toute nouvelle route publique intentionnelle, documenter ici pourquoi
   elle est sans authentification.

---

## 14. Signaler une vulnérabilité

Ouvrez un ticket sur
[github.com/physalis-cloud/physalis/issues](https://github.com/physalis-cloud/physalis/issues)
**sans détail exploitable** et demandez un canal privé pour la suite.
