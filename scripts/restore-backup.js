#!/usr/bin/env node
/**
 * Restaura un respaldo (.ndjson.gz) generado por WhatsFlow en la base configurada (DATABASE_URL o SQLite local).
 *   node scripts/restore-backup.js <archivo> [--force] [--erasures eliminaciones.json]
 * Sin --force aborta si alguna tabla ya tiene datos. Con --force vacía las tablas antes de importar.
 * La API key de la IA no viaja en el respaldo: volvé a cargarla en Configuración → IA.
 * --erasures: lista de identificadores (Configuración → Privacidad → Registro de eliminaciones) para volver a aplicar
 *   las supresiones hechas DESPUÉS de crearse el respaldo (RGPD, art. 17: un dato borrado no debe reaparecer al restaurar).
 */
require('dotenv').config();
process.env.SKIP_SEED = '1';   // la base destino debe quedar solo con lo del respaldo
const fs = require('fs'), zlib = require('zlib'), readline = require('readline'), path = require('path');
const { initDB, query, queryOne, saveDb, USE_PG } = require('../backend/db');

(async () => {
  const file = process.argv[2], force = process.argv.includes('--force');
  if (!file || !fs.existsSync(file)) { console.error('Uso: node scripts/restore-backup.js <archivo.ndjson.gz> [--force]'); process.exit(1); }
  await initDB();

  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const tables = new Map();   // nombre → filas
  let meta = null, ended = false;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o._meta) meta = o._meta;
    else if (o._table) tables.set(o._table, []);
    else if (o._end) ended = true;
    else if (o.t) tables.get(o.t).push(o.r);
  }
  if (!meta || !ended) { console.error('El archivo está incompleto o no es un respaldo de WhatsFlow.'); process.exit(1); }
  console.log(`Respaldo del ${meta.created_at} (${meta.db}, v${meta.app_version}) · ${tables.size} tablas`);

  for (const [t] of tables) {
    const n = Number((await queryOne(`SELECT COUNT(*) AS n FROM ${t}`).catch(() => ({ n: 0 })))?.n) || 0;
    if (n > 0 && !force) { console.error(`La tabla ${t} ya tiene ${n} filas. Usá --force para reemplazar los datos.`); process.exit(1); }
  }
  if (force) for (const [t] of tables) await query(`DELETE FROM ${t}`);

  for (const [t, rows] of tables) {
    for (const r of rows) {
      const cols = Object.keys(r);
      await query(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => r[c]));
    }
    if (USE_PG && rows.length && 'id' in rows[0]) {
      await query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${t}))`).catch(() => {});
    }
    console.log(`  ${t}: ${rows.length}`);
  }
  // Reaplicar supresiones posteriores al respaldo
  const efIdx = process.argv.indexOf('--erasures');
  if (efIdx > -1) {
    const dsr = require('../backend/dsr'), { phoneVariants } = require('../backend/antiban');
    const raw = JSON.parse(fs.readFileSync(process.argv[efIdx + 1], 'utf8'));
    const wanted = new Set(raw.map(x => (typeof x === 'string' ? x : x.subject_hash)));
    const phones = new Set((await query('SELECT phone FROM contacts')).map(r => r.phone));
    (await query("SELECT jid FROM conversations WHERE jid NOT LIKE '%@g.us'")).forEach(r => phones.add(r.jid.split('@')[0].replace(/\D/g, '')));
    let n = 0;
    for (const p of phones) {
      if (p.length < 7) continue;
      if (phoneVariants(p).some(v => wanted.has(dsr.hash(v)))) { try { await dsr.eraseSubject(p); n++; } catch (e) {} }
    }
    console.log(`Supresiones reaplicadas: ${n}`);
  }
  if (!USE_PG) saveDb();
  console.log('Restauración completa.');
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
