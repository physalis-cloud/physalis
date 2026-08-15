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
