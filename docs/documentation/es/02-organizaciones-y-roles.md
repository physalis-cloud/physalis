---
title: Organizaciones y roles
order: 2
icon: RiTeamLine
summary: Invita miembros, comprende los 4 roles, gestiona los permisos.
---

# Organizaciones y roles

Una **organización** es la unidad de agrupación principal en Physalis:
contiene **miembros**, **proyectos**, **secretos globales**
(`OrgSecret`), **servidores** SSH y **bóvedas de equipo**.

Una sola organización cliente puede contener múltiples organizaciones internas
(p. ej. una agencia con varios equipos), y el mismo usuario puede pertenecer a
múltiples organizaciones — puede cambiar entre ellas mediante el selector en
la esquina superior izquierda del panel.

## Los 4 roles de organización

Physalis utiliza una jerarquía de 4 niveles: `MEMBER` < `DEV` < `ADMIN` < `OWNER`.

| Permiso                                      | MEMBER | DEV | ADMIN | OWNER |
|----------------------------------------------|:------:|:---:|:-----:|:-----:|
| Leer **secretos de organización**            |   —    | ✅  |  ✅   |  ✅   |
| Leer **servidores SSH**                      |   —    | ✅  |  ✅   |  ✅   |
| Ver todos los **proyectos** por defecto      |   —    | ✅* |  ✅   |  ✅   |
| Gestionar **políticas de despliegue**        |   —    | ✅  |  ✅   |  ✅   |
| Ver el **registro de auditoría** completo    |   —    |  —  |  ✅   |  ✅   |
| Ver registro de auditoría filtrado (propias acciones) |   —    | ✅  |  —    |  —    |
| Invitar / revocar **miembros**               |   —    |  —  |  ✅   |  ✅   |
| Gestionar **secretos globales** (creación)   |   —    |  —  |  ✅   |  ✅   |
| Renombrar / eliminar la organización         |   —    |  —  |   —   |  ✅   |

> ✅* Para DEV, la visibilidad es **EDITOR implícito** en todos los proyectos de la
> organización: puede ver todo, crear/editar secretos y entornos,
> pero no puede eliminar un proyecto ni invitar ProjectMembers.

### Restringir un DEV a ciertos proyectos

Ese acceso por defecto se ajusta proyecto por proyecto. Desmarcar un proyecto
para un DEV se lo **deniega de verdad**: el proyecto desaparece de su lista, se
le rechaza el acceso y sus tokens de máquina en ese proyecto se revocan.

Tres lugares para hacerlo, según el momento:

- **Al invitar** — botón «Derechos de acceso» junto al rol, en el formulario de
  invitación. El nuevo miembro llega ya acotado.
- **Al crear un proyecto** — sección «Derechos de acceso de los miembros» del
  formulario de creación. Es el único momento en el que el olvido es imposible:
  de lo contrario, un proyecto nuevo es visible de inmediato para todos los DEV.
- **Más tarde** — `/orgs/<slug>` → pestaña «Miembros» → «Derechos de acceso»
  junto al miembro, o la pestaña «Miembros» del propio proyecto.

Las casillas muestran siempre el acceso **real** del miembro: un DEV se abre con
todo marcado, porque es lo que tiene.

### ¿Cuándo usar cada rol?

- **MEMBER** → un empleado no técnico que solo necesita acceso a una bóveda de equipo
  específica (p. ej. personal de ventas que comparte un Vaultwarden interno).
  Ningún proyecto es visible hasta que se le añada explícitamente como
  `ProjectMember`.
- **DEV** → un desarrollador. Puede leer todos los secretos de todos los proyectos,
  gestionar despliegues OIDC, pero no puede tocar la administración de la organización
  (miembros, secretos globales, eliminación).
- **ADMIN** → un desarrollador líder / responsable técnico. Todo lo que puede hacer DEV,
  más invitaciones de miembros, secretos globales y registro de auditoría completo.
- **OWNER** → el propietario de la organización. El único que puede eliminarla o renombrarla.
  Lo ideal es tener 2 OWNERs para evitar un único punto de fallo.

## Invitar a un miembro

> Disponible únicamente para los roles **ADMIN** y **OWNER**.

1. Ve a `/orgs/<slug>` (desde el selector de org en la esquina superior izquierda).
2. Pestaña **"Miembros"** → botón **"+ Invitar"**.
3. Rellena:
   - **Correo electrónico** del destinatario
   - **Rol** en la organización
4. Envía. Se envía un correo a través de Mailgun con un enlace de activación
   **válido por 48 horas**.

Si el destinatario todavía no tiene una cuenta en Physalis, la crea al
aceptar la invitación. Si ya tiene una (otra organización en la misma
plataforma), se le añade a la nueva org en un clic.

> 💡 **Cuotas**: tu plan cliente define un número máximo de miembros
> (`maxUsers`). Si lo alcanzas, el formulario de invitación queda deshabilitado —
> debes revocar un miembro o solicitar al super-admin una mejora de plan.

## Cambiar el rol de un miembro

Pestaña **"Miembros"** → fila del miembro → desplegable de **rol** →
selecciona el nuevo rol. El cambio surte efecto de inmediato; es posible que el miembro
deba volver a iniciar sesión para ver sus nuevos permisos activos.

> ⚠️ No puedes **degradarte a ti mismo** si eres el único OWNER.
> Designa otro OWNER primero.

## Revocar un miembro

Misma pestaña → botón **"Revocar"**. El miembro:

- Pierde de inmediato el acceso al panel de esta organización
- Pierde acceso a todos los proyectos vinculados a esta organización
- **Conserva** su cuenta de Physalis (utilizable en sus otras organizaciones)
- **Ya no puede** descifrar los secretos a los que tenía acceso anteriormente —
  su cuenta no tiene ninguna sesión válida

El registro de auditoría conserva un historial completo de todas las acciones
realizadas por ese miembro durante su tiempo en la organización.

## Secretos globales de organización (`OrgSecret`)

Los **OrgSecrets** son secretos compartidos entre todos los proyectos de la organización.
Se utilizan habitualmente para:

- Tokens de API de terceros (`SENTRY_DSN`, `STRIPE_KEY`…) comunes a todos los proyectos
- **Convenciones reservadas de Physalis**:
  - `GITHUB_DISPATCH_TOKEN` — para el botón "Redesplegar" que activa
    un `workflow_dispatch` en GitHub
  - `REGISTRY_PAT`, `REGISTRY_USER`, `REGISTRY_URL` — para autenticar
    `docker pull` desde un registro privado durante el despliegue OIDC
    (ver [Despliegue OIDC](oidc-deployment))

Crear / editar: pestaña **"Secretos globales"** en la página de la organización.
Reservado para ADMIN / OWNER (DEV puede leer).

## Eliminar una organización

> Disponible únicamente para el rol **OWNER**.

Pestaña **"Configuración"** → sección **"Zona de peligro"**. La eliminación:

- Destruye **todos** los proyectos, entornos, secretos, bóvedas y
  políticas vinculadas
- Es **irreversible** (los datos cifrados se eliminan de la BD)
- Desvincula a todos los miembros (que permanecen registrados en Physalis)

Se requiere confirmación escribiendo el nombre de la organización.

## Más información

- [Proyectos y entornos](proyectos-y-entornos) — crea tu
  primer proyecto y añade secretos
- [Bóvedas](bovedas) — crea una bóveda de equipo compartida
- [Despliegue OIDC](oidc-deployment) — configura Servidor + Política
