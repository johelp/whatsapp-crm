# WhatsFlow — Manual operativo del piloto

Lista de verificación y procedimientos para poner a un cliente en producción y operarlo la primera semana.
Instancia de referencia: un proyecto de Railway (app + Postgres + volumen `/data`).

## 1. Variables de entorno

| Variable | Obligatoria | Qué hace |
|---|---|---|
| `SESSION_SECRET` | Sí (producción) | Firma las sesiones. El servidor no arranca sin ella. |
| `DATABASE_URL` | Sí | Postgres (referencia al servicio `Postgres`). |
| `NODE_ENV` | Sí | `production`. |
| `WA_AUTH_PATH` | Sí | `/data/auth`: la sesión de WhatsApp debe vivir en el volumen. |
| `APP_TZ` | **Recomendada** | Zona horaria única (bot, horario silencioso anti-bloqueo, IA). Sin ella se usa la elegida en Configuración o `Europe/Madrid`. |
| `APP_NAME` | No | Nombre de marca que ve el cliente. Por defecto WhatsFlow. |
| `PUBLIC_LANDING` | No | `false` en instalaciones de clientes: la raíz va al login. Activa (por defecto) solo en la instancia comercial. |
| `ADMIN_PASSWORD` | No | Contraseña inicial del admin (solo se usa al crear la base). Si falta, se genera y se imprime **una vez** en el log. |
| `HISTORY_DAYS` / `HISTORY_MAX_PER_CHAT` | No | Tope del historial importado al vincular (30 días / 200 por chat). `0` días = no importar. |
| `BACKUP_DIR` / `BACKUP_KEEP` / `BACKUP_MAX_MB` | No | Carpeta, cantidad (7) y tamaño máximo (200 MB) de respaldos. |
| `CORS_ORIGINS` | No | Solo si el panel se sirve desde otro origen. |

## 2. Antes de escanear el QR

- [ ] `APP_TZ` definida con la zona del cliente.
- [ ] `GET /health` responde `{"status":"ok","db":true}`.
- [ ] **Cambiar la contraseña del admin** (Configuración → Equipo) y crear un usuario por operador (rol *agent*).
- [ ] Cargar etiquetas, respuestas rápidas y horarios de atención (Configuración → Conversaciones / Automatización).
- [ ] Decidir el historial: por defecto 30 días. Si el cliente no lo necesita, `HISTORY_DAYS=0`.
- [ ] IA: elegir proveedor y API key **del cliente**, definir un **tope diario de tokens** (Configuración → IA) y cargar la base de conocimiento.
- [ ] **Privacidad** (Configuración → Privacidad): aviso de IA activo y con el texto del cliente; política de consentimiento de campañas definida; plazo de **retención** decidido; pie de baja activo.
- [ ] Región del proyecto en **EU West** si hay datos de la UE; DPA de Railway aceptado (ver `docs/legal/CUMPLIMIENTO_EUROPA.md` §7).
- [ ] Probado un **borrado y una exportación** de un contacto de prueba.
- [ ] Firmado el acuerdo de piloto (`docs/legal/ACUERDO_PILOTO.md`) con la aceptación expresa del riesgo del modo no oficial.
- [ ] El cliente leyó la **Guía de uso seguro** (`/guia.html`).
- [ ] Monitor externo creado sobre `/health` (ver §5).
- [ ] Crear un primer respaldo manual (Configuración → Sistema) y descargarlo.

## 3. Día del QR

1. Usar el **teléfono del cliente** (WhatsApp o WhatsApp Business) con conexión estable. Ajustes → Dispositivos vinculados → Vincular.
2. En el panel: botón *Escanear QR* de la barra lateral. El QR expira en ~60 s.
3. Tras vincular, la importación del historial respeta el tope. Revisar `Configuración → Sistema` (cantidad de mensajes) y el log de Railway (`[Historial] Tope aplicado…`).
4. Ejecutar la **prueba de humo** (§6). Enviar un mensaje de prueba entrante y responderlo.
5. **No** lanzar campañas ni avisos masivos el primer día. Empezar por conversaciones entrantes.

## 4. Primera semana

- Día 1–3: solo conversaciones entrantes y respuestas manuales. Observar *Configuración → WhatsApp → Envíos y protección anti-bloqueo*.
- Activar la IA con **tope diario bajo** y revisar el consumo cada día (*Configuración → IA*). Probar con mensajes reales antes de dejarla sola; mantener el handoff a humano.
- Día 4–7: campañas pequeñas (decenas de contactos con consentimiento), con baja automática.
- Revisar cada día: pausas del anti-bloqueo, errores de IA, conversaciones sin asignar.
- Al final de la semana: reunión de feedback, métricas (tiempos de respuesta, volumen, costo de IA) y decisión de continuidad.

## 5. Monitoreo

- Crear en un servicio gratuito (p. ej. UptimeRobot) dos monitores HTTP:
  - `https://<instalacion>/health` — avisa si la app o la base caen.
  - `https://<instalacion>/health?strict=1` — avisa además si **WhatsApp se desconecta** (devuelve 503).
- Railway: activar notificaciones de despliegues fallidos del proyecto.
- Volúmenes: revisar mensualmente el uso (`railway volume list`). El de la base es de 5 GB; el de `/data` de 500 MB.

## 6. Prueba de humo

```bash
SMOKE_URL=https://<instalacion> SMOKE_USER=admin SMOKE_PASS='***' node scripts/smoke.js
# opcional: SMOKE_TO='+34600000000'  → además encola y cancela un aviso real
```

Verifica salud, login, protección de la API, notas, conocimiento, bloqueo SSRF, consumo de IA, anti-bloqueo, API keys, webhooks y respaldos. Limpia todo lo que crea. Correrla después de **cada despliegue** y al dar de alta a cada cliente.

## 7. Respaldos y restauración

- Automático diario (03:30 hora del servidor), últimos 7, en `/data/backups`. Manual: *Configuración → Sistema → Crear respaldo ahora*.
- ⚠ Están en el mismo volumen que la sesión: **descargar copias y guardarlas fuera de Railway** (al menos semanalmente durante el piloto). Contienen datos personales: guardarlas cifradas.
- No incluyen la API key de la IA (hay que volver a cargarla).
- Restaurar en una base vacía (con `DATABASE_URL` de destino en el entorno):
  ```bash
  node scripts/restore-backup.js whatsflow-YYYYMMDD-HHMMSS.ndjson.gz        # base vacía
  node scripts/restore-backup.js whatsflow-….ndjson.gz --force                # reemplaza lo existente
  ```
- Probar una restauración en una base de prueba **antes** de necesitarla.
- La sesión de WhatsApp no se restaura: si se pierde el volumen `/data`, hay que escanear el QR de nuevo.

## 8. Incidentes

| Situación | Qué hacer |
|---|---|
| **Sospecha de bloqueo** (un tilde, avisos de WhatsApp, pausa del anti-bloqueo) | Frenar campañas y avisos 24–72 h. No desvincular/vincular repetidamente. Revisar listas y textos. Solicitar revisión desde la app de WhatsApp. Evaluar migrar a la API oficial. |
| **WhatsApp desconectado** | Ver `/health?strict=1`. Si es 401/`loggedOut`, escanear el QR de nuevo. Si es 440, otra instancia usa el número: apagar la duplicada. |
| **App caída (502)** | `railway logs --service app`. Errores de base → revisar Postgres y espacio del volumen. Volver al despliegue anterior desde el panel de Railway si fue un cambio reciente. |
| **Base llena** | Ampliar el volumen en Railway, reducir historial (`HISTORY_DAYS`), borrar respaldos viejos. |
| **Gasto de IA inesperado** | Bajar o fijar el tope diario; revisar *Consumo* por propósito; desactivar la IA si hace falta. |
| **Pérdida de datos** | Restaurar el último respaldo (§7) y registrar el incidente. |

## 9. Cierre o devolución

Al terminar el piloto: exportar/entregar los datos que el cliente solicite, eliminar la instalación (proyecto de Railway) y los respaldos, y confirmar por escrito el borrado.
