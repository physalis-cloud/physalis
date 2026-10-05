---
title: Rotation des secrets
order: 10
icon: RiRefreshLine
summary: Renouveler automatiquement ou par rappel assisté les secrets, clés, mots de passe de base de données et comptes applicatifs.
---

# Rotation des secrets

La **rotation** renouvelle périodiquement un credential. Le principe clé :
on **change le credential à la source** (sur le système cible), **puis** on met à
jour la valeur dans Physalis — ce n'est pas un simple `upsert` dans le vault.

Deux familles :

- **Automatique** — un exécuteur change le credential à la source puis reporte
  la nouvelle valeur (bases de données, secrets internes, hooks d'application…).
- **Rappel assisté** — Physalis ne peut pas changer le credential à votre place
  (mot de passe humain, compte tiers) : il vous **notifie**, et vous **générez /
  saisissez** la nouvelle valeur qui est alors enregistrée et versionnée.

La rotation s'applique à plusieurs **endroits où vivent des secrets** :

| Objet | Où | Stratégies possibles |
|-------|-----|----------------------|
| **Secret d'environnement** | onglet *Secrets* d'un projet | Database, JWT, Clé API, Webhook, Rappel |
| **Service** (Stripe, OVH…) | onglet *Accès* | Rappel assisté (sur ses propres identifiants) |
| **Compte applicatif** | onglet *Accès* | Rappel assisté, **Webhook** (hook du backend lié) ou **Base de données** (rôle/utilisateur d'une base managée type Supabase) |
| **Entrée de coffre** d'équipe / d'org | onglet *Coffre* | Rappel assisté |

## Quelle stratégie pour quel cas ?

| Vous voulez roter… | Stratégie | Comment |
|--------------------|-----------|---------|
| un mot de passe de **base de données** (rôle PG/MySQL) | **Database** | automatique, self-rotation |
| un **JWT / session / clé de chiffrement** interne | **JWT Secret** | automatique, généré par Physalis |
| une **clé de l'API Gateway** Physalis | **Clé API** | automatique |
| un **mot de passe de compte** (admin/utilisateur) hashé par l'app | **Webhook** | l'app applique via un hook |
| un **compte d'une base managée** (rôle Postgres ou utilisateur Supabase Auth) | **Base de données** | Physalis se connecte (admin du service lié) et applique |
| une **clé tierce / token** (Stripe, Mailgun…) qu'aucun hook ne couvre | **Rappel** | vous changez à la source, puis enregistrez |

## Prérequis

La rotation est **opt-in au niveau de l'organisation** et réservée aux **plans
payants**. Un **ADMIN** ou **OWNER** de l'org l'active dans
*Paramètres de l'organisation → Avancé*. Tant qu'elle est désactivée, aucun
bouton de rotation n'apparaît et le cron ignore l'organisation.

Elle se suspend aussi quand un **projet est mis en pause**.

## Le bouton « Rotation »

Partout (secret, service, compte, entrée de coffre), un **seul bouton
« Rotation »** ouvre une modale qui regroupe :

1. **La configuration** : activer + **intervalle** (en jours) + la **stratégie**
   (pour les secrets d'environnement).
2. **La rotation immédiate** : pour un rappel, une section *générer / saisir* la
   nouvelle valeur ; pour une stratégie automatique, un bouton **« Forcer »**.

> Le bouton « Rotation » n'apparaît que sur les éléments qui ressemblent à un
> credential (le nom contient `password`, `secret`, `token`, `key`, `jwt`…). Un
> `PORT`, une URL publique ou un flag n'en ont pas. Toutes les stratégies
> restent sélectionnables dans la modale, avec un **défaut intelligent** déduit
> du nom (un `*_PASSWORD` → Database, un `JWT_SECRET` → JWT, le reste → Rappel).

## Stratégies (secrets d'environnement)

### Base de données

Rotation **self-rotation** du mot de passe d'un rôle PostgreSQL / MySQL : on se
connecte **en tant que** l'utilisateur à roter (avec son mot de passe courant,
lu depuis le `.env` injecté) et on exécute `ALTER … PASSWORD` — **aucun
credential admin** n'est stocké ni utilisé. Deux modes d'exécution :

- **Agent sur le VPS** *(défaut)* — pour une **base interne au réseau Docker**
  du projet : le sidecar **agent** (le même que pour les backups) effectue la
  rotation **en local**, puis reporte la nouvelle valeur à Physalis. **Aucun
  appel externe** n'est nécessaire.
- **Directe** — pour une **base managée joignable en TCP+SSL** (Supabase, RDS,
  Neon…) : Physalis s'y connecte **directement** (avec le mot de passe courant du
  vault), exécute l'`ALTER`, vérifie la reconnexion, puis committe. **Aucune
  dépendance externe** (pas de N8n). PostgreSQL pour l'instant.

| Champ | Description |
|-------|-------------|
| `dbType` | `POSTGRESQL` ou `MYSQL` |
| `dbHost` | hôte (nom de service Docker en mode Agent, hôte public en Directe) |
| `dbPort` | port (`5432`, `3306`…) |
| `dbName` | nom de la base |
| `dbUser` | utilisateur dont le mot de passe est roté |

Après confirmation du changement à la source, Physalis écrit la nouvelle valeur
(snapshot de l'ancienne dans le versioning) et déclenche un **redéploiement**
pour que l'application recharge son `.env`.

### JWT Secret

Physalis **génère lui-même** une nouvelle valeur aléatoire (64 octets), la
chiffre, archive l'ancienne, puis déclenche un redéploiement — **sans
intervention externe**. Idéale pour `JWT_SECRET`, `NEXTAUTH_SECRET`,
`SESSION_SECRET`, clés de chiffrement internes…

### Clé API Gateway

Génère une nouvelle clé dans l'**API Gateway** du projet, met à jour le secret,
**révoque immédiatement** l'ancienne, puis redéploie. Le secret doit être lié à
une clé existante (sélection API + clé). Concerne uniquement les clés **émises
par la gateway Physalis** (pas une clé tierce type Stripe).

### Webhook (hook côté application)

Pour les credentials que **seule l'application sait appliquer** — typiquement un
**mot de passe de compte** hashé en base par l'app (admin, utilisateur). Voir
la section **Rotation par hook (Webhook)** ci-dessous.

### Rappel (assisté)

Physalis **ne change rien à la source**. À l'échéance, il envoie une
**notification** (centre de notifications, e-mail et webhook selon les
destinations d'alertes de l'org) et la pastille horloge de l'objet passe à
l'orange « À roter ». Un préavis part aussi quelques jours avant (7 par défaut). Vous changez le credential chez le fournisseur,
puis, via la **rotation immédiate** de la modale, vous **générez ou saisissez**
la nouvelle valeur : Physalis l'enregistre et archive l'ancienne. Adapté aux
clés tierces, tokens, mots de passe partagés.

## Rotation par hook (Webhook)

La rotation des **comptes admin/utilisateurs** est bloquée par le **hashing** :
seule l'application sait hasher correctement le mot de passe (bcrypt, argon2,
sel, pepper…). Reproduire ce hashing côté Physalis serait fragile et risquerait
un lockout. La solution : **un hook exposé par l'application**, qui applique le
nouveau mot de passe avec son propre code.

**Principe** : Physalis (ou l'agent) **génère** un mot de passe fort et l'envoie
au hook ; l'application l'**applique** (hashe + met à jour sa source) et répond
**2xx** ; Physalis **committe alors** la valeur qu'il a générée.

### Le contrat du hook

L'application doit exposer un endpoint qui répond `2xx` une fois le credential
appliqué :

```http
POST <url-du-hook>
Authorization: Bearer <token>        # optionnel mais recommandé
Content-Type: application/json

# pour un secret d'environnement :
{ "secretKey": "ADMIN_PASSWORD", "newValue": "<généré par Physalis>" }

# pour un compte applicatif :
{ "user": "admin@exemple.fr", "newValue": "<généré par Physalis>" }
```

- **`Bearer <token>`** : secret partagé. Vous le renseignez dans Physalis, et
  votre hook le vérifie. C'est souvent un **token fourni par le backend** (ex.
  un token d'accès Directus) que vous collez ; un bouton *Générer* est dispo si
  vous préférez un secret dédié.
- **Réponse `2xx`** = appliqué → Physalis enregistre la valeur. Tout autre code
  = échec → rien n'est committé (pas de dérive).

### Modes (joignabilité du hook)

- **Agent** — le hook est **interne** au réseau Docker du projet
  (ex. `http://app:3000/internal/rotate`) : c'est l'**agent** qui l'appelle.
  Cas courant d'une app cliente self-hostée non exposée.
- **Directe** — le hook est **joignable depuis Physalis** (URL publique, plate-
  forme d'automatisation) : Physalis l'appelle directement.

### Où se configure le hook ?

- **Secret** d'environnement en stratégie Webhook : l'URL/token/mode se règlent
  **sur le secret**.
- **Compte applicatif** : le hook se règle **sur le service backend lié** (voir
  la section **Comptes applicatifs**). Ainsi, plusieurs comptes du même backend
  partagent un seul hook.

### Exemple : Directus

Directus n'a pas d'endpoint à ce format ; créez un **Flow** :

1. *Settings → Flows → Create Flow*. Déclencheur **Webhook (POST)**, **Response
   Body = « Data of last operation »** → l'URL `…/flows/trigger/<id>` est votre
   URL de hook.
2. *(auth)* opération **Condition** : `{{$trigger.headers.authorization}}` égal
   à `Bearer <votre-token>`.
3. **Read Data** sur `directus_users`, filtre `email == {{$trigger.body.user}}`
   → récupère l'`id`.
4. **Update Data** sur `directus_users`, clé = cet `id`, payload
   `{ "password": "{{$trigger.body.newValue}}" }` (Directus hashe en argon2).

## Comptes applicatifs

Un **Compte** (onglet *Accès*) représente des identifiants de login pour l'app
du projet. Vous pouvez le **lier** à un **environnement** (frontend) ou à un
**service** (backend) : son URL en découle (source unique, synchronisée), ce qui
permet à l'extension navigateur de le proposer sur la bonne page.

Côté rotation, un compte a trois stratégies possibles :

- **Rappel** (assisté) — par défaut.
- **Webhook** — il **doit être lié à un service backend dont le hook est
  configuré** (le hook vit sur le service). « Forcer » exécute le hook (mode
  Directe) ou le délègue à l'agent (mode Agent).
- **Base de données** — pour un compte d'une **base managée** (Supabase…) : il
  doit être lié à un **service « base de données »** (voir ci-dessous). Physalis
  se connecte avec l'**admin DB du service** et applique le nouveau mot de passe.
  Deux **types de cible** :
  - **Rôle de base** (PostgreSQL) → `ALTER ROLE` ; l'identifiant du compte = le
    nom du rôle.
  - **Utilisateur Supabase Auth** (`auth.users`) → `UPDATE auth.users` (hash
    bcrypt) ; l'identifiant du compte = l'**email**.

## Services

Un **Service** (onglet *Accès*) a trois usages :

- **Service tiers** (Stripe, OVH…) : un identifiant + un mot de passe. Sa
  rotation est un **rappel assisté** sur ses propres identifiants.
- **Service backend** : souvent **juste une URL** (identifiant/mot de passe
  **optionnels**), qui porte le **hook de rotation des comptes** liés. La section
  « Hook de rotation des comptes » de l'éditeur définit l'URL, le token et le
  mode (Agent / Directe).
- **Service base de données managée** (Supabase, RDS…) : coche **« Cible base de
  données »** et renseigne `type / hôte / port / base` **+ un identifiant et un
  mot de passe de connexion DB dédiés** (l'admin, ex. `postgres` ou
  `postgres.<ref>` via le pooler Supabase). ⚠️ Ces identifiants DB sont
  **distincts** des identifiants « du haut » (qui, eux, documentent le **login du
  dashboard**). Les comptes liés en stratégie **Base de données** rotent via cette
  connexion admin.

## Pas à pas : roter le mot de passe d'un compte via un hook

Cas type : un compte **admin** d'une app cliente, dont le mot de passe est hashé
en base par l'application.

1. **Exposez un hook côté app** : un endpoint qui reçoit `{ user, newValue }`,
   applique le nouveau mot de passe (le hashe + met à jour la ligne) et répond
   `2xx`. (Avec Directus, un *Flow* — voir l'exemple ci-dessus.)
2. **Créez/éditez le service backend** (onglet *Accès*) : renseignez son **URL**,
   activez **« Hook de rotation des comptes »** et saisissez l'**URL du hook**, le
   **token** et le **mode** (Agent si le hook est interne au réseau Docker,
   Directe s'il est joignable depuis Physalis). Les identifiants du service sont
   optionnels.
3. **Liez le compte au service** : dans l'éditeur du compte, *Lié à → Service →*
   votre backend.
4. **Activez la rotation du compte** : bouton **Rotation** → activez, intervalle,
   stratégie **Webhook**. Un indicateur confirme que le service lié a bien un hook.
5. **Testez** : bouton **« Forcer la rotation »**. En mode Directe, Physalis
   appelle le hook immédiatement ; si le hook répond `2xx`, la nouvelle valeur est
   enregistrée et versionnée. En mode Agent, l'agent l'exécute à son prochain cycle.

> Vérifiez d'abord le mécanisme en pointant le hook vers un endpoint de test qui
> renvoie `200` (par ex. webhook.site) : vous confirmez le cycle
> *générer → POST → enregistrer* sans risque de lockout, puis branchez le vrai hook.

## Coffres d'équipe et d'organisation

Les entrées de coffre se rotent en **rappel assisté** (générer/saisir + archivage
des 3 dernières valeurs pour revert). Les entrées de coffre **projet** apparaissent
aussi dans l'onglet Rotation de l'org ; les coffres **org** se gèrent depuis
l'onglet Coffre.

## Rotation immédiate & « Forcer »

Depuis la modale d'un élément, ou depuis l'onglet **Rotation** de l'organisation :

- **Rappel / assisté** → section *Rotation immédiate* : générez ou saisissez la
  nouvelle valeur. Une **confirmation bloquante** rappelle que Physalis
  enregistre la valeur **mais ne l'applique pas à la source** — changez-la
  d'abord chez le fournisseur.
- **Stratégie automatique** (Database, JWT, Clé API, Webhook) → bouton
  **« Forcer »** : déclenche la rotation maintenant, hors planning.

## Onglet « Rotation » de l'organisation

Vue d'ensemble groupée par projet de toutes les rotations actives (secrets,
clés email, services, comptes, coffres projet). Chaque ligne a un bouton
**Rotation** (config + immédiate). Un **OWNER** de projet peut **mettre en
pause** toutes ses rotations (utile pendant une maintenance) :

```http
PATCH /api/projects/<slug>/rotation/pause
{ "paused": true }
```

## Planification

Les rotations automatiques s'exécutent à une **heure creuse** configurable
(défaut **2 h UTC**) : le bref redéploiement de fin de rotation tombe ainsi hors
des heures de pointe. Le bouton **« Forcer »** ignore cette fenêtre.

## États et suivi

| Champ | Description |
|-------|-------------|
| `rotationLastStatus` | `success`, `error` ou vide |
| `rotationLastAt` | date de la dernière rotation |
| `rotationNextAt` | prochaine échéance planifiée |

Une notification e-mail part à l'**ADMIN / OWNER** au **premier échec** (pas de
spam ensuite). Toute rotation est tracée dans l'audit log.

## Historique & revert

- **Secrets d'environnement** : l'ancienne valeur est archivée dans le
  **versioning** complet du secret (voir *Secrets & catégories*).
- **Services, comptes, entrées de coffre** (pas de versioning) : les **3
  dernières valeurs** sont conservées pour pouvoir revenir en arrière.

## Dépannage

| Symptôme | Cause probable / solution |
|----------|---------------------------|
| **« Forcer » renvoie une erreur `Échec du hook : … »`** | Le hook a répondu non-2xx ou est injoignable. Le message inclut le code et le début de la réponse. Vérifiez l'URL, le token (`Bearer`), et que le hook répond bien `2xx`. |
| **502 / la page ne répond pas en forçant** | Le hook ne répond pas dans les temps. En mode **Directe**, l'URL doit être joignable **depuis Physalis** (pas seulement depuis votre poste). Vérifiez que votre Flow renvoie une réponse (Response Body configuré). |
| **« Lie le compte à un service backend avec un hook »** | Le compte est en Webhook mais son service lié n'a pas de hook configuré. Réglez le hook **sur le service** (onglet Accès). |
| **Le compte n'apparaît pas dans l'extension** | L'extension propose un credential quand l'URL de la page correspond. Un compte apparaît sur l'URL de sa **cible liée** (environnement ou service) — pas sur une URL sans lien. |
| **Le bouton « Rotation » n'apparaît pas sur un secret** | Le nom n'est pas reconnu comme un credential (`PORT`, URL, flag…). C'est volontaire. |
| **Aucune rotation automatique ne se déclenche** | Le cron tourne en heure creuse (défaut 2 h UTC). Utilisez **« Forcer »** pour tester à la demande. Vérifiez aussi que la feature est activée sur l'org et le projet non en pause. |

## Sécurité

- **Self-rotation sans credential admin** (Database/Agent) : l'agent change le
  mot de passe **du compte qu'il utilise**, jamais un superuser.
- **Le hashing reste dans l'application** (Webhook) : Physalis ne reproduit
  jamais le schéma de hash d'une app.
- **Atomicité** : la nouvelle valeur n'est écrite qu'**après** confirmation du
  changement à la source → pas de dérive entre la source et le vault.
- **Le cron ne déchiffre jamais** de credential : il marque « dû » et délègue à
  l'exécuteur (agent, hook, ou rappel).
