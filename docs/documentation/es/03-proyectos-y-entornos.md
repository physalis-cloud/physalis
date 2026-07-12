---
title: Proyectos y entornos
order: 3
icon: RiFolderOpenLine
summary: Crea un proyecto, gestiona sus entornos, vincula un servidor de despliegue.
---

# Proyectos y entornos

En Physalis, cada aplicación desplegada se representa como un **proyecto**
vinculado a una organización. Un proyecto contiene:

- Una lista de **entornos** (`production`, `staging`, `main`…), cada uno
  con sus propios secretos
- **Servicios** y **cuentas de aplicación** (bases de datos, servicios de terceros,
  acceso de administración) almacenados de forma cifrada
- **Políticas de despliegue** OIDC (quién puede desplegar qué)
- Opcionalmente, una **bóveda de equipo** con alcance al proyecto

## Crear un proyecto

> Permisos: **ADMIN** u **OWNER** de la organización. **DEV**
> puede ver todos los proyectos pero no puede crearlos.

1. Ve a `/projects` (pestaña **Proyectos** en la navegación).
2. En **"Crear un proyecto"**, introduce el **nombre** de tu proyecto y luego
   haz clic en **"Crear"**.
3. El proyecto aparece en un bloque **"sin grupo"** por defecto. Su **slug**
   (identificador válido en URL, usado en `/projects/<slug>` y en el paquete de
   despliegue) se **deriva del nombre**.

> ⚠️ El **slug es permanente**: sirve como ancla para las
> políticas de despliegue OIDC. Cambiarlo posteriormente romperá todos los flujos
> de trabajo que lo referencien.

## Crear un entorno

Al crear un proyecto, se crean **tres entornos por defecto**: `development`,
`staging` y `production`. Los gestionas desde los **ajustes del proyecto** —
pestaña **"Entornos"** — y puedes **añadir** más con el botón
**"+ Nuevo entorno"**.

Campos de un entorno:

| Campo              | Descripción                                                                 |
|--------------------|-----------------------------------------------------------------------------|
| **Nombre**         | `production`, `staging`, `main`, `preview`… (en minúsculas por convención) |
| **URL pública**    | URL donde será accesible la app (se muestra en el panel, opcional)          |
| **Servidor**       | Servidor SSH de destino (ver más abajo)                                     |
| **Ruta de despliegue** | Ruta absoluta en el VPS donde se desplegará la app (predeterminada automática, ver más abajo) |
| **Docker Compose** | YAML completo del `docker-compose.yml` que se sube en el momento del despliegue (opcional) |

### Convención `defaultDeployPath`

Si dejas **Ruta de despliegue** vacío, Physalis aplica automáticamente
la convención:

```
/srv/projets/<env>/<slug>
```

Por ejemplo, el proyecto `physalis` en el entorno `production` se
desplegará en `/srv/projets/production/physalis` en el VPS.

Esta es la convención recomendada — solo necesitas introducir una ruta personalizada
si tienes una infraestructura de VPS no estándar.

### Vínculo Servidor ↔ Entorno

El **Servidor** se define a nivel de organización (un servidor SSH = una
clave cifrada = un destino). Cada entorno apunta a **un servidor**,
pero **un servidor puede alojar múltiples entornos**
(p. ej. tanto `staging` como `preview` en el mismo VPS de pruebas).

Crear / editar servidores: página de la org → pestaña **"Servidores"**.
Ver [Despliegue OIDC](oidc-deployment) para la configuración completa.

### Docker Compose integrado

Si introduces un `docker-compose.yml` en Physalis, este será **subido durante
el despliegue** por el flujo de trabajo OIDC al VPS, dentro del `deployPath`.
Útil para gestionar todo el stack desde un único lugar (Physalis se convierte en
la fuente de verdad).

Si lo dejas vacío, tu VPS ya debe tener un `docker-compose.yml` local
— Physalis solo actualizará el `.env`.

## Editar un entorno

Haz clic en un entorno de la lista para abrir su página de detalle.
Allí encontrarás:

- **Secretos** — la lista de todas las variables `.env` cifradas
  ([→ Secretos](secretos))
- **Configuración** — los campos anteriores, editables
- **Botón "Redesplegar"** — activa un `workflow_dispatch` de GitHub
  Actions en la rama asociada (requiere `GITHUB_DISPATCH_TOKEN` como
  OrgSecret, ver [Organizaciones y roles](organizaciones-y-roles))

## Pestaña "Acceso" del proyecto

Esta pestaña agrupa las **referencias no secretas** relacionadas con el proyecto:

- **Tarjetas de entorno** — resumen visual por entorno (URL, servidor, último
  despliegue visto en el registro de auditoría)
- **Servicios** — entradas para servicios vinculados al proyecto. Dos usos:
  - *servicio de terceros* (Sentry, Stripe…): **usuario + contraseña** cifrados;
  - *servicio backend*: a menudo **solo una URL** (usuario/contraseña
    **opcionales**), que puede portar el **hook de rotación de las cuentas**
    vinculadas.
- **Cuentas de aplicación** (`AppAccount`) — credenciales cifradas para
  usuarios de la aplicación (admin de Strapi, super-usuario de PostgreSQL…). Una
  cuenta puede **vincularse a un entorno** (frontend) o a un **servicio**
  (backend): su URL se deriva del vínculo (la extensión la propone entonces en la
  página correcta).

Aquí es donde se documenta "cómo conectarse a este proyecto manualmente",
sin contaminar los secretos inyectados en tiempo de ejecución.

> Servicios y cuentas también pueden **rotarse** (recordatorio asistido, o
> **webhook** para las cuentas vía el hook del servicio backend vinculado) — ver
> [Rotación de secretos](rotaciones).

## Permisos por proyecto (`ProjectMember`)

En el nivel superior, **los roles de organización son suficientes**:

- ADMIN / OWNER → OWNER implícito en todos los proyectos
- DEV → EDITOR implícito en todos los proyectos
- MEMBER → **ningún proyecto visible** sin un `ProjectMember` explícito

Para dar a un MEMBER acceso a un proyecto específico (o para restringir a un DEV,
o para promover a un DEV a OWNER del proyecto):

1. Página del proyecto → pestaña **"Miembros"**.
2. **"+ Añadir"** → elige el usuario (ya miembro de la org) y
   su rol:
   - **VIEWER** — solo lectura
   - **EDITOR** — puede editar secretos, entornos, servicios
   - **OWNER** — todo lo que puede hacer EDITOR, más eliminación del proyecto y gestión de miembros

> 💡 Los roles de `ProjectMember` **nunca degradan** un rol existente: un OWNER de org
> sigue siendo un OWNER del proyecto aunque sea añadido como VIEWER. El rol efectivo es
> el **máximo** entre el rol implícito de org y el rol explícito del proyecto.

## Eliminar un proyecto

> Disponible para el rol **OWNER del proyecto** (o ADMIN/OWNER de la org por herencia).

Pestaña **"Configuración"** → sección **"Zona de peligro"**. La eliminación:

- Destruye todos los entornos y sus secretos
- Destruye todas las políticas OIDC vinculadas (los flujos de trabajo de GitHub Actions
  asociados ya no podrán desplegarse)
- Es **irreversible**

## Más información

- [Secretos](secretos) — gestiona las variables `.env` de un entorno
- [Despliegue OIDC](oidc-deployment) — configura Servidor, Política
  y el flujo de trabajo de GitHub Actions
- [Bóvedas](bovedas) — crea una bóveda de equipo con alcance al proyecto para
  compartir credenciales no relacionadas con el tiempo de ejecución
