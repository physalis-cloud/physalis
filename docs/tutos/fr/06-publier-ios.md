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
- Un compte **Apple Developer** avec les droits d'administration.

## 1. Créer l'application dans Physalis

Onglet **Mobile** du projet → **Nouvelle application** :

- **Plateforme** : iOS
- **bundleId** : l'identifiant, en reverse-DNS (ex. `fr.exemple.monapp`)
- **Nom** : libellé lisible
- **Team ID / éditeur** (optionnel mais utile) : votre Team ID Apple (10
  caractères)

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

## 3. Le certificat de distribution (`.p12`) et le profil

Il vous faut un **certificat de distribution** et un **profil de provisioning
App Store** pour le bundleId de l'app.

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
d'expiration à l'import et vous alertera avant l'échéance.

## 4. Version et numéro de build

Sur la fiche de l'application, réglez la **version** (ex. `1.9`) et le **dernier
numéro de build publié** (le `CFBundleVersion` de votre dernière release, ex.
`10`). Physalis servira `11`, `12`… automatiquement.

## 5. Autoriser le pipeline (les policies)

Une app Capacitor construit d'abord sa couche web, donc **deux** policies sur le
même `(repo, workflow, branche)` :

- **Policy mobile** (dans l'app, section « Publication depuis le CI ») :
  workflow `release-ios.yml`, branche `production`.
- **Policy serveur** (onglet **Policies** du projet) : même workflow, même
  branche, environnement `production` — elle sert les `VITE_*` du build web.

Une app native pure n'a besoin que de la policy mobile.

## 6. Le workflow

Copiez les gabarits du dépôt public dans votre repo et adaptez le bloc `env`
(voir l'en-tête « À ADAPTER ») :

- `.github/workflows/release-ios.yml` (modèle
  `deploy-mobile-ios-capacitor.modele.yml`)
- `fastlane/Fastfile` (modèle `fastlane.Fastfile.modele`)

Le workflow tourne sur un **runner macOS**. Il récupère les `VITE_*` et le
matériel de signature via OIDC, extrait le nom du profil et le Team ID du
`.mobileprovision` (rien n'est codé en dur), construit l'`.ipa` en signature
manuelle, et le téléverse sur TestFlight. Par défaut il se déclenche
**manuellement** (`workflow_dispatch`).

> **Capacitor.** Le projet natif s'appelle toujours `App.xcworkspace` / scheme
> `App` (imposé par Capacitor), et il est régénéré à chaque build par
> `npx cap add`. Le gabarit gère déjà ce cas.

## C'est sur TestFlight

Le run vert dépose le build sur TestFlight. Vous le retrouvez dans App Store
Connect après quelques minutes de traitement Apple. Le numéro de build s'est
incrémenté tout seul dans Physalis.

Pour la version Android, suivez le tuto
[Publier une app Android sur Google Play](tuto:publier-android).
