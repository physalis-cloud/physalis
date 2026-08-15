---
title: Publicar una app Android en Google Play
order: 5
icon: RiAndroidLine
summary: De cero a un AAB publicado en Google Play desde tu CI — crear la app en Physalis, obtener la cuenta de servicio de Google, importar el keystore y lanzar la publicación sin ningún secreto en el pipeline.
level: intermedio
duration: ~30 min
published: true
---

# Publicar una app Android en Google Play

Esta guía te lleva de una aplicación Android a su **publicación automática en
Google Play desde tu CI**, sin pegar nunca un secreto de firma en tu repo.
Physalis guarda el keystore y la cuenta de servicio; tu CI compila el AAB y lo
sube directamente.

La verdadera fricción no está en Physalis — está en Google. Este tutorial
detalla las dos consolas (Google Cloud + Play Console) pantalla por pantalla.

## Lo que vas a lograr

- Una aplicación Android declarada en Physalis, con su keystore y su acceso a
  Google Play.
- Un workflow de GitHub que publica un AAB firmado en una pista de prueba en
  cada ejecución — sin secreto de GitHub.

## Requisitos previos

- El despliegue móvil está **activado en tu proyecto** (Ajustes del proyecto →
  Despliegue móvil). Consulta la referencia [Despliegue móvil](despliegue-movil).
- Una **conexión CI/CD** está vinculada al proyecto y el **repo** está definido
  (pestaña Ajustes).
- Tu app **ya existe** en la Play Console (el primer AAB de un paquete debe
  publicarse manualmente una vez; la API toma el relevo después).

## 1. Crear la aplicación en Physalis

Pestaña **Móvil** del proyecto → **Nueva aplicación**:

- **Plataforma**: Android
- **applicationId**: el identificador del paquete, en reverse-DNS (p. ej.
  `com.ejemplo.miapp`)
- **Nombre**: una etiqueta legible
- (opcional) **Grupo**: para ordenar dev/staging/prod

## 2. El keystore

Si ya tienes un keystore de firma, consérvalo. Si no, genera uno:

```bash
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias upload
```

> **Play App Signing (recomendado).** Deja que Google gestione la clave de firma
> final y proporciona solo una **clave de subida**. Una clave de subida perdida
> se reinicia; una clave de firma perdida **fuera** de Play App Signing es
> definitiva (republicar bajo otro paquete). Activa Play App Signing en la
> consola.

En la app de Physalis, importa **cinco** credenciales (botón «Importar una
credencial»):

| Tipo | Valor |
|---|---|
| Keystore de Android | el archivo `.jks` |
| Contraseña del keystore | el `storepass` |
| Alias de clave | el alias (`upload` arriba) |
| Contraseña de la clave | el `keypass` |
| Cuenta de servicio de Google Play | el JSON del paso 3 |

> ⚠️ La contraseña introducida al importar el keystore solo sirve para **leer la
> fecha de caducidad** — no se conserva. Impórtala **también** como credencial
> «Contraseña del keystore». Sin los tres textos, la firma fallará.

## 3. La cuenta de servicio de Google Play

Es lo que permite a tu CI subir vía la API. Dos partes.

### a. Crear la cuenta de servicio (Google Cloud)

1. [console.cloud.google.com](https://console.cloud.google.com) → selecciona (o
   crea) un proyecto.
2. **☰ → IAM y administración → Cuentas de servicio → Crear cuenta de
   servicio**. Ponle un nombre (`play-ci`), **sin rol**, Listo.
3. Ábrela → **Claves → Añadir clave → JSON** → el archivo se descarga. **Es lo
   que importas en Physalis.**
4. **☰ → API y servicios → Biblioteca** → busca **Google Play Android Developer
   API** → **Habilitar**. (Se olvida a menudo — sin ella nada funciona.)

### b. Dar el acceso (Play Console)

Al haberse movido la página «Acceso a las API», lo más sencillo es vía usuarios:

1. [play.google.com/console](https://play.google.com/console) → **Usuarios y
   permisos** → **Invitar a nuevos usuarios**.
2. Pega el **correo de la cuenta de servicio**
   (`play-ci@…iam.gserviceaccount.com`).
3. En **Permisos de la aplicación**, selecciona tu app y marca el **mínimo** (no
   «Administrador»):
   - **Publicar aplicaciones en canales de prueba**;
   - **Gestionar canales de prueba y editar listas de testers**.
   (Para publicar en producción más tarde, añade entonces «Poner las
   aplicaciones a disposición de todos…».)
4. **Invitar**.

> **Retraso.** La API puede tardar de unos minutos a ~24 h antes de aceptar la
> cuenta. Un `permission denied` justo después es normal — reinténtalo.

Por último importa el JSON en Physalis (app → Cuenta de servicio de Google Play)
y **elimina la copia local del archivo** — es un secreto.

## 4. Versión y número de build

En la ficha de la aplicación, ajusta la **versión** (p. ej. `1.4`) y el **último
número de build publicado** (el `versionCode` de tu última release, p. ej. `4`).
Physalis servirá `5`, `6`… automáticamente en cada despliegue.

## 5. Autorizar el pipeline (las policies)

Una app Capacitor compila primero su capa web, así que **dos** policies en el
mismo `(repo, workflow, rama)`:

- **Policy móvil** (en la app, sección «Publicación desde el CI»): workflow
  `release-android.yml`, rama `production`.
- **Policy de servidor** (pestaña **Policies** del proyecto): mismo workflow,
  misma rama, entorno `production` — sirve los `VITE_*` del build web.

Una app nativa pura solo necesita la policy móvil.

## 6. El workflow

Copia las plantillas del repo público en tu repo y adapta el bloque `env` (mira
la cabecera «À ADAPTER»):

- `.github/workflows/release-android.yml` (plantilla
  `deploy-mobile-android-capacitor.modele.yml`)
- `fastlane/Fastfile` (plantilla `fastlane.Fastfile.modele`)

El workflow recupera los `VITE_*` y el material de firma vía OIDC, compila el AAB
firmado y lo sube con `fastlane supply`. Por defecto se lanza **manualmente**
(`workflow_dispatch`): ejecútalo desde la pestaña Actions de GitHub, eligiendo la
pista (`internal` por defecto).

## Publicado

La ejecución en verde deja el AAB en tu pista de prueba. Compruébalo en la Play
Console. El número de build se incrementó solo en Physalis.

Para la versión iOS, sigue el tutorial
[Publicar una app iOS en la App Store](tuto:publicar-ios).
