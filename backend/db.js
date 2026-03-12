/**
 * db.js — Capa de base de datos
 * LOCAL:      sql.js (SQLite WebAssembly — sin compilacion, sin Visual Studio)
 * PRODUCCION: PostgreSQL (Railway)
 */
const path = require('path');
const fs   = require('fs');

const USE_PG = !!process.env.DATABASE_URL;

// SQLite en memoria (sql.js)
let sqliteDb = null;
const DB_PATH = path.join(__dirname, '../data/crm.db');

// PostgreSQL
let pgPool;
if (USE_PG) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── Persistencia sql.js (trabaja en memoria, guardamos a disco) ──────────────

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveDb() {
  if (!sqliteDb || USE_PG) return;
  try {
    const data = sqliteDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('Error guardando DB:', e.message);
  }
}

function startAutoSave() {
  setInterval(saveDb, 15000); // guardar cada 15 segundos
  process.on('exit', saveDb);
  process.on('SIGINT', () => { saveDb(); process.exit(0); });
  process.on('SIGTERM', () => { saveDb(); process.exit(0); });
}

// ─── Query adapter ────────────────────────────────────────────────────────────

async function query(sql, params = []) {
  if (USE_PG) {
    let i = 0;
    let pgSql = sql
      .replace(/\?/g, () => `$${++i}`)
      .replace(/AUTOINCREMENT/gi, '')
      .replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()')
      .replace(/datetime\s*\(\s*"now"\s*\)/gi, 'NOW()')
      .replace(/DEFAULT\s+\(datetime\s*\(\s*'now'\s*\)\)/gi, 'DEFAULT NOW()')
      .replace(/strftime\s*\([^)]+\)/gi, 'NOW()');

    // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(pgSql)) {
      pgSql = pgSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
      if (!/ON\s+CONFLICT/i.test(pgSql)) {
        pgSql = pgSql.trimEnd().replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
      }
    }

    const result = await pgPool.query(pgSql, params);
    return result.rows;
  }

  // sql.js
  if (!sqliteDb) throw new Error('DB no inicializada');
  const trimmed = sql.trim().toUpperCase();
  const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');

  try {
    if (isSelect) {
      const result = sqliteDb.exec(sql, params);
      if (!result.length) return [];
      const { columns, values } = result[0];
      return values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
      });
    } else {
      // Quitar clausulas no soportadas
      let cleanSql = sql
        .replace(/ON CONFLICT\s*\(\w+\)\s*DO NOTHING/gi, 'OR IGNORE INTO'.includes('INSERT') ? '' : '')
        .replace(/RETURNING\s+\*/gi, '')
        .replace(/RETURNING\s+\w+/gi, '');

      // Manejar ON CONFLICT ... DO UPDATE (UPSERT)
      if (/ON CONFLICT.*DO UPDATE/i.test(cleanSql)) {
        // sql.js soporta INSERT OR REPLACE
        cleanSql = cleanSql.replace(/INSERT INTO/, 'INSERT OR REPLACE INTO')
          .replace(/ON CONFLICT\s*\([^)]+\)\s*DO UPDATE SET[\s\S]*/i, '');
      }

      // ON CONFLICT DO NOTHING
      if (/ON CONFLICT.*DO NOTHING/i.test(cleanSql)) {
        cleanSql = cleanSql.replace(/INSERT INTO/, 'INSERT OR IGNORE INTO')
          .replace(/ON CONFLICT[^;]*/i, '');
      }

      sqliteDb.run(cleanSql.trim(), params);
      const lastId = sqliteDb.exec('SELECT last_insert_rowid() as id')[0]?.values[0][0] || null;
      return [{ id: lastId, lastInsertRowid: lastId, changes: 1 }];
    }
  } catch (e) {
    console.error('SQL Error:', e.message);
    console.error('SQL:', sql.substring(0, 300));
    throw e;
  }
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function execute(sql) {
  if (USE_PG) {
    // Transformar SQLite → PostgreSQL
    const pgSql = sql
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
      .replace(/DEFAULT\s+\(datetime\s*\(\s*'now'\s*\)\)/gi, 'DEFAULT NOW()')
      .replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()')
      .replace(/TEXT DEFAULT \(datetime/gi, 'TIMESTAMPTZ DEFAULT (NOW')
      .replace(/\bTEXT\b(?=\s+DEFAULT NOW\(\))/gi, 'TIMESTAMPTZ');

    const stmts = pgSql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of stmts) {
      await pgPool.query(stmt).catch(e => {
        if (!e.message.includes('already exists')) throw e;
      });
    }
    return;
  }
  // sql.js: ejecutar statement por statement
  const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of stmts) {
    try { sqliteDb.run(stmt); } catch (e) { /* ignorar "table already exists" */ }
  }
}

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

async function createTables() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'agent',
      color TEXT DEFAULT '#6366f1',
      is_active INTEGER DEFAULT 1,
      last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      company TEXT,
      extra TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#6366f1',
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS contact_labels (
      contact_id INTEGER,
      label_id INTEGER,
      assigned_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (contact_id, label_id)
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT UNIQUE NOT NULL,
      contact_id INTEGER,
      wa_push_name TEXT,
      status TEXT DEFAULT 'open',
      assigned_to INTEGER,
      unread_count INTEGER DEFAULT 0,
      last_message TEXT,
      last_message_at TEXT,
      bot_state TEXT DEFAULT 'idle',
      bot_collected TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS conversation_labels (
      conversation_id INTEGER,
      label_id INTEGER,
      assigned_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, label_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      jid TEXT NOT NULL,
      direction TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      content TEXT,
      timestamp BIGINT,
      is_read INTEGER DEFAULT 0,
      is_auto_reply INTEGER DEFAULT 0,
      sent_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'general',
      template TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      total INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      delay_min INTEGER DEFAULT 8,
      delay_max INTEGER DEFAULT 25,
      created_by INTEGER,
      scheduled_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS campaign_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      contact_id INTEGER,
      phone TEXT NOT NULL,
      name TEXT,
      extra_field TEXT,
      status TEXT DEFAULT 'pending',
      sent_at TEXT,
      error TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS quick_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trigger_text TEXT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      use_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS auto_reply_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      is_active INTEGER DEFAULT 0,
      schedule_start TEXT DEFAULT '09:00',
      schedule_end TEXT DEFAULT '18:00',
      working_days TEXT DEFAULT '1,2,3,4,5',
      greeting_message TEXT,
      collect_fields TEXT DEFAULT '["name","email","phone","reason"]',
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      target_jid TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS file_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      category TEXT DEFAULT 'general',
      uploaded_by INTEGER,
      use_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS ai_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      is_active INTEGER DEFAULT 0,
      provider TEXT DEFAULT 'openai',
      api_key TEXT,
      model TEXT DEFAULT 'gpt-4o-mini',
      system_prompt TEXT,
      company_name TEXT,
      company_context TEXT,
      response_delay_min INTEGER DEFAULT 3,
      response_delay_max INTEGER DEFAULT 8,
      max_tokens INTEGER DEFAULT 300,
      temperature REAL DEFAULT 0.7,
      only_outside_hours INTEGER DEFAULT 1,
      working_hours_start TEXT DEFAULT '09:00',
      working_hours_end TEXT DEFAULT '18:00',
      working_days TEXT DEFAULT '1,2,3,4,5',
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  for (const stmt of tables) {
    if (USE_PG) {
      const pgStmt = stmt
        .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
        .replace(/TEXT DEFAULT \(datetime\('now'\)\)/g, "TIMESTAMP DEFAULT NOW()")
        .replace(/datetime\('now'\)/g, "NOW()");
      await pgPool.query(pgStmt).catch(e => {
        if (!e.message.includes('already exists')) throw e;
      });
    } else {
      try { sqliteDb.run(stmt); } catch (e) { /* ya existe */ }
    }
  }
}

// ─── SEED DATA ────────────────────────────────────────────────────────────────

async function seedData() {
  const existing = await queryOne('SELECT id FROM users LIMIT 1');
  if (existing) return;

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('admin123', 10);

  await query(
    'INSERT INTO users (username, display_name, password_hash, role, color) VALUES (?, ?, ?, ?, ?)',
    ['admin', 'Administrador', hash, 'admin', '#16a34a']
  );

  const defaultLabels = [
    ['Consulta',        '#3b82f6', 'Consulta general'],
    ['Presupuesto',     '#f59e0b', 'Solicitud de presupuesto'],
    ['Inscripcion',     '#10b981', 'Proceso de inscripcion'],
    ['Alquiler equipo', '#8b5cf6', 'Alquiler de equipo'],
    ['Clase privada',   '#f97316', 'Clase privada solicitada'],
    ['No contactar',    '#ef4444', 'No volver a contactar'],
    ['Resena solicitada','#06b6d4','Se pidio resena'],
    ['Seguimiento',     '#84cc16', 'Pendiente de seguimiento'],
  ];
  for (const [name, color, description] of defaultLabels) {
    await query('INSERT INTO labels (name, color, description) VALUES (?, ?, ?)', [name, color, description]);
  }

  const qrs = [
    ['Bienvenida',       '/hola',        'saludos',  'Hola {{nombre}}! Bienvenido/a a Snow Motion. En que podemos ayudarte?'],
    ['Horarios clases',  '/horarios',    'info',     'Nuestras clases son Lun-Vie 9:00-17:00 y fines de semana 8:00-16:00.'],
    ['Solicitar resena', '/resena',      'resenas',  'Hola {{nombre}}! Fue un placer tenerte en Snow Motion. Podrias dejarnos una resena? [LINK]'],
    ['Envio presupuesto','/presupuesto', 'ventas',   'Hola {{nombre}}! Te enviamos el presupuesto solicitado. Cualquier consulta avisanos.'],
    ['Confirmar reserva','/confirmar',   'reservas', 'Perfecto {{nombre}}! Tu reserva quedo confirmada. Te esperamos!'],
  ];
  for (const [name, trigger, category, content] of qrs) {
    await query('INSERT INTO quick_replies (name, trigger_text, category, content) VALUES (?, ?, ?, ?)', [name, trigger, category, content]);
  }

  await query(
    'INSERT INTO auto_reply_config (is_active, schedule_start, schedule_end, greeting_message, collect_fields) VALUES (?, ?, ?, ?, ?)',
    [0, '09:00', '18:00',
     'Hola! Gracias por escribirnos a Snow Motion.\n\nEstamos fuera del horario de atencion (Lun-Vie 9:00-18:00).\n\nPara ayudarte mejor te hacemos unas preguntas rapidas:',
     '["name","email","phone","reason"]']
  );

  console.log('Datos iniciales cargados — usuario: admin / contrasena: admin123');
  saveDb();
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function runMigrations() {
  if (!USE_PG) return;
  const migrations = [
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS wa_push_name TEXT`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_disabled INTEGER DEFAULT 0`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id)`,
    // CRÍTICO: timestamp en milisegundos supera el rango de INTEGER (32-bit). Necesita BIGINT.
    `ALTER TABLE messages ALTER COLUMN timestamp TYPE BIGINT`,
    `CREATE TABLE IF NOT EXISTS ai_documents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      file_type TEXT DEFAULT 'text',
      size INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];
  for (const sql of migrations) {
    try { await query(sql); } catch(e) { console.log('Migration skip:', e.message.substring(0,60)); }
  }
  console.log('Migraciones aplicadas');
}

async function initDB() {
  if (!USE_PG) {
    ensureDataDir();
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      sqliteDb = new SQL.Database(fileBuffer);
      console.log('Base de datos cargada desde disco');
    } else {
      sqliteDb = new SQL.Database();
      console.log('Nueva base de datos creada');
    }

    startAutoSave();
  }

  await createTables();
  await runMigrations();
  await seedData();

  console.log(`Base de datos lista (${USE_PG ? 'PostgreSQL' : 'SQLite/sql.js'})`);
}

module.exports = { query, queryOne, execute, initDB, saveDb, USE_PG };