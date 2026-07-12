---
title: Configurer le service d'emails
order: 4
icon: RiMailSendLine
summary: Envoyer des emails depuis son propre domaine — connexion du domaine, DNS (SPF/DKIM/DMARC), expéditeurs, email de test, et clé API injectée dans les environnements.
level: intermédiaire
duration: ~15 min
published: false
---

# Configurer le service d'emails

Ce guide branche l'**envoi d'emails depuis votre propre domaine** sur un projet.
À la fin, votre application enverra ses emails via le service Physalis, avec une
clé API et un domaine **injectés automatiquement** dans le `.env` de chaque
environnement au déploiement.

## Ce que vous allez accomplir

- Votre **domaine d'envoi** connecté et authentifié (SPF/DKIM/DMARC vérifiés)
- Un **expéditeur autorisé** et un **email de test** envoyé
- Les **variables email injectées** dans vos environnements, prêtes à l'emploi

## Prérequis

- Le **service email activé pour le client** : un **OWNER** l'active depuis la
  page **Sécurité** (clic sur votre email dans l'en-tête).
- Le rôle **EDITOR** ou supérieur sur le projet (connexion, DNS, envoi).
- L'accès à votre **registrar DNS** pour créer des enregistrements.
- Un **projet** existant (cf. [Créer un projet…](tuto:premier-deploiement-github)).

### Notes

L'**activation du service email** est un réglage **client**, à faire **une seule
fois** (par un OWNER). Ensuite, chaque projet connecte son propre domaine. Un
projet ne peut connecter **qu'un seul domaine** à la fois.

---

## 1. Connecter votre domaine

> Réservé au rôle **EDITOR** ou supérieur.

1. Ouvrez un projet → onglet **Email**.
2. Saisissez votre **domaine d'envoi** (ex. `mondomaine.com`) → **Connecter**.
3. Physalis enregistre le domaine, génère une **clé API dédiée** (chiffrée
   immédiatement) et affiche les **enregistrements DNS à créer**.

## 2. Créer les enregistrements DNS

L'onglet **Détails** affiche un tableau (Type / Nom / Valeur) à recopier chez
votre registrar :

- **SPF** — autorise le service à envoyer pour votre domaine
- **DKIM** — signe cryptographiquement vos emails
- **DMARC** — politique d'authentification et de reporting

![Enregistrements DNS à créer](/tutos/configurer-service-email-02.png)

Ajoutez ces trois enregistrements chez votre **registrar DNS**.

> ⚠️ Physalis **ne crée pas** les enregistrements à votre place. La propagation
> DNS peut prendre de quelques minutes à quelques heures.

## 3. Vérifier les DNS

De retour dans l'onglet **Détails**, cliquez sur **« Vérifier les DNS »**.
Physalis contrôle SPF / DKIM / DMARC et affiche le résultat (ex. *« SPF : oui ·
DKIM : oui · DMARC : oui »*). Une fois tout valide, le badge passe à **Vérifié**.

![Vérification des DNS](/tutos/configurer-service-email-03.png)

## 4. Ajouter un expéditeur autorisé

Avant d'envoyer, déclarez au moins une adresse « From » sur votre domaine.

Onglet **Expéditeurs** → renseignez l'**Adresse** (ex. `hello@mondomaine.com`)
et le **Nom** (ex. `Support`) → **Ajouter**.

> Un expéditeur est une **identité d'envoi** autorisée, pas une boîte de
> réception.

## 5. Envoyer un email de test

Onglet **Envoi** (EDITOR+) :

1. choisissez l'**Expéditeur** (parmi les autorisés) ;
2. renseignez **Destinataire**, **Objet** et **Message (HTML)** ;
3. **Envoyer**.

![Envoi d'un email de test](/tutos/configurer-service-email-05.png)

> Les envois depuis l'UI sont **limités en débit** (anti-abus) : cet onglet sert
> aux tests. Pour l'envoi applicatif, utilisez les variables injectées (étape 6).

## 6. Utiliser les variables injectées

L'onglet **Détails → Variables d'environnement** liste ce qui est injecté dans
le `.env` de **chaque environnement** au déploiement :

```
PINK_FLOYD_API_KEY=...            # clé API du projet (secrète, chiffrée)
PINK_FLOYD_DOMAIN=mondomaine.com  # votre domaine d'envoi
PINK_FLOYD_URL=https://...        # endpoint du service d'envoi
```

Votre application lit ces variables pour appeler le service. La clé n'est
jamais stockée en clair : elle est déchiffrée uniquement au déploiement.

> Vous pouvez **Révéler** la clé ponctuellement depuis l'UI (EDITOR+, action
> limitée et journalisée `SECRET_REVEAL`).

## 7. (Option) Activer la rotation automatique de la clé

Si la rotation est activée pour votre organisation, l'onglet **Détails** propose
une section **Rotation automatique** :

1. cochez **Activer la rotation automatique de la clé API** ;
2. définissez l'**intervalle (en jours)** ;
3. **Enregistrer**.

La rotation suit une stratégie **blue/green** : nouvelle clé générée →
redéploiement → l'ancienne n'est révoquée qu'au cycle suivant (le temps que tous
les environnements aient redéployé).

## Vérifier que tout fonctionne

- Le domaine affiche le badge **Vérifié** (étape 3).
- L'**email de test** est bien reçu (étape 5).
- L'onglet **Historique** liste l'envoi avec le statut **Envoyé**.
- Après un déploiement, votre application trouve les variables `PINK_FLOYD_*`
  dans son environnement.

## En cas de problème

- **« Le service email n'est pas activé pour ce client »** → un OWNER doit
  l'activer depuis la page Sécurité (voir Prérequis).
- **La vérification DNS échoue** → propagation en cours, ou un enregistrement
  mal recopié. Attendez et re-vérifiez ; comparez au tableau de l'étape 2.
- **Impossible d'envoyer** → aucun **expéditeur** déclaré (étape 4), ou domaine
  pas encore **Vérifié**.
- **Les variables n'apparaissent pas dans l'app** → elles sont injectées **au
  déploiement** : redéployez après avoir connecté le domaine.

## Et ensuite ?

- Pour approfondir :
  - [Email](email) — historique, déconnexion, permissions détaillées
  - [Rotation des secrets](rotations) — le principe général derrière la rotation
    de la clé API
  - [Secrets & catégories](secrets) — comment les variables arrivent dans vos
    environnements
- Revenir au début : [Créer un projet, le connecter à GitHub et le déployer](tuto:premier-deploiement-github)
