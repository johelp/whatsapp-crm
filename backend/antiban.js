/**
 * antiban.js — Compuerta única de envío con protección anti-baneo.
 *
 * TODO envío saliente (UI, campañas, IA, API de integraciones) pasa por gate().
 * Reglas (todas configurables en la tabla settings, clave "antiban"):
 *  - Serializa los envíos y exige un intervalo mínimo con jitter entre ellos.
 *  - Distingue destinatarios "fríos" (nunca nos escribieron) de "cálidos" (hay conversación
 *    o es un grupo). Lo frío es lo que más baneos provoca → límites por hora/día mucho menores.
 *  - Calentamiento: el tope diario de envíos fríos crece con la antigüedad del número.
 *  - Horario silencioso para envíos fríos.
 *  - Lista de bloqueo (opt-out) + etiqueta "No contactar".
 *  - Anti-duplicado (mismo texto al mismo destino en pocos segundos).
 *  - Circuit breaker: errores seguidos o señales de rate-limit pausan todo el envío.
 *  - Calidad de lista: si muchos números fríos no existen en WhatsApp, pausa.
 */
const { query, queryOne } = require('./db');

const DEFAULTS = {
  gap_min_ms: 2500,        // intervalo mínimo entre envíos (frío: x2)
  gap_max_ms: 6000,
  cold_per_hour: 15,
  cold_per_day: 60,
  warm_per_hour: 120,
  warm_per_day: 600,
  warmup_enabled: 1,
  warmup_start_daily: 20,  // tope diario frío el día 0
  warmup_step_daily: 10,   // +N por cada día de antigüedad
  quiet_start: 21,         // sin envíos fríos de 21:00 a 08:00 (hora local APP_TZ)
  quiet_end: 8,
  breaker_errors: 3,       // errores consecutivos para pausar
  breaker_pause_min: 15,
  duplicate_window_s: 60,
};

const { getTZ } = require('./tz');
const RATE_RE = /rate-overlimit|too many|429|forbidden|403|not-authorized|spam|blocked|restrict/i;

let cfgCache = null, cfgAt = 0;
let chain = Promise.resolve();
let lastSendAt = 0;
let consecutiveErrors = 0;
let pausedUntil = 0, pausedReason = '';
const recentDup = new Map();          // `${jid}|${text}` -> ts
const invalidChecks = [];             // últimos resultados de verificación en frío (true = inválido)
let firstSendAt = null;

class GateError extends Error {
  constructor(code, message, retryAt = null) { super(message); this.code = code; this.retryAt = retryAt; }
}

// ─── Config ───────────────────────────────────────────────────────────────────

async function getConfig(force = false) {
  if (!force && cfgCache && Date.now() - cfgAt < 30000) return cfgCache;
  let stored = {};
  try {
    const row = await queryOne("SELECT value FROM settings WHERE key = 'antiban'");
    if (row?.value) stored = JSON.parse(row.value);
  } catch (e) { /* tabla aún no existe */ }
  cfgCache = { ...DEFAULTS, ...stored };
  cfgAt = Date.now();
  return cfgCache;
}

async function saveConfig(patch) {
  const next = { ...(await getConfig(true)) };
  for (const k of Object.keys(DEFAULTS)) {
    if (patch[k] !== undefined && !Number.isNaN(Number(patch[k]))) next[k] = Number(patch[k]);
  }
  const json = JSON.stringify(next);
  const ex = await queryOne("SELECT key FROM settings WHERE key = 'antiban'");
  if (ex) await query("UPDATE settings SET value = ? WHERE key = 'antiban'", [json]);
  else await query("INSERT INTO settings (key, value) VALUES ('antiban', ?)", [json]);
  cfgCache = next; cfgAt = Date.now();
  return next;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const num = (v) => Number(v) || 0;

function localHour() {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: getTZ() }).format(new Date())) % 24;
  } catch (e) { return new Date().getHours(); }
}

function inQuietHours(cfg) {
  const h = localHour();
  return cfg.quiet_start > cfg.quiet_end
    ? (h >= cfg.quiet_start || h < cfg.quiet_end)
    : (h >= cfg.quiet_start && h < cfg.quiet_end);
}

function nextQuietEnd(cfg) {
  const d = new Date();
  const h = localHour();
  const hoursAhead = ((cfg.quiet_end - h) + 24) % 24 || 24;
  return d.getTime() + hoursAhead * 3600 * 1000;
}

function phoneVariants(jidOrPhone) {
  const p = String(jidOrPhone).split('@')[0].replace(/\D/g, '');
  const v = new Set([p]);
  if (p.startsWith('549')) v.add('54' + p.slice(3));
  else if (p.startsWith('54')) v.add('549' + p.slice(2));
  return [...v];
}

async function isBlocked(jidOrPhone) {
  if (String(jidOrPhone).endsWith('@g.us')) return false;
  for (const p of phoneVariants(jidOrPhone)) {
    if (await queryOne('SELECT phone FROM blocked_numbers WHERE phone = ?', [p])) return true;
    const lab = await queryOne(
      `SELECT c.id FROM contacts c
         JOIN contact_labels cl ON cl.contact_id = c.id
         JOIN labels l ON l.id = cl.label_id
       WHERE c.phone = ? AND l.name = 'No contactar'`, [p]);
    if (lab) return true;
  }
  return false;
}

async function isCold(jid) {
  if (jid.endsWith('@g.us')) return false;
  const row = await queryOne("SELECT COUNT(*) AS n FROM messages WHERE jid = ? AND direction = 'in'", [jid]);
  return num(row?.n) === 0;
}

async function countSince(cold, sinceMs) {
  const row = await queryOne('SELECT COUNT(*) AS n FROM send_log WHERE cold = ? AND ts > ?', [cold ? 1 : 0, sinceMs]);
  return num(row?.n);
}

async function getFirstSendAt() {
  if (firstSendAt) return firstSendAt;
  const s = await queryOne("SELECT value FROM settings WHERE key = 'first_send_at'");
  if (s?.value) return (firstSendAt = num(s.value));
  // Número ya establecido: tomar el primer saliente conocido; si no hay, ahora.
  const m = await queryOne("SELECT MIN(timestamp) AS t FROM messages WHERE direction = 'out'");
  firstSendAt = num(m?.t) || Date.now();
  await query("INSERT INTO settings (key, value) VALUES ('first_send_at', ?)", [String(firstSendAt)]).catch(() => {});
  return firstSendAt;
}

async function dailyColdCap(cfg) {
  if (!cfg.warmup_enabled) return cfg.cold_per_day;
  const days = Math.floor((Date.now() - await getFirstSendAt()) / 86400000);
  return Math.min(cfg.cold_per_day, cfg.warmup_start_daily + cfg.warmup_step_daily * Math.max(days, 0));
}

function pause(minutes, reason) {
  pausedUntil = Date.now() + minutes * 60000;
  pausedReason = reason;
  console.warn(`[antiban] ENVÍOS PAUSADOS ${minutes} min — ${reason}`);
  try { require('./bus').emitEvent('antiban.paused', { until: pausedUntil, reason }); } catch (e) {}
}

function resume() { pausedUntil = 0; pausedReason = ''; consecutiveErrors = 0; invalidChecks.length = 0; }

// ─── Compuerta ────────────────────────────────────────────────────────────────

/**
 * meta: { jid, text?, kind: 'manual'|'campaign'|'notify'|'ai' }
 * fn:   async () => resultado del envío real (se ejecuta ya serializado y con intervalo)
 */
function gate(meta, fn) {
  const run = chain.then(() => _gate(meta, fn));
  chain = run.catch(() => {});   // un fallo no rompe la cadena
  return run;
}

async function _gate(meta, fn) {
  const cfg = await getConfig();
  const { jid, text = '', kind = 'manual' } = meta;

  if (Date.now() < pausedUntil) {
    throw new GateError('PAUSED', `Envíos pausados por protección anti-baneo (${pausedReason}). Reanudan ${new Date(pausedUntil).toLocaleTimeString('es-AR', { timeZone: getTZ() })}`, pausedUntil);
  }

  // Duplicados
  const dupKey = `${jid}|${text}`;
  const dupAt = recentDup.get(dupKey);
  if (text && dupAt && Date.now() - dupAt < cfg.duplicate_window_s * 1000) {
    throw new GateError('DUPLICATE', 'Mensaje idéntico enviado hace instantes al mismo destino');
  }

  // Opt-out: todo menos la respuesta manual de un agente
  if (kind !== 'manual' && await isBlocked(jid)) {
    throw new GateError('BLOCKED', 'Destinatario en lista de bloqueo / No contactar');
  }

  // Campañas = comunicación comercial: exigen consentimiento registrado (art. 21 LSSI / ePrivacy) salvo que el admin lo relaje;
  // quien se dio de baja nunca recibe campañas.
  if (kind === 'campaign' && !jid.endsWith('@g.us')) {
    const privacy = require('./privacy');
    const consent = await privacy.getConsent(jid);
    if (consent === 'revoked') throw new GateError('BLOCKED', 'El contacto se dio de baja de las comunicaciones');
    if (consent !== 'granted' && (await privacy.getPrivacy()).campaign_consent === 'require') {
      throw new GateError('NO_CONSENT', 'Sin consentimiento registrado para comunicaciones comerciales (ver Configuración → Privacidad)');
    }
  }

  const cold = await isCold(jid);
  if (cold) {
    if (inQuietHours(cfg)) {
      throw new GateError('QUIET_HOURS', 'Horario silencioso para envíos a contactos nuevos', nextQuietEnd(cfg));
    }
    const hourUsed = await countSince(true, Date.now() - 3600000);
    if (hourUsed >= cfg.cold_per_hour) {
      throw new GateError('RATE_LIMIT', `Tope horario de contactos nuevos (${cfg.cold_per_hour}/h)`, Date.now() + 10 * 60000);
    }
    const dayCap = await dailyColdCap(cfg);
    const dayUsed = await countSince(true, Date.now() - 86400000);
    if (dayUsed >= dayCap) {
      throw new GateError('RATE_LIMIT', `Tope diario de contactos nuevos (${dayCap}/día, calentamiento)`, Date.now() + 60 * 60000);
    }
  } else {
    if (await countSince(false, Date.now() - 3600000) >= cfg.warm_per_hour) {
      throw new GateError('RATE_LIMIT', `Tope horario de conversaciones (${cfg.warm_per_hour}/h)`, Date.now() + 5 * 60000);
    }
    if (await countSince(false, Date.now() - 86400000) >= cfg.warm_per_day) {
      throw new GateError('RATE_LIMIT', `Tope diario de conversaciones (${cfg.warm_per_day}/día)`, Date.now() + 60 * 60000);
    }
  }

  // Intervalo mínimo con jitter (frío: doble; manual: más corto para no frenar al agente)
  const factor = cold ? 2 : (kind === 'manual' ? 0.4 : 1);
  const wanted = rand(cfg.gap_min_ms, cfg.gap_max_ms) * factor;
  const wait = lastSendAt + wanted - Date.now();
  if (wait > 0) await sleep(wait);

  try {
    const result = await fn({ cold });
    lastSendAt = Date.now();
    consecutiveErrors = 0;
    if (text) recentDup.set(dupKey, Date.now());
    if (recentDup.size > 500) for (const [k, t] of recentDup) if (Date.now() - t > 120000) recentDup.delete(k);
    await getFirstSendAt();
    await query('INSERT INTO send_log (jid, cold, kind, ts) VALUES (?, ?, ?, ?)', [jid, cold ? 1 : 0, kind, Date.now()]).catch(() => {});
    return result;
  } catch (err) {
    lastSendAt = Date.now();
    if (err instanceof GateError) throw err;   // p.ej. NOT_ON_WHATSAPP lanzado desde fn
    consecutiveErrors++;
    if (RATE_RE.test(err.message || '')) pause(60, `señal de límite de WhatsApp: ${err.message}`);
    else if (consecutiveErrors >= cfg.breaker_errors) pause(cfg.breaker_pause_min, `${consecutiveErrors} errores de envío seguidos`);
    throw err;
  }
}

/** Para registrar el resultado de verificar si un número frío existe en WhatsApp. */
function reportNumberCheck(invalid) {
  invalidChecks.push(!!invalid);
  if (invalidChecks.length > 20) invalidChecks.shift();
  if (invalidChecks.length >= 10) {
    const ratio = invalidChecks.filter(Boolean).length / invalidChecks.length;
    if (ratio > 0.4) pause(30, `lista de baja calidad: ${Math.round(ratio * 100)}% de números inexistentes`);
  }
}

async function getStatus() {
  const cfg = await getConfig();
  return {
    paused: Date.now() < pausedUntil,
    paused_until: pausedUntil || null,
    paused_reason: pausedReason || null,
    quiet_hours_now: inQuietHours(cfg),
    local_hour: localHour(),
    timezone: getTZ(),
    cold: {
      last_hour: await countSince(true, Date.now() - 3600000),
      hour_cap: cfg.cold_per_hour,
      last_24h: await countSince(true, Date.now() - 86400000),
      day_cap_today: await dailyColdCap(cfg),
    },
    warm: {
      last_hour: await countSince(false, Date.now() - 3600000),
      hour_cap: cfg.warm_per_hour,
      last_24h: await countSince(false, Date.now() - 86400000),
      day_cap: cfg.warm_per_day,
    },
    config: cfg,
  };
}

async function pruneLog() {
  await query('DELETE FROM send_log WHERE ts < ?', [Date.now() - 8 * 86400000]).catch(() => {});
}

/** Día (1-7, lunes=1) y minutos desde medianoche en la zona horaria del negocio */
function localNow() {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false, timeZone: getTZ() }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t)?.value;
    const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')];
    return { day, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
  } catch (e) { const n = new Date(); return { day: n.getDay() || 7, minutes: n.getHours() * 60 + n.getMinutes() }; }
}

module.exports = { localNow, gate, GateError, getConfig, saveConfig, getStatus, isBlocked, isCold, reportNumberCheck, pause, resume, pruneLog, phoneVariants, DEFAULTS };
