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

const { initDB, USE_PG } = require('./db');
const { connect, setIO, getStatus } = require('./baileys');
const { setIO: setSenderIO, isRunning, runCampaign } = require('./sender');
const apiRoutes = require('./routes/api');
const normalizerRoutes = require('./routes/normalizer');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', credentials: true },
  pingTimeout: 60000,
});

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_secret_change_in_prod';

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
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
  });
} else {
  sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
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

app.use('/api', apiRoutes);
app.use('/api', normalizerRoutes);

// ─── Frontend (protegido) ─────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/login');
}

app.use(requireAuth, express.static(path.join(__dirname, '../frontend')));

app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

const onlineUsers = new Map();

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

// ─── Cron: campanas programadas ───────────────────────────────────────────────

cron.schedule('* * * * *', async () => {
  if (isRunning()) return;
  const { query } = require('./db');
  try {
    const scheduled = await query(
      "SELECT * FROM campaigns WHERE status = 'draft' AND scheduled_at IS NOT NULL AND scheduled_at <= datetime('now') LIMIT 1"
    );
    if (scheduled.length) {
      console.log(`Ejecutando campana programada: ${scheduled[0].name}`);
      runCampaign(scheduled[0].id, scheduled[0].created_by).catch(console.error);
    }
  } catch (e) { /* silent */ }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  await initDB();
  setIO(io);
  setSenderIO(io);
  await connect();

  httpServer.listen(PORT, () => {
    console.log(`\nWhatsApp CRM corriendo en http://localhost:${PORT}`);
    console.log(`DB: ${USE_PG ? 'PostgreSQL' : 'SQLite (local)'}`);
    console.log(`Login: admin / admin123\n`);
  });
}

start().catch(err => {
  console.error('Error iniciando servidor:', err);
  process.exit(1);
});