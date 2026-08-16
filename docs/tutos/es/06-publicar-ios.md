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
- Una cuenta de **Apple Developer** con permisos de administración — alta en
  [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/),
  99 $/año.

> **Ábrela lo primero.** Es lo único de esta guía que no se resuelve en el día.
> Un alta **individual** publica bajo tu propio nombre; un alta de
> **organización** publica bajo el de la empresa, y exige un número **D-U-N-S**
> más una validación por parte de Apple — de unos días a varias semanas. Apple
> ofrece una [herramienta de búsqueda de D-U-N-S](https://developer.apple.com/enroll/duns-lookup/)
> (se requiere Apple ID): empieza por ahí, muchas empresas ya tienen uno sin
> saberlo.

![El despliegue móvil activado en los ajustes del proyecto](/tutos/es/publicar-ios-01.png)

> **¿App ya en la App Store o recién creada?** Ambas funcionan. Solo una cosa no
> pasa por la API: **crear la ficha** de la aplicación en App Store Connect
> (paso 3). La clave de API que guarda Physalis sabe hacer todo lo demás —subir
> builds, gestionar TestFlight— salvo crear una app: es la única operación que
> Apple reserva a la interfaz. El primer build sí sale del pipeline como todos
> los demás; el paso 8 detalla ese primer envío.

## 1. Crear la aplicación en Physalis

Pestaña **Móvil** del proyecto → **Nueva aplicación**:

- **Plataforma**: iOS
- **bundleId**: el identificador, en reverse-DNS (p. ej. `com.ejemplo.miapp`)
- **Nombre**: una etiqueta legible
- **Team ID / editor** (opcional pero útil): tu Team ID de Apple (10 caracteres)

![Formulario de creación de una aplicación iOS](/tutos/es/publicar-ios-02.png)

Los campos **Versión** y **Último n.º de build publicado** del mismo formulario
son el objeto del paso 5 — déjalos tal cual por ahora.

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

## 3. Declarar la app en Apple

Dos registros, una sola vez. Sáltate este paso si tu app ya está publicada.

1. **El bundle ID**, en el [portal de desarrollador](https://developer.apple.com/account/resources/identifiers/list)
   → **Identifiers** → **+** → App IDs → App. Usa exactamente el `bundleId`
   declarado en el paso 1 y marca las capacidades que tu app necesite. Es a él
   al que apuntará el perfil de aprovisionamiento del paso 4.
2. **La ficha de la app**, en [App Store Connect](https://appstoreconnect.apple.com)
   → **Apps** → **+** → **Nueva app**: plataforma iOS, nombre, idioma, el bundle
   ID anterior y un SKU (referencia interna libre).

Es la única operación que Apple no ofrece por API: una clave de API de App Store
Connect sabe subir builds y manejar TestFlight, pero no crear una app. Sin esa
ficha, la subida falla con un mensaje que no dice por qué: `No suitable
application records were found. Verify your bundle identifier is correct.`

## 4. El certificado de distribución (`.p12`) y el perfil

Necesitas un **certificado de distribución** y un **perfil de aprovisionamiento
de App Store** para el bundleId de la app. Dos caminos — y el primero no
requiere ningún Mac.

### Deja que Physalis los genere

En la ficha de la aplicación, **Generar el material de firma**. A partir
únicamente de la clave `.p8` del paso 2, Physalis encadena el par de claves, la
CSR, el certificado de distribución, el `.p12` y el perfil de aprovisionamiento,
y los guarda cifrados. La clave privada nace dentro de la caja fuerte y no sale
de ella.

Aquí es donde esta guía cumple su promesa: **un Mac sirve para compilar, no para
generar**. Una CSR y un `.p12` son criptografía, no Xcode — el rodeo por el
Llavero de macOS nunca fue más que una costumbre.

Dos límites del lado de Apple:

- el **App ID debe estar ya registrado** en tu cuenta de desarrollador — es el
  paso 3;
- Apple **limita los certificados de distribución** (2 o 3 por cuenta).
  Regenerar consume uno, y los perfiles ligados al certificado anterior dejan de
  firmar. El material antiguo sigue consultable en el historial de la
  aplicación.

### O importa los tuyos

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

El certificado y el perfil duran ~1 año. Physalis extrae su fecha de caducidad y
te avisará antes de que expire.

### Verificar antes de lanzar un pipeline

El material ya está completo. En la ficha de la aplicación, **Verificar el
material** comprueba la coherencia de lo depositado — certificado y perfil
legibles, no caducados — y luego **consulta a App Store Connect** con tu clave
de API.

Dos respuestas merecen atención. «La clave funciona pero no ve este bundle id»
significa que falta la ficha del paso 3, o que el rol de la clave es demasiado
estrecho — no que la clave sea mala. Y «Apple rechaza la clave» señala un Key ID
y un Issuer ID que no se corresponden, la confusión más frecuente al importar.

## 5. Versión y número de build

En la ficha de la aplicación — o ya en el formulario de creación del paso 1 —
ajusta la **versión** (p. ej. `1.9`) y el **último número de build publicado**
(el `CFBundleVersion` de tu última release, p. ej. `10`). Physalis servirá `11`,
`12`… automáticamente.

![Los campos Versión y Último n.º de build publicado](/tutos/es/publicar-ios-03.png)

Para una app nueva, deja el contador en **`0`**: el primer despliegue servirá
`1`.

## 6. Autorizar el pipeline (las policies)

Una app Capacitor compila primero su capa web, así que **dos** policies en el
mismo `(repo, workflow, rama)`:

- **Policy móvil** (en la app, sección «Publicación desde el CI»): workflow
  `release-ios.yml`, rama `production`.

  ![El formulario «Autorizar un pipeline» de la aplicación](/tutos/es/publicar-ios-04.png)

- **Policy de servidor** (pestaña **Policies** del proyecto): mismo workflow,
  misma rama, entorno `production` — sirve los `VITE_*` del build web.

  ![La pestaña Policies del proyecto, vínculo repo · workflow · rama → entorno](/tutos/es/publicar-ios-05.png)

Una app nativa pura solo necesita la policy móvil.

## 7. El workflow

Dos archivos que copiar del repo público y luego adaptar (cabecera
«À ADAPTER»):

- `.github/workflows/release-ios.yml` — plantilla
  [deploy-mobile-ios-capacitor.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy-mobile-ios-capacitor.modele.yml)
- `fastlane/Fastfile` — plantilla
  [fastlane.Fastfile.modele](https://github.com/physalis-cloud/physalis/blob/main/docs/fastlane.Fastfile.modele)
  (las lanes de iOS **y** Android viven en este único archivo, en la raíz del
  repo)

El workflow corre en un **runner macOS**.

### Lo que hace la ejecución

1. **Dos llamadas a Physalis, antes de compilar nada**: `/api/deploy` para los
   `VITE_*`, `/api/deploy/mobile` para el `.p12` y su contraseña, el
   `.mobileprovision` y la clave `.p8` con sus dos identificadores. Cada una con
   su propio token OIDC y cubierta por su policy.
2. **Llavero temporal**: el certificado se importa en un keychain creado para la
   ejecución y destruido al final. La plantilla comprueba de inmediato que ese
   llavero expone una identidad de firma completa — `import_certificate` no hace
   fallar la lane cuando la importación falla, y `xcodebuild` solo se daría
   cuenta más tarde, con un mensaje que no señala la causa.
3. **Perfil y firma manual**: el nombre del perfil y el Team ID se extraen del
   `.mobileprovision`, nada está codificado en duro — basta con cambiar el
   perfil en Physalis. La firma manual se escribe solo en el target `App`: un
   ajuste global rompería los pods, que no tienen perfil.
4. **Build y subida**: `xcodebuild` archiva y exporta el `.ipa`, y luego
   `upload_to_testflight` lo sube con la clave de API — sin Apple ID ni doble
   factor.
5. **Parte al registro**: la ejecución informa a Physalis del número de build,
   la pista (`testflight`) y el resultado — `subido`, o `fallido` si la
   publicación se rompió. Es lo que alimenta la pestaña **Entregas** de la
   aplicación. Un parte rechazado no hace fallar la ejecución: el `.ipa` ya está
   en Apple.
6. **Limpieza**: keychain destruido, material de firma y `.env.production`
   borrados del runner.

No se consume ningún `secrets.*` de GitHub, y ese es todo el objetivo del
montaje.

### Qué adaptar

- `VAULT_PROJECT` y `MOBILE_APP`: el slug del proyecto Physalis y el `bundleId`.
- La plantilla asume una raíz web `frontend/`: ajusta las rutas si la tuya es
  distinta.
- El paso «Configure Info.plist»: **los textos de permiso y el nombre mostrado
  son ejemplos**, sustitúyelos por los tuyos — van a Apple y se ven en la ficha
  de la tienda.
- El paso «Generate app icon»: la ruta del icono de origen.

> **Capacitor.** El proyecto nativo siempre se llama `App.xcworkspace` / scheme
> `App` (impuesto por Capacitor), y se regenera en cada build con `npx cap add`:
> todo lo que lo personaliza debe reaplicarse en cada ejecución. La plantilla ya
> lo gestiona.

### Disparo

La plantilla se lanza **manualmente** (`workflow_dispatch`), y es una decisión
deliberada: una actualización de servidor no es una publicación en una tienda.
Una publicación es asíncrona, sujeta a revisión, con número estrictamente
creciente y **sin marcha atrás** — se decide, plataforma por plataforma.

Para publicar en cada push, añade bajo `on:`:

```yaml
push:
  branches: [production]
```

En ambos casos la ejecución debe partir de la rama declarada en la policy: esta
vincula el trío `(repo, workflow, rama)`, y un lanzamiento desde otra rama se
rechaza.

### Congelar las publicaciones sin tocar el repo

Pestaña **Móvil** → la aplicación → **Pausar las publicaciones**.
`/api/deploy/mobile` responde entonces 403 a cualquier pipeline, con un rechazo
explícito, y el material de firma queda intacto; **Reanudar las publicaciones**
vuelve a abrir el grifo. Es el cortacircuitos adecuado para congelar una app:
vale para todos los repos que la apuntan, sin desactivar nada del lado de
GitHub.

![La pestaña Móvil: cada aplicación tiene su botón de pausa](/tutos/es/publicar-ios-06.png)

### Una app nativa pura (sin Capacitor)

Las plantillas facilitadas son las de una app **Capacitor**. Para una app 100 %
nativa, quita toda la parte web: la llamada a `/api/deploy`, la escritura de
`frontend/.env.production`, `npm ci`, `npm run build`, `npx cap add|sync`.
Quedan el bundle de firma, tu proyecto Xcode y `upload_to_testflight` — y una
**sola** policy, la móvil: la policy de servidor solo sirve los `VITE_*`.

## 8. Primera publicación

Este paso solo afecta al **primer** build de una app. Sáltatelo si ya está
publicada.

A diferencia de Google Play, Apple no impone ningún régimen especial al primer
build: en cuanto la ficha existe (paso 3), la subida pasa como las demás. Sin
embargo, dos detalles bloquean la **distribución a los testers** y pillan
desprevenido:

- **Conformidad de exportación.** Sin la clave `ITSAppUsesNonExemptEncryption`
  en el `Info.plist`, el build llega a TestFlight como «Missing Compliance» y
  solo es distribuible tras responder a la pregunta sobre cifrado en App Store
  Connect — en cada build. Si tu app solo usa cifrado exento (HTTPS estándar),
  añade esta línea al paso «Configure Info.plist» del workflow y la pregunta
  desaparece:

  ```bash
  plutil -replace ITSAppUsesNonExemptEncryption -bool false "$PLIST"
  ```

- **Testers.** Un build de TestFlight no llega a nadie mientras no exista un
  grupo de testers y el build no se le asigne. Se hace una vez, en la pestaña
  TestFlight.

Cuenta unos minutos de procesamiento de Apple entre el final de la ejecución y
la aparición del build. La puesta a disposición **pública** en la App Store
sigue siendo una decisión explícita: ficha completa, capturas, envío a revisión.
La plantilla se detiene en TestFlight; para ir directo a la App Store, el
`Fastfile` indica dónde sustituir `upload_to_testflight` por
`upload_to_app_store`.

## En TestFlight

La ejecución en verde deja el build en TestFlight. Lo encuentras en App Store
Connect tras unos minutos de procesamiento de Apple. El número de build se
incrementó solo en Physalis, y la entrega aparece en la pestaña **Entregas** de
la aplicación: build, pista, estado y el pipeline que la produjo.

El certificado y el perfil duran un año, así que Physalis vigila su vencimiento
y te avisará por correo a D-60, D-30 y D-7 — Apple no lo hará.

Para la versión Android, sigue el tutorial
[Publicar una app Android en Google Play](tuto:publicar-android).
