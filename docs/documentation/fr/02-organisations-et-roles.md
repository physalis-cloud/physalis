---
title: Organisations & rôles
order: 2
icon: RiTeamLine
summary: Inviter des membres, comprendre les 4 rôles, gérer les permissions.
---

# Organisations & rôles

Une **organisation** est l'unité de regroupement principale dans Physalis :
elle contient des **membres**, des **projets**, des **secrets globaux**
(`OrgSecret`), des **serveurs** SSH et des **coffres d'équipe**.

Une même organisation cliente peut contenir plusieurs organisations
internes (ex. agence avec plusieurs équipes), et un même utilisateur peut
appartenir à plusieurs organisations — il bascule via le sélecteur en
haut à gauche du dashboard.

## Les 4 rôles d'organisation

Physalis utilise une hiérarchie à 4 niveaux : `MEMBER` < `DEV` < `ADMIN` < `OWNER`.

| Permission                                  | MEMBER | DEV | ADMIN | OWNER |
|---------------------------------------------|:------:|:---:|:-----:|:-----:|
| Lire les **secrets de l'organisation**      |   —    | ✅  |  ✅   |  ✅   |
| Lire les **serveurs SSH**                   |   —    | ✅  |  ✅   |  ✅   |
| Voir tous les **projets** par défaut        |   —    | ✅* |  ✅   |  ✅   |
| Gérer les **Policies de déploiement**       |   —    | ✅  |  ✅   |  ✅   |
| Voir l'**audit log** complet                |   —    |  —  |  ✅   |  ✅   |
| Voir l'audit log filtré (ses actions)       |   —    | ✅  |  —    |  —    |
| Inviter / révoquer des **membres**          |   —    |  —  |  ✅   |  ✅   |
| Gérer les **secrets globaux** (création)    |   —    |  —  |  ✅   |  ✅   |
| Renommer / supprimer l'organisation         |   —    |  —  |   —   |  ✅   |

> ✅* Pour DEV, la visibilité est **EDITOR implicite** sur tous les projets
> de l'organisation : il voit tout, peut créer/modifier secrets et envs,
> mais ne peut pas supprimer un projet ni inviter des ProjectMember.

### Restreindre un DEV à certains projets

Cet accès par défaut se règle projet par projet. Décocher un projet pour un
DEV le lui **interdit vraiment** : le projet disparaît de sa liste, l'accès
est refusé, et ses jetons machine sur ce projet sont révoqués.

Trois endroits pour le faire, selon le moment :

- **À l'invitation** — bouton « Droits d'accès » à côté du rôle, dans le
  formulaire d'invitation. Le nouveau membre arrive déjà cantonné.
- **À la création d'un projet** — section « Droits d'accès des membres » du
  formulaire de création. C'est le seul moment où l'oubli est impossible :
  un projet neuf est sinon visible d'emblée par tous les DEV de l'org.
- **Après coup** — `/orgs/<slug>` → onglet « Membres » → « Droits d'accès »
  en face du membre, ou l'onglet « Membres » du projet lui-même.

Les cases y montrent toujours l'accès **réel** du membre : un DEV s'ouvre
tout coché, puisque c'est ce qu'il a.

### Quand utiliser quel rôle ?

- **MEMBER** → un employé non-tech qui n'a accès qu'à un coffre d'équipe
  spécifique (par ex. les commerciaux qui partagent un Vaultwarden interne).
  Aucun projet visible tant qu'on ne l'ajoute pas explicitement comme
  `ProjectMember`.
- **DEV** → un développeur. Il peut lire tous les secrets de tous les
  projets, gérer les déploiements OIDC, mais ne touche pas à l'admin de
  l'organisation (membres, secrets globaux, suppression).
- **ADMIN** → un lead-dev / responsable technique. Tout DEV + invitation
  des membres + secrets globaux + audit complet.
- **OWNER** → propriétaire de l'organisation. Le seul à pouvoir la
  supprimer ou la renommer. Idéalement 2 OWNER pour éviter le single
  point of failure.

## Inviter un membre

> Réservé aux rôles **ADMIN** et **OWNER**.

1. Allez dans `/orgs/<slug>` (depuis le sélecteur d'org en haut à gauche).
2. Onglet **« Membres »** → bouton **« + Inviter »**.
3. Saisissez :
   - **Email** du destinataire
   - **Rôle** initial dans l'organisation
4. Validez. Un email est envoyé via Mailgun avec un lien d'activation
   **valable 48h**.

Si le destinataire n'a pas encore de compte Physalis, il en crée un en
acceptant l'invitation. S'il en a déjà un (autre organisation sur la
même plateforme), il est ajouté à la nouvelle org en un clic.

> 💡 **Quotas** : votre plan client définit un nombre maximum de membres
> (`maxUsers`). Si vous l'atteignez, le formulaire d'invitation est
> désactivé — il faut soit révoquer un membre, soit demander un upgrade
> de plan au super-admin.

## Changer le rôle d'un membre

Onglet **« Membres »** → ligne du membre → menu déroulant **rôle** →
choisir le nouveau rôle. Le changement est immédiat ; le membre doit
parfois se reconnecter pour voir ses nouvelles permissions actives.

> ⚠️ Vous ne pouvez pas vous **rétrograder vous-même** si vous êtes le
> seul OWNER. Désignez d'abord un autre OWNER.

## Révoquer un membre

Même onglet → bouton **« Révoquer »**. Le membre :

- Perd immédiatement l'accès au dashboard de cette organisation
- Perd l'accès à tous les projets liés à cette organisation
- **Garde** son compte Physalis (utilisable sur ses autres organisations)
- **Ne peut plus** déchiffrer les secrets qu'il avait pu voir — son
  compte n'a plus de session valide

L'audit log conserve une trace complète des actions effectuées par ce
membre du temps où il était dans l'organisation.

## Secrets globaux de l'organisation (`OrgSecret`)

Les **OrgSecret** sont des secrets partagés entre tous les projets de
l'organisation. Utilisés typiquement pour :

- Tokens d'API tiers (`SENTRY_DSN`, `STRIPE_KEY`…) communs à tous les projets
- **Conventions Physalis réservées** :
  - `GITHUB_DISPATCH_TOKEN` — pour le bouton « Redeploy » qui déclenche
    un `workflow_dispatch` GitHub
  - `REGISTRY_PAT`, `REGISTRY_USER`, `REGISTRY_URL` — pour authentifier
    `docker pull` depuis un registre privé pendant le déploiement OIDC
    (cf. [Déploiement OIDC](deploiement-oidc))

Création / édition : onglet **« Secrets globaux »** sur la page de
l'organisation. Réservé à ADMIN / OWNER (lecture autorisée à DEV).

## Supprimer une organisation

> Réservé au rôle **OWNER**.

Onglet **« Paramètres »** → section **« Zone dangereuse »**. La
suppression :

- Détruit **tous** les projets, environnements, secrets, coffres et
  policies liés
- Est **irréversible** (les données chiffrées sont supprimées de la DB)
- Détache tous les membres (qui restent inscrits sur Physalis)

Une confirmation par saisie du nom de l'organisation est demandée.

## Aller plus loin

- [Projets & environnements](projets-et-environnements) — créer votre
  premier projet et y ajouter des secrets
- [Coffres](coffres) — créer un coffre d'équipe partagé
- [Déploiement OIDC](deploiement-oidc) — configurer Server + Policy
