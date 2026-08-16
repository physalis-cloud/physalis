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
- Una **cuenta de desarrollador de Google Play** — alta en
  [play.google.com/console/signup](https://play.google.com/console/signup),
  25 $ una vez.

> **Ábrela lo primero.** Es lo único de esta guía que no se resuelve en el día,
> y el resto esperará sin ti. Al darte de alta eliges entre una cuenta
> **personal** y una de **organización**: ese es el nombre que aparecerá bajo la
> app en la tienda. Google verifica la identidad de los nuevos desarrolladores,
> y una cuenta de organización exige además un número **D-U-N-S** — el mismo
> identificador que pide Apple — cuya asignación tarda de unos días a varias
> semanas según el país. Si tu empresa ya tiene uno, compruébalo antes de pedir
> otro.

![El despliegue móvil activado en los ajustes del proyecto](/tutos/es/publicar-android-01.png)

> **¿App ya publicada o recién creada?** Ambas funcionan. Solo una cosa no pasa
> por la API: **crear la ficha** de la aplicación en la Play Console (paso 3). El
> primer AAB sí sale del pipeline como todos los demás — de eso trata el paso 8.
> Es incluso el orden más seguro: Play App Signing registra la clave de subida a
> partir de la clave que firma la **primera** release. Un primer AAB subido a
> mano con un keystore distinto del que guarda Physalis condena todas las
> ejecuciones posteriores.

## 1. Crear la aplicación en Physalis

Pestaña **Móvil** del proyecto → **Nueva aplicación**:

- **Plataforma**: Android
- **applicationId**: el identificador del paquete, en reverse-DNS (p. ej.
  `com.ejemplo.miapp`)
- **Nombre**: una etiqueta legible
- (opcional) **Grupo**: para ordenar dev/staging/prod

![Formulario de creación de una aplicación Android](/tutos/es/publicar-android-02.png)

Los campos **Versión** y **Último n.º de build publicado** del mismo formulario
son el objeto del paso 5 — déjalos tal cual por ahora.

## 2. El keystore

Dos caminos. El primero no necesita ninguna herramienta.

### Deja que Physalis lo genere

En la ficha de la aplicación, **Generar el material de firma**. Physalis fabrica
la clave de subida (par RSA + certificado, ~27 años), su contraseña y su alias,
y los guarda cifrados: **cuatro de las cinco credenciales** quedan puestas de
una vez. La clave privada se crea dentro de la caja fuerte, así que nunca tiene
que viajar. Este paso no requiere ninguna cuenta; solo quedará la cuenta de
servicio de Google Play, en el paso 4.

> ⚠️ Se trata de la **clave de subida**, la que Google puede reiniciar si la
> pierdes — siempre que Play App Signing esté activo. No de la clave de firma de
> la app, que se queda en Google.

### O importa el tuyo

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
| Cuenta de servicio de Google Play | el JSON del paso 4 |

> ⚠️ La contraseña introducida al importar el keystore solo sirve para **leer la
> fecha de caducidad** — no se conserva. Impórtala **también** como credencial
> «Contraseña del keystore». Sin los tres textos, la firma fallará.

## 3. Crear la ficha en la Play Console

Lo único que la API no sabe hacer: trabaja sobre un `packageName` que ya existe,
no crea aplicaciones. Salta este paso si tu app ya está publicada.

1. [play.google.com/console](https://play.google.com/console) → **Crear
   aplicación**. Nombre, idioma predeterminado, aplicación o juego, gratuita o
   de pago.
2. La consola **no pide** el identificador del paquete: es el **primer AAB
   subido** el que fija el `applicationId`, de forma definitiva. Razón de más
   para dejar que salga del pipeline, con el `applicationId` declarado en el
   paso 1.
3. Rellena **Contenido de la aplicación**: política de privacidad, acceso a la
   app, anuncios, clasificación del contenido, público objetivo, seguridad de
   los datos. Mientras falte alguno, ninguna release puede enviarse a revisión —
   la subida en sí ya funciona.

La app seguirá figurando como **borrador** hasta su primera release revisada: es
lo esperado en este punto, el paso 8 se encarga.

## 4. La cuenta de servicio de Google Play

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
> cuenta. Un `permission denied` justo después es normal — la verificación de
> abajo te dirá cuándo ha pasado.

Por último importa el JSON en Physalis (app → Cuenta de servicio de Google Play)
y **elimina la copia local del archivo** — es un secreto.

### Verificar antes de lanzar un pipeline

El material ya está completo. En la ficha de la aplicación, **Verificar el
material** comprueba primero la coherencia de lo depositado — keystore legible
con su contraseña, alias declarado realmente presente — y luego **consulta a
Google Play** qué puede hacer de verdad tu cuenta de servicio.

Ahí se leen, en dos segundos, los tres casos que un `permission denied` al final
del pipeline no distingue: clave inválida, clave válida pero cuenta de servicio
no invitada a la Play Console, o invitada pero sin derecho sobre **esta**
aplicación. Mejor saberlo antes de diez minutos de build.

## 5. Versión y número de build

En la ficha de la aplicación — o ya en el formulario de creación del paso 1 —
ajusta la **versión** (p. ej. `1.4`) y el **último número de build publicado**
(el `versionCode` de tu última release, p. ej. `4`).
Physalis servirá `5`, `6`… automáticamente en cada despliegue.

![Los campos Versión y Último n.º de build publicado](/tutos/es/publicar-android-03.png)

Para una app nueva, deja el contador en **`0`**, como arriba: el primer
despliegue servirá `1`.

## 6. Autorizar el pipeline (las policies)

Una app Capacitor compila primero su capa web, así que **dos** policies en el
mismo `(repo, workflow, rama)`:

- **Policy móvil** (en la app, sección «Publicación desde el CI»): workflow
  `release-android.yml`, rama `production`.

  ![El formulario «Autorizar un pipeline» de la aplicación](/tutos/es/publicar-android-04.png)

- **Policy de servidor** (pestaña **Policies** del proyecto): mismo workflow,
  misma rama, entorno `production` — sirve los `VITE_*` del build web.

  ![La pestaña Policies del proyecto, vínculo repo · workflow · rama → entorno](/tutos/es/publicar-android-05.png)

Una app nativa pura solo necesita la policy móvil.

## 7. El workflow

Dos archivos que copiar del repo público y luego adaptar (cabecera
«À ADAPTER»):

- `.github/workflows/release-android.yml` — plantilla
  [deploy-mobile-android-capacitor.modele.yml](https://github.com/physalis-cloud/physalis/blob/main/docs/deploy-mobile-android-capacitor.modele.yml)
- `fastlane/Fastfile` — plantilla
  [fastlane.Fastfile.modele](https://github.com/physalis-cloud/physalis/blob/main/docs/fastlane.Fastfile.modele)
  (las lanes de iOS **y** Android viven en este único archivo, en la raíz del
  repo)

### Lo que hace la ejecución

1. **Dos llamadas a Physalis, antes de compilar nada**: `/api/deploy` para los
   `VITE_*`, `/api/deploy/mobile` para el keystore, sus contraseñas y la cuenta
   de servicio. Cada una con su propio token OIDC y cubierta por su policy. Una
   configuración incompleta falla aquí mismo, en segundos.
2. **Comprobaciones inmediatas**: plataforma de la app servida, credenciales
   vacías, alias realmente presente en el keystore. Sin ellas, un error de
   configuración solo aparecería tras ~5 min de build, en un mensaje de gradle
   que no lo señala.
3. **Build**: `npm run build` (Vite lee `frontend/.env.production`),
   `npx cap sync`, aplicación del `versionCode`/`versionName` servidos por
   Physalis, iconos, permisos del manifiesto.
4. **Firma y subida**: gradle firma con el keystore recuperado, mediante
   propiedades `android.injected.signing.*` — no se escribe nada en el repo — y
   luego `fastlane supply` sube el AAB.
5. **Parte al registro**: la ejecución informa a Physalis del número de build,
   la pista y el resultado — `subido`, o `fallido` si la publicación se rompió.
   Es lo que alimenta la pestaña **Entregas** de la aplicación. Un parte
   rechazado no hace fallar la ejecución: el AAB ya está en Google.
6. **Limpieza**: material de firma y `.env.production` borrados del runner.

No se consume ningún `secrets.*` de GitHub, y ese es todo el objetivo del
montaje.

### Qué adaptar

- `VAULT_PROJECT` y `MOBILE_APP`: el slug del proyecto Physalis y el
  `applicationId`.
- La plantilla asume una raíz web `frontend/`: ajusta las rutas si la tuya es
  distinta.
- Los pasos «Generate app icons» y «Add permissions to AndroidManifest» son
  propios de tu app.

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

![La pestaña Móvil: cada aplicación tiene su botón de pausa](/tutos/es/publicar-android-06.png)

### Una app nativa pura (sin Capacitor)

Las plantillas facilitadas son las de una app **Capacitor**. Para una app 100 %
nativa, quita toda la parte web: la llamada a `/api/deploy`, la escritura de
`frontend/.env.production`, `npm ci`, `npm run build`, `npx cap add|sync`.
Quedan el bundle de firma, tu build de gradle y `fastlane supply` — y una
**sola** policy, la móvil: la policy de servidor solo sirve los `VITE_*`.

## 8. Primera publicación

Este paso solo afecta a la **primera** subida de un paquete. Sáltatelo si la app
ya está publicada.

Mientras una aplicación nunca se ha publicado, la Play Console la considera un
**borrador**, y la API añade dos reglas:

- se rechaza toda release que no sea `draft` — `Only releases with status draft
  may be created on draft app`;
- el edit no puede enviarse a revisión por sí solo — `Changes cannot be sent for
  review automatically. Please set the query parameter changesNotSentForReview
  to true`.

La plantilla resuelve ambas: lanza el workflow con **`first_release` marcado**.
La ejecución compila y sube el AAB igual que siempre, como release *draft* — ese
AAB es el que fija el `applicationId` del paquete y registra tu clave de subida
en Play App Signing.

Queda entonces **un solo gesto humano, una vez en la vida del paquete**: Play
Console → tu app → **Enviar a revisión**. Mientras la app sea un borrador, los
testers no reciben nada, haga lo que haga el pipeline.

Una vez fuera del borrador, relánzalo **sin** marcar `first_release`: las
publicaciones siguientes son totalmente automáticas.

> **¿Olvidaste marcarlo en la primera ejecución?** El error llega después del
> build, ~5 min más tarde, y no cuesta nada: márcalo y relanza. El `versionCode`
> servido por Physalis simplemente habrá avanzado uno — un número de build debe
> crecer, no ser contiguo.

## Publicado

La ejecución en verde deja el AAB en tu pista de prueba. Compruébalo en la Play
Console. El número de build se incrementó solo en Physalis, y la entrega aparece
en la pestaña **Entregas** de la aplicación: build, pista, estado y el pipeline
que la produjo.

Physalis vigila además el vencimiento del keystore y te avisará por correo a
D-60, D-30 y D-7 — ni Google ni GitHub lo harán.

Para la versión iOS, sigue el tutorial
[Publicar una app iOS en la App Store](tuto:publicar-ios).
