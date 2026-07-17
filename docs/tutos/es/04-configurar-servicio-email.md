---
title: Configura el servicio de correo
order: 4
icon: RiMailSendLine
summary: Envía correos desde tu propio dominio — conexión del dominio, DNS (SPF/DKIM/DMARC), remitentes, correo de prueba y clave API inyectada en tus entornos.
level: intermedio
duration: ~15 min
published: true
---

# Configura el servicio de correo

Esta guía conecta el **envío de correos desde tu propio dominio** a un proyecto.

Al final, tu aplicación enviará sus correos a través del servicio Physalis, con
una clave API y un dominio **inyectados automáticamente** en el `.env` de cada
entorno durante el despliegue.

## Lo que vas a conseguir

- Tu **dominio de envío** conectado y autenticado (SPF/DKIM/DMARC verificados)
- Un **remitente autorizado** declarado y un **correo de prueba** enviado
- Las **variables de email inyectadas** en tus entornos, listas para usar

## Requisitos previos

- El **servicio de email activado para el cliente**.
- El rol **EDITOR** o superior en el proyecto (conexión, DNS, envío).
- Acceso a tu **registrador DNS** para crear registros.
- Un **proyecto** existente (véase [Crear un proyecto…](tuto:primer-despliegue-github)).

### Notas

La **activación del servicio de email** es un ajuste de **cliente**, que se hace
**una sola vez**.

Después, cada proyecto conecta su propio dominio. Un proyecto solo puede conectar
**un único dominio** a la vez.

---

## 1. Activar el servicio y conectar tu dominio

### Servicio de email

Ve a **Mi cuenta** → pestaña **Servicios** → haz clic en el botón
**«Activar el servicio de email»**.

![Activación del servicio de email desde Mi cuenta](/tutos/es/configurar-servicio-email-01.png)

### Conectar tu dominio

> Reservado al rol **EDITOR** o superior.

1. Abre un proyecto → pestaña **Email**.
2. Introduce tu **dominio de envío** (p. ej. `midominio.com`) → **Conectar**.
3. Physalis registra el dominio, genera una **clave API dedicada** (cifrada
   inmediatamente) y muestra los **registros DNS que hay que crear**.

![Conexión del dominio de envío en la pestaña Email del proyecto](/tutos/es/configurar-servicio-email-02.png)

## 2. Crear los registros DNS

La pestaña **Detalles** muestra una tabla (Tipo / Nombre / Valor) para copiar en
tu registrador:

- **SPF** — autoriza al servicio a enviar en nombre de tu dominio
- **DKIM** — firma criptográficamente tus correos
- **DMARC** — política de autenticación y de reporting

![Registros DNS que hay que crear](/tutos/es/configurar-servicio-email-03.png)

Añade estos tres registros en tu **registrador DNS**.

> ⚠️ Physalis **no crea** los registros por ti. La propagación DNS puede tardar
> desde unos minutos hasta varias horas.

## 3. Verificar los DNS

De vuelta en la pestaña **Detalles**, haz clic en **«Verificar DNS»**.

Physalis comprueba SPF / DKIM / DMARC y muestra el resultado (p. ej. *«SPF: sí ·
DKIM: sí · DMARC: sí»*).

Una vez todo validado, la insignia pasa a **Verificado**.

![Verificación de los DNS](/tutos/es/configurar-servicio-email-04.png)

## 4. Añadir un remitente autorizado

Antes de enviar, declara al menos una dirección «From» en tu dominio.

Pestaña **Remitentes** → escribe la parte izquierda de la **Dirección** (p. ej.
`contact`): el dominio conectado se añade automáticamente. Rellena el **Nombre**
(p. ej. `Contact`) → **Añadir**.

![Añadir un remitente autorizado en la pestaña Remitentes](/tutos/es/configurar-servicio-email-05.png)

> Un remitente es una **identidad de envío** autorizada, no un buzón de entrada.

### El remitente principal

El **primer remitente creado se convierte en el remitente principal**. Su
dirección se inyecta en el `.env` de tus entornos como `PHYSALIS_EMAIL_FROM` al
desplegar (paso 6): no tienes que **crear ningún secreto a mano**.

Si declaras varios remitentes, la insignia **Principal** indica cuál se inyecta,
y el botón **Definir como principal** permite cambiarlo.

![Dos remitentes declarados: la insignia Principal y el botón Definir como principal](/tutos/es/configurar-servicio-email-05.1.png)

> **El nombre no va en la dirección.** `PHYSALIS_EMAIL_FROM` solo contiene la
> dirección (`contact@midominio.com`); el servicio compone él mismo la cabecera
> `"Contact" <contact@midominio.com>` a partir del campo **Nombre**. Por tanto,
> renombrar un remitente no requiere volver a desplegar.

> **Tras cambiar el remitente principal, vuelve a desplegar**: tus aplicaciones
> leen el valor en su `.env`, que solo se actualiza al desplegar.

> Eliminar el remitente principal deja el proyecto **sin** remitente: tus envíos
> serán rechazados hasta que designes otro y vuelvas a desplegar.

## 5. Enviar un correo de prueba

Pestaña **Envío** (EDITOR+):

1. elige el **Remitente** (entre los autorizados);
2. rellena **Destinatario**, **Asunto** y **Mensaje (HTML)**;
3. **Enviar**.

![Envío de un correo de prueba](/tutos/es/configurar-servicio-email-06.png)

> Los envíos desde la interfaz están **limitados en frecuencia** (anti-abuso):
> esta pestaña sirve para pruebas. Para el envío desde la aplicación, usa las
> variables inyectadas (paso 6).

## 6. Usar las variables inyectadas

La pestaña **Detalles → Variables de entorno** lista lo que se inyecta en el
`.env` de **cada entorno** durante el despliegue:

```
PHYSALIS_EMAIL_API_KEY=...                 # clave API del proyecto (secreta, cifrada)
PHYSALIS_EMAIL_DOMAIN=midominio.com        # tu dominio de envío
PHYSALIS_EMAIL_URL=https://...             # endpoint del servicio de envío
PHYSALIS_EMAIL_FROM=contact@midominio.com  # tu remitente principal (paso 4)
```

Tu aplicación lee estas variables para llamar al servicio. La clave nunca se
almacena en claro: solo se descifra en el momento del despliegue.

> Puedes **Revelar** la clave puntualmente desde la interfaz (EDITOR+, acción
> limitada y registrada como `SECRET_REVEAL`).

## 7. (Opcional) Activar la rotación automática de la clave

Si la rotación está activada para tu organización, la pestaña **Detalles**
ofrece una sección **Rotación automática**:

1. marca **Activar la rotación automática de la clave API**;
2. define el **Intervalo (en días)**;
3. **Guardar**.

La rotación sigue una estrategia **blue/green**:

nueva clave generada → redespliegue → la anterior solo se revoca en el ciclo
siguiente (el tiempo necesario para que todos los entornos se redesplieguen).

![Sección Rotación automática de la clave API en la pestaña Detalles](/tutos/es/configurar-servicio-email-07.png)

## Comprobar que todo funciona

- El dominio muestra la insignia **Verificado** (paso 3).
- El **correo de prueba** se recibe correctamente (paso 5).
- La pestaña **Historial** lista el envío con el estado **Enviado**.
- Tras un despliegue, tu aplicación encuentra las variables `PHYSALIS_EMAIL_*`
  en su entorno.

## En caso de problema

- **«El servicio de email no está activado para este cliente»** → actívalo desde
  **Mi cuenta → pestaña Servicios** (paso 1).
- **La verificación DNS falla** → propagación en curso, o un registro mal
  copiado. Espera y vuelve a verificar; compara con la tabla del paso 2.
- **Imposible enviar** → ningún **remitente** declarado (paso 4), o el dominio
  aún no está **Verificado**.
- **Las variables no aparecen en la app** → se inyectan **en el despliegue**:
  redespliega después de conectar el dominio.

## ¿Y ahora qué?

- Para profundizar:
  - [Email](email) — historial, desconexión, permisos detallados
  - [Rotación de secretos](rotaciones) — el principio general detrás de la
    rotación de la clave API
  - [Secretos y categorías](secretos) — cómo llegan las variables a tus entornos
- Volver al principio: [Crear un proyecto, conectarlo a GitHub y desplegarlo](tuto:primer-despliegue-github)
