---
title: Publier une app Android sur Google Play
order: 5
icon: RiAndroidLine
summary: De zéro à un AAB publié sur Google Play depuis votre CI — créer l'app dans Physalis, obtenir le compte de service Google, importer le keystore, et déclencher la publication sans aucun secret dans le pipeline.
level: intermédiaire
duration: ~30 min
published: true
---

# Publier une app Android sur Google Play

Ce guide vous mène d'une application Android à sa **publication automatique sur
Google Play depuis votre CI**, sans jamais coller un secret de signature dans
votre dépôt. Physalis détient le keystore et le compte de service ; votre CI
construit l'AAB et le téléverse directement.

La vraie friction n'est pas dans Physalis — elle est chez Google. Ce tuto
détaille les deux consoles (Google Cloud + Play Console) écran par écran.

## Ce que vous allez accomplir

- Une application Android déclarée dans Physalis, avec son keystore et son accès
  Google Play.
- Un workflow GitHub qui publie un AAB signé sur une piste de test à chaque
  déclenchement — sans secret GitHub.

## Prérequis

- Le déploiement mobile est **activé sur votre projet** (Paramètres du projet →
  Déploiement mobile). Voir la référence [Déploiement mobile](deploiement-mobile).
- Une **connexion CI/CD** est reliée au projet et le **repo** est défini
  (onglet Paramètres).
- Votre app existe **déjà** sur la Play Console (le tout premier AAB d'un
  package doit être publié une fois à la main ; l'API prend le relais ensuite).

## 1. Créer l'application dans Physalis

Onglet **Mobile** du projet → **Nouvelle application** :

- **Plateforme** : Android
- **applicationId** : l'identifiant du package, en reverse-DNS (ex.
  `fr.exemple.monapp`)
- **Nom** : libellé lisible
- (optionnel) **Groupe** : pour ranger dev/staging/prod

## 2. Le keystore

Si vous avez déjà un keystore de signature, gardez-le. Sinon, générez-en un :

```bash
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias upload
```

> **Play App Signing (recommandé).** Laissez Google gérer la clé de signature
> finale et ne fournissez qu'une **clé d'upload**. Une clé d'upload perdue se
> réinitialise ; une clé de signature perdue **hors** Play App Signing est
> définitive (republication sous un autre package). Activez Play App Signing
> dans la console.

Dans l'app Physalis, importez **cinq** credentials (bouton « Importer un
credential ») :

| Type | Valeur |
|---|---|
| Keystore Android | le fichier `.jks` |
| Mot de passe du keystore | le `storepass` |
| Alias de clé | l'alias (`upload` ci-dessus) |
| Mot de passe de la clé | le `keypass` |
| Compte de service Google Play | le JSON de l'étape 3 |

> ⚠️ Le mot de passe saisi à l'import du keystore ne sert qu'à **lire la date
> d'expiration** — il n'est pas conservé. Importez-le **aussi** comme credential
> « Mot de passe du keystore ». Sans les trois textes, la signature échouera.

## 3. Le compte de service Google Play

C'est lui qui permet à votre CI de téléverser via l'API. Deux temps.

### a. Créer le compte de service (Google Cloud)

1. [console.cloud.google.com](https://console.cloud.google.com) → sélectionnez
   (ou créez) un projet.
2. **☰ → IAM et administration → Comptes de service → Créer un compte de
   service**. Nommez-le (`play-ci`), **sans rôle**, Terminer.
3. Ouvrez-le → onglet **Clés → Ajouter une clé → JSON** → le fichier se
   télécharge. **C'est lui que vous importez dans Physalis.**
4. **☰ → API et services → Bibliothèque** → cherchez **Google Play Android
   Developer API** → **Activer**. (Étape souvent oubliée, sans elle rien ne
   marche.)

### b. Donner l'accès (Play Console)

La page « Accès aux API » ayant migré, le plus simple passe par les
utilisateurs :

1. [play.google.com/console](https://play.google.com/console) → **Utilisateurs
   et autorisations** → **Inviter de nouveaux utilisateurs**.
2. Collez l'**e-mail du compte de service**
   (`play-ci@…iam.gserviceaccount.com`).
3. Dans **Autorisations pour l'application**, sélectionnez votre app et cochez
   le **minimum** (pas « Administrateur ») :
   - **Déployer les applications sur des canaux de test** ;
   - **Gérer les canaux de test et modifier les listes de testeurs**.
   (Pour publier en production plus tard, ajoutez alors « Mettre les
   applications à disposition de tous les utilisateurs… ».)
4. **Inviter**.

> **Délai.** L'API peut mettre quelques minutes à ~24 h avant d'accepter le
> compte. Un `permission denied` juste après est normal, réessayez.

Importez enfin le JSON dans Physalis (app → Compte de service Google Play), puis
**supprimez la copie locale du fichier** — c'est un secret.

## 4. Version et numéro de build

Sur la fiche de l'application, réglez la **version** (ex. `1.4`) et le **dernier
numéro de build publié** (le `versionCode` de votre dernière release, ex. `4`).
Physalis servira `5`, `6`… automatiquement à chaque déploiement.

## 5. Autoriser le pipeline (les policies)

Une app Capacitor construit d'abord sa couche web, donc **deux** policies sur le
même `(repo, workflow, branche)` :

- **Policy mobile** (dans l'app, section « Publication depuis le CI ») :
  workflow `release-android.yml`, branche `production`.
- **Policy serveur** (onglet **Policies** du projet) : même workflow, même
  branche, environnement `production` — elle sert les `VITE_*` du build web.

Une app native pure n'a besoin que de la policy mobile.

## 6. Le workflow

Copiez les gabarits du dépôt public dans votre repo et adaptez le bloc
`env` (voir l'en-tête « À ADAPTER ») :

- `.github/workflows/release-android.yml` (modèle
  `deploy-mobile-android-capacitor.modele.yml`)
- `fastlane/Fastfile` (modèle `fastlane.Fastfile.modele`)

Le workflow récupère les `VITE_*` et le matériel de signature via OIDC,
construit l'AAB signé et le téléverse avec `fastlane supply`. Par défaut il se
déclenche **manuellement** (`workflow_dispatch`) : lancez-le depuis l'onglet
Actions de GitHub, en choisissant la piste (`internal` par défaut).

## C'est publié

Le run vert dépose l'AAB sur votre piste de test. Vérifiez-le dans la Play
Console. Le numéro de build s'est incrémenté tout seul dans Physalis.

Pour la version iOS, suivez le tuto
[Publier une app iOS sur l'App Store](tuto:publier-ios).
