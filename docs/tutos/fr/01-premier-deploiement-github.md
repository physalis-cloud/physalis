---
title: Créer un projet, le connecter à GitHub et le déployer
order: 1
icon: RiRocketLine
summary: De zéro à une première application déployée automatiquement depuis GitHub, via OIDC — sans aucun secret stocké dans votre dépôt.
level: débutant
duration: ~30 min
published: true
---

# Créer un projet, le connecter à GitHub et le déployer

Ce guide vous accompagne de bout en bout : créer votre premier **projet**
Physalis, y ranger vos secrets, le relier à un dépôt **GitHub**, et obtenir
un **déploiement automatique** à chaque `git push` — le tout sans jamais
coller un secret Physalis dans votre dépôt.

On suit ici le chemin le plus simple : **GitHub + un VPS en SSH**. Les autres
fournisseurs (GitLab, Bitbucket) suivent la même logique — voir
[Déploiement OIDC](deploiement-oidc) une fois ce guide terminé.

## Ce que vous allez accomplir

- Un projet Physalis avec un environnement `production` et ses secrets
- Un dépôt GitHub qui se déploie tout seul sur votre VPS à chaque push
- Une chaîne d'authentification **OIDC** : votre dépôt ne contient **aucun**
  secret Physalis

## Prérequis

- Un compte Physalis avec le rôle **ADMIN** ou **OWNER** sur votre
  organisation (cf. [Organisations & rôles](organisations-et-roles)).
- Un **dépôt GitHub** contenant une application dockerisée (un `Dockerfile`
  qui build, et une image publiable sur GHCR).
- Un **VPS** accessible en SSH, avec Docker installé.

### Notes

Certaines étapes ne sont à faire **qu'une seule fois** : une fois configurées,
elles se réutilisent pour **tous vos projets**.

- **Étape 2 — Ajouter votre serveur** (défini au niveau de l'organisation)
- **Étape 3 — Créer la connexion CI/CD GitHub** (définie au niveau de l'organisation)

---

## 1. Créer le projet

Dans la nav, allez sur **Projets** → indiquez le **nom** de votre projet dans
« Créer un projet », puis cliquez sur **« Créer »**.

![Formulaire de création du projet](/tutos/fr/premier-deploiement-github-01.png)

> ⚠️ Le **slug** (dérivé du nom) est **définitif** : il sert d'ancrage aux
> Policies de déploiement et au chemin de déploiement. Le changer plus tard
> casse les workflows.

Votre app apparaît dans un bloc **« sans groupe »** par défaut.

![Le projet créé, dans le bloc « sans groupe »](/tutos/fr/premier-deploiement-github-01.1.png)

## 2. Ajouter votre serveur (VPS)

Le serveur SSH se définit **au niveau de l'organisation**. Une fois configuré,
vous pourrez l'utiliser pour **tous vos projets et environnements** déployés sur
ce serveur.

**Menu Paramètres → onglet Serveurs → « + Ajouter »**

![Formulaire d'ajout d'un serveur](/tutos/fr/premier-deploiement-github-02.png)

| Champ          | Valeur                                        |
|----------------|-----------------------------------------------|
| **Nom**        | ex. « VPS prod »                              |
| **IP**         | l'IP ou le hostname du VPS                     |
| **SSH user**   | ex. `github-deploy`                            |
| **Clé privée** | la clé SSH complète (collée une seule fois)   |

> ⚠️ La clé privée n'est **plus jamais relisible** après création. En cas de
> perte, supprimez le serveur et recréez-le avec une nouvelle clé.

Côté VPS, créez l'utilisateur de déploiement et autorisez la clé publique :

```bash
sudo adduser --disabled-password --gecos "" github-deploy
sudo usermod -aG docker github-deploy
sudo -u github-deploy mkdir -p ~github-deploy/.ssh
sudo -u github-deploy bash -c 'echo "ssh-ed25519 AAAA... ci-deploy" >> ~/.ssh/authorized_keys'
sudo -u github-deploy chmod 600 ~github-deploy/.ssh/authorized_keys
```

> ⚠️ **Préparez le dossier cible sur le VPS** avant le premier déploiement,
> sinon il échoue. Créez le `deployPath` (par défaut
> `/srv/projets/production/<slug>`) avec un `.env` et un `docker-compose.yml`
> **vides** :
>
> ```bash
> sudo -u github-deploy mkdir -p /srv/projets/production/mon-app
> sudo -u github-deploy touch /srv/projets/production/mon-app/{.env,docker-compose.yml}
> ```
>
> Physalis y réécrira le vrai contenu à chaque déploiement.

## 3. Créer la connexion CI/CD GitHub

La connexion vit **au niveau de l'organisation** : **Menu Paramètres → onglet
CI/CD → « + Nouvelle connexion »**.

- **Provider** : `github`
- **Issuer OIDC** : laissez **vide** (github.com est de confiance par défaut)
- **Token de redeploy** : un PAT *fine-grained* avec **Contents: Read** +
  **Actions: Write** (sert au bouton « Redéployer » et à lire vos docs projet)
- **Registry** : `ghcr.io` — renseignez user/token **uniquement** si votre
  image est sur un registre privé

![Création de la connexion CI/CD GitHub](/tutos/fr/premier-deploiement-github-03.png)

## 4. Configurer les paramètres de l'environnement de production

Cliquez sur la **card de votre projet**.

Trois environnements sont créés **par défaut** : `development`, `staging` et
`production`. Vous les gérez dans les **paramètres du projet** (icône roue
crantée ⚙️).

Dans cet exemple, nous avons supprimé les environnements `development` et
`staging` pour ne conserver que `production`.

Ouvrez l'environnement `production` → **Settings** :

- **URL publique** : l'URL où l'app sera accessible (optionnel)
- **Deploy path** : laissez **vide** → convention `/srv/projets/production/mon-app`
- **Server** : choisissez le serveur créé à l'**étape 2**

![Paramètres de l'environnement de production](/tutos/fr/premier-deploiement-github-04.png)

### Relier la connexion CI/CD au projet

Projet → **Paramètres** → **Connexion CI/CD** :

- sélectionnez la **connexion** créée à l'étape 3, puis renseignez le champ
  **Repo** au format `owner/repo` (ex. `mon-orga/mon-app`) ;
- pour le champ **Redeploy workflow**, laissez la valeur par défaut — nous vous
  conseillons de conserver `redeploy.yml` ;
- cliquez sur **Enregistrer**.

![Connexion CI/CD reliée au projet](/tutos/fr/premier-deploiement-github-04.1.png)

## 5. Préparez l'environnement de production pour le déploiement

### Ajouter vos secrets

Toujours sur l'environnement `production` → onglet **Secrets** →
**« + Ajouter un secret »**. Saisissez les variables `.env` de votre app (clés
d'API, URL de BDD, etc.), ou **importez directement votre `.env`** pour un
remplissage automatique.

> 💡 Les variables préfixées `VITE_` sont injectées **au build** de l'image
> (et donc publiques côté navigateur). Réservez-les aux URLs publiques et
> feature flags. Détail : [Secrets & catégories](secrets).

### Copier votre docker-compose.yml

Dans l'onglet **Docker Compose**, collez le contenu de votre fichier puis
**enregistrez**.

> 💡 **`.env` et `docker-compose.yml` sont régénérés à chaque déploiement**
> depuis les valeurs enregistrées dans Physalis (c'est lui la source de vérité,
> pas le VPS). Une fois la Policy et le workflow **redeploy** en place (étapes
> 6-7), un bouton **« Redéployer »** apparaît sur l'environnement : après avoir
> modifié un secret ou votre Docker Compose, un clic relance le conteneur avec
> les nouvelles valeurs **sans reconstruire l'image** (une quinzaine de
> secondes), là où un déploiement complet rebuild et republie l'image.

## 6. Créer la Policy de déploiement

C'est la règle qui autorise *ce dépôt, sur cette branche, via ce workflow* à
déployer sur *cet environnement*.

> Vous devez avoir **sélectionné un provider CI/CD et renseigné un repo**
> (étape 4) pour pouvoir créer une Policy.

Projet → onglet **Policies** → **« + Ajouter »**. Trois valeurs à renseigner :

| Champ                        | Valeur                                             |
|------------------------------|----------------------------------------------------|
| **Workflow** (fichier `.yml`) | `deploy.yml` (ou `production.yml`)                 |
| **Branche** (match exact)     | `main` (ou `production`, le nom de votre branche)  |
| **Environnement cible**       | `production`                                        |

> Match **strict, aucune wildcard** : ces valeurs doivent correspondre pile à
> ce que le workflow déclarera.

Vous pouvez créer **directement la règle de redeploy** : mêmes valeurs que la
Policy de deploy, en changeant seulement le nom du workflow (`redeploy.yml`
conseillé).

![Création des Policies deploy et redeploy](/tutos/fr/premier-deploiement-github-06.png)

## 7. Ajouter les workflows GitHub Actions

Copiez les deux templates dans votre dépôt, sous `.github/workflows/`.

### Le workflow de déploiement (`deploy.yml`)

Copiez [deploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.modele.yml)
en `.github/workflows/deploy.yml`, et adaptez les variables en tête de fichier :

```
VAULT_URL       https://vault.physalis.cloud
VAULT_AUDIENCE  = OIDC_AUDIENCE du vault
VAULT_PROJECT   mon-app          # le slug du projet
VAULT_ENV       production
```

> ⚠️ Ne modifiez que **`VAULT_PROJECT`** et **`VAULT_ENV`**. Ne touchez pas à
> `VAULT_URL` ni `VAULT_AUDIENCE`.

Le workflow demande un token OIDC à GitHub (`id-token: write`), l'envoie à
`/api/deploy`, reçoit le bundle (secrets + clé SSH + chemin), l'écrit sur le
VPS et lance `docker compose up -d`.

### Le workflow de redéploiement (`redeploy.yml`)

Copiez [redeploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/redeploy.modele.yml)
en `.github/workflows/redeploy.yml` (mêmes variables en tête). Il redéploie
**sans reconstruire l'image** (re-fetch des secrets + `docker compose up -d`) et
alimente le bouton **« Redéployer »** de l'UI Physalis. Il s'appuie sur la
Policy `redeploy.yml` créée à l'étape 6.

## 8. Premier déploiement

Faites un `git push` sur `main` (ou le nom de la branche définie). Le workflow
se lance :

1. Job **build** : récupère les `VITE_*`, build l'image, la pousse sur GHCR
2. Job **deploy** : récupère le bundle, écrit `.env` + `docker-compose.yml`
   sur le VPS, fait `docker compose up -d`

## Vérifier que tout fonctionne

- Dans Physalis : page de l'organisation → **Audit log** → vous devez voir un
  événement **`DEPLOY_AUTHORIZED`** avec le repo, la branche et l'environnement.
- Votre application répond sur son URL publique.

## En cas de problème

L'audit log enregistre un **`DEPLOY_DENIED`** avec une raison :

- **`policy_not_found`** → le tuple (repo, workflow, branche) ne matche aucune
  Policy. Vérifiez l'orthographe exacte à l'**étape 6**.
- **`wrong_audience`** → `VAULT_AUDIENCE` du workflow ≠ `OIDC_AUDIENCE` du vault
  (à ne pas modifier dans le template — cf. étape 7).
- **`no_server`** → l'environnement n'est lié à aucun serveur. Refaites
  l'**étape 4** (champ **Server**).
- **`expired`** → le job a mis trop de temps avant d'appeler `/api/deploy`
  (relancez-le).

Liste complète des raisons : [Déploiement OIDC](deploiement-oidc).

## Et ensuite ?

- Tuto suivant : [Inviter son équipe et configurer le SSO](tuto:inviter-equipe-sso)
- Pour approfondir :
  - [Déploiement OIDC](deploiement-oidc) — GitLab, Bitbucket, build args Vite,
    bouton « Redéployer »
  - [Secrets & catégories](secrets) — organiser vos variables
  - [Projets & environnements](projets-et-environnements) — services, comptes
    applicatifs, membres de projet
