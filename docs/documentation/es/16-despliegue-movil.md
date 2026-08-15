---
title: Despliegue móvil
order: 16
icon: RiSmartphoneLine
summary: Publica tus apps Android e iOS desde tu CI sin ningún secreto en el pipeline — Physalis guarda el material de firma, tu CI compila y sube directamente a las tiendas.
---

# Despliegue móvil

Physalis guarda el **material de firma** de tus apps móviles (keystore Android,
certificado iOS, perfiles, claves de API de las tiendas), cifrado y versionado,
y se lo sirve a tu CI **bajo demanda vía OIDC** — sin ningún secreto almacenado
en tu repositorio.

Es el equivalente móvil del [Despliegue OIDC](despliegue-oidc): el mismo
principio de token firmado por tu proveedor de CI, aplicado a la publicación de
apps.

## Lo que Physalis hace — y no hace

- **Physalis no compila ni almacena el artefacto.** La compilación (`.apk`,
  `.aab`, `.ipa`) se queda en tu lado, en tu runner de CI. Physalis solo guarda
  un **registro**, nunca el binario.
- **El CI sube directamente** a Google Play / App Store Connect. Los datos de
  publicación no transitan por Physalis.
- **Physalis reemplaza `fastlane match`**: el material ya no vive en un repo git
  cifrado con una frase de contraseña de equipo, sino en la bóveda — con control
  de acceso por proyecto, auditoría, versionado y retirada inmediata de quien se
  va.

## Activar el servicio

1. **Plan.** El despliegue móvil es una función de los planes de pago (no
   disponible en el plan gratuito).
2. **Por proyecto.** Abre los **Ajustes** del proyecto → sección **Despliegue
   móvil** → marca la casilla. La pestaña **Móvil** aparece entonces en el
   proyecto. Cada proyecto se activa por separado: un proyecto que no publica en
   las tiendas no tiene por qué llevar la pestaña.

## El material de firma

En la pestaña **Móvil**, una **aplicación** = un par (plataforma, identificador
de tienda). Cada aplicación lleva sus credenciales, importadas una a una:

**Android** (5)
| Credencial | Contenido |
|---|---|
| Keystore | el archivo `.jks`/`.p12` de firma |
| Contraseña del keystore | texto |
| Alias de clave | texto |
| Contraseña de la clave | texto |
| Cuenta de servicio de Google Play | el JSON descargado de Google Cloud |

**iOS** (6)
| Credencial | Contenido |
|---|---|
| Certificado de distribución (`.p12`) | + su contraseña |
| Perfil de aprovisionamiento (`.mobileprovision`) | |
| Clave de API de App Store Connect (`.p8`) | + Key ID + Issuer ID |

Solo el certificado, el perfil y el keystore llevan una **fecha de caducidad**,
extraída al importar (los demás son contraseñas o identificadores). Para un
`.p12`/keystore protegido, indica la **frase de contraseña** al importar: sirve
para leer la fecha, no se conserva.

## El número de versión

Apple y Google rechazan un número de build que no crece. Physalis lo lleva por
ti: en la ficha de la aplicación, ajusta la **versión** (marketing, p. ej.
`1.4`) y el **último número de build publicado**. En cada despliegue, Physalis
sirve el siguiente número y lo incrementa — ya no lo tocas. La versión de
marketing queda bajo tu control.

## Las policies: dos, si tu app es híbrida

Como en el despliegue de servidor, una **policy** autoriza a un pipeline
concreto `(repo, workflow, rama)` a recuperar el material. Dos tipos:

- una **policy móvil** (pestaña Móvil de la app) → sirve el **material de
  firma**;
- una **policy de servidor** (pestaña Policies del proyecto) → sirve los
  **secretos de build** (`VITE_*`, etc.).

⚠️ **Una app Capacitor / Cordova / Ionic compila primero una capa web**, que
necesita sus secretos de build. Por tanto necesita **las dos** policies, en el
mismo `(repo, workflow, rama)`. Una app nativa pura solo necesita la policy
móvil.

## Interruptor de emergencia

Un botón de **pausa/reanudar** en cada aplicación congela sus publicaciones: el
CI recibe entonces un rechazo claro y auditado, sin que toques el repo. El
material de firma queda intacto — es un veto puntual, no una revocación.

## Guías paso a paso

La mayor fricción está en Google y Apple. Dos tutoriales te llevan de la mano,
consola por consola:

- **[Publicar una app Android en Google Play](tuto:publicar-android)** — cuenta
  de servicio, API, permisos, keystore.
- **[Publicar una app iOS en la App Store](tuto:publicar-ios)** — clave de API
  de App Store Connect, certificado, perfil.
