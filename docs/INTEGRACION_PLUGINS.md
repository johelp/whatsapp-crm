# WhatsFlow — Guía para desarrollar "satélites" de conexión con plugins

> Documento pensado para pasar a las sesiones de desarrollo de **TourFlow**, **EventFlow** y **OrderFlow** (o cualquier otro sistema).
> Un **satélite** es el módulo de cada plugin que habla con WhatsFlow: envía avisos cuando ocurre algo y, opcionalmente, recibe eventos de vuelta.

---

## 1. Principios

1. **Unidireccional primero.** El plugin avisa a WhatsFlow (`POST /api/v1/notify`). Recibir eventos (webhooks) es opcional y se agrega después.
2. **Nunca bloquear al usuario.** El envío a WhatsFlow es asíncrono: un fallo de WhatsApp **no** debe romper un checkout, una reserva o una inscripción.
3. **Idempotente.** Cada aviso lleva una clave de idempotencia; reintentar no duplica mensajes.
4. **Independiente de la conexión.** WhatsFlow hoy conecta por QR (sin API oficial) y mañana podrá usar la API de Meta o Coexistence. **El contrato de esta API no cambia**: el satélite no debe saber cómo está conectado el número.
5. **Cuidar la reputación del número.** Los avisos pasan por protecciones anti-bloqueo (ver §7). Diseñá pensando en pocos mensajes, relevantes y esperados.

## 2. Arquitectura recomendada

```
Plugin (TourFlow / EventFlow / OrderFlow)
 └─ Satélite WhatsFlow
     ├─ Ajustes: URL base, API key, destinatarios, eventos activos, plantillas
     ├─ Emisores: enganchan eventos del plugin → notify()
     ├─ Cliente HTTP: timeout corto, no bloqueante, log de errores
     └─ (opcional) Receptor de webhooks: valida firma → actúa en el plugin
              │  HTTPS + Bearer wak_…
              ▼
        WhatsFlow  /api/v1/*  →  cola persistente  →  anti-bloqueo  →  WhatsApp
```

Una instalación de WhatsFlow por cliente (instalaciones separadas). Cada instalación tiene su propia URL y sus propias API keys. **El satélite se configura con la URL base y la key de la instalación del cliente.**

## 3. Autenticación

- Se crea una **API key** por sistema desde el panel de administración de WhatsFlow (`POST /api/integrations/keys`, solo admin con sesión). La key `wak_…` **se muestra una sola vez**: guardarla.
- Todas las llamadas: `Authorization: Bearer wak_xxx` (también se acepta `X-API-Key`).
- Permisos (scopes): `send` (enviar) y `read` (consultar). Por defecto ambos.
- Límite: **60 requests/minuto por key** (`429` al superarlo).
- Una key por plugin y por cliente; revocable sin afectar a las demás.
- **Seguridad:** guardar la key fuera del código (opciones cifradas / variables de entorno), nunca en el front-end ni en logs.

## 4. Endpoints (v1)

Base: `https://<instalacion>/api/v1`

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/status` | read | Estado de WhatsApp, cola y pausas anti-bloqueo (sirve para el botón "Probar conexión") |
| POST | `/notify` | send | Aviso por evento (caso principal) |
| POST | `/messages` | send | Mensaje directo a uno o varios destinos |
| GET | `/messages/:id` | read | Estado de un envío encolado |
| GET | `/groups` | read | Grupos de WhatsApp conocidos (para elegir destino) |

### 4.1 `POST /notify`

```http
POST /api/v1/notify
Authorization: Bearer wak_xxx
Content-Type: application/json
Idempotency-Key: orderflow:new_order:4833:v1

{
  "event": "new_order",
  "to": ["+393331234567", "120363025661027380@g.us"],
  "text": "🛒 Nueva orden #{{data.id}}\n{{data.customer.name}} — {{data.total}} {{data.currency}}",
  "data": { "id": 4833, "customer": { "name": "Ana" }, "total": "120.00", "currency": "EUR" }
}
```

- `event` (string): nombre del evento, snake_case. Obligatorio salvo que se envíe `text` + `to`.
- `to` (string | string[]): hasta **20** destinatarios. Acepta teléfonos en cualquier formato (`+39 333 123 4567`, `5493415550101`) o JID de grupo (`…@g.us`).
- `text` (string): plantilla. Variables `{{data.campo}}`, `{{data.lista[0].nombre}}`, `{{event}}`. Las variables inexistentes se reemplazan por vacío. Máx. 4096 caracteres.
- `data` (objeto): datos del evento para la plantilla.
- `Idempotency-Key` (header) o `dedupe_key` (body): evita duplicados. Se aplica **por destinatario**.
- **Regla en el servidor (opcional):** si el admin definió una regla para `event` (plantilla + destinatarios), se puede omitir `text` y/o `to`. **Un satélite no necesita reglas**: puede mandar siempre `text` + `to` desde sus propios ajustes.

Respuesta `202 Accepted`:

```json
{ "ok": true, "text": "🛒 Nueva orden #4833…",
  "queued": [ { "id": 101, "status": "pending", "duplicate": false, "to": "393331234567@s.whatsapp.net" } ] }
```

`duplicate: true` indica que esa clave ya existía (no se encoló de nuevo).

### 4.2 `POST /messages`

```json
{ "to": "+5493415550101", "text": "Hola, tu reserva quedó confirmada ✅" }
```

Igual que `/notify` pero sin plantillas ni eventos. Misma respuesta.

### 4.3 `GET /messages/:id`

```json
{ "id": 101, "to": "393331234567@s.whatsapp.net", "status": "sent", "attempts": 1, "error": null,
  "event": "new_order", "created_at": 1793028241760, "sent_at": 1793028249011, "message_id": "3EB0…" }
```

Estados: `pending` (esperando turno o reprogramado), `sending`, `sent`, `failed`.

### 4.4 `GET /status`

```json
{ "whatsapp": "connected", "queue_pending": 0, "sending_paused": false, "paused_reason": null, "quiet_hours_now": false }
```

`whatsapp`: `connected | connecting | qr | disconnected`. Si no es `connected`, los avisos **quedan en cola** y salen al reconectar.

### 4.5 Errores

| HTTP | Significado | ¿Reintentar? |
|---|---|---|
| 400 | Datos inválidos (destinatario, texto vacío, >20 destinos) | No: corregir |
| 401 | Key ausente, inválida o revocada | No: avisar al admin |
| 403 | La key no tiene el permiso `send`/`read` | No |
| 404 | Evento sin regla ni `text` | No |
| 429 | Límite de 60/min | Sí, con espera (backoff) |
| 5xx / timeout | Problema transitorio | Sí, con la **misma** Idempotency-Key |

## 5. Convenciones para los satélites

**Nombres de evento** (snake_case, estables; agregar, nunca renombrar):

| Plugin | Eventos sugeridos |
|---|---|
| **OrderFlow** | `new_order`, `order_paid`, `order_shipped`, `order_cancelled`, `order_refunded`, `low_stock` |
| **TourFlow** | `new_booking`, `booking_confirmed`, `booking_cancelled`, `payment_received`, `tour_reminder`, `low_availability` |
| **EventFlow** | `new_registration`, `ticket_sold`, `registration_cancelled`, `event_reminder`, `capacity_reached` |

**Clave de idempotencia:** `"<plugin>:<evento>:<id_entidad>:<version>"`, por ejemplo `tourflow:new_booking:812:v1`. Si el mismo evento puede dispararse dos veces (hooks duplicados, reintentos del cron), la clave debe ser la misma. Si una entidad cambia de estado, cambia el evento (`order_paid`) o la versión.

**`data`:** plano y estable. Incluir siempre `id`, nombre del cliente, importe y moneda, fecha y un enlace al admin del plugin. No enviar datos sensibles (tarjetas, documentos) ni más datos personales de los necesarios.

**Plantillas por defecto** (editables por el cliente en los ajustes del plugin):

```
🛒 Nueva orden #{{data.id}}
{{data.customer.name}} · {{data.total}} {{data.currency}}
{{data.admin_url}}
```
```
🧭 Nueva reserva #{{data.id}} · {{data.tour_name}}
{{data.date}} · {{data.pax}} pax · {{data.customer.name}}
```
```
🎟 Nueva inscripción · {{data.event_name}}
{{data.attendee.name}} · {{data.tickets}} entrada(s)
```

**Ajustes mínimos del satélite:** URL base, API key, botón "Probar conexión" (`GET /status`), lista de destinatarios (teléfonos y/o grupos), activar/desactivar cada evento, plantilla por evento y modo "solo logs" (no enviar).

## 6. Ejemplos de código

### 6.1 WordPress / PHP (no bloqueante)

```php
function wf_notify( string $event, array $data, string $dedupe, array $to, string $template ): void {
    $base = rtrim( get_option( 'wf_base_url' ), '/' );
    $key  = wf_get_api_key(); // desde opciones cifradas, nunca hardcodeada
    if ( ! $base || ! $key || ! $to ) { return; }

    $res = wp_remote_post( "$base/api/v1/notify", [
        'timeout'  => 5,
        'blocking' => false,           // no frena el checkout/reserva
        'headers'  => [
            'Authorization'   => "Bearer $key",
            'Content-Type'    => 'application/json',
            'Idempotency-Key' => $dedupe,
        ],
        'body' => wp_json_encode( [ 'event' => $event, 'to' => $to, 'text' => $template, 'data' => $data ] ),
    ] );
    if ( is_wp_error( $res ) ) { error_log( '[WhatsFlow] ' . $res->get_error_message() ); }
}

// Enganche (ejemplo OrderFlow / WooCommerce)
add_action( 'woocommerce_new_order', function ( $order_id ) {
    $o = wc_get_order( $order_id );
    wf_notify( 'new_order', [
        'id' => $order_id, 'customer' => [ 'name' => $o->get_formatted_billing_full_name() ],
        'total' => $o->get_total(), 'currency' => $o->get_currency(),
        'admin_url' => admin_url( "post.php?post=$order_id&action=edit" ),
    ], "orderflow:new_order:$order_id:v1", wf_recipients(), wf_template( 'new_order' ) );
} );
```

Con `blocking => false` no se ve el resultado. Para tareas críticas, enviá desde una cola/cron (Action Scheduler) con `blocking => true`, revisá el código HTTP y reintentá solo ante `429`/`5xx` con la **misma** clave.

### 6.2 Node.js

```js
async function notify(event, data, dedupe, to, text) {
  const res = await fetch(`${process.env.WF_URL}/api/v1/notify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WF_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': dedupe },
    body: JSON.stringify({ event, to, text, data }),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 429 || res.status >= 500) throw new Error('reintentar'); // misma clave
  if (!res.ok) console.error('WhatsFlow', res.status, await res.text());
}
```

## 7. Anti-bloqueo: qué implica para un satélite

WhatsFlow envía todo por una cola con protecciones. **Un aviso puede salir con demora**; no es instantáneo.

- Intervalo mínimo de varios segundos entre mensajes, con variación aleatoria.
- **Contactos "nuevos"** (nunca escribieron al número): máx. **15 por hora** y tope diario con calentamiento (20 el primer día, +10 por día, hasta 60). **Sin envíos de 21:00 a 08:00** (hora de la instalación). Los avisos quedan `pending` y salen en la siguiente ventana.
- **Conversaciones existentes y grupos:** hasta 120 por hora y 600 por día.
- Lista de bloqueo (quien responde "STOP"/"BAJA" no recibe más) y etiqueta "No contactar": el envío falla con `BLOCKED`.
- Pausa automática ante errores seguidos o señales de límite de WhatsApp.

**Recomendaciones de diseño:**

1. Los avisos internos al equipo van mejor a un **grupo** de WhatsApp (`/groups`) que a números sueltos: los grupos no cuentan como contacto nuevo.
2. Si el destino es una persona, pedirle que **escriba "hola" primero** al número de WhatsFlow: pasa a ser conversación existente y no consume el cupo de contactos nuevos.
3. Mensajes a clientes finales solo con **consentimiento** (opt-in) y relacionados con su operación (confirmaciones, recordatorios). Nada de promociones desde un satélite.
4. No enviar en bucles ni "por las dudas": un evento, un mensaje. Agrupar (resumen diario) si hay mucho volumen.
5. Esperar demoras: mostrar en el plugin "enviado a WhatsFlow" y no "entregado". Para saber el resultado real, consultar `GET /messages/:id` o usar los webhooks `message.sent` / `message.failed`.

## 8. Webhooks (WhatsFlow → plugin) — opcional

El admin registra un endpoint HTTPS (`POST /api/integrations/webhooks {"url": "...", "events": ["message.received"]}`) y recibe un `secret` (`whsec_…`, se muestra una vez).

**Formato de la entrega:**

```
POST <tu endpoint>
Content-Type: application/json
X-Webhook-Event: message.received
X-Webhook-Delivery: 5521
X-Webhook-Timestamp: 1793028241
X-Webhook-Signature: sha256=<hex>

{ "event": "message.received", "timestamp": 1793028241760, "data": { … } }
```

**Verificación (obligatoria):**
`firma = HMAC_SHA256( secret, "<X-Webhook-Timestamp>.<cuerpo crudo>" )` en hexadecimal. Comparar en tiempo constante y **rechazar timestamps con más de 5 minutos de diferencia** (anti-replay).

```php
$body = file_get_contents( 'php://input' );
$ts   = $_SERVER['HTTP_X_WEBHOOK_TIMESTAMP'] ?? '';
$sig  = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';
$calc = 'sha256=' . hash_hmac( 'sha256', "$ts.$body", WF_WEBHOOK_SECRET );
if ( abs( time() - (int) $ts ) > 300 || ! hash_equals( $calc, $sig ) ) { http_response_code( 401 ); exit; }
```

Responder `2xx` en menos de 8 s. Ante error se reintenta con backoff hasta 6 veces: el receptor debe ser **idempotente** (usar `X-Webhook-Delivery`).

**Eventos disponibles:**

| Evento | Cuándo | Campos de `data` |
|---|---|---|
| `message.received` | Llega un mensaje | `jid, phone, name, type, text, timestamp, message_id, is_group` (grupos: `group_name, sender_jid, sender_name`) |
| `message.sent` | Un aviso encolado salió | `queue_id, to, text, event, message_id` |
| `message.failed` | Un aviso no pudo enviarse | `queue_id, to, event, error, code` (`BLOCKED`, `NOT_ON_WHATSAPP`, `DUPLICATE`, …) |
| `connection.update` | Cambia la conexión | `status, code?` |
| `contact.opted_out` | Un contacto pidió la baja | `phone, jid` |
| `conversation.classified` | La IA clasificó | `jid, labels, intent, priority, sentiment, language, needs_human` |
| `conversation.assigned` | Asignación a un operador | `jid, user_id, user_name, reason` |
| `conversation.needs_human` | Hace falta una persona | `jid, …` |
| `note.changed` | Nota interna creada/editada/borrada | `jid, action, note_id, by` |
| `antiban.paused` | Se pausaron los envíos | `until, reason` |
| `webhook.test` | Prueba manual desde el panel | `message` |

**Usos típicos:** que OrderFlow responda al cliente cuando escribe "estado" (`message.received` → consultar el pedido → `POST /messages`); marcar en TourFlow que un recordatorio falló (`message.failed`); avisar al admin si `antiban.paused` o `connection.update` ≠ `connected`.

## 9. Checklist de un satélite

- [ ] Ajustes con URL base, API key (cifrada), destinatarios, eventos activos y plantillas.
- [ ] Botón **Probar conexión** (`GET /status`) y botón **Enviar mensaje de prueba**.
- [ ] Un emisor por evento, con clave de idempotencia estable.
- [ ] Timeout corto (5 s) y envío no bloqueante; el plugin funciona aunque WhatsFlow esté caído.
- [ ] Reintentos solo ante `429`/`5xx`, con backoff y la misma clave; nunca ante `400/401/403`.
- [ ] Registro de intentos y errores visible para el admin (sin exponer la key).
- [ ] Modo "solo logs" para probar sin enviar.
- [ ] (Si usa webhooks) verificación de firma y de timestamp, idempotencia por `X-Webhook-Delivery`.
- [ ] Textos revisados: breves, útiles, sin datos sensibles, con consentimiento del destinatario.
- [ ] Pruebas contra una instalación de staging de WhatsFlow, nunca contra el número de producción del cliente.

## 10. Estabilidad del contrato

- La API es **`/api/v1`**. Los cambios compatibles (campos nuevos, eventos nuevos) se agregan sin cambiar la versión: **ignorá campos desconocidos**.
- Un cambio incompatible saldrá como `/api/v2`, manteniendo v1 un tiempo.
- La **forma de conexión de WhatsApp** (QR hoy; API oficial de Meta y Coexistence más adelante) es transparente para los satélites: mismos endpoints, mismos eventos. Lo único que podría cambiar es la política de envío (por ejemplo, plantillas aprobadas para escribir primero), que se informará en este documento.

## 11. Pendiente / mejoras previstas (no disponible hoy)

- Gestión de reglas de notificación con API key (hoy requiere sesión de admin; los satélites usan `text` + `to`).
- Envío de archivos e imágenes por la API pública.
- Proveedor de conexión con la API oficial de Meta (plantillas, estados de entrega).
