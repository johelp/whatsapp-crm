/**
 * privacy.js — Ajustes de privacidad (RGPD / ePrivacy / Reglamento de IA) y retención de datos.
 *   - Aviso de IA (art. 50.1 del Reglamento de IA)
 *   - Consentimiento para campañas (art. 21 LSSI / ePrivacy) y pie de baja
 *   - Retención con purga automática (art. 5.1.e RGPD)
 */
const { query, queryOne } = require('./db');
const { phoneVariants } = require('./antiban');

const DEFAULTS = {
  ai_disclosure_enabled: 1,
  ai_disclosure_text: 'Hola, soy el asistente virtual de {{empresa}}. Si preferís hablar con una persona, escribí "persona" en cualquier momento.',
  campaign_consent: 'require',          // require = solo contactos con consentimiento | allow_unknown = también sin dato (nunca los que se dieron de baja)
  campaign_footer_enabled: 1,
  campaign_footer_text: 'Respondé BAJA para no recibir más mensajes.',
  retention_days: 0,                    // 0 = sin purga automática
};
let cache = null, cacheAt = 0;

async function getPrivacy(force = false) {
  if (!force && cache && Date.now() - cacheAt < 15000) return cache;
  let stored = {};
  try { const r = await queryOne("SELECT value FROM settings WHERE key = 'privacy'"); if (r?.value) stored = JSON.parse(r.value); } catch (e) {}
  const p = { ...DEFAULTS, ...stored };
  if (/^(1|true|yes)$/i.test(process.env.AI_DISCLOSURE_LOCKED || '')) p.ai_disclosure_enabled = 1;   // instalaciones de la UE: no se puede apagar
  p.ai_disclosure_locked = /^(1|true|yes)$/i.test(process.env.AI_DISCLOSURE_LOCKED || '');
  cache = p; cacheAt = Date.now();
  return p;
}

async function savePrivacy(patch) {
  const cur = await getPrivacy(true);
  const next = {};
  for (const k of Object.keys(DEFAULTS)) next[k] = cur[k];
  if (patch.ai_disclosure_enabled !== undefined) next.ai_disclosure_enabled = patch.ai_disclosure_enabled ? 1 : 0;
  if (typeof patch.ai_disclosure_text === 'string' && patch.ai_disclosure_text.trim()) next.ai_disclosure_text = patch.ai_disclosure_text.trim().slice(0, 500);
  if (['require', 'allow_unknown'].includes(patch.campaign_consent)) next.campaign_consent = patch.campaign_consent;
  if (patch.campaign_footer_enabled !== undefined) next.campaign_footer_enabled = patch.campaign_footer_enabled ? 1 : 0;
  if (typeof patch.campaign_footer_text === 'string' && patch.campaign_footer_text.trim()) next.campaign_footer_text = patch.campaign_footer_text.trim().slice(0, 200);
  if (patch.retention_days !== undefined) next.retention_days = Math.max(0, Math.min(3650, Math.floor(Number(patch.retention_days) || 0)));
  const json = JSON.stringify(next);
  const ex = await queryOne("SELECT key FROM settings WHERE key = 'privacy'");
  if (ex) await query("UPDATE settings SET value = ? WHERE key = 'privacy'", [json]);
  else await query("INSERT INTO settings (key, value) VALUES ('privacy', ?)", [json]);
  cache = null;
  return getPrivacy(true);
}

async function aiDisclosureText() {
  const p = await getPrivacy();
  const ai = await queryOne('SELECT company_name FROM ai_config LIMIT 1').catch(() => null);
  return p.ai_disclosure_text.replace(/\{\{\s*empresa\s*\}\}/gi, ai?.company_name || process.env.APP_NAME || 'nuestro equipo');
}

// ─── Consentimiento ───────────────────────────────────────────────────────────

const inList = (arr) => arr.map(() => '?').join(', ');

async function getConsent(jidOrPhone) {
  const phones = phoneVariants(jidOrPhone);
  const rows = await query(`SELECT consent_status FROM contacts WHERE phone IN (${inList(phones)})`, phones);
  if (rows.some(r => r.consent_status === 'revoked')) return 'revoked';
  if (rows.some(r => r.consent_status === 'granted')) return 'granted';
  return 'unknown';
}

async function setConsent(phone, status, source, { userId = null, evidence = null } = {}) {
  if (!['granted', 'revoked', 'unknown'].includes(status)) throw new Error('Estado de consentimiento inválido');
  const phones = phoneVariants(phone);
  await query(
    `UPDATE contacts SET consent_status = ?, consent_source = ?, consent_at = ?, consent_evidence = ? WHERE phone IN (${inList(phones)})`,
    [status, String(source || '').slice(0, 60), Date.now(), evidence ? String(evidence).slice(0, 300) : null, ...phones]);
  await query('INSERT INTO activity_log (user_id, action, target_jid, detail) VALUES (?, ?, ?, ?)',
    [userId, 'consent_' + status, null, JSON.stringify({ source, phone_hash: require('crypto').createHash('sha256').update(phones[0]).digest('hex').slice(0, 16) })]).catch(() => {});
}

/** Declaración del operador al importar listas: crea el contacto si falta y marca consentimiento (nunca pisa una baja). */
async function attestConsent(phones, source, userId) {
  let n = 0;
  for (const raw of phones) {
    const p = String(raw).replace(/\D/g, '');
    if (p.length < 7) continue;
    await query('INSERT OR IGNORE INTO contacts (phone, name) VALUES (?, ?)', [p, null]).catch(() => {});
    const cur = await getConsent(p);
    if (cur === 'revoked') continue;
    await setConsent(p, 'granted', source, { userId, evidence: `declarado por el operador ${userId ?? '?'} al importar` });
    n++;
  }
  return n;
}

// ─── Retención ────────────────────────────────────────────────────────────────

const ts = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

async function purgeOld({ dryRun = false } = {}) {
  const { retention_days } = await getPrivacy(true);
  if (!retention_days) return { enabled: false, days: 0, counts: {} };
  const cutMs = Date.now() - retention_days * 86400000;
  const cutStr = ts(new Date(cutMs));
  const counts = {};
  const num = (r) => Number(r?.n) || 0;
  const run = async (key, countSql, delSql, params) => {
    counts[key] = num(await queryOne(countSql, params));
    if (!dryRun && counts[key]) await query(delSql, params);
  };

  await run('mensajes', 'SELECT COUNT(*) AS n FROM messages WHERE timestamp < ?', 'DELETE FROM messages WHERE timestamp < ?', [cutMs]);
  // Conversaciones que se quedaron sin mensajes y sus notas/etiquetas
  const orphan = "FROM conversations WHERE jid NOT IN (SELECT DISTINCT jid FROM messages)";
  counts.conversaciones = num(await queryOne(`SELECT COUNT(*) AS n ${orphan}`));
  if (!dryRun && counts.conversaciones) {
    await query(`DELETE FROM conversation_labels WHERE conversation_id IN (SELECT id ${orphan})`);
    await query(`DELETE FROM conversation_notes WHERE jid IN (SELECT jid ${orphan})`);
    await query(`DELETE ${orphan}`);
  }
  await run('cola_envios', "SELECT COUNT(*) AS n FROM outbound_queue WHERE status IN ('sent','failed') AND created_at < ?", "DELETE FROM outbound_queue WHERE status IN ('sent','failed') AND created_at < ?", [cutMs]);
  await run('webhooks', "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status != 'pending' AND created_at < ?", "DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at < ?", [cutMs]);
  await run('registro_actividad', 'SELECT COUNT(*) AS n FROM activity_log WHERE created_at < ?', 'DELETE FROM activity_log WHERE created_at < ?', [cutStr]);
  const done = "campaign_id IN (SELECT id FROM campaigns WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < ?)";
  await run('contactos_de_campañas', `SELECT COUNT(*) AS n FROM campaign_contacts WHERE ${done}`, `DELETE FROM campaign_contacts WHERE ${done}`, [cutStr]);
  return { enabled: true, days: retention_days, cutoff: new Date(cutMs).toISOString(), dry_run: dryRun, counts };
}

module.exports = { getPrivacy, savePrivacy, aiDisclosureText, getConsent, setConsent, attestConsent, purgeOld, DEFAULTS };
