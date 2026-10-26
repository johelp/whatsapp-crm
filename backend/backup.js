/**
 * backup.js — Respaldo lógico de la base (SQLite o PostgreSQL) en NDJSON comprimido (.ndjson.gz).
 *
 *  - Automático una vez por día y a pedido desde Configuración → Administración del sistema.
 *  - Se guarda en BACKUP_DIR (por defecto junto a la sesión de WhatsApp, en el volumen persistente) y se rotan.
 *  - No incluye: sesiones web, bitácora de envíos, entregas de webhooks. La API key de la IA se REDACTA
 *    (al restaurar hay que volver a cargarla): el archivo puede salir del servidor.
 *  - Restaurar: node scripts/restore-backup.js <archivo>
 *  ⚠ Un respaldo en el mismo volumen NO protege contra la pérdida del volumen: descargá copias fuera de Railway.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { query, USE_PG } = require('./db');

const EXCLUDE = new Set(['user_sessions', 'send_log', 'webhook_deliveries']);
const REDACT = { ai_config: ['api_key'] };
const KEEP = Math.max(parseInt(process.env.BACKUP_KEEP, 10) || 7, 1);
const MAX_MB = Math.max(parseInt(process.env.BACKUP_MAX_MB, 10) || 200, 10);
const NAME_RE = /^whatsflow-\d{8}-\d{6}\.ndjson\.gz$/;
const PAGE = 1000;

function backupDir() {
  const dir = process.env.BACKUP_DIR
    || path.join(path.dirname(path.resolve(process.env.WA_AUTH_PATH || path.join(__dirname, '../auth'))), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function listTables() {
  const rows = USE_PG
    ? await query("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'")
    : await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  return rows.map(r => r.name).filter(n => !EXCLUDE.has(n)).sort();
}

const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

async function createBackup() {
  const dir = backupDir();
  const name = `whatsflow-${stamp()}.ndjson.gz`;
  const tmp = path.join(dir, name + '.part');
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);
  const done = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); gz.on('error', rej); });
  const write = (obj) => new Promise((res) => { if (gz.write(JSON.stringify(obj) + '\n')) res(); else gz.once('drain', res); });

  const counts = {};
  try {
    await write({ _meta: { format: 1, created_at: new Date().toISOString(), db: USE_PG ? 'postgres' : 'sqlite', app_version: require('../package.json').version } });
    for (const t of await listTables()) {
      counts[t] = 0;
      await write({ _table: t });
      for (let off = 0; ; off += PAGE) {
        const rows = await query(`SELECT * FROM ${t} ORDER BY 1 LIMIT ${PAGE} OFFSET ${off}`);
        if (!rows.length) break;
        for (const r of rows) {
          for (const col of REDACT[t] || []) if (col in r) r[col] = null;
          await write({ t, r });
          counts[t]++;
        }
        if (rows.length < PAGE) break;
      }
    }
    await write({ _end: true, counts });
    gz.end();
    await done;
    fs.renameSync(tmp, path.join(dir, name));
  } catch (e) {
    try { gz.destroy(); out.destroy(); fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  rotate(dir);
  const size = fs.statSync(path.join(dir, name)).size;
  return { name, size, counts };
}

function rotate(dir) {
  const files = fs.readdirSync(dir).filter(f => NAME_RE.test(f)).map(f => ({ f, st: fs.statSync(path.join(dir, f)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  let total = 0;
  files.forEach(({ f, st }, i) => {
    total += st.size;
    if (i >= KEEP || (total > MAX_MB * 1024 * 1024 && i > 0)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
  });
}

function listBackups() {
  const dir = backupDir();
  return fs.readdirSync(dir).filter(f => NAME_RE.test(f)).map(f => {
    const st = fs.statSync(path.join(dir, f));
    return { name: f, size: st.size, created_at: st.mtime.toISOString() };
  }).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function backupPath(name) {
  if (!NAME_RE.test(String(name))) return null;          // evita rutas arbitrarias
  const p = path.join(backupDir(), name);
  return fs.existsSync(p) ? p : null;
}

function deleteBackup(name) { const p = backupPath(name); if (!p) return false; fs.unlinkSync(p); return true; }

module.exports = { createBackup, listBackups, backupPath, deleteBackup, NAME_RE };
