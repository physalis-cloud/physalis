---
title: Publier une app iOS sur l'App Store
order: 6
icon: RiAppleLine
summary: De zéro à un build iOS sur TestFlight depuis votre CI — créer l'app dans Physalis, obtenir la clé d'API App Store Connect, le certificat et le profil, et déclencher la publication sans aucun secret dans le pipeline.
level: intermédiaire
duration: ~30 min
published: true
---

# Publier une app iOS sur l'App Store

Ce guide vous mène d'une application iOS à sa **publication sur TestFlight (puis
l'App Store) depuis votre CI**, sans secret de signature dans votre dépôt.
Physalis détient le certificat, le profil et la clé d'API ; votre CI construit
l'`.ipa` sur un runner macOS et le téléverse directement vers Apple.

> **Pas besoin d'un Mac pour ce guide.** Le runner macOS de votre CI compile ;
> vous, vous n'avez qu'à récupérer trois éléments dans App Store Connect.

## Prérequis

- Le déploiement mobile est **activé sur votre projet** (Paramètres → Déploiement
  mobile). Voir [Déploiement mobile](deploiement-mobile).
- Une **connexion CI/CD** est reliée au projet et le **repo** est défini.
- Un compte **Apple Developer** avec les droits d'administration — inscription
  sur [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/),
  99 $/an.

> **Ouvrez-le en premier.** C'est le seul point de ce guide qui ne se règle pas
> dans la journée. Une inscription **individuelle** publie sous votre nom ; une
> inscription **organisation** publie sous celui de la société, et réclame un
> numéro **D-U-N-S** ainsi qu'une validation par Apple — de quelques jours à
> plusieurs semaines. Apple met à disposition un
> [outil de recherche D-U-N-S](https://developer.apple.com/enroll/duns-lookup/)
> (identifiant Apple requis) : commencez par là, beaucoup de sociétés en ont
> déjà un sans le savoir.

![Le déploiement mobile activé dans les paramètres du projet](/tutos/fr/publier-ios-01.png)

> **App déjà sur l'App Store, ou toute neuve ?** Les deux fonctionnent. Une
> seule chose ne passe pas par l'API : **créer la fiche** de l'application dans
> App Store Connect (étape 3). La clé d'API que détient Physalis sait tout faire
> — téléverser, gérer TestFlight — sauf créer une app : c'est la seule opération
> qu'Apple réserve à l'interface. Le premier build, lui, part du pipeline comme
> les suivants ; l'étape 8 détaille ce premier passage.

## 1. Créer l'application dans Physalis

Onglet **Mobile** du projet → **Nouvelle application** :

- **Plateforme** : iOS
- **bundleId** : l'identifiant, en reverse-DNS (ex. `fr.exemple.monapp`)
- **Nom** : libellé lisible
- **Team ID / éditeur** (optionnel mais utile) : votre Team ID Apple (10
  caractères)

![Formulaire de création d'une application iOS](/tutos/fr/publier-ios-02.png)

Les champs **Version** et **Dernier n° de build publié** du même formulaire sont
l'objet de l'étape 5 — laissez-les tels quels pour l'instant.

## 2. La clé d'API App Store Connect (`.p8`)

C'est le credential d'amorçage : il authentifie votre CI auprès d'Apple, sans
Apple ID ni double authentification.

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Users and
   Access** → onglet **Integrations** (ou **Keys**) → **App Store Connect API**.
2. **Generate API Key** → donnez-lui un nom, rôle **App Manager** (suffisant
   pour publier).
3. Notez le **Key ID** et l'**Issuer ID** (l'Issuer ID est en haut de la page,
   il ne s'affiche **qu'une fois** dans certains cas — copiez-le).
4. **Download API Key** → le fichier `.p8`. ⚠️ **Il ne se retéléverse jamais** :
   gardez-le le temps de l'importer, puis supprimez la copie locale.

Dans Physalis, importez trois credentials :

| Type | Valeur |
|---|---|
| Clé API App Store Connect (`.p8`) | le fichier téléchargé |
| Key ID | l'identifiant de la clé |
| Issuer ID | l'identifiant de l'émetteur |

## 3. Déclarer l'app chez Apple

Deux enregistrements, à faire une fois. Sautez cette étape si votre app est déjà
en ligne.

1. **Le bundle ID**, dans le [portail développeur](https://developer.apple.com/account/resources/identifiers/list)
   → **Identifiers** → **+** → App IDs → App. Reprenez exactement le `bundleId`
   déclaré à l'étape 1, et cochez les capacités dont l'app a besoin. C'est lui
   que le profil de provisioning de l'étape 4 viendra référencer.
2. **La fiche de l'app**, dans [App Store Connect](https://appstoreconnect.apple.com)
   → **Apps** → **+** → **Nouvelle app** : plateforme iOS, nom, langue, le
   bundle ID ci-dessus, et un SKU (référence interne libre).

C'est la seule opération qu'Apple ne propose pas par API : une clé d'API App
Store Connect sait téléverser des builds et piloter TestFlight, mais pas créer
une app. Sans cette fiche, l'upload échoue sur un message qui ne dit pas
pourquoi : `No suitable application records were found. Verify your bundle
identifier is correct.`

## 4. Le certificat de distribution (`.p12`) et le profil

Il vous faut un **certificat de distribution** et un **profil de provisioning
App Store** pour le bundleId de l'app. Deux chemins — et le premier n'exige
aucun Mac.

### Laisser Physalis les générer

Sur la fiche de l'application, **Générer le matériel de signature**. À partir de
la seule clé `.p8` de l'étape 2, Physalis enchaîne la paire de clés, la CSR, le
certificat de distribution, le `.p12` et le profil de provisioning, et les range
chiffrés. La clé privée naît dans le coffre et n'en sort pas.

C'est ici que ce guide tient sa promesse : **un Mac sert à compiler, pas à
générer**. La CSR et le `.p12` sont de la cryptographie, pas du Xcode — l'aller-
retour par le Trousseau macOS n'a jamais été qu'une habitude.

Deux limites, côté Apple :

- l'**App ID doit déjà être enregistré** dans votre compte développeur — c'est
  l'étape 3 ;
- Apple **plafonne les certificats de distribution** (2 à 3 par compte).
  Régénérer en consomme un, et les profils liés à l'ancien certificat cessent de
  signer. L'ancien matériel reste consultable dans l'historique de
  l'application.

### Ou importer les vôtres

- Si vous les avez déjà (exportés du Trousseau ou générés précédemment),
  réutilisez-les.
- Un `.p12` exporté du **Trousseau macOS** est protégé par un mot de passe :
  notez-le, il vous sera demandé.

Dans Physalis, importez :

| Type | Valeur |
|---|---|
| Certificat de distribution (`.p12`) | le fichier |
| Mot de passe du `.p12` | le mot de passe d'export |
| Profil de provisioning (`.mobileprovision`) | le fichier |

> ⚠️ Le mot de passe saisi à l'import du `.p12` sert à **lire la date
> d'expiration** — il n'est pas conservé. Importez-le **aussi** comme credential
> « Mot de passe du .p12 ».

Le certificat et le profil valent ~1 an. Physalis extrait leur date
d'expiration et vous alertera avant l'échéance.

### Vérifier avant de lancer un pipeline

Le matériel est maintenant complet. Sur la fiche de l'application, **Vérifier le
matériel** contrôle la cohérence de ce qui est déposé — certificat et profil
lisibles, non expirés — puis **interroge App Store Connect** avec votre clé
d'API.

Deux réponses valent le détour. « La clé fonctionne mais ne voit pas ce bundle
id » signifie que la fiche de l'étape 3 manque, ou que le rôle de la clé est
trop étroit — pas que la clé est mauvaise. Et « Apple refuse la clé » désigne un
Key ID ou un Issuer ID qui ne se correspondent pas, la confusion la plus
fréquente au moment de l'import.

## 5. Version et numéro de build

Sur la fiche de l'application — ou dès le formulaire de création de l'étape 1 —
réglez la **version** (ex. `1.9`) et le **dernier numéro de build publié** (le
`CFBundleVersion` de votre dernière release, ex. `10`). Physalis servira `11`,
`12`… automatiquement.

![Les champs Version et Dernier n° de build publié](/tutos/fr/publier-ios-03.png)

Pour une app neuve, laissez le compteur à **`0`** : le premier déploiement
servira `1`.

## 6. Autoriser le pipeline (les policies)

Une app Capacitor construit d'abord sa couche web, donc **deux** policies sur le
même `(repo, workflow, branche)` :

- **Policy mobile** (dans l'app, section « Publication depuis le CI ») :
  workflow `release-ios.yml`, branche `production`.

  ![Le formulaire « Autoriser un pipeline » de l'application](/tutos/fr/publier-ios-04.png)

- **Policy serveur** (onglet **Policies** du projet) : même workflow, même
  branche, environnement `production` — elle sert les `VITE_*` du build web.

  ![L'onglet Policies du projet, liaison repo · workflow · branche → environnement](/tutos/fr/publier-ios-05.png)

Une app native pure n'a besoin que de la policy mobile.

## 7. Le workflow

Deux fichiers à copier depuis le dépôt public, puis à adapter (en-tête
« À ADAPTER ») :

- `.github/workflows/release-ios.yml` — modèle
  [deploy-mobile-ios-capacitor.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy-mobile-ios-capacitor.modele.yml)
- `fastlane/Fastfile` — modèle
  [fastlane.Fastfile.modele](https://github.com/physalis-cloud/physalis/blob/main/docs/fastlane.Fastfile.modele)
  (les lanes iOS **et** Android vivent dans ce seul fichier, à la racine du repo)

Le workflow tourne sur un **runner macOS**.

### Ce que fait le run

1. **Deux appels à Physalis, avant tout build** : `/api/deploy` pour les
   `VITE_*`, `/api/deploy/mobile` pour le `.p12` et son mot de passe, le
   `.mobileprovision` et la clé `.p8` avec ses deux identifiants. Chacun avec
   son propre token OIDC, chacun couvert par sa policy.
2. **Trousseau temporaire** : le certificat est importé dans un keychain créé
   pour le run et détruit à la fin. Le gabarit vérifie aussitôt que ce trousseau
   expose une identité de signature complète — `import_certificate` ne fait pas
   échouer la lane quand l'import rate, et `xcodebuild` ne s'en apercevrait que
   plus tard, sur un message qui ne désigne pas la cause.
3. **Profil et signature manuelle** : le nom du profil et le Team ID sont
   extraits du `.mobileprovision`, rien n'est codé en dur — changer de profil
   dans Physalis suffit. La signature manuelle est inscrite dans le seul target
   `App` : un réglage global casserait la compilation des pods, qui n'ont pas de
   profil.
4. **Build et upload** : `xcodebuild` archive et exporte l'`.ipa`, puis
   `upload_to_testflight` téléverse avec la clé d'API — ni Apple ID, ni double
   authentification.
5. **Rapport au registre** : le run signale à Physalis le numéro de build, la
   piste (`testflight`) et l'issue — `téléversé`, ou `échoué` si la publication
   a cassé. C'est ce qui alimente l'onglet **Livraisons** de l'application. Un
   rapport refusé ne fait pas rougir le run : l'`.ipa` est déjà chez Apple.
6. **Nettoyage** : keychain détruit, matériel de signature et
   `.env.production` effacés du runner.

Aucun `secrets.*` GitHub n'est consommé, et c'est tout l'objet du montage.

### À adapter

- `VAULT_PROJECT` et `MOBILE_APP` : le slug du projet Physalis et le `bundleId`.
- Le gabarit suppose une racine web `frontend/` : ajustez les chemins si la
  vôtre diffère.
- L'étape « Configure Info.plist » : **les textes de permission et le nom
  affiché sont des exemples**, remplacez-les par les vôtres — ils partent chez
  Apple et s'affichent sur la fiche du store.
- L'étape « Generate app icon » : le chemin de l'icône source.

> **Capacitor.** Le projet natif s'appelle toujours `App.xcworkspace` / scheme
> `App` (imposé par Capacitor), et il est régénéré à chaque build par
> `npx cap add` : tout ce qui le personnalise doit être réappliqué à chaque run.
> Le gabarit gère déjà ce cas.

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

![L'onglet Mobile : chaque application porte son bouton de mise en pause](/tutos/fr/publier-ios-06.png)

### Une app native pure (sans Capacitor)

Les gabarits fournis sont ceux d'une app **Capacitor**. Pour une app 100 %
native, retirez tout le volet web : l'appel à `/api/deploy`, l'écriture de
`frontend/.env.production`, `npm ci`, `npm run build`, `npx cap add|sync`. Il
reste le bundle de signature, votre projet Xcode et `upload_to_testflight` — et
une **seule** policy, la mobile : la policy serveur ne sert qu'aux `VITE_*`.

## 8. Première publication

Cette étape ne concerne que le **tout premier** build d'une app. Passez
directement à la suite si elle est déjà en ligne.

Contrairement à Google Play, Apple n'impose aucun régime particulier au premier
build : dès lors que la fiche existe (étape 3), l'upload passe comme les
suivants. Deux détails bloquent en revanche la **distribution aux testeurs**, et
prennent au dépourvu :

- **Conformité export.** Sans la clé `ITSAppUsesNonExemptEncryption` dans
  l'`Info.plist`, le build arrive dans TestFlight en « Missing Compliance » et
  n'est distribuable qu'après avoir répondu à la question du chiffrement dans
  App Store Connect — à chaque build. Si votre app n'utilise que du chiffrement
  exempté (HTTPS standard), ajoutez cette ligne à l'étape « Configure
  Info.plist » du workflow et la question ne se posera plus :

  ```bash
  plutil -replace ITSAppUsesNonExemptEncryption -bool false "$PLIST"
  ```

- **Testeurs.** Un build TestFlight n'atteint personne tant qu'un groupe de
  testeurs n'existe pas et que le build ne lui est pas assigné. C'est à faire
  une fois, dans l'onglet TestFlight.

Comptez quelques minutes de traitement Apple entre la fin du run et l'apparition
du build. La mise à disposition **publique** sur l'App Store, elle, reste une
décision explicite : fiche remplie, captures, envoi en revue. Le gabarit s'arrête
à TestFlight ; pour aller directement à l'App Store, le `Fastfile` indique où
remplacer `upload_to_testflight` par `upload_to_app_store`.

## C'est sur TestFlight

Le run vert dépose le build sur TestFlight. Vous le retrouvez dans App Store
Connect après quelques minutes de traitement Apple. Le numéro de build s'est
incrémenté tout seul dans Physalis, et la livraison apparaît dans l'onglet
**Livraisons** de l'application : build, piste, état et pipeline qui l'a
produite.

Le certificat et le profil valant un an, Physalis surveille leur échéance et
vous préviendra par email à J-60, J-30 et J-7 — Apple ne le fera pas.

Pour la version Android, suivez le tuto
[Publier une app Android sur Google Play](tuto:publier-android).
