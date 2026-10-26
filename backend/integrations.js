/**
 * integrations.js — API keys, cola de salida persistente, reglas de notificación y webhooks.
 *
 * Flujo "plugin → WhatsApp": POST /api/v1/notify  →  outbound_queue  →  worker  →  antiban.gate  →  Baileys
 * Flujo "WhatsApp → sistema": bus 'event'  →  webhook_deliveries  →  worker  →  POST firmado (HMAC-SHA256)
 */
const crypto = require('crypto');
const { query, queryOne } = require('./db');
const { bus } = require('./bus');
const antiban = require('./antiban');

const MAX_ATTEMPTS = 5;
const WEBHOOK_MAX_ATTEMPTS = 6;
const num = (v) => Number(v) || 0;

// ─── API keys ─────────────────────────────────────────────────────────────────

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function createApiKey(name, scopes = 'send,read') {
  const key = 'wak_' + crypto.randomBytes(24).toString('base64url');
  const rows = await query(
    'INSERT INTO api_keys (name, key_hash, key_prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [name, sha256(key), key.slice(0, 8), scopes, Date.now()]
  );
  return { id: rows[0]?.id, name, key, scopes };   // `key` solo se devuelve en este momento
}

const keyUsage = new Map();   // keyId -> [timestamps] (limitador 60 req/min por key)

/** Middleware: Authorization: Bearer wak_... | X-API-Key */
function apiKeyAuth(scope) {
  return async (req, res, next) => {
    const h = req.get('authorization') || '';
    const raw = (h.startsWith('Bearer ') ? h.slice(7) : req.get('x-api-key') || '').trim();
    if (!raw) return res.status(401).json({ error: 'API key requerida (Authorization: Bearer wak_...)' });
    const k = await queryOne('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1', [sha256(raw)]);
    if (!k) return res.status(401).json({ error: 'API key inválida o revocada' });
    if (scope && !String(k.scopes || '').split(',').map(s => s.trim()).includes(scope)) {
      return res.status(403).json({ error: `La API key no tiene el permiso "${scope}"` });
    }
    const now = Date.now();
    const hits = (keyUsage.get(k.id) || []).filter(t => now - t < 60000);
    if (hits.length >= 60) return res.status(429).json({ error: 'Límite de 60 requests/min por API key' });
    hits.push(now); keyUsage.set(k.id, hits);
    query('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, k.id]).catch(() => {});
    req.apiKey = { id: k.id, name: k.name };
    next();
  };
}

// ─── Destinatarios y plantillas ───────────────────────────────────────────────

/** "5493412345678", "+54 9 341 234-5678" o "1203630...@g.us" → JID normalizado, o null si no es válido */
function toJid(raw) {
  const s = String(raw || '').trim();
  if (s.endsWith('@g.us')) return s;
  const { normalizePhone } = require('./baileys');
  const p = normalizePhone(s);
  return p.length >= 8 && p.length <= 15 ? `${p}@s.whatsapp.net` : null;
}

function renderTemplate(tpl, ctx) {
  return String(tpl).replace(/\{\{\s*([\w.\-\[\]]+)\s*\}\}/g, (_, path) => {
    const v = path.replace(/\[(\w+)\]/g, '.$1').split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// ─── Cola de salida ───────────────────────────────────────────────────────────

async function enqueueMessage({ to, text, event = null, source = 'api', dedupeKey = null, sendAfter = null }) {
  const jid = toJid(to);
  if (!jid) throw Object.assign(new Error(`Destinatario inválido: ${to}`), { status: 400 });
  if (!text || !String(text).trim()) throw Object.assign(new Error('Texto vacío'), { status: 400 });
  if (String(text).length > 4096) throw Object.assign(new Error('Texto demasiado largo (máx 4096)'), { status: 400 });

  const dk = dedupeKey ? `${dedupeKey}:${jid}` : null;
  if (dk) {
    const ex = await queryOne('SELECT id, status FROM outbound_queue WHERE dedupe_key = ?', [dk]);
    if (ex) return { id: ex.id, status: ex.status, duplicate: true, to: jid };
  }
  const now = Date.now();
  try {
    const rows = await query(
      `INSERT INTO outbound_queue (to_jid, text, event, source, status, dedupe_key, send_after, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING id`,
      [jid, String(text), event, source, dk, sendAfter || now, now]
    );
    return { id: rows[0]?.id, status: 'pending', duplicate: false, to: jid };
  } catch (e) {
    // Carrera con la restricción UNIQUE de dedupe_key
    const ex = dk && await queryOne('SELECT id, status FROM outbound_queue WHERE dedupe_key = ?', [dk]);
    if (ex) return { id: ex.id, status: ex.status, duplicate: true, to: jid };
    throw e;
  }
}

/** Notificación por evento: usa la regla activa (plantilla + destinatarios) y/o los datos del request. */
async function notify({ event, data = {}, to = null, text = null, dedupeKey = null, source = 'api' }) {
  const rule = event ? await queryOne('SELECT * FROM notification_rules WHERE event = ? AND is_active = 1', [event]) : null;

  let recipients = to ? [].concat(to) : [];
  if (!recipients.length && rule) { try { recipients = JSON.parse(rule.recipients || '[]'); } catch (e) {} }
  if (!recipients.length) throw Object.assign(new Error('Sin destinatarios: enviá "to" o configurá una regla para el evento'), { status: 400 });
  if (recipients.length > 20) throw Object.assign(new Error('Máximo 20 destinatarios por llamada'), { status: 400 });

  const body = text ? renderTemplate(text, { event, data })
    : rule ? renderTemplate(rule.template, { event, data })
    : null;
  if (!body) throw Object.assign(new Error(`No hay regla activa para "${event}" ni "text" en el request`), { status: 404 });

  const results = [];
  for (const r of recipients) {
    results.push(await enqueueMessage({ to: r, text: body, event, source, dedupeKey }));
  }
  return { text: body, queued: results };
}

let workerBusy = false;

async function processQueueOnce() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const { sendMessage, sendGroupMessage, getStatus } = require('./baileys');
    if (getStatus().status !== 'connected') return;

    const item = await queryOne(
      "SELECT * FROM outbound_queue WHERE status = 'pending' AND send_after <= ? ORDER BY id LIMIT 1", [Date.now()]);
    if (!item) return;
    await query("UPDATE outbound_queue SET status = 'sending', attempts = attempts + 1 WHERE id = ?", [item.id]);

    try {
      const sent = item.to_jid.endsWith('@g.us')
        ? await sendGroupMessage(item.to_jid, item.text, null, { kind: 'notify' })
        : await sendMessage(item.to_jid.split('@')[0], item.text, null, { kind: 'notify' });
      await query("UPDATE outbound_queue SET status = 'sent', sent_at = ?, message_id = ?, error = NULL WHERE id = ?",
        [Date.now(), sent?.key?.id || null, item.id]);
      emit('message.sent', { queue_id: item.id, to: item.to_jid, text: item.text, event: item.event, message_id: sent?.key?.id });
    } catch (err) {
      const code = err.code;
      const attempts = num(item.attempts) + 1;
      if (['RATE_LIMIT', 'QUIET_HOURS', 'PAUSED'].includes(code)) {
        // No es culpa del mensaje: reprogramar sin consumir intentos
        await query("UPDATE outbound_queue SET status = 'pending', attempts = attempts - 1, send_after = ?, error = ? WHERE id = ?",
          [err.retryAt || Date.now() + 60000, err.message, item.id]);
      } else if (['BLOCKED', 'DUPLICATE', 'NOT_ON_WHATSAPP'].includes(code) || attempts >= MAX_ATTEMPTS) {
        await query("UPDATE outbound_queue SET status = 'failed', error = ? WHERE id = ?", [`${code || 'ERROR'}: ${err.message}`, item.id]);
        emit('message.failed', { queue_id: item.id, to: item.to_jid, event: item.event, error: err.message, code: code || 'ERROR' });
      } else {
        const backoff = Math.min(2 ** attempts * 15000, 30 * 60000);
        await query("UPDATE outbound_queue SET status = 'pending', send_after = ?, error = ? WHERE id = ?",
          [Date.now() + backoff, err.message, item.id]);
      }
    }
  } catch (e) {
    console.error('[queue]', e.message);
  } finally {
    workerBusy = false;
  }
}

// ─── Webhooks salientes ───────────────────────────────────────────────────────

function emit(event, data) {
  // Se encola una entrega por cada webhook suscrito
  (async () => {
    const hooks = await query('SELECT * FROM webhooks WHERE is_active = 1');
    for (const h of hooks) {
      const subs = String(h.events || '*').split(',').map(s => s.trim());
      if (!subs.includes('*') && !subs.includes(event)) continue;
      const payload = JSON.stringify({ event, timestamp: Date.now(), data });
      await query(
        "INSERT INTO webhook_deliveries (webhook_id, event, payload, status, next_attempt, created_at) VALUES (?, ?, ?, 'pending', ?, ?)",
        [h.id, event, payload, Date.now(), Date.now()]);
    }
  })().catch(e => console.error('[webhook emit]', e.message));
}

function signPayload(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret || '').update(`${timestamp}.${body}`).digest('hex');
}

async function deliver(h, d) {
  const ts = Math.floor(Date.now() / 1000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(h.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsFlow-webhook/1',
        'X-Webhook-Event': d.event,
        'X-Webhook-Delivery': String(d.id),
        'X-Webhook-Timestamp': String(ts),
        'X-Webhook-Signature': 'sha256=' + signPayload(h.secret, ts, d.payload),
      },
      body: d.payload,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } finally { clearTimeout(timer); }
}

let hookBusy = false;
async function processWebhooksOnce() {
  if (hookBusy) return;
  hookBusy = true;
  try {
    const due = await query("SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt <= ? ORDER BY id LIMIT 5", [Date.now()]);
    for (const d of due) {
      const h = await queryOne('SELECT * FROM webhooks WHERE id = ?', [d.webhook_id]);
      if (!h || !num(h.is_active)) { await query("UPDATE webhook_deliveries SET status = 'failed', last_error = 'webhook inactivo/eliminado' WHERE id = ?", [d.id]); continue; }
      const attempts = num(d.attempts) + 1;
      try {
        await deliver(h, d);
        await query("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_error = NULL WHERE id = ?", [attempts, d.id]);
      } catch (e) {
        const msg = e.name === 'AbortError' ? 'timeout 8s' : e.message;
        if (attempts >= WEBHOOK_MAX_ATTEMPTS) await query("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?", [attempts, msg, d.id]);
        else await query("UPDATE webhook_deliveries SET attempts = ?, last_error = ?, next_attempt = ? WHERE id = ?",
          [attempts, msg, Date.now() + Math.min(2 ** attempts * 10000, 3600000), d.id]);
      }
    }
  } catch (e) { console.error('[webhooks]', e.message); }
  finally { hookBusy = false; }
}

// ─── Arranque ─────────────────────────────────────────────────────────────────

let started = false;
async function startWorkers() {
  if (started) return;
  started = true;
  // Lo que quedó "sending" por un reinicio vuelve a la cola
  await query("UPDATE outbound_queue SET status = 'pending' WHERE status = 'sending'").catch(() => {});
  bus.on('event', (name, data) => emit(name, data));
  setInterval(processQueueOnce, 3000);
  setInterval(processWebhooksOnce, 4000);
  setInterval(async () => {
    antiban.pruneLog();
    const old = Date.now() - 30 * 86400000;
    await query("DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at < ?", [old]).catch(() => {});
    await query("DELETE FROM outbound_queue WHERE status IN ('sent','failed') AND created_at < ?", [old]).catch(() => {});
  }, 6 * 3600 * 1000);
}

module.exports = {
  createApiKey, apiKeyAuth, notify, enqueueMessage, renderTemplate, toJid,
  emit, startWorkers, processQueueOnce, signPayload,
};
