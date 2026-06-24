---
title: Sauvegardes
order: 14
icon: RiDatabase2Line
summary: Sauvegarder automatiquement les bases de données de vos projets, chiffrées, vers votre propre serveur — et les restaurer en un clic.
---

# Sauvegardes

Physalis sauvegarde automatiquement les **bases de données** de vos projets,
**chiffrées**, vers un serveur de destination que vous choisissez. Le principe :
seul du **contenu chiffré** quitte votre VPS — Physalis ne voit jamais vos
données, et ne détient pas la clé de déchiffrement.

## Comment ça marche

Au déploiement d'un projet, Physalis ajoute un **agent** (conteneur compagnon) à
côté de votre application. Cet agent :

1. se connecte à votre base, fait un `dump` ;
2. le **compresse et le chiffre** localement ;
3. l'envoie (`rsync`) vers votre **VPS de destination**.

Toutes les connexions sont **sortantes** : l'agent appelle Physalis et la
destination, rien n'entre. Le dump en clair ne quitte jamais le serveur de votre
projet.

## Prérequis : la destination

La destination se règle **une fois par client**, dans **Réglages → Sécurité** :
un **VPS de destination** (parmi vos serveurs) + un **chemin** de base. Tous les
projets du client y écrivent, chacun dans son sous-dossier.

## Activer le backup d'un projet

Dans l'onglet **Backup** du projet :

1. choisissez l'**environnement** à sauvegarder (prod par défaut) ;
2. les **bases de données** sont détectées automatiquement (depuis le
   `docker-compose` + les secrets) — vérifiez/ajustez la liste ;
3. réglez la **planification** (heure UTC + intervalle en jours) et la
   **rétention** (nombre de sauvegardes conservées) ;
4. enregistrez.

La sauvegarde démarre au **prochain déploiement** du projet (l'agent est injecté
à ce moment-là).

## Chiffrement : GPG ou Enveloppe KMS

Deux modes, choisis par projet via le bouton **« Activer le chiffrement KMS »** /
**« Repasser en GPG »** :

- **GPG (legacy)** : l'agent génère une paire de clés **sur votre VPS**, la clé
  privée n'en sort jamais. Simple, mais une clé par serveur (pas de gestion
  centralisée, pas de restauration orchestrée).
- **Enveloppe KMS** (recommandé) : chaque archive est chiffrée par une **clé de
  données unique**, elle-même scellée par une **clé maître** qui ne quitte
  jamais le coffre cryptographique (OpenBao). Avantages : rotation, révocation
  et **audit** centralisés, robustesse **post-quantique** (chiffrement
  symétrique AES‑256), et surtout la **restauration en un clic** depuis Physalis.

Le changement de mode prend effet au **prochain déploiement**. Il **ne touche pas
aux accès** de votre base (utilisateurs, mots de passe). Les sauvegardes déjà
produites en GPG restent restaurables.

## Forcer une sauvegarde

Le bouton **« Forcer maintenant »** demande une sauvegarde immédiate : l'agent
l'exécute à son prochain passage (sous une minute). Le résultat apparaît dans
l'historique.

## Historique

L'onglet **Backup** liste les sauvegardes (statut, fichier, taille, date),
**paginées par 10**. Une entrée en succès est restaurable (mode enveloppe).

## Restaurer une sauvegarde

Depuis l'historique, sur une sauvegarde réussie : bouton **« Restaurer »**. Deux
modes :

- **Nouvelle DB** (sûr, par défaut) : restaure dans une base **fraîche et vide**
  que vous créez au préalable. Idéal pour **vérifier** une sauvegarde ou repartir
  d'une copie sans toucher à la production.
- **Remplacer en place** : remplace le **contenu de la base courante** par la
  sauvegarde — la vraie **reprise après incident**. ⚠️ Les données actuelles de
  cette base sont **écrasées** ; à faire de préférence application à l'arrêt.

> **La restauration ne touche pas aux accès** (rôles, utilisateurs, mots de
> passe) : seul le **contenu** est restauré. Votre application se reconnecte
> normalement, avec les mêmes identifiants.

La restauration est **orchestrée** : Physalis demande à l'agent de tirer
l'archive, de la déchiffrer (via le coffre, à la demande et audité) et de la
restaurer **en local** sur votre serveur. Le contenu en clair ne transite jamais
par Physalis.

## Bon à savoir

- La restauration **« nouvelle DB »** exige une base cible **vide** (sinon elle
  est refusée, pour éviter tout écrasement accidentel).
- La restauration **« en place »** s'appuie sur les sauvegardes du mode
  **enveloppe** : utilisez une sauvegarde **récente** (forcez-en une au besoin).
- Si le coffre cryptographique est momentanément indisponible, une sauvegarde est
  **sautée** (reprise à la suivante) — **jamais** de sauvegarde en clair.

## Sécurité

- Seul du **chiffré** quitte votre serveur ; le VPS de destination ne stocke que
  des archives inexploitables sans le coffre.
- En mode **Enveloppe KMS**, la **clé maître ne quitte jamais** le coffre, et
  chaque client est **isolé** : la clé d'un client ne peut pas déchiffrer les
  sauvegardes d'un autre.
- Voir aussi : [Rotation des secrets](rotations) — qui utilise le même agent.
