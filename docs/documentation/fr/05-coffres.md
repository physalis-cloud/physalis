---
title: Coffres
order: 5
icon: RiSafe2Line
summary: Coffre personnel, coffres d'équipe, TOTP des sites tiers.
---

# Coffres

Les **coffres** (`Vault`) servent à stocker des credentials qui ne sont
**pas** des variables d'environnement runtime — typiquement des accès
web (Bitwarden, AWS Console, dashboard Stripe, panneau OVH…).

Trois niveaux de coffres existent dans Physalis :

| Coffre              | Visibilité                          | Cas d'usage                                  |
|---------------------|--------------------------------------|----------------------------------------------|
| **Personnel**       | Vous seul                            | Vos accès personnels, BDD locales, perso     |
| **D'équipe (org)**  | Membres ajoutés à la collection      | Accès partagés entre tech leads d'une org    |
| **D'équipe (projet)** | Membres du projet (`ProjectMember`) | Accès liés à un projet spécifique            |

Tous les coffres utilisent le même chiffrement AES-256-GCM côté serveur
que les secrets de projet.

## Coffre personnel

Accessible via **🔒 Coffre personnel** dans la nav du dashboard, à
l'URL `/vault`. Personne d'autre que vous ne peut lire vos entrées —
même les OWNER de votre organisation.

### Les quatre types d'entrée

Tout n'est pas un login sur un site. La modale d'ajout commence par un
sélecteur de **type**, et le formulaire s'adapte :

| Type            | Ce qu'il contient                                  | Exemple                          |
|-----------------|----------------------------------------------------|----------------------------------|
| **Identifiant** | URL *(facultative)*, login, mot de passe, code 2FA | Console AWS, Gmail               |
| **Secret**      | Une seule valeur                                   | Clé d'API, numéro de licence     |
| **Liste**       | Plusieurs libellés + valeurs                       | Questions secrètes d'une banque  |
| **Note**        | Un texte libre                                     | Procédure de récupération        |

Seul le type **Identifiant** porte une URL — c'est donc le seul que
l'extension navigateur propose en remplissage automatique. Les trois
autres restent lisibles depuis le site.

Pour une **Liste**, les libellés sont chiffrés au même titre que les
valeurs : la recherche ne les couvre pas, la liste affiche simplement
« N secrets ».

### Créer une entrée

1. Bouton **« + Ajouter »** sur `/vault`.
2. Choisissez le type, puis remplissez :
   - **Nom** — libellé court (ex. « Console AWS prod »), commun à tous les types
   - **URL** — site web associé (utilisé par l'extension navigateur pour
     le matching de domaine)
   - **Identifiant** — login / email
   - **Mot de passe** — peut être généré avec le **🎲 générateur** intégré
     (longueur, symboles, exclusion de caractères ambigus configurables)
   - **TOTP** *(facultatif)* — clé `otpauth://...` pour générer les codes
     2FA du site tiers (voir plus bas)
3. **Collection**, **tags** et **★ favori** se règlent sur la dernière
   ligne du formulaire.

### Changer le type d'une entrée existante

Le sélecteur de type reste actif en modification, mais **seules les
conversions qui ne perdent rien** sont proposées. Concrètement : une
entrée qui n'a qu'un nom et un mot de passe peut devenir un Secret, une
Liste ou une Note — sa valeur est reportée automatiquement. Si l'entrée
porte encore une URL, un login ou un code 2FA, le type visé est grisé :
retirez le champ gênant et enregistrez avant de convertir.

Une Liste de plusieurs secrets ne se convertit vers rien : videz-la
d'abord si vous voulez en changer la forme.

### Générateur de mot de passe

Le bouton 🎲 ouvre un générateur universel avec :

- Longueur (8 → 64 caractères)
- Inclusion / exclusion : majuscules, minuscules, chiffres, symboles
- Exclusion des caractères ambigus (`0`/`O`, `1`/`l`/`I`)

Le mot de passe généré est inséré directement dans le champ — vous
pouvez le régénérer jusqu'à satisfaction avant de sauvegarder.

## Coffres d'équipe

### Coffre d'équipe au niveau organisation

Sur la page de l'org → onglet **🔒 Coffres**. Permet de créer une
**collection** (par ex. « Accès admin clients ») et d'y ajouter des
entrées partagées avec un sous-ensemble de membres choisi.

#### Créer une collection

> Permissions : ADMIN / OWNER de l'org.

1. Bouton **« + Nouvelle collection »**.
2. Saisissez :
   - **Nom** de la collection
   - **Membres** initiaux (depuis la liste des membres de l'org)
3. Validez. Tous les membres ajoutés voient désormais la collection
   et peuvent y créer / lire des entrées.

#### Ajouter / retirer un membre

Dans la collection → onglet **« Membres »** → ajouter via dropdown,
retirer via le bouton **« Révoquer »**.

> ⚠️ **Révoquer ne re-chiffre pas** les entrées existantes. Le membre
> révoqué n'a plus de session valide pour lire les entrées, mais
> considérez les credentials comme **potentiellement compromis** s'il
> a pu les exfiltrer pendant son passage. Procédez à une rotation de
> ce qui est sensible.

### Coffre d'équipe au niveau projet

Même principe, mais scopé à un projet : sur la page du projet →
onglet **🔒 Coffre** → collection visible par les `ProjectMember`.

Le **RBAC est hérité** automatiquement : pas besoin de gérer une liste
de membres séparée — quiconque a un rôle sur le projet a accès au
coffre projet (en lecture si VIEWER, en écriture si EDITOR/OWNER).

## TOTP des sites tiers

Si vous stockez la clé `otpauth://...` d'un site dans une entrée de
coffre, Physalis génère automatiquement les **codes TOTP à 6 chiffres**
toutes les 30 secondes (RFC 6238).

### Saisir une clé TOTP

Quand vous activez la 2FA sur un site externe, vous obtenez un QR code
ou une chaîne `otpauth://totp/...?secret=XXXX&...`. Collez cette chaîne
dans le champ **TOTP** de l'entrée :

- Chaîne `otpauth://` complète → parsée automatiquement (compte, issuer,
  algorithme, période)
- Ou juste le secret base32 (`JBSWY3DPEHPK3PXP`) → période/algo par défaut

### Lire le code

Sur l'entrée, le code à 6 chiffres s'affiche avec un **countdown** des
secondes restantes. Cliquez dessus pour copier dans le presse-papier.

L'**extension navigateur** ([→ Extension navigateur](extension-navigateur))
va plus loin : elle auto-fill les champs `autocomplete="one-time-code"`
sur les sites web sans copier-coller manuel.

## Déplacer une entrée perso → équipe ou compte de projet

Si vous avez créé une entrée personnelle qui mériterait d'être partagée ou
rattachée à un projet :

1. Sur l'entrée perso → bouton **« Déplacer »**.
2. Choisir la destination :
   - une **collection d'équipe** (org ou projet) à laquelle vous appartenez ;
   - ou un **Compte de projet** (onglet *Accès*) — l'entrée devient un compte
     applicatif. ⚠️ L'identifiant et le mot de passe sont conservés, mais
     l'**URL et le 2FA (TOTP) ne sont pas repris** (les comptes n'ont pas ces
     champs) ; un avertissement le rappelle.
3. Validez. L'entrée est **re-chiffrée et déplacée atomiquement** — elle
   disparaît de votre coffre perso et apparaît dans la destination choisie.

## Lecture par l'extension navigateur

L'extension Physalis (Chrome / Firefox, voir
[Extension navigateur](extension-navigateur)) lit les 3 sources de
coffre simultanément :

- Coffre personnel
- Coffres d'équipe (org)
- Coffres d'équipe (projet)

Sur le site visité, elle propose les credentials matchant le domaine
(via les URLs stockées dans les entrées).

## Aller plus loin

- [Extension navigateur](extension-navigateur) — auto-fill et auto-save
  des coffres sur le web
- [Partages](partages) — transmettre une entrée à un tiers sans la
  partager définitivement
