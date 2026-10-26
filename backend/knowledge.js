/**
 * knowledge.js — Base de conocimiento de la IA.
 *
 *  - Ingesta: texto/notas diarias, archivos (PDF/txt/md/csv) y URLs (HTML, PDF, texto).
 *  - Recuperación: en vez de pegar los 5 últimos documentos, se trocean y se eligen los fragmentos
 *    más relevantes para cada mensaje (BM25 simplificado). Los documentos "fijados" van siempre.
 *  - URLs: protección SSRF (IPs privadas, metadata cloud, redirecciones revalidadas), límites de tamaño y tiempo.
 *  - Refresco: una URL puede re-leerse a mano o automáticamente (auto_refresh) cuando cambia su contenido.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const { query, queryOne } = require('./db');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CHARS = 60000;
const FETCH_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 4;

let version = 0;             // sube en cada escritura → invalida el índice en memoria
function touch() { version++; }

// ─── Seguridad de red (SSRF) ──────────────────────────────────────────────────

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4 mapeada (forma con puntos)
    if (m) return isPrivateIp(m[1]);
    const hx = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);   // forma hex que normaliza new URL()
    if (hx) { const n = (parseInt(hx[1], 16) << 16) | parseInt(hx[2], 16); return isPrivateIp([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.')); }
    return false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || a >= 224 ||
    (a === 169 && b === 254) ||               // link-local / metadata cloud
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127);       // CGNAT
}

/** lookup que valida la IP resuelta EN el momento de conectar (evita DNS rebinding) */
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter(a => !isPrivateIp(a.address));
    if (!ok.length) return cb(new Error('Destino no permitido (red privada o local)'));
    if (options && options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('URL inválida'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Solo se admiten URLs http/https');
  if (u.username || u.password) throw new Error('URL con credenciales no permitida');
  const host = u.hostname.replace(/^\[|\]$/g, '');   // IPv6 llega entre corchetes
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('Destino no permitido (red privada o local)');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('Destino no permitido');
  return u;
}

function fetchRaw(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = validateUrl(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: safeLookup,
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WhatsAppCRM-KnowledgeBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'es,en;q=0.8',
      },
    }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('Demasiadas redirecciones'));
        const next = new URL(res.headers.location, u).toString();
        return fetchRaw(next, redirects + 1).then(resolve, reject);
      }
      if (status < 200 || status >= 300) { res.resume(); return reject(new Error(`El sitio respondió HTTP ${status}`)); }

      const ctype = String(res.headers['content-type'] || '').toLowerCase();
      if (!/(text\/|html|xml|json|pdf)/.test(ctype)) { res.resume(); return reject(new Error(`Tipo de contenido no soportado: ${ctype || 'desconocido'}`)); }

      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = []; let total = 0;
      stream.on('data', (c) => {
        total += c.length;
        if (total > MAX_BYTES) { req.destroy(); return reject(new Error('El contenido supera los 3 MB')); }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ buffer: Buffer.concat(chunks), ctype, finalUrl: u.toString() }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Tiempo de espera agotado (${FETCH_TIMEOUT_MS / 1000}s)`)));
    req.on('error', reject);
    req.end();
  });
}

// ─── Extracción de texto ──────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', uuml: 'ü', iquest: '¿', iexcl: '¡', euro: '€', copy: '©', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
  const desc = decodeEntities(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || '');

  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|canvas|template|form|select|button)\b[\s\S]*?<\/\1>/gi, ' ');
  // Preferir el contenido principal si existe
  const main = body.match(/<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i);
  if (main && main[2].length > 400) body = main[2];
  else body = body.replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ');

  body = body
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n) => '\n\n' + '#'.repeat(Math.min(Number(n) + 1, 4)) + ' ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|dd|dt)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');

  let text = decodeEntities(body)
    .replace(/[ \t ]+/g, ' ')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .filter((l, i, arr) => l !== arr[i - 1])            // quita líneas repetidas consecutivas
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  if (desc && !text.includes(desc.slice(0, 40))) text = desc + '\n\n' + text;
  return { title, text };
}

async function extractFromUrl(rawUrl) {
  const { buffer, ctype, finalUrl } = await fetchRaw(rawUrl);
  let title = '', text = '';
  if (ctype.includes('pdf')) {
    const pdfParse = require('pdf-parse');
    text = (await pdfParse(buffer)).text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    title = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || 'documento.pdf');
  } else if (ctype.includes('html') || ctype.includes('xml')) {
    ({ title, text } = htmlToText(buffer.toString('utf8')));
  } else {
    text = buffer.toString('utf8').trim();
  }
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS) + '\n[... contenido truncado ...]';
  const warnings = [];
  if (text.length < 200) warnings.push('Se extrajo muy poco texto: el sitio puede cargar su contenido con JavaScript o requerir login. Pegá el texto manualmente si hace falta.');
  if (truncated) warnings.push('El contenido era muy largo y se truncó.');
  return { title: title || new URL(finalUrl).hostname, text, final_url: finalUrl, chars: text.length, warnings };
}

/** Pide a la IA que destile la página en notas útiles para atender clientes (sin inventar datos). */
async function cleanWithAI(text, title) {
  const ai = await queryOne('SELECT * FROM ai_config LIMIT 1');
  if (!ai?.api_key) throw new Error('Configurá la IA (proveedor y API key) para usar "Limpiar con IA"');
  const { callProvider } = require('./ai-agent');
  const system = 'Sos un editor que prepara base de conocimiento para un asistente de atención al cliente por WhatsApp. No inventes datos.';
  const prompt = `Del siguiente contenido web ("${title}") extraé SOLO la información útil para responder consultas de clientes: servicios, productos, precios, horarios, ubicación, políticas, requisitos, preguntas frecuentes, contacto. Ignorá menús, publicidad, avisos de cookies y texto de navegación.
Reglas: mantené cifras, precios, fechas y nombres EXACTOS como figuran; usá viñetas y títulos cortos; escribí en el idioma original; no agregues nada que no esté en el texto.

CONTENIDO:
${text.slice(0, 14000)}`;
  const out = await callProvider({ ...ai, max_tokens: 1800, temperature: 0.1 }, [{ role: 'user', content: prompt }], system, 'knowledge');
  const cleaned = (typeof out === 'string' ? out : out?.text || '').trim();
  if (cleaned.length < 50) throw new Error('La IA no devolvió contenido útil');
  return cleaned;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const clip = (s, n) => String(s || '').slice(0, n);

async function addDoc({ title, content, category = 'general', source_url = null, auto_refresh = 0, is_pinned = 0, file_type = 'text', userId = null }) {
  content = String(content || '').trim();
  if (!content) throw Object.assign(new Error('El contenido está vacío'), { status: 400 });
  if (content.length > MAX_CHARS) content = content.slice(0, MAX_CHARS) + '\n[... truncado ...]';
  const now = Date.now();
  const rows = await query(
    `INSERT INTO ai_documents (name, content, file_type, size, is_active, category, source_url, auto_refresh, is_pinned, content_hash, created_by, updated_at, last_fetched_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [clip(title, 200) || 'Sin título', content, file_type, content.length, clip(category, 60) || 'general', source_url, auto_refresh ? 1 : 0,
     is_pinned ? 1 : 0, hash(content), userId, now, source_url ? now : null]);
  touch();
  return rows[0]?.id;
}

async function updateDoc(id, { title, content, category, is_pinned, auto_refresh, is_active }) {
  const cur = await queryOne('SELECT * FROM ai_documents WHERE id = ?', [id]);
  if (!cur) throw Object.assign(new Error('No encontrado'), { status: 404 });
  const newContent = content !== undefined ? String(content).slice(0, MAX_CHARS) : cur.content;
  await query(
    `UPDATE ai_documents SET name = ?, content = ?, size = ?, category = ?, is_pinned = ?, auto_refresh = ?, is_active = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
    [title !== undefined ? clip(title, 200) : cur.name, newContent, newContent.length,
     category !== undefined ? clip(category, 60) : cur.category,
     is_pinned !== undefined ? (is_pinned ? 1 : 0) : (cur.is_pinned || 0),
     auto_refresh !== undefined ? (auto_refresh ? 1 : 0) : (cur.auto_refresh || 0),
     is_active !== undefined ? (is_active ? 1 : 0) : cur.is_active,
     hash(newContent), Date.now(), id]);
  touch();
}

async function removeDoc(id) { await query('DELETE FROM ai_documents WHERE id = ?', [id]); touch(); }

async function refreshDoc(id, { aiClean = false } = {}) {
  const d = await queryOne('SELECT * FROM ai_documents WHERE id = ?', [id]);
  if (!d?.source_url) throw Object.assign(new Error('El documento no tiene URL de origen'), { status: 400 });
  const got = await extractFromUrl(d.source_url);
  let text = got.text;
  if (aiClean) text = await cleanWithAI(text, got.title);
  const h = hash(text);
  if (h === d.content_hash) {
    await query('UPDATE ai_documents SET last_fetched_at = ? WHERE id = ?', [Date.now(), id]);
    return { changed: false };
  }
  await query('UPDATE ai_documents SET content = ?, size = ?, content_hash = ?, updated_at = ?, last_fetched_at = ? WHERE id = ?',
    [text, text.length, h, Date.now(), Date.now(), id]);
  touch();
  return { changed: true, chars: text.length };
}

/** Cron diario: re-lee las URLs con auto_refresh que no se actualizaron en 7 días. */
async function refreshDue() {
  const due = await query('SELECT id, name FROM ai_documents WHERE auto_refresh = 1 AND source_url IS NOT NULL AND (last_fetched_at IS NULL OR last_fetched_at < ?)',
    [Date.now() - 7 * 86400000]);
  for (const d of due) {
    try { const r = await refreshDoc(d.id); console.log(`[KB] ${d.name}: ${r.changed ? 'actualizado' : 'sin cambios'}`); }
    catch (e) { console.error(`[KB] refresco falló "${d.name}":`, e.message); }
  }
}

async function listDocs({ search = '', category = '' } = {}) {
  let sql = `SELECT id, name, category, file_type, size, is_active, is_pinned, auto_refresh, source_url, updated_at, last_fetched_at, created_at,
               SUBSTR(content, 1, 220) AS preview FROM ai_documents WHERE 1=1`;
  const p = [];
  if (category) { sql += ' AND category = ?'; p.push(category); }
  if (search) { sql += ' AND (LOWER(name) LIKE ? OR LOWER(content) LIKE ?)'; p.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`); }
  sql += ' ORDER BY is_pinned DESC, COALESCE(updated_at, 0) DESC, id DESC';
  return query(sql, p);
}

// ─── Recuperación (BM25 simplificado) ─────────────────────────────────────────

const STOP = new Set(('el la los las un una unos unas de del al y o u a en con por para que es son era fue ser muy mas más pero como si no ni se su sus lo le les me mi te tu ya hay este esta esto ese esa eso ' +
  'hola buenas buenos dias tardes noches gracias favor quiero quisiera queria necesito saber puedo podria podrian tienen tiene hacer ' +
  'the a an and or of to in on for with is are was be it this that i you we my your do does can how what ' +
  'il lo la le gli di da in con per che è un una e o ma').split(/\s+/));

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function tokenize(s) {
  // Raíz aproximada (primeros 5 caracteres): une ubicación/ubicados, precio/precios, privada/privado
  return norm(s).split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t)).map(t => t.length > 5 ? t.slice(0, 5) : t);
}

let index = null;   // { version, chunks:[{docId,title,text,tf:Map,len}], df:Map, avgLen, pinned:[{title,content}], totalChars }

function chunkText(text, target = 700) {
  const paras = text.split(/\n{2,}|\n(?=#{2,4} )/).map(p => p.trim()).filter(Boolean);
  const out = []; let cur = '';
  for (const p of paras) {
    if ((cur + '\n' + p).length > target && cur) { out.push(cur); cur = p; }
    else cur = cur ? cur + '\n' + p : p;
    while (cur.length > target * 1.8) { out.push(cur.slice(0, target)); cur = cur.slice(target); }
  }
  if (cur) out.push(cur);
  return out;
}

async function buildIndex() {
  if (index && index.version === version) return index;
  const docs = await query('SELECT id, name, content, is_pinned FROM ai_documents WHERE is_active = 1');
  const chunks = [], df = new Map(), pinned = [];
  let totalChars = 0;
  for (const d of docs) {
    totalChars += d.content.length;
    if (Number(d.is_pinned)) { pinned.push({ title: d.name, content: d.content }); continue; }
    for (const text of chunkText(d.content)) {
      const toks = tokenize(d.name + ' ' + text);
      const tf = new Map();
      toks.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      chunks.push({ docId: d.id, title: d.name, text, tf, len: toks.length || 1 });
    }
  }
  const avgLen = chunks.reduce((s, c) => s + c.len, 0) / (chunks.length || 1);
  index = { version, chunks, df, avgLen, pinned, totalChars };
  return index;
}

function score(idx, chunk, qTokens) {
  const N = idx.chunks.length, k1 = 1.4, b = 0.75;
  let s = 0;
  for (const t of qTokens) {
    const f = chunk.tf.get(t);
    if (!f) continue;
    const df = idx.df.get(t) || 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * chunk.len / idx.avgLen));
  }
  return s;
}

/**
 * Devuelve { text, used:[{title,score}] } con lo más relevante para `queryText`.
 * Si toda la base cabe en el presupuesto se incluye completa (sin riesgo de perder contexto).
 */
async function retrieve(queryText, { maxChars = 4500 } = {}) {
  const idx = await buildIndex();
  if (!idx.chunks.length && !idx.pinned.length) return { text: '', used: [] };

  const parts = [], used = [];
  let budget = maxChars;
  for (const p of idx.pinned) {
    const c = p.content.length > 2500 ? p.content.slice(0, 2500) + '\n[...]' : p.content;
    parts.push(`[${p.title}]\n${c}`); used.push({ title: p.title, pinned: true }); budget -= c.length;
  }

  const rest = idx.chunks;
  const restChars = rest.reduce((s, c) => s + c.text.length, 0);
  let chosen;
  if (restChars <= Math.max(budget, 1500)) {
    chosen = rest.map(c => ({ c, s: null }));
  } else {
    const q = tokenize(queryText);
    chosen = rest.map(c => ({ c, s: q.length ? score(idx, c, q) : 0 }))
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  }
  const byDoc = new Map();
  for (const { c, s } of chosen) {
    if (budget <= 0) break;
    if (!byDoc.has(c.title)) byDoc.set(c.title, []);
    byDoc.get(c.title).push(c.text);
    budget -= c.text.length;
    used.push({ title: c.title, score: s == null ? null : Math.round(s * 100) / 100 });
  }
  for (const [title, texts] of byDoc) parts.push(`[${title}]\n${texts.join('\n…\n')}`);
  return { text: parts.join('\n\n---\n\n'), used };
}

/** Agrega el conocimiento relevante al system prompt (por mensaje; el prompt base sigue cacheado). */
async function withKnowledge(systemPrompt, queryText) {
  try {
    const { text } = await retrieve(queryText);
    if (!text) return systemPrompt;
    return `${systemPrompt}\n\n[BASE DE CONOCIMIENTO]\nUsá esta información para responder. Si la respuesta no está acá ni en las instrucciones, no inventes: decí que lo consultan y se comunican.\n${text}`;
  } catch (e) { console.error('[KB]', e.message); return systemPrompt; }
}

module.exports = {
  extractFromUrl, cleanWithAI, addDoc, updateDoc, removeDoc, refreshDoc, refreshDue, listDocs,
  retrieve, withKnowledge, touch, htmlToText, isPrivateIp, validateUrl,
};
