# Journal des versions

Toutes les modifications notables de Physalis self-hosted. Le format suit
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le versionnage
[SemVer](https://semver.org/lang/fr/).

Les entrées marquées **⚠️ Rupture** demandent une action de votre part avant ou
pendant la mise à jour. Lisez-les avant de lancer `docker compose up -d`.

---

## [1.7.0] — 2026-10-05

> ⚠️ **Vous venez de la 1.6.0 ou d'une version antérieure ?** Lisez d'abord la
> rupture de la [1.6.1](#161--2026-09-26) : le port n'est plus publié que sur
> `127.0.0.1`. Une instance jointe directement par l'IP du serveur, sans
> reverse proxy, deviendrait injoignable tant que `BIND_IP` n'est pas posé.

La mise à jour applique une migration de base (`20261005100000_catchup_2026_10`)
au démarrage du conteneur, comme d'habitude. Elle n'ajoute que des tables et des
colonnes facultatives ou avec une valeur par défaut : aucune donnée n'est
modifiée, à une exception près, voulue — les projets existants sont marqués
« antérieurs au guide d'installation » (voir ci-dessous).

### Ajouté

- **Session CLI** : `physalis login` ouvre une session par flux d'appareil,
  approuvée depuis le navigateur (`/account/cli`). `physalis run` injecte les
  secrets avec les droits de l'utilisateur, re-vérifiés à chaque requête — plus
  besoin de fichiers `.env` sur le poste. `physalis pull` est refusé hors des
  environnements de développement et tracé comme un export. Les sessions
  ouvertes se consultent et se révoquent depuis le compte. Une session « agent
  IA » est limitée au périmètre coché par l'humain.
- **Clés SSH dans le coffre personnel** : génération ed25519 ou import
  (OpenSSH, PKCS#8, PEM). La clé privée n'est jamais renvoyée au navigateur.
  Une API d'agent SSH (`/api/agent/ssh/*`) liste les clés et fait signer par
  le serveur, chaque signature étant journalisée.
- **Suivi des déploiements** : chaque run OIDC est enregistré, son issue
  remonte par `/api/deploy/report` ou est lue chez la plateforme (GitHub,
  GitLab, Bitbucket). Un sous-onglet « Déploiements », ouvert par défaut,
  liste les runs d'un environnement et permet de les relancer.
- **Guide d'installation** : un onglet calcule les étapes restantes d'un projet
  depuis son état réel (dépôt, policy, fichier de workflow, premier
  déploiement) et fournit des modèles de workflow pré-remplis à copier ou
  télécharger. Les projets créés avant cette version sont marqués comme
  antérieurs au guide : il ne leur est pas imposé, et une vérification dédiée
  indique ce qui manque à leur workflow.
- Projets : recherche, ordre des environnements par glisser-déposer, filtre
  des secrets.
- Déploiement mobile : synchronisation des versions publiées et actions sur
  les magasins depuis l'interface.

### Modifié

- `/api/health` renvoie la version de l'image (`"version": "X.Y.Z+sha"`), pour
  savoir quelle version tourne réellement.
- Chaque image publiée est d'abord testée de bout en bout (Playwright) : la CI
  la lance avec le `docker-compose.yml` du dépôt sur une base neuve, puis joue
  les parcours de `e2e/` (connexion, projets, secrets, installation, session
  CLI). Un échec bloque la publication.

### Sécurité

- Import de clé SSH : le nombre de tours `bcrypt-pbkdf` est plafonné — une clé
  forgée pouvait bloquer le serveur.
- `axios` monte en 1.20.0 (dépendance de `mailgun.js`, envoi des emails
  transactionnels), ce qui ferme sept avis de sévérité haute et cinq de
  sévérité moyenne. Reste `braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm), sans version
  corrigée publiée : il n'intervient qu'à la construction de l'image (via
  Tailwind CSS), jamais à l'exécution.

## [1.6.1] — 2026-09-26

### ⚠️ Rupture — le port n'est plus publié sur toutes les interfaces

Le `docker-compose.yml` publiait l'application sur `0.0.0.0`. Il la publie
désormais sur `127.0.0.1` par défaut :

```yaml
- "${BIND_IP:-127.0.0.1}:${PORT:-3000}:3000"
```

**Qui est concerné** : vous seul·e, si vous joignez votre instance
**directement par l'adresse IP du serveur**, sans reverse proxy devant. Après
la mise à jour, elle deviendra injoignable.

**Qui ne l'est pas** : si Physalis est derrière nginx, Caddy, Traefik ou tout
autre proxy sur la même machine, ou si vous y accédez en `localhost`. Rien à
faire.

**Comment garder l'accès** — deux options, dans cet ordre de préférence :

1. **Mettre un reverse proxy devant** (recommandé). Il termine le TLS et parle
   au conteneur en local. C'est de toute façon ce qu'il faut pour du HTTPS.
2. **Rouvrir le port explicitement**, en posant `BIND_IP` dans votre `.env` :
   ```sh
   BIND_IP=10.0.0.5     # l'adresse d'une interface privée (VPN, réseau interne)
   BIND_IP=0.0.0.0      # toutes les interfaces — uniquement derrière un pare-feu
   ```

**Pourquoi ce changement.** Un port publié sans adresse ne se contente pas
d'écouter partout : il **contourne le pare-feu de l'hôte**, parce que Docker
insère ses propres règles et que la chaîne `DOCKER-USER` est vide par défaut.
Un `ufw deny` ne le bloque pas. Autrement dit, un gestionnaire de secrets
devenait joignable depuis l'Internet public dès que l'IP du serveur était
connue — et une IP se découvre sans effort, par l'historique DNS ou les
journaux de transparence des certificats. Un défaut fermé est le seul défaut
défendable pour ce type d'application.

### Sécurité

- Le conteneur applicatif est durci : système de fichiers racine en lecture
  seule (`read_only`), `no-new-privileges`, et `cap_drop: [ALL]` — le process
  écoute sur un port > 1024 et tourne déjà en utilisateur non-root, aucune
  capability Linux ne lui est nécessaire. Ces directives ne sont **pas**
  appliquées au service `db` : l'entrypoint PostgreSQL démarre en root et a
  besoin de `SETUID`/`SETGID`/`CHOWN` pour redescendre sur son utilisateur.
- Le cache d'images de Next.js est monté en `tmpfs` avec `mode: 01777`. La
  syntaxe courte laissait ce montage non inscriptible par l'utilisateur non-root
  du conteneur, ce qui produisait un `EACCES: mkdir '/app/.next/cache/images'`
  au démarrage une fois la racine en lecture seule.
- `sanitize-html` monte en 2.17.7, ce qui ferme
  [GHSA-g8qq-57p8-ggw5](https://github.com/advisories/GHSA-g8qq-57p8-ggw5)
  (XSS stockée via SVG SMIL). L'avis n'était pas exploitable dans Physalis — il
  suppose que les balises `svg`, `animate`/`set` et `text` soient autorisées, ce
  que notre configuration d'assainissement ne fait pas.
- Dépendances mises à jour pour fermer les failles connues (OSV.dev) :
  `next` 15.5.26, `next-auth` 5.0.0-beta.32 (`@auth/core` 0.41.3), `sharp`
  0.35.4, `js-yaml` 4.3.2, `deepmerge-ts` 8, et côté outillage de dev `vitest`
  3.2.7, `vite` 7.3.6, `browserslist` 4.29.1, `brace-expansion`.

### Modifié

- L'image est épinglée par **digest** dans le `docker-compose.yml`
  (`physalis:1.6.1@sha256:…`) : `docker compose pull` tire exactement l'image de
  cette version, jamais une image publiée depuis sous le même tag. Pour mettre à
  jour, récupérez la nouvelle version du dépôt (`git pull`), qui porte le digest
  suivant.
- PostgreSQL est épinglé sur `16.15-alpine` au lieu de `16-alpine`.
- L'installation **depuis les sources** passe par un fichier dédié, Docker
  refusant de construire une image dont la référence contient un digest :
  ```sh
  docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
  ```

### Ajouté

- Des limites de ressources (CPU, mémoire, PID) sont fournies **en commentaire**
  dans le `docker-compose.yml`, à décommenter et ajuster à votre machine. Elles
  ne sont volontairement pas actives par défaut : une limite mémoire trop basse
  ferait tuer le conteneur par l'OOM killer sur une grosse instance, et une
  indisponibilité n'est pas un durcissement.
