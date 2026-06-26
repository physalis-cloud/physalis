---
title: SSO & connexion externe
order: 15
icon: RiShieldKeyholeLine
summary: SSO entreprise (Google, GitHub, Microsoft, Okta, Keycloak, OIDC) et connexion avec un compte personnel.
---

# SSO & connexion externe

Physalis propose deux mécanismes de connexion fédérée, en complément du mot
de passe classique :

- **SSO entreprise** — vos membres se connectent via l'IdP de votre
  organisation (Google Workspace, GitHub, Microsoft Entra, Okta, Keycloak ou
  tout fournisseur OIDC standard). Configuré par le **propriétaire** de
  l'espace.
- **Connexion avec un compte personnel** (social login) — un membre lie son
  compte Google / GitHub / Microsoft personnel et s'en sert pour se connecter,
  en plus du mot de passe. Activé par le membre lui-même.

> 🔒 **Principe de sécurité — aucune création de compte automatique.** Le SSO
> connecte uniquement des membres **déjà invités** dans l'espace. Une identité
> fédérée qui ne correspond à aucun membre existant est **refusée**, jamais
> créée. Pour donner accès à quelqu'un, invitez-le d'abord (voir
> *Organisations & rôles*) ; il pourra ensuite se connecter en SSO.

---

## SSO entreprise

### À quoi ça sert

Vos collaborateurs se connectent à Physalis avec les identifiants de votre
fournisseur d'identité, sans mot de passe Physalis dédié. Vous gardez le
contrôle des accès depuis votre IdP (désactivation d'un compte, MFA, etc.).

### Configurer un provider

Réservé au **propriétaire de l'organisation principale** de l'espace.

1. **Mon compte → onglet SSO**.
2. Choisissez l'onglet du provider voulu (Google, GitHub, Microsoft, Okta,
   Keycloak, OIDC). Vous pouvez en configurer et en activer **plusieurs**.
3. Renseignez les champs (voir le tableau ci-dessous), définissez les
   **domaines autorisés**, cochez **Activer**, puis **Enregistrer**.
4. Le bouton **Tester** valide la découverte OIDC de l'issuer.

Le *client secret* est stocké chiffré et n'est jamais réaffiché : laissez le
champ vide à la modification pour conserver l'actuel.

### URL de redirection (callback)

Côté IdP, enregistrez l'URL de redirection de **votre sous-domaine** :

```
https://<votre-espace>.physalis.cloud/api/auth/callback/<provider>
```

où `<provider>` vaut `google`, `github`, `microsoft`, `okta`, `keycloak` ou
`oidc`. Exemple pour Google sur l'espace *acme* :
`https://acme.physalis.cloud/api/auth/callback/google`.

### Champs par provider

| Provider | Champs requis | Où créer l'application |
|---|---|---|
| **Google** | Client ID + secret | Google Cloud Console → Identifiants OAuth |
| **GitHub** | Client ID + secret | GitHub → Settings → Developer settings → OAuth Apps |
| **Microsoft** | Client ID + secret (+ Tenant ID, `common` par défaut) | Azure → App registrations |
| **Okta** | Client ID + secret + **Issuer URL** | Okta Admin → Applications (OIDC Web) |
| **Keycloak** | Client ID + secret + **Issuer URL** | Console Keycloak → Clients |
| **OIDC** (générique) | Client ID + secret + **Issuer URL** | N'importe quel IdP conforme OpenID Connect |

> **Domaines autorisés** : restreignez la connexion aux e-mails vérifiés de
> certains domaines (ex. `acme.fr`). Une identité hors de ces domaines est
> refusée — utile pour éviter qu'un compte perso au même provider serve à
> entrer.

### Imposer le SSO

L'option **Imposer le SSO** (tenant-wide) coupe la connexion par mot de passe
pour **tous** les membres : ils ne pourront se connecter que via le(s)
provider(s) SSO activé(s). Un filet anti-verrouillage conserve le mot de passe
tant qu'aucun provider n'est activé.

### Activer / désactiver

Chaque provider se configure et s'active **indépendamment**. Désactiver un
provider retire simplement son bouton de la page de connexion, sans supprimer
sa configuration.

> ✅ **Disponibilité** : Google, GitHub et Microsoft sont validés en
> production. Okta, Keycloak et l'OIDC générique empruntent le même flux OIDC
> standard et sont disponibles — validez-les dans votre environnement avant un
> déploiement large.

---

## Connexion avec un compte personnel (social login)

Pratique pour les membres qui préfèrent se connecter d'un clic avec leur
compte Google, GitHub ou Microsoft **personnel**, sans dépendre d'un IdP
d'entreprise. Cela utilise les applications OAuth de Physalis : **rien à
configurer** côté espace.

### Lier son compte

1. **Mon compte → Sécurité → Connexion avec un compte externe**.
2. Cliquez sur **Lier** en face du provider voulu.
3. Authentifiez-vous auprès du provider ; l'identité est rattachée à votre
   compte Physalis. Vous pouvez **délier** à tout moment.

La liaison est **explicite** : elle ne peut se faire que connecté à votre
compte. Aucune liaison automatique.

### Se connecter

Une fois lié, un bouton (« Google », « GitHub », « Microsoft ») apparaît sur
la page de connexion, en plus du mot de passe. Un clic vous connecte.

### Contrôle au niveau de l'espace

Le propriétaire peut activer/désactiver globalement le social login depuis
**Mon compte → SSO → onglet Social login**. Désactivé : aucun bouton social,
liaison masquée. Un provider déjà configuré en **SSO entreprise** n'est pas
proposé en double en social.

---

## Extension navigateur

Quel que soit votre mode de connexion sur le **web** (mot de passe, SSO ou
social), l'extension navigateur Physalis, si elle est installée, **se
rattache automatiquement** à votre session — aucune saisie supplémentaire.
Le login classique (e-mail + mot de passe + code TOTP) reste disponible
directement depuis le popup de l'extension pour les comptes à mot de passe.

---

## En résumé

- **SSO entreprise** = vos membres invités se connectent via votre IdP ;
  configuré par le propriétaire, multi-provider, callback sur votre
  sous-domaine, option « imposer le SSO ».
- **Social login** = un membre lie son compte perso et se connecte avec ;
  activable/désactivable par l'espace.
- **Jamais d'auto-provisioning** : on se connecte, on ne crée pas de compte.
- **Extension** : toute connexion web rattache l'extension automatiquement.
