/**
 * routes/integrations.js — Administración (sesión + rol admin) de API keys, reglas,
 * webhooks, cola, lista de bloqueo y ajustes anti-ban.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, queryOne } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const antiban = require('../antiban');
const { createApiKey, notify, renderTemplate, emit } = require('../integrations');

router.use(requireAuth, requireAdmin);

const J = (v, d) => { try { return JSON.parse(v); } catch (e) { return d; } };

// ── API keys ─────────────────────────────────────────────────────────────────
router.get('/keys', async (req, res) => {
  res.json(await query('SELECT id, name, key_prefix, scopes, is_active, last_used_at, created_at FROM api_keys ORDER BY id DESC'));
});
router.post('/keys', async (req, res) => {
  const { name, scopes } = req.body;
  if (!name) return res.status(400).json({ error: 'name requerido' });
  res.json(await createApiKey(name, scopes || 'send,read'));   // la key completa se muestra solo ahora
});
router.delete('/keys/:id', async (req, res) => {
  await query('UPDATE api_keys SET is_active = 0 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ── Reglas de notificación ───────────────────────────────────────────────────
router.get('/rules', async (req, res) => {
  const rows = await query('SELECT * FROM notification_rules ORDER BY event');
  res.json(rows.map(r => ({ ...r, recipients: J(r.recipients, []) })));
});
router.put('/rules/:event', async (req, res) => {
  const { name, template, recipients, is_active } = req.body;
  if (!template) return res.status(400).json({ error: 'template requerido' });
  const ev = req.params.event;
  const rec = JSON.stringify([].concat(recipients || []));
  const act = is_active === 0 || is_active === false ? 0 : 1;
  const ex = await queryOne('SELECT id FROM notification_rules WHERE event = ?', [ev]);
  if (ex) await query('UPDATE notification_rules SET name = ?, template = ?, recipients = ?, is_active = ? WHERE event = ?', [name || ev, template, rec, act, ev]);
  else await query('INSERT INTO notification_rules (event, name, template, recipients, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)', [ev, name || ev, template, rec, act, Date.now()]);
  res.json({ ok: true });
});
router.delete('/rules/:event', async (req, res) => {
  await query('DELETE FROM notification_rules WHERE event = ?', [req.params.event]);
  res.json({ ok: true });
});
// Vista previa de la plantilla con datos de ejemplo (no envía nada)
router.post('/rules/preview', (req, res) => {
  res.json({ text: renderTemplate(req.body.template || '', { event: req.body.event, data: req.body.data || {} }) });
});
// Disparo de prueba usando la regla real
router.post('/rules/:event/test', async (req, res) => {
  try {
    res.json(await notify({ event: req.params.event, data: req.body.data || {}, source: 'admin-test' }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Webhooks ─────────────────────────────────────────────────────────────────
router.get('/webhooks', async (req, res) => {
  res.json((await query('SELECT id, name, url, events, is_active, created_at FROM webhooks ORDER BY id DESC')));
});
router.post('/webhooks', async (req, res) => {
  const { name, url, events } = req.body;
  if (!/^https?:\/\//i.test(url || '')) return res.status(400).json({ error: 'url http(s) requerida' });
  const secret = 'whsec_' + crypto.randomBytes(20).toString('base64url');
  const rows = await query('INSERT INTO webhooks (name, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [name || url, url, secret, [].concat(events || '*').join(','), Date.now()]);
  res.json({ id: rows[0]?.id, secret });   // el secret se muestra solo al crear
});
router.delete('/webhooks/:id', async (req, res) => {
  await query('UPDATE webhooks SET is_active = 0 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});
router.post('/webhooks/test', (req, res) => {
  emit('webhook.test', { message: 'Evento de prueba desde el CRM' });
  res.json({ ok: true });
});
router.get('/webhooks/deliveries', async (req, res) => {
  res.json(await query('SELECT id, webhook_id, event, status, attempts, last_error, created_at FROM webhook_deliveries ORDER BY id DESC LIMIT 100'));
});

// ── Cola ─────────────────────────────────────────────────────────────────────
router.get('/queue', async (req, res) => {
  res.json(await query('SELECT id, to_jid, text, event, source, status, attempts, error, send_after, created_at, sent_at FROM outbound_queue ORDER BY id DESC LIMIT 100'));
});
router.post('/queue/:id/cancel', async (req, res) => {
  await query("UPDATE outbound_queue SET status = 'failed', error = 'cancelado manualmente' WHERE id = ? AND status = 'pending'", [req.params.id]);
  res.json({ ok: true });
});

// ── Lista de bloqueo ─────────────────────────────────────────────────────────
router.get('/blocked', async (req, res) => res.json(await query('SELECT * FROM blocked_numbers ORDER BY created_at DESC')));
router.post('/blocked', async (req, res) => {
  const p = String(req.body.phone || '').replace(/\D/g, '');
  if (p.length < 8) return res.status(400).json({ error: 'phone inválido' });
  await query('INSERT OR IGNORE INTO blocked_numbers (phone, reason, created_at) VALUES (?, ?, ?)', [p, req.body.reason || 'manual', Date.now()]);
  res.json({ ok: true });
});
router.delete('/blocked/:phone', async (req, res) => {
  await query('DELETE FROM blocked_numbers WHERE phone = ?', [req.params.phone]);
  res.json({ ok: true });
});

// ── Anti-ban ─────────────────────────────────────────────────────────────────
router.get('/antiban', async (req, res) => res.json(await antiban.getStatus()));
router.put('/antiban', async (req, res) => res.json(await antiban.saveConfig(req.body || {})));
router.post('/antiban/resume', (req, res) => { antiban.resume(); res.json({ ok: true }); });

module.exports = router;
