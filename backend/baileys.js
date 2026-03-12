/**
 * baileys.js — Conexion WhatsApp con Baileys
 * Usa dynamic import() para compatibilidad con Node 18/20/22 (ESM)
 */
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { query, queryOne } = require('./db');
const { runAIAgent } = require('./ai-agent');

// Baileys se importa dinámicamente en connect() por ser ESM puro
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, getContentType;

const AUTH_PATH = process.env.WA_AUTH_PATH
  ? path.resolve(process.env.WA_AUTH_PATH)
  : path.join(__dirname, '../auth');

if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });

let sock = null;
let io = null;
let qrData = null;
let connectionStatus = 'disconnected';
let reconnectTimer = null;

function setIO(socketIO) { io = socketIO; }
function getStatus() { return { status: connectionStatus, qr: qrData }; }
function getSock() { return sock; }

// ─── Normalización de números ─────────────────────────────────────────────────
// WhatsApp Argentina: algunos números llegan con 549... otros con 54...
// Normalizamos siempre a 549XXXXXXXXXX para celulares argentinos

function normalizePhone(raw) {
  let p = String(raw).replace(/\D/g, '');

  // Quitar prefijo de JID si viene con @
  p = p.split('@')[0];

  // Argentina: si empieza con 54 y el siguiente dígito NO es 9, insertar 9
  // Ej: 5411XXXXXXXX -> 54911XXXXXXXX
  // Ej: 5491XXXXXXXX -> 5491XXXXXXXX (ya correcto)
  if (p.startsWith('54') && p.length >= 10) {
    const sinPrefijo = p.slice(2);
    if (!sinPrefijo.startsWith('9')) {
      p = '549' + sinPrefijo;
    }
  }

  return p;
}

function normalizeJid(phone) {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}

function extractPhone(jid) {
  return jid.split('@')[0];
}

// Busca contacto por número, tolerando variantes con/sin 9
async function findContactByPhone(phone) {
  const clean = normalizePhone(phone);
  let c = await queryOne('SELECT * FROM contacts WHERE phone = ?', [clean]);
  if (c) return c;

  // Intentar variante: si tiene 549 buscar sin 9, y viceversa
  let alt = clean;
  if (clean.startsWith('549')) {
    alt = '54' + clean.slice(3); // quitar el 9
  } else if (clean.startsWith('54') && !clean.startsWith('549')) {
    alt = '549' + clean.slice(2); // agregar el 9
  }

  return await queryOne('SELECT * FROM contacts WHERE phone = ?', [alt]);
}

function getMessageText(msg) {
  if (!msg.message) return { type: 'unknown', text: '' };
  const type = getContentType(msg.message);
  const m = msg.message;
  let text = '';
  switch (type) {
    case 'conversation': text = m.conversation; break;
    case 'extendedTextMessage': text = m.extendedTextMessage?.text || ''; break;
    case 'imageMessage': text = m.imageMessage?.caption || '[Imagen]'; break;
    case 'videoMessage': text = m.videoMessage?.caption || '[Video]'; break;
    case 'audioMessage': text = '[Audio]'; break;
    case 'documentMessage': text = `[Archivo: ${m.documentMessage?.fileName || ''}]`; break;
    case 'stickerMessage': text = '[Sticker]'; break;
    case 'locationMessage': text = '[Ubicacion]'; break;
    default: text = `[${type || 'mensaje'}]`;
  }
  return { type: type || 'text', text };
}

// ─── Auto-reply bot ───────────────────────────────────────────────────────────

function isBusinessHours(config) {
  if (!config?.is_active) return true;
  const now = new Date();
  const day = now.getDay();
  const workDays = (config.working_days || '1,2,3,4,5').split(',').map(Number);
  if (!workDays.includes(day)) return false;
  const [sh, sm] = config.schedule_start.split(':').map(Number);
  const [eh, em] = config.schedule_end.split(':').map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= sh * 60 + sm && nowMin <= eh * 60 + em;
}

const fieldPrompts = {
  name: '¿Cuál es tu nombre?',
  email: '¿Cuál es tu email?',
  phone: '¿En qué número podemos llamarte?',
  reason: '¿Cuál es el motivo de tu consulta?',
};

async function runAutoReplyBot(jid, incomingText, conv) {
  const config = await queryOne('SELECT * FROM auto_reply_config LIMIT 1');
  if (!config || !config.is_active) return false;
  if (isBusinessHours(config)) return false;

  const botState = conv?.bot_state || 'idle';
  const collected = JSON.parse(conv?.bot_collected || '{}');
  const fields = JSON.parse(config.collect_fields || '["name","email","phone","reason"]');

  let responseText = '';
  let newState = botState;
  let newCollected = { ...collected };

  if (botState === 'idle') {
    responseText = config.greeting_message || 'Hola! Estamos fuera de horario.';
    if (fields.length > 0) {
      responseText += `\n\n${fieldPrompts[fields[0]] || fields[0]}`;
      newState = `collecting_${fields[0]}`;
    } else {
      newState = 'done';
    }
  } else if (botState.startsWith('collecting_')) {
    const currentField = botState.replace('collecting_', '');
    newCollected[currentField] = incomingText.trim();
    const idx = fields.indexOf(currentField);
    const next = fields[idx + 1];
    if (next) {
      responseText = fieldPrompts[next] || `Y tu ${next}?`;
      newState = `collecting_${next}`;
    } else {
      const summary = Object.entries(newCollected)
        .map(([k, v]) => `- ${k}: ${v}`).join('\n');
      responseText = `Gracias! Tomamos nota:\n\n${summary}\n\nTe respondemos en el proximo horario de atencion.`;
      newState = 'done';
      if (io) io.emit('bot:lead_collected', { jid, phone: extractPhone(jid), data: newCollected, time: new Date().toISOString() });
      await query('INSERT INTO activity_log (action, target_jid, detail) VALUES (?, ?, ?)',
        ['bot_collected', jid, JSON.stringify(newCollected)]);
    }
  } else if (botState === 'done') {
    responseText = `Hola de nuevo! Ya recibimos tu consulta. Te respondemos en horario de atencion (${config.schedule_start} - ${config.schedule_end}).`;
  }

  if (responseText && sock) {
    await sock.sendMessage(jid, { text: responseText });
    await saveMessage({
      message_id: `bot_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      jid, direction: 'out', type: 'text',
      content: responseText, timestamp: Date.now(),
      is_auto_reply: 1, sent_by: null,
    });
    await query(
      'UPDATE conversations SET bot_state = ?, bot_collected = ?, updated_at = datetime(\'now\') WHERE jid = ?',
      [newState, JSON.stringify(newCollected), jid]
    );
  }
  return true;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function saveMessage({ message_id, jid, direction, type, content, timestamp, is_auto_reply, sent_by }) {
  try {
    await query(
      `INSERT INTO messages (message_id, jid, direction, type, content, timestamp, is_auto_reply, sent_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO NOTHING`,
      [message_id, jid, direction, type, content || '', timestamp, is_auto_reply ? 1 : 0, sent_by || null]
    );
  } catch(e) {
    console.error('[saveMessage] Error:', e.message, '| jid:', jid, '| msg_id:', message_id);
  }
}

async function upsertConversationHistory(jid, contactId, lastMessage, lastMessageAt, direction) {
  const existing = await queryOne('SELECT id, last_message_at FROM conversations WHERE jid = ?', [jid]);
  if (existing) {
    // Solo actualizar last_message si este mensaje es más reciente
    await query(
      `UPDATE conversations SET
        contact_id = COALESCE(contact_id, ?),
        last_message = CASE WHEN last_message_at < ? THEN ? ELSE last_message END,
        last_message_at = CASE WHEN last_message_at < ? THEN ? ELSE last_message_at END
       WHERE jid = ?`,
      [contactId || null, lastMessageAt, lastMessage, lastMessageAt, lastMessageAt, jid]
    );
  } else {
    await query(
      `INSERT INTO conversations (jid, contact_id, last_message, last_message_at, unread_count) VALUES (?, ?, ?, ?, 0)`,
      [jid, contactId || null, lastMessage, lastMessageAt]
    );
  }
}

async function upsertConversation(jid, contactId, lastMessage, lastMessageAt, pushName = null) {
  const existing = await queryOne('SELECT id, unread_count FROM conversations WHERE jid = ?', [jid]);
  if (existing) {
    await query(
      `UPDATE conversations SET
        contact_id = COALESCE(?, contact_id),
        wa_push_name = COALESCE(wa_push_name, ?),
        last_message = ?,
        last_message_at = ?,
        unread_count = unread_count + 1,
        updated_at = datetime('now')
       WHERE jid = ?`,
      [contactId || null, pushName, lastMessage, lastMessageAt, jid]
    );
  } else {
    await query(
      `INSERT INTO conversations (jid, contact_id, wa_push_name, last_message, last_message_at, unread_count)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [jid, contactId || null, pushName, lastMessage, lastMessageAt]
    );
  }
}

// ─── Process incoming message ─────────────────────────────────────────────────

async function processMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;

  const rawJid = msg.key.remoteJid;
  if (!rawJid || rawJid.includes('broadcast') || rawJid.endsWith('@g.us')) return;

  const rawPhone = extractPhone(rawJid);
  const phone = normalizePhone(rawPhone);

  // Normalizar el JID: usar siempre el número normalizado (con 9 para Argentina)
  // Esto evita que 543412824082 y 5493412824082 generen dos conversaciones distintas
  const suffix = rawJid.includes('@lid') ? '@lid' : '@s.whatsapp.net';
  const jid = rawJid.includes('@lid') ? rawJid : `${phone}${suffix}`;

  const { type, text } = getMessageText(msg);
  const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;

  // Buscar contacto existente (tolerando variantes con/sin 9)
  let contact = await findContactByPhone(phone);

  if (!contact) {
    // Crear contacto nuevo — usar RETURNING para PostgreSQL
    try {
      const rows = await query(
        'INSERT INTO contacts (phone, name) VALUES (?, ?) ON CONFLICT (phone) DO UPDATE SET name = COALESCE(contacts.name, EXCLUDED.name) RETURNING id, name, phone',
        [phone, msg.pushName || phone]
      );
      contact = rows[0] || await queryOne('SELECT id, name FROM contacts WHERE phone = ?', [phone]);
    } catch (e) {
      // Fallback SQLite
      await query('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)', [phone, msg.pushName || phone]);
      contact = await queryOne('SELECT id, name FROM contacts WHERE phone = ?', [phone]);
    }
  } else if (!contact.name && msg.pushName) {
    await query('UPDATE contacts SET name = ? WHERE id = ?', [msg.pushName, contact.id]);
    contact.name = msg.pushName;
  }

  // Actualizar contact_id en conversación si faltaba
  if (contact?.id) {
    await query(
      'UPDATE conversations SET contact_id = ? WHERE jid = ? AND contact_id IS NULL',
      [contact.id, jid]
    ).catch(() => {});
  }

  // Guardar mensaje usando JID original de WhatsApp
  await saveMessage({
    message_id: msg.key.id,
    jid, direction: 'in', type, content: text,
    timestamp, is_auto_reply: 0, sent_by: null,
  });

  // Upsert conversación
  await upsertConversation(jid, contact?.id, text, new Date(timestamp).toISOString(), msg.pushName || null);

  const conv = await queryOne('SELECT * FROM conversations WHERE jid = ?', [jid]);

  const autoHandled = await runAutoReplyBot(jid, text, conv).catch(e => {
    console.error('Error en auto-reply:', e.message);
    return false;
  });

  // Si el auto-reply no manejó el mensaje, intentar con el agente IA
  if (!autoHandled) {
    runAIAgent(jid, text, sendMessage).catch(e => {
      console.error('Error en agente IA:', e.message);
    });
  }

  if (io) {
    const convFull = await queryOne(`
      SELECT cv.*, c.name as contact_name, c.phone as contact_phone
      FROM conversations cv LEFT JOIN contacts c ON cv.contact_id = c.id
      WHERE cv.jid = ?`, [jid]);
    io.emit('message:new', {
      jid, phone,
      contact_name: contact?.name || msg.pushName || phone,
      content: text, type, timestamp,
      is_auto_reply: autoHandled,
      message_id: msg.key.id,
      conversation: convFull,
    });
  }
}

// ─── Connect ──────────────────────────────────────────────────────────────────

async function connect() {
  // Importar Baileys dinámicamente (es un módulo ESM)
  if (!makeWASocket) {
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket = baileys.default;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    getContentType = baileys.getContentType;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['WhatsApp CRM', 'Chrome', '121.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: true,   // solicitar historial al móvil
    markOnlineOnConnect: false,
  });

  connectionStatus = 'connecting';
  if (io) io.emit('wa:status', { status: 'connecting' });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrData = await qrcode.toDataURL(qr);
      connectionStatus = 'qr';
      if (io) io.emit('wa:qr', { qr: qrData });
      console.log('QR listo para escanear');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      qrData = null;
      if (io) io.emit('wa:status', { status: 'disconnected' });
      if (!loggedOut) {
        const delay = code === 408 ? 2000 : 5000;
        reconnectTimer = setTimeout(connect, delay);
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrData = null;
      const phone = sock.user?.id?.split(':')[0] || '';
      console.log(`WhatsApp conectado: ${phone}`);
      if (io) io.emit('wa:status', { status: 'connected', phone });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Historial sincronizado desde el móvil
  sock.ev.on('messaging-history.set', async ({ messages: msgs, isLatest }) => {
    console.log(`Sincronizando historial: ${msgs.length} mensajes (isLatest: ${isLatest})`);
    let imported = 0;
    for (const msg of msgs) {
      try {
        if (!msg.message || !msg.key?.remoteJid) continue;
        const rawJid = msg.key.remoteJid;
        if (rawJid.includes('broadcast') || rawJid.endsWith('@g.us')) continue;

        const { type, text } = getMessageText(msg);
        if (!text) continue;

        const rawPhone = extractPhone(rawJid);
        const phone = normalizePhone(rawPhone);
        // Normalizar JID igual que en processMessage
        const jid = rawJid.includes('@lid') ? rawJid : `${phone}@s.whatsapp.net`;

        const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;
        const direction = msg.key.fromMe ? 'out' : 'in';

        // Verificar si ya existe este mensaje
        const exists = await queryOne('SELECT id FROM messages WHERE message_id = ?', [msg.key.id]);
        if (exists) continue;

        // Upsert contacto
        let contact = await findContactByPhone(phone);
        if (!contact) {
          try {
            const rows = await query(
              'INSERT INTO contacts (phone, name) VALUES (?, ?) ON CONFLICT (phone) DO UPDATE SET name = COALESCE(contacts.name, EXCLUDED.name) RETURNING id, name',
              [phone, msg.pushName || phone]
            );
            contact = rows[0] || await queryOne('SELECT id, name FROM contacts WHERE phone = ?', [phone]);
          } catch (e) {
            await query('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)', [phone, msg.pushName || phone]);
            contact = await queryOne('SELECT id, name FROM contacts WHERE phone = ?', [phone]);
          }
        }

        await saveMessage({ message_id: msg.key.id, jid, direction, type, content: text, timestamp, is_auto_reply: 0, sent_by: null });
        await upsertConversationHistory(jid, contact?.id, text, new Date(timestamp).toISOString(), direction);
        imported++;
      } catch (e) {
        // silencioso — mensajes históricos no deben crashear
      }
    }
    if (imported > 0) {
      console.log(`Historial importado: ${imported} mensajes nuevos`);
      if (io) io.emit('history:synced', { count: imported });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      await processMessage(msg).catch(e => console.error('Error procesando mensaje:', e.message));
    }
  });
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage(phone, text, sentBy = null) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp no está conectado');
  }

  // Resolver el JID correcto — algunos contactos usan @lid en vez de @s.whatsapp.net
  let jid = normalizeJid(phone);
  try {
    const [result] = await sock.onWhatsApp(jid);
    if (result?.exists && result?.jid) {
      jid = result.jid; // usar el JID real que devuelve WA (puede ser @lid)
    }
  } catch(e) {
    // Si onWhatsApp falla, seguir con el JID normalizado
  }

  await sock.presenceSubscribe(jid).catch(() => {});
  await sock.sendPresenceUpdate('composing', jid);
  const typingMs = Math.min(Math.max(text.length * 25, 800), 3500);
  await new Promise(r => setTimeout(r, typingMs));
  await sock.sendPresenceUpdate('paused', jid);

  const sent = await sock.sendMessage(jid, { text });

  await saveMessage({
    message_id: sent.key.id,
    jid, direction: 'out', type: 'text',
    content: text, timestamp: Date.now(),
    is_auto_reply: 0, sent_by: sentBy,
  });

  const existing = await queryOne('SELECT id FROM conversations WHERE jid = ?', [jid]);
  if (existing) {
    await query(
      `UPDATE conversations SET last_message = ?, last_message_at = NOW(), updated_at = NOW() WHERE jid = ?`,
      [text, jid]
    );
  } else {
    await query(
      `INSERT INTO conversations (jid, last_message, last_message_at) VALUES (?, ?, NOW())`,
      [jid, text]
    );
  }

  if (io) {
    let sentByName = null, sentByColor = null;
    if (sentBy) {
      const user = await queryOne('SELECT display_name, color FROM users WHERE id = ?', [sentBy]).catch(() => null);
      sentByName = user?.display_name || null;
      sentByColor = user?.color || null;
    }
    io.emit('message:sent', {
      jid,
      content: text,
      timestamp: Date.now(),
      direction: 'out',
      type: 'text',
      sent_by: sentBy,
      sent_by_name: sentByName,
      sent_by_color: sentByColor,
    });
  }

  return sent;
}

async function sendFile(phone, filePath, mimeType, fileName, caption = '', sentBy = null) {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp no está conectado');

  const jid = normalizeJid(phone);
  const fileBuffer = fs.readFileSync(filePath);

  let message;
  if (mimeType.startsWith('image/')) {
    message = { image: fileBuffer, caption, fileName };
  } else if (mimeType.startsWith('video/')) {
    message = { video: fileBuffer, caption, fileName };
  } else if (mimeType.startsWith('audio/')) {
    message = { audio: fileBuffer, mimetype: mimeType };
  } else {
    message = { document: fileBuffer, mimetype: mimeType, fileName, caption };
  }

  await sock.presenceSubscribe(jid).catch(() => {});
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise(r => setTimeout(r, 1000));
  await sock.sendPresenceUpdate('paused', jid);

  const sent = await sock.sendMessage(jid, message);

  const content = caption || `[${fileName}]`;
  await saveMessage({
    message_id: sent.key.id,
    jid, direction: 'out', type: mimeType.startsWith('image/') ? 'imageMessage' : 'documentMessage',
    content, timestamp: Date.now(), is_auto_reply: 0, sent_by: sentBy,
  });

  const existing = await queryOne('SELECT id FROM conversations WHERE jid = ?', [jid]);
  if (existing) {
    await query(`UPDATE conversations SET last_message = ?, last_message_at = datetime('now'), updated_at = datetime('now') WHERE jid = ?`, [content, jid]);
  } else {
    await query(`INSERT INTO conversations (jid, last_message, last_message_at) VALUES (?, ?, datetime('now'))`, [jid, content]);
  }

  if (io) {
    let sentByName = null, sentByColor = null;
    if (sentBy) {
      const user = await queryOne('SELECT display_name, color FROM users WHERE id = ?', [sentBy]).catch(() => null);
      sentByName = user?.display_name || null;
      sentByColor = user?.color || null;
    }
    io.emit('message:sent', {
      jid: normalizeJid(phone),
      content,
      timestamp: Date.now(),
      sent_by: sentBy,
      sent_by_name: sentByName,
      sent_by_color: sentByColor,
      type: mimeType.startsWith('image/') ? 'imageMessage' : 'documentMessage',
    });
  }
  return sent;
}

async function logout() {
  if (sock) {
    await sock.logout().catch(() => {});
    sock = null;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (fs.existsSync(AUTH_PATH)) {
    fs.rmSync(AUTH_PATH, { recursive: true, force: true });
    fs.mkdirSync(AUTH_PATH, { recursive: true });
  }
  connectionStatus = 'disconnected';
  qrData = null;
  setTimeout(connect, 1000);
}

// Fuerza re-sincronización del historial desde el teléfono
// borrando las credenciales de sesión y reconectando
async function requestHistoryResync() {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp no conectado');
  }
  try {
    // Baileys: fetchAllSupportedFeatures fuerza historial si el sock lo soporta
    await sock.sendNode({
      tag: 'iq',
      attrs: { type: 'get', to: 's.whatsapp.net', xmlns: 'urn:xmpp:whatsapp:dirty' },
      content: [{ tag: 'clean', attrs: { type: 'account_sync' } }]
    }).catch(() => {});
  } catch(e) { /* ignorar */ }

  // Emitir historial nuevamente desde el store de mensajes en memoria si existe
  if (sock.ev) {
    sock.ev.emit('messaging-history.set', {
      messages: [],
      contacts: [],
      chats: [],
      isLatest: false
    });
  }
  return true;
}

module.exports = { connect, setIO, getStatus, getSock, sendMessage, sendFile, logout, normalizePhone, normalizeJid, extractPhone, requestHistoryResync };