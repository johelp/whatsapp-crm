/**
 * tz.js — Zona horaria única de la instalación.
 * Prioridad: variable APP_TZ  >  zona elegida en Configuración (auto-respuesta)  >  Europe/Madrid.
 * Bot de fuera de horario, horario silencioso anti-bloqueo y horarios de la IA usan SIEMPRE esta misma zona.
 */
const { queryOne } = require('./db');

const DEFAULT_TZ = 'Europe/Madrid';
let dbTZ = null;

function valid(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

/** Síncrono (usa el valor cacheado). */
function getTZ() {
  if (process.env.APP_TZ && valid(process.env.APP_TZ)) return process.env.APP_TZ;
  return dbTZ || DEFAULT_TZ;
}

async function refreshTZ() {
  try {
    const r = await queryOne('SELECT timezone FROM auto_reply_config LIMIT 1');
    dbTZ = r?.timezone && valid(r.timezone) ? r.timezone : null;
  } catch (e) { /* tabla/columna aún no disponible */ }
  return getTZ();
}

function startTZRefresh() { refreshTZ(); setInterval(refreshTZ, 60000).unref?.(); }

module.exports = { getTZ, refreshTZ, startTZRefresh, DEFAULT_TZ };
