# Prompt para generar la página de venta

Pegalo tal cual en tu generador (Claude, v0, Lovable, Framer AI, etc.). Reemplazá lo que está entre `[corchetes]` (el nombre de la marca es **WhatsFlow**).
Los **hechos** de abajo reflejan lo que el producto hace hoy; no agregues funciones que no estén listadas.

---

Creá una landing page de venta, en español rioplatense neutro, de una sola página, responsive (mobile first), con modo claro/oscuro automático, accesible (contraste WCAG AA, foco visible, `prefers-reduced-motion`) y rápida (sin librerías pesadas; HTML/CSS autocontenido o Tailwind).

## Producto
**WhatsFlow**: un CRM de WhatsApp multiagente en **marca blanca**. Público: negocios con equipo de atención (turismo, retail, servicios, e-commerce) y agencias que lo revenden.

## Mensaje principal
"Todo tu equipo atendiendo desde un solo WhatsApp, con IA y conectado a tus sistemas."

## Hechos (usar solo estos)
**Atención**
- Bandeja multiagente: asignación manual y automática (por carga, por turnos o por etiqueta), estados (abierto/pendiente/resuelto), aviso de quién ve cada chat, escritura en vivo.
- Notas internas por cliente (las ve el equipo, nunca el cliente), con notas fijadas sobre el chat.
- Etiquetas, respuestas rápidas con "/", biblioteca de archivos (PDF/imágenes), grupos de WhatsApp, contactos con importación CSV.
- Respuesta automática fuera de horario que recoge nombre, email y motivo.
- Campañas masivas con personalización, variación de texto y baja automática ("STOP"/"BAJA").

**IA** (proveedor a elección con la API key del cliente: OpenAI, Anthropic, Gemini, Groq; cada función se activa por separado)
- Transcripción de audios entrantes.
- Clasificación automática: intención, prioridad, sentimiento, idioma y etiquetas; destaca casos urgentes o molestos.
- Base de conocimiento: notas diarias, archivos (PDF/txt/md/csv) o **cargar desde una URL**; la IA responde solo con ese conocimiento y deriva a una persona si no sabe.
- Derivación a humano cuando el cliente lo pide.

**Integraciones**
- API REST con API keys revocables: `POST /api/v1/notify` para disparar avisos por evento (ej. "nueva orden" → notificar a N números o grupos) con plantillas y variables.
- Cola persistente con reintentos e idempotencia (sin duplicados).
- Webhooks firmados (HMAC) para mensaje recibido/enviado/fallido, asignación, nota, etc.

**Protección anti-bloqueo**: cola con intervalos naturales, topes más bajos para contactos nuevos, calentamiento progresivo, horario silencioso, pausa automática ante errores o listas de baja calidad, lista de bloqueo. *Reduce el riesgo; nunca prometas "0 bloqueos" ni "100% seguro".*

## Formas de conexión (sección obligatoria y destacada)
Debe quedar clarísimo que hay **dos familias: sin API oficial y con API oficial**:
1. **Sin API oficial (QR) — DISPONIBLE HOY.** Se vincula el número escaneando un QR como WhatsApp Web. Rápido, sin plantillas, sin costo de Meta. Riesgo de bloqueo mayor por ser canal no oficial.
2. **API oficial de Meta (WhatsApp Business Platform / Cloud API) — PRÓXIMAMENTE.** Canal homologado, plantillas aprobadas, números verificados, ideal para escalar; costo por conversación de Meta.
3. **Coexistence — PRÓXIMAMENTE.** API oficial + app WhatsApp Business en el celular sobre el mismo número.
- Incluir una tabla comparativa (estado, puesta en marcha, escribir primero, costo, riesgo de bloqueo, uso del celular).
- Mensaje clave: "Empezás hoy con QR y, cuando crezcas, pasás a lo oficial sin cambiar de sistema."
- Marcar con etiquetas visibles "Disponible hoy" vs "Próximamente". No presentar lo próximo como disponible.

## Estructura
1. Hero (titular, subtítulo, 2 CTA: "Pedir demo" y "Ver formas de conexión", badges de conexión, maqueta de la bandeja).
2. Formas de conexión (3 tarjetas + tabla + aviso honesto sobre bloqueos).
3. Funciones para el equipo (6 tarjetas).
4. IA (4 tarjetas).
5. Integraciones (explicación + ejemplo de código `curl` a `/api/v1/notify`).
6. Cómo empezar (4 pasos).
7. Preguntas frecuentes (¿necesito API oficial?, ¿me pueden bloquear?, ¿sigo usando el celular?, ¿marca blanca?, datos y API keys, precio).
8. CTA final + pie con aclaración: "WhatsApp es marca de Meta Platforms, Inc.; este producto no está afiliado ni respaldado por Meta."

## Tono y restricciones
- Claro, concreto, sin hype. Beneficio primero, función después. Frases cortas.
- Sin precios inventados ("Escribinos y armamos una propuesta").
- Sin testimonios, logos de clientes ni cifras inventadas.
- Sin logos ni marcas de terceros salvo la mención de WhatsApp/Meta en el pie.
- Iconos SVG, no emojis como iconos de interfaz.
- Contacto: [email], [WhatsApp de ventas].
- Entregá un único `index.html` listo para publicar.
