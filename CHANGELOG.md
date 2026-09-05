# Journal des versions

Toutes les modifications notables de Physalis self-hosted. Le format suit
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le versionnage
[SemVer](https://semver.org/lang/fr/).

Les entrées marquées **⚠️ Rupture** demandent une action de votre part avant ou
pendant la mise à jour. Lisez-les avant de lancer `docker compose up -d`.

---

## Non publié

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

### Ajouté

- Des limites de ressources (CPU, mémoire, PID) sont fournies **en commentaire**
  dans le `docker-compose.yml`, à décommenter et ajuster à votre machine. Elles
  ne sont volontairement pas actives par défaut : une limite mémoire trop basse
  ferait tuer le conteneur par l'OOM killer sur une grosse instance, et une
  indisponibilité n'est pas un durcissement.
