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

const { query, queryOne } = require('../db');
const { sendMessage, sendFile, getStatus, logout, normalizePhone } = require('../baileys');
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
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
  }
  await query('UPDATE users SET display_name = ?, role = ?, color = ?, is_active = ? WHERE id = ?',
    [display_name, role, color, is_active, req.params.id]);
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
  await query('UPDATE contacts SET name = ?, company = ?, extra = ?, notes = ?, updated_at = datetime(\'now\') WHERE id = ?',
    [name, company, extra, notes, req.params.id]);
  res.json({ ok: true });
});

// Guardar contacto desde conversación (upsert por JID/phone)
router.post('/contacts/from-conversation', requireAuth, async (req, res) => {
  const { jid, name, company, extra, notes } = req.body;
  if (!jid) return res.status(400).json({ error: 'jid requerido' });
  const phone = normalizePhone(jid.split('@')[0]);
  await query(
    'INSERT OR IGNORE INTO contacts (phone, name, company, extra, notes) VALUES (?, ?, ?, ?, ?)',
    [phone, name || phone, company || '', extra || '', notes || '']
  );
  await query(
    'UPDATE contacts SET name = ?, company = ?, extra = ?, notes = ?, updated_at = datetime(\'now\') WHERE phone = ?',
    [name || phone, company || '', extra || '', notes || '', phone]
  );
  const c = await queryOne('SELECT * FROM contacts WHERE phone = ?', [phone]);
  // Vincular con la conversación
  if (c) {
    await query('UPDATE conversations SET contact_id = ? WHERE jid = ?', [c.id, jid]);
  }
  res.json(c);
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
  let sql = `
    SELECT cv.*, c.name as contact_name, c.phone as contact_phone, c.company,
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
    sql += ' AND (c.name LIKE ? OR c.phone LIKE ? OR cv.last_message LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY cv.last_message_at DESC LIMIT 200';

  const rows = await query(sql, params);
  const result = await Promise.all(rows.map(async (row) => {
    const labels = await query(`
      SELECT l.id, l.name, l.color FROM conversation_labels cvl
      JOIN labels l ON cvl.label_id = l.id WHERE cvl.conversation_id = ?`, [row.id]);
    return { ...row, labels };
  }));
  res.json(result);
});

router.get('/conversations/:jid/messages', requireAuth, async (req, res) => {
  const msgs = await query(`
    SELECT m.*, u.display_name as sent_by_name, u.color as sent_by_color
    FROM messages m LEFT JOIN users u ON m.sent_by = u.id
    WHERE m.jid = ? ORDER BY m.timestamp ASC LIMIT 150
  `, [decodeURIComponent(req.params.jid)]);
  res.json(msgs);
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
  const target = phone || (jid ? jid.split('@')[0] : null);
  if (!target || !message) return res.status(400).json({ error: 'phone/jid y message requeridos' });
  try {
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
    'INSERT INTO campaigns (name, type, template, delay_min, delay_max, scheduled_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [name, type || 'general', template, delay_min || 8, delay_max || 25, scheduled_at || null, req.session.user.id]
  );
  const campaignId = rows[0]?.lastInsertRowid;

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
  await query("UPDATE campaigns SET status = 'draft', sent = 0, failed = 0 WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
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
  const { is_active, schedule_start, schedule_end, working_days, greeting_message, collect_fields } = req.body;
  const existing = await queryOne('SELECT id FROM auto_reply_config LIMIT 1');
  if (existing) {
    await query(
      'UPDATE auto_reply_config SET is_active=?, schedule_start=?, schedule_end=?, working_days=?, greeting_message=?, collect_fields=?, updated_at=datetime(\'now\') WHERE id=1',
      [is_active ? 1 : 0, schedule_start, schedule_end, working_days || '1,2,3,4,5', greeting_message, JSON.stringify(collect_fields)]
    );
  } else {
    await query(
      'INSERT INTO auto_reply_config (is_active, schedule_start, schedule_end, working_days, greeting_message, collect_fields) VALUES (?,?,?,?,?,?)',
      [is_active ? 1 : 0, schedule_start, schedule_end, working_days || '1,2,3,4,5', greeting_message, JSON.stringify(collect_fields)]
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

module.exports = router;