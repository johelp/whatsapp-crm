/**
 * routes/api.js — Todas las rutas REST
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const csvParser = require('csv-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { query, queryOne, USE_PG } = require('../db');
const { sendMessage, sendGroupMessage, sendFile, getStatus, logout, normalizePhone, getSock } = require('../baileys');
const { runCampaign, isRunning, requestCancel } = require('../sender');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Carpeta de archivos de biblioteca
const FILES_DIR = path.join(__dirname, '../../data/files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// Multer: CSV uploads al temp
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 5 * 1024 * 1024 } });

// Multer: biblioteca de archivos (hasta 20MB, guardados en data/files)
const fileUpload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ext = path.extname(file.originalname);
      cb(null, `${unique}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

router.get('/wa/status', (req, res) => res.json(getStatus()));

router.post('/wa/logout', requireAuth, requireAdmin, async (req, res) => {
  await logout();
  res.json({ ok: true });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  const user = await queryOne('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
  if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  req.session.user = { id: user.id, username: user.username, display_name: user.display_name, role: user.role, color: user.color };
  await query('UPDATE users SET last_seen = datetime(\'now\') WHERE id = ?', [user.id]);
  res.json({ ok: true, user: req.session.user });
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'No autenticado' });
  res.json(req.session.user);
});

// ─── Users ────────────────────────────────────────────────────────────────────

router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  res.json(await query('SELECT id, username, display_name, role, color, is_active, last_seen FROM users ORDER BY display_name'));
});

router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, display_name, password, role, color } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username y password requeridos' });
  const hash = await bcrypt.hash(password, 10);
  const rows = await query(
    'INSERT INTO users (username, display_name, password_hash, role, color) VALUES (?, ?, ?, ?, ?)',
    [username, display_name || username, hash, role || 'agent', color || '#6366f1']
  );
  res.json({ id: rows[0]?.lastInsertRowid, ok: true });
});

router.put('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { display_name, role, color, is_active, password } = req.body;
  if (parseInt(req.params.id) === req.session.user.id && is_active === 0) {
    return res.status(400).json({ error: 'No podés desactivarte a vos mismo' });
  }
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
  }
  await query('UPDATE users SET display_name = ?, role = ?, color = ?, is_active = ? WHERE id = ?',
    [display_name, role, color, is_active != null ? (is_active ? 1 : 0) : 1, req.params.id]);
  res.json({ ok: true });
});

router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) return res.status(400).json({ error: 'No podés eliminarte a vos mismo' });
  await query('UPDATE users SET is_active = 0 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Contacts ─────────────────────────────────────────────────────────────────

router.get('/contacts', requireAuth, async (req, res) => {
  const rows = await query('SELECT * FROM contacts ORDER BY name');
  const result = await Promise.all(rows.map(async (row) => {
    const labels = await query(`
      SELECT l.id, l.name, l.color FROM contact_labels cl
      JOIN labels l ON cl.label_id = l.id WHERE cl.contact_id = ?`, [row.id]);
    return { ...row, labels };
  }));
  res.json(result);
});

router.post('/contacts', requireAuth, async (req, res) => {
  const { phone, name, company, extra, notes } = req.body;
  if (!phone) return res.status(400).json({ error: 'Telefono requerido' });
  const clean = normalizePhone(phone);
  await query(
    'INSERT OR IGNORE INTO contacts (phone, name, company, extra, notes) VALUES (?, ?, ?, ?, ?)',
    [clean, name || '', company || '', extra || '', notes || '']
  );
  // Si ya existía, actualizar datos
  await query(
    'UPDATE contacts SET name = ?, company = ?, extra = ?, notes = ?, updated_at = datetime(\'now\') WHERE phone = ? AND (name = \'\' OR name IS NULL OR name = phone)',
    [name || '', company || '', extra || '', notes || '', clean]
  );
  const c = await queryOne('SELECT * FROM contacts WHERE phone = ?', [clean]);
  res.json(c);
});

router.put('/contacts/:id', requireAuth, async (req, res) => {
  const { name, company, extra, notes } = req.body;
  await query('UPDATE contacts SET name = ?, company = ?, extra = ?, notes = ?, updated_at = NOW() WHERE id = ?',
    [name, company, extra, notes, req.params.id]);
  // Notificar al frontend que recargue conversaciones (el nombre cambió)
  res.json({ ok: true, reload: true });
});

// Guardar contacto desde conversación (upsert por JID/phone)
router.post('/contacts/from-conversation', requireAuth, async (req, res) => {
  const { jid, name, company, extra, notes } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid requerido' });
  
  // Para @lid el "phone" del JID no es real — usar el phone del contacto si ya existe
  const isLid = jid.endsWith('@lid');
  const rawPhone = jid.split('@')[0];
  const phone = isLid ? rawPhone : normalizePhone(rawPhone);

  try {
    // Upsert PostgreSQL
    await query(
      `INSERT INTO contacts (phone, name, company, extra, notes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (phone) DO UPDATE SET
         name = EXCLUDED.name,
         company = COALESCE(NULLIF(EXCLUDED.company,''), contacts.company),
         extra = COALESCE(NULLIF(EXCLUDED.extra,''), contacts.extra),
         notes = COALESCE(NULLIF(EXCLUDED.notes,''), contacts.notes),
         updated_at = NOW()`,
      [phone, name || '', company || '', extra || '', notes || '']
    );
  } catch(e) {
    // Fallback SQLite
    await query('INSERT OR IGNORE INTO contacts (phone, name, company, extra, notes) VALUES (?, ?, ?, ?, ?)',
      [phone, name || '', company || '', extra || '', notes || '']);
    await query('UPDATE contacts SET name=?, company=?, extra=?, notes=?, updated_at=datetime(\'now\') WHERE phone=?',
      [name || '', company || '', extra || '', notes || '', phone]);
  }
  
  const c = await queryOne('SELECT * FROM contacts WHERE phone = ?', [phone]);
  if (c) {
    // Vincular conversación + actualizar wa_push_name para que aparezca en la lista
    await query(
      `UPDATE conversations SET contact_id = ?, wa_push_name = COALESCE(wa_push_name, ?) WHERE jid = ?`,
      [c.id, name || null, jid]
    );
  }
  res.json({ ...(c || {}), ok: true });
});

router.delete('/contacts/:id', requireAuth, requireAdmin, async (req, res) => {
  await query('DELETE FROM contacts WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.post('/contacts/:id/labels/:labelId', requireAuth, async (req, res) => {
  await query('INSERT OR IGNORE INTO contact_labels (contact_id, label_id) VALUES (?, ?)', [req.params.id, req.params.labelId]);
  res.json({ ok: true });
});

router.delete('/contacts/:id/labels/:labelId', requireAuth, async (req, res) => {
  await query('DELETE FROM contact_labels WHERE contact_id = ? AND label_id = ?', [req.params.id, req.params.labelId]);
  res.json({ ok: true });
});

// Import CSV contacts
router.post('/contacts/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
  let imported = 0, skipped = 0;
  const rows = [];
  await new Promise(resolve => {
    fs.createReadStream(req.file.path).pipe(csvParser()).on('data', row => rows.push(row)).on('end', resolve);
  });
  for (const row of rows) {
    const raw = row.phone || row.telefono || row.numero || Object.values(row)[0] || '';
    const phone = normalizePhone(raw);
    if (phone.length >= 7) {
      await query('INSERT OR IGNORE INTO contacts (phone, name, company, extra) VALUES (?, ?, ?, ?)',
        [phone, row.name || row.nombre || '', row.company || row.empresa || '', row.extra || row.campo || '']);
      imported++;
    } else skipped++;
  }
  fs.unlinkSync(req.file.path);
  res.json({ imported, skipped });
});

// ─── Labels ───────────────────────────────────────────────────────────────────

router.get('/labels', requireAuth, async (req, res) => res.json(await query('SELECT * FROM labels ORDER BY name')));

router.post('/labels', requireAuth, async (req, res) => {
  const rows = await query('INSERT INTO labels (name, color, description) VALUES (?, ?, ?)',
    [req.body.name, req.body.color || '#6366f1', req.body.description || '']);
  res.json({ id: rows[0]?.lastInsertRowid, ...req.body });
});

router.put('/labels/:id', requireAuth, async (req, res) => {
  await query('UPDATE labels SET name = ?, color = ?, description = ? WHERE id = ?',
    [req.body.name, req.body.color, req.body.description, req.params.id]);
  res.json({ ok: true });
});

router.delete('/labels/:id', requireAuth, requireAdmin, async (req, res) => {
  await query('DELETE FROM labels WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Conversations ────────────────────────────────────────────────────────────

router.get('/conversations', requireAuth, async (req, res) => {
  const { status, assigned, search } = req.query;

  const phoneFromJid = USE_PG
    ? `SPLIT_PART(cv.jid, '@', 1)`
    : `SUBSTR(cv.jid, 1, INSTR(cv.jid, '@') - 1)`;

  // Prioridad de nombre: 1) nombre agendado (si no es igual al teléfono) 2) push_name de WA 3) nombre agendado igual al tel 4) teléfono del JID
  const displayName = USE_PG
    ? `COALESCE(NULLIF(c.name, ${phoneFromJid}), cv.wa_push_name, c.name, ${phoneFromJid})`
    : `COALESCE(CASE WHEN c.name != ${phoneFromJid} THEN c.name ELSE NULL END, cv.wa_push_name, c.name, ${phoneFromJid})`;

  let sql = `
    SELECT cv.*,
      CASE WHEN cv.is_group = 1 THEN COALESCE(cv.group_name, ${phoneFromJid})
           ELSE ${displayName}
      END as contact_name,
      CASE WHEN cv.is_group = 1 THEN NULL
           ELSE COALESCE(c.phone, ${phoneFromJid})
      END as contact_phone,
      c.name as contact_saved_name,
      c.company as company,
      u.display_name as assigned_name, u.color as assigned_color
    FROM conversations cv
    LEFT JOIN contacts c ON cv.contact_id = c.id
    LEFT JOIN users u ON cv.assigned_to = u.id
    WHERE 1=1
  `;
  const params = [];
  if (status && status !== 'all') { sql += ' AND cv.status = ?'; params.push(status); }
  if (assigned === 'me') { sql += ' AND cv.assigned_to = ?'; params.push(req.session.user.id); }
  if (search) {
    if (USE_PG) {
      sql += ` AND (c.name ILIKE ? OR c.phone LIKE ? OR cv.wa_push_name ILIKE ? OR cv.last_message ILIKE ? OR ${phoneFromJid} LIKE ? OR cv.group_name ILIKE ?)`;
    } else {
      sql += ` AND (c.name LIKE ? OR c.phone LIKE ? OR cv.wa_push_name LIKE ? OR cv.last_message LIKE ? OR ${phoneFromJid} LIKE ? OR cv.group_name LIKE ?)`;
    }
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY cv.last_message_at DESC LIMIT 200';

  try {
    const rows = await query(sql, params);
    const result = await Promise.all(rows.map(async (row) => {
      const labels = await query(`
        SELECT l.id, l.name, l.color FROM conversation_labels cvl
        JOIN labels l ON cvl.label_id = l.id WHERE cvl.conversation_id = ?`, [row.id]);
      if (!row.contact_name) row.contact_name = row.jid.split('@')[0];
      return { ...row, labels };
    }));
    res.json(result);
  } catch (e) {
    console.error('Error en GET /conversations:', e.message);
    try {
      const rows = await query(`SELECT * FROM conversations ORDER BY last_message_at DESC LIMIT 200`);
      res.json(rows.map(r => ({ ...r, labels: [], contact_name: r.wa_push_name || r.jid.split('@')[0] })));
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

router.get('/conversations/:jid/messages', requireAuth, async (req, res) => {
  const jidParam = decodeURIComponent(req.params.jid);
  const msgs = await query(USE_PG ? `
    SELECT m.id, m.message_id, m.jid, m.direction, m.type, m.content,
           m.timestamp::bigint as timestamp,
           m.is_read, m.is_auto_reply, m.sent_by, m.sender_jid, m.sender_name,
           m.media_data, m.created_at,
           u.display_name as sent_by_name, u.color as sent_by_color
    FROM messages m LEFT JOIN users u ON m.sent_by = u.id
    WHERE m.jid = ? ORDER BY m.timestamp ASC LIMIT 300
  ` : `
    SELECT m.id, m.message_id, m.jid, m.direction, m.type, m.content,
           m.timestamp,
           m.is_read, m.is_auto_reply, m.sent_by, m.sender_jid, m.sender_name,
           m.media_data, m.created_at,
           u.display_name as sent_by_name, u.color as sent_by_color
    FROM messages m LEFT JOIN users u ON m.sent_by = u.id
    WHERE m.jid = ? ORDER BY m.timestamp ASC LIMIT 300
  `, [jidParam]);
  // Asegurar que timestamp es siempre número
  res.json(msgs.map(m => ({ ...m, timestamp: Number(m.timestamp) || 0 })));
});

router.post('/conversations/:jid/read', requireAuth, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  await query('UPDATE conversations SET unread_count = 0 WHERE jid = ?', [jid]);
  await query('UPDATE messages SET is_read = 1 WHERE jid = ?', [jid]);
  res.json({ ok: true });
});

router.put('/conversations/:jid/status', requireAuth, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  await query('UPDATE conversations SET status = ?, updated_at = datetime(\'now\') WHERE jid = ?', [req.body.status, jid]);
  res.json({ ok: true });
});

router.put('/conversations/:jid/assign', requireAuth, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  await query('UPDATE conversations SET assigned_to = ?, updated_at = datetime(\'now\') WHERE jid = ?', [req.body.user_id || null, jid]);
  res.json({ ok: true });
});

router.post('/conversations/:jid/labels/:labelId', requireAuth, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const conv = await queryOne('SELECT id FROM conversations WHERE jid = ?', [jid]);
  if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });
  await query('INSERT OR IGNORE INTO conversation_labels (conversation_id, label_id) VALUES (?, ?)', [conv.id, req.params.labelId]);
  res.json({ ok: true });
});

router.delete('/conversations/:jid/labels/:labelId', requireAuth, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const conv = await queryOne('SELECT id FROM conversations WHERE jid = ?', [jid]);
  if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });
  await query('DELETE FROM conversation_labels WHERE conversation_id = ? AND label_id = ?', [conv.id, req.params.labelId]);
  res.json({ ok: true });
});

// Eliminar conversación (soft: solo del CRM, hard: también mensajes)
router.delete('/conversations/:jid', requireAuth, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const { hard } = req.query; // ?hard=1 para borrar mensajes también
  const conv = await queryOne('SELECT id FROM conversations WHERE jid = ?', [jid]);
  if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });

  await query('DELETE FROM conversation_labels WHERE conversation_id = ?', [conv.id]);

  if (hard === '1') {
    await query('DELETE FROM messages WHERE jid = ?', [jid]);
  }

  await query('DELETE FROM conversations WHERE jid = ?', [jid]);
  res.json({ ok: true });
});

// ─── Send Message ─────────────────────────────────────────────────────────────

router.post('/send', requireAuth, async (req, res) => {
  const { phone, message, jid } = req.body;
  if (!message) return res.status(400).json({ error: 'message requerido' });
  try {
    // Grupos
    if (jid && jid.endsWith('@g.us')) {
      await sendGroupMessage(jid, message, req.session.user.id);
      return res.json({ ok: true });
    }
    // JID completo (@lid o @s.whatsapp.net) — pasar directamente a sendMessage
    // sendMessage ahora acepta JID completo o número suelto
    if (jid && jid.includes('@')) {
      await sendMessage(jid, message, req.session.user.id);
      return res.json({ ok: true });
    }
    // Solo número: normalizar
    const target = phone || (jid ? jid.split('@')[0] : null);
    if (!target) return res.status(400).json({ error: 'phone o jid requerido' });
    const cleanPhone = normalizePhone(target);
    await sendMessage(cleanPhone, message, req.session.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enviar archivo de biblioteca a un chat
router.post('/send-file', requireAuth, async (req, res) => {
  const { jid, file_id, caption } = req.body;
  if (!jid || !file_id) return res.status(400).json({ error: 'jid y file_id requeridos' });
  const file = await queryOne('SELECT * FROM file_library WHERE id = ?', [file_id]);
  if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });
  const filePath = path.join(FILES_DIR, file.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });
  try {
    const phone = normalizePhone(jid.split('@')[0]);
    await sendFile(phone, filePath, file.mime_type, file.original_name, caption || '', req.session.user.id);
    await query('UPDATE file_library SET use_count = use_count + 1 WHERE id = ?', [file_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Campaigns ────────────────────────────────────────────────────────────────

router.get('/campaigns', requireAuth, async (req, res) => {
  res.json(await query(`
    SELECT cp.*, u.display_name as created_by_name
    FROM campaigns cp LEFT JOIN users u ON cp.created_by = u.id
    ORDER BY cp.created_at DESC`));
});

router.post('/campaigns', requireAuth, async (req, res) => {
  const { name, type, template, delay_min, delay_max, scheduled_at, contacts: contactList } = req.body;
  if (!name || !template) return res.status(400).json({ error: 'name y template requeridos' });

  const rows = await query(
    'INSERT INTO campaigns (name, type, template, delay_min, delay_max, scheduled_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [name, type || 'general', template, delay_min || 8, delay_max || 25, scheduled_at || null, req.session.user.id]
  );
  const campaignId = rows[0]?.id || rows[0]?.lastInsertRowid;

  if (contactList?.length) {
    for (const c of contactList) {
      const phone = normalizePhone(c.phone || '');
      if (phone.length < 7) continue;
      const existing = await queryOne('SELECT id FROM contacts WHERE phone = ?', [phone]);
      await query(
        'INSERT INTO campaign_contacts (campaign_id, contact_id, phone, name, extra_field) VALUES (?, ?, ?, ?, ?)',
        [campaignId, existing?.id || null, phone, c.name || '', c.extra || '']
      );
    }
    const cnt = await queryOne('SELECT COUNT(*) as n FROM campaign_contacts WHERE campaign_id = ?', [campaignId]);
    await query('UPDATE campaigns SET total = ? WHERE id = ?', [cnt?.n || 0, campaignId]);
  }

  res.json({ id: campaignId, ok: true });
});

router.put('/campaigns/:id', requireAuth, async (req, res) => {
  const { name, type, template, delay_min, delay_max, scheduled_at } = req.body;
  const camp = await queryOne('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!camp) return res.status(404).json({ error: 'Campaña no encontrada' });
  if (camp.status === 'running') return res.status(409).json({ error: 'No se puede editar una campaña en curso' });
  await query(
    'UPDATE campaigns SET name=?, type=?, template=?, delay_min=?, delay_max=?, scheduled_at=? WHERE id=?',
    [name, type, template, delay_min || 8, delay_max || 25, scheduled_at || null, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/campaigns/:id', requireAuth, async (req, res) => {
  const camp = await queryOne('SELECT status FROM campaigns WHERE id = ?', [req.params.id]);
  if (!camp) return res.status(404).json({ error: 'Campaña no encontrada' });
  if (camp.status === 'running') return res.status(409).json({ error: 'No se puede eliminar una campaña en curso' });
  await query('DELETE FROM campaign_contacts WHERE campaign_id = ?', [req.params.id]);
  await query('DELETE FROM campaigns WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.post('/campaigns/:id/contacts/add', requireAuth, async (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'contacts requerido' });
  let added = 0;
  for (const c of contacts) {
    const phone = normalizePhone(c.phone || '');
    if (phone.length < 7) continue;
    // Evitar duplicados en la campaña
    const exists = await queryOne('SELECT id FROM campaign_contacts WHERE campaign_id = ? AND phone = ?', [req.params.id, phone]);
    if (exists) continue;
    const contact = await queryOne('SELECT id FROM contacts WHERE phone = ?', [phone]);
    await query(
      'INSERT INTO campaign_contacts (campaign_id, contact_id, phone, name, extra_field) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, contact?.id || null, phone, c.name || '', c.extra || '']
    );
    added++;
  }
  const cnt = await queryOne('SELECT COUNT(*) as n FROM campaign_contacts WHERE campaign_id = ?', [req.params.id]);
  await query('UPDATE campaigns SET total = ? WHERE id = ?', [cnt?.n || 0, req.params.id]);
  res.json({ added, total: cnt?.n || 0 });
});

router.delete('/campaigns/:id/contacts/:contactId', requireAuth, async (req, res) => {
  await query('DELETE FROM campaign_contacts WHERE id = ? AND campaign_id = ?', [req.params.contactId, req.params.id]);
  const cnt = await queryOne('SELECT COUNT(*) as n FROM campaign_contacts WHERE campaign_id = ? AND status = ?', [req.params.id, 'pending']);
  await query('UPDATE campaigns SET total = (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = ?) WHERE id = ?', [req.params.id, req.params.id]);
  res.json({ ok: true });
});

router.post('/campaigns/:id/reset', requireAuth, async (req, res) => {
  const camp = await queryOne('SELECT status FROM campaigns WHERE id = ?', [req.params.id]);
  if (camp?.status === 'running') return res.status(409).json({ error: 'Campaña en curso' });
  await query("UPDATE campaign_contacts SET status = 'pending', sent_at = NULL, error = NULL WHERE campaign_id = ?", [req.params.id]);
  const cnt = await queryOne('SELECT COUNT(*) as n FROM campaign_contacts WHERE campaign_id = ?', [req.params.id]);
  await query("UPDATE campaigns SET status = 'draft', sent = 0, failed = 0, total = ? WHERE id = ?", [cnt?.n || 0, req.params.id]);
  res.json({ ok: true });
});


// Duplicar campaña — copia config + contactos como draft
router.post('/campaigns/:id/duplicate', requireAuth, async (req, res) => {
  const src = await queryOne('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
  if (!src) return res.status(404).json({ error: 'Campaña no encontrada' });

  const rows = await query(
    'INSERT INTO campaigns (name, type, template, delay_min, delay_max, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [`${src.name} (copia)`, src.type, src.template, src.delay_min, src.delay_max, req.session.user.id]
  );
  const newId = rows[0]?.id || rows[0]?.lastInsertRowid;
  if (!newId) return res.status(500).json({ error: 'Error creando copia' });

  // Copiar todos los contactos como pending
  const contacts = await query(
    'SELECT phone, name, extra_field, contact_id FROM campaign_contacts WHERE campaign_id = ?',
    [req.params.id]
  );
  for (const c of contacts) {
    await query(
      'INSERT INTO campaign_contacts (campaign_id, contact_id, phone, name, extra_field) VALUES (?, ?, ?, ?, ?)',
      [newId, c.contact_id || null, c.phone, c.name || '', c.extra_field || '']
    );
  }
  const cnt = await queryOne('SELECT COUNT(*) as n FROM campaign_contacts WHERE campaign_id = ?', [newId]);
  await query('UPDATE campaigns SET total = ? WHERE id = ?', [cnt?.n || 0, newId]);

  res.json({ id: newId, ok: true });
});

router.get('/campaigns/:id/contacts', requireAuth, async (req, res) => {
  res.json(await query('SELECT * FROM campaign_contacts WHERE campaign_id = ? ORDER BY id', [req.params.id]));
});

router.post('/campaigns/:id/start', requireAuth, async (req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'Ya hay una campaña activa' });
  res.json({ ok: true });
  runCampaign(parseInt(req.params.id), req.session.user.id).catch(console.error);
});

router.post('/campaigns/:id/cancel', requireAuth, (req, res) => {
  requestCancel();
  res.json({ ok: true });
});

router.post('/campaigns/:id/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
  const rows = [];
  await new Promise(resolve => {
    fs.createReadStream(req.file.path).pipe(csvParser()).on('data', row => rows.push(row)).on('end', resolve);
  });
  let count = 0;
  for (const row of rows) {
    const raw = row.phone || row.telefono || row.numero || Object.values(row)[0] || '';
    const phone = normalizePhone(raw);
    if (phone.length >= 7) {
      await query('INSERT INTO campaign_contacts (campaign_id, phone, name, extra_field) VALUES (?, ?, ?, ?)',
        [req.params.id, phone, row.name || row.nombre || '', row.extra || row.campo || '']);
      count++;
    }
  }
  const cnt = await queryOne('SELECT COUNT(*) as n FROM campaign_contacts WHERE campaign_id = ?', [req.params.id]);
  await query('UPDATE campaigns SET total = ? WHERE id = ?', [cnt?.n || 0, req.params.id]);
  fs.unlinkSync(req.file.path);
  res.json({ imported: count });
});

// ─── Media download ──────────────────────────────────────────────────────────
// Descarga media de WhatsApp en tiempo real usando las claves almacenadas

router.get('/messages/:messageId/media', requireAuth, async (req, res) => {
  try {
    const msg = await queryOne(
      'SELECT media_data, type FROM messages WHERE message_id = ?',
      [req.params.messageId]
    );
    if (!msg?.media_data) return res.status(404).json({ error: 'Media no disponible' });

    const media = JSON.parse(msg.media_data);
    if (!media?.mediaKey) return res.status(404).json({ error: 'Claves de media no disponibles' });

    // Reconstruir el objeto que necesita Baileys para descargar
    const downloadable = {
      mediaKey: Buffer.from(media.mediaKey, 'base64'),
      url: media.url,
      directPath: media.directPath,
      fileEncSha256: media.fileEncSha256 ? Buffer.from(media.fileEncSha256, 'base64') : null,
      fileSha256: media.fileSha256 ? Buffer.from(media.fileSha256, 'base64') : null,
    };

    // Mapear tipo de mensaje al tipo de media para Baileys
    const mediaTypeMap = {
      imageMessage:    'image',
      videoMessage:    'video',
      audioMessage:    'audio',
      documentMessage: 'document',
      stickerMessage:  'sticker',
    };
    const baileyType = mediaTypeMap[msg.type] || 'document';

    // Importar Baileys dinámicamente (ESM)
    const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');

    const stream = await downloadContentFromMessage(downloadable, baileyType);

    // Setear headers
    const mimeType = media.mimetype || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    if (media.fileName) {
      res.setHeader('Content-Disposition', `inline; filename="${media.fileName}"`);
    }
    if (media.fileLength) {
      res.setHeader('Content-Length', media.fileLength);
    }

    // Pipe el stream al response
    for await (const chunk of stream) {
      res.write(chunk);
    }
    res.end();
  } catch(e) {
    console.error('[media download]', e.message);
    res.status(500).json({ error: 'Error descargando media: ' + e.message });
  }
});

// ─── Quick Replies ────────────────────────────────────────────────────────────

router.get('/quick-replies', requireAuth, async (req, res) => res.json(await query('SELECT * FROM quick_replies ORDER BY category, name')));

router.post('/quick-replies', requireAuth, async (req, res) => {
  const rows = await query('INSERT INTO quick_replies (name, trigger_text, content, category) VALUES (?, ?, ?, ?)',
    [req.body.name, req.body.trigger_text || '', req.body.content, req.body.category || 'general']);
  res.json({ id: rows[0]?.lastInsertRowid, ok: true });
});

router.put('/quick-replies/:id', requireAuth, async (req, res) => {
  await query('UPDATE quick_replies SET name = ?, trigger_text = ?, content = ?, category = ? WHERE id = ?',
    [req.body.name, req.body.trigger_text, req.body.content, req.body.category, req.params.id]);
  res.json({ ok: true });
});

router.delete('/quick-replies/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM quick_replies WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Auto Reply Config ────────────────────────────────────────────────────────

router.get('/auto-reply', requireAuth, async (req, res) => {
  res.json(await queryOne('SELECT * FROM auto_reply_config LIMIT 1') || {});
});

router.put('/auto-reply', requireAuth, async (req, res) => {
  const { is_active, schedule_start, schedule_end, working_days, greeting_message, collect_fields, timezone } = req.body;
  const existing = await queryOne('SELECT id FROM auto_reply_config LIMIT 1');
  const fields = JSON.stringify(Array.isArray(collect_fields) ? collect_fields : [collect_fields].filter(Boolean));
  if (existing) {
    await query(
      'UPDATE auto_reply_config SET is_active=?, schedule_start=?, schedule_end=?, working_days=?, greeting_message=?, collect_fields=?, timezone=COALESCE(?,timezone), updated_at=NOW() WHERE id=1',
      [is_active ? 1 : 0, schedule_start, schedule_end, working_days || '1,2,3,4,5', greeting_message, fields, timezone || null]
    );
  } else {
    await query(
      'INSERT INTO auto_reply_config (is_active, schedule_start, schedule_end, working_days, greeting_message, collect_fields, timezone) VALUES (?,?,?,?,?,?,?)',
      [is_active ? 1 : 0, schedule_start, schedule_end, working_days || '1,2,3,4,5', greeting_message, fields, timezone || 'Europe/Madrid']
    );
  }
  res.json({ ok: true });
});

// ─── Activity Log ─────────────────────────────────────────────────────────────

router.get('/activity', requireAuth, requireAdmin, async (req, res) => {
  res.json(await query(`
    SELECT al.*, u.display_name, u.color FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id ORDER BY al.created_at DESC LIMIT 100`));
});

// ─── AI Webhook ───────────────────────────────────────────────────────────────

router.post('/ai/respond', async (req, res) => {
  const { jid, response: text } = req.body;
  if (!jid || !text) return res.status(400).json({ error: 'jid y response requeridos' });
  try {
    const phone = normalizePhone(jid.split('@')[0]);
    await sendMessage(phone, text, null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── File Library ─────────────────────────────────────────────────────────────

router.get('/files', requireAuth, async (req, res) => {
  const files = await query(`
    SELECT f.*, u.display_name as uploaded_by_name
    FROM file_library f LEFT JOIN users u ON f.uploaded_by = u.id
    ORDER BY f.category, f.name`);
  res.json(files);
});

router.post('/files', requireAuth, fileUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
  const { name, description, category } = req.body;
  const rows = await query(
    'INSERT INTO file_library (name, description, filename, original_name, mime_type, size, category, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [name || req.file.originalname, description || '', req.file.filename, req.file.originalname,
     req.file.mimetype, req.file.size, category || 'general', req.session.user.id]
  );
  res.json({ id: rows[0]?.lastInsertRowid, ok: true });
});

router.put('/files/:id', requireAuth, async (req, res) => {
  const { name, description, category } = req.body;
  await query('UPDATE file_library SET name = ?, description = ?, category = ? WHERE id = ?',
    [name, description, category, req.params.id]);
  res.json({ ok: true });
});

router.delete('/files/:id', requireAuth, async (req, res) => {
  const file = await queryOne('SELECT * FROM file_library WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });
  const filePath = path.join(FILES_DIR, file.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await query('DELETE FROM file_library WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Preview/descarga de archivo de biblioteca
router.get('/files/:id/download', requireAuth, async (req, res) => {
  const file = await queryOne('SELECT * FROM file_library WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });
  const filePath = path.join(FILES_DIR, file.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${file.original_name}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ─── AI Config ────────────────────────────────────────────────────────────────

router.get('/ai-config', requireAuth, requireAdmin, async (req, res) => {
  const cfg = await queryOne('SELECT * FROM ai_config LIMIT 1') || {};
  // No devolver la API key completa — solo indicar si está cargada
  if (cfg.api_key) cfg.api_key_set = true;
  delete cfg.api_key;
  res.json(cfg);
});

// Test directo del agente IA v2
router.post('/ai/test', requireAuth, requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Falta el mensaje de prueba' });

  const { buildSystemPrompt } = require('../ai-agent');
  const config = await queryOne('SELECT * FROM ai_config LIMIT 1');
  if (!config?.is_active) return res.status(400).json({ error: 'El agente IA no está activo' });
  if (!config?.api_key)   return res.status(400).json({ error: 'No hay API key configurada' });

  try {
    const systemPrompt = await buildSystemPrompt(config, true); // forceRefresh
    const history      = [{ role: 'user', content: message }];
    const t0           = Date.now();

    // Reutilizar el mismo callProvider del agente v2
    let response = null, tokensUsed = 0;

    if (config.provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model || 'gemini-1.5-flash'}:generateContent?key=${config.api_key}`;
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: message }] }],
          generationConfig: { maxOutputTokens: config.max_tokens || 300, temperature: config.temperature ?? 0.7 },
        }),
      });
      if (!r.ok) return res.status(400).json({ error: `Gemini ${r.status}: ${(await r.text()).substring(0,300)}` });
      const d = await r.json();
      response   = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
      tokensUsed = d.usageMetadata?.totalTokenCount || 0;
    } else if (config.provider === 'groq') {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
        body: JSON.stringify({ model: config.model || 'llama-3.1-8b-instant', messages: [{ role: 'system', content: systemPrompt }, ...history], max_tokens: config.max_tokens || 300 }),
      });
      if (!r.ok) return res.status(400).json({ error: `Groq ${r.status}: ${(await r.text()).substring(0,300)}` });
      const d = await r.json();
      response   = d.choices?.[0]?.message?.content?.trim() || null;
      tokensUsed = d.usage?.total_tokens || 0;
    } else if (config.provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
        body: JSON.stringify({ model: config.model || 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, ...history], max_tokens: config.max_tokens || 300 }),
      });
      if (!r.ok) return res.status(400).json({ error: `OpenAI ${r.status}: ${(await r.text()).substring(0,300)}` });
      const d = await r.json();
      response   = d.choices?.[0]?.message?.content?.trim() || null;
      tokensUsed = d.usage?.total_tokens || 0;
    } else if (config.provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': config.api_key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: config.model || 'claude-haiku-4-5', system: systemPrompt, messages: history, max_tokens: config.max_tokens || 300 }),
      });
      if (!r.ok) return res.status(400).json({ error: `Anthropic ${r.status}: ${(await r.text()).substring(0,300)}` });
      const d = await r.json();
      response   = d.content?.[0]?.text?.trim() || null;
      tokensUsed = (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0);
    } else {
      return res.status(400).json({ error: `Proveedor ${config.provider} no soportado` });
    }

    const elapsed = Date.now() - t0;
    res.json({ ok: true, response, provider: config.provider, model: config.model, elapsed_ms: elapsed, tokens_used: tokensUsed, prompt_tokens_est: Math.ceil(systemPrompt.length / 4) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Métricas del agente IA v2
router.get('/ai/metrics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getMetrics } = require('../ai-agent');
    res.json({ ok: true, metrics: getMetrics() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Invalidar cache del system prompt (útil después de actualizar config/documentos)
router.post('/ai/invalidate-cache', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { invalidatePromptCache } = require('../ai-agent');
    invalidatePromptCache();
    res.json({ ok: true, message: 'Cache del system prompt invalidado' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/ai-config', requireAuth, requireAdmin, async (req, res) => {
  const {
    is_active, provider, api_key, model, system_prompt,
    company_name, company_context, response_delay_min, response_delay_max,
    max_tokens, temperature, only_outside_hours,
    working_hours_start, working_hours_end, working_days,
  } = req.body;

  const existing = await queryOne('SELECT id FROM ai_config LIMIT 1');
  if (existing) {
    // Solo actualizar api_key si se envió una nueva (no vacía)
    const keyClause = api_key ? ', api_key = ?' : '';
    const keyParam  = api_key ? [api_key] : [];
    await query(
      `UPDATE ai_config SET
        is_active=?, provider=?, model=?, system_prompt=?, company_name=?,
        company_context=?, response_delay_min=?, response_delay_max=?,
        max_tokens=?, temperature=?, only_outside_hours=?,
        working_hours_start=?, working_hours_end=?, working_days=?,
        updated_at=datetime('now') ${keyClause}
       WHERE id=1`,
      [is_active?1:0, provider, model, system_prompt, company_name,
       company_context, response_delay_min||3, response_delay_max||8,
       max_tokens||300, temperature||0.7, only_outside_hours?1:0,
       working_hours_start, working_hours_end, working_days||'1,2,3,4,5',
       ...keyParam]
    );
  } else {
    await query(
      `INSERT INTO ai_config
        (is_active, provider, api_key, model, system_prompt, company_name,
         company_context, response_delay_min, response_delay_max, max_tokens,
         temperature, only_outside_hours, working_hours_start, working_hours_end, working_days)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [is_active?1:0, provider, api_key||'', model, system_prompt||'', company_name||'',
       company_context||'', response_delay_min||3, response_delay_max||8,
       max_tokens||300, temperature||0.7, only_outside_hours?1:0,
       working_hours_start||'09:00', working_hours_end||'18:00', working_days||'1,2,3,4,5']
    );
  }
  res.json({ ok: true });
});

// ─── AI Documents ─────────────────────────────────────────────────────────────

router.get('/ai-documents', requireAuth, requireAdmin, async (req, res) => {
  const docs = await query('SELECT id, name, file_type, size, is_active, created_at FROM ai_documents ORDER BY created_at DESC');
  res.json(docs);
});

router.post('/ai-documents', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!req.file && !req.body.text_content) return res.status(400).json({ error: 'Falta archivo o texto' });

    let content = '';
    let fileType = 'text';
    let size = 0;

    if (req.file) {
      fileType = req.file.mimetype.includes('pdf') ? 'pdf' : 'text';
      size = req.file.size;

      if (fileType === 'pdf') {
        try {
          const pdfParse = require('pdf-parse');
          const data = await pdfParse(req.file.buffer);
          content = data.text.replace(/\s+/g, ' ').trim();
        } catch(e) {
          return res.status(400).json({ error: 'No se pudo leer el PDF: ' + e.message });
        }
      } else {
        content = req.file.buffer.toString('utf-8');
      }
    } else {
      content = req.body.text_content;
      size = content.length;
    }

    // Truncar a 50.000 caracteres para no explotar el contexto
    if (content.length > 50000) content = content.substring(0, 50000) + '\n[... documento truncado ...]';

    await query(
      `INSERT INTO ai_documents (name, content, file_type, size) VALUES (?, ?, ?, ?)`,
      [name || req.file?.originalname || 'Documento', content, fileType, size]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('Error subiendo documento IA:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/ai-documents/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  const doc = await queryOne('SELECT is_active FROM ai_documents WHERE id = ?', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'No encontrado' });
  await query('UPDATE ai_documents SET is_active = ? WHERE id = ?', [doc.is_active ? 0 : 1, req.params.id]);
  res.json({ ok: true });
});

router.delete('/ai-documents/:id', requireAuth, requireAdmin, async (req, res) => {
  await query('DELETE FROM ai_documents WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Sistema / Administración ─────────────────────────────────────────────────

// Estadísticas del sistema (para el panel admin)
router.get('/system/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [convs, msgs, contacts, users] = await Promise.all([
      queryOne('SELECT COUNT(*) as n FROM conversations'),
      queryOne('SELECT COUNT(*) as n FROM messages'),
      queryOne('SELECT COUNT(*) as n FROM contacts'),
      queryOne('SELECT COUNT(*) as n FROM users WHERE is_active = 1'),
    ]);
    const oldestMsg = await queryOne('SELECT MIN(timestamp) as t FROM messages');
    const newestMsg = await queryOne('SELECT MAX(timestamp) as t FROM messages');
    res.json({
      conversations: convs?.n || 0,
      messages: msgs?.n || 0,
      contacts: contacts?.n || 0,
      active_users: users?.n || 0,
      oldest_message: oldestMsg?.t,
      newest_message: newestMsg?.t,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset/limpieza del sistema — requiere contraseña de confirmación
router.post('/system/reset', requireAuth, requireAdmin, async (req, res) => {
  const { password, scope } = req.body;

  // Verificar contraseña del admin actual
  const adminUser = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
  if (!adminUser) return res.status(403).json({ error: 'Sin autorización' });
  const valid = await bcrypt.compare(password, adminUser.password_hash);
  if (!valid) return res.status(403).json({ error: 'Contraseña incorrecta' });

  const deleted = {};
  try {
    if (scope === 'messages' || scope === 'all') {
      const r = await query('DELETE FROM messages');
      deleted.messages = r.rowCount || 0;
    }
    if (scope === 'conversations' || scope === 'all') {
      const r = await query('DELETE FROM conversations');
      deleted.conversations = r.rowCount || 0;
    }
    if (scope === 'contacts' || scope === 'all') {
      const r = await query('DELETE FROM contacts');
      deleted.contacts = r.rowCount || 0;
    }
    if (scope === 'activity' || scope === 'all') {
      const r = await query('DELETE FROM activity_log');
      deleted.activity = r.rowCount || 0;
    }
    // Nunca borra usuarios, config, ni credenciales WA
    console.log(`[SYSTEM RESET] scope=${scope} by user ${req.session.user.id}:`, deleted);
    res.json({ ok: true, deleted });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Reparar DB: corregir índice unique en messages si falta, sincronizar migraciones
router.post('/system/repair-db', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  const adminUser = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
  const valid = adminUser && await bcrypt.compare(password, adminUser.password_hash);
  if (!valid) return res.status(403).json({ error: 'Contraseña incorrecta' });

  const results = [];
  const ops = [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id)`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS wa_push_name TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_disabled INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active INTEGER DEFAULT 1`,
    // CRÍTICO: timestamp INTEGER (32-bit) no puede guardar ms. Necesita BIGINT.
    `ALTER TABLE messages ALTER COLUMN timestamp TYPE BIGINT`,
    `CREATE TABLE IF NOT EXISTS ai_documents (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
      file_type TEXT DEFAULT 'text', size INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Forzar is_active = 1 donde está NULL
    `UPDATE users SET is_active = 1 WHERE is_active IS NULL`,
    // Asegurar que conversations tiene columnas de timestamps
    `UPDATE conversations SET last_message_at = NOW() WHERE last_message_at IS NULL AND last_message IS NOT NULL`,
    // Limpiar nombres de contactos que son iguales al teléfono (fallback anterior incorrecto)
    // Los setea a NULL para que la UI muestre el push_name de WA
    `UPDATE contacts SET name = NULL WHERE name = phone AND phone IS NOT NULL`,
    // Poblar wa_push_name en conversaciones desde contactos que sí tenían push_name
    `UPDATE conversations SET wa_push_name = (
      SELECT c.name FROM contacts c WHERE c.id = conversations.contact_id AND c.name IS NOT NULL
    ) WHERE wa_push_name IS NULL AND contact_id IS NOT NULL`,
    // Eliminar conversaciones "fantasma" creadas por JIDs raros de onWhatsApp()
    `DELETE FROM conversations WHERE
      id NOT IN (SELECT DISTINCT conversation_id FROM conversation_labels WHERE conversation_id IS NOT NULL)
      AND last_message IS NULL
      AND unread_count = 0
      AND contact_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.jid = conversations.jid)`,
    // Nuevas columnas — grupos y sender
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_group INTEGER DEFAULT 0`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS group_name TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_summary TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_summary_at TIMESTAMPTZ`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_jid TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_data TEXT`,
    `ALTER TABLE auto_reply_config ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Europe/Madrid'`,
    // Limpiar contactos creados con @lid como teléfono (números raros como 258978055516407)
    // Son contactos cuyo phone no empieza con código de país válido (< 7 dígitos o > 15 dígitos)
    // y cuya conversación asociada usa @lid — se elimina el contacto ficticio, no la conversación
    `UPDATE conversations SET contact_id = NULL
     WHERE contact_id IN (
       SELECT id FROM contacts
       WHERE length(phone) > 13 AND phone NOT SIMILAR TO '54[0-9]+|34[0-9]+|39[0-9]+|55[0-9]+|1[0-9]+'
     )`,
    `DELETE FROM contacts
     WHERE length(phone) > 13
       AND phone NOT SIMILAR TO '54[0-9]+|34[0-9]+|39[0-9]+|55[0-9]+|1[0-9]+'
       AND id NOT IN (SELECT DISTINCT contact_id FROM conversations WHERE contact_id IS NOT NULL)`,
  ];

  for (const sql of ops) {
    try {
      await query(sql);
      results.push({ sql: sql.substring(0, 60) + '…', ok: true });
    } catch(e) {
      results.push({ sql: sql.substring(0, 60) + '…', ok: false, err: e.message.substring(0, 80) });
    }
  }
  console.log('[SYSTEM REPAIR-DB]', results);
  res.json({ ok: true, results });
});

// Merge conversaciones duplicadas del mismo número (ej: con/sin 9 en Argentina)
router.post('/system/merge-duplicates', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  const adminUser = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
  const valid = adminUser && await bcrypt.compare(password, adminUser.password_hash);
  if (!valid) return res.status(403).json({ error: 'Contraseña incorrecta' });

  try {
    // Obtener todas las conversaciones
    const convs = await query(`SELECT jid, last_message, last_message_at FROM conversations ORDER BY last_message_at DESC`);

    // Agrupar por número normalizado
    const { default: normalizePhone } = { default: (p) => {
      p = String(p).replace(/\D/g,'').split('@')[0];
      if (p.startsWith('54') && p.length >= 10) {
        const s = p.slice(2);
        if (!s.startsWith('9')) p = '549' + s;
      }
      return p;
    }};

    const groups = {};
    for (const c of convs) {
      const raw = c.jid.split('@')[0];
      let norm = raw.replace(/\D/g,'');
      if (norm.startsWith('54') && !norm.startsWith('549') && norm.length >= 12) {
        norm = '549' + norm.slice(2);
      }
      const canonical = norm + '@s.whatsapp.net';
      if (!groups[canonical]) groups[canonical] = [];
      groups[canonical].push(c.jid);
    }

    let merged = 0;
    for (const [canonical, jids] of Object.entries(groups)) {
      if (jids.length <= 1) continue;
      // El canónico es el que tiene 9 (o el primero)
      const keep = jids.includes(canonical) ? canonical : jids[0];
      const dupes = jids.filter(j => j !== keep);

      for (const dupe of dupes) {
        // Reasignar mensajes del duplicado al canónico
        await query(`UPDATE messages SET jid = ? WHERE jid = ?`, [keep, dupe]).catch(()=>{});
        // Eliminar la conversación duplicada
        await query(`DELETE FROM conversations WHERE jid = ?`, [dupe]).catch(()=>{});
        merged++;
        console.log(`[MERGE] ${dupe} → ${keep}`);
      }
    }

    res.json({ ok: true, merged, message: `${merged} conversaciones duplicadas fusionadas` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Seed: poblar messages desde last_message de conversations (fallback cuando historial no llegó)
router.post('/system/seed-messages', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  const adminUser = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
  const valid = adminUser && await bcrypt.compare(password, adminUser.password_hash);
  if (!valid) return res.status(403).json({ error: 'Contraseña incorrecta' });

  try {
    // Primero: limpiar seeds anteriores con timestamps incorrectos (message_id empieza con seed_)
    await query(`DELETE FROM messages WHERE message_id LIKE 'seed_%'`);

    // Asegurar que el campo es BIGINT antes de insertar
    try { await query(`ALTER TABLE messages ALTER COLUMN timestamp TYPE BIGINT`); } catch(e) {}

    const convs = await query(
      `SELECT jid, last_message, last_message_at
       FROM conversations
       WHERE last_message IS NOT NULL AND last_message != ''
         AND last_message NOT LIKE '[%]'
       ORDER BY last_message_at DESC`
    );

    let inserted = 0, errors = 0;
    for (const c of convs) {
      // Calcular timestamp en milisegundos correctamente
      let ts;
      if (c.last_message_at) {
        const parsed = new Date(c.last_message_at).getTime();
        ts = isNaN(parsed) ? Date.now() : parsed;
      } else {
        ts = Date.now();
      }

      const syntheticId = `seed_${c.jid}_${ts}`;
      try {
        await query(
          `INSERT INTO messages (message_id, jid, direction, type, content, timestamp, is_auto_reply, sent_by)
           VALUES ($1, $2, 'in', 'text', $3, $4::bigint, 0, NULL)
           ON CONFLICT (message_id) DO NOTHING`,
          [syntheticId, c.jid, c.last_message, ts]
        );
        inserted++;
      } catch(e) {
        errors++;
        console.error('[seed] error:', e.message, '| ts:', ts, '| jid:', c.jid);
      }
    }

    const after = await queryOne('SELECT COUNT(*) as n FROM messages');
    res.json({ ok: true, inserted, errors, total: Number(after?.n || 0) });
  } catch(e) {
    console.error('[seed-messages] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Forzar re-sincronización del historial de WhatsApp
router.post('/system/resync-history', requireAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  const adminUser = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
  const valid = adminUser && await bcrypt.compare(password, adminUser.password_hash);
  if (!valid) return res.status(403).json({ error: 'Contraseña incorrecta' });

  try {
    const { requestHistoryResync } = require('../baileys');
    await requestHistoryResync();
    res.json({ ok: true, message: 'Re-sincronización solicitada. Los mensajes aparecerán en los próximos minutos.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;