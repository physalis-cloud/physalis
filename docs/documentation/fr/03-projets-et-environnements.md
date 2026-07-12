---
title: Projets & environnements
order: 3
icon: RiFolderOpenLine
summary: Créer un projet, gérer ses environnements, lier un serveur de déploiement.
---

# Projets & environnements

Dans Physalis, chaque application déployée est représentée par un
**projet** rattaché à une organisation. Un projet contient :

- Une liste d'**environnements** (`production`, `staging`, `main`…) avec
  chacun ses propres secrets
- Des **services** et **comptes applicatifs** (BDD, services tiers, accès
  admin) chiffrés
- Des **policies de déploiement** OIDC (qui peut déployer quoi)
- Optionnellement, un **coffre d'équipe** scopé au projet

## Créer un projet

> Permissions : **ADMIN** ou **OWNER** de l'organisation. Les **DEV**
> peuvent voir tous les projets mais pas en créer.

1. Allez sur `/projects` (onglet **Projets** dans la nav).
2. Dans **« Créer un projet »**, saisissez le **nom** de votre projet, puis
   cliquez sur **« Créer »**.
3. Le projet apparaît dans un bloc **« sans groupe »** par défaut. Son **slug**
   (identifiant URL-safe utilisé dans `/projects/<slug>` et le bundle de
   déploiement) est **dérivé du nom**.

> ⚠️ Le **slug est définitif** : il sert d'ancrage pour les Policies de
> déploiement OIDC. Le changer plus tard cassera tous les workflows qui
> le référencent.

## Créer un environnement

À la création d'un projet, **trois environnements sont créés par défaut** :
`development`, `staging` et `production`. Vous les gérez depuis les **paramètres
du projet** — onglet **« Environnements »** — et pouvez en **ajouter** d'autres
avec le bouton **« + Nouvel environnement »**.

Champs d'un environnement :

| Champ            | Description                                                                 |
|------------------|-----------------------------------------------------------------------------|
| **Nom**          | `production`, `staging`, `main`, `preview`… (en minuscules par convention) |
| **URL publique** | URL où l'app sera accessible (affichée dans le dashboard, optionnel)       |
| **Server**       | Serveur SSH cible (cf. ci-dessous)                                          |
| **Deploy path**  | Chemin absolu sur le VPS où sera déployé l'app (défaut auto, voir plus bas) |
| **Docker Compose** | YAML complet du `docker-compose.yml` qui sera poussé au déploiement (optionnel) |

### Convention `defaultDeployPath`

Si vous laissez **Deploy path** vide, Physalis applique automatiquement la
convention :

```
/srv/projets/<env>/<slug>
```

Par exemple, le projet `physalis` en environnement `production` sera
déployé dans `/srv/projets/production/physalis` sur le VPS.

C'est la convention recommandée — vous n'avez à saisir un chemin
custom que si vous avez une infrastructure VPS atypique.

### Lien Server ↔ Environment

Le **Server** est défini au niveau organisation (un serveur SSH = une
clé chiffrée = une cible). Chaque environnement pointe vers **un seul
serveur**, mais **un même serveur peut héberger plusieurs environnements**
(par exemple `staging` et `preview` sur le même VPS de test).

Création / édition des serveurs : page de l'org → onglet **« Serveurs »**.
Voir [Déploiement OIDC](deploiement-oidc) pour la configuration complète.

### Docker Compose embarqué

Si vous renseignez un `docker-compose.yml` dans Physalis, il sera **poussé
au déploiement** par le workflow OIDC sur le VPS, dans le `deployPath`.
Pratique pour piloter la stack depuis un seul endroit (Physalis devient
la source de vérité).

Si vous laissez vide, votre VPS doit déjà avoir un `docker-compose.yml`
local — Physalis ne touchera qu'au `.env`.

## Modifier un environnement

Cliquez sur un environnement dans la liste pour ouvrir sa page de détail.
Vous y trouverez :

- **Secrets** — la liste de toutes les variables `.env` chiffrées
  ([→ Secrets](secrets))
- **Settings** — les champs ci-dessus, modifiables
- **Bouton « Redéployer »** — déclenche un `workflow_dispatch` GitHub
  Actions sur la branche associée (nécessite `GITHUB_DISPATCH_TOKEN` en
  OrgSecret, cf. [Organisations & rôles](organisations-et-roles))

## Onglet « Accès » du projet

Cet onglet regroupe les **références non-secrètes** liées au projet :

- **Cards d'environnement** — récap visuel par env (URL, serveur, dernier
  déploiement vu dans l'audit)
- **Services** — entrées pour les services liés au projet. Deux usages :
  - *service tiers* (Sentry, Stripe…) : **identifiant + mot de passe** chiffrés ;
  - *service backend* : souvent **juste une URL** (identifiant/mot de passe
    **optionnels**), qui peut porter le **hook de rotation des comptes** liés.
- **Comptes applicatifs** (`AppAccount`) — credentials d'utilisateurs
  applicatifs (admin Strapi, super-user PostgreSQL…) chiffrés. Un compte peut
  être **lié à un environnement** (frontend) ou à un **service** (backend) :
  son URL en découle (l'extension le propose alors sur la bonne page).

C'est l'endroit où vous documentez « comment se connecter à ce projet
manuellement », sans polluer les secrets injectés au runtime.

> Services et comptes peuvent aussi être **rotés** (rappel assisté, ou
> **webhook** pour les comptes via le hook du service backend lié) — voir
> [Rotation des secrets](rotations).

## Permissions par projet (`ProjectMember`)

À la racine, **les rôles d'organisation suffisent** :

- ADMIN / OWNER → OWNER implicite sur tous les projets
- DEV → EDITOR implicite sur tous les projets
- MEMBER → **aucun projet visible** sans `ProjectMember` explicite

Pour donner accès à un MEMBER à un projet précis (ou à un DEV qu'on veut
restreindre, ou pour faire d'un DEV un OWNER de projet) :

1. Page du projet → onglet **« Membres »**.
2. **« + Ajouter »** → choisir l'utilisateur (déjà membre de l'org) et
   son rôle :
   - **VIEWER** — lecture seule
   - **EDITOR** — peut modifier secrets, envs, services
   - **OWNER** — tout EDITOR + suppression du projet, gestion des membres

> 💡 Les `ProjectMember` ne **dégradent jamais** un rôle : un OWNER d'org
> reste OWNER de projet même si on l'ajoute en VIEWER. Le rôle effectif
> est le **maximum** entre rôle d'org implicite et rôle de projet explicite.

## Supprimer un projet

> Réservé au rôle **OWNER de projet** (ou ADMIN/OWNER d'org via héritage).

Onglet **« Paramètres »** → section **« Zone dangereuse »**. La
suppression :

- Détruit tous les environnements et leurs secrets
- Détruit toutes les Policies OIDC liées (les workflows GitHub Actions
  associés ne pourront plus déployer)
- Est **irréversible**

## Aller plus loin

- [Secrets](secrets) — gérer les variables `.env` d'un environnement
- [Déploiement OIDC](deploiement-oidc) — configurer Server, Policy,
  workflow GitHub Actions
- [Coffres](coffres) — créer un coffre d'équipe scopé au projet pour
  partager des credentials non-runtime
