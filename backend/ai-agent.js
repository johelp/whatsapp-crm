/**
 * ai-agent.js — Agente de IA para respuestas automáticas inteligentes
 * Soporta: OpenAI, Anthropic, Groq
 */
const { query, queryOne } = require('./db');

// ─── Obtener config ───────────────────────────────────────────

async function getAIConfig() {
  return await queryOne('SELECT * FROM ai_config LIMIT 1');
}

// ─── Verificar si debe responder ──────────────────────────────

function isWorkingHours(config) {
  if (!config.only_outside_hours) return false; // siempre activo

  const now = new Date();
  const day = now.getDay() || 7; // 1=Lun ... 7=Dom
  const workingDays = (config.working_days || '1,2,3,4,5').split(',').map(Number);

  if (!workingDays.includes(day)) return false; // día no laboral

  const [startH, startM] = (config.working_hours_start || '09:00').split(':').map(Number);
  const [endH, endM]     = (config.working_hours_end   || '18:00').split(':').map(Number);

  const nowMin   = now.getHours() * 60 + now.getMinutes();
  const startMin = startH * 60 + startM;
  const endMin   = endH   * 60 + endM;

  return nowMin >= startMin && nowMin < endMin; // true = horario laboral
}

// ─── Construir system prompt ──────────────────────────────────

function buildSystemPrompt(config) {
  const lines = [];

  lines.push(`Sos el asistente virtual de ${config.company_name || 'la empresa'}.`);
  lines.push('Respondés mensajes de WhatsApp de forma amigable, clara y concisa.');
  lines.push('Nunca uses markdown, asteriscos ni emojis en exceso.');
  lines.push('Si no sabés algo, decí que lo vas a consultar con el equipo.');

  if (config.company_context) {
    lines.push('\n--- INFORMACIÓN DE LA EMPRESA ---');
    lines.push(config.company_context);
  }

  if (config.system_prompt) {
    lines.push('\n--- INSTRUCCIONES ADICIONALES ---');
    lines.push(config.system_prompt);
  }

  return lines.join('\n');
}

// ─── Obtener historial para contexto ─────────────────────────

async function getConversationContext(jid, limit = 10) {
  const msgs = await query(
    'SELECT direction, content FROM messages WHERE jid = ? ORDER BY timestamp DESC LIMIT ?',
    [jid, limit]
  );
  return msgs.reverse().map(m => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.content || '',
  }));
}

// ─── Llamar al proveedor ──────────────────────────────────────

async function callProvider(config, messages, systemPrompt) {
  const provider = config.provider || 'openai';
  const apiKey   = config.api_key;
  const model    = config.model || 'gpt-4o-mini';
  const maxTok   = config.max_tokens || 300;
  const temp     = config.temperature ?? 0.7;

  if (!apiKey) throw new Error('API key no configurada');

  if (provider === 'openai' || provider === 'groq') {
    const baseUrl = provider === 'groq'
      ? 'https://api.groq.com/openai/v1'
      : 'https://api.openai.com/v1';

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        max_tokens: maxTok,
        temperature: temp,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${provider} API error: ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5',
        system: systemPrompt,
        messages,
        max_tokens: maxTok,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error: ${err}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  }

  throw new Error(`Proveedor no soportado: ${provider}`);
}

// ─── Función principal ────────────────────────────────────────

async function runAIAgent(jid, incomingText, sendMessageFn) {
  try {
    const config = await getAIConfig();
    if (!config?.is_active) return false;

    // Si estamos en horario laboral y el config dice solo fuera de horario → no responder
    if (config.only_outside_hours && isWorkingHours(config)) return false;

    const systemPrompt = buildSystemPrompt(config);
    const history      = await getConversationContext(jid, 10);

    // Agregar el mensaje actual si no está en el historial
    const lastMsg = history[history.length - 1];
    if (!lastMsg || lastMsg.content !== incomingText) {
      history.push({ role: 'user', content: incomingText });
    }

    // Delay humanizado
    const delayMin = (config.response_delay_min || 3) * 1000;
    const delayMax = (config.response_delay_max || 8) * 1000;
    const delay    = delayMin + Math.random() * (delayMax - delayMin);
    await new Promise(r => setTimeout(r, delay));

    const response = await callProvider(config, history, systemPrompt);
    if (!response) return false;

    // Enviar respuesta
    const phone = jid.split('@')[0];
    await sendMessageFn(phone, response, null); // sent_by = null = bot IA

    console.log(`[AI] Respondió a ${phone}: ${response.substring(0, 60)}...`);
    return true;

  } catch (e) {
    console.error('[AI] Error en agente IA:', e.message);
    return false;
  }
}

module.exports = { runAIAgent, getAIConfig };