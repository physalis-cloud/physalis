---
title: Despliegue OIDC
order: 7
icon: RiCloudLine
summary: Despliega desde GitHub Actions, GitLab CI/CD o Bitbucket Pipelines sin secretos almacenados, mediante tokens OIDC firmados por el proveedor CI.
---

# Despliegue OIDC

Physalis reemplaza los antiguos flujos de "PAT almacenado + secretos CI" con
autenticación **OIDC** (OpenID Connect) basada en **tokens firmados por tu
proveedor CI** mismo.

Se admiten tres proveedores, todos con el **mismo** mecanismo:

- **GitHub Actions**
- **GitLab CI/CD** (gitlab.com o instancia self-hosted)
- **Bitbucket Pipelines**

**Resultado**: tu repositorio **no** tiene secretos vinculados a Physalis. La
prueba de identidad es el token OIDC que el runner CI emite automáticamente en
cada ejecución de job. Physalis lo verifica contra una **Política** antes de
devolver el bundle de despliegue (secretos + clave SSH + ruta).

## Diagrama de extremo a extremo

```
┌─────────────────┐      ┌──────────────────────────┐      ┌────────────┐
│  Runner CI      │ OIDC │ /api/deploy de Physalis   │ SSH  │   VPS      │
│  (GH/GL/BB)     │─────▶│ - verifica el token OIDC  │─────▶│ /srv/...   │
│                 │      │ - busca Conexión+Política  │      │            │
│                 │◀─────│ - devuelve el bundle       │      │            │
└─────────────────┘      └──────────────────────────┘      └────────────┘
        │                                                         ▲
        │   POST .env + docker-compose + docker login + restart   │
        └─────────────────────────────────────────────────────────┘
```

El runner CI, el VPS y el bundle SSH son **idénticos** sea cual sea el
proveedor. Solo cambian: el formato del identificador del repo, el claim usado
como 3ª dimensión de la Política, y la forma de solicitar el token.

## Los 4 objetos a configurar

Antes de activar un despliegue, necesitas **4 objetos** en Physalis:

1. Un **Servidor** a nivel de organización (clave SSH del VPS de destino)
2. Un **Entorno** vinculado a ese Servidor (con un `deployPath`)
3. Una **Conexión CI/CD** a nivel de organización (proveedor + issuer OIDC
   + credenciales opcionales de registry / redeploy)
4. Una **Política** que indique *"este repo, en esta rama, mediante este job,
   puede desplegar en el proyecto P, entorno E"*

## Tabla de referencia por proveedor

Ten esta tabla a mano: resume todo lo que difiere entre los tres proveedores.
El resto de la documentación remite a ella.

| Aspecto | GitHub | GitLab | Bitbucket |
|---|---|---|---|
| **Identificador del repo** (Política + proyecto) | `owner/repo` | `project_path` (p. ej. `acme/web`, `acme/team/web`) | `repositoryUuid` (`{11111111-…}`) |
| **3ª dimensión de la Política** | archivo de workflow (`deploy.yml`) | `environment: name:` del job | `deployment:` del step |
| **Claim de rama** | `ref` | `$CI_COMMIT_BRANCH` | `branchName` |
| **Audiencia (`aud`)** | obligatoria, debe coincidir con `OIDC_AUDIENCE` | obligatoria, debe coincidir con `OIDC_AUDIENCE` | no soportada → no exigida |
| **Issuer (en la conexión)** | vacío para github.com | vacío para gitlab.com; URL de instancia si self-hosted | **obligatorio**: URL OIDC del workspace |
| **Plantilla** | [deploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.modele.yml) | [deploy.gitlab-ci.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.gitlab-ci.modele.yml) | [deploy.bitbucket-pipelines.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.bitbucket-pipelines.modele.yml) |

> **A tener en cuenta**: solo la plantilla de GitHub incluye un **job `build`**
> que construye la imagen Docker e inyecta los `VITE_*` como `--build-arg`
> (ver [§ Vite build args](#vite-build-args-job-build)). Las plantillas de
> GitLab y Bitbucket son **deploy-only**: suponen que la imagen ya está
> construida y publicada en un registro, y simplemente la tiran + reinician.

## 1. Crear un Servidor

> Permisos: ADMIN / OWNER de la organización.

Página de la organización → pestaña **"Servers"** → **"+ New server"**.

| Campo           | Descripción                                                                |
|-----------------|----------------------------------------------------------------------------|
| **Name**        | Etiqueta interna (p. ej. "Hetzner prod VPS")                               |
| **IP**          | IPv4 o hostname que resuelve el VPS                                        |
| **SSH user**    | El usuario Linux en el VPS (normalmente `deploy` o `ci-deploy`)           |
| **Private key** | La clave privada SSH **completa** (PEM, OpenSSH) — pegada una sola vez     |

> ⚠️ La **clave privada nunca vuelve a ser legible** desde la UI tras la
> creación — solo se usa en tiempo de ejecución por `/api/deploy` para
> incluirla en el bundle. Si la pierdes, elimina el Servidor y crea uno nuevo
> con una clave nueva.

### Preparar el VPS en el lado SSH

En el VPS, crea el usuario de despliegue y autoriza la clave pública:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo -u deploy mkdir -p ~deploy/.ssh
sudo -u deploy bash -c 'echo "ssh-ed25519 AAAA... ci-deploy" >> ~/.ssh/authorized_keys'
sudo -u deploy chmod 600 ~deploy/.ssh/authorized_keys
```

El `deployPath` (por defecto `/srv/projets/<env>/<slug>`) debe existir y
pertenecer a `deploy:deploy`.

## 2. Vincular el Entorno al Servidor

En la página del proyecto → entorno → **Configuración** → campo **Server**.
Elige el servidor creado en el paso 1, ajusta el `deployPath` si es necesario
(en caso contrario se aplica la convención `defaultDeployPath`).

Consulta [Proyectos y entornos](projets-et-environnements) para más detalles.

## 3. Crear una Conexión CI/CD

El **proveedor**, el **issuer OIDC** y las **credenciales de infraestructura**
(token de redeploy, acceso a un registro privado) viven en una **Conexión
CI/CD** a nivel de organización — pestaña **"CI/CD"**. Cada proyecto selecciona
una en sus Ajustes.

Una conexión contiene:

| Campo                  | Función                                                             |
|------------------------|---------------------------------------------------------------------|
| **Proveedor**          | `github` \| `gitlab` \| `bitbucket`                                 |
| **Issuer OIDC**        | ver abajo — determina qué autoridad de firma se acepta              |
| **Token de redeploy**  | PAT para el botón "Redeploy" (dispatch) — *solo GitHub*            |
| **Registry — URL**     | por defecto `ghcr.io`                                                |
| **Registry — usuario/token** | para `docker login` en el VPS (registro privado)              |

### Definir el issuer según el proveedor

- **GitHub** — deja el issuer **vacío** (github.com es de confianza por
  defecto, issuer `https://token.actions.githubusercontent.com`).
- **GitLab** — déjalo **vacío** para gitlab.com. Para una instancia
  self-hosted, indica la URL de la instancia (p. ej. `https://gitlab.miempresa.com`).
- **Bitbucket** — **obligatorio**: la URL OIDC del workspace, visible en
  *Workspace settings → OpenID Connect*, de la forma
  `https://api.bitbucket.org/2.0/workspaces/<ws>/pipelines-config/identity/oidc`.

> **Por qué importa el issuer**: Physalis solo acepta un token si su emisor es
> conocido. Para instancias dinámicas (GitLab self-hosted, cada workspace de
> Bitbucket), el issuer debe estar **registrado explícitamente** en una
> conexión; de lo contrario el token se rechaza con `untrusted_issuer`.

Las credenciales del registry las devuelve `/api/deploy` bajo una clave
`registry` separada, distinta de `secrets[]` — **no** contaminan el `.env` del
contenedor; solo se usan para el `docker login` remoto. Todo está cifrado
(AES-256-GCM) y nunca se vuelve a mostrar.

> **Migración**: los antiguos `OrgSecret` reservados (`GITHUB_DISPATCH_TOKEN`,
> `REGISTRY_PAT/USER/URL`) se convierten automáticamente en una conexión
> "GitHub" durante la actualización — nada que volver a introducir.

Una vez creada la conexión, vincúlala al proyecto y define el **repo** en el
formato esperado por el proveedor (ver la tabla de referencia): proyecto →
**Ajustes** → **Conexión CI/CD** + campo **Repo**.

## 4. Crear una Política

Esta es la **regla de autorización**: quién (claims OIDC del job) puede
desplegar dónde (proyecto + entorno de Physalis).

En la página del proyecto → pestaña **"Policies"** → **"+ New Policy"**.

Campos (todos obligatorios, **coincidencia estricta, sin comodines**):

| Campo             | GitHub                | GitLab                  | Bitbucket               |
|-------------------|-----------------------|-------------------------|-------------------------|
| **Repo**          | `argo-web/physalis`   | `acme/web`              | `{11111111-…}`          |
| **Workflow / Entorno CI** | `deploy.yml`  | `production` (`environment: name:`) | `production` (`deployment:`) |
| **Branch**        | `main`                | `main`                  | `main`                  |
| **Environment**   | un entorno existente del proyecto | igual       | igual                   |

La columna **"Workflow / Entorno CI"** es la 3ª dimensión: es un archivo de
workflow en GitHub, pero el **nombre del entorno CI declarado por el job** en
GitLab (`environment: name:`) y Bitbucket (`deployment:`). El campo de la
Política debe coincidir **exactamente** con lo que declara el job.

> El botón **"Edit"** en una Política existente permite ajustar los campos (se
> detecta una colisión si ya existe otra tupla igual).

### Qué significa esto en la práctica

Cuando se ejecuta un job, el proveedor emite un token OIDC. Physalis verifica
su **firma** (el JWKS del proveedor), extrae `(repo, 3ª dimensión, rama)`,
busca una Política que coincida **exactamente**, y solo activa el despliegue
si el `(project, environment)` del cuerpo de la petición coincide.

Ejemplos de claims según el proveedor:

```json
// GitHub
{
  "repository": "argo-web/physalis",
  "workflow_ref": ".../.github/workflows/deploy.yml@refs/heads/main",
  "ref": "refs/heads/main",
  "aud": "vault.physalis.cloud"
}

// GitLab
{
  "project_path": "acme/web",
  "environment": "production",
  "ref": "main",
  "aud": "vault.physalis.cloud"
}

// Bitbucket
{
  "repositoryUuid": "{11111111-...}",
  "deploymentEnvironment": "production",
  "branchName": "main"
  // sin aud: Bitbucket no permite configurarlo
}
```

## 5. El workflow / pipeline plantilla

Copia la plantilla correspondiente a tu proveedor en tu repo y adapta las
variables al inicio del archivo:

| Proveedor | Plantilla a copiar | Ubicación en el repo |
|---|---|---|
| GitHub    | [deploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.modele.yml) | `.github/workflows/deploy.yml` |
| GitLab    | [deploy.gitlab-ci.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.gitlab-ci.modele.yml) | `.gitlab-ci.yml` |
| Bitbucket | [deploy.bitbucket-pipelines.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.bitbucket-pipelines.modele.yml) | `bitbucket-pipelines.yml` |

Las variables comunes a adaptar:

```
VAULT_URL       URL de Physalis (p. ej. https://vault.physalis.cloud)
VAULT_AUDIENCE  audiencia OIDC = OIDC_AUDIENCE del vault (GitHub/GitLab; ignorada en Bitbucket)
VAULT_PROJECT   slug del proyecto en Physalis
VAULT_ENV       entorno de destino en Physalis (production, staging, ...)
```

### Cómo solicita cada proveedor su token OIDC

- **GitHub** — `permissions: id-token: write` en el job, luego
  `core.getIDToken(audience)`:

  ```yaml
  permissions:
    id-token: write    # OBLIGATORIO para core.getIDToken()
    contents: read
    packages: write    # para hacer push a GHCR con GITHUB_TOKEN (job build)
  ```

- **GitLab** — palabra clave `id_tokens`, el `aud` debe coincidir con `OIDC_AUDIENCE`:

  ```yaml
  deploy:
    environment:
      name: production           # = 3ª dimensión de la Política
    id_tokens:
      VAULT_OIDC_TOKEN:
        aud: "$VAULT_AUDIENCE"
  ```

- **Bitbucket** — `oidc: true` en el step; el token llega en
  `$BITBUCKET_STEP_OIDC_TOKEN`. Sin audiencia que configurar:

  ```yaml
  - step:
      oidc: true
      deployment: production     # = 3ª dimensión de la Política
  ```

En los tres casos, el job llama después a `POST /api/deploy` con el token como
`Authorization: Bearer`, recibe el bundle, escribe `.env` (+ el opcional
`docker-compose.yml`) en el VPS via SCP, y luego `docker compose pull && up -d`.

## Vite build args (job `build`)

> Se aplica **solo a la plantilla de GitHub**. Las plantillas de GitLab y
> Bitbucket son deploy-only y suponen la imagen ya construida.

Cualquier secreto de entorno con el prefijo `VITE_` se recupera en el job
`build` y se pasa a `docker build` como `--build-arg`. En tu `Dockerfile` de
frontend, declara los `ARG` correspondientes:

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app

ARG VITE_VAULT_URL
ARG VITE_API_URL
ENV VITE_VAULT_URL=$VITE_VAULT_URL
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

> ⚠️ Vite **incrusta** los `VITE_*` en el bundle JS final → públicamente
> visible en el lado del navegador. Reserva estas variables para URLs públicas,
> feature flags, etc. Consulta [Secretos y categorías](secrets) para la
> convención completa.

## Construir y publicar la imagen (GitLab / Bitbucket)

Las plantillas de GitLab y Bitbucket son **deploy-only**: tiran una imagen ya
publicada. Eres tú quien debe **construirla y publicarla** en un registro antes
del job de deploy (un job de build que también puede obtener los `VITE_*`
mediante el mismo `/api/deploy`). Dos etapas distintas, **dos juegos de
credenciales**:

| Etapa | Dónde se ejecuta | Credenciales | Configurado en |
|---|---|---|---|
| **Build + push** | en el CI | acceso de **escritura** al registro | variables del CI (`$CI_REGISTRY_*` en GitLab, *repository variables* en Bitbucket) |
| **Pull** | en el VPS (`docker compose pull`) | acceso de **lectura** al registro | los campos **Registry** de la Conexión CI/CD |

**¿Qué registro?** Cualquiera:

- **GitLab** — lo más sencillo es el **Container Registry integrado**
  (`registry.gitlab.com/<grupo>/<proyecto>`), con `$CI_REGISTRY`,
  `$CI_REGISTRY_USER` y `$CI_JOB_TOKEN` ya disponibles en el job — el
  equivalente del combo GHCR + `GITHUB_TOKEN` de GitHub.
- **Bitbucket** — sin registro integrado: usa uno externo (Docker Hub
  `docker.io`, GHCR, AWS ECR…) y guarda las credenciales de push como
  *Repository variables*.

> ⚠️ Los campos **Registry** de la Conexión CI/CD (URL / usuario / token)
> **no** se usan para el build. Se devuelven en el bundle `/api/deploy` y se
> usan **en el VPS** para `docker login` + `docker compose pull`. Rellénalos
> **solo si la imagen está en un registro privado**; para una imagen pública,
> déjalos vacíos.

Build-push y pull pueden apuntar a la **misma** cuenta de registro — pero
siguen siendo dos configuraciones separadas (lado CI para publicar, lado
Conexión para que el VPS tire).

## 6. Primer despliegue

1. Haz push a `main` → el pipeline se inicia
2. *(GitHub)* Job `build`: obtiene los `VITE_*`, construye la imagen, hace push a GHCR
3. Job `deploy`: obtiene el bundle, escribe `.env` + `docker-compose.yml`
   en el VPS, ejecuta `docker compose up -d`
4. Comprueba el **registro de auditoría** de Physalis (página de la org) →
   verás `DEPLOY_AUTHORIZED` con los detalles (repo, 3ª dimensión, rama, entorno)

### En caso de fallo

El registro de auditoría de Physalis registra `DEPLOY_DENIED` con una razón diagnosticable:

| `reason`               | Causa probable                                                              |
|------------------------|----------------------------------------------------------------------------|
| `wrong_audience`       | `VAULT_AUDIENCE` del job ≠ `OIDC_AUDIENCE` del vault (GitHub/GitLab)        |
| `wrong_issuer`         | El issuer del token es desconocido / no soportado                          |
| `untrusted_issuer`     | Issuer dinámico (GitLab self-hosted / workspace de Bitbucket) no registrado en una conexión |
| `expired`              | El job tardó demasiado antes de llamar a `/api/deploy`                     |
| `policy_not_found`     | Ninguna Política coincide con `(repo, 3ª dimensión, rama)`                 |
| `policy_match_failed`  | Política encontrada pero `(project, env)` del cuerpo no coincide           |
| `no_server`            | El entorno existe pero no está vinculado a ningún Servidor                 |

> **Error frecuente (GitLab/Bitbucket)**: un `policy_not_found` suele deberse a
> un desajuste en la 3ª dimensión — el `environment: name:` (GitLab) o
> `deployment:` (Bitbucket) declarado en el job no coincide, carácter a
> carácter, con el campo "Entorno CI" de la Política.

## Botón "Redeploy" (workflow_dispatch)

> **Solo GitHub** por ahora.

Si deseas activar un redespliegue **desde la UI de Physalis** sin hacer push,
define el **token de redeploy** en la conexión CI/CD del proyecto (pestaña
"CI/CD" de la org — un PAT con alcance `repo` o un token de GitHub App) y el
botón **"Redeploy"** aparecerá en cada entorno.

Al hacer clic, Physalis llama a `POST /repos/{owner}/{repo}/actions/workflows/{wf}/dispatches`
que activa el workflow `redeploy.yml` en la rama del entorno. Este workflow
**no reconstruye imágenes** — vuelve a obtener el bundle `.env`, lo escribe en
el VPS y reinicia los contenedores con `docker compose up -d`. Esto es
suficiente para secretos cargados en tiempo de ejecución (variables de entorno,
claves pasadas mediante `.env`).

Copia [docs/redeploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/redeploy.modele.yml)
en `.github/workflows/redeploy.yml` de tu repositorio y adapta las variables al
inicio del archivo.

> **Secretos inyectados en tiempo de compilación** (p. ej. `VITE_*`) — Si tu
> secreto se pasa como `--build-arg` de Docker durante la construcción de la
> imagen, un simple redespliegue no es suficiente. Necesitas activar el
> workflow de compilación completo (`deploy.yml`). Physalis lo gestiona
> automáticamente mediante la opción **"Full build required"** en la
> configuración de rotación del secreto (consulta [Rotación de secretos](rotaciones)).

## Para ir más lejos

- [Secretos y categorías](secrets) — cómo tus `VITE_*` y otras variables de
  entorno llegan al bundle
- [Organizaciones y roles](organizaciones-y-roles) — quién puede gestionar
  Servidores, Conexiones CI/CD y Políticas
