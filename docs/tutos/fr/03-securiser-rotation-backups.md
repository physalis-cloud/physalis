---
title: Sécuriser son org : rotation auto + backups chiffrés
order: 3
icon: RiShieldCheckLine
summary: Passer en posture production : renouveler automatiquement un secret, et sauvegarder ses bases de données chiffrées vers son propre serveur — avec restauration en un clic.
level: avancé
duration: ~20 min
published: true
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

Ouvrez le menu **Paramètres → onglet Infos** et activez la rotation.
Tant qu'elle est désactivée, aucun bouton de rotation n'apparaît.

![Activer la rotation dans les paramètres de l'organisation](/tutos/fr/securiser-rotation-backups-01.png)

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

Physalis pré-sélectionne un **défaut intelligent** d'après le nom du secret (un
`*_PASSWORD` → **Base de données**, un `JWT_SECRET` → **JWT Secret**, le reste →
**Rappel**).

### Notre exemple : roter le mot de passe de la base

On prend le cas le plus **complet** — et le plus utile en production. Sur le
secret du mot de passe (ex. `DATABASE_PASSWORD`), ouvrez **Rotation**, activez,
réglez l'**intervalle** (en jours) et choisissez la stratégie **Base de
données**. Renseignez la **cible** :

| Champ | Valeur |
|-------|--------|
| `dbType` | `POSTGRESQL` ou `MYSQL` |
| `dbHost` | **nom de service Docker** de la base (ex. `db`, `postgres`) — on reste en réseau interne |
| `dbPort` | `5432`, `3306`… |
| `dbName` | nom de la base |
| `dbUser` | l'utilisateur **dont on rote le mot de passe** |

Laissez le **mode d'exécution** sur **Agent sur le VPS** *(le défaut)* — c'est
celui qu'on utilise ici, et c'est là qu'intervient l'**agent** :

- Physalis injecte au déploiement un **conteneur compagnon (l'agent)** à côté de
  votre application. C'est lui qui, **en local sur votre serveur**, se connecte à
  la base par son **nom de service Docker** (jamais exposée à l'extérieur),
  exécute le changement de mot de passe, puis **reporte** la nouvelle valeur à
  Physalis.
- **Aucun port de base à ouvrir vers l'extérieur**, et c'est le **même agent**
  qui gère les backups (§ 5).

![Modale de rotation en stratégie Base de données, mode Agent](/tutos/fr/securiser-rotation-backups-02.png)

> **Base managée ?** Si votre base est un service **managé joignable en TCP+SSL**
> (Supabase, RDS, Neon…), choisissez plutôt le mode **Directe** : Physalis s'y
> connecte lui-même, sans agent. Le reste du formulaire est identique.

> **Self-rotation, sans compte admin.** L'exécuteur se connecte **en tant que
> l'utilisateur à roter**, avec son mot de passe courant (lu dans le `.env`
> injecté), et exécute `ALTER … PASSWORD` sur lui-même — aucun superuser n'est
> stocké ni utilisé. La nouvelle valeur n'est écrite qu'**après** confirmation
> du changement à la source.

**La case « Build complet requis ».** Laissez-la **décochée** pour un mot de
passe de base : c'est un secret *runtime*, un redéploiement simple suffit. Ne la
cochez que si la valeur est figée **au build** (`VITE_*`, `NEXT_PUBLIC_*`,
compilées dans le bundle).

### Déployer l'agent — une seule fois par projet

Le mode Agent repose sur un **agent** : un petit **conteneur compagnon** que
Physalis fait tourner **à côté de votre application**, sur votre serveur. C'est
lui qui exécute la rotation **en local** — et c'est **le même agent** qui fera
les **sauvegardes** (§ 5). L'installer une fois couvre donc **les deux
fonctions**.

Une seule action pour l'installer : après avoir enregistré la rotation, cliquez
**une fois** sur **Redeploy** (bouton du projet). Physalis ajoute le service
agent au `docker-compose` servi, et il démarre au `docker compose up` habituel —
**rien à faire de votre côté** sur le serveur.

- **Un Redeploy simple suffit** (inutile de rebuild) : le compose servi contient
  déjà l'agent.
- **Une seule fois par projet** : l'agent en place gère ensuite **toutes** les
  rotations *et* les backups du projet ; chaque rotation déclenche elle-même son
  redéploiement.
- **À refaire pour chaque projet** où vous activez la rotation ou les backups :
  l'agent est **créé par projet** (un conteneur agent = un projet).

> Redeploy s'appuie sur la **connexion CI/CD** (`workflow_dispatch`) posée au
> [premier déploiement](tuto:premier-deploiement-github). Sans elle, aucun
> redéploiement (simple ou complet) ne peut partir.

## 3. Forcer une rotation pour tester

Afin de **valider** la rotation, on ne va pas attendre l'échéance : on la
**force**. Deux endroits permettent de déclencher la rotation d'un mot de passe.

**Depuis le projet**, sur le secret lui-même : rouvrez la modale **Rotation** et
utilisez **« Forcer »** (section *rotation immédiate*).

![Bouton « Forcer » dans la modale de rotation du secret](/tutos/fr/securiser-rotation-backups-03.png)

**Depuis Paramètres → onglet Rotation**, où vous retrouvez **l'ensemble des
rotations activées de l'organisation, classées par projet** : chaque ligne a son
propre bouton pour forcer la rotation.

![Onglet Rotation de l'organisation, rotations classées par projet](/tutos/fr/securiser-rotation-backups-04.png)

Dans les deux cas, la valeur est changée à la source selon la stratégie (en mode
**Agent**, c'est l'agent qui applique le changement à son prochain passage, sous
une minute), l'ancienne valeur est archivée dans le versioning, puis un
**redéploiement** recharge le `.env`.

> Une notification part à l'ADMIN/OWNER au **premier échec** seulement. Toute
> rotation est tracée dans l'audit log.

## 4. Paramétrer le backup pour l'organisation

Le service doit être **activé une fois**, et la destination se règle **une fois
par client**. Allez dans **Mon compte → onglet Services** et cochez **« Activer
le backup automatisé pour ce client »**.

Choisissez ensuite un **VPS de destination** (parmi vos serveurs) et un
**chemin** de base. Tous les projets y écriront, chacun dans son sous-dossier.

![Activer le backup automatisé et régler la destination (Mon compte → Services)](/tutos/fr/securiser-rotation-backups-05.png)

> Seul du **contenu chiffré** quitte votre VPS : Physalis ne voit jamais vos
> données et ne détient pas la clé de déchiffrement.

## 5. Activer le backup du projet

Dans l'onglet **Backup** du projet :

1. cliquez sur **« Configurer la sauvegarde »** ;
2. choisissez l'**environnement** à sauvegarder (prod par défaut) et vérifiez la
   liste des **bases détectées** automatiquement ;
3. réglez la **planification** : l'**intervalle** en jours (`1` = tous les jours)
   et l'**heure UTC** de passage (défaut **3 h UTC**) ;
4. réglez la **rétention** — combien de sauvegardes conserver, sur trois paliers
   **Daily / Weekly / Monthly** (défaut **7 / 4 / 3**) : Physalis garde les 7
   dernières sauvegardes **quotidiennes**, 4 **hebdomadaires** et 3
   **mensuelles**. Vous avez ainsi un historique **fin** sur les derniers jours
   et plus **espacé** sur les mois, sans tout conserver ;
5. enregistrez.

![Configuration du backup d'un projet](/tutos/fr/securiser-rotation-backups-06.png)

> **Même agent que la rotation.** La sauvegarde tourne via l'**agent** injecté au
> **prochain déploiement**. Si vous l'avez **déjà déployé pour la rotation
> (§ 2)**, c'est le **même conteneur** — rien à refaire. Sinon, un **Redeploy**
> l'installe (même procédure qu'au § 2, *une seule fois par projet*).

## 6. Passer en chiffrement Enveloppe KMS

Dans l'onglet **Backup**, cliquez sur **« Activer le chiffrement KMS »**.

L'**Enveloppe KMS** (recommandé par rapport à GPG) chiffre chaque archive avec
une clé de données unique, scellée par une **clé maître** qui ne quitte jamais le
coffre cryptographique.

Bénéfices : rotation/révocation/**audit** centralisés, et surtout la
**restauration en un clic** depuis Physalis.

> **Un Redeploy est nécessaire.** Le changement de chiffrement prend effet au
> **prochain déploiement** : c'est là que Physalis injecte l'**identité KMS**
> dans l'environnement de l'agent. Cliquez donc sur **Redeploy** — sans ça
> l'agent garde son schéma actuel (le prochain backup **seul** ne bascule pas).
> Après ce déploiement, **toutes** les sauvegardes passent en enveloppe. Cela ne
> touche **pas** aux accès de votre base, et les sauvegardes GPG déjà produites
> restent restaurables.

## 7. Forcer une sauvegarde

Cliquez sur le bouton **« Forcer maintenant »** : l'agent exécute la sauvegarde à
son prochain passage (sous une minute).

Le résultat apparaît dans l'**historique** (statut, fichier, taille, date).

![Historique des sauvegardes après un backup forcé](/tutos/fr/securiser-rotation-backups-07.png)

## 8. Restaurer (test en base neuve)

Sur une sauvegarde réussie de l'historique → bouton **« Restaurer »**, mode
**Nouvelle DB** (le plus sûr) :

1. créez au préalable une base **fraîche et vide** ;
2. lancez la restauration vers cette base.

![Restauration d'une sauvegarde](/tutos/fr/securiser-rotation-backups-08.png)

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
