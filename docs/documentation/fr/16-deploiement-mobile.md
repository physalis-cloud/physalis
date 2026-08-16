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
(2 à 3 par compte). Régénérer en consomme un et **fait cesser de signer les
profils liés à l'ancien certificat** — l'ancien matériel reste consultable dans
l'historique de l'application.

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
