---
title: Déploiement OIDC
order: 7
icon: RiCloudLine
summary: Déployer depuis GitHub Actions, GitLab CI/CD ou Bitbucket Pipelines sans aucun secret stocké, via des tokens OIDC signés par le fournisseur CI.
---

# Déploiement OIDC

Physalis remplace les anciens flows « PAT stocké + secrets CI » par une
authentification **OIDC** (OpenID Connect) basée sur des **tokens signés
par votre fournisseur CI** lui-même.

Trois fournisseurs sont supportés, avec le **même** mécanisme :

- **GitHub Actions**
- **GitLab CI/CD** (gitlab.com ou instance self-hosted)
- **Bitbucket Pipelines**

**Conséquence** : votre dépôt n'a **aucun** secret lié à Physalis. La
preuve d'identité est le token OIDC que le runner CI émet automatiquement
à chaque exécution de job. Physalis le vérifie contre une **Policy** avant
de renvoyer le bundle de déploiement (secrets + clé SSH + chemin).

## Schéma de bout en bout

```
┌─────────────────┐      ┌──────────────────────────┐      ┌────────────┐
│  Runner CI      │ OIDC │ /api/deploy de Physalis  │ SSH  │   VPS      │
│  (GH/GL/BB)     │─────▶│ - vérifie le token OIDC  │─────▶│ /srv/...   │
│                 │      │ - lookup Connexion+Policy│      │            │
│                 │◀─────│ - retourne bundle        │      │            │
└─────────────────┘      └──────────────────────────┘      └────────────┘
        │                                                         ▲
        │   POST .env + docker-compose + docker login + restart   │
        └─────────────────────────────────────────────────────────┘
```

Le runner CI, le VPS et le bundle SSH sont **identiques** quel que soit le
fournisseur. Seuls changent : le format de l'identifiant de dépôt, le claim
qui sert de 3ᵉ dimension à la Policy, et la façon dont le token est demandé.

## Les 4 objets à configurer

Avant de déclencher un déploiement, vous avez besoin de **4 objets** dans
Physalis :

1. Un **Server** au niveau organisation (clé SSH du VPS cible)
2. Un **Environment** lié à ce Server (avec un `deployPath`)
3. Une **Connexion CI/CD** au niveau organisation (fournisseur + issuer OIDC
   + éventuels credentials registry / redeploy)
4. Une **Policy** qui dit *« ce dépôt, sur cette branche, via ce job, peut
   déployer sur le projet P, environnement E »*

## Tableau de référence par fournisseur

Gardez ce tableau sous la main : il résume tout ce qui diffère entre les
trois fournisseurs. Le reste de la doc y fait référence.

| Aspect | GitHub | GitLab | Bitbucket |
|---|---|---|---|
| **Identifiant dépôt** (Policy + projet) | `owner/repo` | `project_path` (ex. `acme/web`, `acme/team/web`) | `repositoryUuid` (`{11111111-…}`) |
| **3ᵉ dimension de la Policy** | fichier workflow (`deploy.yml`) | `environment: name:` du job | `deployment:` du step |
| **Claim de branche** | `ref` | `$CI_COMMIT_BRANCH` | `branchName` |
| **Audience (`aud`)** | requise, doit matcher `OIDC_AUDIENCE` | requise, doit matcher `OIDC_AUDIENCE` | non supportée → non exigée |
| **Issuer (sur la connexion)** | vide pour github.com | vide pour gitlab.com ; URL d'instance si self-hosted | **requis** : URL OIDC du workspace |
| **Template** | [deploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.modele.yml) | [deploy.gitlab-ci.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.gitlab-ci.modele.yml) | [deploy.bitbucket-pipelines.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.bitbucket-pipelines.modele.yml) |

> **À noter** : seul le template GitHub embarque un **job `build`** qui
> construit l'image Docker et injecte les `VITE_*` en `--build-arg` (voir
> [§ Build args Vite](#build-args-vite-job-build)). Les templates GitLab et
> Bitbucket sont **deploy-only** : ils supposent que l'image est déjà
> construite et publiée sur un registre, et se contentent de tirer + relancer.

## 1. Créer un Server

> Permissions : ADMIN / OWNER de l'org.

Page de l'organisation → onglet **« Serveurs »** → **« + Nouveau serveur »**.

| Champ           | Description                                                                 |
|-----------------|-----------------------------------------------------------------------------|
| **Nom**         | Libellé interne (« VPS prod Hetzner »)                                      |
| **IP**          | IPv4 ou hostname résolvant le VPS                                            |
| **SSH user**    | L'utilisateur Linux côté VPS (typiquement `deploy` ou `ci-deploy`)         |
| **Clé privée**  | La clé SSH **complète** (PEM, OpenSSH) — collée une seule fois              |

> ⚠️ La **clé privée n'est plus jamais relisible** depuis l'UI après
> création — elle n'est utilisée qu'au runtime par `/api/deploy` pour être
> incluse dans le bundle. Si vous la perdez, supprimez le Server et
> créez-en un nouveau avec une nouvelle clé.

### Préparer le VPS côté SSH

Sur le VPS, créez l'utilisateur de déploiement et autorisez la clé publique :

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo -u deploy mkdir -p ~deploy/.ssh
sudo -u deploy bash -c 'echo "ssh-ed25519 AAAA... ci-deploy" >> ~/.ssh/authorized_keys'
sudo -u deploy chmod 600 ~deploy/.ssh/authorized_keys
```

Le `deployPath` (par défaut `/srv/projets/<env>/<slug>`) doit exister et
appartenir à `deploy:deploy`.

## 2. Lier l'Environment au Server

Sur la page du projet → environnement → **Settings** → champ **Server**.
Choisissez le serveur créé à l'étape 1, ajustez le `deployPath` si besoin
(sinon convention `defaultDeployPath` appliquée).

Voir [Projets & environnements](projets-et-environnements) pour le détail.

## 3. Créer une Connexion CI/CD

Le **fournisseur**, l'**issuer OIDC** et les **credentials d'infra** (token
de redeploy, accès registre privé) vivent dans une **Connexion CI/CD** au
niveau de l'organisation — onglet **« CI/CD »**. Chaque projet en sélectionne
une dans ses Paramètres.

Une connexion porte :

| Champ                 | Rôle                                                                 |
|-----------------------|----------------------------------------------------------------------|
| **Provider**          | `github` \| `gitlab` \| `bitbucket`                                  |
| **Issuer OIDC**       | voir ci-dessous — détermine quelle autorité de signature est acceptée |
| **Token de redeploy** | PAT pour le bouton « Redéployer » (dispatch) — *GitHub uniquement*   |
| **Registry — URL**    | défaut `ghcr.io`                                                      |
| **Registry — user/token** | pour `docker login` côté VPS (registre privé)                    |

### Renseigner l'issuer selon le fournisseur

- **GitHub** — laissez l'issuer **vide** (github.com est de confiance par
  défaut, issuer `https://token.actions.githubusercontent.com`).
- **GitLab** — laissez **vide** pour gitlab.com. Pour une instance
  self-hosted, renseignez l'URL de l'instance
  (ex. `https://gitlab.monentreprise.com`).
- **Bitbucket** — **requis** : l'URL OIDC du workspace, visible dans
  *Workspace settings → OpenID Connect*, de la forme
  `https://api.bitbucket.org/2.0/workspaces/<ws>/pipelines-config/identity/oidc`.

> **Pourquoi l'issuer compte** : Physalis n'accepte un token que si son
> émetteur est connu. Pour les instances dynamiques (GitLab self-hosted,
> chaque workspace Bitbucket), l'issuer doit être **explicitement enregistré**
> dans une connexion, sinon le token est rejeté en `untrusted_issuer`.

Les credentials registry sont renvoyés par `/api/deploy` sous une clé
`registry` séparée des `secrets[]` — elles ne polluent **pas** le `.env` du
conteneur, elles servent uniquement au `docker login` distant. Tout est
chiffré (AES-256-GCM) et jamais réaffiché.

> **Migration** : les anciens `OrgSecret` réservés (`GITHUB_DISPATCH_TOKEN`,
> `REGISTRY_PAT/USER/URL`) sont automatiquement convertis en une connexion
> « GitHub » lors de la mise à jour — rien à ressaisir.

Une fois la connexion créée, reliez-la au projet et renseignez le **repo**
au format attendu par le fournisseur (voir le tableau de référence) :
projet → **Paramètres** → **Connexion CI/CD** + champ **Repo**.

## 4. Créer une Policy

C'est la **règle d'autorisation** : qui (claims OIDC du job) peut déployer
où (projet + env Physalis).

Sur la page du projet → onglet **« Policies »** → **« + Nouvelle Policy »**.

Champs (tous obligatoires, **match strict, aucune wildcard**) :

| Champ             | GitHub                | GitLab                  | Bitbucket               |
|-------------------|-----------------------|-------------------------|-------------------------|
| **Repo**          | `argo-web/physalis`   | `acme/web`              | `{11111111-…}`          |
| **Workflow / Env CI** | `deploy.yml`      | `production` (`environment: name:`) | `production` (`deployment:`) |
| **Branche**       | `main`                | `main`                  | `main`                  |
| **Environnement** | un env existant du projet | idem                | idem                    |

La colonne **« Workflow / Env CI »** est la 3ᵉ dimension : c'est un fichier
workflow chez GitHub, mais le **nom d'environnement CI déclaré par le job**
chez GitLab (`environment: name:`) et Bitbucket (`deployment:`). Le champ de
la Policy doit matcher **exactement** ce que le job déclare.

> Le bouton **« Modifier »** sur une Policy existante permet d'ajuster les
> champs (collision détectée si un autre tuple identique existe déjà).

### Ce que ça veut dire concrètement

Quand un job tourne, le fournisseur émet un token OIDC. Physalis en vérifie
la **signature** (JWKS du fournisseur), en extrait `(repo, 3ᵉ dimension,
branche)`, cherche une Policy qui matche **pile**, et ne déclenche le
déploiement que si le `(project, environment)` du body de la requête
correspond.

Exemples de claims selon le fournisseur :

```json
// GitHub
{
  "repository": "argo-web/physalis",
  "workflow_ref": ".../.github/workflows/deploy.yml@refs/heads/main",
  "ref": "refs/heads/main",
  "aud": "vault.physalis.cloud"
}

// GitLab
{
  "project_path": "acme/web",
  "environment": "production",
  "ref": "main",
  "aud": "vault.physalis.cloud"
}

// Bitbucket
{
  "repositoryUuid": "{11111111-...}",
  "deploymentEnvironment": "production",
  "branchName": "main"
  // pas d'aud : Bitbucket ne permet pas de le configurer
}
```

## 5. Le workflow / pipeline modèle

Copiez le template adapté à votre fournisseur dans votre dépôt et adaptez les
variables en tête de fichier :

| Fournisseur | Template à copier | Emplacement dans le dépôt |
|---|---|---|
| GitHub    | [deploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.modele.yml) | `.github/workflows/deploy.yml` |
| GitLab    | [deploy.gitlab-ci.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.gitlab-ci.modele.yml) | `.gitlab-ci.yml` |
| Bitbucket | [deploy.bitbucket-pipelines.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.bitbucket-pipelines.modele.yml) | `bitbucket-pipelines.yml` |

Les variables communes à adapter :

```
VAULT_URL       URL de Physalis (ex. https://vault.physalis.cloud)
VAULT_AUDIENCE  audience OIDC = OIDC_AUDIENCE du vault (GitHub/GitLab ; ignoré chez Bitbucket)
VAULT_PROJECT   slug du projet dans Physalis
VAULT_ENV       environnement cible Physalis (production, staging, ...)
```

### Comment chaque fournisseur demande son token OIDC

- **GitHub** — `permissions: id-token: write` au niveau du job, puis
  `core.getIDToken(audience)` :

  ```yaml
  permissions:
    id-token: write    # OBLIGATOIRE pour core.getIDToken()
    contents: read
    packages: write    # pour push sur GHCR avec GITHUB_TOKEN (job build)
  ```

- **GitLab** — mot-clé `id_tokens`, l'`aud` doit matcher `OIDC_AUDIENCE` :

  ```yaml
  deploy:
    environment:
      name: production           # = 3ᵉ dimension de la Policy
    id_tokens:
      VAULT_OIDC_TOKEN:
        aud: "$VAULT_AUDIENCE"
  ```

- **Bitbucket** — `oidc: true` sur le step ; le token arrive dans
  `$BITBUCKET_STEP_OIDC_TOKEN`. Pas d'audience à configurer :

  ```yaml
  - step:
      oidc: true
      deployment: production     # = 3ᵉ dimension de la Policy
  ```

Dans les trois cas, le job appelle ensuite `POST /api/deploy` avec le token
en `Authorization: Bearer`, reçoit le bundle, écrit `.env` (+ éventuel
`docker-compose.yml`) sur le VPS via SCP, puis `docker compose pull && up -d`.

## Build args Vite (job `build`)

> S'applique au **template GitHub** uniquement. Les templates GitLab et
> Bitbucket sont deploy-only et supposent l'image déjà construite.

Tout secret d'environnement préfixé `VITE_` est récupéré au job `build` et
passé au `docker build` en `--build-arg`. Côté `Dockerfile` du frontend,
déclarez les `ARG` correspondants :

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app

ARG VITE_VAULT_URL
ARG VITE_API_URL
ENV VITE_VAULT_URL=$VITE_VAULT_URL
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

> ⚠️ Vite **inline** les `VITE_*` dans le bundle JS final → publics côté
> navigateur. À réserver aux URLs publiques, feature flags, etc. Voir
> [Secrets & catégories](secrets) pour la convention complète.

## Construire et publier l'image (GitLab / Bitbucket)

Les templates GitLab et Bitbucket sont **deploy-only** : ils tirent une image
déjà publiée. C'est à vous de la **construire et la pousser** sur un registre
en amont du job de deploy (un job de build qui peut lui aussi fetch les
`VITE_*` via le même `/api/deploy`). Deux étapes distinctes, **deux jeux de
credentials** :

| Étape | Où ça tourne | Credentials | Configuré où |
|---|---|---|---|
| **Build + push** | dans le CI | accès **écriture** au registre | variables du CI (`$CI_REGISTRY_*` GitLab, *repository variables* Bitbucket) |
| **Pull** | sur le VPS (`docker compose pull`) | accès **lecture** au registre | champs **Registry** de la Connexion CI/CD |

**Quel registre ?** N'importe lequel :

- **GitLab** — le plus simple est le **Container Registry intégré**
  (`registry.gitlab.com/<groupe>/<projet>`), avec `$CI_REGISTRY`,
  `$CI_REGISTRY_USER` et `$CI_JOB_TOKEN` déjà disponibles dans le job —
  l'équivalent du combo GHCR + `GITHUB_TOKEN` côté GitHub.
- **Bitbucket** — pas de registre intégré : utilisez un registre externe
  (Docker Hub `docker.io`, GHCR, AWS ECR…) et stockez les creds de push en
  *Repository variables*.

> ⚠️ Les champs **Registry** de la Connexion CI/CD (URL / utilisateur / token)
> ne servent **pas** au build. Ils sont renvoyés dans le bundle `/api/deploy`
> et utilisés **sur le VPS** pour `docker login` + `docker compose pull`.
> Renseignez-les **uniquement si l'image est sur un registre privé** ; pour
> une image publique, laissez-les vides.

Build-push et pull peuvent viser le **même compte** de registre — mais ce sont
bien deux configurations séparées (côté CI pour pousser, côté Connexion pour
que le VPS tire).

## 6. Premier déploiement

1. Push sur `main` → le pipeline se lance
2. *(GitHub)* Job `build` : récupère les `VITE_*`, build l'image, push sur GHCR
3. Job `deploy` : récupère le bundle, écrit `.env` + `docker-compose.yml`
   sur le VPS, fait un `docker compose up -d`
4. Vérifiez l'**audit log** Physalis (page de l'org) → vous verrez
   `DEPLOY_AUTHORIZED` avec les détails (repo, 3ᵉ dimension, branche, env)

### En cas d'échec

L'audit log Physalis enregistre `DEPLOY_DENIED` avec une raison
diagnostiquable :

| `reason`               | Cause probable                                                                 |
|------------------------|--------------------------------------------------------------------------------|
| `wrong_audience`       | `VAULT_AUDIENCE` du job ≠ `OIDC_AUDIENCE` du vault (GitHub/GitLab)              |
| `wrong_issuer`         | Issuer du token inconnu / non supporté                                          |
| `untrusted_issuer`     | Issuer dynamique (GitLab self-hosted / workspace Bitbucket) non enregistré dans une connexion |
| `expired`              | Le job a tourné trop longtemps avant d'appeler `/api/deploy`                    |
| `policy_not_found`     | Aucune Policy ne matche `(repo, 3ᵉ dimension, branche)`                         |
| `policy_match_failed`  | Policy trouvée mais `(project, env)` du body ne matche pas                      |
| `no_server`            | L'env existe mais n'est lié à aucun Server                                      |

> **Piège fréquent (GitLab/Bitbucket)** : un `policy_not_found` vient souvent
> d'un décalage sur la 3ᵉ dimension — le `environment: name:` (GitLab) ou
> `deployment:` (Bitbucket) déclaré dans le job ne matche pas, au caractère
> près, le champ « Env CI » de la Policy.

## Bouton « Redéployer » (workflow_dispatch)

> **GitHub uniquement** pour l'instant.

Si vous voulez piloter un redéploiement **depuis l'UI Physalis** sans push,
renseignez le **token de redeploy** sur la connexion CI/CD du projet (onglet
org « CI/CD » — un PAT avec scope `repo` ou un GitHub App token) et le bouton
**« Redéployer »** apparaîtra sur chaque environnement.

Au clic, Physalis appelle `POST /repos/{owner}/{repo}/actions/workflows/{wf}/dispatches`
qui déclenche le workflow `redeploy.yml` sur la branche de l'environnement.
Ce workflow **ne rebuilde pas les images** — il re-fetch le bundle `.env`,
l'écrit sur le VPS et redémarre les containers via `docker compose up -d`.
C'est suffisant pour les secrets chargés au runtime (variables d'environnement,
clés passées via `.env`).

Copiez [docs/redeploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/redeploy.modele.yml)
dans `.github/workflows/redeploy.yml` de votre repo et adaptez les variables
en tête du fichier.

> **Secrets injectés au build** (ex. `VITE_*`) — Si votre secret est passé
> comme `--build-arg` Docker lors du build de l'image, un simple redeploy ne
> suffit pas. Il faut déclencher le workflow de build complet (`deploy.yml`).
> Physalis le gère automatiquement via l'option **« Build complet requis »**
> dans la configuration de rotation du secret (voir [Rotation des secrets](rotations)).

## Aller plus loin

- [Secrets & catégories](secrets) — comment vos `VITE_*` et autres variables
  d'env arrivent dans le bundle
- [Organisations & rôles](organisations-et-roles) — qui peut gérer les
  Servers, les Connexions CI/CD et les Policies
