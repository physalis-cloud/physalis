---
title: API Gateway
order: 11
icon: RiAppsLine
summary: Générer et gérer des clés API pour protéger vos propres services, avec validation en temps réel, rate limiting et monitoring d'usage.
---

# API Gateway

L'**API Gateway** de Physalis vous permet de protéger vos propres services
avec des clés d'API générées, validées et monitorées directement depuis votre
vault — sans infrastructure supplémentaire.

Physalis devient la source de vérité pour :

- La génération et révocation des clés
- La validation en temps réel de chaque requête
- Le monitoring d'usage par clé (logs, stats, rate limiting)
- La rotation automatique des clés avec redéploiement

## Concepts

```
Projet
  └── API (ex : "API Commandes")
        ├── Clés (ApiKey)
        │     ├── Scopes (permissions)
        │     ├── Rate limit
        │     └── Expiration
        └── Logs d'accès
```

Une **API** dans Physalis représente un de vos services à protéger. Chaque
API peut avoir plusieurs clés — une par client, par environnement, ou par
workflow.

## Format des clés

```
ph_live_sk_<64 caractères hexadécimaux>
```

- Le préfixe `ph_` est reconnu par les outils de scan de secrets
  (trufflehog, gitleaks) pour détecter les fuites accidentelles.
- `live` vs `test` distingue les clés de production des clés de
  développement.
- La clé brute n'est jamais stockée en base : seul son hash SHA-256 est
  conservé.

## Créer une API

> Permissions : **EDITOR** ou supérieur sur le projet.

1. Ouvrez un projet → onglet **API Gateway**.
2. Cliquez sur **Nouvelle API**.
3. Renseignez le nom et optionnellement l'URL de votre service.
4. Choisissez le **mode de validation** :
   - **REMOTE** *(recommandé)* — chaque requête est validée en temps réel
     via Physalis. La révocation d'une clé est effective immédiatement.
   - **JWT** — les clés sont des tokens signés localement par votre service,
     sans appel réseau. Latence nulle, mais la révocation n'est effective
     qu'à l'expiration du token.
5. Définissez optionnellement un **rate limit par défaut** (requêtes par
   minute) pour toutes les clés de cette API.

## Créer une clé

1. Depuis le détail d'une API → **Nouvelle clé**.
2. Donnez un nom identifiant le consommateur (ex : `N8n workflow Commandes`,
   `CI/CD staging`).
3. Définissez des **scopes** si votre service les vérifie (ex :
   `read:orders`, `write:products`).
4. Personnalisez le rate limit ou la durée d'expiration si nécessaire.
5. La clé brute vous est affichée **une seule fois** à la création.
   Copiez-la et stockez-la en lieu sûr.

> ⚠️ Après fermeture de la fenêtre, la clé brute est irrécupérable. En cas
> de perte, révoquez la clé et créez-en une nouvelle.

## Utiliser une clé dans votre service

### Mode REMOTE — appel à Physalis à chaque requête

Votre middleware envoie la clé à l'endpoint public de Physalis pour valider
chaque requête entrante :

Le champ **`apiId` est requis** : c'est l'identifiant de VOTRE API (visible dans le
dashboard Gateway). Il garantit qu'une clé n'est acceptée que pour l'API à laquelle
elle appartient — sans lui, une clé valide destinée à une autre API serait acceptée.

```http
POST https://<votre-slug>.physalis.cloud/api/gateway/verify
Content-Type: application/json

{
  "apiId": "clx...",
  "key": "ph_live_sk_...",
  "path": "/api/orders",
  "method": "GET"
}
```

Réponse en cas de succès :

```json
{
  "valid": true,
  "apiId": "clx...",
  "keyId": "clx...",
  "keyPrefix": "ph_live_sk_ab",
  "scopes": ["read:orders"],
  "rateLimit": {
    "limit": 100,
    "remaining": 87,
    "resetAt": 1746270060
  }
}
```

Réponse en cas d'échec :

```json
{ "valid": false, "reason": "revoked" }
```

Les valeurs possibles pour `reason` sont : `invalid`, `revoked`, `expired`,
`rate_limited`, `api_id_required` (le champ `apiId` manque dans la requête).

### Exemple — middleware Next.js

```typescript
// middleware.ts
export async function middleware(req: NextRequest) {
  const key = req.headers.get("x-api-key");
  if (!key) return new Response("Unauthorized", { status: 401 });

  const res = await fetch(
    `${process.env.PHYSALIS_URL}/api/gateway/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiId: process.env.PHYSALIS_API_ID, key, path: req.nextUrl.pathname, method: req.method }),
    }
  );

  const data = await res.json();
  if (!data.valid) return new Response(data.reason, { status: 401 });

  return NextResponse.next();
}
```

### Exemple — node HTTP Request dans N8n

Dans un nœud **HTTP Request** de N8n, ajoutez un header :

```
x-api-key: ph_live_sk_...
```

L'endpoint de votre API valide la clé via Physalis. Vous voyez tous les
appels du workflow dans les logs de la clé.

## Rate limiting

Le rate limiting est géré **par clé** (pas par IP). Vous pouvez définir :

- Un **rate limit par défaut** sur l'API (hérité par toutes les nouvelles
  clés).
- Un **rate limit spécifique** sur une clé individuelle (override).

Les fenêtres disponibles sont `1m` (1 minute), `1h` (1 heure) et `1d`
(24 heures).

Quand la limite est atteinte, Physalis retourne :

```json
{ "valid": false, "reason": "rate_limited" }
```

## Logs et monitoring

Chaque appel à `/api/gateway/verify` génère une entrée dans les logs de la
clé (méthode, path, résultat, latence). Depuis le détail d'une API ou d'une
clé, vous pouvez :

- Voir les **stats 24h** : total de requêtes, taux de succès/erreur,
  répartition horaire.
- Parcourir les **logs récents** avec filtre par clé ou par résultat.
- Identifier les **top keys** par volume d'usage.

## Rotation automatique des clés

Vous pouvez configurer la **rotation automatique** d'un secret qui stocke
une clé API Gateway. Lors de chaque rotation :

1. Physalis génère une nouvelle clé.
2. La valeur du secret est mise à jour avec la nouvelle clé.
3. L'ancienne clé est **révoquée immédiatement** — toute validation retourne
   `{ valid: false, reason: "revoked" }` sans délai.
4. Un redéploiement GitHub Actions est déclenché pour recharger la nouvelle
   valeur.

Pour configurer la rotation :

1. Créez une clé dans l'API Gateway et stockez sa valeur comme secret
   (ex : `MY_SERVICE_API_KEY`).
2. Ouvrez la rotation du secret → stratégie **Clé API Gateway**.
3. Sélectionnez l'API et la clé correspondante.
4. Définissez l'intervalle en jours.
5. Si la clé est injectée au **build** (ex. `VITE_*` passé comme `--build-arg`
   Docker), cochez **« Build complet requis »** — Physalis déclenchera alors
   le workflow `deploy.yml` du projet au lieu du simple `redeploy.yml`, afin
   de rebuilder l'image avec la nouvelle valeur.

> ⚠️ La rotation automatique n'est adaptée que si la clé est chargée depuis
> le vault, soit au runtime via `.env`, soit au build via `--build-arg`.
> Si vous l'avez copiée directement dans n8n, Make ou un autre outil externe,
> vous devrez la mettre à jour manuellement après chaque rotation.

Voir [Rotation des secrets](rotations) pour la configuration complète.

## Révoquer une clé

Depuis le détail d'une API → colonne **Actions** → **Révoquer**. La
révocation est **immédiate** en mode REMOTE : la clé devient invalide pour
tout appel ultérieur à `/api/gateway/verify`.

> La révocation est auditée (`API_KEY_REVOKED`) et irréversible. Pour
> rétablir l'accès, créez une nouvelle clé.

## Supprimer une API

> Permissions : **OWNER** du projet uniquement.

La suppression d'une API efface toutes ses clés et tous ses logs de façon
permanente. Les entrées dans le registre global de tokens sont également
supprimées — toutes les clés de l'API deviennent invalides immédiatement.

## Sécurité

| Point                        | Implémentation                                           |
|------------------------------|----------------------------------------------------------|
| Clé jamais stockée en clair  | SHA-256 uniquement en base                               |
| Préfixe identifiable         | `ph_` détecté par trufflehog, gitleaks                   |
| Révocation instantanée       | Suppression du registre global token_index               |
| Rate limiting par clé        | Fenêtre fixe en mémoire, configurable par clé ou par API |
| Logs non bloquants           | Écriture asynchrone — ne ralentit pas la validation      |
| RBAC                         | EDITOR+ pour créer/révoquer, OWNER pour supprimer l'API  |
