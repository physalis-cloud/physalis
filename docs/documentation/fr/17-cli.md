---
title: CLI et fin des fichiers .env
order: 17
icon: RiTerminalBoxLine
summary: Injectez vos secrets dans vos commandes de développement, sans fichier .env sur le disque.
---

# CLI et fin des fichiers .env

La CLI `physalis` remplace les fichiers `.env` de vos projets. Au lieu de lire
un fichier en clair, votre application reçoit ses secrets **au lancement**,
dans les variables d'environnement de son processus. Rien n'est écrit sur le
disque.

```bash
physalis run -- npm run dev
```

## Installation

```bash
npm install -g physalis-cli
```

Node.js 18 ou plus récent. La CLI n'a aucune dépendance.

## Se connecter : une session pour tous vos projets

```bash
physalis login --url https://<votre-slug>.physalis.cloud
```

1. La CLI affiche un **code** (par exemple `BCDF-GHJK`) et ouvre votre
   navigateur sur la page **Connecter un terminal**.
2. Vérifiez que le code affiché dans la page est **le même** que celui de
   votre terminal, puis cliquez sur **Approuver**.
3. La CLI reçoit une session valable **12 heures**, qui donne accès à **tous
   les projets** auxquels vous avez accès dans l'interface, avec les mêmes
   droits.

> ⚠️ N'approuvez une connexion que si vous venez de lancer `physalis login`
> vous-même. Quelqu'un qui vous envoie un lien d'approbation cherche à obtenir
> l'accès à votre compte.

Sans navigateur sur la machine (serveur, SSH), ajoutez `--no-browser` et
ouvrez l'adresse affichée depuis un autre appareil.

Vos sessions sont listées dans **Compte → Sécurité → Sessions CLI**, avec
l'appareil, l'adresse IP et la date d'expiration. Vous pouvez y couper une
session à tout moment. `physalis logout` coupe la session du terminal courant.

## Relier un projet : `.physalis.json`

À la racine de chaque projet, un fichier **sans aucun secret**, que vous
pouvez committer :

```json
{
  "url": "https://<votre-slug>.physalis.cloud",
  "project": "mon-projet",
  "env": "development"
}
```

La CLI le cherche dans le dossier courant **puis dans ses parents**, comme
git cherche `.git` : `physalis run` fonctionne depuis n'importe quel
sous-dossier du projet.

## Lancer vos commandes

Remplacez vos scripts par leur version `physalis run` :

```json
{
  "scripts": {
    "dev": "physalis run -- next dev",
    "db:migrate": "physalis run -- prisma migrate dev",
    "test": "physalis run -- vitest run"
  }
}
```

Avec Docker Compose, déclarez les variables sans valeur pour qu'elles viennent
du shell :

```yaml
services:
  app:
    environment:
      - DATABASE_URL
      - API_KEY
```

```bash
physalis run -- docker compose up
```

Si la récupération des secrets échoue (session expirée, droits insuffisants,
réseau), **la commande n'est pas lancée** : jamais d'application démarrée avec
des secrets manquants.

## Migrer un projet qui utilise un `.env`

1. Créez un environnement **development** dans le projet, avec des valeurs de
   développement uniquement. Ne mettez pas de secrets de production sur un
   poste de développement.
2. Importez votre `.env` depuis la page de l'environnement (**Importer**).
3. Remplacez le fichier par un `.env.example` qui ne contient **que les noms**
   des variables, et supprimez le `.env`.
4. Si un `.env` a déjà été committé, le supprimer ne suffit pas : cherchez-le
   dans l'historique (`git log --all -- .env`) et **renouvelez** les secrets
   qu'il contenait.

> ⚠️ Next.js et d'autres frameworks chargent encore `.env.local` et les
> fichiers `.env*` voisins s'ils existent, et leurs valeurs prennent alors le
> pas en silence. Supprimez-les tous.

> ⚠️ `physalis export > .env` recrée exactement le fichier en clair que
> `physalis run` évite. Réservez `export` aux cas qui l'exigent vraiment.

## Travailler hors ligne : `physalis pull`

`physalis run` a besoin du réseau. Pour coder sans connexion, `physalis pull`
écrit le `.env` du projet. C'est la **seule** commande qui écrit des secrets en
clair sur le disque, donc elle est encadrée :

- **environnements de développement uniquement** (`development`, `dev`,
  `local`, `test`, `testing`, `sandbox`) : la production et `staging` sont
  refusés, par la CLI et par Physalis ;
- **le fichier doit être ignoré par git** : sinon la CLI refuse de l'écrire,
  pour qu'il ne finisse pas committé ;
- il est écrit lisible par vous seul (`0600`), et chaque `pull` apparaît dans
  le journal d'audit comme un **export**.

```bash
physalis pull                 # .env à la racine du projet
physalis pull --output .env.local
```

Supprimez le fichier dès que vous n'en avez plus besoin.

## Travailler avec un agent IA (Claude Code)

Un agent de code a **sa propre session**, distincte de la vôtre.

```bash
physalis ai-rules            # règles de refus à coller dans .claude/settings.json
physalis login --ai          # à lancer depuis VOTRE terminal
```

Dans le navigateur, la demande est marquée **Agent IA**. Vous cochez les
projets et environnements que l'agent peut lire :

- **environnements de développement uniquement** : la production et `staging`
  ne sont même pas proposés ;
- vous ne pouvez ouvrir que ce que vous lisez vous-même, et vos droits restent
  appliqués : si vous perdez l'accès à un projet, l'agent le perd aussi ;
- l'agent lit **en lecture seule** et ne peut **jamais** télécharger de `.env` ;
- chaque lecture est tracée comme venant de l'agent, et la session (12 h) se
  coupe seule depuis **Compte → Sécurité → Sessions CLI**, qui affiche ce
  qu'elle peut lire.

Dans le shell de l'agent (Claude Code pose `CLAUDECODE=1`), la CLI **n'utilise
que la session IA**, jamais la vôtre.

Chez l'agent, `physalis run` **masque d'office** les valeurs dans la sortie :
un `printenv` accidentel n'affiche que `<masqué par Physalis>`. Vous pouvez
activer le même masquage pour vous avec `physalis run --mask` (la commande perd
alors ses couleurs et ses invites interactives).

> ⚠️ Un agent qui **transforme** une valeur avant de l'afficher (base64,
> découpage) la verrait quand même : aucun outil d'injection ne peut
> l'empêcher. Le masquage et les règles de refus évitent l'accident ; ce qui
> borne réellement l'agent, c'est son périmètre, choisi par vous et limité au
> développement.

## Agent SSH : se connecter sans clé sur le disque

Générez une clé dans **Coffre → Clés SSH** (ou importez la vôtre, puis
supprimez-la de `~/.ssh`), copiez sa clé publique sur vos serveurs ou sur
GitHub, puis :

```bash
physalis ssh-agent start
```

et, dans `~/.ssh/config`, pour les hôtes concernés :

```
Host github.com prod-*
  IdentityAgent ~/.physalis/agent.sock
```

`ssh`, `git push` et la signature de commits passent alors par Physalis :
**la clé privée ne quitte jamais Physalis**, c'est lui qui signe, et chaque
signature est journalisée (clé, appareil, compte SSH visé). Couper votre
session coupe l'agent à la connexion suivante.

> ⚠️ Sans connexion à Physalis, l'agent ne peut pas signer. Gardez toujours une
> clé de secours hors Physalis pour vos serveurs critiques.

## Plusieurs organisations, plusieurs instances

Les sessions sont rangées **par instance**. Si vous travaillez pour deux
organisations sur deux instances Physalis, connectez-vous une fois à chacune :
le champ `url` du `.physalis.json` choisit la bonne session.

## Dans la CI

En intégration continue, utilisez un **token machine** (`sv_…`), créé dans
l'interface et limité à un projet et un environnement, passé par la variable
`PHYSALIS_TOKEN`. Il prime sur la session stockée.

```bash
PHYSALIS_TOKEN=sv_… physalis run -p mon-projet -e production -- npm run build
```

Un token machine **n'expire pas** : il reste valide jusqu'à sa révocation dans
l'interface.

## Ce que la CLI protège, et ce qu'elle ne protège pas

- ✅ **Plus de fichier `.env` qui traîne** : rien à voler dans un dépôt, une
  sauvegarde du poste ou un portable perdu.
- ✅ **Accès révocable et tracé** : chaque lecture apparaît dans le journal
  d'audit, attribuée à votre compte et à la session CLI ; couper la session
  coupe l'accès à la requête suivante.
- ✅ **Mêmes droits que dans l'interface**, re-vérifiés à chaque lecture : un
  projet qui vous est masqué, ou une organisation que vous quittez, n'est plus
  lisible.
- ⚠️ **Les secrets injectés restent lisibles par votre utilisateur** pendant
  que la commande tourne (comme avec tout outil d'injection) : la CLI protège
  des fichiers oubliés, pas d'un logiciel malveillant actif sur votre poste.
- ✅ **Votre session est rangée dans le trousseau du système** (macOS ;
  Linux avec GNOME Keyring ou KWallet) : un agent IA qui lirait
  `~/.physalis/config.json` n'y trouve pas votre accès. Sans trousseau
  (serveur, WSL, conteneur, Windows pour l'instant), elle reste dans ce fichier,
  lisible par vous seul (`0600`), et `physalis login` vous le signale.
- ⚠️ Le trousseau protège de la lecture d'un fichier, pas d'un logiciel
  malveillant actif : sous Linux, un programme lancé par votre utilisateur peut
  l'interroger. La durée courte de la session et sa révocation limitent
  l'effet d'un vol.
