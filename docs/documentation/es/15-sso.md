---
title: SSO e inicio de sesión externo
order: 15
icon: RiShieldKeyholeLine
summary: SSO empresarial (Google, GitHub, Microsoft, Okta, Keycloak, OIDC) e inicio de sesión con una cuenta personal.
---

# SSO e inicio de sesión externo

Physalis ofrece dos mecanismos de inicio de sesión federado, además de la
contraseña clásica:

- **SSO empresarial** — tus miembros inician sesión a través del IdP de tu
  organización (Google Workspace, GitHub, Microsoft Entra, Okta, Keycloak o
  cualquier proveedor OIDC estándar). Lo configura el **propietario** del
  espacio.
- **Inicio de sesión con una cuenta personal** (social login) — un miembro
  vincula su cuenta personal de Google / GitHub / Microsoft y la usa para
  iniciar sesión, además de la contraseña. Lo activa el propio miembro.

> 🔒 **Principio de seguridad — sin creación automática de cuentas.** El SSO
> solo conecta a miembros **ya invitados** al espacio. Una identidad federada
> que no corresponde a ningún miembro existente es **rechazada**, nunca
> creada. Para dar acceso a alguien, invítalo primero (ver *Organizaciones y
> roles*); luego podrá iniciar sesión por SSO.

---

## SSO empresarial

### Para qué sirve

Tu equipo inicia sesión en Physalis con las credenciales de tu proveedor de
identidad, sin una contraseña dedicada de Physalis. Mantienes el control de
los accesos desde tu IdP (desactivar una cuenta, MFA, etc.).

### Configurar un proveedor

Reservado al **propietario de la organización principal** del espacio.

1. **Mi cuenta → pestaña SSO**.
2. Elige la pestaña del proveedor deseado (Google, GitHub, Microsoft, Okta,
   Keycloak, OIDC). Puedes configurar y activar **varios**.
3. Completa los campos (ver la tabla siguiente), define los **dominios
   permitidos**, marca **Activar** y luego **Guardar**.
4. El botón **Probar** valida el descubrimiento OIDC del issuer.

El *client secret* se almacena cifrado y nunca se vuelve a mostrar: deja el
campo vacío al editar para conservar el actual.

### URL de redirección (callback)

En el IdP, registra la URL de redirección de **tu subdominio**:

```
https://<tu-espacio>.physalis.cloud/api/auth/callback/<proveedor>
```

donde `<proveedor>` es `google`, `github`, `microsoft`, `okta`, `keycloak` u
`oidc`. Ejemplo para Google en el espacio *acme*:
`https://acme.physalis.cloud/api/auth/callback/google`.

### Campos por proveedor

| Proveedor | Campos requeridos | Dónde crear la aplicación |
|---|---|---|
| **Google** | Client ID + secret | Google Cloud Console → Credenciales OAuth |
| **GitHub** | Client ID + secret | GitHub → Settings → Developer settings → OAuth Apps |
| **Microsoft** | Client ID + secret (+ Tenant ID, `common` por defecto) | Azure → App registrations |
| **Okta** | Client ID + secret + **Issuer URL** | Okta Admin → Applications (OIDC Web) |
| **Keycloak** | Client ID + secret + **Issuer URL** | Consola Keycloak → Clients |
| **OIDC** (genérico) | Client ID + secret + **Issuer URL** | Cualquier IdP compatible con OpenID Connect |

Para **Okta**, indica como Issuer la URL de tu organización —
`https://<tu-org>.okta.com` (el servidor de autorización de organización).

> **Dominios permitidos**: restringe el inicio de sesión a correos verificados
> de ciertos dominios (p. ej. `acme.com`). Una identidad fuera de esos dominios
> es rechazada — útil para evitar que una cuenta personal del mismo proveedor
> sirva para entrar.

### Imponer el SSO

La opción **Imponer el SSO** (a nivel de espacio) corta el inicio de sesión por
contraseña para **todos** los miembros: solo podrán entrar mediante el/los
proveedor(es) SSO activado(s). Una red de seguridad anti-bloqueo conserva la
contraseña mientras no haya ningún proveedor activado.

### Activar / desactivar

Cada proveedor se configura y se activa de forma **independiente**. Desactivar
un proveedor solo retira su botón de la página de inicio de sesión, sin
eliminar su configuración.

> ✅ **Disponibilidad**: Google, GitHub, Microsoft y Okta están validados en
> producción. Keycloak y el OIDC genérico usan el mismo flujo OIDC estándar y
> están disponibles — valídalos en tu entorno antes de un despliegue amplio.

---

## Inicio de sesión con una cuenta personal (social login)

Práctico para los miembros que prefieren entrar con un clic usando su cuenta
**personal** de Google, GitHub o Microsoft, sin depender de un IdP empresarial.
Usa las aplicaciones OAuth de Physalis: **nada que configurar** en el espacio.

### Vincular tu cuenta

1. **Mi cuenta → Seguridad → Inicio de sesión con una cuenta externa**.
2. Haz clic en **Vincular** junto al proveedor deseado.
3. Autentícate con el proveedor; la identidad queda asociada a tu cuenta
   Physalis. Puedes **desvincular** en cualquier momento.

La vinculación es **explícita**: solo puede hacerse con la sesión iniciada en
tu cuenta. Sin vinculación automática.

### Iniciar sesión

Una vez vinculado, aparece un botón (“Google”, “GitHub”, “Microsoft”) en la
página de inicio de sesión, además de la contraseña. Un clic te conecta.

### Control a nivel de espacio

El propietario puede activar/desactivar globalmente el social login desde **Mi
cuenta → SSO → pestaña Social login**. Desactivado: ningún botón social,
vinculación oculta. Un proveedor ya configurado como **SSO empresarial** no se
ofrece por duplicado como social.

---

## Extensión de navegador

Sea cual sea tu método de inicio de sesión en la **web** (contraseña, SSO o
social), la extensión de navegador de Physalis, si está instalada, **se asocia
automáticamente** a tu sesión — sin entrada adicional. El inicio de sesión
clásico (correo + contraseña + código TOTP) sigue disponible directamente
desde el popup de la extensión para las cuentas con contraseña.

---

## En resumen

- **SSO empresarial** = tus miembros invitados inician sesión a través de tu
  IdP; lo configura el propietario, multi-proveedor, callback en tu subdominio,
  opción «imponer el SSO».
- **Social login** = un miembro vincula su cuenta personal e inicia sesión con
  ella; el espacio puede activarlo/desactivarlo.
- **Nunca auto-provisioning**: inicias sesión, no creas una cuenta.
- **Extensión**: cualquier inicio de sesión web asocia la extensión
  automáticamente.
