---
title: Configurer le service d'emails
order: 4
icon: RiMailSendLine
summary: Envoyer des emails depuis son propre domaine — connexion du domaine, DNS (SPF/DKIM/DMARC), expéditeurs, email de test, et clé API injectée dans les environnements.
level: intermédiaire
duration: ~15 min
published: true
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

- Le **service email activé pour le client**.
- Le rôle **EDITOR** ou supérieur sur le projet (connexion, DNS, envoi).
- L'accès à votre **registrar DNS** pour créer des enregistrements.
- Un **projet** existant (cf. [Créer un projet…](tuto:premier-deploiement-github)).

### Notes

L'**activation du service email** est un réglage **client**, à faire **une seule
fois**.

Ensuite, chaque projet connecte son propre domaine. Un projet ne peut connecter
**qu'un seul domaine** à la fois.

---

## 1. Activer le service et connecter votre domaine

### Service email

Allez dans **Mon compte** → onglet **Services** → cliquez sur le bouton
**« Activer le service email »**.

![Activation du service email depuis Mon compte](/tutos/fr/configurer-service-email-01.png)

### Connecter votre domaine

> Réservé au rôle **EDITOR** ou supérieur.

1. Ouvrez un projet → onglet **Email**.
2. Saisissez votre **domaine d'envoi** (ex. `mondomaine.com`) → **Connecter**.
3. Physalis enregistre le domaine, génère une **clé API dédiée** (chiffrée
   immédiatement) et affiche les **enregistrements DNS à créer**.

![Connexion du domaine d'envoi dans l'onglet Email du projet](/tutos/fr/configurer-service-email-02.png)

## 2. Créer les enregistrements DNS

L'onglet **Détails** affiche un tableau (Type / Nom / Valeur) à recopier chez
votre registrar :

- **SPF** — autorise le service à envoyer pour votre domaine
- **DKIM** — signe cryptographiquement vos emails
- **DMARC** — politique d'authentification et de reporting

![Enregistrements DNS à créer](/tutos/fr/configurer-service-email-03.png)

Ajoutez ces trois enregistrements chez votre **registrar DNS**.

> ⚠️ Physalis **ne crée pas** les enregistrements à votre place. La propagation
> DNS peut prendre de quelques minutes à quelques heures.

## 3. Vérifier les DNS

De retour dans l'onglet **Détails**, cliquez sur **« Vérifier les DNS »**.

Physalis contrôle SPF / DKIM / DMARC et affiche le résultat (ex. *« SPF : oui ·
DKIM : oui · DMARC : oui »*).

Une fois tout validé, le badge passe à **Vérifié**.

![Vérification des DNS](/tutos/fr/configurer-service-email-04.png)

## 4. Ajouter un expéditeur autorisé

Avant d'envoyer, déclarez au moins une adresse « From » sur votre domaine.

Onglet **Expéditeurs** → saisissez la partie gauche de l'**Adresse** (ex.
`contact`) : le domaine connecté est ajouté automatiquement. Renseignez le
**Nom** (ex. `Contact`) → **Ajouter**.

![Ajout d'un expéditeur autorisé dans l'onglet Expéditeurs](/tutos/fr/configurer-service-email-05.png)

> Un expéditeur est une **identité d'envoi** autorisée, pas une boîte de
> réception.

### L'expéditeur principal

Le **premier expéditeur créé devient l'expéditeur principal**. Son adresse est
injectée dans le `.env` de vos environnements sous `PHYSALIS_EMAIL_FROM` au
déploiement (étape 6) : vous n'avez **aucun secret à créer à la main**.

Si vous déclarez plusieurs expéditeurs, le badge **Principal** indique celui qui
est injecté, et le bouton **Définir comme principal** permet d'en changer.

![Deux expéditeurs déclarés : le badge Principal et le bouton Définir comme principal](/tutos/fr/configurer-service-email-05.1.png)

> **Le nom ne va pas dans l'adresse.** `PHYSALIS_EMAIL_FROM` ne contient que
> l'adresse (`contact@mondomaine.com`) ; le service compose lui-même l'en-tête
> `"Contact" <contact@mondomaine.com>` à partir du champ **Nom**. Renommer un
> expéditeur ne demande donc pas de redéploiement.

> **Après avoir changé l'expéditeur principal, redéployez** : vos applications
> lisent la valeur dans leur `.env`, mis à jour seulement au déploiement.

> Supprimer l'expéditeur principal laisse le projet **sans** expéditeur : vos
> envois seront refusés tant que vous n'en aurez pas désigné un autre et
> redéployé.

## 5. Envoyer un email de test

Onglet **Envoi** (EDITOR+) :

1. choisissez l'**Expéditeur** (parmi les autorisés) ;
2. renseignez **Destinataire**, **Objet** et **Message (HTML)** ;
3. **Envoyer**.

![Envoi d'un email de test](/tutos/fr/configurer-service-email-06.png)

> Les envois depuis l'UI sont **limités en débit** (anti-abus) : cet onglet sert
> aux tests. Pour l'envoi applicatif, utilisez les variables injectées
> (étape 6) depuis votre code (étape 7).

## 6. Utiliser les variables injectées

L'onglet **Détails → Variables d'environnement** liste ce qui est injecté dans
le `.env` de **chaque environnement** au déploiement :

```
PHYSALIS_EMAIL_API_KEY=...                 # clé API du projet (secrète, chiffrée)
PHYSALIS_EMAIL_DOMAIN=mondomaine.com       # votre domaine d'envoi
PHYSALIS_EMAIL_URL=https://...             # endpoint du service d'envoi
PHYSALIS_EMAIL_FROM=contact@mondomaine.com # votre expéditeur principal (étape 4)
```

Votre application lit ces variables pour appeler le service. La clé n'est
jamais stockée en clair : elle est déchiffrée uniquement au déploiement.

> Vous pouvez **Révéler** la clé ponctuellement depuis l'UI (EDITOR+, action
> limitée et journalisée `SECRET_REVEAL`).

### Transmettez-les à votre conteneur

Physalis écrit ces variables dans le `.env` du répertoire de déploiement. Si
votre `docker-compose.yml` déclare une liste `environment:`, **seules les clés
qui y sont énumérées atteignent le conteneur** — le `.env` ne sert alors qu'à
l'interpolation `${...}`. Pensez à les ajouter :

```yaml
services:
  backend:
    environment:
      PHYSALIS_EMAIL_URL: ${PHYSALIS_EMAIL_URL}
      PHYSALIS_EMAIL_API_KEY: ${PHYSALIS_EMAIL_API_KEY}
      PHYSALIS_EMAIL_FROM: ${PHYSALIS_EMAIL_FROM}
```

> Si vous utilisez `env_file: .env`, tout le fichier est transmis : rien à
> faire. C'est l'oubli le plus fréquent — les variables sont bien dans le
> `.env`, mais l'application ne les voit pas.

## 7. Envoyer depuis votre application

Un seul appel : `POST /v1/send` sur `PHYSALIS_EMAIL_URL`, avec votre clé dans
l'en-tête `x-api-key`.

### Node / TypeScript

```ts
// utils/physalis-email.ts
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export async function sendEmail({ to, subject, html, text }: {
  to: string; subject: string; html: string; text?: string;
}): Promise<void> {
  const baseUrl = env("PHYSALIS_EMAIL_URL").replace(/\/+$/, "");

  const res = await fetch(`${baseUrl}/v1/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env("PHYSALIS_EMAIL_API_KEY"),
    },
    body: JSON.stringify({
      from: env("PHYSALIS_EMAIL_FROM"),
      to,
      subject,
      html,
      ...(text ? { text } : {}),
    }),
  });

  // 202 = accepté et mis en file d'envoi.
  if (res.status !== 202 && res.status !== 200) {
    const body = await res.text().catch(() => "");
    throw new Error(`physalis-email HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}
```

### curl

Pratique pour tester en dehors de votre application :

```bash
curl -X POST "$PHYSALIS_EMAIL_URL/v1/send" \
  -H "content-type: application/json" \
  -H "x-api-key: $PHYSALIS_EMAIL_API_KEY" \
  -d '{
    "from": "'"$PHYSALIS_EMAIL_FROM"'",
    "to": "vous@exemple.com",
    "subject": "Test",
    "html": "<p>Bonjour</p>"
  }'
# → 202 {"success":true,"messageId":"...","queued":true}
```

Trois choses à savoir :

- **Exigez les variables, ne prévoyez pas de défaut.** Un repli du type
  `EMAIL_FROM || "noreply@" + domaine` fabrique un expéditeur qui n'est pas
  déclaré : le service le refuse. Mieux vaut une erreur claire au démarrage.
- **`202` signifie « accepté et mis en file »**, pas « reçu ». Le statut final
  est dans l'onglet **Historique**.
- **Les erreurs `400` sont explicites** : *Expéditeur (from) requis*,
  *Domaine expéditeur non enregistré*, *Expéditeur non autorisé* — dans ce
  dernier cas, l'adresse n'est pas dans vos expéditeurs déclarés (étape 4).

## 8. (Option) Activer la rotation automatique de la clé

Si la rotation est activée pour votre organisation, l'onglet **Détails** propose
une section **Rotation automatique** :

1. cochez **Activer la rotation automatique de la clé API** ;
2. définissez l'**intervalle (en jours)** ;
3. **Enregistrer**.

La rotation suit une stratégie **blue/green** :

nouvelle clé générée → redéploiement → l'ancienne n'est révoquée qu'au cycle
suivant (le temps que tous les environnements aient redéployé).

![Section Rotation automatique de la clé API dans l'onglet Détails](/tutos/fr/configurer-service-email-07.png)

## Vérifier que tout fonctionne

- Le domaine affiche le badge **Vérifié** (étape 3).
- L'**email de test** est bien reçu (étape 5).
- L'onglet **Historique** liste l'envoi avec le statut **Envoyé**.
- Après un déploiement, votre application trouve les variables
  `PHYSALIS_EMAIL_*` dans son environnement.

## En cas de problème

- **« Le service email n'est pas activé pour ce client »** → activez-le depuis
  **Mon compte → onglet Services** (étape 1).
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
