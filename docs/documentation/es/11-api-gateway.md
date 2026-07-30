---
title: API Gateway
order: 11
icon: RiAppsLine
summary: Genera y gestiona claves de API para proteger tus propios servicios, con validación en tiempo real, límite de velocidad y monitorización de uso.
---

# API Gateway

El **API Gateway** de Physalis te permite proteger tus propios servicios con claves de API
generadas, validadas y monitorizadas directamente desde tu bóveda — sin infraestructura adicional.

Physalis se convierte en la única fuente de verdad para:

- Generación y revocación de claves
- Validación en tiempo real de cada petición
- Monitorización de uso por clave (logs, estadísticas, límite de velocidad)
- Rotación automática de claves con redespliegue

## Conceptos

```
Proyecto
  └── API (p. ej. "Orders API")
        ├── Claves (ApiKey)
        │     ├── Alcances (permisos)
        │     ├── Límite de velocidad
        │     └── Expiración
        └── Logs de acceso
```

Una **API** en Physalis representa uno de tus servicios a proteger. Cada
API puede tener múltiples claves — una por cliente, por entorno o por
workflow.

## Formato de clave

```
ph_live_sk_<64 caracteres hexadecimales>
```

- El prefijo `ph_` es reconocido por herramientas de escaneo de secretos
  (trufflehog, gitleaks) para detectar filtraciones accidentales.
- `live` vs `test` distingue las claves de producción de las claves de desarrollo.
- La clave en bruto nunca se almacena en la base de datos: solo se conserva su hash SHA-256.

## Crear una API

> Permisos: **EDITOR** o superior en el proyecto.

1. Abre un proyecto → pestaña **API Gateway**.
2. Haz clic en **New API**.
3. Introduce el nombre y, opcionalmente, la URL de tu servicio.
4. Elige el **modo de validación**:
   - **REMOTE** *(recomendado)* — cada petición se valida en tiempo real
     mediante Physalis. La revocación de claves tiene efecto inmediato.
   - **JWT** — las claves son tokens firmados localmente por tu servicio,
     sin llamada de red. Latencia cero, pero la revocación solo tiene
     efecto cuando el token expira.
5. Opcionalmente, define un **límite de velocidad por defecto** (peticiones por minuto) para
   todas las claves de esta API.

## Crear una clave

1. Desde la página de detalle de la API → **New key**.
2. Asígnale un nombre que identifique al consumidor (p. ej. `N8n workflow Orders`,
   `CI/CD staging`).
3. Define **alcances** si tu servicio los verifica (p. ej.
   `read:orders`, `write:products`).
4. Personaliza el límite de velocidad o la duración de expiración si es necesario.
5. La clave en bruto se te muestra **solo una vez** al crearla.
   Cópiala y guárdala en un lugar seguro.

> ⚠️ Tras cerrar la ventana, la clave en bruto es irrecuperable. Si se pierde,
> revoca la clave y crea una nueva.

## Usar una clave en tu servicio

### Modo REMOTE — llamada a Physalis en cada petición

Tu middleware envía la clave al endpoint público de Physalis para validar
cada petición entrante:

El campo **`apiId` es obligatorio**: es el identificador de TU API (visible en el
panel Gateway). Garantiza que una clave solo se acepte para la API a la que pertenece
— sin él, una clave válida destinada a otra API sería aceptada.

```http
POST https://<tu-slug>.physalis.cloud/api/gateway/verify
Content-Type: application/json

{
  "apiId": "clx...",
  "key": "ph_live_sk_...",
  "path": "/api/orders",
  "method": "GET"
}
```

Respuesta en caso de éxito:

```json
{
  "valid": true,
  "apiId": "clx...",
  "keyId": "clx...",
  "keyPrefix": "ph_live_sk_ab",
  "scopes": ["read:orders"],
  "rateLimit": {
    "limit": 100,
    "remaining": 87,
    "resetAt": 1746270060
  }
}
```

Respuesta en caso de fallo:

```json
{ "valid": false, "reason": "revoked" }
```

Los valores posibles para `reason` son: `invalid`, `revoked`, `expired`,
`rate_limited`, `api_id_required` (falta el campo `apiId` en la petición).

### Ejemplo — middleware de Next.js

```typescript
// middleware.ts
export async function middleware(req: NextRequest) {
  const key = req.headers.get("x-api-key");
  if (!key) return new Response("Unauthorized", { status: 401 });

  const res = await fetch(
    `${process.env.PHYSALIS_URL}/api/gateway/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiId: process.env.PHYSALIS_API_ID, key, path: req.nextUrl.pathname, method: req.method }),
    }
  );

  const data = await res.json();
  if (!data.valid) return new Response(data.reason, { status: 401 });

  return NextResponse.next();
}
```

### Ejemplo — nodo HTTP Request en N8n

En un nodo **HTTP Request** de N8n, añade una cabecera:

```
x-api-key: ph_live_sk_...
```

Tu endpoint de API valida la clave mediante Physalis. Puedes ver todas las llamadas
del workflow en los logs de la clave.

## Límite de velocidad

El límite de velocidad se gestiona **por clave** (no por IP). Puedes definir:

- Un **límite de velocidad por defecto** en la API (heredado por todas las claves nuevas).
- Un **límite de velocidad específico** en una clave individual (anula el anterior).

Las ventanas disponibles son `1m` (1 minuto), `1h` (1 hora) y `1d`
(24 horas).

Cuando se alcanza el límite, Physalis devuelve:

```json
{ "valid": false, "reason": "rate_limited" }
```

## Logs y monitorización

Cada llamada a `/api/gateway/verify` genera una entrada en los logs de la clave
(método, ruta, resultado, latencia). Desde la página de detalle de la API o la clave, puedes:

- Ver **estadísticas de 24h**: total de peticiones, tasa de éxito/error, desglose por hora.
- Consultar los **logs recientes** con filtro por clave o resultado.
- Identificar las **claves más activas** por volumen de uso.

## Rotación automática de claves

Puedes configurar **rotación automática** para un secreto que almacene una clave del API
Gateway. En cada rotación:

1. Physalis genera una nueva clave.
2. El valor del secreto se actualiza con la nueva clave.
3. La clave antigua se **revoca de inmediato** — cualquier validación devuelve
   `{ valid: false, reason: "revoked" }` sin demora.
4. Se activa un redespliegue mediante GitHub Actions para recargar el nuevo valor.

Para configurar la rotación:

1. Crea una clave en el API Gateway y almacena su valor como secreto
   (p. ej. `MY_SERVICE_API_KEY`).
2. Abre la rotación del secreto → estrategia **API Gateway key**.
3. Selecciona la API y la clave correspondientes.
4. Define el intervalo en días.
5. Si la clave se inyecta en **tiempo de compilación** (p. ej. `VITE_*` pasada como
   `--build-arg` de Docker), marca **"Full build required"** — Physalis activará entonces
   el workflow `deploy.yml` del proyecto en lugar del simple `redeploy.yml`, para reconstruir
   la imagen con el nuevo valor.

> ⚠️ La rotación automática solo aplica si la clave se carga desde la bóveda,
> ya sea en tiempo de ejecución mediante `.env` o en tiempo de compilación mediante `--build-arg`.
> Si la copiaste directamente en n8n, Make u otra herramienta externa,
> tendrás que actualizarla manualmente tras cada rotación.

Consulta [Rotación de secretos](rotaciones) para la configuración completa.

## Revocar una clave

Desde la página de detalle de la API → columna **Actions** → **Revoke**. La revocación
es **inmediata** en modo REMOTE: la clave queda inválida para cualquier llamada posterior
a `/api/gateway/verify`.

> La revocación queda auditada (`API_KEY_REVOKED`) y es irreversible. Para restaurar
> el acceso, crea una nueva clave.

## Eliminar una API

> Permisos: **OWNER** del proyecto únicamente.

Eliminar una API borra permanentemente todas sus claves y todos sus logs. Las entradas
en el registro global de tokens también se eliminan — todas las claves de la API
quedan inválidas de inmediato.

## Seguridad

| Aspecto                          | Implementación                                             |
|----------------------------------|------------------------------------------------------------|
| Clave nunca almacenada en texto plano | Solo hash SHA-256 en la base de datos               |
| Prefijo identificable            | `ph_` detectado por trufflehog, gitleaks                   |
| Revocación instantánea           | Eliminación del registro global token_index                |
| Límite de velocidad por clave    | Ventana fija en memoria, configurable por clave o por API  |
| Logs no bloqueantes              | Escritura asíncrona — no ralentiza la validación           |
| RBAC                             | EDITOR+ para crear/revocar, OWNER para eliminar la API     |
