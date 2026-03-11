# WhatsApp CRM v2

Panel de gestión de WhatsApp multi-agente con envío masivo, etiquetas, auto-respuesta y trazabilidad por operador.

---

## Requisitos

- Node.js 18 o superior → https://nodejs.org
- Git → https://git-scm.com
- Cuenta en Railway → https://railway.app (deploy online gratis)

---

## Instalación local (desarrollo)

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar archivo de configuración
cp .env.example .env
# (No es necesario cambiar nada para empezar localmente)

# 3. Iniciar el servidor
npm run dev

# 4. Abrir en el navegador
# http://localhost:3000
# Usuario: admin | Contraseña: admin123
```

---

## Deploy en Railway (producción online)

### Paso 1 — Subir a GitHub

```bash
git init
git add .
git commit -m "Initial commit"
# Crear repo en github.com y conectar:
git remote add origin https://github.com/TU_USUARIO/whatsapp-crm.git
git push -u origin main
```

### Paso 2 — Crear proyecto en Railway

1. Ir a https://railway.app → New Project
2. "Deploy from GitHub repo" → seleccionar tu repo
3. Railway detecta Node.js automáticamente

### Paso 3 — Agregar PostgreSQL

1. En Railway → "+ New" → "Database" → "PostgreSQL"
2. En la base de datos → "Connect" → copiar `DATABASE_URL`

### Paso 4 — Variables de entorno en Railway

En tu servicio Node → Variables → agregar:

```
DATABASE_URL = [pegar la URL de PostgreSQL]
SESSION_SECRET = [generar string aleatorio en: https://generate-secret.vercel.app/32]
NODE_ENV = production
WA_AUTH_PATH = /data/auth
```

### Paso 5 — Volumen persistente (CRÍTICO para la sesión de WhatsApp)

1. En Railway → tu servicio → "Volumes"
2. "Add Volume" → Mount Path: `/data`
3. Esto guarda la sesión de WhatsApp entre reinicios

### Paso 6 — Deploy

Railway hace deploy automático. En 2-3 minutos tenés la URL pública.

---

## Primer uso

1. Entrar con `admin` / `admin123`
2. Ir a **Configuración → WhatsApp** → botón QR
3. En WhatsApp del teléfono → Dispositivos vinculados → Vincular dispositivo
4. Escanear el QR
5. Crear los usuarios de los agentes en Configuración → Agentes

---

## Estructura del proyecto

```
whatsapp-crm/
├── backend/
│   ├── server.js          # Servidor principal Express + Socket.io
│   ├── baileys.js         # Conexión WhatsApp + auto-reply bot
│   ├── sender.js          # Cola de envío masivo con anti-ban
│   ├── db.js              # Capa de datos (SQLite local / PostgreSQL prod)
│   ├── middleware/
│   │   └── auth.js        # Autenticación de rutas
│   └── routes/
│       └── api.js         # Todos los endpoints REST
├── frontend/
│   ├── index.html         # App principal (SPA)
│   ├── login.html         # Pantalla de login
│   ├── css/app.css        # Estilos
│   └── js/app.js          # Lógica del frontend
├── .env.example           # Plantilla de variables de entorno
├── railway.toml           # Config de deploy en Railway
└── package.json
```

---

## Usuarios y roles

| Rol | Permisos |
|---|---|
| `admin` | Todo: crear usuarios, eliminar, configurar WA |
| `agent` | Inbox, responder, etiquetar, crear campañas |

---

## Anti-ban para envíos masivos

| Mecanismo | Detalle |
|---|---|
| Delay entre mensajes | 8–25 seg aleatorio (configurable) |
| Pausa cada 5 mensajes | 45–90 seg adicionales |
| Typing indicator | Simula escritura humana antes de enviar |
| Personalización | Cada mensaje usa `{{nombre}}`, nunca es idéntico |
| Máximo recomendado | 40–50 por campaña |

---

## Variables en mensajes

```
{{nombre}}    → Nombre del contacto
{{empresa}}   → Empresa
{{extra}}     → Campo extra (grupo, categoría, etc.)
{{telefono}}  → Número de teléfono
```

---

## Auto-respuesta fuera de horario

El bot recopila automáticamente:
1. Nombre
2. Email
3. Teléfono de contacto
4. Motivo de consulta

Los campos son configurables desde el panel.

---

## Integración IA futura

Endpoint listo para conectar con GPT-4, Claude API u otro LLM:

```http
POST /api/ai/respond
Content-Type: application/json

{
  "jid": "5491123456789@s.whatsapp.net",
  "response": "La respuesta generada por la IA"
}
```

---

## Atajos de teclado

| Tecla | Acción |
|---|---|
| `Enter` | Enviar mensaje |
| `Shift+Enter` | Nueva línea |
| `/` | Abrir respuestas rápidas |
| `Escape` | Cerrar modal/popup |
