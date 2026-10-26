/**
 * routes/v1.js — API pública para sistemas externos / plugins (autenticación por API key)
 *
 *   GET  /api/v1/status
 *   POST /api/v1/notify     { event, data, to?, text?, dedupe_key? }   ← caso WooCommerce / ToursFlow
 *   POST /api/v1/messages   { to, text, dedupe_key? }
 *   GET  /api/v1/messages/:id
 *   GET  /api/v1/groups
 */
const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');
const { getStatus } = require('../baileys');
const antiban = require('../antiban');
const { apiKeyAuth, notify, enqueueMessage } = require('../integrations');

const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });
const dedupe = (req) => req.get('idempotency-key') || req.body?.dedupe_key || null;

router.get('/status', apiKeyAuth('read'), async (req, res) => {
  const wa = getStatus();
  const ab = await antiban.getStatus();
  const pending = await queryOne("SELECT COUNT(*) AS n FROM outbound_queue WHERE status = 'pending'");
  res.json({
    whatsapp: wa.status,
    queue_pending: Number(pending?.n) || 0,
    sending_paused: ab.paused, paused_reason: ab.paused_reason,
    quiet_hours_now: ab.quiet_hours_now,
  });
});

router.post('/notify', apiKeyAuth('send'), async (req, res) => {
  const { event, data, to, text } = req.body || {};
  if (!event && !text) return res.status(400).json({ error: 'Falta "event" (o "text" + "to")' });
  try {
    const out = await notify({ event, data: data || {}, to, text, dedupeKey: dedupe(req), source: `key:${req.apiKey.name}` });
    res.status(202).json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
});

router.post('/messages', apiKeyAuth('send'), async (req, res) => {
  const { to, text } = req.body || {};
  const list = [].concat(to || []);
  if (!list.length || !text) return res.status(400).json({ error: '"to" y "text" requeridos' });
  if (list.length > 20) return res.status(400).json({ error: 'Máximo 20 destinatarios por llamada' });
  try {
    const queued = [];
    for (const t of list) queued.push(await enqueueMessage({ to: t, text, source: `key:${req.apiKey.name}`, dedupeKey: dedupe(req) }));
    res.status(202).json({ ok: true, queued });
  } catch (e) { fail(res, e); }
});

router.get('/messages/:id', apiKeyAuth('read'), async (req, res) => {
  const m = await queryOne(
    'SELECT id, to_jid AS "to", status, attempts, error, event, created_at, sent_at, message_id FROM outbound_queue WHERE id = ?', [req.params.id]);
  if (!m) return res.status(404).json({ error: 'No encontrado' });
  res.json(m);
});

router.get('/groups', apiKeyAuth('read'), async (req, res) => {
  res.json(await query('SELECT jid, group_name AS name FROM conversations WHERE is_group = 1 ORDER BY group_name'));
});

module.exports = router;
