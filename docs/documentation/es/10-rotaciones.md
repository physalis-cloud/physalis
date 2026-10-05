---
title: Rotación de secretos
order: 10
icon: RiRefreshLine
summary: Renueva automáticamente o mediante recordatorio asistido los secretos, claves, contraseñas de base de datos y cuentas de aplicación.
---

# Rotación de secretos

La **rotación** renueva periódicamente una credencial. El principio clave: se
**cambia la credencial en el origen** (en el sistema destino) y **luego** se
actualiza el valor en Physalis — no es un simple `upsert` en la bóveda.

Dos familias:

- **Automática** — un ejecutor cambia la credencial en el origen y luego reporta
  el nuevo valor (bases de datos, secretos internos, hooks de aplicación…).
- **Recordatorio asistido** — Physalis no puede cambiar la credencial por usted
  (contraseña humana, cuenta externa): le **notifica**, y usted **genera /
  introduce** el nuevo valor, que se guarda y versiona.

La rotación se aplica a varios **lugares donde viven los secretos**:

| Objeto | Dónde | Estrategias posibles |
|--------|-------|----------------------|
| **Secreto de entorno** | pestaña *Secretos* de un proyecto | Base de datos, JWT, Clave API, Webhook, Recordatorio |
| **Servicio** (Stripe, OVH…) | pestaña *Acceso* | Recordatorio asistido (sobre sus propias credenciales) |
| **Cuenta de aplicación** | pestaña *Acceso* | Recordatorio asistido, **Webhook** (hook del backend vinculado) o **Base de datos** (rol/usuario de una base gestionada tipo Supabase) |
| **Entrada de bóveda** de equipo / org | pestaña *Bóveda* | Recordatorio asistido |

## ¿Qué estrategia para qué caso?

| Quiere rotar… | Estrategia | Cómo |
|---------------|------------|------|
| una contraseña de **base de datos** (rol PG/MySQL) | **Base de datos** | automática, self-rotation |
| un **JWT / sesión / clave de cifrado** interno | **JWT Secret** | automática, generada por Physalis |
| una **clave del API Gateway** de Physalis | **Clave API** | automática |
| una **contraseña de cuenta** (admin/usuario) hasheada por la app | **Webhook** | la app la aplica vía un hook |
| una **cuenta de una base gestionada** (rol Postgres o usuario de Supabase Auth) | **Base de datos** | Physalis se conecta (admin del servicio vinculado) y la aplica |
| una **clave externa / token** (Stripe, Mailgun…) que ningún hook cubre | **Recordatorio** | usted la cambia en el origen y luego la guarda |

## Requisitos

La rotación es **opcional a nivel de organización** y reservada a los **planes de
pago**. Un **ADMIN** u **OWNER** de la org la activa en *Ajustes de la
organización → Avanzado*. Mientras está desactivada, no aparece ningún botón de
rotación y el cron ignora la organización.

También se suspende cuando un **proyecto está en pausa**.

## El botón «Rotación»

En todas partes (secreto, servicio, cuenta, entrada de bóveda), un **único botón
«Rotación»** abre un modal que reúne:

1. **La configuración**: activar + **intervalo** (en días) + la **estrategia**
   (para los secretos de entorno).
2. **La rotación inmediata**: para un recordatorio, una sección *generar /
   introducir* el nuevo valor; para una estrategia automática, un botón
   **«Forzar»**.

> El botón «Rotación» solo aparece en elementos que parecen una credencial (el
> nombre contiene `password`, `secret`, `token`, `key`, `jwt`…). Un `PORT`, una
> URL pública o un flag no lo tienen. Todas las estrategias siguen seleccionables
> en el modal, con un **valor por defecto inteligente** deducido del nombre (un
> `*_PASSWORD` → Base de datos, un `JWT_SECRET` → JWT, el resto → Recordatorio).

## Estrategias (secretos de entorno)

### Base de datos

**Self-rotation** de la contraseña de un rol PostgreSQL / MySQL: Physalis se
conecta **como** el usuario a rotar (con su contraseña actual, leída del `.env`
inyectado) y ejecuta `ALTER … PASSWORD` — **no se almacena ni usa ninguna
credencial admin**. Dos modos de ejecución:

- **Agente en el VPS** *(por defecto)* — para una **base interna a la red Docker**
  del proyecto: el sidecar **agente** (el mismo que para las copias) realiza la
  rotación **en local** y luego reporta el nuevo valor a Physalis. **No se
  necesita ninguna llamada externa.**
- **Directa** — para una **base gestionada accesible por TCP+SSL** (Supabase,
  RDS, Neon…): Physalis se conecta **directamente** (con la contraseña actual de
  la bóveda), ejecuta el `ALTER`, verifica la reconexión y luego confirma. **Sin
  dependencia externa** (sin N8n). PostgreSQL por ahora.

| Campo | Descripción |
|-------|-------------|
| `dbType` | `POSTGRESQL` o `MYSQL` |
| `dbHost` | host (nombre de servicio Docker en modo Agente, host público en Directa) |
| `dbPort` | puerto (`5432`, `3306`…) |
| `dbName` | nombre de la base |
| `dbUser` | usuario cuya contraseña se rota |

Tras confirmar el cambio en el origen, Physalis escribe el nuevo valor (con
snapshot del anterior en el versionado) y dispara un **redespliegue** para que la
aplicación recargue su `.env`.

### JWT Secret

Physalis **genera** él mismo un nuevo valor aleatorio (64 bytes), lo cifra,
archiva el anterior y luego dispara un redespliegue — **sin intervención
externa**. Ideal para `JWT_SECRET`, `NEXTAUTH_SECRET`, `SESSION_SECRET`, claves de
cifrado internas…

### Clave API Gateway

Genera una nueva clave en el **API Gateway** del proyecto, actualiza el secreto,
**revoca inmediatamente** la anterior y luego redespliega. El secreto debe estar
vinculado a una clave existente (selección API + clave). Solo para claves
**emitidas por el gateway de Physalis** (no una clave externa tipo Stripe).

### Webhook (hook del lado de la aplicación)

Para credenciales que **solo la aplicación sabe aplicar** — típicamente una
**contraseña de cuenta** hasheada en la base por la app (admin, usuario). Ver
la sección **Rotación vía hook (Webhook)** abajo.

### Recordatorio (asistido)

Physalis **no cambia nada en el origen**. Al vencer, envía una
**notificación** (centro de notificaciones, correo y webhook según los destinos
de alertas de la org) y la insignia de reloj del objeto pasa a naranja («A
rotar»). También se envía un aviso previo unos días antes (7 por defecto). Usted cambia la credencial en el
proveedor y luego, mediante la **rotación inmediata** del modal, **genera o
introduce** el nuevo valor: Physalis lo guarda y archiva el anterior. Adecuado
para claves externas, tokens, contraseñas compartidas.

## Rotación vía hook (Webhook)

La rotación de **cuentas admin/usuario** está bloqueada por el **hashing**: solo
la aplicación sabe hashear correctamente la contraseña (bcrypt, argon2, sal,
pepper…). Reproducir ese hashing en Physalis sería frágil y arriesgaría un
lockout. La solución: **un hook expuesto por la aplicación** que aplica la nueva
contraseña con su propio código.

**Principio**: Physalis (o el agente) **genera** una contraseña fuerte y la envía
al hook; la aplicación la **aplica** (hashea + actualiza su origen) y responde
**2xx**; entonces Physalis **confirma** el valor que generó.

### El contrato del hook

La aplicación debe exponer un endpoint que responda `2xx` una vez aplicada la
credencial:

```http
POST <url-del-hook>
Authorization: Bearer <token>        # opcional pero recomendado
Content-Type: application/json

# para un secreto de entorno:
{ "secretKey": "ADMIN_PASSWORD", "newValue": "<generado por Physalis>" }

# para una cuenta de aplicación:
{ "user": "admin@ejemplo.com", "newValue": "<generado por Physalis>" }
```

- **`Bearer <token>`**: un secreto compartido. Lo configura en Physalis y su hook
  lo verifica. Suele ser un **token proporcionado por el backend** (p. ej. un
  token de acceso de Directus) que usted pega; hay un botón *Generar* si prefiere
  un secreto dedicado.
- **Respuesta `2xx`** = aplicada → Physalis guarda el valor. Cualquier otro código
  = fallo → no se confirma nada (sin deriva).

### Modos (accesibilidad del hook)

- **Agente** — el hook es **interno** a la red Docker del proyecto
  (p. ej. `http://app:3000/internal/rotate`): lo llama el **agente**. Caso común
  de una app cliente self-hosted no expuesta.
- **Directa** — el hook es **accesible desde Physalis** (URL pública, plataforma
  de automatización): Physalis lo llama directamente.

### ¿Dónde se configura el hook?

- **Secreto de entorno** en estrategia Webhook: la URL/token/modo se ajustan **en
  el secreto**.
- **Cuenta de aplicación**: el hook se ajusta **en el servicio backend vinculado**
  (ver la sección **Cuentas de aplicación**). Así, varias cuentas del mismo
  backend comparten un solo hook.

### Ejemplo: Directus

Directus no tiene un endpoint con este formato; cree un **Flow**:

1. *Settings → Flows → Create Flow*. Disparador **Webhook (POST)**, **Response
   Body = «Data of last operation»** → la URL `…/flows/trigger/<id>` es su URL de
   hook.
2. *(auth)* operación **Condition**: `{{$trigger.headers.authorization}}` igual a
   `Bearer <su-token>`.
3. **Read Data** en `directus_users`, filtro `email == {{$trigger.body.user}}` →
   obtiene el `id`.
4. **Update Data** en `directus_users`, clave = ese `id`, payload
   `{ "password": "{{$trigger.body.newValue}}" }` (Directus hashea con argon2).

## Cuentas de aplicación

Una **Cuenta** (pestaña *Acceso*) contiene credenciales de login para la app del
proyecto. Puede **vincularla** a un **entorno** (frontend) o a un **servicio**
(backend): su URL se deriva del vínculo (fuente única, sincronizada), lo que
permite a la extensión del navegador proponerla en la página correcta.

En cuanto a rotación, una cuenta tiene tres estrategias posibles:

- **Recordatorio** (asistido) — por defecto.
- **Webhook** — **debe estar vinculada a un servicio backend cuyo hook esté
  configurado** (el hook vive en el servicio). «Forzar» ejecuta el hook (modo
  Directa) o lo delega al agente (modo Agente).
- **Base de datos** — para una cuenta de una **base gestionada** (Supabase…):
  debe estar vinculada a un **servicio «base de datos»** (ver abajo). Physalis se
  conecta con el **admin DB del servicio** y aplica la nueva contraseña. Dos
  **tipos de destino**:
  - **Rol de base de datos** (PostgreSQL) → `ALTER ROLE` ; el identificador de la
    cuenta = el nombre del rol.
  - **Usuario de Supabase Auth** (`auth.users`) → `UPDATE auth.users` (hash
    bcrypt) ; el identificador de la cuenta = el **email**.

## Servicios

Un **Servicio** (pestaña *Acceso*) tiene tres usos:

- **Servicio externo** (Stripe, OVH…): un usuario + una contraseña. Su rotación es
  un **recordatorio asistido** sobre sus propias credenciales.
- **Servicio backend**: a menudo **solo una URL** (usuario/contraseña
  **opcionales**), que porta el **hook de rotación de las cuentas** vinculadas. La
  sección «Hook de rotación de cuentas» del editor define la URL, el token y el
  modo (Agente / Directa).
- **Servicio base de datos gestionada** (Supabase, RDS…): marca **«Destino base
  de datos»** e indica `tipo / host / puerto / base` **más un usuario y una
  contraseña de conexión DB dedicados** (el admin, p. ej. `postgres` o
  `postgres.<ref>` vía el pooler de Supabase). ⚠️ Estas credenciales DB son
  **distintas** de las credenciales «de arriba» (que documentan el **login del
  dashboard**). Las cuentas vinculadas con la estrategia **Base de datos** rotan a
  través de esta conexión admin.

## Paso a paso: rotar la contraseña de una cuenta vía un hook

Caso típico: una cuenta **admin** de una app cliente, cuya contraseña la hashea en
la base la aplicación.

1. **Exponga un hook del lado de la app**: un endpoint que recibe
   `{ user, newValue }`, aplica la nueva contraseña (la hashea + actualiza la
   fila) y responde `2xx`. (Con Directus, un *Flow* — ver el ejemplo arriba.)
2. **Cree/edite el servicio backend** (pestaña *Acceso*): indique su **URL**,
   active **«Hook de rotación de cuentas»** e introduzca la **URL del hook**, el
   **token** y el **modo** (Agente si el hook es interno a la red Docker, Directa
   si es accesible desde Physalis). Las credenciales del servicio son opcionales.
3. **Vincule la cuenta al servicio**: en el editor de la cuenta, *Vinculado a →
   Servicio →* su backend.
4. **Active la rotación de la cuenta**: botón **Rotación** → active, intervalo,
   estrategia **Webhook**. Un indicador confirma que el servicio vinculado tiene
   un hook.
5. **Pruebe**: botón **«Forzar la rotación»**. En modo Directa, Physalis llama al
   hook de inmediato; si el hook responde `2xx`, el nuevo valor se guarda y
   versiona. En modo Agente, el agente lo ejecuta en su próximo ciclo.

> Verifique primero el mecanismo apuntando el hook a un endpoint de prueba que
> devuelva `200` (p. ej. webhook.site): confirma el ciclo
> *generar → POST → guardar* sin riesgo de lockout, y luego conecta el hook real.

## Bóvedas de equipo y de organización

Las entradas de bóveda se rotan por **recordatorio asistido** (generar/introducir
+ los **3 últimos** valores conservados para revertir). Las entradas de bóveda de
**proyecto** también aparecen en la pestaña Rotación de la org; las bóvedas de
**org** se gestionan desde la pestaña Bóveda.

## Rotación inmediata y «Forzar»

Desde el modal de un elemento, o desde la pestaña **Rotación** de la organización:

- **Recordatorio / asistido** → sección *Rotación inmediata*: genere o introduzca
  el nuevo valor. Una **confirmación bloqueante** recuerda que Physalis guarda el
  valor **pero no lo aplica en el origen** — cámbielo primero en el proveedor.
- **Estrategia automática** (Base de datos, JWT, Clave API, Webhook) → botón
  **«Forzar»**: dispara la rotación ahora, fuera de la planificación.

## Pestaña «Rotación» de la organización

Una vista general por proyecto de todas las rotaciones activas (secretos, claves
de email, servicios, cuentas, bóvedas de proyecto). Cada fila tiene un botón
**Rotación** (config + inmediata). Un **OWNER** de proyecto puede **pausar** todas
sus rotaciones (útil durante un mantenimiento):

```http
PATCH /api/projects/<slug>/rotation/pause
{ "paused": true }
```

## Planificación

Las rotaciones automáticas se ejecutan en una **hora valle** configurable (por
defecto **2 h UTC**): el breve redespliegue al final de una rotación cae así fuera
de las horas pico. El botón **«Forzar»** ignora esta ventana.

## Estado y seguimiento

| Campo | Descripción |
|-------|-------------|
| `rotationLastStatus` | `success`, `error` o vacío |
| `rotationLastAt` | fecha de la última rotación |
| `rotationNextAt` | próxima ejecución planificada |

Se envía una notificación por email al **ADMIN / OWNER** en el **primer fallo**
(sin spam después). Toda rotación queda registrada en el log de auditoría.

## Historial y reversión

- **Secretos de entorno**: el valor anterior se archiva en el **versionado**
  completo del secreto (ver *Secretos y categorías*).
- **Servicios, cuentas, entradas de bóveda** (sin versionado): se conservan los
  **3 últimos valores** para poder revertir.

## Resolución de problemas

| Síntoma | Causa probable / solución |
|---------|---------------------------|
| **«Forzar» devuelve `Fallo del hook: …`** | El hook respondió no-2xx o es inaccesible. El mensaje incluye el código y el inicio de la respuesta. Verifique la URL, el token (`Bearer`) y que el hook responda `2xx`. |
| **502 / la página se cuelga al forzar** | El hook no responde a tiempo. En modo **Directa**, la URL debe ser accesible **desde Physalis** (no solo desde su equipo). Verifique que su Flow devuelve una respuesta (Response Body configurado). |
| **«Vincule la cuenta a un servicio backend con un hook»** | La cuenta es Webhook pero su servicio vinculado no tiene hook configurado. Configure el hook **en el servicio** (pestaña Acceso). |
| **La cuenta no aparece en la extensión** | La extensión propone una credencial cuando la URL de la página coincide. Una cuenta aparece en la URL de su **destino vinculado** (entorno o servicio) — no en una URL sin vínculo. |
| **El botón «Rotación» no aparece en un secreto** | El nombre no se reconoce como credencial (`PORT`, URL, flag…). Es intencional. |
| **No se dispara ninguna rotación automática** | El cron se ejecuta en hora valle (por defecto 2 h UTC). Use **«Forzar»** para probar bajo demanda. Verifique también que la función esté activada en la org y el proyecto no en pausa. |

## Seguridad

- **Self-rotation sin credencial admin** (Base de datos/Agente): el agente cambia
  la contraseña **de la cuenta que usa**, nunca un superusuario.
- **El hashing se queda en la aplicación** (Webhook): Physalis nunca reproduce el
  esquema de hash de una app.
- **Atomicidad**: el nuevo valor solo se escribe **tras** confirmar el cambio en
  el origen → sin deriva entre el origen y la bóveda.
- **El cron nunca descifra** una credencial: la marca «pendiente» y delega en el
  ejecutor (agente, hook o recordatorio).
