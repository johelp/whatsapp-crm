#!/usr/bin/env node
/**
 * Prueba de humo de una instalación de WhatsFlow (sin dependencias, Node 18+).
 *
 *   SMOKE_URL=https://tu-instalacion SMOKE_USER=admin SMOKE_PASS=*** node scripts/smoke.js
 *
 * Opcional: SMOKE_TO=<tu número o grupo> para además encolar y cancelar un aviso real de prueba
 * (se cancela de inmediato; si WhatsApp está conectado y el worker lo toma antes, SÍ llegará un mensaje de prueba).
 *
 * Todo lo que crea (API key, nota, entrada de conocimiento, webhook) se elimina al final.
 * Termina con código 0 si todo pasó, 1 si algo falló.
 */
const BASE = (process.env.SMOKE_URL || '').replace(/\/$/, '');
const USER = process.env.SMOKE_USER, PASS = process.env.SMOKE_PASS, TO = process.env.SMOKE_TO;
if (!BASE || !USER || !PASS) { console.error('Faltan SMOKE_URL, SMOKE_USER y SMOKE_PASS'); process.exit(2); }

let cookie = '', fails = 0;
const log = (ok, name, extra = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); };

async function http(method, path, { body, key, session = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session && cookie) headers.Cookie = cookie;
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
const step = async (name, fn) => { try { await fn(); } catch (e) { log(false, name, e.message); } };

(async () => {
  console.log(`Prueba de humo → ${BASE}\n`);
  let apiKeyId = null, apiKey = null, noteId = null, kbId = null, hookId = null;
  const jid = `smoke-${Date.now()}@s.whatsapp.net`;

  await step('health', async () => { const r = await http('GET', '/health'); log(r.status === 200 && r.json?.db === true, 'GET /health', `db=${r.json?.db} whatsapp=${r.json?.whatsapp}`); });
  await step('login incorrecto', async () => { const r = await http('POST', '/api/auth/login', { body: { username: USER, password: PASS + 'x' }, session: false }); log(r.status === 401, 'login con clave incorrecta rechazado', `HTTP ${r.status}`); cookie = ''; });
  await step('login', async () => { const r = await http('POST', '/api/auth/login', { body: { username: USER, password: PASS } }); log(r.status === 200 && r.json?.ok, 'login correcto', `HTTP ${r.status}`);
    if (r.status !== 200) {
      console.error(`\n⛔ No se pudo iniciar sesión (HTTP ${r.status}). Revisá SMOKE_USER y SMOKE_PASS: usá la contraseña real del admin, no un marcador como ***.${r.status === 429 ? ' (Demasiados intentos: esperá ~10 minutos.)' : ''}`);
      process.exit(1);
    } });
  await step('sesión', async () => { const r = await http('GET', '/api/auth/me'); log(r.status === 200 && r.json?.role, 'sesión activa', `rol=${r.json?.role}`); });
  await step('api sin sesión', async () => { const r = await http('GET', '/api/wa/status', { session: false }); log(r.status === 401, 'API protegida sin sesión', `HTTP ${r.status}`); });

  await step('conversaciones', async () => { const r = await http('GET', '/api/conversations'); log(r.status === 200 && Array.isArray(r.json), 'lista de conversaciones', `${r.json?.length ?? '?'} chats`); });
  await step('notas', async () => {
    const c = await http('POST', `/api/conversations/${encodeURIComponent(jid)}/notes`, { body: { text: 'nota de prueba de humo', pinned: true } });
    noteId = c.json?.id; log(c.status === 200 && noteId, 'crear nota interna');
    const l = await http('GET', `/api/conversations/${encodeURIComponent(jid)}/notes`); log(l.json?.length === 1 && l.json[0].pinned, 'listar nota fijada');
  });
  await step('conocimiento', async () => {
    const c = await http('POST', '/api/knowledge', { body: { title: 'Prueba de humo', content: 'El horario de prueba es de 9 a 18.', category: 'smoke' } });
    kbId = c.json?.id; log(c.status === 200 && kbId, 'agregar a la base de conocimiento');
    const s = await http('POST', '/api/knowledge/search', { body: { q: 'horario de prueba' } }); log(/9 a 18/.test(s.json?.text || ''), 'búsqueda de conocimiento');
    const u = await http('POST', '/api/knowledge/url/preview', { body: { url: 'http://127.0.0.1:1/' } }); log(u.status >= 400, 'bloquea URLs internas (SSRF)', `HTTP ${u.status}`);
  });
  await step('ia', async () => { const r = await http('GET', '/api/ai/usage'); log(r.status === 200 && r.json?.ok, 'consumo de IA', `tokens 30d=${r.json?.tokens}`); });
  await step('privacidad', async () => {
    const s = await http('GET', '/api/privacy/settings'); log(s.status === 200 && s.json?.ai_disclosure_text, 'ajustes de privacidad', `aviso de IA ${s.json?.ai_disclosure_enabled ? 'activo' : 'APAGADO'}, retención ${s.json?.retention_days} días`);
    const f = await http('GET', '/api/privacy/subject?q=' + encodeURIComponent('+0000000000000')); log(f.status === 200 && f.json?.found === false, 'búsqueda de un titular inexistente');
    const e = await http('POST', '/api/privacy/erase', { body: { q: '+0000000000000', confirm: 'otro' } }); log(e.status === 400, 'borrado exige confirmación del teléfono', `HTTP ${e.status}`);
    const rt = await http('GET', '/api/privacy/retention/preview'); log(rt.status === 200 && rt.json?.ok, 'vista previa de retención');
  });
  await step('anti-ban', async () => { const r = await http('GET', '/api/integrations/antiban'); log(r.status === 200 && r.json?.timezone, 'estado anti-bloqueo', `zona=${r.json?.timezone} pausado=${r.json?.paused}`); });

  await step('api key', async () => {
    const k = await http('POST', '/api/integrations/keys', { body: { name: 'smoke-test' } });
    apiKey = k.json?.key; apiKeyId = k.json?.id; log(k.status === 200 && /^wak_/.test(apiKey || ''), 'crear API key');
    const st = await http('GET', '/api/v1/status', { key: apiKey, session: false }); log(st.status === 200 && st.json?.whatsapp, 'GET /api/v1/status con API key', `whatsapp=${st.json?.whatsapp}`);
    const bad = await http('GET', '/api/v1/status', { key: 'wak_invalida', session: false }); log(bad.status === 401, 'API key inválida rechazada');
    const inv = await http('POST', '/api/v1/notify', { key: apiKey, session: false, body: { event: 'x', to: 'no-es-un-numero', text: 'hola' } }); log(inv.status === 400, 'destinatario inválido → 400', `HTTP ${inv.status}`);
    if (TO) {
      const n = await http('POST', '/api/v1/notify', { key: apiKey, session: false, body: { to: TO, text: 'Prueba de humo de WhatsFlow {{data.n}}', data: { n: 1 } } });
      const qid = n.json?.queued?.[0]?.id; log(n.status === 202 && qid, 'POST /api/v1/notify encola el aviso', `id=${qid}`);
      if (qid) { const c = await http('POST', `/api/integrations/queue/${qid}/cancel`); log(c.status === 200, 'cancelar el aviso de prueba'); }
    } else console.log('⏭  notify real omitido (definí SMOKE_TO para probarlo)');
  });
  await step('webhook', async () => {
    const w = await http('POST', '/api/integrations/webhooks', { body: { name: 'smoke', url: 'https://example.invalid/hook', events: ['webhook.test'] } });
    hookId = w.json?.id; log(w.status === 200 && /^whsec_/.test(w.json?.secret || ''), 'crear webhook con secreto');
  });
  await step('respaldos', async () => {
    const b = await http('POST', '/api/system/backups'); log(b.status === 200 && b.json?.name, 'crear respaldo de la base', b.json?.name);
    const l = await http('GET', '/api/system/backups'); log(l.json?.backups?.length >= 1, 'listar respaldos');
    if (b.json?.name) await http('DELETE', `/api/system/backups/${encodeURIComponent(b.json.name)}`);
  });

  // Limpieza
  if (noteId) await http('DELETE', `/api/notes/${noteId}`);
  if (kbId) await http('DELETE', `/api/knowledge/${kbId}`);
  if (apiKeyId) await http('DELETE', `/api/integrations/keys/${apiKeyId}`);
  if (hookId) await http('DELETE', `/api/integrations/webhooks/${hookId}`);
  await http('POST', '/api/auth/logout');

  console.log(`\n${fails ? '❌ ' + fails + ' prueba(s) fallaron' : '✅ Todo OK'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('Error fatal:', e.message); process.exit(1); });
