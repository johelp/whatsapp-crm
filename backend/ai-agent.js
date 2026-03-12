/**
 * ai-agent.js — Agente IA para WhatsApp CRM
 * Proveedores: gemini (gratis), groq (gratis), openai, anthropic
 * Contexto: texto libre + documentos cargados (ai_documents)
 */
const { query, queryOne } = require('./db');

async function getAIConfig() {
  return await queryOne('SELECT * FROM ai_config LIMIT 1');
}

async function getDocumentContext() {
  try {
    const docs = await query(
      `SELECT name, content FROM ai_documents WHERE is_active = 1 ORDER BY created_at DESC LIMIT 5`
    );
    if (!docs.length) return '';
    return docs.map(d => `[${d.name}]\n${d.content}`).join('\n\n---\n\n');
  } catch(e) { return ''; }
}

function isWorkingHours(config) {
  if (!config.only_outside_hours) return false;
  const now = new Date();
  const day = now.getDay() || 7;
  const workingDays = (config.working_days || '1,2,3,4,5').split(',').map(Number);
  if (!workingDays.includes(day)) return false;
  const [sH, sM] = (config.working_hours_start || '09:00').split(':').map(Number);
  const [eH, eM] = (config.working_hours_end   || '18:00').split(':').map(Number);
  const t = now.getHours() * 60 + now.getMinutes();
  return t >= (sH * 60 + sM) && t < (eH * 60 + eM);
}

async function buildSystemPrompt(config) {
  const lines = [
    `Sos el asistente virtual de ${config.company_name || 'la empresa'}.`,
    'Respondés mensajes de WhatsApp de forma amigable, clara y concisa.',
    'Nunca uses markdown ni asteriscos. Máximo 3 oraciones por respuesta.',
    'Si no sabés algo, decí que lo van a consultar y se comunicarán pronto.',
  ];
  if (config.company_context?.trim()) {
    lines.push('\n--- INFORMACIÓN DE LA EMPRESA ---\n' + config.company_context.trim());
  }
  const docCtx = await getDocumentContext();
  if (docCtx) lines.push('\n--- DOCUMENTOS DE REFERENCIA ---\n' + docCtx);
  if (config.system_prompt?.trim()) {
    lines.push('\n--- INSTRUCCIONES ADICIONALES ---\n' + config.system_prompt.trim());
  }
  return lines.join('\n');
}

async function getConversationContext(jid, limit = 8) {
  const msgs = await query(
    `SELECT direction, content FROM messages
     WHERE jid = ? AND content IS NOT NULL AND content != ''
     ORDER BY timestamp DESC LIMIT ?`,
    [jid, limit]
  );
  return msgs.reverse().map(m => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.content,
  }));
}

// ── Proveedores ──────────────────────────────────────────────

async function callGemini(config, messages, systemPrompt) {
  const model = config.model || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.api_key}`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: config.max_tokens || 300, temperature: config.temperature ?? 0.7 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).substring(0,200)}`);
  const d = await res.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

async function callGroq(config, messages, systemPrompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.api_key}` },
    body: JSON.stringify({
      model: config.model || 'llama3-8b-8192',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: config.max_tokens || 300,
      temperature: config.temperature ?? 0.7,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).substring(0,200)}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content?.trim() || null;
}

async function callOpenAI(config, messages, systemPrompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.api_key}` },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: config.max_tokens || 300,
      temperature: config.temperature ?? 0.7,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).substring(0,200)}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content?.trim() || null;
}

async function callAnthropic(config, messages, systemPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.api_key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: config.model || 'claude-haiku-4-5',
      system: systemPrompt,
      messages,
      max_tokens: config.max_tokens || 300,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).substring(0,200)}`);
  const d = await res.json();
  return d.content?.[0]?.text?.trim() || null;
}

async function callProvider(config, messages, systemPrompt) {
  if (!config.api_key) throw new Error('API key no configurada');
  switch (config.provider) {
    case 'gemini':    return callGemini(config, messages, systemPrompt);
    case 'groq':      return callGroq(config, messages, systemPrompt);
    case 'openai':    return callOpenAI(config, messages, systemPrompt);
    case 'anthropic': return callAnthropic(config, messages, systemPrompt);
    default: throw new Error(`Proveedor desconocido: ${config.provider}`);
  }
}

async function runAIAgent(jid, incomingText, sendMessageFn) {
  try {
    const config = await getAIConfig();
    if (!config?.is_active) return false;
    if (config.only_outside_hours && isWorkingHours(config)) return false;
    const conv = await queryOne('SELECT ai_disabled FROM conversations WHERE jid = ?', [jid]);
    if (conv?.ai_disabled) return false;

    const systemPrompt = await buildSystemPrompt(config);
    const history      = await getConversationContext(jid, 8);
    if (!history.length || history[history.length-1].content !== incomingText) {
      history.push({ role: 'user', content: incomingText });
    }

    const dMin = (config.response_delay_min || 3) * 1000;
    const dMax = (config.response_delay_max || 8) * 1000;
    await new Promise(r => setTimeout(r, dMin + Math.random() * (dMax - dMin)));

    const response = await callProvider(config, history, systemPrompt);
    if (!response) return false;

    await sendMessageFn(jid.split('@')[0], response, null);
    console.log(`[AI:${config.provider}] → ${jid.split('@')[0]}: ${response.substring(0,80)}`);
    return true;
  } catch(e) {
    console.error('[AI Agent] Error:', e.message);
    return false;
  }
}

module.exports = { runAIAgent, getAIConfig };