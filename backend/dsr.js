/**
 * dsr.js — Derechos de los interesados (RGPD arts. 15, 17 y 20): buscar, exportar y eliminar los datos de una persona.
 * Cubre contactos, conversaciones 1:1, mensajes, notas, etiquetas, campañas, cola de envíos y bitácora.
 * En grupos no se borran los mensajes de terceros: los de la persona se anonimizan.
 * Se conserva (opcional) la entrada de la lista de bloqueo como registro de supresión (para no volver a contactarla).
 */
const crypto = require('crypto');
const { query, queryOne } = require('./db');
const { phoneVariants } = require('./antiban');

const inList = (arr) => arr.map(() => '?').join(', ');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = (r) => Number(r?.n) || 0;

async function resolveSubject(q) {
  q = String(q || '').trim();
  if (q.replace(/\D/g, '').length < 7 && !q.includes('@')) throw Object.assign(new Error('Ingresá un teléfono (mínimo 7 dígitos) o un JID'), { status: 400 });
  const phones = new Set(), jids = new Set();
  const base = q.split('@')[0].replace(/\D/g, '');
  if (base.length >= 7) phoneVariants(base).forEach(p => phones.add(p));
  if (q.includes('@') && !q.endsWith('@g.us')) jids.add(q);
  for (const p of phones) jids.add(`${p}@s.whatsapp.net`);

  const contacts = phones.size ? await query(`SELECT * FROM contacts WHERE phone IN (${inList([...phones])})`, [...phones]) : [];
  const ids = contacts.map(c => c.id);
  const jl = [...jids];
  let convs = [];
  if (jl.length || ids.length) {
    const parts = [], params = [];
    if (jl.length) { parts.push(`jid IN (${inList(jl)})`); params.push(...jl); }
    if (ids.length) { parts.push(`contact_id IN (${inList(ids)})`); params.push(...ids); }
    convs = (await query(`SELECT * FROM conversations WHERE (${parts.join(' OR ')}) AND jid NOT LIKE '%@g.us'`, params));
  }
  convs.forEach(c => jids.add(c.jid));
  return { phones: [...phones], jids: [...jids], contacts, convs, key: [...phones][0] || [...jids][0] };
}

async function summarize(q) {
  const s = await resolveSubject(q);
  const J = s.jids, P = s.phones;
  const cnt = async (sql, params) => params.length ? num(await queryOne(sql, params)) : 0;
  return {
    found: s.contacts.length + s.convs.length > 0,
    contacts: s.contacts.map(c => ({ id: c.id, name: c.name, phone: c.phone, consent_status: c.consent_status || 'unknown' })),
    conversations: s.convs.length,
    messages: await cnt(`SELECT COUNT(*) AS n FROM messages WHERE jid IN (${inList(J)})`, J),
    group_messages: await cnt(`SELECT COUNT(*) AS n FROM messages WHERE sender_jid IN (${inList(J)})`, J),
    notes: await cnt(`SELECT COUNT(*) AS n FROM conversation_notes WHERE jid IN (${inList(J)})`, J),
    campaign_rows: await cnt(`SELECT COUNT(*) AS n FROM campaign_contacts WHERE phone IN (${inList(P)})`, P),
    queued_messages: await cnt(`SELECT COUNT(*) AS n FROM outbound_queue WHERE to_jid IN (${inList(J)})`, J),
    blocked: await cnt(`SELECT COUNT(*) AS n FROM blocked_numbers WHERE phone IN (${inList(P)})`, P) > 0,
  };
}

async function exportSubject(q) {
  const s = await resolveSubject(q);
  const J = s.jids, P = s.phones;
  const rows = async (sql, params) => params.length ? await query(sql, params) : [];
  const cids = s.convs.map(c => c.id);
  const data = {
    contactos: s.contacts,
    etiquetas_del_contacto: s.contacts.length ? await query(`SELECT cl.contact_id, l.name AS etiqueta FROM contact_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.contact_id IN (${inList(s.contacts.map(c => c.id))})`, s.contacts.map(c => c.id)) : [],
    conversaciones: s.convs,
    etiquetas_de_conversaciones: cids.length ? await query(`SELECT cvl.conversation_id, l.name AS etiqueta FROM conversation_labels cvl JOIN labels l ON l.id = cvl.label_id WHERE cvl.conversation_id IN (${inList(cids)})`, cids) : [],
    // media_data no se exporta: contiene claves de descarga de archivos, no datos de la persona
    mensajes: await rows(`SELECT message_id, jid, direction, type, content, timestamp, is_auto_reply, sent_by, created_at FROM messages WHERE jid IN (${inList(J)}) ORDER BY timestamp`, J),
    mensajes_en_grupos: await rows(`SELECT message_id, jid, type, content, timestamp, sender_jid, sender_name FROM messages WHERE sender_jid IN (${inList(J)}) ORDER BY timestamp`, J),
    notas_internas: await rows(`SELECT n.id, n.jid, n.text, n.pinned, n.created_at, u.display_name AS autor FROM conversation_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.jid IN (${inList(J)})`, J),
    campanas: await rows(`SELECT cc.campaign_id, c.name AS campana, cc.phone, cc.name, cc.status, cc.sent_at, cc.error FROM campaign_contacts cc LEFT JOIN campaigns c ON c.id = cc.campaign_id WHERE cc.phone IN (${inList(P)})`, P),
    cola_de_envios: await rows(`SELECT id, to_jid, text, event, status, created_at, sent_at FROM outbound_queue WHERE to_jid IN (${inList(J)})`, J),
    lista_de_bloqueo: await rows(`SELECT phone, reason, created_at FROM blocked_numbers WHERE phone IN (${inList(P)})`, P),
    bitacora: await rows(`SELECT action, target_jid, detail, created_at FROM activity_log WHERE target_jid IN (${inList(J)})`, J),
  };
  await query('INSERT INTO activity_log (user_id, action, target_jid, detail) VALUES (?, ?, ?, ?)', [null, 'dsr_export', null, JSON.stringify({ subject_hash: hash(s.key).slice(0, 16) })]).catch(() => {});
  return { generado_el: new Date().toISOString(), sujeto: { consulta: q, telefonos: P }, datos: data };
}

async function eraseSubject(q, { userId = null, keepSuppression = true } = {}) {
  const s = await resolveSubject(q);
  const J = s.jids, P = s.phones;
  if (!s.contacts.length && !s.convs.length) throw Object.assign(new Error('No se encontraron datos de esa persona'), { status: 404 });
  const counts = {};
  const del = async (key, sql, params) => { if (!params.length) { counts[key] = 0; return; } const n = num(await queryOne(sql.replace(/^DELETE/, 'SELECT COUNT(*) AS n'), params)); counts[key] = n; if (n) await query(sql, params); };

  const cids = s.convs.map(c => c.id);
  if (cids.length) await query(`DELETE FROM conversation_labels WHERE conversation_id IN (${inList(cids)})`, cids);
  await del('mensajes', `DELETE FROM messages WHERE jid IN (${inList(J)})`, J);
  await del('notas', `DELETE FROM conversation_notes WHERE jid IN (${inList(J)})`, J);
  await del('conversaciones', `DELETE FROM conversations WHERE jid IN (${inList(J)})`, J);
  if (s.contacts.length) {
    const ids = s.contacts.map(c => c.id);
    await query(`DELETE FROM contact_labels WHERE contact_id IN (${inList(ids)})`, ids);
    counts.contactos = ids.length; await query(`DELETE FROM contacts WHERE id IN (${inList(ids)})`, ids);
  } else counts.contactos = 0;
  await del('filas_de_campañas', `DELETE FROM campaign_contacts WHERE phone IN (${inList(P)})`, P);
  await del('cola_de_envios', `DELETE FROM outbound_queue WHERE to_jid IN (${inList(J)})`, J);
  await del('registro_de_envios', `DELETE FROM send_log WHERE jid IN (${inList(J)})`, J);
  // Mensajes de la persona en grupos: se anonimizan (los de otros participantes se conservan)
  counts.mensajes_en_grupos = num(await queryOne(`SELECT COUNT(*) AS n FROM messages WHERE sender_jid IN (${inList(J)})`, J));
  if (counts.mensajes_en_grupos) await query(`UPDATE messages SET content = '[mensaje eliminado]', sender_jid = NULL, sender_name = NULL, media_data = NULL WHERE sender_jid IN (${inList(J)})`, J);
  // Entregas de webhooks que contienen su teléfono en el payload
  let hooks = 0;
  for (const p of P) { hooks += num(await queryOne('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE payload LIKE ?', [`%${p}%`])); await query('DELETE FROM webhook_deliveries WHERE payload LIKE ?', [`%${p}%`]); }
  counts.entregas_de_webhooks = hooks;
  // Bitácora: se desvincula del sujeto
  await query(`UPDATE activity_log SET target_jid = NULL, detail = NULL WHERE target_jid IN (${inList(J)})`, J);
  // Lista de bloqueo: se conserva como registro de supresión (no volver a contactar), o se elimina
  const wasBlocked = num(await queryOne(`SELECT COUNT(*) AS n FROM blocked_numbers WHERE phone IN (${inList(P)})`, P)) > 0;
  if (!keepSuppression && wasBlocked) await query(`DELETE FROM blocked_numbers WHERE phone IN (${inList(P)})`, P);
  counts.lista_de_bloqueo_conservada = keepSuppression && wasBlocked ? 1 : 0;

  const subjectHash = hash(s.key);
  await query('INSERT INTO dsr_log (action, subject_hash, by_user, counts, created_at) VALUES (?, ?, ?, ?, ?)', ['erase', subjectHash, userId, JSON.stringify(counts), Date.now()]);
  require('./bus').emitEvent('privacy.erased', { subject_hash: subjectHash.slice(0, 16) });
  return { ok: true, counts, subject_hash: subjectHash };
}

async function erasureLog() {
  return (await query("SELECT id, action, subject_hash, by_user, counts, created_at FROM dsr_log WHERE action = 'erase' ORDER BY id DESC LIMIT 1000"))
    .map(r => ({ ...r, created_at: Number(r.created_at), counts: (() => { try { return JSON.parse(r.counts); } catch (e) { return {}; } })() }));
}

module.exports = { summarize, exportSubject, eraseSubject, erasureLog, hash };
