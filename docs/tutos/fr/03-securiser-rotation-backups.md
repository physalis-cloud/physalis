---
title: Sécuriser son org : rotation auto + backups chiffrés
order: 3
icon: RiShieldCheckLine
summary: Passer en posture production : renouveler automatiquement un secret, et sauvegarder ses bases de données chiffrées vers son propre serveur — avec restauration en un clic.
level: avancé
duration: ~20 min
published: false
---

# Sécuriser son org : rotation auto + backups chiffrés

Ce guide fait passer votre organisation en **posture production** : d'abord la
**rotation automatique** d'un secret (fini les credentials qui traînent des
années), ensuite les **sauvegardes chiffrées** de vos bases vers votre propre
serveur, avec restauration orchestrée.

## Ce que vous allez accomplir

- La rotation **activée** pour votre organisation, et un premier secret qui se
  renouvelle tout seul
- Les bases d'un projet **sauvegardées, chiffrées**, vers votre VPS de
  destination
- Une **restauration testée** (dans une base neuve, sans toucher à la prod)

## Prérequis

- Un **plan payant** : rotation et backups sont des fonctions avancées.
- Le rôle **ADMIN** ou **OWNER** de l'organisation.
- Un **projet déjà déployé** (cf. [Créer un projet…](tuto:premier-deploiement-github))
  avec au moins une base de données.
- Un **VPS de destination** (parmi vos serveurs) pour recevoir les sauvegardes.

### Notes

Certains réglages sont **globaux** et ne se font **qu'une seule fois** :

- **Étape 1 — Activer la rotation** (niveau organisation)
- **Étape 4 — Définir la destination des backups** (niveau client, réutilisée
  par tous les projets)

---

## 1. Activer la rotation pour l'organisation

La rotation est **opt-in** au niveau de l'organisation.

Ouvrez **Paramètres de l'organisation → Avancé** et activez la rotation.
Tant qu'elle est désactivée, aucun bouton de rotation n'apparaît.

> La rotation se suspend automatiquement quand un projet est **mis en pause**.

## 2. Configurer la rotation d'un secret

Sur un secret d'environnement (onglet **Secrets** d'un projet), cliquez sur
**Rotation**. La modale regroupe la **configuration** (activer + intervalle en
jours + stratégie) et la **rotation immédiate**.

Choisissez la **stratégie** selon le secret :

| Secret | Stratégie | Ce que fait Physalis |
|--------|-----------|----------------------|
| `JWT_SECRET`, `SESSION_SECRET`… | **JWT Secret** | génère une nouvelle valeur, redéploie — 100 % auto |
| mot de passe de **base** (rôle PG/MySQL) | **Base de données** | self-rotation `ALTER … PASSWORD`, sans credential admin |
| clé émise par l'**API Gateway** Physalis | **Clé API** | nouvelle clé + révocation de l'ancienne |
| clé tierce (Stripe, Mailgun…) | **Rappel** | vous notifie ; vous changez à la source puis enregistrez |

![Modale de configuration de la rotation](/tutos/securiser-rotation-backups-02.png)

> 💡 Pour un premier test **sans risque**, prenez un `JWT_SECRET` en stratégie
> **JWT Secret** : Physalis gère tout, sans dépendance externe.

## 3. Forcer une rotation pour tester

Ne pas attendre l'échéance : dans la modale (ou l'onglet **Rotation** de l'org),
utilisez **« Forcer »** pour déclencher une rotation immédiate.

Physalis change la valeur à la source (selon la stratégie), archive l'ancienne
dans le versioning, puis déclenche un **redéploiement** pour recharger le `.env`.

> Une notification part à l'ADMIN/OWNER au **premier échec** seulement. Toute
> rotation est tracée dans l'audit log.

## 4. Définir la destination des backups

La destination se règle **une fois par client**, dans **Réglages → Sécurité** :
choisissez un **VPS de destination** (parmi vos serveurs) et un **chemin** de
base. Tous les projets y écriront, chacun dans son sous-dossier.

> Seul du **contenu chiffré** quitte votre VPS : Physalis ne voit jamais vos
> données et ne détient pas la clé de déchiffrement.

## 5. Activer le backup du projet

Dans l'onglet **Backup** du projet :

1. choisissez l'**environnement** à sauvegarder (prod par défaut) ;
2. vérifiez la liste des **bases détectées** automatiquement ;
3. réglez la **planification** (heure UTC + intervalle) et la **rétention**
   (nombre de sauvegardes conservées) ;
4. enregistrez.

![Configuration du backup d'un projet](/tutos/securiser-rotation-backups-05.png)

> La sauvegarde démarre au **prochain déploiement** : c'est là que Physalis
> injecte l'**agent** (conteneur compagnon) à côté de votre application.

## 6. Passer en chiffrement Enveloppe KMS

Dans l'onglet **Backup**, cliquez sur **« Activer le chiffrement KMS »**.

L'**Enveloppe KMS** (recommandé sur GPG) chiffre chaque archive avec une clé de
données unique, scellée par une **clé maître** qui ne quitte jamais le coffre
cryptographique. Bénéfices : rotation/révocation/**audit** centralisés, et
surtout la **restauration en un clic** depuis Physalis.

> Le changement prend effet au **prochain déploiement** et ne touche **pas** aux
> accès de votre base. Les sauvegardes GPG déjà produites restent restaurables.

## 7. Forcer une sauvegarde

Bouton **« Forcer maintenant »** : l'agent exécute la sauvegarde à son prochain
passage (sous une minute). Le résultat apparaît dans l'**historique** (statut,
fichier, taille, date).

## 8. Restaurer (test en base neuve)

Sur une sauvegarde réussie de l'historique → bouton **« Restaurer »**, mode
**Nouvelle DB** (le plus sûr) :

1. créez au préalable une base **fraîche et vide** ;
2. lancez la restauration vers cette base.

![Restauration d'une sauvegarde](/tutos/securiser-rotation-backups-08.png)

Physalis orchestre : l'agent tire l'archive, la **déchiffre en local** (via le
coffre, à la demande et audité) et la restaure. Le contenu en clair ne transite
jamais par Physalis.

> Le mode **« Remplacer en place »** est la vraie reprise après incident (il
> **écrase** la base courante) — à réserver aux vrais incidents, application à
> l'arrêt de préférence.

## Vérifier que tout fonctionne

- **Rotation** : dans l'onglet Rotation de l'org, le secret affiche
  `rotationLastStatus = success` et une **prochaine échéance**.
- **Backup** : l'historique montre une sauvegarde en **succès**, en mode
  enveloppe.
- **Restauration** : votre base de test contient bien les données restaurées.

## En cas de problème

- **Aucun bouton de rotation** → la feature n'est pas activée sur l'org
  (étape 1), ou le nom du secret n'est pas reconnu comme credential (`PORT`,
  URL, flag… : volontaire).
- **Aucune rotation automatique ne part** → le cron tourne en heure creuse
  (défaut 2 h UTC) ; utilisez **« Forcer »** pour tester à la demande.
- **La restauration « nouvelle DB » est refusée** → la base cible doit être
  **vide** (sécurité anti-écrasement).
- **Une sauvegarde est « sautée »** → le coffre cryptographique était
  momentanément indisponible ; reprise à la suivante — jamais de sauvegarde en
  clair.

## Et ensuite ?

- Tuto suivant : [Configurer le service d'emails](tuto:configurer-service-email)
- Pour approfondir :
  - [Rotation des secrets](rotations) — stratégie Webhook (comptes applicatifs),
    hooks côté application, comptes de bases managées
  - [Sauvegardes](sauvegardes) — GPG vs Enveloppe, rétention, sécurité
  - [Coffres](coffres) — partager des credentials non-runtime en équipe
