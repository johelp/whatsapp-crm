# WhatsApp CRM v2

Panel de gestión de WhatsApp multi-agente con bandeja compartida, agente IA, campañas masivas, grupos, auto-respuesta y trazabilidad completa de todos los mensajes.

> **Demo en producción:** https://whatsapp-crm-production-5810.up.railway.app

---

## Características principales

### Bandeja y mensajes
- **Multi-agente en tiempo real** — múltiples operadores ven y responden el mismo número simultáneamente, con indicadores de "quién está viendo este chat"
- **Registro completo** — captura mensajes del CRM, del teléfono físico y de WhatsApp Web (otras sesiones), todos identificados con ícono 📱
- **Grupos de WhatsApp** — visualización con nombre del grupo, ícono 👥 y nombre del hablante por mensaje
- **Actualización quirúrgica** — la lista de conversaciones se actualiza sin recargar toda la página
- **Sincronización de historial** — importa el historial del teléfono al conectar, con banner visual de progreso

### Agente IA v2
- **Multi-proveedor** — Gemini, Groq, OpenAI, Anthropic (configurable desde el panel)
- **Colas por JID** — cada conversación tiene su propia cola; múltiples chats en paralelo sin bloquearse
- **Memoria comprimida** — resumen automático de conversaciones largas para optimizar tokens
- **Cache de system prompt** — TTL de 5 minutos, no reconstruye en cada mensaje
- **Debounce por JID** — si el usuario envía varios mensajes rápidos, responde solo al último
- **Conteo real de tokens** — métricas acumuladas de uso de la API
- **Handoff a humano** — detecta frustración y pausa la IA notificando al agente
- **Documentos de contexto** — sube PDFs o archivos de texto como base de conocimiento
- **Panel de prueba + métricas** — testea la IA y ve tokens usados directamente en el panel
- **No responde en grupos** — protección explícita en auto-reply y agente IA

### Campañas masivas
- **Anti-ban integrado** — delays aleatorios, pausas automáticas, typing indicator
- **Personalización** — variables `{{nombre}}`, `{{empresa}}`, `{{extra}}`, `{{telefono}}`
- **Importación CSV** — carga de contactos por archivo
- **Duplicar campaña** — copia configuración + contactos con un clic para reutilizar
- **Reiniciar campaña** — vuelve todos los contactos a "pendiente" para reenviar
- **Estados** — draft → running → completed / cancelled

### Auto-respuesta fuera de horario
- **Timezone correcto** — zona horaria configurable (España, Argentina, México, etc.); no usa UTC del servidor
- **Recopilación de leads** — captura nombre, email, teléfono y motivo
- **Campos configurables** — definís qué datos recopilar desde el panel
- **Nunca en grupos** — protección explícita

### Otras funcionalidades
- Etiquetas con colores para organizar conversaciones
- Asignación de conversaciones a agentes
- Respuestas rápidas (acceso con `/`)
- Biblioteca de archivos reutilizables
- Contactos con búsqueda, notas y campos extra
- Log de actividad del sistema

---

## Stack técnico

| Capa | Tecnología |
|---|---|
| Backend | Node.js 20, Express, Socket.io |
| WhatsApp | Baileys ESM (multi-device) |
| Base de datos | PostgreSQL (producción) / SQLite in-memory (local) |
| Frontend | Vanilla JS, HTML, CSS — SPA sin frameworks |
| Deploy | Railway (Node.js + PostgreSQL + Volumen persistente) |
| IA | Gemini / Groq / OpenAI / Anthropic (configurable) |

---

## Requisitos

- Node.js 20 o superior → https://nodejs.org
- Git → https://git-scm.com
- Cuenta en Railway → https://railway.app

---

## Instalación local (desarrollo)

```bash
# 1. Clonar el repo
git clone https://github.com/johelp/whatsapp-crm.git
cd whatsapp-crm

# 2. Instalar dependencias
npm install

# 3. Copiar configuración
cp .env.example .env

# 4. Iniciar el servidor
npm run dev

# 5. Abrir en el navegador
# http://localhost:3000
# Usuario: admin | Contraseña: admin123
```

En desarrollo usa SQLite en memoria — no necesita PostgreSQL.

---

## Deploy en Railway (producción)

### 1 — Subir a GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU_USUARIO/whatsapp-crm.git
git push -u origin main
```

### 2 — Crear proyecto en Railway

1. Ir a https://railway.app → **New Project**
2. **Deploy from GitHub repo** → seleccionar tu repo
3. Railway detecta Node.js automáticamente

### 3 — Agregar PostgreSQL

1. En Railway → **+ New** → **Database** → **PostgreSQL**
2. En la base de datos → **Connect** → copiar `DATABASE_URL`

### 4 — Variables de entorno

En tu servicio Node → **Variables**:

```
DATABASE_URL    = [URL de PostgreSQL de Railway]
SESSION_SECRET  = [string aleatorio — https://generate-secret.vercel.app/32]
NODE_ENV        = production
WA_AUTH_PATH    = /data/auth
```

### 5 — Volumen persistente (CRÍTICO)

1. En Railway → tu servicio → **Volumes**
2. **Add Volume** → Mount Path: `/data`

Sin esto la sesión de WhatsApp se pierde en cada redeploy.

### 6 — Primer uso post-deploy

1. **Config → Sistema → 🔧 Reparar DB** (con contraseña de admin) — aplica todas las migraciones
2. **Config → WhatsApp → Mostrar QR** → escanear desde el teléfono
3. Crear agentes en **Config → Agentes**

---

## Estructura del proyecto

```
whatsapp-crm/
├── backend/
│   ├── server.js          # Servidor Express + Socket.io
│   ├── baileys.js         # Conexión WhatsApp, mensajes entrantes/salientes,
│   │                      # grupos, captura de WA Web y teléfono físico
│   ├── ai-agent.js        # Agente IA v2: colas por JID, memoria comprimida,
│   │                      # multi-proveedor, métricas de tokens
│   ├── sender.js          # Cola de envío masivo anti-ban
│   ├── db.js              # Capa de datos con migraciones automáticas
│   ├── middleware/
│   │   └── auth.js        # Autenticación de rutas
│   └── routes/
│       └── api.js         # Todos los endpoints REST
├── frontend/
│   ├── index.html         # App principal (SPA)
│   ├── login.html         # Pantalla de login
│   ├── css/app.css        # Estilos
│   └── js/app.js          # Lógica del frontend y tiempo real
├── .env.example
├── railway.toml
└── package.json
```

---

## Usuarios y roles

| Rol | Permisos |
|---|---|
| `admin` | Todo: usuarios, Config, Sistema, campañas |
| `agent` | Inbox, responder, etiquetar, ver campañas |

---

## Manejo de JIDs de WhatsApp

WhatsApp usa distintos identificadores según el tipo de cuenta:

| Sufijo | Tipo | Notas |
|---|---|---|
| `@s.whatsapp.net` | Número estándar | El más común |
| `@lid` | Privacy mode activado | El número numérico del LID no es un teléfono real |
| `@g.us` | Grupo | El sistema lo detecta y muestra con ícono 👥 |

Los contactos con `@lid` usan el pushName de WhatsApp como nombre visible.

---

## Agente IA — Proveedores

| Proveedor | Modelo recomendado | Gratuito |
|---|---|---|
| **Groq** | `llama-3.1-8b-instant` | ✅ Sí |
| **Gemini** | `gemini-1.5-flash` | ✅ Sí |
| **OpenAI** | `gpt-4o-mini` | ❌ |
| **Anthropic** | `claude-haiku-4-5` | ❌ |

---

## Campañas — Anti-ban

| Mecanismo | Detalle |
|---|---|
| Delay entre mensajes | 8–25 seg aleatorio (configurable) |
| Pausa cada 5 mensajes | 45–90 seg adicionales |
| Typing indicator | Simula escritura humana |
| Personalización | Variables por contacto, nunca mensajes idénticos |
| Máximo recomendado | 40–50 contactos por campaña |

---

## Auto-respuesta — Zonas horarias disponibles

Railway corre en UTC. La zona horaria se configura en el panel para que el horario de atención se evalúe correctamente:

`Europe/Madrid` · `America/Argentina/Buenos_Aires` · `America/Mexico_City` · `America/Bogota` · `America/Santiago` · `America/Lima` · `America/New_York` · `America/Los_Angeles` · `UTC`

---

## Mantenimiento en producción

| Acción | Dónde |
|---|---|
| Aplicar migraciones de DB | Config → Sistema → 🔧 Reparar DB |
| Re-sincronizar historial de WA | Config → Sistema → 🔄 Re-sincronizar |
| Fusionar números duplicados (ej: con/sin 9 en AR) | Config → Sistema → 🔀 Fusionar duplicados |
| Invalidar cache del system prompt de IA | Config → Agente IA → 🔄 Cache |

---

## Atajos de teclado

| Tecla | Acción |
|---|---|
| `Enter` | Enviar mensaje |
| `Shift+Enter` | Nueva línea |
| `/` | Abrir respuestas rápidas |
| `Escape` | Cerrar modal |

---

## Limitaciones conocidas

- Un número de WhatsApp por instancia del servidor
- Usa Baileys (API no oficial) — para alto volumen comercial considerar la API oficial de Meta
- Mensajes de voz y video se registran como `[Audio]` / `[Video]` sin reproducción
- Reacciones y mensajes de respuesta (reply) no se muestran en el hilo

---

## Licencia

MIT
