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

## Generar en lugar de importar

No estás obligado a fabricar este material tú mismo. En la ficha de la
aplicación, **Generar el material de firma** lo produce dentro de la caja
fuerte: la clave privada nace donde se va a guardar, así que nunca tiene que
viajar. Disponible en todos los planes de pago, como el resto del despliegue
móvil.

**Android** — Physalis fabrica la clave de subida (par RSA + certificado, ~27
años), su contraseña y su alias: **cuatro de las cinco credenciales**. Solo te
queda la cuenta de servicio de Google Play. Esta generación no requiere ninguna
cuenta.

> ⚠️ Se trata de la **clave de subida**, la que Google puede reiniciar si
> pierdes la tuya — no de la clave de firma de la app que guarda Play App
> Signing.

**iOS** — a partir únicamente de tu **clave de API de App Store Connect**
(`.p8`, con su Key ID y su Issuer ID), Physalis encadena el par de claves, la
CSR, el certificado de distribución, el `.p12` y el perfil de aprovisionamiento:
**tres credenciales de seis**, siendo las otras tres precisamente la clave de
API que sirve de entrada.

> **Ningún Mac necesario.** Un Mac sirve para *compilar*, no para generar: una
> CSR y un `.p12` son criptografía, no Xcode. Esto es lo que de verdad sustituye
> a `fastlane match` — y el rodeo por el Llavero de macOS.

Dos límites del lado de Apple: el **App ID debe estar ya registrado** en tu
cuenta de desarrollador, y Apple limita los certificados de distribución (2 o 3
por cuenta). Regenerar **todo** consume uno y hace que los perfiles ligados al
certificado anterior dejen de firmar.

> ⚠️ **La sustitución no tiene vuelta atrás.** Physalis conserva el valor
> anterior, pero **hoy ninguna pantalla permite restaurarlo**: guarda una copia
> local de tu `.p12` y de tu perfil antes de regenerar.

### Regenerar solo el perfil

Es el caso más frecuente, y el que conviene preferir: un perfil dura un año, un
certificado también, pero **sus fechas no coinciden**. Cuando solo caduca el
perfil, regenerarlo todo consumiría un certificado para nada — y llegarías al
límite a la segunda.

**Regenerar solo el perfil** reutiliza el certificado ya en uso: no consume
ninguna plaza y no toca ni el certificado ni la clave privada. Physalis
encuentra el certificado correcto comparando **huellas**, no nombres — dos
certificados de una misma cuenta suelen llevar el mismo rótulo.

> El perfil regenerado puede mostrar la caducidad del **certificado** en lugar de
> un año: Apple limita la validez de un perfil a la del certificado que incrusta.
> No es una anomalía.

### El límite, y la revocación

**Ver los certificados de Apple** lista los certificados de distribución de la
cuenta y marca el que está **en uso** — aquel cuya clave privada está en la caja
fuerte y, por tanto, el que firma tus builds. Sin ese dato, revocar es jugar a
los dados.

Al llegar al límite hay que revocar antes de generar. **Revocar** llama a la API
de Apple por ti, desde Physalis, y lo registra en el diario de auditoría: es lo
que sustituye al `match nuke` de fastlane, conservando la traza.

> ⚠️ Physalis **se niega** a revocar el certificado en uso, y solo lo hace tras
> una confirmación explícita. Hacerlo igualmente rompe tus publicaciones hasta
> que se genere un certificado nuevo. La entrada de auditoría lleva entonces
> `forced: true`: es la traza que hay que buscar el día en que una firma falle
> sin motivo aparente.

## Verificar el material

**Verificar el material** responde a «¿esto va a funcionar?» antes de gastar
diez minutos de CI. La comprobación tiene dos tiempos: la coherencia de lo
depositado y luego una **consulta real a las tiendas**.

| Grupo | Qué se comprueba |
|---|---|
| Integridad | ¿están todas las credenciales necesarias? |
| Keystore | legible con la contraseña dada, alias declarado realmente presente, contraseña de clave coherente |
| Certificado / Perfil | legibles, no caducados, vencimiento conocido |
| Google Play | la cuenta de servicio existe, está invitada a la consola y puede publicar **esta** aplicación |
| App Store Connect | la clave se acepta y **ve** este bundle id |

Esas dos últimas filas son las que ahorran tiempo: distinguen «clave inválida»
de «clave válida pero no invitada a la consola», y «aplicación desconocida para
Apple» de «rol demasiado estrecho». Un `permission denied` al fondo del log de
un pipeline no hace ninguna de esas distinciones.

## Vigilar la caducidad

Un certificado de distribución de Apple dura un año, un perfil de
aprovisionamiento también — y **ni Google, ni Apple, ni tu forja envían un aviso
utilizable** al respecto. Caducan un viernes de release.

Physalis lee el vencimiento al importar (o al generar) y avisa por correo a los
**propietarios de la organización** a **D-60, D-30, D-7** y luego al caducar.
Tres avisos y no uno solo porque el remedio no es el mismo: a 60 días se
planifica, a 30 se actúa, a 7 ya se va tarde. La pestaña Móvil muestra en
paralelo un aviso en la aplicación afectada.

El recordatorio se envía **una sola vez por umbral**: la comprobación se ejecuta
a diario sin inundar los buzones, y un vencimiento aplazado (material renovado)
rearma el mecanismo limpiamente. Un proyecto con la pestaña Móvil desactivada no
genera ningún aviso — has dicho que ya no publicas desde ahí.

## El registro de entregas

La pestaña **Entregas** de una aplicación responde a «qué versión está en
revisión, cuál está publicada, quién la subió y con qué material» — una pregunta
cuya respuesta suele vivir en tres consolas y un hilo de chat.

Una fila se escribe en dos momentos, y la distinción es el núcleo del diseño:

- **lo que Physalis constata** — al entregar el material: número de build
  consumido, huellas del material servido, identidad OIDC del pipeline. Esa
  mitad no puede mentir;
- **lo que el pipeline informa** — pista y estado, mediante
  `POST /api/deploy/mobile/report`, con el mismo token OIDC y la misma policy
  que el bundle. Declarativo por naturaleza.

Los estados van de `material servido` a `publicado`, pasando por `subido`, `en
proceso`, `en revisión`, `suspendido`, `rechazado` y `fallido`. Una fila que se
queda en `material servido` no es un fallo: dice que alguien obtuvo material de
firma y no publicó nada — justo lo que un registro debe mostrar.

> **Physalis no guarda el artefacto.** Una entrega es un **parte fechado**, no
> una prueba de que exista un binario ni de que una tienda lo haya aceptado. El
> registro señala además las entregas firmadas con material **ya sustituido**:
> ese build no se reproducirá igual.

Las plantillas de workflow incluidas llaman a `/report` al final de la
ejecución, incluso cuando esta falla — un fallo posterior a la entrega del
material es precisamente lo que quieres ver.

### ⚠️ «Publicado» significa «publicado en el canal», no «aprobado»

Dos límites de API que conviene conocer, porque parecen errores:

- **Google Play no expone en ninguna parte el estado de la revisión.** Una
  versión puede estar `completed` en su canal — y por tanto aparecer aquí como
  **publicada** — y haber sido **rechazada** por la revisión de conformidad de
  Play. Solo la consola lo muestra. No existe ningún endpoint para leerlo; en
  caso de duda, manda la Play Console.
- **En Apple, `VALID` significa «binario procesado»**, no «a la venta». La
  revisión y la puesta a la venta están en otra parte de la API, que Physalis no
  lee — por eso mostramos `subido`, nunca `publicado`, en lugar de anunciar una
  puesta a la venta que no hemos constatado.

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

## Proyecto nativo o híbrido: el delta

Se incluyen cuatro plantillas, dos por plataforma:

| Proyecto | Plantillas |
|---|---|
| **Híbrido** (Capacitor, Cordova, Ionic) | `deploy-mobile-android-capacitor.modele.yml`, `deploy-mobile-ios-capacitor.modele.yml` |
| **Nativo** (Gradle/Kotlin, Xcode/Swift) | `deploy-mobile-android-native.modele.yml`, `deploy-mobile-ios-native.modele.yml` |

Un **único `fastlane/Fastfile`** sirve para las cuatro: lo que separa a las dos
familias es lo que hace el *workflow* antes de llamar a la lane, no la lane.

⚠️ **Las plantillas Capacitor han publicado de verdad** (Google Play y TestFlight,
desde el CI, sin secretos). Las nativas son su transposición y **aún no se han
ejecutado** en condiciones reales: su cabecera lo indica. Las partes sensibles
(obtención del bundle, verificación de huella, aviso de entrega, lane de
fastlane) se reutilizan tal cual; lee los dos puntos siguientes antes del primer
run.

### Lo que el nativo hace de menos

- **Ninguna llamada a `/api/deploy`.** Sin capa web no hay secretos de compilación
  que inyectar: basta con **una sola policy móvil** (véase la sección anterior).
- **Ni `npm ci` ni `npx cap sync`.** El proyecto nativo está en tu repositorio,
  versionado; no se regenera en cada compilación.
- **Ninguna etapa de iconos ni de permisos.** Viven en el proyecto, en git.

### El punto que de verdad cambia: la versión

Physalis manda sobre el número de build, pero **la forma de aplicarlo difiere**,
y no es cosmético.

**Android.** Las plantillas parchean el `build.gradle` del módulo de aplicación y
luego **releen el archivo** para comprobar que la sustitución ha surtido efecto.
La plantilla nativa acepta ambas sintaxis: `versionCode 12` (Groovy) y
`versionCode = 12` (DSL de Kotlin). Si tu proyecto **calcula** su versión (número
de commits, archivo de propiedades, plugin de versionado), la sustitución no
encontrará nada: el workflow se detiene y lo dice, en lugar de publicar un número
erróneo. Sustituye entonces esa etapa por lo que tu proyecto espere.

**iOS.** Aquí es donde ambas familias más divergen:

- **Capacitor** genera un `Info.plist` con valores **literales**, que `agvtool` no
  sabe leer. Por eso la plantilla escribe directamente con `plutil -replace`.
- **Un proyecto Xcode nativo** escribe `CFBundleVersion = $(CURRENT_PROJECT_VERSION)`
  y guarda el valor en sus *build settings*. Poner ahí un literal con `plutil`
  **desconectaría el plist de los ajustes del proyecto**: el número realmente
  incrustado volvería a ser el de los build settings en la siguiente compilación.
  La plantilla nativa usa por tanto `agvtool new-version -all`, que es el método
  correcto aquí.

⚠️ `agvtool` exige el versionado **«Apple Generic»** (`VERSIONING_SYSTEM =
apple-generic`), que es el valor por defecto de los proyectos Xcode recientes. La
plantilla lo comprueba **antes** de compilar y se detiene si no es el caso: una
compilación de 20 minutos que acaba en un rechazo por «redundant build version»
cuesta más que un fallo inmediato.

### Qué hay que adaptar

En ambas plantillas nativas, un recuadro `À ADAPTER POUR VOTRE PROJET` enumera las
variables: identificador de la app, módulo Gradle (`app` por convención), carpeta
del proyecto Xcode y nombre del *scheme*.

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
