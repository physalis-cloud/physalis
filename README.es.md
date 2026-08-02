# Physalis

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[Français](README.md) · [English](README.en.md) · **Español**

> **Versión 1.3.3** · Versión alojada y gestionada: [physalis.cloud](https://physalis.cloud) · Errores y comentarios: [abrir una issue](https://github.com/physalis-cloud/physalis/issues)

---

Gestor de secretos autoalojado (Next.js + Postgres + AES-256-GCM) que centraliza
las variables de entorno, claves SSH y credenciales de todos tus proyectos, con
autenticación OIDC (GitHub, GitLab, Bitbucket) para los flujos de despliegue.

Multiorganización, registro de auditoría, servicios y cuentas cifrados,
docker-compose servido por entorno, redespliegue CI integrado, intercambio de
claves híbrido post-cuántico (ECDH P-256 + ML-KEM-768) para las solicitudes de
secretos externas.

**Physalis** es un gestor de secretos autoalojado, pensado para centralizar
todas las variables de entorno de una agencia web en sus propios servidores, sin
depender de un servicio en la nube de terceros.

---

## El problema que resuelve

En una agencia que gestiona varios proyectos en varios VPS, las variables de
entorno (contraseñas de bases de datos, claves de API, tokens) acaban dispersas
en archivos `.env` de cada servidor, en GitHub Secrets, en notas personales.
Cambiar una variable obliga a conectarse manualmente a cada servidor. Cuando una
persona deja el equipo, resulta imposible saber a qué tenía acceso.

---

## Qué hace Physalis

### Centralización cifrada

Todas las variables se almacenan en una base de datos PostgreSQL, cifradas con
AES-256-GCM antes de escribirse. Incluso con acceso directo a la base de datos,
los valores son ilegibles sin la clave de cifrado, que solo vive en las
variables de entorno del servidor.

### Multiorganización y control de acceso

La aplicación admite varias organizaciones aisladas, cada una con sus propios
proyectos y miembros. Los permisos son granulares en tres niveles —
organización, proyecto, entorno — con roles distintos (lector, editor,
propietario). Invitaciones por correo con enlace firmado y revocación automática
de los accesos cuando alguien deja el equipo.

### Dos formas de consumir los secretos

**Para personas** — una interfaz web protegida por contraseña y, opcionalmente,
por doble autenticación TOTP. Los valores de los secretos nunca se muestran en
bloque: cada revelación es una acción explícita, de una en una, registrada en el
registro de auditoría.

**Para máquinas** — autenticación OIDC. En el momento del despliegue, el flujo
de trabajo obtiene un token firmado por el proveedor de CI (sin ningún secreto
almacenado en GitHub Secrets) y lo presenta a Physalis. La bóveda verifica la
firma criptográficamente, comprueba que el repositorio, el flujo de trabajo y la
rama coinciden exactamente con una regla autorizada, y devuelve en una sola
petición todo el paquete de despliegue: variables de entorno descifradas, clave
SSH del servidor de destino, ruta de despliegue, docker-compose y credenciales
del registro Docker.

### Criptografía resistente a la computación cuántica

Los secretos se cifran en reposo con **AES-256-GCM**, un cifrado simétrico ya
considerado resistente a los ordenadores cuánticos: el algoritmo de Grover solo
reduce una clave de 256 bits a 128 bits de seguridad efectiva.

El intercambio de claves de las **solicitudes de secretos externas** — el único
punto donde la criptografía asimétrica protege un valor y, por tanto, el único
realmente expuesto a un futuro ordenador cuántico — es **híbrido**: ECDH P-256
**y** ML-KEM-768 (FIPS 203), combinados mediante HKDF-SHA256 con vinculación de
la transcripción. Romper la clave derivada exige romper ambos. Las solicitudes
creadas antes de este cambio (solo ECDH) siguen siendo descifrables.
Implementación: [lib/hybrid-kem.ts](lib/hybrid-kem.ts) y [lib/pqc.ts](lib/pqc.ts).

### Trazabilidad completa

Cada acción — leer un secreto, modificarlo, iniciar sesión, desplegar, invitar —
queda registrada en un registro de auditoría persistente con el actor, la IP y
la marca de tiempo. Exportable a CSV y consultable por proyecto o por
organización.

---

## Qué cambia en la práctica

| Antes | Después |
|---|---|
| Un archivo `.env` por proyecto y por servidor | Una única interfaz para todos los secretos de la agencia |
| Claves SSH y tokens en GitHub Secrets | Ninguna clave ni token en GitHub |
| Ninguna trazabilidad | Cada acceso registrado con actor, IP y marca de tiempo |
| Imposible saber quién accede a qué | Revocación inmediata cuando alguien se marcha |
| Despliegues manuales o semiautomatizados | Despliegues totalmente automatizados, sin intervención humana |


📖 **Documentación técnica** : [docs/physalis.md](docs/physalis.md) (en francés)
📚 **Documentación de usuario** : [docs/documentation/es/](docs/documentation/es/) (también en `fr` / `en`)
🔒 **Modelo de seguridad** : [docs/security.md](docs/security.md) (en francés)

---

## Inicio rápido

### 1. Local — stack completo (Docker)

```bash
cp .env.example .env
# Rellenar los valores vacíos: ENCRYPTION_KEY, AUTH_SECRET, NEXTAUTH_SECRET,
#   DB_PASSWORD, ADMIN_PASSWORD (ADMIN_EMAIL tiene un valor por defecto).
#   ENCRYPTION_KEY = openssl rand -hex 32 ; los secretos = openssl rand -base64 32.
docker compose up -d --build
```

→ http://localhost:3001 (puerto por defecto; el 3000 suele estar ocupado —
ajustable con `PORT` en `.env`, alineando `NEXTAUTH_URL` con el mismo puerto).

El primer arranque aplica las migraciones de Prisma y crea la cuenta de
administración definida por `ADMIN_EMAIL` / `ADMIN_PASSWORD`
([scripts/bootstrap-admin.mjs](scripts/bootstrap-admin.mjs)).

### 2. Local — desarrollo nativo (hot reload)

```bash
docker compose -f docker-compose.dev.yml up -d   # solo Postgres (puerto 5434)
npm install
npx prisma migrate dev
npm run bootstrap-admin
npm run dev                                       # http://localhost:3000
```

### 3. Producción (VPS detrás de un proxy inverso)

Flujo típico: test → build/push al registro → despliegue SSH + health check.
Plantilla lista para copiar: [docs/deploy.modele.yml](docs/deploy.modele.yml).

Consulta [docs/physalis.md §9](docs/physalis.md) para la instalación completa
(carpeta de despliegue, clave SSH dedicada al flujo de trabajo, contenido del
`.env`, proxy inverso y TLS).

---

## Consumir los secretos desde un proyecto

Tres modos de acceso, del más moderno al más antiguo:

### Modo 1 — OIDC (recomendado)

El runner de CI se autentica con un JWT OIDC firmado por el proveedor (GitHub
Actions, GitLab CI, Bitbucket Pipelines). La bóveda valida el claim contra una
`Policy` estricta — `(repo, workflow, branch) → (project, env)` — y devuelve un
paquete completo.

| Endpoint | Auth | Respuesta |
|---|---|---|
| `POST /api/deploy` | Bearer JWT OIDC | `{ serverIp, serverUser, sshKey, deployPath, secrets, dockerCompose, registry }` |

No se consume ningún secreto de CI. La clave SSH y las credenciales del registro
viven cifradas en la bóveda. Plantillas listas para copiar:
[docs/deploy.modele.yml](docs/deploy.modele.yml) (despliegue con rebuild),
[docs/redeploy.modele.yml](docs/redeploy.modele.yml) (redespliegue sin rebuild),
[docs/deploy.gitlab-ci.modele.yml](docs/deploy.gitlab-ci.modele.yml) y
[docs/deploy.bitbucket-pipelines.modele.yml](docs/deploy.bitbucket-pipelines.modele.yml).

### Modo 2 — token de máquina Bearer (alternativa sin CI OIDC)

Para contextos que no pueden obtener un token OIDC (cron en un VPS, otra CI,
scripts manuales):

| Endpoint | Auth | Respuesta |
|---|---|---|
| `GET /api/secrets/[slug]/[env]` | `Bearer sv_<hex>` | `{ secrets: { KEY: value, … } }` |
| `GET /api/compose/[slug]/[env]` | `Bearer sv_<hex>` | contenido bruto del `docker-compose.yml` configurado |

El token está limitado a un par `(proyecto, entorno)`; cualquier otra
combinación devuelve 403. Se gestiona desde la página del proyecto → pestaña del
entorno → «Machine tokens».

### Modo 3 — script local

[scripts/inject-secrets.sh](scripts/inject-secrets.sh) — un wrapper de bash
sobre el endpoint Bearer, útil cuando la misma lógica se invoca desde varios
scripts en el mismo VPS.

---

## Generar los secretos necesarios al inicializar

```bash
openssl rand -hex 32        # ENCRYPTION_KEY
openssl rand -base64 32     # AUTH_SECRET / NEXTAUTH_SECRET
```

> ⚠️ `ENCRYPTION_KEY`: **nunca en la base de datos ni en el código**, solo en el
> entorno del contenedor. Perderla de forma definitiva significa que los
> secretos son irrecuperables, incluso con un volcado completo de la base de
> datos. Guarda una copia en un gestor de contraseñas compartido (escrow).

---

## Copias de seguridad de tu instancia

**Este repositorio no proporciona copias de seguridad, ni replicación, ni
conmutación por error** — ningún script, ningún cron, ningún mecanismo de
bascula. La copia de seguridad de tu instancia es tu infraestructura y, por
tanto, tu responsabilidad. Como mínimo:

- un **volcado periódico** de la base de datos PostgreSQL (`pg_dump`), cifrado y
  almacenado fuera del servidor que lo ha producido;
- una **copia de `ENCRYPTION_KEY`** en escrow (véase la advertencia anterior):
  un volcado sin la clave es irrecuperable, y la clave sin volcado no vale nada;
- una **prueba de restauración** periódica; de lo contrario no tienes una copia
  de seguridad, tienes archivos.

La oferta alojada [physalis.cloud](https://physalis.cloud) opera su propia
infraestructura de resiliencia (replicación y copias cifradas gestionadas); nada
de eso está incluido ni orquestado por este repositorio.

---

## Stack

Next.js 15 (App Router) · TypeScript · Prisma 6 + PostgreSQL 16 ·
NextAuth v5 (Credentials, JWT) · bcryptjs (salt 12) · AES-256-GCM ·
híbrido ECDH P-256 + ML-KEM-768 (`@noble/post-quantum`) ·
jose 6 (OIDC JWKS) · 2FA TOTP (otplib) · Tailwind 3 · Mailgun (correo
transaccional) · Docker multi-stage (node:22-alpine).

## Tests

```bash
npm test               # unitarios (crypto, tokens, rate-limit, validación, totp,
                       #            oidc, categorías, plugin-token)
npm run test:integ     # integración (bearer-auth, RBAC, cifrado en BD, cabeceras,
                       #              rate-limit, 2FA, servidores, policies, plugin)
```

Consulta [docs/physalis.md §12](docs/physalis.md) para el detalle.
