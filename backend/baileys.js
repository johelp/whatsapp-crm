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

async function saveMessage({ message_id, jid, direction, type, content, timestamp, is_auto_reply, sent_by, sender_jid = null, sender_name = null }) {
  try {
    await query(
      `INSERT INTO messages (message_id, jid, direction, type, content, timestamp, is_auto_reply, sent_by, sender_jid, sender_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO NOTHING`,
      [message_id, jid, direction, type, content || '', timestamp, is_auto_reply ? 1 : 0, sent_by || null, sender_jid, sender_name]
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


// ─── Grupos ───────────────────────────────────────────────────────────────────

// Cache de metadata de grupos en memoria (jid → {subject, participants, ...})
const _groupCache = new Map();

async function getGroupMetadata(jid) {
  if (_groupCache.has(jid)) return _groupCache.get(jid);
  try {
    if (!sock) return null;
    const meta = await sock.groupMetadata(jid);
    if (meta) _groupCache.set(jid, meta);
    return meta;
  } catch(e) {
    return null;
  }
}

async function upsertGroup(jid, subject, description) {
  // Upsert en tabla conversations con flag is_group y nombre del grupo
  try {
    await query(
      `INSERT INTO conversations (jid, is_group, group_name, last_message_at)
       VALUES (?, 1, ?, NOW())
       ON CONFLICT (jid) DO UPDATE SET
         is_group = 1,
         group_name = COALESCE(EXCLUDED.group_name, conversations.group_name)`,
      [jid, subject || jid.split('@')[0]]
    );
  } catch(e) {
    // ignorar
  }
}

// Procesar mensaje de grupo
async function processGroupMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;

  const groupJid = msg.key.remoteJid; // formato: XXXXX@g.us
  const senderJid = msg.key.participant || ''; // quien habló en el grupo
  const senderPhone = senderJid ? normalizePhone(extractPhone(senderJid)) : null;

  const { type, text } = getMessageText(msg);
  if (!text) return; // ignorar mensajes sin texto (stickers, etc. se pueden agregar después)

  const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;
  const pushName = msg.pushName || senderPhone || 'Desconocido';

  // Obtener o crear metadata del grupo
  let groupName = groupJid.split('@')[0];
  try {
    const meta = await getGroupMetadata(groupJid);
    if (meta?.subject) groupName = meta.subject;
  } catch(e) {}

  // Asegurar que existe la conversación de grupo
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
      [groupJid, groupName, text]
    );
  } catch(e) {
    console.error('Error upsert grupo:', e.message);
  }

  // Guardar mensaje con info del sender
  await saveMessage({
    message_id: msg.key.id,
    jid: groupJid,
    direction: 'in',
    type,
    content: text,
    timestamp,
    is_auto_reply: 0,
    sent_by: null,
    sender_jid: senderJid,
    sender_name: pushName,
  });

  if (io) {
    io.emit('message:new', {
      jid: groupJid,
      is_group: true,
      group_name: groupName,
      sender_jid: senderJid,
      sender_name: pushName,
      content: text,
      type,
      timestamp,
      message_id: msg.key.id,
    });
  }
}

// ─── Process incoming message ─────────────────────────────────────────────────

async function processMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;

  const rawJid = msg.key.remoteJid;
  if (!rawJid || rawJid.includes('broadcast')) return;
  
  // Grupos: procesar separado con contexto de grupo
  if (rawJid.endsWith('@g.us')) {
    await processGroupMessage(msg);
    return;
  }

  const isLid = rawJid.endsWith('@lid');
  const rawPhone = extractPhone(rawJid);
  // Si es @lid, el "phone" es el LID numérico interno de WA — NO es un teléfono real.
  // Lo usamos solo como identificador único para la conversación.
  const phone = isLid ? rawPhone : normalizePhone(rawPhone);

  // JID canónico: @lid se usa tal cual, @s.whatsapp.net se normaliza (Argentina con 9)
  const jid = isLid ? rawJid : `${phone}@s.whatsapp.net`;

  const { type, text } = getMessageText(msg);
  const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;

  // Para @lid: NO buscar por teléfono (el LID no es un número real).
  // Solo buscamos/creamos contacto para JIDs con número real.
  let contact = null;
  if (!isLid) {
    contact = await findContactByPhone(phone);
    if (!contact) {
      const contactName = msg.pushName || null;
      try {
        const rows = await query(
          `INSERT INTO contacts (phone, name) VALUES (?, ?)
           ON CONFLICT (phone) DO UPDATE SET
             name = CASE
               WHEN contacts.name IS NULL OR contacts.name = EXCLUDED.phone THEN EXCLUDED.name
               ELSE contacts.name
             END
           RETURNING id, name, phone`,
          [phone, contactName]
        );
        contact = rows[0] || await queryOne('SELECT id, name FROM contacts WHERE phone = ?', [phone]);
      } catch (e) {
        await query('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)', [phone, contactName]);
        contact = await queryOne('SELECT id, name FROM contacts WHERE phone = ?', [phone]);
      }
    } else if (msg.pushName && (!contact.name || contact.name === phone || contact.name === contact.phone)) {
      await query('UPDATE contacts SET name = ? WHERE id = ?', [msg.pushName, contact.id]);
      contact.name = msg.pushName;
    }
  }
  // Para @lid: el nombre visible es siempre el pushName de WhatsApp
  const displayName = msg.pushName || (contact?.name) || phone;

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
  await upsertConversation(jid, contact?.id, text, new Date(timestamp).toISOString(), displayName);

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
        if (rawJid.includes('broadcast')) continue;
        // Grupos: guardar con flag is_group
        const isGroup = rawJid.endsWith('@g.us');

        const { type, text } = getMessageText(msg);
        if (!text) continue;

        const rawPhone = extractPhone(rawJid);
        const phone = normalizePhone(rawPhone);
        // Normalizar JID: grupos usan su JID original, individuales se normalizan
        const jid = isGroup ? rawJid : (rawJid.includes('@lid') ? rawJid : `${phone}@s.whatsapp.net`);

        const timestamp = (msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000;
        const direction = msg.key.fromMe ? 'out' : 'in';

        // Verificar si ya existe este mensaje
        const exists = await queryOne('SELECT id FROM messages WHERE message_id = ?', [msg.key.id]);
        if (exists) continue;

        // Upsert contacto — no usar teléfono como nombre
        let contact = await findContactByPhone(phone);
        if (!contact) {
          const contactName = msg.pushName || null;
          try {
            const rows = await query(
              `INSERT INTO contacts (phone, name) VALUES (?, ?)
               ON CONFLICT (phone) DO UPDATE SET
                 name = CASE
                   WHEN contacts.name IS NULL OR contacts.name = EXCLUDED.phone THEN EXCLUDED.name
                   ELSE contacts.name
                 END
               RETURNING id, name`,
              [phone, contactName]
            );
            contact = rows[0] || await queryOne('SELECT id, name FROM contacts WHERE phone = ?', [phone]);
          } catch (e) {
            await query('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)', [phone, contactName]);
            contact = await queryOne('SELECT id, name FROM contacts WHERE phone = ?', [phone]);
          }
        } else if (msg.pushName && (!contact.name || contact.name === phone)) {
          await query('UPDATE contacts SET name = ? WHERE id = ?', [msg.pushName, contact.id]);
          contact.name = msg.pushName;
        }

        const senderJidHist = isGroup ? (msg.key.participant || '') : null;
        const senderNameHist = isGroup ? (msg.pushName || null) : null;
        await saveMessage({ message_id: msg.key.id, jid, direction, type, content: text, timestamp, is_auto_reply: 0, sent_by: null, sender_jid: senderJidHist, sender_name: senderNameHist });
        if (isGroup) {
          // Para grupos usar upsertGroup en vez del upsert normal
          let groupName = jid.split('@')[0];
          try { const meta = await getGroupMetadata(jid); if (meta?.subject) groupName = meta.subject; } catch(e) {}
          await query(
            `INSERT INTO conversations (jid, is_group, group_name, last_message, last_message_at)
             VALUES (?, 1, ?, ?, ?)
             ON CONFLICT (jid) DO UPDATE SET
               is_group = 1,
               group_name = COALESCE(EXCLUDED.group_name, conversations.group_name),
               last_message = CASE WHEN EXCLUDED.last_message_at >= conversations.last_message_at THEN EXCLUDED.last_message ELSE conversations.last_message END,
               last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at)`,
            [jid, groupName, text, new Date(timestamp).toISOString()]
          ).catch(() => {});
        } else {
          await upsertConversationHistory(jid, contact?.id, text, new Date(timestamp).toISOString(), direction);
        }
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

  // Actualizar cache de grupos cuando cambian
  sock.ev.on('groups.update', async (updates) => {
    for (const update of updates) {
      if (!update.id) continue;
      _groupCache.delete(update.id); // invalidar cache
      if (update.subject) {
        await query(
          `UPDATE conversations SET group_name = ? WHERE jid = ?`,
          [update.subject, update.id]
        ).catch(() => {});
        if (io) io.emit('group:updated', { jid: update.id, group_name: update.subject });
      }
    }
  });

  // Cuando entramos a un grupo o se actualiza lista
  sock.ev.on('groups.upsert', async (groups) => {
    for (const group of groups) {
      _groupCache.set(group.id, group);
      await query(
        `INSERT INTO conversations (jid, is_group, group_name, last_message_at)
         VALUES (?, 1, ?, NOW())
         ON CONFLICT (jid) DO UPDATE SET is_group = 1, group_name = COALESCE(EXCLUDED.group_name, conversations.group_name)`,
        [group.id, group.subject || group.id.split('@')[0]]
      ).catch(() => {});
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

  // Determinar el JID correcto para enviar.
  // Si 'phone' ya contiene '@' es un JID completo (puede ser @lid, @s.whatsapp.net, @g.us)
  // Si no, normalizar como número argentino → @s.whatsapp.net
  // NUNCA llamar onWhatsApp() — causa "Esperando mensaje" en el destinatario
  // cuando resuelve un @lid y el envío queda en modo pendiente.
  let convJid;
  if (phone.includes('@')) {
    convJid = phone; // ya es JID completo
  } else {
    convJid = normalizeJid(phone);
  }

  await sock.presenceSubscribe(convJid).catch(() => {});
  await sock.sendPresenceUpdate('composing', convJid);
  const typingMs = Math.min(Math.max(text.length * 25, 800), 3500);
  await new Promise(r => setTimeout(r, typingMs));
  await sock.sendPresenceUpdate('paused', convJid);

  const sent = await sock.sendMessage(convJid, { text });

  await saveMessage({
    message_id: sent.key.id,
    jid: convJid, direction: 'out', type: 'text',
    content: text, timestamp: Date.now(),
    is_auto_reply: 0, sent_by: sentBy,
  });

  const existing = await queryOne('SELECT id FROM conversations WHERE jid = ?', [convJid]);
  if (existing) {
    await query(
      `UPDATE conversations SET last_message = ?, last_message_at = NOW(), updated_at = NOW() WHERE jid = ?`,
      [text, convJid]
    );
  } else {
    // Intentar encontrar la conversación por variantes del número
    const phoneOnly = phone.replace(/\D/g,'');
    const altConv = await queryOne(
      `SELECT jid FROM conversations WHERE jid LIKE ? OR jid LIKE ?`,
      [`%${phoneOnly}%`, `%${normalizePhone(phoneOnly)}%`]
    );
    const targetJid = altConv?.jid || convJid;
    await query(
      `INSERT INTO conversations (jid, last_message, last_message_at) VALUES (?, ?, NOW())
       ON CONFLICT (jid) DO UPDATE SET last_message = EXCLUDED.last_message, last_message_at = NOW()`,
      [targetJid, text]
    ).catch(() => {});
  }

  if (io) {
    let sentByName = null, sentByColor = null;
    if (sentBy) {
      const user = await queryOne('SELECT display_name, color FROM users WHERE id = ?', [sentBy]).catch(() => null);
      sentByName = user?.display_name || null;
      sentByColor = user?.color || null;
    }
    io.emit('message:sent', {
      jid: convJid,
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


// ─── Enviar mensaje a grupo ────────────────────────────────────────────────────

async function sendGroupMessage(groupJid, text, sentBy = null) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp no está conectado');
  }
  if (!groupJid.endsWith('@g.us')) throw new Error('JID de grupo inválido');

  // Indicador de escritura en el grupo
  await sock.sendPresenceUpdate('composing', groupJid).catch(() => {});
  const typingMs = Math.min(Math.max(text.length * 20, 600), 2500);
  await new Promise(r => setTimeout(r, typingMs));
  await sock.sendPresenceUpdate('paused', groupJid).catch(() => {});

  const sent = await sock.sendMessage(groupJid, { text });

  // Guardar en DB como mensaje saliente del grupo
  await saveMessage({
    message_id: sent.key.id,
    jid: groupJid,
    direction: 'out',
    type: 'text',
    content: text,
    timestamp: Date.now(),
    is_auto_reply: 0,
    sent_by: sentBy,
    sender_jid: null,
    sender_name: null,
  });

  // Actualizar última conversación del grupo
  await query(
    `UPDATE conversations SET last_message = ?, last_message_at = NOW(), updated_at = NOW() WHERE jid = ?`,
    [text, groupJid]
  ).catch(() => {});

  if (io) {
    let sentByName = null, sentByColor = null;
    if (sentBy) {
      const user = await queryOne('SELECT display_name, color FROM users WHERE id = ?', [sentBy]).catch(() => null);
      sentByName = user?.display_name || null;
      sentByColor = user?.color || null;
    }
    io.emit('message:sent', {
      jid: groupJid,
      is_group: true,
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

module.exports = { connect, setIO, getStatus, getSock, sendMessage, sendGroupMessage, sendFile, logout, normalizePhone, normalizeJid, extractPhone, requestHistoryResync };