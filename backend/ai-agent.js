/**
 * ai-agent.js v2 — Agente IA con memoria, concurrencia real y optimización de tokens
 *
 * Mejoras sobre v1:
 *  - Cola por JID: cada conversación tiene su propia cola → no se bloquean entre sí
 *  - Sin bloqueo global: múltiples chats se procesan en paralelo
 *  - Memoria comprimida: resumen de la conversación + últimos N mensajes (menos tokens)
 *  - Cache del system prompt: se reconstruye cada 5 min, no en cada mensaje
 *  - Debounce por JID: si llegan 3 mensajes rápido, solo responde al último
 *  - Conteo real de tokens de la API (Groq/OpenAI/Anthropic lo devuelven)
 *  - Handoff a humano: si detecta frustración, pausa la IA y notifica
 *  - Métricas: tokens usados, tiempo de respuesta, errores por JID
 */

'use strict';

const { query, queryOne } = require('./db');

// ─── Cache del system prompt (TTL: 5 min) ─────────────────────────────────────
let _promptCache   = null;
let _promptCacheAt = 0;
const PROMPT_CACHE_TTL = 5 * 60 * 1000;

let _capNotifiedDay = null;

// ─── Cola por JID ─────────────────────────────────────────────────────────────
const _jidState = new Map();

// ─── Métricas ─────────────────────────────────────────────────────────────────
const _metrics = {
  total_calls:       0,
  total_tokens_used: 0,
  errors:            0,
  by_jid:            {},
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getAIConfig() {
  return await queryOne('SELECT * FROM ai_config LIMIT 1');
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function isWorkingHours(config) {
  if (!config.only_outside_hours) return false;
  const { day, minutes: t } = require('./antiban').localNow();   // hora del negocio, no la del servidor
  const days = (config.working_days || '1,2,3,4,5').split(',').map(Number);
  if (!days.includes(day)) return false;
  const [sH, sM] = (config.working_hours_start || '09:00').split(':').map(Number);
  const [eH, eM] = (config.working_hours_end   || '18:00').split(':').map(Number);
  return t >= sH * 60 + sM && t < eH * 60 + eM;
}

// ─── System prompt con cache ──────────────────────────────────────────────────

async function getDocumentContext() {
  try {
    const docs = await query(
      `SELECT name, content FROM ai_documents WHERE is_active = 1 ORDER BY created_at DESC LIMIT 5`
    );
    if (!docs.length) return '';
    return docs.map(d => {
      const content = d.content.length > 3000
        ? d.content.substring(0, 3000) + '\n[...truncado]'
        : d.content;
      return `[${d.name}]\n${content}`;
    }).join('\n\n---\n\n');
  } catch(e) { return ''; }
}

async function buildSystemPrompt(config, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _promptCache && (now - _promptCacheAt) < PROMPT_CACHE_TTL) {
    return _promptCache;
  }
  const lines = [];
  if (config.company_name) {
    lines.push(`Sos el asistente de ${config.company_name}. Respondés por WhatsApp.`);
  }
  lines.push('Respuestas cortas y directas. Sin markdown. Sin asteriscos. Máximo 3 oraciones.');
  lines.push('Si no sabés algo, decí que lo consultan y se comunican pronto.');
  if (config.company_context?.trim()) {
    lines.push('\n[EMPRESA]\n' + config.company_context.trim());
  }
  if (config.system_prompt?.trim()) {
    lines.push('\n[INSTRUCCIONES]\n' + config.system_prompt.trim());
  }
  _promptCache   = lines.join('\n');
  _promptCacheAt = now;
  return _promptCache;
}

// ─── Memoria comprimida ───────────────────────────────────────────────────────

const HISTORY_WINDOW  = 6;
const SUMMARY_TRIGGER = 20;

async function getConversationMemory(jid) {
  const recent = await query(
    `SELECT direction, content FROM messages
     WHERE jid = ? AND content IS NOT NULL AND content != '' AND type IN ('text', 'audioMessage')
     ORDER BY timestamp DESC LIMIT ?`,
    [jid, HISTORY_WINDOW]
  );
  const recentMsgs = recent.reverse().map(m => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.content,
  }));

  const convRow = await queryOne(
    `SELECT ai_summary FROM conversations WHERE jid = ?`, [jid]
  );

  const messages = [];
  if (convRow?.ai_summary) {
    messages.push({ role: 'user',      content: `[Contexto previo: ${convRow.ai_summary}]` });
    messages.push({ role: 'assistant', content: 'Entendido.' });
  }
  messages.push(...recentMsgs);
  return messages;
}

async function maybeUpdateSummary(jid, config) {
  const countRow = await queryOne(
    `SELECT COUNT(*) as n FROM messages WHERE jid = ? AND type = 'text'`, [jid]
  );
  if (Number(countRow?.n || 0) < SUMMARY_TRIGGER) return;

  const convRow = await queryOne(
    `SELECT ai_summary_at FROM conversations WHERE jid = ?`, [jid]
  );
  const lastAt = convRow?.ai_summary_at ? new Date(convRow.ai_summary_at).getTime() : 0;
  if (convRow?.ai_summary && (Date.now() - lastAt) < 30 * 60 * 1000) return;

  try {
    const older = await query(
      `SELECT direction, content FROM messages
       WHERE jid = ? AND type = 'text' AND content IS NOT NULL
       ORDER BY timestamp DESC LIMIT 30 OFFSET ${HISTORY_WINDOW}`,
      [jid]
    );
    if (!older.length) return;
    const conv = older.reverse().map(m =>
      `${m.direction === 'in' ? 'Cliente' : 'Agente'}: ${m.content}`
    ).join('\n');

    const result = await callProvider(
      config,
      [{ role: 'user', content: `Resume en máximo 2 oraciones qué quiere el cliente:\n\n${conv}` }],
      'Sos un asistente que resume conversaciones de WhatsApp de forma muy concisa.',
      'summary'
    );
    const summary = typeof result === 'string' ? result : result?.text;
    if (summary) {
      await query(
        `UPDATE conversations SET ai_summary = ?, ai_summary_at = NOW() WHERE jid = ?`,
        [summary.substring(0, 500), jid]
      ).catch(() => {});
      console.log(`[AI v2] Resumen: ${jid.split('@')[0]} → ${summary.substring(0,60)}...`);
    }
  } catch(e) { /* silencioso */ }
}

// ─── Detección de handoff ────────────────────────────────────────────────────

const HANDOFF_RE = [
  /hablar con (una persona|un humano|un agente|alguien)/i,
  /quiero hablar con/i,
  /me comunicás con/i,
  /esto no (ayuda|sirve)/i,
  /no entend[eé]s/i,
  /inútil/i,
];

function detectsHandoff(text) {
  return HANDOFF_RE.some(p => p.test(text));
}

// ─── Proveedores ─────────────────────────────────────────────────────────────

async function callGemini(config, messages, systemPrompt) {
  const model = config.model || 'gemini-1.5-flash';
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.api_key}`;
  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        maxOutputTokens: config.max_tokens || 300,
        temperature: config.temperature ?? 0.7,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).substring(0,200)}`);
  const d = await res.json();
  return {
    text:       d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null,
    tokensUsed: d.usageMetadata?.totalTokenCount || 0,
  };
}

async function callGroq(config, messages, systemPrompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
    body: JSON.stringify({
      model:       config.model || 'llama-3.1-8b-instant',
      messages:    [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens:  config.max_tokens || 300,
      temperature: config.temperature ?? 0.7,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).substring(0,200)}`);
  const d = await res.json();
  return {
    text:       d.choices?.[0]?.message?.content?.trim() || null,
    tokensUsed: d.usage?.total_tokens || 0,
  };
}

async function callOpenAI(config, messages, systemPrompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
    body: JSON.stringify({
      model:       config.model || 'gpt-4o-mini',
      messages:    [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens:  config.max_tokens || 300,
      temperature: config.temperature ?? 0.7,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).substring(0,200)}`);
  const d = await res.json();
  return {
    text:       d.choices?.[0]?.message?.content?.trim() || null,
    tokensUsed: d.usage?.total_tokens || 0,
  };
}

async function callAnthropic(config, messages, systemPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.api_key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model:      config.model || 'claude-haiku-4-5',
      system:     systemPrompt,
      messages,
      max_tokens: config.max_tokens || 300,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).substring(0,200)}`);
  const d = await res.json();
  return {
    text:       d.content?.[0]?.text?.trim() || null,
    tokensUsed: (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0),
  };
}

// ─── Consumo persistente ──────────────────────────────────────────────────────
// purpose: 'reply' (respuestas), 'summary', 'classify', 'knowledge' (limpieza de URLs)

function todayKey() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: require('./tz').getTZ() }).format(new Date()); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}

async function recordUsage(purpose, provider, model, tokens, isError = false) {
  try {
    const day = todayKey();
    const row = await queryOne('SELECT id FROM ai_usage WHERE day = ? AND purpose = ? AND provider = ? AND model = ?', [day, purpose, provider || '', model || '']);
    if (row) await query('UPDATE ai_usage SET calls = calls + 1, tokens = tokens + ?, errors = errors + ? WHERE id = ?', [tokens || 0, isError ? 1 : 0, row.id]);
    else await query('INSERT INTO ai_usage (day, purpose, provider, model, calls, tokens, errors) VALUES (?, ?, ?, ?, 1, ?, ?)', [day, purpose, provider || '', model || '', tokens || 0, isError ? 1 : 0]);
  } catch (e) { console.error('[AI usage]', e.message); }
}

async function getTokensToday() {
  const r = await queryOne('SELECT COALESCE(SUM(tokens), 0) AS t FROM ai_usage WHERE day = ?', [todayKey()]);
  return Number(r?.t) || 0;
}

async function getLimits() {
  let l = {};
  try { const r = await queryOne("SELECT value FROM settings WHERE key = 'ai_limits'"); if (r?.value) l = JSON.parse(r.value); } catch (e) {}
  return { daily_token_cap: Number(l.daily_token_cap) || 0 };
}

async function saveLimits(patch) {
  const next = { ...(await getLimits()) };
  if (patch.daily_token_cap !== undefined) next.daily_token_cap = Math.max(0, Math.floor(Number(patch.daily_token_cap) || 0));
  const json = JSON.stringify(next);
  const ex = await queryOne("SELECT key FROM settings WHERE key = 'ai_limits'");
  if (ex) await query("UPDATE settings SET value = ? WHERE key = 'ai_limits'", [json]);
  else await query("INSERT INTO settings (key, value) VALUES ('ai_limits', ?)", [json]);
  return next;
}

async function getUsageSummary(days = 30) {
  days = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  const tz = require('./tz').getTZ();
  const sinceKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() - (days - 1) * 86400000));
  const rows = await query('SELECT day, purpose, provider, model, calls, tokens, errors FROM ai_usage WHERE day >= ? ORDER BY day', [sinceKey]);
  const num = (v) => Number(v) || 0;
  const byDay = {}, byPurpose = {}, byModel = {};
  let calls = 0, tokens = 0, errors = 0;
  for (const r of rows) {
    const t = num(r.tokens), c = num(r.calls), e = num(r.errors);
    calls += c; tokens += t; errors += e;
    byDay[r.day] = (byDay[r.day] || 0) + t;
    byPurpose[r.purpose] = byPurpose[r.purpose] || { calls: 0, tokens: 0 }; byPurpose[r.purpose].calls += c; byPurpose[r.purpose].tokens += t;
    const mk = `${r.provider}/${r.model}`; byModel[mk] = byModel[mk] || { calls: 0, tokens: 0 }; byModel[mk].calls += c; byModel[mk].tokens += t;
  }
  const limits = await getLimits();
  const today = byDay[todayKey()] || 0;
  return { days, calls, tokens, errors, today_tokens: today, by_day: byDay, by_purpose: byPurpose, by_model: byModel,
           daily_token_cap: limits.daily_token_cap, cap_reached: limits.daily_token_cap > 0 && today >= limits.daily_token_cap };
}

async function callProvider(config, messages, systemPrompt, purpose = 'reply') {
  if (!config.api_key) throw new Error('API key no configurada');
  let result;
  try {
    switch (config.provider) {
      case 'gemini':    result = await callGemini(config, messages, systemPrompt); break;
      case 'groq':      result = await callGroq(config, messages, systemPrompt); break;
      case 'openai':    result = await callOpenAI(config, messages, systemPrompt); break;
      case 'anthropic': result = await callAnthropic(config, messages, systemPrompt); break;
      default: throw new Error(`Proveedor desconocido: ${config.provider}`);
    }
  } catch (e) {
    await recordUsage(purpose, config.provider, config.model, 0, true);
    throw e;
  }
  await recordUsage(purpose, config.provider, config.model, result?.tokensUsed || 0);
  return result;
}

// ─── Motor interno (corre dentro de la cola por JID) ─────────────────────────

async function _processForJid(jid, text, config, sendMessageFn) {
  const t0       = Date.now();
  const jidShort = jid.split('@')[0]; // solo para logs/métricas

  try {
    // Handoff
    if (detectsHandoff(text)) {
      console.log(`[AI v2] Handoff en ${jidShort}`);
      await query(`UPDATE conversations SET ai_disabled = 1 WHERE jid = ?`, [jid]).catch(() => {});
      // CRÍTICO: pasar el JID COMPLETO (con @lid, @s.whatsapp.net, etc.)
      // NO jidShort — si el contacto usa @lid, enviar al número causa "Esperando mensaje"
      await sendMessageFn(jid, 'Entendido, te comunico con un agente. En breve te atienden.', null);
      // Antes solo se apagaba la IA y nadie se enteraba: ahora se asigna operador y se avisa
      const feats = require('./ai-features');
      await feats.autoAssign(jid, { reason: 'handoff', force: false }).catch(() => {});
      require('./bus').emitEvent('conversation.needs_human', { jid, reason: 'handoff' });
      require('./bus').emitEvent('conversation.updated', { jid });
      return true;
    }

    // Tope diario de tokens: si se alcanzó, la IA no responde y la conversación queda para los operadores
    const limits = await getLimits();
    if (limits.daily_token_cap > 0 && await getTokensToday() >= limits.daily_token_cap) {
      if (_capNotifiedDay !== todayKey()) {
        _capNotifiedDay = todayKey();
        console.warn(`[AI] Tope diario de tokens alcanzado (${limits.daily_token_cap}). La IA deja de responder hasta mañana.`);
        require('./bus').emitEvent('ai.limit_reached', { daily_token_cap: limits.daily_token_cap });
      }
      return false;
    }
    const messages     = await getConversationMemory(jid);
    // Conocimiento relevante al mensaje actual + los 2 anteriores del cliente (el prompt base queda cacheado)
    const recentUser   = messages.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' ');
    const systemPrompt = await require('./knowledge').withKnowledge(await buildSystemPrompt(config), `${text} ${recentUser}`);

    // Asegurar que el último mensaje del usuario está al final
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || last.content !== text) {
      messages.push({ role: 'user', content: text });
    }

    const result      = await callProvider(config, messages, systemPrompt);
    const responseText = result?.text;
    const tokensUsed  = result?.tokensUsed || 0;

    if (!responseText) {
      console.warn(`[AI v2] Respuesta vacía para ${jidShort}`);
      return false;
    }

    // CRÍTICO: pasar JID completo, no solo el número
    await sendMessageFn(jid, responseText, null);

    // Métricas
    const elapsed = Date.now() - t0;
    _metrics.total_calls++;
    _metrics.total_tokens_used += tokensUsed;
    if (!_metrics.by_jid[jidShort]) {
      _metrics.by_jid[jidShort] = { calls: 0, tokens: 0, errors: 0, last_ms: 0 };
    }
    _metrics.by_jid[jidShort].calls++;
    _metrics.by_jid[jidShort].tokens  += tokensUsed;
    _metrics.by_jid[jidShort].last_ms  = elapsed;

    console.log(`[AI v2:${config.provider}] ${jidShort} → "${responseText.substring(0,60)}..." (${tokensUsed}tok, ${elapsed}ms)`);

    // Resumen en background (no bloquea la respuesta)
    setImmediate(() => maybeUpdateSummary(jid, config).catch(() => {}));

    return true;
  } catch(e) {
    _metrics.errors++;
    if (_metrics.by_jid[jidShort]) _metrics.by_jid[jidShort].errors++;
    console.error(`[AI v2] Error ${jidShort}:`, e.message);
    return false;
  }
}

// ─── Cola por JID + debounce ──────────────────────────────────────────────────

const DEBOUNCE_MS = 1200; // si llegan mensajes muy rápido, esperar al último

function getOrCreateJidState(jid) {
  if (!_jidState.has(jid)) {
    _jidState.set(jid, {
      queue:       Promise.resolve(),
      pendingText: null,
      timer:       null,
    });
  }
  return _jidState.get(jid);
}

async function runAIAgent(jid, incomingText, sendMessageFn) {
  try {
    const config = await getAIConfig();
    if (!config?.is_active)  return false;
    if (!config?.api_key)    return false;
    if (config.only_outside_hours && isWorkingHours(config)) return false;

    const conv = await queryOne('SELECT ai_disabled, assigned_to FROM conversations WHERE jid = ?', [jid]);
    if (conv?.ai_disabled) return false;
    // Si un operador humano habló hace poco, la IA no le pisa la conversación
    const human = await queryOne("SELECT MAX(timestamp) AS t FROM messages WHERE jid = ? AND direction = 'out' AND sent_by IS NOT NULL", [jid]);
    if (human?.t && Date.now() - Number(human.t) < 30 * 60000) return false;

    const state = getOrCreateJidState(jid);

    // Debounce: cancelar timer anterior y guardar el texto más reciente
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pendingText = incomingText;

    const dMin  = Math.max(DEBOUNCE_MS, (config.response_delay_min || 2) * 1000);
    const dMax  = Math.max(dMin + 500,  (config.response_delay_max || 6) * 1000);
    const delay = dMin + Math.random() * (dMax - dMin);

    return new Promise((resolve) => {
      state.timer = setTimeout(() => {
        state.timer = null;
        const textToProcess = state.pendingText;
        state.pendingText   = null;

        // Encolar en la cola serial de ESTE JID
        // (otros JIDs tienen su propia cola → paralelo entre chats)
        state.queue = state.queue.then(async () => {
          const ok = await _processForJid(jid, textToProcess, config, sendMessageFn);
          resolve(ok);
          return ok;
        }).catch(e => {
          console.error('[AI v2] Queue error:', e.message);
          resolve(false);
        });
      }, delay);
    });
  } catch(e) {
    console.error('[AI v2] runAIAgent error:', e.message);
    return false;
  }
}

// ─── API pública ─────────────────────────────────────────────────────────────

function getMetrics() {
  return {
    ..._metrics,
    active_queues:     _jidState.size,
    prompt_cached:     !!_promptCache,
    prompt_cache_age_s: _promptCache ? Math.round((Date.now() - _promptCacheAt) / 1000) : null,
    prompt_tokens_est:  estimateTokens(_promptCache || ''),
  };
}

function invalidatePromptCache() {
  _promptCache   = null;
  _promptCacheAt = 0;
}

module.exports = {
  runAIAgent,
  getDocumentContext,
  callProvider,
  getUsageSummary, getLimits, saveLimits, getTokensToday,
  getAIConfig,
  buildSystemPrompt,
  getMetrics,
  invalidatePromptCache,
};