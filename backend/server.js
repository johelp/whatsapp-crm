/**
 * server.js — Servidor principal
 * Express + Socket.io + Sesiones + Baileys
 */
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const { initDB, USE_PG, query } = require('./db');
const { connect, setIO, getStatus } = require('./baileys');
const { setIO: setSenderIO, isRunning, runCampaign } = require('./sender');
const apiRoutes = require('./routes/api');
const v1Routes = require('./routes/v1');
const integrationRoutes = require('./routes/integrations');
const knowledgeRoutes = require('./routes/knowledge');
const { startWorkers } = require('./integrations');
const normalizerRoutes = require('./routes/normalizer');

// Un rechazo de promesa sin capturar (p.ej. consulta a la DB en un handler async) tumbaba el proceso entero → 502 en Railway
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err?.message || err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err?.message || err));

// Handlers async rechazados → next(err) (mismo mecanismo que express-async-errors, sin dependencia extra)
const ExpressLayer = require('express/lib/router/layer');
const _handleRequest = ExpressLayer.prototype.handle_request;
ExpressLayer.prototype.handle_request = function (req, res, next) {
  if (this.handle.length > 3) return next();
  try {
    const r = this.handle(req, res, next);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (e) { next(e); }
};

const app = express();
const httpServer = createServer(app);
const IS_PROD = process.env.NODE_ENV === 'production';
// Orígenes permitidos para el panel (mismo origen por defecto). Lista separada por comas.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || process.env.APP_URL || '').split(',').map(s => s.trim()).filter(Boolean);

const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false, credentials: true },
  pingTimeout: 60000,
});

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'WhatsFlow';
if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('FATAL: definí SESSION_SECRET en producción');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_secret_change_in_prod';
const COOKIE = { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 7 * 24 * 60 * 60 * 1000 };
app.set('trust proxy', 1);   // Railway/Cloudflare: necesario para cookies secure y req.ip

// ─── Session ──────────────────────────────────────────────────────────────────

let sessionMiddleware;

if (USE_PG) {
  const pgSession = require('connect-pg-simple')(session);
  sessionMiddleware = session({
    store: new pgSession({
      conString: process.env.DATABASE_URL,
      tableName: 'user_sessions',
      createTableIfMissing: true,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: COOKIE,
  });
} else {
  sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: COOKIE,
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' });
  next();
});
// API pública v1 (API key, sin cookies): CORS abierto y sin credenciales
app.use('/api/v1', cors({ origin: '*', allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Key', 'Idempotency-Key'] }));
app.use(cors({ origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// ─── Rutas de login (publicas) ────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// ─── API (todas las rutas, auth se maneja dentro de api.js) ───────────────────

// Marca blanca: el nombre se define por instalación con APP_NAME (público, lo usa también la pantalla de login)
app.get('/api/brand', (req, res) => res.json({ name: APP_NAME }));
app.use('/api/v1', v1Routes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api', apiRoutes);
app.use('/api', normalizerRoutes);

// Express 4 no captura rechazos de handlers async: respondemos 500 en vez de dejar la request colgada
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno (¿base de datos no disponible?)' });
});

// ─── Frontend (protegido) ─────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/login');
}

// Raíz pública: visitantes ven la landing (con botón "Iniciar sesión" → /login); con sesión activa entran al panel
app.use('/img', express.static(path.join(__dirname, '../landing/img'), { maxAge: '7d' }));
// PUBLIC_LANDING=false en las instalaciones de clientes: la raíz lleva directo al login (la landing es solo de la instancia comercial)
const LANDING_ON = !/^(0|false|off|no)$/i.test(process.env.PUBLIC_LANDING || 'true');
app.get('/', (req, res) => {
  if (req.session?.user) return res.sendFile(path.join(__dirname, '../frontend/index.html'));
  if (!LANDING_ON) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '../landing/index.html'));
});

// Salud para monitores externos: 200 si la app y la base responden; ?strict=1 exige además WhatsApp conectado
app.get('/health', async (req, res) => {
  let db = false;
  try { await Promise.race([query('SELECT 1 AS ok'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]); db = true; } catch (e) {}
  const wa = getStatus().status;
  const ok = db && (req.query.strict !== '1' || wa === 'connected');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db, whatsapp: wa, uptime_s: Math.round(process.uptime()), version: require('../package.json').version });
});

app.use(requireAuth, express.static(path.join(__dirname, '../frontend')));

app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

const onlineUsers = new Map();
require('./online').setMap(onlineUsers);
// Cambios hechos por la IA/automatizaciones → refrescar la UI de los agentes
require('./bus').bus.on('event', (name, data) => {
  if (name === 'conversation.updated') io.emit('conversation:updated', data);
  if (name === 'note.changed') io.emit('note:changed', data);
  if (['conversation.assigned', 'conversation.needs_human'].includes(name)) io.emit('conversation:alert', { name, ...data });
});

io.on('connection', (socket) => {
  const user = socket.request.session?.user;
  if (!user) { socket.disconnect(); return; }

  onlineUsers.set(socket.id, user);
  console.log(`Agente conectado: ${user.display_name}`);

  socket.emit('wa:status', getStatus());
  socket.emit('users:online', [...onlineUsers.values()]);
  io.emit('users:online', [...new Map([...onlineUsers].map(([, u]) => [u.id, u])).values()]);

  socket.on('typing:start', ({ jid }) => {
    socket.broadcast.emit('typing:remote', { jid, user: { display_name: user.display_name, color: user.color } });
  });

  socket.on('typing:stop', ({ jid }) => {
    socket.broadcast.emit('typing:stop_remote', { jid, userId: user.id });
  });

  socket.on('chat:open', ({ jid }) => {
    socket.broadcast.emit('chat:viewing', { jid, user: { id: user.id, display_name: user.display_name, color: user.color } });
  });

  socket.on('chat:close', ({ jid }) => {
    socket.broadcast.emit('chat:left', { jid, userId: user.id });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    console.log(`Agente desconectado: ${user.display_name}`);
    io.emit('users:online', [...new Map([...onlineUsers].map(([, u]) => [u.id, u])).values()]);
  });
});

// ─── Cron: campañas programadas ───────────────────────────────────────────────

cron.schedule('* * * * *', async () => {
  if (isRunning()) return;
  try {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const scheduled = await query(
      "SELECT * FROM campaigns WHERE status = 'draft' AND scheduled_at IS NOT NULL AND scheduled_at <= $1 LIMIT 1",
      [now]
    ).catch(() => query(
      "SELECT * FROM campaigns WHERE status = 'draft' AND scheduled_at IS NOT NULL AND scheduled_at <= ? LIMIT 1",
      [now]
    ));
    if (scheduled.length) {
      console.log(`Ejecutando campaña programada: ${scheduled[0].name}`);
      runCampaign(scheduled[0].id, scheduled[0].created_by).catch(console.error);
    }
  } catch (e) { /* silent */ }
});

// ─── Cron: refresco diario de URLs de la base de conocimiento ─────────────────
cron.schedule('0 4 * * *', () => require('./knowledge').refreshDue().catch(e => console.error('[KB cron]', e.message)));

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  // 1. Escuchar el puerto PRIMERO — Railway mata el proceso si no responde en ~10s
  await new Promise(resolve => {
    httpServer.listen(PORT, () => {
      console.log(`\n${APP_NAME} corriendo en http://localhost:${PORT}`);
      console.log(`DB: ${USE_PG ? 'PostgreSQL' : 'SQLite (local)'}`);
      console.log('');
      resolve();
    });
  });

  // 2. Inicializar DB (puede tardar con 25+ migraciones en PG)
  // Reintentar: en Railway la base puede tardar en aceptar conexiones tras un (re)despliegue
  let dbReady = false;
  for (let attempt = 1; attempt <= 8 && !dbReady; attempt++) {
    try {
      await initDB();
      dbReady = true;
    } catch(e) {
      console.error(`Error en initDB (intento ${attempt}/8):`, e.message || e.code || e);
      if (attempt < 8) await new Promise(r => setTimeout(r, Math.min(3000 * attempt, 15000)));
    }
  }
  if (!dbReady) { console.error('FATAL: no se pudo inicializar la base de datos'); process.exit(1); }   // Railway reinicia el servicio

  setIO(io);
  setSenderIO(io);
  require('./tz').startTZRefresh();
  await startWorkers().catch(e => console.error('Error iniciando workers:', e.message));

  // 3. Conectar Baileys en background
  connect().catch(err => {
    console.error('Error conectando WhatsApp (reintentando):', err.message);
  });
}

start().catch(err => {
  console.error('Error iniciando servidor:', err);
  process.exit(1);
});