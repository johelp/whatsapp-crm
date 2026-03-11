/**
 * normalizer.js — Módulo de normalización de números telefónicos
 * Endpoint independiente, no interfiere con el resto del sistema
 * Usa libphonenumber-js para normalización internacional
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const csvParser = require('csv-parser');
const fs = require('fs');
const os = require('os');
const { requireAuth } = require('../middleware/auth');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

// Lazy load para no romper si no está instalado
function getParser() {
  try {
    return require('libphonenumber-js');
  } catch(e) {
    return null;
  }
}

/**
 * Normaliza un número al formato E.164 internacional (+XXXXXXXXXXX)
 * sin el + al inicio (para WhatsApp: XXXXXXXXXXX@s.whatsapp.net)
 */
function normalizeInternational(raw, defaultCountry = 'ES') {
  const lib = getParser();
  if (!lib) return { normalized: raw.replace(/\D/g,''), valid: false, error: 'libphonenumber-js no instalado' };

  const { parsePhoneNumberFromString } = lib;
  const str = String(raw).trim();
  if (!str) return { normalized: '', valid: false, error: 'vacío' };

  // Intentar con el país por defecto
  let parsed = parsePhoneNumberFromString(str, defaultCountry);

  // Si no parseó, intentar sin país (números con + explícito)
  if (!parsed || !parsed.isValid()) {
    parsed = parsePhoneNumberFromString(str);
  }

  if (!parsed || !parsed.isValid()) {
    // Fallback: limpiar y devolver como está
    const clean = str.replace(/\D/g, '');
    return { normalized: clean, valid: false, error: 'no reconocido' };
  }

  // E.164 sin el +
  const e164 = parsed.format('E.164').replace('+', '');
  const country = parsed.country || '?';
  const formatted = parsed.formatInternational();

  return { normalized: e164, valid: true, country, formatted };
}

// ─── Endpoint: normalizar lista pegada manualmente ────────────────────────────

router.post('/normalize/list', requireAuth, (req, res) => {
  const { numbers, defaultCountry = 'ES' } = req.body;
  if (!Array.isArray(numbers)) return res.status(400).json({ error: 'numbers debe ser un array' });

  const results = numbers.map((item, idx) => {
    const raw = typeof item === 'object' ? (item.phone || item.numero || item.telefono || '') : String(item);
    const name = typeof item === 'object' ? (item.name || item.nombre || '') : '';
    const extra = typeof item === 'object' ? (item.extra || '') : '';

    const result = normalizeInternational(raw, defaultCountry);
    return {
      row: idx + 1,
      original: raw,
      name,
      extra,
      ...result,
    };
  });

  const valid = results.filter(r => r.valid);
  const invalid = results.filter(r => !r.valid);

  res.json({ results, summary: { total: results.length, valid: valid.length, invalid: invalid.length } });
});

// ─── Endpoint: normalizar CSV ─────────────────────────────────────────────────

router.post('/normalize/csv', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo' });

  const defaultCountry = req.body.defaultCountry || 'ES';
  const rows = [];

  await new Promise(resolve => {
    fs.createReadStream(req.file.path)
      .pipe(csvParser())
      .on('data', row => rows.push(row))
      .on('end', resolve);
  });

  fs.unlinkSync(req.file.path);

  const results = rows.map((row, idx) => {
    // Detectar columna de teléfono automáticamente
    const phoneKeys = ['phone', 'telefono', 'numero', 'tel', 'mobile', 'celular', 'whatsapp'];
    let rawPhone = '';
    for (const k of phoneKeys) {
      const val = row[k] || row[k.toUpperCase()] || row[k.charAt(0).toUpperCase() + k.slice(1)];
      if (val) { rawPhone = val; break; }
    }
    // Si no encontró columna conocida, usar la primera
    if (!rawPhone) rawPhone = Object.values(row)[0] || '';

    const name = row.name || row.nombre || row.Name || '';
    const extra = row.extra || row.campo || row.Extra || '';

    const result = normalizeInternational(rawPhone, defaultCountry);
    return {
      row: idx + 1,
      original: rawPhone,
      name,
      extra,
      ...result,
    };
  });

  const valid = results.filter(r => r.valid);
  const invalid = results.filter(r => !r.valid);

  res.json({ results, summary: { total: results.length, valid: valid.length, invalid: invalid.length } });
});

// ─── Endpoint: exportar CSV normalizado ──────────────────────────────────────

router.post('/normalize/export', requireAuth, (req, res) => {
  const { results, onlyValid = true } = req.body;
  if (!Array.isArray(results)) return res.status(400).json({ error: 'results requerido' });

  const data = onlyValid ? results.filter(r => r.valid) : results;
  const lines = ['phone,name,extra,country,original'];
  data.forEach(r => {
    lines.push(`${r.normalized},${csvEsc(r.name)},${csvEsc(r.extra)},${r.country||''},${csvEsc(r.original)}`);
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=contactos_normalizados.csv');
  res.send(lines.join('\n'));
});

function csvEsc(str) {
  const s = String(str || '').replace(/"/g, '""');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
}

module.exports = router;
module.exports.normalizeInternational = normalizeInternational;
