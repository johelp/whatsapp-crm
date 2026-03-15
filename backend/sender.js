/**
 * sender.js — Cola de envío masivo con protección anti-ban
 */
const { sendMessage, normalizePhone } = require('./baileys');
const { query, queryOne } = require('./db');

let activeCampaignId = null;
let cancelRequested = false;
let io = null;

function setIO(s) { io = s; }
function isRunning() { return activeCampaignId !== null; }
function requestCancel() { cancelRequested = true; }

function delay(minSec, maxSec) {
  const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
  return new Promise(r => setTimeout(r, ms));
}

function personalize(template, row) {
  return template
    .replace(/\{\{nombre\}\}/gi, row.name || row.phone || '')
    .replace(/\{\{empresa\}\}/gi, row.company || '')
    .replace(/\{\{extra\}\}/gi, row.extra_field || '')
    .replace(/\{\{telefono\}\}/gi, row.phone || '');
}

async function runCampaign(campaignId, userId) {
  if (isRunning()) throw new Error('Ya hay una campaña en ejecución');

  const [campaign] = await query('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
  if (!campaign) throw new Error('Campaña no encontrada');

  const pending = await query(
    'SELECT * FROM campaign_contacts WHERE campaign_id = ? AND status = ? ORDER BY id',
    [campaignId, 'pending']
  );
  if (!pending.length) throw new Error('No hay contactos pendientes');

  activeCampaignId = campaignId;
  cancelRequested = false;

  await query("UPDATE campaigns SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", [campaignId]);

  if (io) io.emit('campaign:started', { id: campaignId, name: campaign.name, total: pending.length });
  console.log(`🚀 Campaña "${campaign.name}" — ${pending.length} contactos`);

  let sent = 0, failed = 0;

  for (let i = 0; i < pending.length; i++) {
    if (cancelRequested) {
      await query("UPDATE campaigns SET status = 'cancelled' WHERE id = ?", [campaignId]);
      if (io) io.emit('campaign:cancelled', { id: campaignId });
      break;
    }

    const row = pending[i];
    const text = personalize(campaign.template, row);

    try {
      // Buscar el JID real de la conversación (puede ser @lid, @s.whatsapp.net)
      // Usar el número normalizado como fallback
      const cleanPhone = normalizePhone(row.phone);
      const convRow = await queryOne(
        `SELECT jid FROM conversations WHERE jid LIKE ? OR jid LIKE ? ORDER BY updated_at DESC LIMIT 1`,
        [`%${cleanPhone}%`, `%${row.phone.replace(/\D/g,'')}%`]
      );
      const targetJid = convRow?.jid || cleanPhone;
      await sendMessage(targetJid, text, userId);
      await query(
        "UPDATE campaign_contacts SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?",
        [row.id]
      );
      await query('UPDATE campaigns SET sent = sent + 1 WHERE id = ?', [campaignId]);
      sent++;
    } catch (err) {
      await query(
        "UPDATE campaign_contacts SET status = 'failed', error = ? WHERE id = ?",
        [err.message, row.id]
      );
      await query('UPDATE campaigns SET failed = failed + 1 WHERE id = ?', [campaignId]);
      failed++;
      console.error(`❌ ${row.phone}: ${err.message}`);
    }

    const progress = Math.round(((sent + failed) / pending.length) * 100);
    if (io) io.emit('campaign:progress', {
      id: campaignId, sent, failed,
      total: pending.length, progress,
      current: row.name || row.phone,
    });

    // ─── Anti-ban delays ───────────────────────────────────────────────
    const isLast = i === pending.length - 1;
    if (!isLast && !cancelRequested) {
      if ((i + 1) % 5 === 0) {
        // Pausa larga cada 5 mensajes (45-90 segundos)
        const pauseSec = Math.floor(Math.random() * 45) + 45;
        console.log(`⏸  Pausa anti-ban: ${pauseSec}s`);
        if (io) io.emit('campaign:pause', { id: campaignId, seconds: pauseSec });
        await delay(pauseSec, pauseSec + 5);
      } else {
        // Delay normal entre mensajes
        await delay(campaign.delay_min || 8, campaign.delay_max || 25);
      }
    }
  }

  if (!cancelRequested) {
    await query("UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [campaignId]);
    if (io) io.emit('campaign:completed', { id: campaignId, sent, failed, total: pending.length });
    console.log(`✅ Campaña completada — ${sent} enviados, ${failed} fallidos`);
  }

  activeCampaignId = null;
  return { sent, failed };
}

module.exports = { runCampaign, isRunning, requestCancel, setIO, personalize };