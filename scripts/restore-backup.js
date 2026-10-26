#!/usr/bin/env node
/**
 * Restaura un respaldo (.ndjson.gz) generado por WhatsFlow en la base configurada (DATABASE_URL o SQLite local).
 *   node scripts/restore-backup.js <archivo> [--force]
 * Sin --force aborta si alguna tabla ya tiene datos. Con --force vacía las tablas antes de importar.
 * La API key de la IA no viaja en el respaldo: volvé a cargarla en Configuración → IA.
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
  if (!USE_PG) saveDb();
  console.log('Restauración completa.');
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
