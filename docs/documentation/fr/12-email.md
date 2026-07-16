---
title: Email
order: 12
icon: RiMailSendLine
summary: Envoyez des emails depuis votre propre domaine via le service d'envoi de Physalis — authentification DNS (SPF/DKIM/DMARC), expéditeurs autorisés, historique et clé API injectée dans vos environnements.
---

# Email

Le module **Email** permet à un projet d'envoyer des emails depuis **votre
propre domaine** via le service d'envoi de Physalis. La clé API et le domaine
sont injectés dans le `.env` de chaque environnement au déploiement — votre
application n'a plus qu'à les lire.

Physalis prend en charge :

- L'enregistrement de votre domaine d'envoi
- La génération des enregistrements DNS (SPF, DKIM, DMARC) et leur vérification
- La gestion des **expéditeurs autorisés** (adresses « From »)
- L'envoi d'emails de test et la consultation de l'**historique**
- La rotation automatique de la clé API

## Prérequis

Le service email doit d'abord être **activé pour le client** (organisation).
Un OWNER l'active depuis la page **Sécurité** (clic sur votre email dans
l'en-tête). Tant qu'il ne l'est pas, l'onglet affiche : *« Le service email
n'est pas activé pour ce client. »*

> Permissions : la connexion, la vérification, l'envoi et la gestion des
> expéditeurs nécessitent le rôle **EDITOR** ou supérieur sur le projet. Les
> rôles **VIEWER** peuvent consulter l'état, les expéditeurs et l'historique.

## Concepts

```
Projet
  └── Configuration email
        ├── Domaine d'envoi (ex : mondomaine.com)
        ├── Enregistrements DNS (SPF · DKIM · DMARC)
        ├── Clé API (chiffrée, injectée au déploiement)
        ├── Expéditeurs autorisés (adresses « From »)
        └── Historique des envois
```

Un projet ne peut connecter **qu'un seul domaine** à la fois.

## Connecter un domaine

> Permissions : **EDITOR** ou supérieur.

1. Ouvrez un projet → onglet **Email**.
2. Saisissez votre **domaine d'envoi** (ex : `mondomaine.com`) puis cliquez sur
   **Connecter**.
3. Physalis enregistre le domaine auprès du service d'envoi, génère une clé API
   dédiée au projet (chiffrée immédiatement) et affiche les **enregistrements
   DNS à créer**.

## Enregistrements DNS et vérification

Après connexion, l'onglet **Détails** affiche un tableau des enregistrements à
créer chez votre registrar (Type / Nom / Valeur) :

- **SPF** — autorise le service à envoyer pour votre domaine.
- **DKIM** — signe cryptographiquement vos emails.
- **DMARC** — politique d'authentification et de reporting.

1. Ajoutez ces enregistrements chez votre **registrar DNS**.
2. Cliquez sur **Vérifier les DNS**.
3. Physalis contrôle SPF / DKIM / DMARC et affiche le résultat (ex :
   *« SPF : oui · DKIM : oui · DMARC : oui »*). Une fois tout valide, le badge
   passe à **Vérifié**.

> La propagation DNS peut prendre de quelques minutes à quelques heures.
> Physalis ne crée pas les enregistrements à votre place : la vérification se
> contente de contrôler leur présence.

## Expéditeurs autorisés

Avant d'envoyer, déclarez au moins une adresse d'expédition (« From ») sur
votre domaine.

- Onglet **Expéditeurs** → renseignez **Adresse** (ex : `hello@mondomaine.com`)
  et **Nom** (ex : `Support`), puis **Ajouter**.
- Vous pouvez supprimer un expéditeur à tout moment.

> Un expéditeur est une identité d'envoi autorisée sur votre domaine, pas une
> boîte de réception.

## Variables d'environnement injectées

L'onglet **Détails → Variables d'environnement** liste les variables injectées
dans le `.env` de **chaque environnement** au déploiement :

```
PHYSALIS_EMAIL_API_KEY=...            # clé API du projet (secrète)
PHYSALIS_EMAIL_DOMAIN=mondomaine.com  # votre domaine d'envoi
PHYSALIS_EMAIL_URL=https://...        # endpoint du service d'envoi
```

- `PHYSALIS_EMAIL_API_KEY` n'est jamais stockée en clair : elle est chiffrée
  (AES-256-GCM) et déchiffrée uniquement au déploiement. Vous pouvez la
  **Révéler** ponctuellement depuis l'UI (EDITOR+, action auditée).
- Votre application lit ces variables pour appeler le service d'envoi.

> ⚠️ La révélation de la clé est limitée (anti-abus) et journalisée
> (`SECRET_REVEAL`).

## Envoyer un email de test

Depuis l'onglet **Envoi** (EDITOR+) :

1. Choisissez l'**Expéditeur** (parmi les expéditeurs autorisés).
2. Renseignez le **Destinataire**, l'**Objet** et le **Message (HTML)**.
3. Cliquez sur **Envoyer**.

> Les envois depuis l'UI sont limités en débit (anti-abus). Cet onglet sert aux
> tests ; pour l'envoi applicatif, utilisez les variables injectées dans votre
> code.

## Historique

L'onglet **Historique** liste les envois du domaine (Statut, Destinataire,
Objet, Date), avec un bouton **Rafraîchir**. Les statuts possibles sont
**Envoyé** et **Échec**.

## Rotation automatique de la clé

Si la fonctionnalité de rotation est activée pour votre organisation, l'onglet
**Détails** propose une section **Rotation automatique** :

1. Cochez **Activer la rotation automatique de la clé API**.
2. Définissez l'**intervalle (en jours)**.
3. **Enregistrer** — la prochaine date de rotation s'affiche.

La rotation suit une stratégie **blue/green** :

1. Une **nouvelle clé** est générée et chiffrée.
2. Un **redéploiement** est déclenché pour recharger la nouvelle valeur.
3. L'**ancienne clé n'est révoquée qu'au cycle suivant**, le temps que tous les
   environnements aient redéployé.

> En cas d'échec d'une rotation, aucune clé n'est révoquée et un nouvel essai
> est automatiquement programmé.

Voir [Rotation des secrets](rotations) pour le principe général.

## Déconnecter

Onglet **Détails → Déconnecter** (EDITOR+). La déconnexion **révoque la clé
API** auprès du service d'envoi et supprime la configuration locale. Les
variables ne sont plus injectées aux déploiements suivants.

## Permissions

| Action                                       | Rôle requis                          |
|----------------------------------------------|--------------------------------------|
| Voir l'état, les expéditeurs, l'historique   | VIEWER+                              |
| Connecter / déconnecter un domaine           | EDITOR+                             |
| Vérifier les DNS                             | EDITOR+                             |
| Ajouter / supprimer un expéditeur            | EDITOR+                             |
| Envoyer un email, révéler la clé             | EDITOR+                             |
| Configurer la rotation automatique           | EDITOR+ (rotation activée pour l'org) |
