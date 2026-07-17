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

- Onglet **Expéditeurs** → saisissez la partie gauche de l'**Adresse** (ex :
  `contact`) — le domaine connecté est ajouté automatiquement — puis le **Nom**
  (ex : `Contact`), et **Ajouter**.
- Vous pouvez supprimer un expéditeur à tout moment.

> Un expéditeur est une identité d'envoi autorisée sur votre domaine, pas une
> boîte de réception.

### Expéditeur principal

Le **premier expéditeur créé devient l'expéditeur principal**. Son adresse est
injectée en `PHYSALIS_EMAIL_FROM` au déploiement : vous n'avez aucun secret à
créer à la main. Le badge **Principal** indique celui qui est injecté, et le
bouton **Définir comme principal** permet d'en changer — suivi d'un
redéploiement pour que vos applications reçoivent la nouvelle valeur.

Seule l'**adresse** est retenue : le **nom** d'affichage reste attaché à
l'expéditeur et le service compose lui-même l'en-tête `"Contact"
<contact@mondomaine.com>`. Renommer un expéditeur ne demande donc pas de
redéploiement.

> Supprimer l'expéditeur principal laisse le projet sans expéditeur : vos envois
> sont refusés tant que vous n'en désignez pas un autre et ne redéployez pas.

## Variables d'environnement injectées

L'onglet **Détails → Variables d'environnement** liste les variables injectées
dans le `.env` de **chaque environnement** au déploiement :

```
PHYSALIS_EMAIL_API_KEY=...                 # clé API du projet (secrète)
PHYSALIS_EMAIL_DOMAIN=mondomaine.com       # votre domaine d'envoi
PHYSALIS_EMAIL_URL=https://...             # endpoint du service d'envoi
PHYSALIS_EMAIL_FROM=contact@mondomaine.com # votre expéditeur principal
```

- `PHYSALIS_EMAIL_API_KEY` n'est jamais stockée en clair : elle est chiffrée
  (AES-256-GCM) et déchiffrée uniquement au déploiement. Vous pouvez la
  **Révéler** ponctuellement depuis l'UI (EDITOR+, action auditée).
- `PHYSALIS_EMAIL_FROM` n'apparaît que si un expéditeur principal est défini.
- Votre application lit ces variables pour appeler le service d'envoi.

> ⚠️ La révélation de la clé est limitée (anti-abus) et journalisée
> (`SECRET_REVEAL`).

### Transmettre les variables à votre conteneur

Physalis écrit ces variables dans le `.env` du répertoire de déploiement. Si
votre `docker-compose.yml` déclare une liste `environment:`, **seules les clés
qui y sont énumérées atteignent le conteneur** — le `.env` ne sert alors qu'à
l'interpolation `${...}` :

```yaml
services:
  backend:
    environment:
      PHYSALIS_EMAIL_URL: ${PHYSALIS_EMAIL_URL}
      PHYSALIS_EMAIL_API_KEY: ${PHYSALIS_EMAIL_API_KEY}
      PHYSALIS_EMAIL_FROM: ${PHYSALIS_EMAIL_FROM}
```

Avec `env_file: .env`, tout le fichier est transmis : rien à faire. C'est
l'oubli le plus fréquent — les variables sont bien dans le `.env`, mais
l'application ne les voit pas.

## Appeler le service depuis votre application

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

### Corps de la requête

| Champ | Requis | Détail |
|---|---|---|
| `from` | oui | Adresse **nue** (`contact@mondomaine.com`), pas le format `Nom <adresse>`. Doit être un expéditeur déclaré. |
| `to` | oui | Une adresse, ou un tableau (50 max). |
| `subject` | oui | |
| `html` / `text` | l'un des deux | Les deux sont acceptés simultanément. |
| `replyTo` | non | |
| `category` | non | `transactional` (défaut) ou `bulk`. |
| `attachments` | non | `{ filename, content, encoding }`, 25 max. |

### Bonnes pratiques

- **Exigez les variables, ne prévoyez pas de défaut.** Un repli du type
  `EMAIL_FROM || "noreply@" + domaine` fabrique un expéditeur qui n'est pas
  déclaré : le service le refuse. Mieux vaut une erreur claire.
- **`202` signifie « accepté et mis en file »**, pas « reçu ». Le statut final
  est dans l'onglet **Historique**.
- **Les erreurs `400` sont explicites** : *Expéditeur (from) requis*, *Domaine
  expéditeur non enregistré*, *Expéditeur non autorisé*.
- **`401`** = clé invalide, **`429`** = quota mensuel ou limite journalière
  atteinte.

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
