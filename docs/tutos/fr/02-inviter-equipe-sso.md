---
title: Inviter son équipe et configurer le SSO
order: 2
icon: RiTeamLine
summary: Constituer son équipe avec les bons rôles, puis permettre à chacun de se connecter via l'IdP de l'entreprise (Google, GitHub, Microsoft, Okta…).
level: intermédiaire
duration: ~15 min
published: false
---

# Inviter son équipe et configurer le SSO

Ce guide vous accompagne pour **ouvrir Physalis à votre équipe** : inviter vos
collaborateurs avec le bon niveau d'accès, puis configurer le **SSO entreprise**
pour qu'ils se connectent avec les identifiants de votre fournisseur d'identité,
sans mot de passe Physalis dédié.

## Ce que vous allez accomplir

- Des membres invités dans votre organisation, chacun avec le bon rôle
- Un fournisseur SSO (Google, GitHub, Microsoft ou Okta) configuré et testé
- Vos collaborateurs qui se connectent via l'IdP de l'entreprise

## Prérequis

- Le rôle **ADMIN** ou **OWNER** pour inviter des membres
  (cf. [Organisations & rôles](organisations-et-roles)).
- Le rôle **OWNER de l'organisation principale** pour configurer le SSO.
- Un **fournisseur d'identité** (Google Workspace, GitHub, Microsoft Entra,
  Okta…) où vous pouvez créer une application OAuth/OIDC.

### Notes

Deux natures d'étapes ici :

- **Inviter des membres** (étapes 1→3) se fait **à la demande**, au fil des
  arrivées.
- **Configurer le SSO** (étapes 4→8) se fait **une seule fois pour tout
  l'espace** : ensuite, tous vos membres invités s'y connectent.

---

## 1. Choisir le rôle de chaque personne

Physalis a **4 rôles** hiérarchiques : `MEMBER` < `DEV` < `ADMIN` < `OWNER`.

| Rôle | Pour qui | En bref |
|------|----------|---------|
| **MEMBER** | non-tech | aucun projet visible sans ajout explicite ; accès à un coffre d'équipe |
| **DEV** | développeur | lit tous les secrets, gère les déploiements ; pas d'admin d'org |
| **ADMIN** | lead-tech | tout DEV + invite les membres + secrets globaux + audit complet |
| **OWNER** | propriétaire | tout ADMIN + renommer/supprimer l'org (idéalement 2 OWNER) |

> 💡 Choisissez le rôle **le plus faible** qui permet à la personne de
> travailler. On peut toujours l'élever ensuite (étape 3).

## 2. Inviter vos membres

> Réservé aux rôles **ADMIN** et **OWNER**.

1. Ouvrez votre organisation (sélecteur en haut à gauche) → onglet **Membres**.
2. Bouton **« + Inviter »**.
3. Saisissez l'**email** du destinataire et son **rôle** initial.
4. Validez : un email d'activation (valable **48h**) part automatiquement.

![Formulaire d'invitation d'un membre](/tutos/inviter-equipe-sso-02.png)

> 💡 **Quotas** : votre plan définit un nombre maximum de membres. À la limite,
> le formulaire est désactivé — révoquez un membre ou demandez un upgrade.

## 3. Ajuster un rôle ou révoquer un accès

Toujours dans l'onglet **Membres** :

- **Changer un rôle** : menu déroulant sur la ligne du membre (effet immédiat ;
  il devra parfois se reconnecter).
- **Révoquer** : bouton **« Révoquer »** — le membre perd l'accès à
  l'organisation et à ses projets, mais garde son compte Physalis. L'audit log
  conserve la trace de ses actions passées.

> ⚠️ Vous ne pouvez pas vous **rétrograder vous-même** si vous êtes le seul
> OWNER. Désignez d'abord un autre OWNER.

## 4. Ouvrir la configuration SSO

Passons au SSO entreprise. Allez dans **Mon compte → onglet SSO**, puis
choisissez l'onglet du fournisseur voulu (Google, GitHub, Microsoft, Okta,
Keycloak ou OIDC). Vous pouvez en configurer **plusieurs**.

> 🔒 **Sécurité — aucune création de compte automatique.** Le SSO connecte
> uniquement des membres **déjà invités** (étape 2). Une identité fédérée qui ne
> correspond à aucun membre est **refusée**, jamais créée.

## 5. Créer l'application côté fournisseur

Dans la console de votre fournisseur, créez une application OAuth/OIDC et
enregistrez l'**URL de redirection** de votre sous-domaine :

```
https://<votre-espace>.physalis.cloud/api/auth/callback/<provider>
```

où `<provider>` vaut `google`, `github`, `microsoft`, `okta`… Exemple Google sur
l'espace *acme* : `https://acme.physalis.cloud/api/auth/callback/google`.

| Provider | Où créer l'application | Champs à récupérer |
|----------|------------------------|--------------------|
| **Google** | Google Cloud Console → Identifiants OAuth | Client ID + secret |
| **GitHub** | Settings → Developer settings → OAuth Apps | Client ID + secret |
| **Microsoft** | Azure → App registrations | Client ID + secret (+ Tenant ID) |
| **Okta** | Okta Admin → Applications (OIDC Web) | Client ID + secret + **Issuer URL** |

## 6. Renseigner le provider dans Physalis

De retour dans **Mon compte → SSO**, sur l'onglet du fournisseur :

1. Collez le **Client ID** et le **client secret** (+ Issuer URL pour Okta).
2. Définissez les **domaines autorisés** (ex. `acme.fr`) : seules les identités
   dont l'email vérifié est sur ces domaines pourront entrer.
3. **Enregistrez.**

![Configuration d'un provider SSO](/tutos/inviter-equipe-sso-06.png)

> Le *client secret* est stocké chiffré et jamais réaffiché : à la modification,
> laissez le champ vide pour conserver l'actuel.

## 7. Tester et activer

1. Cliquez sur **Tester** : Physalis valide la découverte OIDC de l'issuer.
2. Cochez **Activer**, puis **Enregistrez** : le bouton du fournisseur apparaît
   sur la page de connexion.

![Test et activation du provider](/tutos/inviter-equipe-sso-07.png)

## 8. (Option) Imposer le SSO

L'option **Imposer le SSO** coupe la connexion par mot de passe pour **tous** les
membres : ils ne pourront se connecter que via le(s) provider(s) activé(s). Un
filet anti-verrouillage conserve le mot de passe tant qu'aucun provider n'est
actif.

> ⚠️ N'activez « Imposer le SSO » qu'**après** avoir vérifié qu'au moins un
> provider fonctionne (étape 7), sous peine de verrouiller votre espace.

## Vérifier que tout fonctionne

- Déconnectez-vous, puis sur la page de connexion de votre sous-domaine, le
  **bouton du fournisseur** est présent.
- Un membre invité (étape 2) clique dessus et arrive sur son dashboard.
- Une adresse **hors des domaines autorisés** est refusée.

## En cas de problème

- **« Identité refusée »** → la personne n'est pas membre de l'espace :
  invitez-la d'abord (étape 2). Le SSO ne crée jamais de compte.
- **Email hors domaine autorisé** → ajoutez son domaine à l'étape 6, ou
  utilisez le bon compte.
- **Le bouton n'apparaît pas** → le provider n'est pas **Activé** (étape 7).
- **Erreur de redirection côté IdP** → l'URL de callback (étape 5) ne correspond
  pas exactement à `…/api/auth/callback/<provider>` sur **votre** sous-domaine.

## Et ensuite ?

- Tuto suivant : [Sécuriser son org : rotation auto + backups chiffrés](tuto:securiser-rotation-backups)
- Pour approfondir :
  - [SSO & connexion externe](sso) — Keycloak, OIDC générique, et **social
    login** (compte perso lié par le membre)
  - [Organisations & rôles](organisations-et-roles) — permissions détaillées,
    secrets globaux
  - [Projets & environnements](projets-et-environnements) — donner accès à un
    MEMBER sur un projet précis
