---
title: Email
order: 12
icon: RiMailSendLine
summary: Envía emails desde tu propio dominio a través del servicio de envío de Physalis — autenticación DNS (SPF/DKIM/DMARC), remitentes autorizados, historial y una clave API inyectada en tus entornos.
---

# Email

El módulo **Email** permite a un proyecto enviar emails desde **tu propio
dominio** a través del servicio de envío de Physalis. La clave API y el dominio
se inyectan en el `.env` de cada entorno durante el despliegue — tu aplicación
solo tiene que leerlos.

Physalis se encarga de:

- Registrar tu dominio de envío
- Generar los registros DNS (SPF, DKIM, DMARC) y verificarlos
- Gestionar los **remitentes autorizados** (direcciones «From»)
- Enviar emails de prueba y consultar el **historial**
- La rotación automática de la clave API

## Requisitos previos

El servicio de email debe estar primero **activado para el cliente**
(organización). Un OWNER lo activa desde la página **Seguridad** (clic en tu
email en la cabecera). Hasta entonces, la pestaña muestra: *«El servicio de
email no está activado para este cliente.»*

> Permisos: conectar, verificar, enviar y gestionar remitentes requieren el rol
> **EDITOR** o superior en el proyecto. Los roles **VIEWER** pueden consultar el
> estado, los remitentes y el historial.

## Conceptos

```
Proyecto
  └── Configuración de email
        ├── Dominio de envío (p. ej. midominio.com)
        ├── Registros DNS (SPF · DKIM · DMARC)
        ├── Clave API (cifrada, inyectada en el despliegue)
        ├── Remitentes autorizados (direcciones «From»)
        └── Historial de envíos
```

Un proyecto solo puede conectar **un dominio** a la vez.

## Conectar un dominio

> Permisos: **EDITOR** o superior.

1. Abre un proyecto → pestaña **Email**.
2. Introduce tu **dominio de envío** (p. ej. `midominio.com`) y haz clic en
   **Conectar**.
3. Physalis registra el dominio en el servicio de envío, genera una clave API
   específica del proyecto (cifrada de inmediato) y muestra los **registros DNS
   a crear**.

## Registros DNS y verificación

Tras conectar, la pestaña **Detalles** muestra una tabla de registros a crear
en tu registrador (Tipo / Nombre / Valor):

- **SPF** — autoriza al servicio a enviar por tu dominio.
- **DKIM** — firma criptográficamente tus emails.
- **DMARC** — política de autenticación e informes.

1. Añade estos registros en tu **registrador DNS**.
2. Haz clic en **Verificar DNS**.
3. Physalis comprueba SPF / DKIM / DMARC y muestra el resultado (p. ej.
   *«SPF: sí · DKIM: sí · DMARC: sí»*). Cuando todo es válido, la insignia pasa
   a **Verificado**.

> La propagación DNS puede tardar de unos minutos a unas horas. Physalis no
> crea los registros por ti: la verificación solo comprueba que estén
> presentes.

## Remitentes autorizados

Antes de enviar, declara al menos una dirección de envío («From») en tu
dominio.

- Pestaña **Remitentes** → rellena **Dirección** (p. ej. `hola@midominio.com`)
  y **Nombre** (p. ej. `Soporte`), luego **Añadir**.
- Puedes eliminar un remitente en cualquier momento.

> Un remitente es una identidad de envío autorizada en tu dominio, no un buzón.

## Variables de entorno inyectadas

La pestaña **Detalles → Variables de entorno** lista las variables inyectadas
en el `.env` de **cada entorno** durante el despliegue:

```
PHYSALIS_EMAIL_API_KEY=...          # clave API del proyecto (secreta)
PHYSALIS_EMAIL_DOMAIN=midominio.com # tu dominio de envío
PHYSALIS_EMAIL_URL=https://...      # endpoint del servicio de envío
```

- `PHYSALIS_EMAIL_API_KEY` nunca se almacena en claro: se cifra (AES-256-GCM) y
  solo se descifra en el despliegue. Puedes **Revelarla** puntualmente desde la
  interfaz (EDITOR+, acción auditada).
- Tu aplicación lee estas variables para llamar al servicio de envío.

> ⚠️ La revelación de la clave está limitada (anti-abuso) y registrada
> (`SECRET_REVEAL`).

## Enviar un email de prueba

Desde la pestaña **Envío** (EDITOR+):

1. Elige el **Remitente** (entre los remitentes autorizados).
2. Rellena el **Destinatario**, el **Asunto** y el **Mensaje (HTML)**.
3. Haz clic en **Enviar**.

> Los envíos desde la interfaz están limitados (anti-abuso). Esta pestaña sirve
> para pruebas; para el envío desde tu aplicación, usa las variables inyectadas
> en tu código.

## Historial

La pestaña **Historial** lista los envíos del dominio (Estado, Destinatario,
Asunto, Fecha), con un botón **Actualizar**. Los estados posibles son
**Enviado** y **Fallido**.

## Rotación automática de la clave

Si la rotación de claves está activada para tu organización, la pestaña
**Detalles** ofrece una sección **Rotación automática**:

1. Marca **Activar la rotación automática de la clave API**.
2. Define el **intervalo (en días)**.
3. **Guardar** — se muestra la próxima fecha de rotación.

La rotación sigue una estrategia **blue/green**:

1. Se genera y cifra una **nueva clave**.
2. Se desencadena un **redespliegue** para recargar el nuevo valor.
3. La **clave antigua solo se revoca en el siguiente ciclo**, dando tiempo a
   que todos los entornos se redesplieguen.

> Si una rotación falla, no se revoca ninguna clave y se programa un nuevo
> intento automáticamente.

Consulta [Rotación de secretos](rotaciones) para el principio general.

## Desconectar

**Detalles → Desconectar** (EDITOR+). Al desconectar se **revoca la clave API**
en el servicio de envío y se elimina la configuración local. Las variables
dejan de inyectarse en los despliegues siguientes.

## Permisos

| Acción                                      | Rol requerido                          |
|---------------------------------------------|----------------------------------------|
| Ver estado, remitentes, historial           | VIEWER+                               |
| Conectar / desconectar un dominio           | EDITOR+                              |
| Verificar DNS                               | EDITOR+                              |
| Añadir / eliminar un remitente              | EDITOR+                              |
| Enviar un email, revelar la clave           | EDITOR+                              |
| Configurar la rotación automática           | EDITOR+ (rotación activada en la org)  |
