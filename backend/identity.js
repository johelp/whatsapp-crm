/**
 * identity.js — Identidades de WhatsApp: LID (@lid, identificador privado sin número) ↔ teléfono ↔ nombre.
 *
 * WhatsApp identifica cada vez más chats con @lid y NO entrega el número. Para mostrar nombres y enlazar con los
 * contactos agendados hay que aprender las equivalencias que WhatsApp sí comparte en algunos eventos
 * (historial, contacts.upsert/update, chats.phoneNumberShare, claves de mensajes) y guardarlas.
 *
 *   lid_map(lid → phone)      equivalencias aprendidas (o declaradas a mano por el operador)
 *   wa_names(jid → nombre)    nombres de la agenda del teléfono ("contact") o que la persona se puso ("push")
 *
 * Los nombres de la agenda NO crean contactos en el CRM (solo etiquetan chats): evita importar toda la libreta.
 */
const { query, queryOne } = require('./db');
const { phoneVariants } = require('./antiban');

const isLid = (j) => String(j || '').endsWith('@lid');
const isGroup = (j) => String(j || '').endsWith('@g.us');
const digits = (j) => String(j || '').split('@')[0].replace(/\D/g, '');
const cleanName = (n) => { const s = String(n ?? '').trim(); return !s || /^\+?[\d\s()-]+$/.test(s) ? null : s.slice(0, 120); };
const inList = (a) => a.map(() => '?').join(', ');
const blank = (v) => v == null || String(v).trim() === '';

async function upsert(table, keyCol, key, cols) {
  const ex = await queryOne(`SELECT ${keyCol} FROM ${table} WHERE ${keyCol} = ?`, [key]);
  const names = Object.keys(cols);
  if (ex) await query(`UPDATE ${table} SET ${names.map(n => n + ' = ?').join(', ')} WHERE ${keyCol} = ?`, [...names.map(n => cols[n]), key]);
  else await query(`INSERT INTO ${table} (${keyCol}, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`, [key, ...names.map(n => cols[n])]);
}

/** Aprende que `lid` corresponde al teléfono de `pnJid`. */
async function rememberMapping(lid, pnJid, source = 'wa', apply = true) {
  if (!isLid(lid) || !pnJid || isLid(pnJid) || isGroup(pnJid)) return false;
  const phone = digits(pnJid);
  if (phone.length < 7) return false;
  const cur = await queryOne('SELECT source FROM lid_map WHERE lid = ?', [lid]);
  if (cur?.source === 'manual' && source !== 'manual') return false;   // lo declarado por el operador manda
  await upsert('lid_map', 'lid', lid, { phone, source, updated_at: Date.now() });
  if (apply) await applyIdentity(lid);
  return true;
}

/** Guarda un nombre: source 'contact' = de la agenda del teléfono (el mejor), 'push' = el que la persona se puso. */
async function rememberName(jid, name, source = 'push', apply = true) {
  name = cleanName(name);
  if (!name || isGroup(jid) || !jid) return false;
  const cur = await queryOne('SELECT source FROM wa_names WHERE jid = ?', [jid]);
  if (cur?.source === 'contact' && source !== 'contact') return false;
  await upsert('wa_names', 'jid', jid, { name, source, updated_at: Date.now() });
  if (apply) await applyIdentity(jid);
  return true;
}

async function partnersOf(jid) {
  const jids = new Set([jid]);
  if (isLid(jid)) {
    const m = await queryOne('SELECT phone FROM lid_map WHERE lid = ?', [jid]);
    if (m) phoneVariants(m.phone).forEach(p => jids.add(`${p}@s.whatsapp.net`));
  } else {
    const phones = phoneVariants(digits(jid));
    const rows = await query(`SELECT lid FROM lid_map WHERE phone IN (${inList(phones)})`, phones);
    rows.forEach(r => jids.add(r.lid));
  }
  return [...jids];
}

/** Propaga lo que se sabe (nombre y contacto) a las conversaciones de esa persona. */
async function applyIdentity(jid) {
  if (!jid || isGroup(jid)) return;
  const all = await partnersOf(jid);
  const names = await query(`SELECT name, source FROM wa_names WHERE jid IN (${inList(all)})`, all);
  const best = names.find(n => n.source === 'contact') || names[0] || null;

  // Teléfono conocido de esta persona (si lo hay): del mapeo o del propio JID
  let phone = null;
  const pn = all.find(j => !isLid(j));
  if (pn) phone = digits(pn);
  const contact = phone ? await findContact(phone) : null;

  const convs = await query(`SELECT jid, contact_id, wa_push_name FROM conversations WHERE jid IN (${inList(all)})`, all);
  for (const c of convs) {
    if (best && (best.source === 'contact' || blank(c.wa_push_name))) {
      await query('UPDATE conversations SET wa_push_name = ? WHERE jid = ?', [best.name, c.jid]);
    }
    if (contact && !c.contact_id) await query('UPDATE conversations SET contact_id = ? WHERE jid = ?', [contact.id, c.jid]);
  }
  if (contact && best && blank(contact.name)) await query('UPDATE contacts SET name = ? WHERE id = ?', [best.name, contact.id]);
}

async function findContact(phone) {
  const v = phoneVariants(phone);
  return queryOne(`SELECT * FROM contacts WHERE phone IN (${inList(v)})`, v);
}

/** Al crear/editar/importar un contacto con su número real: enlaza los chats @lid que ya se sabe que son suyos. */
async function linkPhone(phone) {
  const v = phoneVariants(String(phone).replace(/\D/g, ''));
  if (!v[0] || v[0].length < 7) return 0;
  const lids = await query(`SELECT lid FROM lid_map WHERE phone IN (${inList(v)})`, v);
  for (const l of lids) await applyIdentity(l.lid);
  return lids.length;
}

/** Reaplica lo aprendido a TODAS las conversaciones 1:1 (se usa tras una carga masiva del historial). */
async function applyAll() {
  const rows = await query("SELECT jid FROM conversations WHERE jid NOT LIKE '%@g.us'");
  for (const r of rows) await applyIdentity(r.jid).catch(() => {});
  return rows.length;
}

/** El operador declara a mano a quién corresponde un chat @lid. */
async function setManualMapping(lid, phone) {
  const p = String(phone).replace(/\D/g, '');
  if (!isLid(lid) || p.length < 7) throw new Error('Teléfono inválido');
  await upsert('lid_map', 'lid', lid, { phone: p, source: 'manual', updated_at: Date.now() });
  await applyIdentity(lid);
}

/** Reparación: reaplica todo lo aprendido y enlaza por nombre exacto cuando es inequívoco. */
async function relinkAll() {
  const out = { mapeos_aplicados: 0, nombres_aplicados: 0, vinculados_por_nombre: 0, siguen_sin_nombre: 0 };
  const lids = await query("SELECT jid, contact_id, wa_push_name FROM conversations WHERE jid LIKE '%@lid'");
  for (const c of lids) {
    const before = { name: c.wa_push_name, contact: c.contact_id };
    await applyIdentity(c.jid);
    const now = await queryOne('SELECT contact_id, wa_push_name FROM conversations WHERE jid = ?', [c.jid]);
    if (!before.contact && now.contact_id) out.mapeos_aplicados++;
    if (blank(before.name) && !blank(now.wa_push_name)) out.nombres_aplicados++;
    if (!now.contact_id && !blank(now.wa_push_name)) {
      const same = await query('SELECT id FROM contacts WHERE LOWER(name) = LOWER(?)', [now.wa_push_name]);
      if (same.length === 1) { await query('UPDATE conversations SET contact_id = ? WHERE jid = ?', [same[0].id, c.jid]); out.vinculados_por_nombre++; }
    }
  }
  const left = await queryOne("SELECT COUNT(*) AS n FROM conversations WHERE jid LIKE '%@lid' AND contact_id IS NULL AND (wa_push_name IS NULL OR wa_push_name = '')");
  out.siguen_sin_nombre = Number(left?.n) || 0;
  return out;
}

async function diagnose() {
  const n = async (sql) => Number((await queryOne(sql))?.n) || 0;
  return {
    conversaciones: await n('SELECT COUNT(*) AS n FROM conversations WHERE is_group IS NULL OR is_group = 0'),
    privadas_lid: await n("SELECT COUNT(*) AS n FROM conversations WHERE jid LIKE '%@lid'"),
    privadas_sin_nombre: await n("SELECT COUNT(*) AS n FROM conversations WHERE jid LIKE '%@lid' AND (wa_push_name IS NULL OR wa_push_name = '') AND contact_id IS NULL"),
    privadas_con_contacto: await n("SELECT COUNT(*) AS n FROM conversations WHERE jid LIKE '%@lid' AND contact_id IS NOT NULL"),
    equivalencias_aprendidas: await n('SELECT COUNT(*) AS n FROM lid_map'),
    nombres_de_agenda: await n("SELECT COUNT(*) AS n FROM wa_names WHERE source = 'contact'"),
    nombres_de_perfil: await n("SELECT COUNT(*) AS n FROM wa_names WHERE source = 'push'"),
    contactos_en_crm: await n('SELECT COUNT(*) AS n FROM contacts'),
  };
}

module.exports = { applyAll, rememberMapping, rememberName, applyIdentity, linkPhone, setManualMapping, relinkAll, diagnose, isLid, digits };
