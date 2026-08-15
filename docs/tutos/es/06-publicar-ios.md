---
title: Publicar una app iOS en la App Store
order: 6
icon: RiAppleLine
summary: De cero a un build iOS en TestFlight desde tu CI — crear la app en Physalis, obtener la clave de API de App Store Connect, el certificado y el perfil, y lanzar la publicación sin ningún secreto en el pipeline.
level: intermedio
duration: ~30 min
published: true
---

# Publicar una app iOS en la App Store

Esta guía te lleva de una aplicación iOS a su **publicación en TestFlight (luego
la App Store) desde tu CI**, sin secreto de firma en tu repo. Physalis guarda el
certificado, el perfil y la clave de API; tu CI compila el `.ipa` en un runner
macOS y lo sube directamente a Apple.

> **No necesitas un Mac para esta guía.** El runner macOS de tu CI compila; tú
> solo tienes que recuperar tres elementos en App Store Connect.

## Requisitos previos

- El despliegue móvil está **activado en tu proyecto** (Ajustes → Despliegue
  móvil). Consulta [Despliegue móvil](despliegue-movil).
- Una **conexión CI/CD** está vinculada al proyecto y el **repo** está definido.
- Una cuenta de **Apple Developer** con permisos de administración.

## 1. Crear la aplicación en Physalis

Pestaña **Móvil** del proyecto → **Nueva aplicación**:

- **Plataforma**: iOS
- **bundleId**: el identificador, en reverse-DNS (p. ej. `com.ejemplo.miapp`)
- **Nombre**: una etiqueta legible
- **Team ID / editor** (opcional pero útil): tu Team ID de Apple (10 caracteres)

## 2. La clave de API de App Store Connect (`.p8`)

Es la credencial de arranque: autentica tu CI ante Apple, sin Apple ID ni doble
factor.

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Users and
   Access** → pestaña **Integrations** (o **Keys**) → **App Store Connect API**.
2. **Generate API Key** → ponle un nombre, rol **App Manager** (suficiente para
   publicar).
3. Anota el **Key ID** y el **Issuer ID** (el Issuer ID está arriba de la página
   y puede mostrarse **solo una vez** — cópialo).
4. **Download API Key** → el archivo `.p8`. ⚠️ **Nunca se puede volver a
   descargar**: guárdalo lo justo para importarlo, luego elimina la copia local.

En Physalis, importa tres credenciales:

| Tipo | Valor |
|---|---|
| Clave de API de App Store Connect (`.p8`) | el archivo descargado |
| Key ID | el identificador de la clave |
| Issuer ID | el identificador del emisor |

## 3. El certificado de distribución (`.p12`) y el perfil

Necesitas un **certificado de distribución** y un **perfil de aprovisionamiento
de App Store** para el bundleId de la app.

- Si ya los tienes (exportados del Llavero o generados antes), reutilízalos.
- Un `.p12` exportado del **Llavero de macOS** está protegido por una contraseña:
  anótala, te la pedirá.

En Physalis, importa:

| Tipo | Valor |
|---|---|
| Certificado de distribución (`.p12`) | el archivo |
| Contraseña del `.p12` | la contraseña de exportación |
| Perfil de aprovisionamiento (`.mobileprovision`) | el archivo |

> ⚠️ La contraseña introducida al importar el `.p12` sirve para **leer la fecha
> de caducidad** — no se conserva. Impórtala **también** como credencial
> «Contraseña del .p12».

El certificado y el perfil duran ~1 año. Physalis extrae su fecha de caducidad al
importar y te avisará antes de que expire.

## 4. Versión y número de build

En la ficha de la aplicación, ajusta la **versión** (p. ej. `1.9`) y el **último
número de build publicado** (el `CFBundleVersion` de tu última release, p. ej.
`10`). Physalis servirá `11`, `12`… automáticamente.

## 5. Autorizar el pipeline (las policies)

Una app Capacitor compila primero su capa web, así que **dos** policies en el
mismo `(repo, workflow, rama)`:

- **Policy móvil** (en la app, sección «Publicación desde el CI»): workflow
  `release-ios.yml`, rama `production`.
- **Policy de servidor** (pestaña **Policies** del proyecto): mismo workflow,
  misma rama, entorno `production` — sirve los `VITE_*` del build web.

Una app nativa pura solo necesita la policy móvil.

## 6. El workflow

Copia las plantillas del repo público en tu repo y adapta el bloque `env` (mira
la cabecera «À ADAPTER»):

- `.github/workflows/release-ios.yml` (plantilla
  `deploy-mobile-ios-capacitor.modele.yml`)
- `fastlane/Fastfile` (plantilla `fastlane.Fastfile.modele`)

El workflow corre en un **runner macOS**. Recupera los `VITE_*` y el material de
firma vía OIDC, extrae el nombre del perfil y el Team ID del `.mobileprovision`
(nada está codificado en duro), compila el `.ipa` con firma manual y lo sube a
TestFlight. Por defecto se lanza **manualmente** (`workflow_dispatch`).

> **Capacitor.** El proyecto nativo siempre se llama `App.xcworkspace` / scheme
> `App` (impuesto por Capacitor), y se regenera en cada build con `npx cap add`.
> La plantilla ya lo gestiona.

## En TestFlight

La ejecución en verde deja el build en TestFlight. Lo encuentras en App Store
Connect tras unos minutos de procesamiento de Apple. El número de build se
incrementó solo en Physalis.

Para la versión Android, sigue el tutorial
[Publicar una app Android en Google Play](tuto:publicar-android).
