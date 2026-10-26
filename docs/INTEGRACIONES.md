# Integraciones (API v1)

Crear una API key: panel admin → `POST /api/integrations/keys {"name":"toursflow"}` (la key `wak_...` se muestra una sola vez).
Todas las llamadas llevan `Authorization: Bearer wak_...`. Límite: 60 req/min por key.

## Notificar un evento (ej. nueva orden)

1. Definir la regla una vez (plantilla + destinatarios; números o JIDs de grupo `...@g.us`):

```bash
curl -X PUT $URL/api/integrations/rules/new_order -b cookie.txt -H 'content-type: application/json' -d '{
  "name": "Nueva orden",
  "template": "🛒 Nueva orden #{{data.id}}\n{{data.customer.name}} — {{data.total}} {{data.currency}}\nTour: {{data.items[0].name}}",
  "recipients": ["+393331234567", "120363025661027380@g.us"]
}'
```

2. Disparar desde el plugin cuando ocurra el evento. `Idempotency-Key` evita duplicados si el plugin reintenta:

```bash
curl -X POST $URL/api/v1/notify -H "Authorization: Bearer wak_xxx" -H 'Idempotency-Key: order-1001' \
  -H 'content-type: application/json' -d '{"event":"new_order","data":{"id":1001,"customer":{"name":"Ana"},"total":"120.00","currency":"EUR","items":[{"name":"Etna Tour"}]}}'
```

Respuesta `202` con los ids de cola; el envío es asíncrono y pasa por las protecciones anti-baneo.
Estado: `GET /api/v1/messages/:id` (`pending | sending | sent | failed`).

### Desde WordPress / WooCommerce (ToursFlow, Visit Sicily Order)

```php
function crm_notify( $event, $data, $key ) {
  wp_remote_post( 'https://TU-CRM/api/v1/notify', [
    'timeout' => 5, 'blocking' => false,
    'headers' => [ 'Authorization' => 'Bearer ' . CRM_API_KEY, 'Content-Type' => 'application/json', 'Idempotency-Key' => $key ],
    'body'    => wp_json_encode( [ 'event' => $event, 'data' => $data ] ),
  ] );
}
add_action( 'woocommerce_new_order', fn( $id ) => crm_notify( 'new_order', [ 'id' => $id /* ... */ ], "order-$id" ) );
```

## Otros endpoints

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/v1/status` | Estado de WhatsApp, cola y pausa anti-ban |
| POST | `/api/v1/messages` | `{to, text}` mensaje directo (hasta 20 destinos) |
| GET | `/api/v1/groups` | Grupos conocidos (para obtener el JID) |

## Webhooks salientes (WhatsApp → tu sistema)

`POST /api/integrations/webhooks {"url":"https://...","events":["message.received","message.failed"]}` devuelve un `secret`.
Eventos: `message.received`, `message.sent`, `message.failed`, `connection.update`, `contact.opted_out`,
`conversation.classified`, `conversation.assigned`, `conversation.needs_human`, `antiban.paused`.

Cada entrega lleva `X-Webhook-Signature: sha256=HMAC(secret, "<X-Webhook-Timestamp>.<body>")`. Reintentos con backoff (6 intentos).

## Protecciones anti-baneo (resumen)

- Cola serializada con intervalo aleatorio entre envíos; “escribiendo…” proporcional al texto.
- Contactos **nuevos** (nunca escribieron): 15/h, tope diario con calentamiento (20 + 10/día hasta 60), sin envíos de 21:00 a 08:00.
- Conversaciones existentes y grupos: 120/h, 600/día.
- Lista de bloqueo (`STOP`/`BAJA` automático + etiqueta “No contactar”), anti-duplicados, verificación de que el número existe.
- Circuit breaker: 3 errores seguidos o señal de límite de WhatsApp → pausa; lista con >40% de números inexistentes → pausa.
- **Recomendación:** para notificar a personas, que primero escriban “hola” al número del CRM (así pasan a “conversación existente”), o usar un grupo.
