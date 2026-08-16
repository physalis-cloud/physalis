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
- Un **compte développeur Google Play** — inscription sur
  [play.google.com/console/signup](https://play.google.com/console/signup),
  25 $ une fois.

> **Ouvrez-le en premier.** C'est le seul point de ce guide qui ne se règle pas
> dans la journée, et le reste attendra sans vous. À l'inscription vous
> choisissez entre un compte **personnel** et un compte **organisation** : c'est
> ce nom qui s'affichera sous l'app dans le magasin. Google vérifie l'identité
> des nouveaux développeurs, et un compte d'organisation réclame en plus un
> numéro **D-U-N-S** — le même identifiant qu'exige Apple — dont l'attribution
> prend de quelques jours à plusieurs semaines selon le pays. Si votre société
> en a déjà un, vérifiez-le avant d'en demander un nouveau.

![Le déploiement mobile activé dans les paramètres du projet](/tutos/fr/publier-android-01.png)

> **App déjà publiée, ou toute neuve ?** Les deux fonctionnent. Une seule chose
> ne passe pas par l'API : **créer la fiche** de l'application dans la Play
> Console (étape 3). Le premier AAB, lui, part du pipeline comme les suivants —
> c'est tout l'objet de l'étape 8. C'est même l'ordre le plus sûr : Play App
> Signing enrôle la clé d'upload à partir de la clé qui signe la **première**
> release. Un premier AAB téléversé à la main avec un autre keystore que celui
> confié à Physalis condamne tous les runs suivants.

## 1. Créer l'application dans Physalis

Onglet **Mobile** du projet → **Nouvelle application** :

- **Plateforme** : Android
- **applicationId** : l'identifiant du package, en reverse-DNS (ex.
  `fr.exemple.monapp`)
- **Nom** : libellé lisible
- (optionnel) **Groupe** : pour ranger dev/staging/prod

![Formulaire de création d'une application Android](/tutos/fr/publier-android-02.png)

Les champs **Version** et **Dernier n° de build publié** du même formulaire sont
l'objet de l'étape 5 — laissez-les tels quels pour l'instant.

## 2. Le keystore

Deux chemins. Le premier ne demande aucun outil.

### Laisser Physalis le générer

Sur la fiche de l'application, **Générer le matériel de signature**. Physalis
fabrique la clé d'upload (paire RSA + certificat, ~27 ans), son mot de passe et
son alias, et les range chiffrés : **quatre des cinq credentials** sont posés
d'un coup. La clé privée est créée dans le coffre, elle n'a donc jamais à
voyager. Aucun compte n'est requis pour cette étape ; il ne restera que le
compte de service Google Play, à l'étape 4.

> ⚠️ Il s'agit de la **clé d'upload**, celle que Google réinitialise si vous la
> perdez — à condition que Play App Signing soit actif. Pas la clé de signature
> d'app, qui reste chez Google.

### Ou importer le vôtre

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
| Compte de service Google Play | le JSON de l'étape 4 |

> ⚠️ Le mot de passe saisi à l'import du keystore ne sert qu'à **lire la date
> d'expiration** — il n'est pas conservé. Importez-le **aussi** comme credential
> « Mot de passe du keystore ». Sans les trois textes, la signature échouera.

## 3. Créer la fiche sur la Play Console

Le seul geste que l'API ne sait pas faire : elle travaille sur un `packageName`
qui existe déjà, elle ne crée pas d'application. Si votre app est déjà en ligne,
sautez cette étape.

1. [play.google.com/console](https://play.google.com/console) → **Créer une
   application**. Nom, langue par défaut, application ou jeu, gratuite ou
   payante.
2. La console **ne demande pas** l'identifiant du package : c'est le **premier
   AAB téléversé** qui fixe l'`applicationId` définitivement. Raison de plus pour
   le laisser partir du pipeline, avec l'`applicationId` déclaré à l'étape 1.
3. Remplissez **Contenu de l'application** : politique de confidentialité, accès
   à l'app, publicités, classification du contenu, public cible, sécurité des
   données. Tant qu'il en manque une, aucune release ne peut être envoyée en
   examen — l'upload, lui, passe déjà.

L'app reste affichée en **Brouillon** jusqu'à la première release examinée :
c'est normal à ce stade, l'étape 8 s'en occupe.

## 4. Le compte de service Google Play

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
> compte. Un `permission denied` juste après est normal — la vérification
> ci-dessous vous dira quand c'est passé.

Importez enfin le JSON dans Physalis (app → Compte de service Google Play), puis
**supprimez la copie locale du fichier** — c'est un secret.

### Vérifier avant de lancer un pipeline

Le matériel est maintenant complet. Sur la fiche de l'application, **Vérifier le
matériel** contrôle d'abord la cohérence de ce qui est déposé — keystore lisible
avec son mot de passe, alias réellement présent dedans — puis **interroge Google
Play** pour savoir ce que votre compte de service a vraiment le droit de faire.

C'est là que se lisent, en deux secondes, les trois cas qu'un `permission
denied` de fin de pipeline ne distingue pas : clé invalide, clé valide mais
compte de service non invité dans la Play Console, ou invité mais sans droit sur
**cette** application. Autant le savoir avant dix minutes de build.

## 5. Version et numéro de build

Sur la fiche de l'application — ou dès le formulaire de création de l'étape 1 —
réglez la **version** (ex. `1.4`) et le **dernier numéro de build publié** (le
`versionCode` de votre dernière release, ex. `4`).
Physalis servira `5`, `6`… automatiquement à chaque déploiement.

![Les champs Version et Dernier n° de build publié](/tutos/fr/publier-android-03.png)

Pour une app neuve, laissez le compteur à **`0`**, comme ci-dessus : le premier
déploiement servira `1`.

## 6. Autoriser le pipeline (les policies)

Une app Capacitor construit d'abord sa couche web, donc **deux** policies sur le
même `(repo, workflow, branche)` :

- **Policy mobile** (dans l'app, section « Publication depuis le CI ») :
  workflow `release-android.yml`, branche `production`.

  ![Le formulaire « Autoriser un pipeline » de l'application](/tutos/fr/publier-android-04.png)

- **Policy serveur** (onglet **Policies** du projet) : même workflow, même
  branche, environnement `production` — elle sert les `VITE_*` du build web.

  ![L'onglet Policies du projet, liaison repo · workflow · branche → environnement](/tutos/fr/publier-android-05.png)

Une app native pure n'a besoin que de la policy mobile.

## 7. Le workflow

Deux fichiers à copier depuis le dépôt public, puis à adapter (en-tête
« À ADAPTER ») :

- `.github/workflows/release-android.yml` — modèle
  [deploy-mobile-android-capacitor.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy-mobile-android-capacitor.modele.yml)
- `fastlane/Fastfile` — modèle
  [fastlane.Fastfile.modele](https://github.com/physalis-cloud/physalis/blob/main/docs/fastlane.Fastfile.modele)
  (les lanes iOS **et** Android vivent dans ce seul fichier, à la racine du repo)

### Ce que fait le run

1. **Deux appels à Physalis, avant tout build** : `/api/deploy` pour les
   `VITE_*`, `/api/deploy/mobile` pour le keystore, ses mots de passe et le
   compte de service. Chacun avec son propre token OIDC, chacun couvert par sa
   policy. Une configuration incomplète échoue ici, en quelques secondes.
2. **Vérifications immédiates** : plateforme de l'app servie, credentials vides,
   alias réellement présent dans le keystore. Sans elles, une erreur de
   configuration ne se manifesterait qu'après ~5 min de build, sur un message
   de gradle qui ne la désigne pas.
3. **Build** : `npm run build` (Vite lit `frontend/.env.production`),
   `npx cap sync`, pose du `versionCode`/`versionName` servis par Physalis,
   icônes, permissions du manifeste.
4. **Signature et upload** : gradle signe avec le keystore récupéré, par
   propriétés `android.injected.signing.*` — rien n'est écrit dans le dépôt —
   puis `fastlane supply` téléverse l'AAB.
5. **Rapport au registre** : le run signale à Physalis le numéro de build, la
   piste et l'issue — `téléversé`, ou `échoué` si la publication a cassé. C'est
   ce qui alimente l'onglet **Livraisons** de l'application. Un rapport refusé
   ne fait pas rougir le run : l'AAB est déjà chez Google.
6. **Nettoyage** : matériel de signature et `.env.production` effacés du runner.

Aucun `secrets.*` GitHub n'est consommé, et c'est tout l'objet du montage.

### À adapter

- `VAULT_PROJECT` et `MOBILE_APP` : le slug du projet Physalis et
  l'`applicationId`.
- Le gabarit suppose une racine web `frontend/` : ajustez les chemins si la
  vôtre diffère.
- Les étapes « Generate app icons » et « Add permissions to AndroidManifest »
  sont propres à votre app.

### Déclenchement

Le gabarit se lance **manuellement** (`workflow_dispatch`), et c'est un choix
délibéré : une mise à jour serveur n'est pas une publication de magasin. Une
publication est asynchrone, soumise à revue, à numéro strictement croissant et
**sans retour arrière** — elle se décide, plateforme par plateforme.

Pour publier à chaque push, ajoutez sous `on:` :

```yaml
push:
  branches: [production]
```

Dans les deux cas le run doit partir de la branche déclarée dans la policy :
celle-ci lie le triplet `(repo, workflow, branche)`, un lancement depuis une
autre branche est refusé.

### Geler les publications sans toucher au repo

Onglet **Mobile** → l'application → **Mettre les publications en pause**.
`/api/deploy/mobile` répond alors 403 à tout pipeline, avec un refus explicite,
et le matériel de signature reste intact ; **Reprendre les publications**
rouvre le robinet. C'est le bon coupe-circuit pour geler une app : il vaut pour
tous les repos qui la visent, sans rien désactiver côté GitHub.

![L'onglet Mobile : chaque application porte son bouton de mise en pause](/tutos/fr/publier-android-06.png)

### Une app native pure (sans Capacitor)

Les gabarits fournis sont ceux d'une app **Capacitor**. Pour une app 100 %
native, retirez tout le volet web : l'appel à `/api/deploy`, l'écriture de
`frontend/.env.production`, `npm ci`, `npm run build`, `npx cap add|sync`. Il
reste le bundle de signature, votre build gradle et `fastlane supply` — et une
**seule** policy, la mobile : la policy serveur ne sert qu'aux `VITE_*`.

## 8. Première publication

Cette étape ne concerne que le **tout premier** envoi d'un package. Passez
directement à la suite si l'app est déjà en ligne.

Tant qu'une application n'a jamais été publiée, la Play Console la tient pour un
**brouillon**, et l'API pose deux règles de plus :

- une release non-`draft` est refusée — `Only releases with status draft may be
  created on draft app` ;
- l'edit ne peut pas partir en examen tout seul — `Changes cannot be sent for
  review automatically. Please set the query parameter changesNotSentForReview
  to true`.

Le gabarit gère les deux : lancez le workflow en **cochant `first_release`**. Le
run construit et téléverse l'AAB exactement comme d'habitude, en release
*draft* — c'est cet AAB qui fixe l'`applicationId` du package et enrôle votre
clé d'upload dans Play App Signing.

Reste alors **un seul geste humain, une fois pour la vie du package** : Play
Console → votre app → **Envoyer pour examen**. Tant que l'app est en brouillon,
les testeurs ne reçoivent rien, quoi qu'ait fait le pipeline.

Une fois l'app sortie du brouillon, relancez **sans** cocher `first_release` :
les publications suivantes sont entièrement automatiques.

> **Case oubliée au premier run ?** L'erreur tombe après le build, ~5 min plus
> tard, et ne coûte rien : cochez et relancez. Le `versionCode` servi par
> Physalis aura simplement avancé d'un cran — un numéro de build doit croître,
> pas être contigu.

## C'est publié

Le run vert dépose l'AAB sur votre piste de test. Vérifiez-le dans la Play
Console. Le numéro de build s'est incrémenté tout seul dans Physalis, et la
livraison apparaît dans l'onglet **Livraisons** de l'application : build, piste,
état et pipeline qui l'a produite.

Physalis surveille par ailleurs l'échéance du keystore et vous préviendra par
email à J-60, J-30 et J-7 — ni Google ni GitHub ne le feront.

Pour la version iOS, suivez le tuto
[Publier une app iOS sur l'App Store](tuto:publier-ios).
