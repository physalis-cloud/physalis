---
title: Protege tu organización: rotación automática + copias cifradas
order: 3
icon: RiShieldCheckLine
summary: Pasa a modo producción: renueva automáticamente un secreto y respalda tus bases de datos cifradas en tu propio servidor — con restauración en un clic.
level: avanzado
duration: ~20 min
published: true
---

# Protege tu organización: rotación automática + copias cifradas

Esta guía lleva tu organización a un **modo producción**: primero la **rotación
automática** de un secreto (se acabaron las credenciales que se arrastran durante
años), luego las **copias cifradas** de tus bases de datos hacia tu propio
servidor, con restauración orquestada.

## Lo que vas a lograr

- La rotación **activada** para tu organización, y un primer secreto que se
  renueva solo
- Las bases de un proyecto **respaldadas, cifradas**, hacia tu VPS de destino
- Una **restauración probada** (en una base nueva, sin tocar producción)

## Requisitos

- Un **plan de pago**: rotación y copias son funciones avanzadas.
- El rol **ADMIN** u **OWNER** de la organización.
- Un **proyecto ya desplegado** (ver [Crear un proyecto…](tuto:primer-despliegue-github))
  con al menos una base de datos.
- Un **VPS de destino** (entre tus servidores) para recibir las copias.

### Notas

Algunos ajustes son **globales** y se hacen **una sola vez**:

- **Paso 1 — Activar la rotación** (nivel organización)
- **Paso 4 — Definir el destino de las copias** (nivel cliente, reutilizado por
  todos los proyectos)

---

## 1. Activar la rotación para la organización

La rotación es **opt-in** a nivel de organización.

Abre el menú **Configuración → pestaña Info** y activa la rotación. Mientras esté
desactivada, no aparece ningún botón de rotación.

![Activar la rotación en la configuración de la organización](/tutos/es/proteger-org-rotacion-backups-01.png)

> La rotación se suspende automáticamente cuando un proyecto se **pausa**.

## 2. Configurar la rotación de un secreto

En un secreto de entorno (pestaña **Secretos** de un proyecto), haz clic en
**Rotación**. El modal reúne la **configuración** (activar + intervalo en días +
estrategia) y la **rotación inmediata**.

Elige la **estrategia** según el secreto:

| Secreto | Estrategia | Lo que hace Physalis |
|---------|------------|----------------------|
| `JWT_SECRET`, `SESSION_SECRET`… | **JWT Secret** | genera un nuevo valor, redespliega — 100 % automático |
| contraseña de **base** (rol PG/MySQL) | **Base de datos** | self-rotation `ALTER … PASSWORD`, sin credencial admin |
| clave emitida por el **API Gateway** de Physalis | **Clave API** | nueva clave + revocación de la anterior |
| clave de terceros (Stripe, Mailgun…) | **Recordatorio** | te avisa; cambias en la fuente y luego guardas |

Physalis preselecciona un **valor por defecto inteligente** según el nombre del
secreto (un `*_PASSWORD` → **Base de datos**, un `JWT_SECRET` → **JWT Secret**, el
resto → **Recordatorio**).

### Nuestro ejemplo: rotar la contraseña de la base

Tomamos el caso más **completo** — y el más útil en producción. En el secreto de
la contraseña (ej. `DATABASE_PASSWORD`), abre **Rotación**, actívala, ajusta el
**intervalo** (en días) y elige la estrategia **Base de datos**. Rellena el
**destino**:

| Campo | Valor |
|-------|-------|
| `dbType` | `POSTGRESQL` o `MYSQL` |
| `dbHost` | **nombre de servicio Docker** de la base (ej. `db`, `postgres`) — permanece en la red interna |
| `dbPort` | `5432`, `3306`… |
| `dbName` | nombre de la base |
| `dbUser` | el usuario **cuya contraseña se rota** |

Deja el **modo de ejecución** en **Agente en el VPS** *(el valor por defecto)* —
es el que usamos aquí, y ahí interviene el **agente**:

- Physalis inyecta en el despliegue un **contenedor compañero (el agente)** junto
  a tu aplicación. Es él quien, **localmente en tu servidor**, se conecta a la
  base por su **nombre de servicio Docker** (nunca expuesta al exterior), ejecuta
  el cambio de contraseña y luego **reporta** el nuevo valor a Physalis.
- **Ningún puerto de base que abrir al exterior**, y es el **mismo agente** que
  gestiona las copias (paso 5).

![Modal de rotación en estrategia Base de datos, modo Agente](/tutos/es/proteger-org-rotacion-backups-02.png)

> **¿Base gestionada?** Si tu base es un servicio **gestionado accesible por
> TCP+SSL** (Supabase, RDS, Neon…), elige más bien el modo **Directo**: Physalis
> se conecta él mismo, sin agente. El resto del formulario es idéntico.

> **Self-rotation, sin cuenta admin.** El ejecutor se conecta **como el usuario a
> rotar**, con su contraseña actual (leída del `.env` inyectado), y ejecuta
> `ALTER … PASSWORD` sobre sí mismo — no se almacena ni usa ningún superusuario.
> El nuevo valor solo se escribe **tras** confirmar el cambio en la fuente.

**La casilla «Build completo requerido».** Déjala **desmarcada** para una
contraseña de base: es un secreto *runtime*, basta un redespliegue simple.
Márcala solo si el valor se fija **en el build** (`VITE_*`, `NEXT_PUBLIC_*`,
compilados en el bundle).

### Desplegar el agente — una sola vez por proyecto

El modo Agente se apoya en un **agente**: un pequeño **contenedor compañero** que
Physalis ejecuta **junto a tu aplicación**, en tu servidor. Es él quien ejecuta
la rotación **localmente** — y es **el mismo agente** que hará las **copias**
(paso 5). Instalarlo una vez cubre **las dos funciones**.

Una sola acción para instalarlo: tras guardar la rotación, haz clic **una vez**
en **Redeploy** (botón del proyecto). Physalis añade el servicio del agente al
`docker-compose` servido, y arranca en el `docker compose up` habitual — **nada
que hacer de tu lado** en el servidor.

- **Basta un Redeploy simple** (sin necesidad de rebuild): el compose servido ya
  contiene el agente.
- **Una sola vez por proyecto**: una vez instalado, el agente gestiona luego
  **todas** las rotaciones *y* las copias del proyecto; cada rotación lanza su
  propio redespliegue.
- **A repetir en cada proyecto** donde actives la rotación o las copias: el
  agente se **crea por proyecto** (un contenedor agente = un proyecto).

> Redeploy se apoya en la **conexión CI/CD** (`workflow_dispatch`) configurada en
> el [primer despliegue](tuto:primer-despliegue-github). Sin ella, ningún
> redespliegue (simple o completo) puede lanzarse.

## 3. Forzar una rotación para probar

Para **validar** la rotación, no esperaremos al vencimiento: la **forzamos**. Dos
lugares permiten disparar la rotación de una contraseña.

**Desde el proyecto**, en el secreto mismo: reabre el modal **Rotación** y usa
**«Forzar»** (sección *rotación inmediata*).

![Botón «Forzar» en el modal de rotación del secreto](/tutos/es/proteger-org-rotacion-backups-03.png)

**Desde Configuración → pestaña Rotación**, donde encuentras **todas las
rotaciones activadas de la organización, clasificadas por proyecto**: cada fila
tiene su propio botón para forzar la rotación.

![Pestaña Rotación de la organización, rotaciones clasificadas por proyecto](/tutos/es/proteger-org-rotacion-backups-04.png)

En ambos casos, el valor se cambia en la fuente según la estrategia (en modo
**Agente**, el agente aplica el cambio en su próximo paso, en menos de un
minuto), el valor anterior se archiva en el versionado, y luego un
**redespliegue** recarga el `.env`.

> Se envía una notificación al ADMIN/OWNER solo en el **primer fallo**. Toda
> rotación queda registrada en el audit log.

## 4. Configurar la copia para la organización

El servicio debe **activarse una vez**, y el destino se ajusta **una vez por
cliente**. Ve a **Cuenta y facturación → pestaña Servicios** y marca **«Activar
el backup automatizado para este cliente»**.

Luego elige un **VPS de destino** (entre tus servidores) y una **ruta** base.
Todos los proyectos escribirán ahí, cada uno en su subcarpeta.

![Activar el backup automatizado y ajustar el destino (Cuenta y facturación → Servicios)](/tutos/es/proteger-org-rotacion-backups-05.png)

> Solo **contenido cifrado** sale de tu VPS: Physalis nunca ve tus datos ni posee
> la clave de descifrado.

## 5. Activar la copia del proyecto

En la pestaña **Backup** del proyecto:

1. haz clic en **«Configurar copia de seguridad»**;
2. elige el **entorno** a respaldar (prod por defecto) y verifica la lista de
   **bases detectadas** automáticamente;
3. ajusta la **planificación**: el **intervalo** en días (`1` = todos los días) y
   la **hora UTC** de paso (por defecto **3 h UTC**);
4. ajusta la **retención** — cuántas copias conservar, en tres niveles
   **Daily / Weekly / Monthly** (por defecto **7 / 4 / 3**): Physalis conserva las
   7 últimas copias **diarias**, 4 **semanales** y 3 **mensuales**. Así tienes un
   historial **fino** en los días recientes y más **espaciado** en los meses, sin
   conservarlo todo;
5. guarda.

![Configuración de la copia de un proyecto](/tutos/es/proteger-org-rotacion-backups-06.png)

> **Mismo agente que la rotación.** La copia funciona con el **agente** inyectado
> en el **próximo despliegue**. Si ya lo **desplegaste para la rotación
> (paso 2)**, es el **mismo contenedor** — nada que rehacer. Si no, un
> **Redeploy** lo instala (mismo procedimiento que en el paso 2, *una sola vez
> por proyecto*).

## 6. Pasar al cifrado por Sobre KMS

En la pestaña **Backup**, haz clic en **«Activar el cifrado KMS»**.

El **Sobre KMS** (recomendado frente a GPG) cifra cada archivo con una clave de
datos única, sellada por una **clave maestra** que nunca sale de la bóveda
criptográfica.

Beneficios: rotación/revocación/**auditoría** centralizadas, y sobre todo la
**restauración en un clic** desde Physalis.

> **Se requiere un Redeploy.** El cambio de cifrado surte efecto en el **próximo
> despliegue**: es cuando Physalis inyecta la **identidad KMS** en el entorno del
> agente. Así que haz clic en **Redeploy** — si no, el agente conserva su esquema
> actual (la próxima copia **sola** no cambia). Tras ese despliegue, **todas** las
> copias pasan a sobre. Esto no toca los accesos de tu base, y las copias GPG ya
> producidas siguen siendo restaurables.

## 7. Forzar una copia

Haz clic en el botón **«Forzar ahora»**: el agente ejecuta la copia en su próximo
paso (en menos de un minuto).

El resultado aparece en el **historial** (estado, archivo, tamaño, fecha).

![Historial de copias tras una copia forzada](/tutos/es/proteger-org-rotacion-backups-07.png)

## 8. Restaurar (prueba en base nueva)

Sobre una copia exitosa del historial → botón **«Restaurar»**, modo **Nueva BD**
(el más seguro):

1. crea previamente una base **nueva y vacía**;
2. lanza la restauración hacia esa base.

![Restauración de una copia](/tutos/es/proteger-org-rotacion-backups-08.png)

Physalis orquesta: el agente descarga el archivo, lo **descifra localmente** (vía
la bóveda, bajo demanda y auditado) y lo restaura. El contenido en claro nunca
pasa por Physalis.

> El modo **«Reemplazar en el sitio»** es la verdadera recuperación ante
> incidentes (**sobrescribe** la base actual) — resérvalo para incidentes reales,
> preferiblemente con la app detenida.

## Comprobar que todo funciona

- **Rotación**: en la pestaña Rotación de la org, el secreto muestra
  `rotationLastStatus = success` y un **próximo vencimiento**.
- **Copia**: el historial muestra una copia **exitosa**, en modo sobre.
- **Restauración**: tu base de prueba contiene efectivamente los datos
  restaurados.

## En caso de problema

- **Ningún botón de rotación** → la función no está activada en la org (paso 1),
  o el nombre del secreto no se reconoce como credencial (`PORT`, URL, flag… :
  intencional).
- **No se lanza ninguna rotación automática** → el cron corre en hora valle (por
  defecto 2 h UTC); usa **«Forzar»** para probar bajo demanda.
- **La restauración «nueva BD» es rechazada** → la base destino debe estar
  **vacía** (seguridad anti-sobrescritura).
- **Una copia queda «saltada»** → la bóveda criptográfica estaba momentáneamente
  no disponible; se reanuda en la siguiente — nunca una copia en claro.

## ¿Y ahora?

- Siguiente tutorial: [Configurar el servicio de emails](tuto:configurar-servicio-email)
- Para profundizar:
  - [Rotación de secretos](rotaciones) — estrategia Webhook (cuentas de
    aplicación), hooks del lado app, cuentas de bases gestionadas
  - [Copias de seguridad](copias-de-seguridad) — GPG vs Sobre, retención,
    seguridad
  - [Bóvedas](bovedas) — compartir credenciales no-runtime en equipo
