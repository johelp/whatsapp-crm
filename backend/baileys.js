/**
 * baileys.js — Conexion WhatsApp con Baileys ESM
 * VERSIÓN SIMPLIFICADA Y ROBUSTA — sin lógica de país específica
 */
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { query, queryOne } = require('./db');
const { runAIAgent } = require('./ai-agent');

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

// ─── Normalización ────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  // Solo limpiar — sin transformaciones de país
  return String(raw).replace(/\D/g, '').split('@')[0];
}

function normalizeJid(phone) {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}

function extractPhone(jid) {
  return String(jid).split('@')[0];
}

// Busca contacto por número exacto o variante (últimos 10 dígitos)
async function findContactByPhone(phone) {
  const clean = normalizePhone(phone);
  let c = await queryOne('SELECT * FROM contacts WHERE phone = ?', [clean]);
  if (c) return c;
  // Buscar por sufijo de 10 dígitos
  if (clean.length >= 10) {
    const suffix = clean.slice(-10);
    c = await queryOne(`SELECT * FROM contacts WHERE phone LIKE ?`, [`%${suffix}`]);
  }
  return c || null;
}

// ─── Texto del mensaje ────────────────────────────────────────────────────────

function getMessageText(msg) {
  if (!msg.message) return { type: 'unknown', text: '', mediaData: null };
  const type = getContentType(msg.message);
  const m = msg.message;
  let text = '';
  let mediaData = null;

  const extractMedia = (obj, mediaType) => ({
    type: mediaType,
    mimetype: obj?.mimetype || null,
    caption: obj?.caption || '',
    fileName: obj?.fileName || null,
    ptt: obj?.ptt || false,
    seconds: obj?.seconds || 0,
    url: obj?.url || null,
    directPath: obj?.directPath || null,
    mediaKey: obj?.mediaKey ? Buffer.from(obj.mediaKey).toString('base64') : null,
    fileEncSha256: obj?.fileEncSha256 ? Buffer.from(obj.fileEncSha256).toString('base64') : null,
    fileSha256: obj?.fileSha256 ? Buffer.from(obj.fileSha256).toString('base64') : null,
    fileLength: obj?.fileLength || null,
  });

  switch (type) {
    case 'conversation':       text = m.conversation || ''; break;
    case 'extendedTextMessage': text = m.extendedTextMessage?.text || ''; break;
    case 'imageMessage':
      text = m.imageMessage?.caption || '';
      mediaData = extractMedia(m.imageMessage, 'image');
      if (!text) text = '[Imagen]';
      break;
    case 'videoMessage':
      text = m.videoMessage?.caption || '[Video]';
      mediaData = extractMedia(m.videoMessage, 'video');
      break;
    case 'audioMessage':
      text = '[Audio]';
      mediaData = extractMedia(m.audioMessage, 'audio');
      break;
    case 'documentMessage':
      text = `[Archivo: ${m.documentMessage?.fileName || ''}]`;
      mediaData = extractMedia(m.documentMessage, 'document');
      break;
    case 'stickerMessage': text = '[Sticker]'; break;
    case 'locationMessage':
      text = `[Ubicación]`;
      break;
    case 'reactionMessage': text = ''; break;
    default: text = type ? `[${type}]` : '';
  }
  return { type: type || 'text', text, mediaData };
}

// ─── Auto-reply bot ───────────────────────────────────────────────────────────

function isBusinessHours(config) {
  if (!config?.is_active) return true;
  const tz = config.timezone || 'Europe/Madrid';
  const now = new Date();
  const parts = now.toLocaleString('en-US', { timeZone: tz, hour12: false }).split(', ');
  const timePart = parts[1] || '00:00:00';
  const [hStr, mStr] = timePart.split(':');
  const localH = parseInt(hStr, 10) % 24;
  const localM = parseInt(mStr, 10);
  const localNowMin = localH * 60 + localM;
  const localDay = new Date(now.toLocaleString('en-US', { timeZone: tz })).getDay();
  const workDays = (config.working_days || '1,2,3,4,5').split(',').map(Number);
  if (!workDays.includes(localDay)) return false;
  const [sh, sm] = (config.schedule_start || '09:00').split(':').map(Number);
  const [eh, em] = (config.schedule_end   || '18:00').split(':').map(Number);
  return localNowMin >= sh * 60 + sm && localNowMin <= eh * 60 + em;
}

const fieldPrompts = {
  name: '¿Cuál es tu nombre?',
  email: '¿Cuál es tu email?',
  phone: '¿En qué número podemos llamarte?',
  reason: '¿Cuál es el motivo de tu consulta?',
};

async function runAutoReplyBot(jid, incomingText, conv) {
  if (jid.endsWith('@g.us')) return false;
  const config = await queryOne('SELECT * FROM auto_reply_config LIMIT 1');
  if (!config || !config.is_active) return false;
  if (isBusinessHours(config)) return false;

  const botState = conv?.bot_state || 'idle';
  const collected = JSON.parse(conv?.bot_collected || '{}');
  const fields = JSON.parse(config.collect_fields || '["name","email","phone","reason"]');

  let responseText = '', newState = botState, newCollected = { ...collected };

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
      const summary = Object.entries(newCollected).map(([k, v]) => `- ${k}: ${v}`).join('\n');
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
    try {
      await sendMessage(jid, responseText, null);
    } catch(e) {
      console.error('[AutoReply] Error:', e.message);
      try {
        await sock.sendMessage(jid, { text: responseText });
        await saveMessage({ message_id: `bot_${Date.now()}`, jid, direction: 'out', type: 'text', content: responseText, timestamp: Date.now(), is_auto_reply: 1, sent_by: null });
      } catch(e2) { console.error('[AutoReply] Fallback falló:', e2.message); }
    }
    await query('UPDATE conversations SET bot_state = ?, bot_collected = ?, updated_at = NOW() WHERE jid = ?',
      [newState, JSON.stringify(newCollected), jid]).catch(() => {});
    await query(`UPDATE messages SET is_auto_reply = 1 WHERE jid = ? AND direction = 'out' ORDER BY timestamp DESC LIMIT 1`, [jid]).catch(() => {});
  }
  return true;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function saveMessage({ message_id, jid, direction, type, content, timestamp, is_auto_reply, sent_by, sender_jid = null, sender_name = null, media_data = null }) {
  try {
    const mediaJson = media_data ? JSON.stringify(media_data) : null;
    await query(
      `INSERT INTO messages (message_id, jid, direction, type, content, timestamp, is_auto_reply, sent_by, sender_jid, sender_name, media_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO NOTHING`,
      [message_id, jid, direction, type, content || '', timestamp, is_auto_reply ? 1 : 0, sent_by || null, sender_jid, sender_name, mediaJson]
    );
  } catch(e) {
    console.error('[saveMessage] Error:', e.message, '| jid:', jid, '| msg_id:', message_id);
  }
}

async function upsertConversationHistory(jid, contactId, lastMessage, lastMessageAt, direction) {
  const existing = await queryOne('SELECT id, last_message_at FROM conversations WHERE jid = ?', [jid]);
  if (existing) {
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
        wa_push_name = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE wa_push_name END,
        last_message = ?,
        last_message_at = ?,
        unread_count = unread_count + 1,
        updated_at = NOW()
       WHERE jid = ?`,
      [contactId || null, pushName, pushName, pushName, lastMessage, lastMessageAt, jid]
    );
  } else {
    await query(
      `INSERT INTO conversations (jid, contact_id, wa_push_name, last_message, last_message_at, unread_count)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [jid, contactId || null, pushName, lastMessage, lastMessageAt]
    );
  }
}

// ─── Grupos ───────────────────────────────────────────────────────────────────

const _groupCache = new Map();

async function getGroupMetadata(jid) {
  if (_groupCache.has(jid)) return _groupCache.get(jid);
  try {
    if (!sock) return null;
    const meta = await sock.groupMetadata(jid);
    if (meta) _groupCache.set(jid, meta);
    return meta;
  } catch(e) { return null; }
}

async function processGroupMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;
  const groupJid = msg.key.remoteJid;
  const senderJid = msg.key.participant || '';
  const { type, text, mediaData } = getMessageText(msg);
  if (!text && !mediaData) return;
  const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;
  const pushName = msg.pushName || extractPhone(senderJid) || 'Desconocido';
  let groupName = groupJid.split('@')[0];
  try { const meta = await getGroupMetadata(groupJid); if (meta?.subject) groupName = meta.subject; } catch(e) {}
  const content = text || (mediaData ? `[${mediaData.type}]` : '[mensaje]');
  try {
    await query(
      `INSERT INTO conversations (jid, is_group, group_name, last_message, last_message_at, unread_count)
       VALUES (?, 1, ?, ?, NOW(), 1)
       ON CONFLICT (jid) DO UPDATE SET
         is_group = 1,
         group_name = COALESCE(EXCLUDED.group_name, conversations.group_name),
         last_message = EXCLUDED.last_message,
         last_message_at = NOW(),
         unread_count = conversations.unread_count + 1,
         updated_at = NOW()`,
      [groupJid, groupName, content]
    );
  } catch(e) { console.error('[processGroupMessage]', e.message); }
  await saveMessage({ message_id: msg.key.id, jid: groupJid, direction: 'in', type, content, timestamp, is_auto_reply: 0, sent_by: null, sender_jid: senderJid, sender_name: pushName, media_data: mediaData });
  if (io) io.emit('message:new', { jid: groupJid, is_group: true, group_name: groupName, sender_jid: senderJid, sender_name: pushName, content, type, timestamp, message_id: msg.key.id });
}

// ─── Procesar mensaje ENTRANTE en tiempo real ─────────────────────────────────

async function processMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;
  const rawJid = msg.key.remoteJid;
  if (!rawJid || rawJid.includes('broadcast')) return;
  if (rawJid.endsWith('@g.us')) { await processGroupMessage(msg); return; }

  const isLid = rawJid.endsWith('@lid');
  // Usar el JID exacto que viene de WA — no transformar
  const jid = rawJid;
  const phone = extractPhone(rawJid);

  const { type, text, mediaData } = getMessageText(msg);
  const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;
  const content = text || (mediaData ? `[${mediaData.type || 'media'}]` : '');

  // Contacto (solo para números reales, no @lid)
  let contact = null;
  if (!isLid) {
    contact = await findContactByPhone(phone);
    if (!contact) {
      try {
        const rows = await query(
          `INSERT INTO contacts (phone, name) VALUES (?, ?)
           ON CONFLICT (phone) DO UPDATE SET
             name = CASE WHEN contacts.name IS NULL OR contacts.name = EXCLUDED.phone THEN EXCLUDED.name ELSE contacts.name END
           RETURNING id, name, phone`,
          [phone, msg.pushName || null]
        );
        contact = rows[0] || await queryOne('SELECT id FROM contacts WHERE phone = ?', [phone]);
      } catch (e) {
        await query('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)', [phone, msg.pushName || null]).catch(() => {});
        contact = await queryOne('SELECT id FROM contacts WHERE phone = ?', [phone]);
      }
    } else if (msg.pushName && (!contact.name || contact.name === phone)) {
      await query('UPDATE contacts SET name = ? WHERE id = ?', [msg.pushName, contact.id]).catch(() => {});
    }
  }

  const displayName = msg.pushName || contact?.name || phone;

  if (contact?.id) {
    await query('UPDATE conversations SET contact_id = ? WHERE jid = ? AND contact_id IS NULL', [contact.id, jid]).catch(() => {});
  }

  await saveMessage({ message_id: msg.key.id, jid, direction: 'in', type, content, timestamp, is_auto_reply: 0, sent_by: null, media_data: mediaData });
  await upsertConversation(jid, contact?.id, content, new Date(timestamp).toISOString(), displayName);

  const conv = await queryOne('SELECT * FROM conversations WHERE jid = ?', [jid]);
  const autoHandled = await runAutoReplyBot(jid, text, conv).catch(() => false);
  if (!autoHandled) {
    runAIAgent(jid, text, sendMessage).catch(e => console.error('[AI]', e.message));
  }

  if (io) {
    const convFull = await queryOne(
      `SELECT cv.*, c.name as contact_name, c.phone as contact_phone
       FROM conversations cv LEFT JOIN contacts c ON cv.contact_id = c.id WHERE cv.jid = ?`, [jid]
    );
    io.emit('message:new', { jid, phone, contact_name: displayName, content, type, timestamp, is_auto_reply: autoHandled, message_id: msg.key.id, conversation: convFull });
  }
}

// ─── Procesar mensaje individual de historial ─────────────────────────────────

async function processHistoryMessage(msg) {
  if (!msg.message || !msg.key?.remoteJid) return;
  const rawJid = msg.key.remoteJid;
  if (rawJid.includes('broadcast')) return;
  const { type, text, mediaData } = getMessageText(msg);
  const isGroup = rawJid.endsWith('@g.us');
  const isLid = rawJid.endsWith('@lid');
  const phone = extractPhone(rawJid);
  const jid = rawJid;
  const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;
  const direction = msg.key.fromMe ? 'out' : 'in';
  const content = text || (mediaData ? `[${mediaData.type || 'media'}]` : '[mensaje]');
  const exists = await queryOne('SELECT id FROM messages WHERE message_id = ?', [msg.key.id]);
  if (exists) return;
  await saveMessage({ message_id: msg.key.id, jid, direction, type, content, timestamp, is_auto_reply: 0, sent_by: null, sender_jid: isGroup ? (msg.key.participant || null) : null, sender_name: isGroup ? (msg.pushName || null) : null, media_data: mediaData });
  if (!isGroup && !isLid) {
    let contact = await findContactByPhone(phone);
    if (!contact && msg.pushName) {
      await query('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)', [phone, msg.pushName]).catch(() => {});
      contact = await queryOne('SELECT id FROM contacts WHERE phone = ?', [phone]);
    }
    await upsertConversationHistory(jid, contact?.id, content, new Date(timestamp).toISOString(), direction);
    if (msg.pushName) await query('UPDATE conversations SET wa_push_name = COALESCE(wa_push_name, ?) WHERE jid = ?', [msg.pushName, jid]).catch(() => {});
  } else if (isGroup) {
    let groupName = jid.split('@')[0];
    try { const meta = await getGroupMetadata(jid); if (meta?.subject) groupName = meta.subject; } catch(e) {}
    await query(
      `INSERT INTO conversations (jid, is_group, group_name, last_message, last_message_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT (jid) DO UPDATE SET
         is_group = 1, group_name = COALESCE(EXCLUDED.group_name, conversations.group_name),
         last_message = CASE WHEN conversations.last_message_at < EXCLUDED.last_message_at THEN EXCLUDED.last_message ELSE conversations.last_message END,
         last_message_at = CASE WHEN conversations.last_message_at < EXCLUDED.last_message_at THEN EXCLUDED.last_message_at ELSE conversations.last_message_at END`,
      [jid, groupName, content, new Date(timestamp).toISOString()]
    ).catch(() => {});
  } else {
    await upsertConversationHistory(jid, null, content, new Date(timestamp).toISOString(), direction);
  }
}

// ─── Mensajes salientes desde el móvil/WA Web ─────────────────────────────────

async function processOutgoingMessage(msg) {
  if (!msg.message || !msg.key.fromMe) return;
  const rawJid = msg.key.remoteJid;
  if (!rawJid || rawJid.includes('broadcast')) return;
  const { type, text, mediaData } = getMessageText(msg);
  if (!text && !mediaData && type === 'unknown') return;
  const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;
  const jid = rawJid;
  const content = text || (mediaData ? `[${mediaData.type || 'media'}]` : '[mensaje]');
  const exists = await queryOne('SELECT id FROM messages WHERE message_id = ?', [msg.key.id]);
  if (exists) return;
  await saveMessage({ message_id: msg.key.id, jid, direction: 'out', type, content, timestamp, is_auto_reply: 0, sent_by: null, sender_jid: msg.key.participant || null, sender_name: null, media_data: mediaData });
  await query(`UPDATE conversations SET last_message = ?, last_message_at = ?, updated_at = NOW() WHERE jid = ?`,
    [content, new Date(timestamp).toISOString(), jid]).catch(() => {});
  if (io) {
    io.emit('message:sent', { jid, content, timestamp, direction: 'out', type, sent_by: null, sent_by_name: '📱 Móvil', sent_by_color: '#94a3b8', from_device: true, media_data: mediaData });
  }
  console.log(`[fromDevice] ${jid.split('@')[0]}: ${content.substring(0, 60)}`);
}

// ─── Connect ──────────────────────────────────────────────────────────────────

async function connect() {
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
    browser: ['Chrome (Linux)', 'Chrome', '121.0.6167.160'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: true,
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
      console.log('Conexión cerrada. Código:', code);
      connectionStatus = 'disconnected';
      if (io) io.emit('wa:status', { status: 'disconnected' });
      if (code === DisconnectReason.loggedOut) {
        console.log('Sesión cerrada. Re-escanear QR.');
      } else {
        clearTimeout(reconnectTimer);
        const delay = code === 440 ? 8000 : 4000;
        reconnectTimer = setTimeout(() => connect().catch(console.error), delay);
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrData = null;
      const phone = sock.user?.id?.split(':')[0] || '';
      console.log(`WhatsApp conectado: ${phone}`);
      // Emitir ambos strings — el frontend puede escuchar cualquiera
      if (io) {
        io.emit('wa:status', { status: 'open', phone });
        io.emit('wa:status', { status: 'connected', phone });
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── HISTORIAL ────────────────────────────────────────────────────────────────
  sock.ev.on('messaging-history.set', async ({ messages: msgs, isLatest }) => {
    console.log(`[Historial] Recibidos: ${msgs.length} mensajes (isLatest: ${isLatest})`);
    if (io) io.emit('history:progress', { total: msgs.length, imported: 0, status: 'starting' });

    let imported = 0;
    let errors = 0;

    for (const msg of msgs) {
      try {
        if (!msg.message || !msg.key?.remoteJid) continue;
        const rawJid = msg.key.remoteJid;
        if (rawJid.includes('broadcast')) continue;

        const isGroup = rawJid.endsWith('@g.us');
        const isLid = rawJid.endsWith('@lid');
        const { type, text, mediaData } = getMessageText(msg);
        const jid = rawJid;
        const phone = extractPhone(rawJid);
        const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;
        const direction = msg.key.fromMe ? 'out' : 'in';
        const content = text || (mediaData ? `[${mediaData.type || 'media'}]` : '[mensaje]');

        // Verificar si ya existe
        const exists = await queryOne('SELECT id FROM messages WHERE message_id = ?', [msg.key.id]);
        if (exists) continue;

        // Contacto
        let contact = null;
        if (!isLid && !isGroup) {
          contact = await findContactByPhone(phone);
          if (!contact && msg.pushName) {
            try {
              const rows = await query(
                `INSERT INTO contacts (phone, name) VALUES (?, ?)
                 ON CONFLICT (phone) DO UPDATE SET name = CASE WHEN contacts.name IS NULL OR contacts.name = EXCLUDED.phone THEN EXCLUDED.name ELSE contacts.name END
                 RETURNING id, name`,
                [phone, msg.pushName]
              );
              contact = rows[0] || await queryOne('SELECT id FROM contacts WHERE phone = ?', [phone]);
            } catch(e) {
              await query('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)', [phone, msg.pushName]).catch(() => {});
              contact = await queryOne('SELECT id FROM contacts WHERE phone = ?', [phone]);
            }
          }
        }

        const senderJid = isGroup ? (msg.key.participant || null) : null;
        const senderName = isGroup ? (msg.pushName || null) : null;
        await saveMessage({ message_id: msg.key.id, jid, direction, type, content, timestamp, is_auto_reply: 0, sent_by: null, sender_jid: senderJid, sender_name: senderName, media_data: mediaData || null });

        if (isGroup) {
          let groupName = jid.split('@')[0];
          try { const meta = await getGroupMetadata(jid); if (meta?.subject) groupName = meta.subject; } catch(e) {}
          await query(
            `INSERT INTO conversations (jid, is_group, group_name, last_message, last_message_at)
             VALUES (?, 1, ?, ?, ?)
             ON CONFLICT (jid) DO UPDATE SET
               is_group = 1, group_name = COALESCE(EXCLUDED.group_name, conversations.group_name),
               last_message = CASE WHEN conversations.last_message_at < EXCLUDED.last_message_at THEN EXCLUDED.last_message ELSE conversations.last_message END,
               last_message_at = CASE WHEN conversations.last_message_at < EXCLUDED.last_message_at THEN EXCLUDED.last_message_at ELSE conversations.last_message_at END`,
            [jid, groupName, content, new Date(timestamp).toISOString()]
          ).catch(() => {});
        } else {
          await upsertConversationHistory(jid, contact?.id, content, new Date(timestamp).toISOString(), direction);
          if (msg.pushName) {
            await query('UPDATE conversations SET wa_push_name = COALESCE(wa_push_name, ?) WHERE jid = ?', [msg.pushName, jid]).catch(() => {});
          }
        }

        imported++;
        if (imported % 50 === 0 && io) {
          io.emit('history:progress', { total: msgs.length, imported, status: 'importing' });
          console.log(`[Historial] Importados: ${imported}/${msgs.length}`);
        }
      } catch (e) {
        errors++;
        if (!e.message?.includes('duplicate') && !e.message?.includes('unique')) {
          console.error('[Historial] Error:', e.message?.substring(0, 100));
        }
      }
    }

    console.log(`[Historial] COMPLETADO: ${imported} importados, ${errors} errores`);
    if (io) io.emit('history:synced', { count: imported, isLatest });
  });

  // ─── MENSAJES EN TIEMPO REAL ───────────────────────────────────────────────
  sock.ev.on('groups.update', async (updates) => {
    for (const update of updates) {
      if (!update.id) continue;
      _groupCache.delete(update.id);
      if (update.subject) {
        await query('UPDATE conversations SET group_name = ? WHERE jid = ?', [update.subject, update.id]).catch(() => {});
        if (io) io.emit('group:updated', { jid: update.id, group_name: update.subject });
      }
    }
  });

  sock.ev.on('groups.upsert', async (groups) => {
    for (const group of groups) {
      _groupCache.set(group.id, group);
      await query(
        `INSERT INTO conversations (jid, is_group, group_name, last_message_at) VALUES (?, 1, ?, NOW())
         ON CONFLICT (jid) DO UPDATE SET is_group = 1, group_name = COALESCE(EXCLUDED.group_name, conversations.group_name)`,
        [group.id, group.subject || group.id.split('@')[0]]
      ).catch(() => {});
    }
  });

  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    const RECENT_MS = 5 * 60 * 1000;
    const now = Date.now();

    for (const msg of msgs) {
      if (msg.key?.fromMe) {
        const ts = (msg.messageTimestamp || 0) * 1000;
        const isRecent = (now - ts) < RECENT_MS;
        if (type === 'notify' || (type === 'append' && isRecent)) {
          await processOutgoingMessage(msg).catch(e => console.error('[outgoing]', e.message));
        }
      } else {
        if (type === 'notify') {
          await processMessage(msg).catch(e => console.error('[incoming]', e.message));
        } else if (type === 'append') {
          await processHistoryMessage(msg).catch(e => console.error('[history append]', e.message));
        }
      }
    }
  });
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage(phone, text, sentBy = null) {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp no está conectado');

  let convJid;
  if (String(phone).includes('@')) {
    convJid = phone;
  } else {
    convJid = `${normalizePhone(phone)}@s.whatsapp.net`;
  }

  // Typing indicator solo para @s.whatsapp.net (no @lid — causa "Esperando")
  if (convJid.endsWith('@s.whatsapp.net')) {
    await sock.sendPresenceUpdate('composing', convJid).catch(() => {});
    const typingMs = Math.min(Math.max(text.length * 25, 600), 2500);
    await new Promise(r => setTimeout(r, typingMs));
    await sock.sendPresenceUpdate('paused', convJid).catch(() => {});
  }

  const sent = await sock.sendMessage(convJid, { text });

  await saveMessage({ message_id: sent.key.id, jid: convJid, direction: 'out', type: 'text', content: text, timestamp: Date.now(), is_auto_reply: 0, sent_by: sentBy });

  const existing = await queryOne('SELECT id FROM conversations WHERE jid = ?', [convJid]);
  if (existing) {
    await query(`UPDATE conversations SET last_message = ?, last_message_at = NOW(), updated_at = NOW() WHERE jid = ?`, [text, convJid]);
  } else {
    await query(`INSERT INTO conversations (jid, last_message, last_message_at) VALUES (?, ?, NOW()) ON CONFLICT (jid) DO UPDATE SET last_message = EXCLUDED.last_message, last_message_at = NOW()`, [convJid, text]).catch(() => {});
  }

  if (io) {
    let sentByName = null, sentByColor = null;
    if (sentBy) {
      const user = await queryOne('SELECT display_name, color FROM users WHERE id = ?', [sentBy]).catch(() => null);
      sentByName = user?.display_name || null;
      sentByColor = user?.color || null;
    }
    io.emit('message:sent', { jid: convJid, content: text, timestamp: Date.now(), direction: 'out', type: 'text', sent_by: sentBy, sent_by_name: sentByName, sent_by_color: sentByColor });
  }

  return sent;
}

async function sendGroupMessage(groupJid, text, sentBy = null) {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp no está conectado');
  if (!groupJid.endsWith('@g.us')) throw new Error('JID de grupo inválido');
  await sock.sendPresenceUpdate('composing', groupJid).catch(() => {});
  const typingMs = Math.min(Math.max(text.length * 20, 400), 2000);
  await new Promise(r => setTimeout(r, typingMs));
  await sock.sendPresenceUpdate('paused', groupJid).catch(() => {});
  const sent = await sock.sendMessage(groupJid, { text });
  await saveMessage({ message_id: sent.key.id, jid: groupJid, direction: 'out', type: 'text', content: text, timestamp: Date.now(), is_auto_reply: 0, sent_by: sentBy });
  await query(`UPDATE conversations SET last_message = ?, last_message_at = NOW(), updated_at = NOW() WHERE jid = ?`, [text, groupJid]).catch(() => {});
  if (io) {
    let sentByName = null, sentByColor = null;
    if (sentBy) {
      const user = await queryOne('SELECT display_name, color FROM users WHERE id = ?', [sentBy]).catch(() => null);
      sentByName = user?.display_name || null; sentByColor = user?.color || null;
    }
    io.emit('message:sent', { jid: groupJid, is_group: true, content: text, timestamp: Date.now(), direction: 'out', type: 'text', sent_by: sentBy, sent_by_name: sentByName, sent_by_color: sentByColor });
  }
  return sent;
}

async function sendFile(phone, filePath, mimeType, fileName, caption = '', sentBy = null) {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp no está conectado');
  const jid = String(phone).includes('@') ? phone : normalizeJid(phone);
  const fileBuffer = fs.readFileSync(filePath);
  let message;
  if (mimeType.startsWith('image/')) message = { image: fileBuffer, caption, fileName };
  else if (mimeType.startsWith('video/')) message = { video: fileBuffer, caption, fileName };
  else if (mimeType.startsWith('audio/')) message = { audio: fileBuffer, mimetype: mimeType };
  else message = { document: fileBuffer, mimetype: mimeType, fileName, caption };
  const sent = await sock.sendMessage(jid, message);
  const content = caption || `[${fileName}]`;
  await saveMessage({ message_id: sent.key.id, jid, direction: 'out', type: mimeType.startsWith('image/') ? 'imageMessage' : 'documentMessage', content, timestamp: Date.now(), is_auto_reply: 0, sent_by: sentBy });
  await query(`UPDATE conversations SET last_message = ?, last_message_at = NOW(), updated_at = NOW() WHERE jid = ?`, [content, jid]).catch(() => {});
  if (io) io.emit('message:sent', { jid, content, timestamp: Date.now(), direction: 'out', type: mimeType.startsWith('image/') ? 'imageMessage' : 'documentMessage', sent_by: sentBy, sent_by_name: null, sent_by_color: null });
  return sent;
}

async function logout() {
  try { await sock?.logout(); } catch(e) {}
  connectionStatus = 'disconnected';
  qrData = null;
  if (io) io.emit('wa:status', { status: 'disconnected' });
}

async function requestHistoryResync() {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp no conectado');
  console.log('[Resync] Iniciando re-sincronización...');
  try {
    const convs = await query(`SELECT c.jid, m.message_id, m.timestamp, m.direction FROM conversations c LEFT JOIN messages m ON m.jid = c.jid WHERE c.jid NOT LIKE '%@g.us%' AND c.jid NOT LIKE '%@lid%' AND m.message_id IS NOT NULL ORDER BY m.timestamp ASC LIMIT 1`).catch(() => []);
    if (sock.fetchMessageHistory && convs.length > 0) {
      const oldest = convs[0];
      await sock.fetchMessageHistory(50, { remoteJid: oldest.jid, fromMe: oldest.direction === 'out', id: oldest.message_id }, oldest.timestamp / 1000);
      console.log('[Resync] fetchMessageHistory enviado');
    }
  } catch(e) { console.log('[Resync] fetchMessageHistory falló:', e.message); }
  try {
    await sock.sendNode({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'set', id: sock.generateMessageTag?.() || `resync_${Date.now()}`, xmlns: 'urn:xmpp:whatsapp:dirty' }, content: [{ tag: 'clean', attrs: { type: 'account_sync' } }] });
    console.log('[Resync] dirty sync enviado');
  } catch(e) { console.log('[Resync] dirty sync falló:', e.message); }
  if (io) io.emit('history:syncing', {});
  return true;
}

// ─── Reset completo de auth para forzar historial desde cero ─────────────────
// Borra las credenciales guardadas — WA enviará historial completo en la reconexión

async function fullResetAuth() {
  console.log('[FullReset] Iniciando reset de credenciales WA...');
  
  // 1. Desconectar socket actual limpiamente (sin logout de WA — queremos mantener la sesión de WA activa)
  try {
    if (sock) {
      sock.end(undefined);
      sock = null;
    }
  } catch(e) { console.log('[FullReset] sock.end:', e.message); }

  connectionStatus = 'disconnected';
  if (io) io.emit('wa:status', { status: 'disconnected' });

  // 2. Borrar archivos de credenciales para que Baileys los regenere
  //    WA verá un dispositivo "nuevo" y mandará historial completo
  try {
    const files = fs.readdirSync(AUTH_PATH);
    for (const f of files) {
      fs.unlinkSync(path.join(AUTH_PATH, f));
    }
    console.log(`[FullReset] Eliminados ${files.length} archivos de auth`);
  } catch(e) {
    console.error('[FullReset] Error borrando auth:', e.message);
    throw new Error('No se pudo borrar las credenciales: ' + e.message);
  }

  // 3. Reconectar — aparecerá QR para re-vincular
  setTimeout(() => {
    connect().catch(e => console.error('[FullReset] connect error:', e.message));
  }, 1000);

  return true;
}

module.exports = { connect, setIO, getStatus, getSock, sendMessage, sendGroupMessage, sendFile, logout, normalizePhone, normalizeJid, extractPhone, requestHistoryResync, fullResetAuth };