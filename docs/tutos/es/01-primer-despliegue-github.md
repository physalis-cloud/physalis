---
title: Crear un proyecto, conectarlo a GitHub y desplegarlo
order: 1
icon: RiRocketLine
summary: De cero a una primera aplicación desplegada automáticamente desde GitHub, mediante OIDC — sin ningún secreto almacenado en tu repositorio.
level: principiante
duration: ~30 min
published: true
---

# Crear un proyecto, conectarlo a GitHub y desplegarlo

Esta guía te acompaña de principio a fin: crear tu primer **proyecto** Physalis,
guardar sus secretos, conectarlo a un repositorio **GitHub** y obtener un
**despliegue automático** en cada `git push` — todo sin pegar jamás un secreto
de Physalis en tu repositorio.

Aquí seguimos el camino más sencillo: **GitHub + un VPS por SSH**. Los demás
proveedores (GitLab, Bitbucket) siguen la misma lógica — consulta
[Despliegue OIDC](despliegue-oidc) una vez terminada esta guía.

## Lo que vas a lograr

- Un proyecto Physalis con un entorno `production` y sus secretos
- Un repositorio GitHub que se despliega solo en tu VPS en cada push
- Una cadena de autenticación **OIDC**: tu repositorio no contiene **ningún**
  secreto de Physalis

## Requisitos previos

- Una cuenta Physalis con el rol **ADMIN** u **OWNER** en tu organización (ver
  [Organizaciones y roles](organizaciones-y-roles)).
- Un **repositorio GitHub** con una aplicación dockerizada (un `Dockerfile` que
  compile y una imagen publicable en GHCR).
- Un **VPS** accesible por SSH, con Docker instalado.

### Notas

Algunos pasos se hacen **una sola vez**: una vez configurados, se reutilizan en
**todos tus proyectos**.

- **Paso 2 — Añadir tu servidor** (definido a nivel de organización)
- **Paso 3 — Crear la conexión CI/CD de GitHub** (definida a nivel de organización)

---

## 1. Crear el proyecto

En la navegación, ve a **Proyectos** → indica el **nombre** de tu proyecto en
«Crear un proyecto», luego haz clic en **«Crear»**.

![Formulario de creación del proyecto](/tutos/es/primer-despliegue-github-01.png)

> ⚠️ El **slug** (derivado del nombre) es **definitivo**: sirve de anclaje para
> las Policies de despliegue y para la ruta de despliegue. Cambiarlo más tarde
> rompe los workflows.

Tu app aparece en un bloque **«sin grupo»** por defecto.

![El proyecto creado, en el bloque «sin grupo»](/tutos/es/primer-despliegue-github-01.1.png)

## 2. Añadir tu servidor (VPS)

El servidor SSH se define **a nivel de organización**. Una vez configurado,
podrás usarlo para **todos tus proyectos y entornos** desplegados en ese
servidor.

**Menú Ajustes → pestaña Servidores → «+ Añadir»**

![Formulario para añadir un servidor](/tutos/es/primer-despliegue-github-02.png)

| Campo             | Valor                                       |
|-------------------|---------------------------------------------|
| **Nombre**        | ej. «VPS prod»                              |
| **IP**            | la IP o el hostname del VPS                  |
| **Usuario SSH**   | ej. `github-deploy`                         |
| **Clave privada** | la clave SSH completa (pegada una sola vez)|

> ⚠️ La clave privada **ya no se puede volver a leer** tras su creación. Si la
> pierdes, elimina el servidor y vuelve a crearlo con una clave nueva.

En el VPS, crea el usuario de despliegue y autoriza la clave pública:

```bash
sudo adduser --disabled-password --gecos "" github-deploy
sudo usermod -aG docker github-deploy
sudo -u github-deploy mkdir -p ~github-deploy/.ssh
sudo -u github-deploy bash -c 'echo "ssh-ed25519 AAAA... ci-deploy" >> ~/.ssh/authorized_keys'
sudo -u github-deploy chmod 600 ~github-deploy/.ssh/authorized_keys
```

> ⚠️ **Prepara la carpeta de destino en el VPS** antes del primer despliegue, de
> lo contrario fallará. Crea el `deployPath` (por defecto
> `/srv/projets/production/<slug>`) con un `.env` y un `docker-compose.yml`
> **vacíos**:
>
> ```bash
> sudo -u github-deploy mkdir -p /srv/projets/production/mi-app
> sudo -u github-deploy touch /srv/projets/production/mi-app/{.env,docker-compose.yml}
> ```
>
> Physalis reescribirá el contenido real en cada despliegue.

## 3. Crear la conexión CI/CD de GitHub

La conexión vive **a nivel de organización**: **Menú Ajustes → pestaña CI/CD →
«+ Nueva conexión»**.

- **Proveedor**: `github`
- **Issuer OIDC**: déjalo **vacío** (github.com es de confianza por defecto)
- **Token de redeploy**: un PAT *fine-grained* con **Contents: Read** +
  **Actions: Write** (lo usa el botón «Redesplegar» y para leer la documentación
  de tu proyecto)
- **Registry**: `ghcr.io` — rellena usuario/token **únicamente** si tu imagen
  está en un registro privado

![Creación de la conexión CI/CD de GitHub](/tutos/es/primer-despliegue-github-03.png)

## 4. Configurar los ajustes del entorno de producción

Haz clic en la **card de tu proyecto**.

Se crean tres entornos **por defecto**: `development`, `staging` y `production`.
Los gestionas en los **ajustes del proyecto** (icono de rueda dentada ⚙️).

En este ejemplo, hemos eliminado los entornos `development` y `staging` para
conservar solo `production`.

Abre el entorno `production` → **Settings**:

- **URL pública**: la URL donde la app será accesible (opcional)
- **Deploy path**: déjalo **vacío** → convención `/srv/projets/production/mi-app`
- **Server**: elige el servidor creado en el **paso 2**

![Ajustes del entorno de producción](/tutos/es/primer-despliegue-github-04.png)

### Vincular la conexión CI/CD al proyecto

Proyecto → **Ajustes** → **Conexión CI/CD**:

- selecciona la **conexión** creada en el paso 3, luego rellena el campo **Repo**
  con el formato `owner/repo` (ej. `mi-org/mi-app`);
- para el campo **Redeploy workflow**, deja el valor por defecto — te
  recomendamos conservar `redeploy.yml`;
- haz clic en **Guardar**.

![Conexión CI/CD vinculada al proyecto](/tutos/es/primer-despliegue-github-04.1.png)

## 5. Preparar el entorno de producción para el despliegue

### Añadir tus secretos

Sigue en el entorno `production` → pestaña **Secretos** → **«+ Añadir un
secreto»**. Introduce las variables `.env` de tu app (claves de API, URL de BD,
etc.), o **importa directamente tu `.env`** para un rellenado automático.

> 💡 Las variables con prefijo `VITE_` se inyectan **al compilar** la imagen (y
> por tanto son públicas en el navegador). Resérvalas para URLs públicas y
> feature flags. Detalle: [Secretos y categorías](secretos).

### Copiar tu docker-compose.yml

En la pestaña **Docker Compose**, pega el contenido de tu archivo y luego
**guarda**.

> 💡 **`.env` y `docker-compose.yml` se regeneran en cada despliegue** a partir
> de los valores guardados en Physalis (él es la fuente de verdad, no el VPS).
> Una vez que la Policy y el workflow **redeploy** estén listos (pasos 6-7),
> aparece un botón **«Redesplegar»** en el entorno: tras modificar un secreto o
> tu Docker Compose, un clic reinicia el contenedor con los nuevos valores **sin
> reconstruir la imagen** (unos quince segundos), mientras que un despliegue
> completo reconstruye y vuelve a publicar la imagen.

## 6. Crear la Policy de despliegue

Es la regla que autoriza a *este repo, en esta rama, mediante este workflow* a
desplegar en *este entorno*.

> Debes haber **seleccionado un proveedor CI/CD y rellenado un repo** (paso 4)
> para poder crear una Policy.

Proyecto → pestaña **Policies** → **«+ Añadir»**. Tres valores a rellenar:

| Campo                        | Valor                                          |
|------------------------------|------------------------------------------------|
| **Workflow** (archivo `.yml`)| `deploy.yml` (o `production.yml`)              |
| **Rama** (coincidencia exacta)| `main` (o `production`, el nombre de tu rama) |
| **Entorno destino**          | `production`                                    |

> **Coincidencia estricta, sin comodines**: estos valores deben corresponder
> exactamente a lo que declara el workflow.

Puedes crear **directamente la regla de redeploy**: los mismos valores que la
Policy de deploy, cambiando solo el nombre del workflow (`redeploy.yml`
recomendado).

![Creación de las Policies deploy y redeploy](/tutos/es/primer-despliegue-github-06.png)

## 7. Añadir los workflows de GitHub Actions

Copia las dos plantillas en tu repositorio, bajo `.github/workflows/`.

### El workflow de despliegue (`deploy.yml`)

Copia [deploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy.modele.yml)
en `.github/workflows/deploy.yml`, y adapta las variables al principio del archivo:

```
VAULT_URL       https://vault.physalis.cloud
VAULT_AUDIENCE  = el OIDC_AUDIENCE del vault
VAULT_PROJECT   mi-app          # el slug del proyecto
VAULT_ENV       production
```

> ⚠️ Modifica únicamente **`VAULT_PROJECT`** y **`VAULT_ENV`**. No toques
> `VAULT_URL` ni `VAULT_AUDIENCE`.

El workflow solicita un token OIDC a GitHub (`id-token: write`), lo envía a
`/api/deploy`, recibe el bundle (secretos + clave SSH + ruta), lo escribe en el
VPS y ejecuta `docker compose up -d`.

### El workflow de redespliegue (`redeploy.yml`)

Copia [redeploy.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/redeploy.modele.yml)
en `.github/workflows/redeploy.yml` (mismas variables al principio). Redespliega
**sin reconstruir la imagen** (re-fetch de secretos + `docker compose up -d`) y
alimenta el botón **«Redesplegar»** de la interfaz de Physalis. Se apoya en la
Policy `redeploy.yml` creada en el paso 6.

## 8. Primer despliegue

Haz un `git push` en `main` (o el nombre de la rama definida). El workflow arranca:

1. Job **build**: recupera las `VITE_*`, compila la imagen y la sube a GHCR
2. Job **deploy**: recupera el bundle, escribe `.env` + `docker-compose.yml` en
   el VPS, ejecuta `docker compose up -d`

## Comprobar que todo funciona

- En Physalis: página de la organización → **Audit log** → deberías ver un
  evento **`DEPLOY_AUTHORIZED`** con el repo, la rama y el entorno.
- Tu aplicación responde en su URL pública.

## En caso de problema

El audit log registra un **`DEPLOY_DENIED`** con un motivo:

- **`policy_not_found`** → la tupla (repo, workflow, rama) no coincide con
  ninguna Policy. Verifica la ortografía exacta en el **paso 6**.
- **`wrong_audience`** → el `VAULT_AUDIENCE` del workflow ≠ el `OIDC_AUDIENCE`
  del vault (no debe modificarse en la plantilla — ver paso 7).
- **`no_server`** → el entorno no está vinculado a ningún servidor. Rehaz el
  **paso 4** (campo **Server**).
- **`expired`** → el job tardó demasiado antes de llamar a `/api/deploy`
  (relánzalo).

Lista completa de motivos: [Despliegue OIDC](despliegue-oidc).

## ¿Y ahora?

- Tutorial siguiente: **Invitar a tu equipo y configurar el SSO** *(próximamente)*
- Para profundizar:
  - [Despliegue OIDC](despliegue-oidc) — GitLab, Bitbucket, build args de Vite,
    botón «Redesplegar»
  - [Secretos y categorías](secretos) — organizar tus variables
  - [Proyectos y entornos](proyectos-y-entornos) — servicios, cuentas de
    aplicación, miembros del proyecto
