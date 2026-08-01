---
title: Bóvedas
order: 5
icon: RiSafe2Line
summary: Bóveda personal, bóvedas de equipo, TOTP para sitios de terceros.
---

# Bóvedas

Las **bóvedas** (`Vault`) se utilizan para almacenar credenciales que **no son**
variables de entorno en tiempo de ejecución — típicamente credenciales de acceso web
(Bitwarden, AWS Console, panel de Stripe, panel de control de OVH…).

En Physalis existen tres niveles de bóveda:

| Bóveda              | Visibilidad                          | Caso de uso                                          |
|---------------------|--------------------------------------|------------------------------------------------------|
| **Personal**        | Solo tú                              | Tu acceso personal, BDs locales, elementos personales |
| **Equipo (org)**    | Miembros añadidos a la colección     | Acceso compartido entre los responsables técnicos de una org |
| **Equipo (proyecto)** | Miembros del proyecto (`ProjectMember`) | Acceso vinculado a un proyecto específico         |

Todas las bóvedas utilizan el mismo cifrado AES-256-GCM del lado del servidor
que los secretos del proyecto.

## Bóveda personal

Accesible mediante **🔒 Bóveda personal** en la navegación del panel, en la URL
`/vault`. Nadie más que tú puede leer tus entradas — ni siquiera los
OWNERs de tu organización.

### Los cuatro tipos de entrada

No todo es una credencial de un sitio web. El diálogo de creación empieza
por un selector de **tipo**, y el formulario se adapta:

| Tipo            | Qué contiene                                      | Ejemplo                          |
|-----------------|---------------------------------------------------|----------------------------------|
| **Credencial**  | URL *(opcional)*, usuario, contraseña, código 2FA | Consola AWS, Gmail               |
| **Secreto**     | Un único valor                                    | Clave de API, número de licencia |
| **Lista**       | Varias etiquetas + valores                        | Preguntas secretas del banco     |
| **Nota**        | Un texto libre                                    | Procedimiento de recuperación    |

Solo el tipo **Credencial** lleva una URL — por eso es el único que la
extensión de navegador propone para el autorrelleno. Los otros tres
siguen siendo legibles desde el sitio.

En una **Lista**, las etiquetas se cifran igual que los valores: la
búsqueda no las cubre y la lista muestra simplemente "N secretos".

### Crear una entrada

1. Haz clic en **"+ Añadir"** en `/vault`.
2. Elige el tipo y luego rellena:
   - **Nombre** — etiqueta corta (p. ej. "AWS prod Console"), común a todos los tipos
   - **URL** — sitio web asociado (usado por la extensión de navegador para
     la coincidencia de dominio)
   - **Usuario** — login / correo electrónico
   - **Contraseña** — puede generarse con el **🎲 generador** integrado
     (longitud, símbolos y exclusión de caracteres ambiguos son configurables)
   - **TOTP** *(opcional)* — clave `otpauth://...` para generar códigos 2FA
     para el sitio de terceros (ver más abajo)
3. **Colección**, **etiquetas** y **★ favorito** están en la última fila
   del formulario.

### Cambiar el tipo de una entrada existente

El selector de tipo sigue activo al editar, pero **solo se ofrecen las
conversiones que no pierden nada**. En la práctica: una entrada que solo
tiene un nombre y una contraseña puede convertirse en Secreto, Lista o
Nota — su valor se traslada automáticamente. Si la entrada todavía lleva
una URL, un usuario o un código 2FA, el tipo de destino aparece
atenuado: quita el campo que estorba y guarda antes de convertir.

Una Lista con varios secretos no se convierte a nada: vacíala primero si
quieres cambiar su forma.

### Generador de contraseñas

El botón 🎲 abre un generador universal con:

- Longitud (8 → 64 caracteres)
- Incluir / excluir: mayúsculas, minúsculas, números, símbolos
- Excluir caracteres ambiguos (`0`/`O`, `1`/`l`/`I`)

La contraseña generada se inserta directamente en el campo — puedes
regenerarla hasta quedar satisfecho antes de guardar.

## Bóvedas de equipo

### Bóveda de equipo a nivel de organización

En la página de la org → pestaña **🔒 Bóvedas**. Permite crear una **colección**
(p. ej. "Acceso admin clientes") y añadir entradas compartidas con un subconjunto
seleccionado de miembros.

#### Crear una colección

> Permisos: ADMIN / OWNER de la org.

1. Haz clic en **"+ Nueva colección"**.
2. Rellena:
   - **Nombre** de la colección
   - **Miembros** iniciales (de la lista de miembros de la org)
3. Envía. Todos los miembros añadidos pueden ahora ver la colección
   y crear / leer entradas en ella.

#### Añadir / eliminar un miembro

Dentro de la colección → pestaña **"Miembros"** → añadir mediante desplegable,
eliminar mediante el botón **"Revocar"**.

> ⚠️ **Revocar no re-cifra** las entradas existentes. El miembro revocado
> ya no tiene una sesión válida para leer las entradas, pero debes tratar
> las credenciales como **potencialmente comprometidas** si pudo haberlas
> exfiltrado durante su acceso. Rota todo lo que sea sensible.

### Bóveda de equipo a nivel de proyecto

Mismo principio, pero con alcance a un proyecto: página del proyecto →
pestaña **🔒 Bóveda** → colección visible para los `ProjectMember`s.

El **RBAC se hereda** automáticamente: no es necesario gestionar una lista de
miembros separada — cualquier persona con un rol en el proyecto tiene acceso a la
bóveda del proyecto (acceso de lectura para VIEWER, acceso de escritura para EDITOR/OWNER).

## TOTP para sitios de terceros

Si almacenas la clave `otpauth://...` de un sitio en una entrada de bóveda,
Physalis genera automáticamente **códigos TOTP de 6 dígitos** cada 30 segundos
(RFC 6238).

### Introducir una clave TOTP

El campo TOTP pertenece al tipo **Credencial** — el único que representa una
cuenta en un sitio.

Cuando activas el 2FA en un sitio externo, obtienes un código QR
o una cadena `otpauth://totp/...?secret=XXXX&...`. Pega esa cadena
en el campo **TOTP** de la entrada:

- Cadena `otpauth://` completa → analizada automáticamente (cuenta, emisor,
  algoritmo, período)
- O solo el secreto en base32 (`JBSWY3DPEHPK3PXP`) → período/algoritmo predeterminados

### Leer el código

En la entrada, el código de 6 dígitos se muestra con una **cuenta regresiva** de los
segundos restantes. Haz clic en él para copiarlo al portapapeles.

La **extensión de navegador** ([→ Extensión de navegador](browser-extension))
va más lejos: completa automáticamente los campos `autocomplete="one-time-code"` en
sitios web sin necesidad de copiar y pegar manualmente.

## Mover una entrada personal → equipo o cuenta de proyecto

Si has creado una entrada personal que debería compartirse o vincularse a un
proyecto:

1. En la entrada personal → haz clic en **"Mover"**.
2. Elige el destino:
   - una **colección de equipo** (org o proyecto) a la que pertenezcas;
   - o una **Cuenta de proyecto** (pestaña *Acceso*) — la entrada se convierte en
     una cuenta de aplicación. ⚠️ El usuario y la contraseña se conservan, pero la
     **URL y el 2FA (TOTP) no se trasladan** (las cuentas no tienen esos campos);
     un aviso te lo recuerda.
3. Envía. La entrada queda **re-cifrada y movida de forma atómica** — desaparece
   de tu bóveda personal y aparece en el destino elegido.

Solo los tipos **Credencial** y **Secreto** se pueden mover: su contenido cabe
por completo en una entrada de equipo. Las **Listas** y las **Notas** aún no
tienen equivalente en la bóveda de equipo — el botón «Mover» no aparece en
ellas, en lugar de vaciarlas en silencio.

## Importar desde otro gestor

El botón **«Importar»** de la bóveda personal acepta una exportación CSV de
**Bitwarden**, de **Chrome** o un CSV genérico. Las carpetas de Bitwarden se
convierten en colecciones. Se muestra una vista previa antes de guardar nada.

Se importan las credenciales y las **notas seguras** de Bitwarden (que pasan a
ser entradas de tipo Nota). Las tarjetas y las identidades se omiten: ningún
tipo de la bóveda las representa.

## Leer entradas desde la extensión de navegador

La extensión de Physalis (Chrome / Firefox, ver
[Extensión de navegador](browser-extension)) lee las 3 fuentes de bóveda
simultáneamente:

- Bóveda personal
- Bóvedas de equipo (org)
- Bóvedas de equipo (proyecto)

En el sitio visitado, sugiere credenciales que coincidan con el dominio
(a través de las URLs almacenadas en las entradas). Solo las entradas de tipo
**Credencial** entran en juego — son las únicas que llevan una URL. Tus
Secretos, Listas y Notas siguen siendo consultables desde el sitio, pero nunca
se ofrecen para autocompletar.

## Más información

- [Extensión de navegador](browser-extension) — autocompletado y guardado automático
  de entradas de bóveda en la web
- [Comparticiones](comparticiones) — envía una entrada a un tercero sin compartirla permanentemente
