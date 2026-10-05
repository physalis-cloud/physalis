---
title: CLI y el fin de los archivos .env
order: 17
icon: RiTerminalBoxLine
summary: Inyecta tus secretos en tus comandos de desarrollo, sin archivo .env en el disco.
---

# CLI y el fin de los archivos .env

La CLI `physalis` sustituye los archivos `.env` de tus proyectos. En lugar de
leer un archivo en claro, tu aplicación recibe sus secretos **al arrancar**,
en las variables de entorno de su proceso. No se escribe nada en el disco.

```bash
physalis run -- npm run dev
```

## Instalación

```bash
npm install -g physalis-cli
```

Node.js 18 o posterior. La CLI no tiene ninguna dependencia.

## Conectarse: una sesión para todos tus proyectos

```bash
physalis login --url https://<tu-slug>.physalis.cloud
```

1. La CLI muestra un **código** (por ejemplo `BCDF-GHJK`) y abre tu navegador
   en la página **Conectar un terminal**.
2. Comprueba que el código de la página es **el mismo** que el de tu
   terminal y haz clic en **Aprobar**.
3. La CLI recibe una sesión válida durante **12 horas**, que da acceso a
   **todos los proyectos** a los que tienes acceso en la interfaz, con los
   mismos derechos.

> ⚠️ Aprueba una conexión solo si acabas de lanzar `physalis login` tú mismo.
> Quien te envía un enlace de aprobación intenta acceder a tu cuenta.

En una máquina sin navegador (servidor, SSH), añade `--no-browser` y abre la
dirección mostrada desde otro dispositivo.

Tus sesiones aparecen en **Cuenta → Seguridad → Sesiones CLI**, con el
dispositivo, la dirección IP y la fecha de caducidad. Puedes cerrar una sesión
en cualquier momento. `physalis logout` cierra la sesión del terminal actual.

## Vincular un proyecto: `.physalis.json`

En la raíz de cada proyecto, un archivo **sin ningún secreto**, que puedes
incluir en git:

```json
{
  "url": "https://<tu-slug>.physalis.cloud",
  "project": "mi-proyecto",
  "env": "development"
}
```

La CLI lo busca en la carpeta actual **y después en sus carpetas padre**, como
git busca `.git`: `physalis run` funciona desde cualquier subcarpeta del
proyecto.

## Lanzar tus comandos

Sustituye tus scripts por su versión `physalis run`:

```json
{
  "scripts": {
    "dev": "physalis run -- next dev",
    "db:migrate": "physalis run -- prisma migrate dev",
    "test": "physalis run -- vitest run"
  }
}
```

Con Docker Compose, declara las variables sin valor para que vengan del shell:

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

Si la obtención de los secretos falla (sesión caducada, permisos
insuficientes, red), **el comando no se lanza**: una aplicación nunca arranca
con secretos ausentes.

## Migrar un proyecto que usa un `.env`

1. Crea un entorno **development** en el proyecto, solo con valores de
   desarrollo. No pongas secretos de producción en un equipo de desarrollo.
2. Importa tu `.env` desde la página del entorno (**Importar**).
3. Sustituye el archivo por un `.env.example` que contenga **solo los
   nombres** de las variables y borra el `.env`.
4. Si un `.env` llegó a incluirse en git, borrarlo no basta: búscalo en el
   historial (`git log --all -- .env`) y **renueva** los secretos que
   contenía.

> ⚠️ Next.js y otros frameworks siguen cargando `.env.local` y los archivos
> `.env*` vecinos si existen, y sus valores tienen entonces prioridad sin
> avisar. Bórralos todos.

> ⚠️ `physalis export > .env` vuelve a crear justo el archivo en claro que
> `physalis run` evita. Reserva `export` para los casos que de verdad lo
> exijan.

## Trabajar sin conexión: `physalis pull`

`physalis run` necesita la red. Para programar sin conexión, `physalis pull`
escribe el `.env` del proyecto. Es el **único** comando que escribe secretos en
claro en el disco, así que está acotado:

- **solo entornos de desarrollo** (`development`, `dev`, `local`, `test`,
  `testing`, `sandbox`): producción y `staging` se rechazan, en la CLI y en
  Physalis;
- **el archivo debe estar ignorado por git**: si no, la CLI se niega a
  escribirlo, para que no acabe en un commit;
- se escribe legible solo por ti (`0600`), y cada `pull` aparece en el
  registro de auditoría como una **exportación**.

```bash
physalis pull                 # .env en la raíz del proyecto
physalis pull --output .env.local
```

Borra el archivo en cuanto ya no lo necesites.

## Trabajar con un agente IA (Claude Code)

Un agente de código tiene **su propia sesión**, distinta de la tuya.

```bash
physalis ai-rules            # reglas de denegación para .claude/settings.json
physalis login --ai          # lánzalo desde TU terminal
```

En el navegador, la solicitud aparece como **Agente IA**. Marcas los proyectos
y entornos que el agente puede leer:

- **solo entornos de desarrollo**: producción y `staging` ni siquiera se
  proponen;
- solo puedes abrir lo que tú mismo lees, y tus permisos siguen aplicándose:
  si pierdes el acceso a un proyecto, el agente también;
- el agente lee **en solo lectura** y **nunca** puede descargar un `.env`;
- cada lectura queda registrada como hecha por el agente, y la sesión (12 h) se
  cierra por separado desde **Cuenta → Seguridad → Sesiones CLI**, que muestra
  lo que puede leer.

En el shell del agente (Claude Code define `CLAUDECODE=1`), la CLI **solo usa
la sesión IA**, nunca la tuya.

Para el agente, `physalis run` **oculta** los valores en la salida por
defecto: un `printenv` accidental solo muestra `<masqué par Physalis>`. Puedes
activar el mismo enmascaramiento para ti con `physalis run --mask` (el comando
pierde entonces sus colores y sus preguntas interactivas).

> ⚠️ Un agente que **transforma** un valor antes de mostrarlo (base64,
> troceado) lo seguiría viendo: ninguna herramienta de inyección puede
> impedirlo. El enmascaramiento y las reglas de denegación evitan accidentes;
> lo que realmente limita al agente es su perímetro, elegido por ti y limitado
> al desarrollo.

## Agente SSH: conectarse sin clave en el disco

Genera una clave en **Cofre → Claves SSH** (o importa la tuya y bórrala de
`~/.ssh`), copia su clave pública en tus servidores o en GitHub, y después:

```bash
physalis ssh-agent start
```

y, en `~/.ssh/config`, para los hosts afectados:

```
Host github.com prod-*
  IdentityAgent ~/.physalis/agent.sock
```

`ssh`, `git push` y la firma de commits pasan entonces por Physalis: **la clave
privada nunca sale de Physalis**, es él quien firma, y cada firma queda
registrada (clave, dispositivo, cuenta SSH de destino). Cerrar tu sesión corta
el agente en la siguiente conexión.

> ⚠️ Sin conexión con Physalis, el agente no puede firmar. Guarda siempre una
> clave de respaldo fuera de Physalis para tus servidores críticos.

## Varias organizaciones, varias instancias

Las sesiones se guardan **por instancia**. Si trabajas para dos
organizaciones en dos instancias de Physalis, conéctate una vez a cada una: el
campo `url` del `.physalis.json` elige la sesión correcta.

## En la CI

En integración continua, usa un **token de máquina** (`sv_…`), creado en la
interfaz y limitado a un proyecto y un entorno, pasado por la variable
`PHYSALIS_TOKEN`. Tiene prioridad sobre la sesión guardada.

```bash
PHYSALIS_TOKEN=sv_… physalis run -p mi-proyecto -e production -- npm run build
```

Un token de máquina **no caduca**: sigue siendo válido hasta que se revoca en
la interfaz.

## Lo que la CLI protege, y lo que no

- ✅ **Se acabaron los `.env` olvidados**: nada que robar en un repositorio,
  una copia de seguridad del equipo o un portátil perdido.
- ✅ **Acceso revocable y trazado**: cada lectura aparece en el registro de
  auditoría, atribuida a tu cuenta y a la sesión CLI; cerrar la sesión corta
  el acceso en la siguiente petición.
- ✅ **Los mismos permisos que en la interfaz**, comprobados en cada lectura:
  un proyecto que se te oculta, o una organización que abandonas, deja de ser
  legible.
- ⚠️ **Los secretos inyectados siguen siendo legibles por tu usuario**
  mientras el comando se ejecuta (como con cualquier herramienta de
  inyección): la CLI protege de los archivos olvidados, no de un software
  malicioso activo en tu equipo.
- ✅ **Tu sesión se guarda en el llavero del sistema** (macOS; Linux con GNOME
  Keyring o KWallet): un agente IA que leyera `~/.physalis/config.json` no
  encuentra ahí tu acceso. Sin llavero (servidor, WSL, contenedor, Windows por
  ahora), se queda en ese archivo, legible solo por ti (`0600`), y
  `physalis login` te lo indica.
- ⚠️ El llavero protege de la lectura de un archivo, no de un software
  malicioso activo: en Linux, un programa lanzado por tu usuario puede
  consultarlo. La corta duración de la sesión y su revocación limitan el
  efecto de un robo.
