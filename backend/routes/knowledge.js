/**
 * routes/knowledge.js — Base de conocimiento (cualquier usuario autenticado carga y edita; borrar es de admin)
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { queryOne } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const K = require('../knowledge');

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.use(requireAuth);

const h = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

router.get('/', h(async (req, res) => {
  res.json(await K.listDocs({ search: String(req.query.search || ''), category: String(req.query.category || '') }));
}));

router.get('/:id(\\d+)', h(async (req, res) => {
  const d = await queryOne('SELECT * FROM ai_documents WHERE id = ?', [req.params.id]);
  d ? res.json(d) : res.status(404).json({ error: 'No encontrado' });
}));

// Nota/texto manual (carga diaria)
router.post('/', h(async (req, res) => {
  const { title, content, category, is_pinned } = req.body;
  const id = await K.addDoc({ title, content, category, is_pinned: flag(is_pinned), userId: req.session.user.id });
  res.json({ ok: true, id });
}));

// Archivo PDF / txt / md / csv
router.post('/file', memUpload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
  const isPdf = /pdf/i.test(req.file.mimetype) || /\.pdf$/i.test(req.file.originalname);
  let content;
  if (isPdf) {
    try { content = (await require('pdf-parse')(req.file.buffer)).text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); }
    catch (e) { return res.status(400).json({ error: 'No se pudo leer el PDF: ' + e.message }); }
  } else if (/\.(txt|md|csv|json)$/i.test(req.file.originalname) || /^text\//.test(req.file.mimetype)) {
    content = req.file.buffer.toString('utf8');
  } else return res.status(400).json({ error: 'Formato no soportado (PDF, txt, md, csv)' });
  const id = await K.addDoc({
    title: req.body.title || req.file.originalname, content, category: req.body.category,
    is_pinned: flag(req.body.is_pinned), file_type: isPdf ? 'pdf' : 'text', userId: req.session.user.id,
  });
  res.json({ ok: true, id });
}));

// Analizar una URL sin guardar (para revisar/editar antes)
router.post('/url/preview', h(async (req, res) => {
  const got = await K.extractFromUrl(String(req.body.url || '').trim());
  if (flag(req.body.ai_clean)) { got.raw_chars = got.chars; got.text = await K.cleanWithAI(got.text, got.title); got.chars = got.text.length; got.cleaned = true; }
  res.json(got);
}));

// Analizar y guardar en un paso (o guardar el texto ya revisado: `content`)
router.post('/url', h(async (req, res) => {
  const url = String(req.body.url || '').trim();
  let { content, title } = req.body;
  if (!content) {
    const got = await K.extractFromUrl(url);
    content = flag(req.body.ai_clean) ? await K.cleanWithAI(got.text, got.title) : got.text;
    title = title || got.title;
  }
  const id = await K.addDoc({
    title, content, category: req.body.category, source_url: url, file_type: 'url',
    auto_refresh: flag(req.body.auto_refresh), is_pinned: flag(req.body.is_pinned), userId: req.session.user.id,
  });
  res.json({ ok: true, id });
}));

router.put('/:id(\\d+)', h(async (req, res) => {
  const b = req.body;
  await K.updateDoc(req.params.id, {
    title: b.title, content: b.content, category: b.category,
    is_pinned: b.is_pinned === undefined ? undefined : flag(b.is_pinned),
    auto_refresh: b.auto_refresh === undefined ? undefined : flag(b.auto_refresh),
    is_active: b.is_active === undefined ? undefined : flag(b.is_active),
  });
  res.json({ ok: true });
}));

router.post('/:id(\\d+)/refresh', h(async (req, res) => {
  res.json({ ok: true, ...(await K.refreshDoc(req.params.id, { aiClean: flag(req.body?.ai_clean) })) });
}));

router.delete('/:id(\\d+)', requireAdmin, h(async (req, res) => {
  await K.removeDoc(req.params.id);
  res.json({ ok: true });
}));

// Probar qué fragmentos recuperaría la IA para una pregunta
router.post('/search', h(async (req, res) => {
  res.json(await K.retrieve(String(req.body.q || '')));
}));

module.exports = router;
