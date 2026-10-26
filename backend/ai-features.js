/**
 * ai-features.js — Funciones de IA sobre las conversaciones:
 *   1. Transcripción de audios entrantes (Groq Whisper / OpenAI Whisper / Gemini)
 *   2. Clasificación automática (etiquetas, intención, prioridad, sentimiento, idioma, necesita humano)
 *   3. Asignación automática de operadores (balanceo, por etiqueta, o handoff)
 *
 * Configuración en settings.key = 'ai_features' (JSON). La clasificación usa el proveedor/clave de ai_config.
 */
const { query, queryOne } = require('./db');
const { emitEvent } = require('./bus');

const DEFAULTS = {
  transcribe: 0,
  transcribe_provider: 'groq',          // groq | openai | gemini
  transcribe_api_key: '',               // si vacío y coincide con el proveedor del chat, usa la clave de ai_config
  transcribe_model: '',                 // vacío = modelo por defecto del proveedor
  transcribe_language: 'es',
  max_audio_seconds: 180,
  classify: 0,
  classify_cooldown_min: 10,            // no reclasificar la misma conversación antes de N min
  auto_assign: 'off',                   // off | least_busy | round_robin
  assign_only_online: 0,
  routing: {},                          // { "Presupuesto": 3 }  etiqueta → id de usuario
};

let cache = null, cacheAt = 0;

async function getFeatures(force = false) {
  if (!force && cache && Date.now() - cacheAt < 15000) return cache;
  let stored = {};
  try {
    const r = await queryOne("SELECT value FROM settings WHERE key = 'ai_features'");
    if (r?.value) stored = JSON.parse(r.value);
  } catch (e) {}
  cache = { ...DEFAULTS, ...stored }; cacheAt = Date.now();
  return cache;
}

async function saveFeatures(patch) {
  const cur = await getFeatures(true);
  const next = { ...cur };
  for (const k of Object.keys(DEFAULTS)) {
    if (patch[k] === undefined) continue;
    if (k === 'transcribe_api_key' && !patch[k]) continue;   // vacío = conservar la actual
    next[k] = patch[k];
  }
  const json = JSON.stringify(next);
  const ex = await queryOne("SELECT key FROM settings WHERE key = 'ai_features'");
  if (ex) await query("UPDATE settings SET value = ? WHERE key = 'ai_features'", [json]);
  else await query("INSERT INTO settings (key, value) VALUES ('ai_features', ?)", [json]);
  cache = next; cacheAt = Date.now();
  return publicFeatures(next);
}

function publicFeatures(f) {
  const { transcribe_api_key, ...rest } = f;
  return { ...rest, transcribe_api_key_set: !!transcribe_api_key };
}

// ─── 1. Transcripción ─────────────────────────────────────────────────────────

async function resolveTranscribeKey(f) {
  if (f.transcribe_api_key) return f.transcribe_api_key;
  const ai = await queryOne('SELECT provider, api_key FROM ai_config LIMIT 1');
  if (ai?.api_key && ai.provider === f.transcribe_provider) return ai.api_key;
  return null;
}

async function transcribeAudio(buffer, mime = 'audio/ogg') {
  const f = await getFeatures();
  const key = await resolveTranscribeKey(f);
  if (!key) throw new Error('Sin API key para transcripción');
  const lang = f.transcribe_language || undefined;

  if (f.transcribe_provider === 'gemini') {
    const model = f.transcribe_model || 'gemini-2.0-flash';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [
        { text: 'Transcribí literalmente este audio. Devolvé solo el texto, sin comentarios.' },
        { inline_data: { mime_type: mime.split(';')[0], data: buffer.toString('base64') } },
      ] }] }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const d = await res.json();
    return (d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  }

  // Groq y OpenAI comparten la API /audio/transcriptions (Whisper)
  const isGroq = f.transcribe_provider === 'groq';
  const url = isGroq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
  const model = f.transcribe_model || (isGroq ? 'whisper-large-v3-turbo' : 'whisper-1');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime.split(';')[0] }), 'audio.ogg');
  form.append('model', model);
  if (lang) form.append('language', lang);
  form.append('response_format', 'json');
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`${isGroq ? 'Groq' : 'OpenAI'} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return ((await res.json()).text || '').trim();
}

// ─── 2. Clasificación ─────────────────────────────────────────────────────────

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const SENTIMENTS = ['positive', 'neutral', 'negative'];
const PROTECTED_LABELS = ['no contactar'];     // la IA nunca aplica estas
const classifying = new Set();

async function classifyConversation(jid, { force = false } = {}) {
  const f = await getFeatures();
  if (!f.classify && !force) return null;
  if (classifying.has(jid)) return null;
  classifying.add(jid);
  try {
    const conv = await queryOne('SELECT * FROM conversations WHERE jid = ?', [jid]);
    if (!conv) return null;
    if (!force && conv.ai_classified_at && Date.now() - Number(conv.ai_classified_at) < f.classify_cooldown_min * 60000) return null;

    const ai = await queryOne('SELECT * FROM ai_config LIMIT 1');
    if (!ai?.api_key) return null;

    const msgs = await query(
      `SELECT direction, content FROM messages WHERE jid = ? AND content IS NOT NULL AND content != ''
       ORDER BY timestamp DESC LIMIT 10`, [jid]);
    if (!msgs.length) return null;
    const transcript = msgs.reverse().map(m => `${m.direction === 'in' ? 'Cliente' : 'Empresa'}: ${m.content}`).join('\n');

    const labels = (await query('SELECT id, name, description FROM labels'))
      .filter(l => !PROTECTED_LABELS.includes(String(l.name).toLowerCase()));

    const system = 'Sos un clasificador de conversaciones de atención al cliente por WhatsApp. Respondés SOLO con JSON válido, sin texto extra.';
    const prompt = `Etiquetas disponibles (usá solo estas, 0 a 3):
${labels.map(l => `- ${l.name}${l.description ? ': ' + l.description : ''}`).join('\n')}

Conversación:
${transcript}

Devolvé JSON con esta forma exacta:
{"labels":["..."],"intent":"frase corta de qué quiere el cliente","priority":"low|normal|high|urgent","sentiment":"positive|neutral|negative","language":"código ISO 639-1","needs_human":true|false}`;

    const { callProvider } = require('./ai-agent');
    const out = await callProvider({ ...ai, max_tokens: 250, temperature: 0.1 }, [{ role: 'user', content: prompt }], system, 'classify');
    const raw = (typeof out === 'string' ? out : out?.text) || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('respuesta sin JSON');
    const r = JSON.parse(m[0]);

    const priority = PRIORITIES.includes(r.priority) ? r.priority : 'normal';
    const sentiment = SENTIMENTS.includes(r.sentiment) ? r.sentiment : 'neutral';
    await query(
      'UPDATE conversations SET ai_intent = ?, ai_priority = ?, ai_sentiment = ?, ai_lang = ?, ai_classified_at = ? WHERE jid = ?',
      [String(r.intent || '').slice(0, 200), priority, sentiment, String(r.language || '').slice(0, 5), Date.now(), jid]);

    const applied = [];
    for (const name of [].concat(r.labels || [])) {
      const lab = labels.find(l => String(l.name).toLowerCase() === String(name).toLowerCase());
      if (!lab) continue;     // ignorar etiquetas inventadas
      await query('INSERT OR IGNORE INTO conversation_labels (conversation_id, label_id) VALUES (?, ?)', [conv.id, lab.id]);
      applied.push(lab.name);
    }

    const result = { jid, labels: applied, intent: r.intent, priority, sentiment, language: r.language, needs_human: !!r.needs_human };
    emitEvent('conversation.classified', result);
    emitEvent('conversation.updated', { jid });

    // Asignar si hace falta (usa la primera etiqueta para el ruteo por etiqueta)
    if (!conv.assigned_to) await autoAssign(jid, { labels: applied, reason: 'classified' });
    if (r.needs_human && !conv.ai_disabled) {
      await query('UPDATE conversations SET ai_disabled = 1 WHERE jid = ?', [jid]).catch(() => {});
      emitEvent('conversation.needs_human', result);
    }
    return result;
  } catch (e) {
    console.error('[AI classify]', jid.split('@')[0], e.message);
    return null;
  } finally { classifying.delete(jid); }
}

const classifyTimers = new Map();
/** Agrupa ráfagas de mensajes: clasifica 15 s después del último */
function scheduleClassify(jid) {
  clearTimeout(classifyTimers.get(jid));
  classifyTimers.set(jid, setTimeout(() => { classifyTimers.delete(jid); classifyConversation(jid).catch(() => {}); }, 15000));
}

// ─── 3. Asignación de operadores ──────────────────────────────────────────────

async function pickOperator(f, labels = []) {
  // 1) ruteo por etiqueta
  for (const l of labels) {
    const uid = f.routing?.[l];
    if (uid) {
      const u = await queryOne('SELECT id FROM users WHERE id = ? AND is_active = 1', [uid]);
      if (u) return u.id;
    }
  }
  // 2) candidatos: agentes activos (si no hay, cualquier usuario activo)
  let users = await query("SELECT id FROM users WHERE is_active = 1 AND role != 'admin'");
  if (!users.length) users = await query('SELECT id FROM users WHERE is_active = 1');
  if (f.assign_only_online) {
    const online = require('./online').getOnlineIds();
    const filtered = users.filter(u => online.has(u.id));
    if (filtered.length) users = filtered;
  }
  if (!users.length) return null;

  if (f.auto_assign === 'round_robin') {
    const last = await queryOne("SELECT value FROM settings WHERE key = 'rr_last_user'");
    const ids = users.map(u => u.id).sort((a, b) => a - b);
    const next = ids.find(id => id > Number(last?.value || 0)) ?? ids[0];
    const ex = await queryOne("SELECT key FROM settings WHERE key = 'rr_last_user'");
    if (ex) await query("UPDATE settings SET value = ? WHERE key = 'rr_last_user'", [String(next)]);
    else await query("INSERT INTO settings (key, value) VALUES ('rr_last_user', ?)", [String(next)]);
    return next;
  }
  // least_busy: menos conversaciones abiertas asignadas
  let best = null, bestN = Infinity;
  for (const u of users) {
    const n = Number((await queryOne("SELECT COUNT(*) AS n FROM conversations WHERE assigned_to = ? AND status = 'open'", [u.id]))?.n) || 0;
    if (n < bestN) { best = u.id; bestN = n; }
  }
  return best;
}

async function autoAssign(jid, { labels = [], reason = 'auto', force = false } = {}) {
  const f = await getFeatures();
  if (f.auto_assign === 'off' && !force) return null;
  const conv = await queryOne('SELECT assigned_to FROM conversations WHERE jid = ?', [jid]);
  if (!conv || (conv.assigned_to && !force)) return null;
  if (jid.endsWith('@g.us')) return null;   // grupos no se asignan automáticamente

  const uid = await pickOperator(f.auto_assign === 'off' ? { ...f, auto_assign: 'least_busy' } : f, labels);
  if (!uid) return null;
  await query("UPDATE conversations SET assigned_to = ?, updated_at = datetime('now') WHERE jid = ?", [uid, jid]);
  const u = await queryOne('SELECT id, display_name FROM users WHERE id = ?', [uid]);
  await query('INSERT INTO activity_log (user_id, action, target_jid, detail) VALUES (?, ?, ?, ?)',
    [uid, 'auto_assigned', jid, JSON.stringify({ reason, labels })]).catch(() => {});
  emitEvent('conversation.assigned', { jid, user_id: uid, user_name: u?.display_name, reason });
  emitEvent('conversation.updated', { jid });
  return uid;
}

module.exports = {
  getFeatures, saveFeatures, publicFeatures, transcribeAudio, classifyConversation, scheduleClassify, autoAssign, DEFAULTS,
};
