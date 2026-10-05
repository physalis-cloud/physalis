---
title: Déploiement mobile
order: 16
icon: RiSmartphoneLine
summary: Publier vos applications Android et iOS depuis votre CI sans aucun secret dans le pipeline — Physalis détient le matériel de signature, votre CI construit et téléverse directement vers les stores.
---

# Déploiement mobile

Physalis range le **matériel de signature** de vos applications mobiles
(keystore Android, certificat iOS, profils, clés d'API des stores), chiffré et
versionné, et le sert à votre CI **à la demande via OIDC** — sans qu'aucun
secret ne soit stocké dans votre dépôt.

C'est le pendant mobile du [Déploiement OIDC](deploiement-oidc) : même principe
de token signé par votre fournisseur CI, appliqué à la publication d'apps.

## Ce que Physalis fait — et ne fait pas

- **Physalis ne construit pas et ne stocke pas l'artefact.** Le build (`.apk`,
  `.aab`, `.ipa`) reste chez vous, sur votre runner CI. Physalis ne garde qu'un
  **enregistrement**, jamais le binaire.
- **Le CI téléverse directement** vers Google Play / App Store Connect. La
  donnée de publication ne transite pas par Physalis.
- **Physalis remplace `fastlane match`** : le matériel n'est plus dans un dépôt
  git chiffré par une passphrase d'équipe, mais dans le coffre — avec contrôle
  d'accès par projet, audit, versionnement et retrait immédiat d'un partant.

## Activer le service

1. **Plan.** Le déploiement mobile est une fonctionnalité des plans payants
   (indisponible sur le plan gratuit).
2. **Par projet.** Ouvrez les **Paramètres** du projet → section
   **Déploiement mobile** → cochez l'activation. L'onglet **Mobile** apparaît
   alors sur le projet. Chaque projet s'active séparément : un projet qui ne
   publie pas sur les stores n'a pas à porter l'onglet.

## Le matériel de signature

Dans l'onglet **Mobile**, une **application** = un couple (plateforme,
identifiant de store). Chaque application porte ses credentials, importés un
par un :

**Android** (5)
| Credential | Contenu |
|---|---|
| Keystore | le fichier `.jks`/`.p12` de signature |
| Mot de passe du keystore | texte |
| Alias de clé | texte |
| Mot de passe de la clé | texte |
| Compte de service Google Play | le JSON téléchargé depuis Google Cloud |

**iOS** (6)
| Credential | Contenu |
|---|---|
| Certificat de distribution (`.p12`) | + son mot de passe |
| Profil de provisioning (`.mobileprovision`) | |
| Clé d'API App Store Connect (`.p8`) | + Key ID + Issuer ID |

Seuls le certificat, le profil et le keystore portent une **date d'expiration**,
extraite à l'import (les autres sont des mots de passe ou des identifiants).
Pour un `.p12`/keystore protégé, renseignez la **passphrase** à l'import : elle
sert à lire la date, elle n'est pas conservée.

## Générer plutôt qu'importer

Vous n'êtes pas obligé de fabriquer ce matériel vous-même. Sur la fiche de
l'application, **Générer le matériel de signature** le produit dans le coffre —
la clé privée est créée là où elle sera gardée, et n'a donc jamais à voyager.
Disponible sur tous les plans payants, comme le reste du déploiement mobile.

**Android** — Physalis fabrique la clé d'upload (paire RSA + certificat,
~27 ans), son mot de passe et son alias : **quatre des cinq credentials**. Il ne
vous reste que le compte de service Google Play. Aucun compte n'est requis pour
cette génération.

> ⚠️ C'est la **clé d'upload**, celle que Google réinitialise si vous perdez la
> vôtre — pas la clé de signature d'app détenue par Play App Signing.

**iOS** — à partir de votre seule **clé d'API App Store Connect** (`.p8`, avec
son Key ID et son Issuer ID), Physalis enchaîne la paire de clés, la CSR, le
certificat de distribution, le `.p12` et le profil de provisioning : **trois
credentials sur six**, les trois autres étant précisément la clé d'API qui sert
d'entrée.

> **Aucun Mac requis.** Un Mac sert à *compiler*, pas à générer : la CSR et le
> `.p12` sont de la cryptographie, pas du Xcode. C'est ce qui remplace vraiment
> `fastlane match` — et l'aller-retour par le Trousseau macOS.

Deux limites à connaître côté Apple : l'**App ID doit déjà être enregistré**
dans votre compte développeur, et Apple plafonne les certificats de distribution
(2 à 3 par compte). Régénérer **tout** en consomme un et fait cesser de signer
les profils liés à l'ancien certificat.

> ⚠️ **Le remplacement n'a pas de retour arrière.** Physalis conserve bien
> l'ancienne valeur, mais **aucun écran ne permet aujourd'hui de la restaurer** :
> gardez une copie locale de votre `.p12` et de votre profil avant de régénérer.

### Régénérer le profil seul

C'est le cas le plus fréquent, et celui qu'il faut préférer : un profil vaut un
an, un certificat aussi, mais **leurs dates ne coïncident pas**. Quand seul le
profil expire, tout régénérer consommerait un certificat pour rien — et vous
cogneriez le plafond au bout de deux fois.

**Régénérer le profil seul** réutilise le certificat déjà en service : il
n'entame aucun slot, et ne touche ni au certificat ni à la clé privée. Physalis
retrouve le bon certificat en comparant les **empreintes**, pas les noms — deux
certificats d'un même compte portent souvent le même intitulé.

> Le profil régénéré peut afficher l'échéance du **certificat** plutôt qu'un an :
> Apple plafonne la validité d'un profil à celle du certificat qu'il embarque.
> Ce n'est pas une anomalie.

### Le plafond, et la révocation

**Voir les certificats Apple** liste les certificats de distribution du compte,
et marque celui **en service** — c'est-à-dire celui dont la clé privée est dans
le coffre, donc celui qui signe vos builds. Sans cette indication, révoquer est
un coup de dés.

Au plafond, il faut révoquer avant de générer. **Révoquer** appelle l'API d'Apple
pour vous, depuis Physalis, et l'inscrit au journal d'audit — c'est ce qui
remplace le `match nuke` de fastlane, en gardant la trace.

> ⚠️ Physalis **refuse** de révoquer le certificat en service, et ne passe outre
> qu'après une confirmation explicite. Le faire quand même casse vos publications
> tant qu'un nouveau certificat n'a pas été généré. L'audit porte alors
> `forced: true` : c'est la trace à chercher le jour où une signature échoue sans
> raison apparente.

## Vérifier le matériel

**Vérifier le matériel** répond à la question « est-ce que ça marchera ? » avant
de dépenser dix minutes de CI. Le contrôle est en deux temps : la cohérence de
ce qui est déposé, puis une **interrogation réelle des magasins**.

| Groupe | Ce qui est contrôlé |
|---|---|
| Complétude | tous les credentials requis sont-ils présents |
| Keystore | lisible avec le mot de passe fourni, alias déclaré réellement présent, mot de passe de clé cohérent |
| Certificat / Profil | lisibles, non expirés, échéance connue |
| Google Play | le compte de service existe, est invité dans la console, et a le droit de publier **cette** application |
| App Store Connect | la clé est acceptée et **voit** ce bundle id |

Ce sont ces deux dernières lignes qui font gagner du temps : elles distinguent
« clé invalide » de « clé valide mais pas invitée dans la console », et
« application inconnue d'Apple » de « rôle trop étroit ». Un `permission denied`
au fond d'un log de pipeline ne fait pas cette différence.

## Surveiller l'expiration

Un certificat de distribution Apple vaut un an, un profil de provisioning
aussi — et **ni Google, ni Apple, ni votre forge n'envoient de rappel
utilisable** là-dessus. Ils expirent un vendredi de release.

Physalis lit l'échéance à l'import (ou à la génération) et prévient les
**propriétaires de l'organisation** par email à **J-60, J-30, J-7**, puis à
l'expiration. Trois rappels et non un seul parce que le remède n'est pas le
même : à 60 jours on planifie, à 30 on agit, à 7 on est en retard. L'onglet
Mobile affiche en parallèle une bannière sur l'application concernée.

Le rappel n'est envoyé **qu'une fois par palier** : le contrôle tourne tous les
jours sans pour autant inonder les boîtes, et une échéance repoussée (matériel
renouvelé) réarme proprement le mécanisme. Un projet dont l'onglet Mobile est
désactivé ne génère aucun rappel — vous avez dit que vous ne publiiez plus de
là.

## Le registre des livraisons

L'onglet **Livraisons** d'une application répond à « quelle version est en
revue, laquelle est en ligne, qui l'a publiée, avec quel matériel » — une
question dont la réponse vit d'ordinaire dans trois consoles et un fil de
discussion.

Une ligne s'écrit en deux temps, et la distinction est le cœur du dispositif :

- **ce que Physalis constate** — au moment où il remet le matériel : numéro de
  build consommé, empreintes du matériel servi, identité OIDC du pipeline. Cette
  moitié ne peut pas mentir ;
- **ce que le pipeline rapporte** — piste et état, via
  `POST /api/deploy/mobile/report`, avec le même jeton OIDC et la même policy
  que le bundle. Déclaratif par nature.

Les états vont de `matériel servi` à `en ligne`, en passant par `téléversé`,
`en traitement`, `en revue`, `suspendu`, `refusé`, `échoué`. Une ligne restée à
`matériel servi` n'est pas un bug : elle dit que quelqu'un a obtenu du matériel
de signature et n'a rien publié — c'est précisément ce qu'un registre doit
montrer.

> **Physalis ne détient pas l'artefact.** Une livraison est un **signalement
> daté**, pas une preuve qu'un binaire existe ni qu'un magasin l'a accepté. Le
> registre signale aussi les livraisons signées avec un **matériel depuis
> remplacé** : ce build-là ne se reproduira plus à l'identique.

Les gabarits de workflow fournis appellent `/report` en fin de run, y compris
quand le run échoue — un échec survenu **après** la remise du matériel est
justement ce qu'on veut voir.

### ⚠️ « En ligne » veut dire « publié sur la piste », pas « approuvé »

Deux limites d'API à connaître, parce qu'elles ressemblent à des bugs :

- **Google Play n'expose nulle part l'état de la revue.** Une version peut être
  `completed` sur sa piste — donc affichée **en ligne** ici — et avoir été
  **refusée** par la conformité Play. Seule la console le montre. Il n'existe pas
  d'endpoint pour le lire ; en cas de doute, la Play Console fait foi.
- **Chez Apple, `VALID` signifie « binaire traité »**, pas « en vente ». Le
  passage en revue puis en vente relève d'une autre partie de l'API, que
  Physalis ne lit pas — on affiche donc `téléversé`, jamais `en ligne`, plutôt
  que d'annoncer une mise en vente qu'on n'a pas constatée.

## Le numéro de version

Apple et Google refusent un numéro de build qui ne croît pas. Physalis le tient
pour vous : sur la fiche de l'application, réglez la **version** (marketing,
ex. `1.4`) et le **dernier numéro de build publié**. À chaque déploiement,
Physalis sert le numéro suivant et l'incrémente — vous n'y touchez plus. La
version marketing, elle, reste à votre main.

## Les policies : deux, si votre app est hybride

Comme pour le déploiement serveur, une **policy** autorise un pipeline précis
`(repo, workflow, branche)` à récupérer le matériel. Deux natures :

- une **policy mobile** (onglet Mobile de l'app) → sert le **matériel de
  signature** ;
- une **policy serveur** (onglet Policies du projet) → sert les **secrets de
  build** (`VITE_*`, etc.).

⚠️ **Une app Capacitor / Cordova / Ionic construit d'abord une couche web**, qui
a besoin de ses secrets de build. Elle a donc besoin des **deux** policies, sur
le même `(repo, workflow, branche)`. Une app native pure n'a besoin que de la
policy mobile.

## Projet natif ou hybride : le delta

Quatre gabarits sont fournis, deux par plateforme :

| Projet | Gabarits |
|---|---|
| **Hybride** (Capacitor, Cordova, Ionic) | `deploy-mobile-android-capacitor.modele.yml`, `deploy-mobile-ios-capacitor.modele.yml` |
| **Natif** (Gradle/Kotlin, Xcode/Swift) | `deploy-mobile-android-native.modele.yml`, `deploy-mobile-ios-native.modele.yml` |

Un **seul `fastlane/Fastfile`** sert les quatre : ce qui sépare les deux
familles tient à ce que fait le *workflow* avant d'appeler la lane, pas à la
lane elle-même.

⚠️ **Les gabarits Capacitor ont publié pour de vrai** (Google Play et TestFlight,
depuis le CI, sans secret). Les gabarits natifs en sont la transposition et
**n'ont pas encore tourné** en conditions réelles : leur en-tête le dit. Les
parties sensibles — récupération du bundle, vérification d'empreinte, rapport,
lane fastlane — y sont reprises à l'identique ; relisez les deux points ci-dessous
avant votre premier run.

### Ce que le natif fait en moins

- **Pas d'appel à `/api/deploy`.** Sans couche web, il n'y a pas de secrets de
  build à injecter : une **seule policy mobile** suffit (voir la section
  précédente).
- **Pas de `npm ci` ni de `npx cap sync`.** Le projet natif est dans votre dépôt,
  versionné ; il n'est pas régénéré à chaque build.
- **Pas d'étape icônes ni permissions.** Elles vivent dans le projet, en git.

### Le point qui change vraiment : la version

Physalis fait autorité sur le numéro de build, mais **la façon de le poser
diffère**, et ce n'est pas cosmétique.

**Android.** Les gabarits patchent le `build.gradle` du module applicatif puis
**relisent le fichier** pour vérifier que la substitution a mordu. Le gabarit
natif accepte les deux syntaxes — `versionCode 12` (Groovy) et
`versionCode = 12` (Kotlin DSL). Si votre projet **calcule** sa version (nombre
de commits, fichier de propriétés, plugin de versioning), la substitution ne
trouvera rien : le workflow s'arrête et vous le dit, plutôt que de publier un
numéro faux. Remplacez alors cette étape par ce que votre projet attend.

**iOS.** C'est ici que les deux familles divergent le plus :

- **Capacitor** génère un `Info.plist` à valeurs **littérales**, qu'`agvtool` ne
  sait pas lire. Le gabarit y écrit donc directement avec `plutil -replace`.
- **Un projet Xcode natif** écrit `CFBundleVersion = $(CURRENT_PROJECT_VERSION)`
  et garde la valeur dans ses *build settings*. Y poser un littéral au `plutil`
  **déconnecterait le plist des réglages du projet** : le numéro réellement
  embarqué redeviendrait celui des build settings au build suivant. Le gabarit
  natif utilise donc `agvtool new-version -all`, qui est la bonne méthode là.

⚠️ `agvtool` exige le versioning **« Apple Generic »** (`VERSIONING_SYSTEM =
apple-generic`), qui est le défaut des projets Xcode récents. Le gabarit le
vérifie **avant** de construire et s'arrête net sinon — un build de 20 minutes
qui se solde par un rejet « redundant build version » coûte plus cher qu'un
échec immédiat.

### Ce qu'il faut adapter

Dans les deux gabarits natifs, un encadré `À ADAPTER POUR VOTRE PROJET` liste
les variables : identifiant de l'app, module Gradle (`app` par convention),
dossier du projet Xcode et nom du *scheme*.

## Coupe-circuit

Un bouton **pause/reprise** sur chaque application gèle ses publications : le CI
reçoit alors un refus clair et audité, sans que vous ayez à toucher au dépôt.
Le matériel de signature reste intact — c'est un veto ponctuel, pas une
révocation.

## Guides pas à pas

L'essentiel de la friction est chez Google et Apple. Deux tutos vous prennent
par la main, console par console :

- **[Publier une app Android sur Google Play](tuto:publier-android)** — compte de service,
  API, permissions, keystore.
- **[Publier une app iOS sur l'App Store](tuto:publier-ios)** — clé d'API App Store
  Connect, certificat, profil.
