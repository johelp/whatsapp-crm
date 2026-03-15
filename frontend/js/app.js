/**
 * app.js — Lógica del frontend
 * Multi-agente, tiempo real, CRM completo
 */

const API = '/api';
const socket = io({ withCredentials: true });

// ═══════════════════════════════════════════════════════════════
// ESTADO GLOBAL
// ═══════════════════════════════════════════════════════════════

const S = {
  me: null,               // Usuario actual
  conversations: [],
  activeJid: null,
  labels: [],
  contacts: [],
  quickReplies: [],
  campaigns: [],
  users: [],
  statusFilter: 'all',
  labelFilter: [],
  mineOnly: false,
  searchText: '',
  contactsSearch: '',
  contactsLabelFilter: [],
  activeCampaignId: null,
  viewingThisChat: {},    // jid → [users]
  typingTimers: {},
};

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

async function init() {
  // Obtener usuario actual
  const me = await apiFetch('/auth/me');
  if (!me || me.error) { window.location.href = '/login'; return; }
  S.me = me;

  // Configurar UI del usuario
  document.getElementById('my-avatar').textContent = me.display_name[0].toUpperCase();
  document.getElementById('my-avatar').style.background = me.color;
  document.getElementById('my-name').textContent = me.display_name;
  document.getElementById('my-role').textContent = me.role === 'admin' ? 'Administrador' : 'Agente';

  // Cargar datos
  await Promise.all([loadLabels(), loadUsers(), loadQuickReplies()]);
  await loadConversations();
  loadCampaigns();
  loadContacts();
  loadFileLibrary();
  renderSettings();

  // Solicitar permisos de notificación
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ═══════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════

async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...opts,
    });
    if (res.status === 401) { window.location.href = '/login'; return null; }
    return res.json();
  } catch (e) {
    console.error('API error:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════

socket.on('wa:status', ({ status, phone }) => {
  updateWAStatus(status, phone);
  // Cuando conecta, mostrar banner de sincronización
  if (status === 'open') {
    showSyncBanner();
    // Fallback: si history:synced no llega en 30s, recargar igual
    setTimeout(() => {
      hideSyncBanner();
      loadConversations();
      if (S.activeJid) loadMessages(S.activeJid);
    }, 30000);
  }
});

socket.on('wa:qr', ({ qr }) => {
  updateWAStatus('qr');
  const img = document.getElementById('qr-image');
  img.src = qr;
  img.style.display = 'block';
  document.getElementById('qr-waiting').style.display = 'none';
  document.getElementById('qr-subtitle').textContent = 'Escaneá con WhatsApp → Dispositivos vinculados';
  openModal('modal-qr');
});

socket.on('message:new', async (data) => {
  // Actualización quirúrgica: solo mover la conv al tope y actualizar preview
  // sin recargar TODA la lista (evita flicker y es instantáneo)
  const existingIdx = S.conversations.findIndex(c => c.jid === data.jid);
  if (existingIdx !== -1) {
    const conv = { ...S.conversations[existingIdx] };
    conv.last_message   = data.content;
    conv.last_message_at = new Date().toISOString();
    if (S.activeJid !== data.jid) conv.unread_count = (conv.unread_count || 0) + 1;
    S.conversations.splice(existingIdx, 1);
    S.conversations.unshift(conv);
    renderConversationList();
  } else {
    // Nueva conversación — recargar desde servidor para tener todos los datos
    await loadConversations();
  }

  // Si es el chat activo, agregar mensaje al área de chat
  if (S.activeJid === data.jid) {
    appendMessage({
      direction: 'in',
      content: data.content,
      timestamp: data.timestamp,
      is_auto_reply: 0,
      sender_name: data.sender_name || null,
      sender_jid:  data.sender_jid  || null,
    });
    apiFetch(`/conversations/${encodeURIComponent(data.jid)}/read`, { method: 'POST' });
  } else {
    const name = data.group_name || data.contact_name || data.jid?.split('@')[0];
    const preview = data.sender_name ? `${data.sender_name}: ${data.content}` : data.content;
    showDesktopNotif(name, preview);
    notify(`${data.is_group ? '👥' : '💬'} ${name}: ${preview.substring(0, 60)}`);
  }
});

socket.on('message:sent', (data) => {
  // Actualización quirúrgica del preview en la lista
  const existingIdx = S.conversations.findIndex(c => c.jid === data.jid);
  if (existingIdx !== -1) {
    const conv = { ...S.conversations[existingIdx] };
    conv.last_message    = data.content;
    conv.last_message_at = new Date().toISOString();
    S.conversations.splice(existingIdx, 1);
    S.conversations.unshift(conv);
    renderConversationList();
  }
  // Mostrar en el chat si:
  // a) lo envió otro agente del CRM (sent_by !== mi ID)
  // b) lo envió desde el móvil (from_device = true, sent_by = null)
  if (S.activeJid === data.jid) {
    const isFromOtherAgent = data.sent_by && data.sent_by !== S.me?.id;
    const isFromMobile = data.from_device === true;
    if (isFromOtherAgent || isFromMobile) {
      appendMessage({
        direction: 'out',
        content: data.content,
        timestamp: data.timestamp,
        sent_by: data.sent_by,
        sent_by_name: data.sent_by_name,
        sent_by_color: data.sent_by_color,
        from_device: data.from_device,
        type: data.type || 'text',
      });
    }
  }
});

socket.on('users:online', (users) => renderOnlineAgents(users));

socket.on('group:updated', ({ jid, group_name }) => {
  const conv = S.conversations.find(c => c.jid === jid);
  if (conv) {
    conv.contact_name = group_name;
    conv.group_name   = group_name;
    renderConversationList();
    // Actualizar header si el grupo está activo
    if (S.activeJid === jid) {
      document.getElementById('ch-name').textContent = group_name;
    }
  }
});

socket.on('history:synced', ({ count, isLatest }) => {
  hideSyncBanner();
  if (count > 0) notify(`📥 ${count} mensajes importados`);
  // Primero recargar lista, luego mensajes del chat activo
  loadConversations().then(() => {
    if (S.activeJid) loadMessages(S.activeJid);
  });
});

socket.on('typing:remote', ({ jid, user }) => {
  if (S.activeJid !== jid) return;
  showRemoteTyping(`${user.display_name} está escribiendo...`);
});

socket.on('typing:stop_remote', () => {
  document.getElementById('remote-typing').style.display = 'none';
});

socket.on('chat:viewing', ({ jid, user }) => {
  if (!S.viewingThisChat[jid]) S.viewingThisChat[jid] = [];
  S.viewingThisChat[jid] = S.viewingThisChat[jid].filter(u => u.id !== user.id);
  S.viewingThisChat[jid].push(user);
  if (S.activeJid === jid) renderViewingIndicator(jid);
});

socket.on('chat:left', ({ jid, userId }) => {
  if (S.viewingThisChat[jid]) {
    S.viewingThisChat[jid] = S.viewingThisChat[jid].filter(u => u.id !== userId);
    if (S.activeJid === jid) renderViewingIndicator(jid);
  }
});

socket.on('campaign:started', (d) => {
  S.activeCampaignId = d.id;
  const t = document.getElementById('campaign-toast');
  document.getElementById('ct-name').textContent = d.name;
  document.getElementById('ct-stats').textContent = `0 / ${d.total} enviados`;
  document.getElementById('ct-bar-fill').style.width = '0%';
  document.getElementById('ct-pause').style.display = 'none';
  t.classList.add('visible');
  loadCampaigns();
});

socket.on('campaign:progress', (d) => {
  document.getElementById('ct-stats').textContent = `${d.sent} / ${d.total} — ${d.current}`;
  document.getElementById('ct-bar-fill').style.width = d.progress + '%';
  document.getElementById('ct-pause').style.display = 'none';
  loadCampaigns();
});

socket.on('campaign:pause', (d) => {
  const p = document.getElementById('ct-pause');
  p.textContent = `⏸ Pausa anti-ban: ${d.seconds}s...`;
  p.style.display = 'block';
});

socket.on('campaign:completed', (d) => {
  document.getElementById('ct-name').textContent = '✅ Campaña completada';
  document.getElementById('ct-stats').textContent = `${d.sent} enviados · ${d.failed} fallidos`;
  document.getElementById('ct-bar-fill').style.width = '100%';
  setTimeout(() => { document.getElementById('campaign-toast').classList.remove('visible'); }, 6000);
  S.activeCampaignId = null;
  loadCampaigns();
  notify('✅ Campaña completada');
});

socket.on('campaign:cancelled', () => {
  document.getElementById('campaign-toast').classList.remove('visible');
  S.activeCampaignId = null;
  loadCampaigns();
});

socket.on('bot:lead_collected', (data) => {
  const fields = Object.entries(data.data).map(([k, v]) => `${k}: ${v}`).join('\n');
  const alert = document.createElement('div');
  alert.className = 'bot-alert';
  alert.innerHTML = `
    <h5>🤖 Consulta fuera de horario</h5>
    <div class="ba-data">${esc(fields)}</div>
    <div class="ba-actions">
      <button class="btn-secondary btn-sm" onclick="openChatFromAlert('${data.jid}',this)">Ver chat</button>
      <button class="btn-icon-sm" onclick="this.closest('.bot-alert').remove()">✕</button>
    </div>`;
  document.getElementById('bot-alerts').appendChild(alert);
  setTimeout(() => alert.remove(), 45000);
  notify(`🤖 Nueva consulta de ${data.phone}: ${fields.split('\n')[0]}`);
});

function openChatFromAlert(jid, btn) {
  btn.closest('.bot-alert').remove();
  showPanel('inbox');
  openChat(jid);
}

// ═══════════════════════════════════════════════════════════════
// WA STATUS
// ═══════════════════════════════════════════════════════════════

function updateWAStatus(status, phone) {
  const pill = document.getElementById('wa-pill');
  const text = document.getElementById('wa-status-text');
  pill.className = `wa-status-pill ${status}`;
  if (status === 'connected') text.textContent = phone ? `+${phone}` : 'Conectado';
  else if (status === 'qr') text.textContent = 'Escanear QR';
  else if (status === 'connecting') text.textContent = 'Conectando...';
  else text.textContent = 'Desconectado';
}

// ═══════════════════════════════════════════════════════════════
// PANELS
// ═══════════════════════════════════════════════════════════════

function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`panel-${name}`)?.classList.add('active');
  document.querySelector(`[data-panel="${name}"]`)?.classList.add('active');
}

// ═══════════════════════════════════════════════════════════════
// LABELS
// ═══════════════════════════════════════════════════════════════

async function loadLabels() {
  S.labels = await apiFetch('/labels') || [];
  renderLabelChips();
}

function renderLabelChips() {
  // Dropdown de etiquetas en inbox
  const sel = document.getElementById('label-filter-sel');
  if (sel) {
    sel.innerHTML = '<option value="">🏷 Todas las etiquetas</option>' +
      S.labels.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    if (S.labelFilter.length) sel.value = S.labelFilter[0];
  }
  // Chips en panel contactos (puede no existir si no está en esa vista)
  const contactsChips = document.getElementById('contacts-label-chips');
  if (contactsChips) {
    contactsChips.innerHTML = S.labels.map(l =>
      `<span class="lchip" data-id="${l.id}" style="color:${l.color};background:${l.color}18" onclick="toggleContactsLabel(${l.id},this)">${esc(l.name)}</span>`
    ).join('');
  }
}

function setLabelFromSelect(sel) {
  const val = parseInt(sel.value);
  S.labelFilter = val ? [val] : [];
  renderConversationList();
}

function toggleInboxLabel(id, el) {
  const idx = S.labelFilter.indexOf(id);
  if (idx >= 0) S.labelFilter.splice(idx, 1); else S.labelFilter.push(id);
  el.classList.toggle('active', S.labelFilter.includes(id));
  renderConversationList();
}

function toggleContactsLabel(id, el) {
  const idx = S.contactsLabelFilter.indexOf(id);
  if (idx >= 0) S.contactsLabelFilter.splice(idx, 1); else S.contactsLabelFilter.push(id);
  el.classList.toggle('active', S.contactsLabelFilter.includes(id));
  renderContactsTable();
}

// ═══════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════

async function loadUsers() {
  if (S.me?.role !== 'admin') return;
  S.users = await apiFetch('/users') || [];
  renderAssignSelect();
}

function renderAssignSelect() {
  const sel = document.getElementById('conv-assign-sel');
  if (!sel) return;
  const options = S.users.map(u => `<option value="${u.id}">${u.display_name}</option>`).join('');
  sel.innerHTML = '<option value="">Sin asignar</option>' + options;
}

function renderOnlineAgents(users) {
  const el = document.getElementById('online-agents');
  // Filtrar yo mismo
  const others = users.filter(u => u.id !== S.me?.id);
  if (!others.length) { el.innerHTML = ''; return; }
  el.innerHTML = others.map(u =>
    `<div class="agent-dot" style="background:${u.color}" title="${u.display_name}">${u.display_name[0]}</div>`
  ).join('');
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATIONS
// ═══════════════════════════════════════════════════════════════

async function loadConversations() {
  const params = new URLSearchParams();
  if (S.statusFilter !== 'all') params.set('status', S.statusFilter);
  if (S.mineOnly) params.set('assigned', 'me');
  if (S.searchText) params.set('search', S.searchText);

  S.conversations = await apiFetch(`/conversations?${params}`) || [];
  renderConversationList();
  updateInboxBadge();
}

function updateInboxBadge() {
  const count = S.conversations.filter(c => c.unread_count > 0).length;
  const badge = document.getElementById('badge-inbox');
  badge.textContent = count;
  badge.style.display = count > 0 ? 'block' : 'none';
}

function renderConversationList() {
  const el = document.getElementById('chat-list');
  let convs = S.conversations;

  if (S.labelFilter.length) {
    convs = convs.filter(c => {
      const ids = (c.labels || []).map(l => l.id);
      return S.labelFilter.some(f => ids.includes(f));
    });
  }

  if (!convs.length) {
    el.innerHTML = '<div class="list-empty">Sin conversaciones</div>';
    return;
  }

  el.innerHTML = convs.map(c => {
    const isGroup = c.is_group == 1 || c.jid?.endsWith('@g.us');
    const name = c.contact_name || (isGroup ? (c.group_name || c.jid?.split('@')[0]) : c.contact_phone) || c.jid?.split('@')[0];
    const avatar = isGroup ? '👥' : (name[0]?.toUpperCase() || '?');
    const avatarStyle = isGroup ? 'font-size:18px;display:flex;align-items:center;justify-content:center;background:var(--surface3)' : '';
    const labels = (c.labels || []).map(l =>
      `<span class="label-pill" style="background:${l.color}" title="${esc(l.name)}"></span>`
    ).join('');
    const assignedChip = c.assigned_name
      ? `<span class="assigned-chip" style="background:${c.assigned_color}">${c.assigned_name[0]}</span>`
      : '';
    const groupBadge = isGroup ? `<span style="font-size:10px;color:var(--text3);margin-left:4px">grupo</span>` : '';
    return `
    <div class="chat-item ${c.jid === S.activeJid ? 'active' : ''}" onclick="openChat('${c.jid}')">
      <div class="chat-avatar" style="${avatarStyle}">${avatar}</div>
      <div class="chat-body">
        <div class="chat-name-row">
          <span class="chat-name">${esc(name)}${groupBadge}</span>
          <span class="chat-time">${fmtTime(c.last_message_at)}</span>
        </div>
        <div class="chat-preview">${esc(c.last_message || '')}</div>
        <div class="chat-footer">
          ${labels}
          ${assignedChip}
          ${c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function setStatusFilter(status, el) {
  S.statusFilter = status;
  document.querySelectorAll('.filter-btn:not(.mine)').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  loadConversations();
}

function setStatusFromSelect(sel) {
  S.statusFilter = sel.value;
  loadConversations();
}

function toggleMineFilter(el) {
  S.mineOnly = !S.mineOnly;
  el.classList.toggle('active', S.mineOnly);
  loadConversations();
}

function filterConversations() {
  S.searchText = document.getElementById('chat-search').value;
  loadConversations();
}

// ═══════════════════════════════════════════════════════════════
// CHAT OPEN
// ═══════════════════════════════════════════════════════════════

let prevActiveJid = null;

async function openChat(jid) {
  // Avisar al anterior que ya no lo estamos viendo
  if (prevActiveJid) socket.emit('chat:close', { jid: prevActiveJid });

  S.activeJid = jid;
  prevActiveJid = jid;

  // Mostrar panel activo
  document.getElementById('chat-empty').style.display = 'none';
  document.getElementById('chat-active').style.display = 'flex';
  document.getElementById('chat-active').style.flexDirection = 'column';
  document.getElementById('chat-active').style.height = '100%';

  const conv = S.conversations.find(c => c.jid === jid);
  const isGroup = jid.endsWith('@g.us') || conv?.is_group == 1;
  const phone = jid.split('@')[0];

  let displayName;
  if (isGroup) {
    displayName = conv?.group_name || conv?.contact_name || phone;
  } else {
    displayName = conv?.contact_name && conv.contact_name !== phone
      ? conv.contact_name
      : (conv?.wa_push_name || conv?.contact_phone || phone);
  }

  // Header
  const avatarEl = document.getElementById('ch-avatar');
  if (isGroup) {
    avatarEl.textContent = '👥';
    avatarEl.style.fontSize = '20px';
  } else {
    avatarEl.textContent = displayName[0]?.toUpperCase() || '?';
    avatarEl.style.fontSize = '';
  }
  document.getElementById('ch-name').textContent = displayName;
  document.getElementById('ch-phone').textContent = isGroup ? `${jid}` : `+${phone}`;
  document.getElementById('ch-company').textContent = isGroup ? '👥 Grupo de WhatsApp' : (conv?.company ? `· ${conv.company}` : '');

  // Status y asignación
  document.getElementById('conv-status-sel').value = conv?.status || 'open';
  document.getElementById('conv-assign-sel').value = conv?.assigned_to || '';

  // Etiquetas en header
  renderChatHeaderLabels(conv);

  // Info sidebar
  renderInfoSidebar(conv);

  // Bot data
  renderBotData(conv);

  // Cargar mensajes
  const msgs = await apiFetch(`/conversations/${encodeURIComponent(jid)}/messages`) || [];
  renderMessages(msgs);

  // Marcar como leído
  await apiFetch(`/conversations/${encodeURIComponent(jid)}/read`, { method: 'POST' });

  // Avisar a otros que estoy viendo este chat
  socket.emit('chat:open', { jid });

  renderConversationList();
  renderViewingIndicator(jid);
}

function renderChatHeaderLabels(conv) {
  const el = document.getElementById('ch-labels');
  if (!conv?.labels?.length) { el.innerHTML = ''; return; }
  el.innerHTML = conv.labels.map(l => `
    <span class="ch-label-badge" style="background:${l.color}20;color:${l.color};border:1px solid ${l.color}40">
      ${esc(l.name)}
      <span class="ch-label-remove" onclick="removeLabelFromConv('${conv.jid}',${l.id})">✕</span>
    </span>`).join('');
}

function renderInfoSidebar(conv) {
  const convLabelIds = (conv?.labels || []).map(l => l.id);
  const grid = document.getElementById('conv-labels-add');
  grid.innerHTML = S.labels.map(l => {
    const on = convLabelIds.includes(l.id);
    return `<button class="label-toggle-btn ${on ? 'on' : ''}"
      style="color:${l.color};border-color:${l.color};background:${on ? l.color + '20' : 'transparent'}"
      onclick="toggleConvLabel('${conv?.jid}',${l.id},${on})">${esc(l.name)}</button>`;
  }).join('');

  document.getElementById('conv-labels-active').innerHTML = (conv?.labels || []).map(l =>
    `<span class="ch-label-badge" style="background:${l.color}20;color:${l.color};border:1px solid ${l.color}40;margin-bottom:4px;display:inline-flex">
      ${esc(l.name)} <span class="ch-label-remove" onclick="removeLabelFromConv('${conv.jid}',${l.id})">✕</span>
    </span>`
  ).join(' ') || '<span style="font-size:12px;color:var(--text3)">Sin etiquetas</span>';
}

function renderBotData(conv) {
  const el = document.getElementById('bot-data-view');
  const collected = JSON.parse(conv?.bot_collected || '{}');
  if (!Object.keys(collected).length) {
    el.textContent = conv?.bot_state === 'idle' ? 'Sin actividad del bot' : `Estado: ${conv?.bot_state}`;
    return;
  }
  el.innerHTML = Object.entries(collected)
    .map(([k, v]) => `<div><b>${k}:</b> ${esc(v)}</div>`).join('');
}

function renderViewingIndicator(jid) {
  const viewers = (S.viewingThisChat[jid] || []).filter(u => u.id !== S.me?.id);
  const el = document.getElementById('viewing-indicator');
  el.innerHTML = viewers.map(u =>
    `<span class="viewer-chip" style="background:${u.color}" title="${u.display_name} está en este chat">${u.display_name[0]}</span>`
  ).join('');
}

// Renderiza el contenido de un mensaje según su tipo (texto, imagen, audio, etc.)
function renderMsgContent(m) {
  const media = m.media_data ? (typeof m.media_data === 'string' ? JSON.parse(m.media_data) : m.media_data) : null;
  const msgId = m.message_id;
  const caption = media?.caption ? `<div class="media-caption">${esc(media.caption)}</div>` : '';
  const text = m.content || '';

  if (media?.type === 'image') {
    return `<div class="msg-media">
      <img src="/api/messages/${encodeURIComponent(msgId)}/media"
           class="msg-image" loading="lazy"
           onclick="openMediaModal(this.src, 'image')"
           onerror="this.parentElement.innerHTML='<span class=\"media-error\">🖼 ${esc(text || 'Imagen')}</span>'"
           alt="Imagen">
      ${caption}
    </div>`;
  }

  if (media?.type === 'video') {
    return `<div class="msg-media">
      <video controls class="msg-video" preload="metadata"
             onerror="this.parentElement.innerHTML='<span class=\"media-error\">🎬 ${esc(text || 'Video')}</span>'">
        <source src="/api/messages/${encodeURIComponent(msgId)}/media" type="${media.mimetype || 'video/mp4'}">
      </video>
      ${caption}
    </div>`;
  }

  if (media?.type === 'audio') {
    const isPtt = media.ptt;
    const secs = media.seconds || 0;
    const duration = secs > 0 ? ` · ${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}` : '';
    return `<div class="msg-audio">
      ${isPtt ? '🎤' : '🎵'}<span class="audio-label">${isPtt ? 'Nota de voz' : 'Audio'}${duration}</span>
      <audio controls preload="none" class="msg-audio-player"
             onerror="this.parentElement.innerHTML='<span class=\"media-error\">🎵 Audio no disponible</span>'">
        <source src="/api/messages/${encodeURIComponent(msgId)}/media" type="${media.mimetype || 'audio/ogg'}">
      </audio>
    </div>`;
  }

  if (media?.type === 'document') {
    const fname = media.fileName || 'archivo';
    const size = media.fileLength ? ` (${Math.round(media.fileLength/1024)}KB)` : '';
    return `<div class="msg-document">
      <a href="/api/messages/${encodeURIComponent(msgId)}/media"
         target="_blank" class="msg-doc-link" download="${esc(fname)}">
        📎 ${esc(fname)}${size}
      </a>
    </div>`;
  }

  // Texto plano o tipos sin media
  return esc(text || m.content || '[mensaje]');
}

// Modal para ver imágenes en grande
function openMediaModal(src, type) {
  let modal = document.getElementById('media-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'media-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
    modal.onclick = () => modal.remove();
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<img src="${src}" style="max-width:90vw;max-height:90vh;border-radius:8px;object-fit:contain">`;
  modal.style.display = 'flex';
}

function renderMessages(msgs) {
  const el = document.getElementById('messages-area');
  if (!msgs || !msgs.length) {
    el.innerHTML = '<div class="msg-date-sep" style="opacity:0.5">Sin mensajes aún en el CRM — los nuevos mensajes aparecerán aquí</div>';
    return;
  }

  const activeConv = S.conversations.find(c => c.jid === S.activeJid);
  const isGroupChat = S.activeJid?.endsWith('@g.us') || activeConv?.is_group == 1;

  let lastDate = '';
  el.innerHTML = msgs.map(m => {
    // timestamp puede llegar como string desde PostgreSQL BIGINT — siempre convertir a número
    const ts = Number(m.timestamp);
    const d = ts > 0 ? new Date(ts) : null;
    const dateStr = d ? d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Fecha desconocida';
    const timeStr = d ? d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '--:--';
    const sep = dateStr !== lastDate ? `<div class="msg-date-sep">${dateStr}</div>` : '';
    lastDate = dateStr;
    // sent_by=null y sent_by_name='📱 Móvil' → enviado desde el teléfono
    const fromDevice = m.direction === 'out' && !m.sent_by && !m.sent_by_name;
    // También soportar cuando viene del socket con sent_by_name='📱 Móvil'
    const isFromMobile = fromDevice || (m.direction === 'out' && m.from_device);
    const agentTag = isFromMobile
      ? `<span class="msg-agent msg-agent-mobile" title="Enviado desde el móvil">📱</span>`
      : (m.sent_by && m.sent_by_name
          ? `<span class="msg-agent" style="background:${m.sent_by_color || '#6366f1'}">${m.sent_by_name[0]}</span>`
          : '');
    const autoTag = m.is_auto_reply ? '<span class="msg-auto-tag">bot</span>' : '';
    // En grupos, mostrar quién habló encima del mensaje (solo para mensajes entrantes)
    const senderTag = isGroupChat && m.direction === 'in' && m.sender_name
      ? `<div class="msg-sender-name">${esc(m.sender_name)}</div>`
      : '';
    const bubbleContent = renderMsgContent(m);
    return `${sep}
    <div class="msg-wrap ${m.direction} ${m.is_auto_reply ? 'auto' : ''} ${isFromMobile ? 'from-device' : ''}">
      ${senderTag}
      <div class="msg-bubble">${bubbleContent}</div>
      <div class="msg-meta">
        <span class="msg-time">${timeStr}</span>
        ${agentTag}${autoTag}
      </div>
    </div>`;
  }).join('');

  el.scrollTop = el.scrollHeight;
}

// Recarga solo los mensajes del chat activo
async function loadMessages(jid) {
  if (!jid) return;
  const msgs = await apiFetch(`/conversations/${encodeURIComponent(jid)}/messages`) || [];
  renderMessages(msgs);
}

function appendMessage(msg) {
  const el = document.getElementById('messages-area');
  const ts = Number(msg.timestamp);
  const d = ts > 0 ? new Date(ts) : new Date();
  const wrap = document.createElement('div');
  wrap.className = `msg-wrap ${msg.direction}`;

  const activeConv = S.conversations.find(c => c.jid === S.activeJid);
  const isGroupChat = S.activeJid?.endsWith('@g.us') || activeConv?.is_group == 1;

  let agentTag = '';
  const isFromMobile = msg.from_device || (msg.direction === 'out' && !msg.sent_by && !msg.sent_by_name);
  if (isFromMobile) {
    agentTag = `<span class="msg-agent msg-agent-mobile" title="Enviado desde el móvil">📱</span>`;
  } else if (msg.direction === 'out' && S.me && !msg.sent_by_name) {
    agentTag = `<span class="msg-agent" style="background:${S.me.color}">${S.me.display_name[0]}</span>`;
  } else if (msg.sent_by_name) {
    agentTag = `<span class="msg-agent" style="background:${msg.sent_by_color || '#6366f1'}">${msg.sent_by_name[0]}</span>`;
  }

  // Sender en grupos
  const senderTag = isGroupChat && msg.direction === 'in' && msg.sender_name
    ? `<div class="msg-sender-name">${esc(msg.sender_name)}</div>`
    : '';

  wrap.innerHTML = `
    ${senderTag}
    <div class="msg-bubble">${renderMsgContent(msg)}</div>
    <div class="msg-meta">
      <span class="msg-time">${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
      ${agentTag}
    </div>`;
  el.appendChild(wrap);
  el.scrollTop = el.scrollHeight;
}

function toggleInfoSidebar() {
  const sb = document.getElementById('info-sidebar');
  const btn = document.getElementById('btn-toggle-sidebar');
  sb.classList.toggle('open');
  btn.classList.toggle('active');
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION ACTIONS
// ═══════════════════════════════════════════════════════════════

async function updateConvStatus() {
  if (!S.activeJid) return;
  const status = document.getElementById('conv-status-sel').value;
  await apiFetch(`/conversations/${encodeURIComponent(S.activeJid)}/status`, {
    method: 'PUT', body: JSON.stringify({ status }),
  });
  loadConversations();
}

async function updateConvAssign() {
  if (!S.activeJid) return;
  const userId = document.getElementById('conv-assign-sel').value;
  await apiFetch(`/conversations/${encodeURIComponent(S.activeJid)}/assign`, {
    method: 'PUT', body: JSON.stringify({ user_id: userId || null }),
  });
  loadConversations();
}

async function toggleConvLabel(jid, labelId, isOn) {
  if (isOn) await removeLabelFromConv(jid, labelId);
  else await addLabelToConv(jid, labelId);
}

async function addLabelToConv(jid, labelId) {
  await apiFetch(`/conversations/${encodeURIComponent(jid)}/labels/${labelId}`, { method: 'POST' });
  await loadConversations();
  const conv = S.conversations.find(c => c.jid === jid);
  renderChatHeaderLabels(conv);
  renderInfoSidebar(conv);
}

async function removeLabelFromConv(jid, labelId) {
  await apiFetch(`/conversations/${encodeURIComponent(jid)}/labels/${labelId}`, { method: 'DELETE' });
  await loadConversations();
  const conv = S.conversations.find(c => c.jid === jid);
  renderChatHeaderLabels(conv);
  renderInfoSidebar(conv);
}

// ═══════════════════════════════════════════════════════════════
// GUARDAR CONTACTO DESDE CHAT
// ═══════════════════════════════════════════════════════════════

async function saveContactFromChat() {
  if (!S.activeJid) return;
  const conv = S.conversations.find(c => c.jid === S.activeJid);
  const phone = S.activeJid.split('@')[0];
  const name = conv?.wa_push_name || conv?.contact_name || '';

  // Si ya tiene nombre real (no es solo el número), confirmar
  if (name && name !== phone) {
    if (!confirm(`¿Guardar "${name}" como contacto?`)) return;
    const res = await apiFetch('/contacts/from-conversation', {
      method: 'POST',
      body: JSON.stringify({ jid: S.activeJid, name }),
    });
    if (res?.id) {
      notify(`✅ Contacto guardado: ${name}`);
      await loadContacts();
      await loadConversations();
      const updConv = S.conversations.find(c => c.jid === S.activeJid);
      renderChatHeaderLabels(updConv);
    }
  } else {
    // Abrir modal para completar datos
    document.getElementById('contact-modal-title').textContent = 'Guardar contacto';
    document.getElementById('ct-id').value = '';
    document.getElementById('ct-phone').value = phone;
    document.getElementById('ct-name').value = name !== phone ? name : '';
    document.getElementById('ct-company').value = '';
    document.getElementById('ct-extra').value = '';
    document.getElementById('ct-notes').value = '';
    // Al guardar, usar from-conversation
    window._saveFromChat = S.activeJid;
    openModal('modal-contact');
  }
}

// Override saveContact para manejar el caso from-conversation
const _origSaveContact = typeof saveContact !== 'undefined' ? saveContact : null;

async function saveContact() {
  const id = document.getElementById('ct-id').value;
  const body = {
    phone: document.getElementById('ct-phone').value.replace(/\D/g, ''),
    name: document.getElementById('ct-name').value,
    company: document.getElementById('ct-company').value,
    extra: document.getElementById('ct-extra').value,
    notes: document.getElementById('ct-notes').value,
  };
  if (!body.phone) { notify('El teléfono es obligatorio', 'error'); return; }

  if (window._saveFromChat) {
    // Guardar desde conversación
    const res = await apiFetch('/contacts/from-conversation', {
      method: 'POST',
      body: JSON.stringify({ jid: window._saveFromChat, ...body }),
    });
    window._saveFromChat = null;
    closeModal('modal-contact');
    await loadContacts();
    await loadConversations();
    notify('✅ Contacto guardado');
  } else if (id) {
    await apiFetch(`/contacts/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    closeModal('modal-contact');
    await loadContacts();
    await loadConversations(); // actualizar nombre en la bandeja inmediatamente
    if (S.activeJid) openChat(S.activeJid); // refrescar header del chat
    notify('✅ Contacto actualizado');
  } else {
    const res = await apiFetch('/contacts', { method: 'POST', body: JSON.stringify(body) });
    closeModal('modal-contact');
    await loadContacts();
    notify('✅ Contacto agregado');
  }
}

// Enviar mensaje directo desde lista de contactos
async function sendDirectMessage(phone, name) {
  const text = prompt(`Mensaje para ${name} (+${phone}):`);
  if (!text?.trim()) return;
  try {
    const res = await apiFetch('/send', {
      method: 'POST',
      body: JSON.stringify({ phone, message: text.trim() }),
    });
    if (res?.ok) {
      notify(`✅ Mensaje enviado a ${name}`);
      showPanel('inbox');
      await loadConversations();
      // Abrir la conversación
      const jid = `${phone.replace(/\D/g,'')}@s.whatsapp.net`;
      setTimeout(() => openChat(jid), 500);
    } else {
      notify(res?.error || 'Error enviando mensaje', 'error');
    }
  } catch(e) {
    notify('Error: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// ELIMINAR CONVERSACIÓN
// ═══════════════════════════════════════════════════════════════

function deleteConversationPrompt() {
  if (!S.activeJid) return;
  const conv = S.conversations.find(c => c.jid === S.activeJid);
  const name = conv?.contact_name || S.activeJid.split('@')[0];
  document.getElementById('del-conv-name').textContent = name;
  // reset to soft
  document.querySelector('input[name="del-mode"][value="soft"]').checked = true;
  openModal('modal-delete-conv');
}

async function confirmDeleteConversation() {
  const mode = document.querySelector('input[name="del-mode"]:checked')?.value;
  const jid = S.activeJid;
  if (!jid) return;

  const url = `/conversations/${encodeURIComponent(jid)}${mode === 'hard' ? '?hard=1' : ''}`;
  const res = await apiFetch(url, { method: 'DELETE' });

  if (res?.ok) {
    closeModal('modal-delete-conv');
    // Cerrar el chat activo
    S.activeJid = null;
    document.getElementById('chat-empty').style.display = 'flex';
    document.getElementById('chat-active').style.display = 'none';
    await loadConversations();
    notify('✅ Conversación eliminada');
  } else {
    notify(res?.error || 'Error al eliminar', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// BIBLIOTECA DE ARCHIVOS
// ═══════════════════════════════════════════════════════════════

let fileLibrary = [];
let filePopupOpen = false;

async function loadFileLibrary() {
  fileLibrary = await apiFetch('/files') || [];
}

function openFileLibraryModal() {
  renderFilesTable();
  renderFileCatFilters();
  switchFileTab('list', document.querySelector('#modal-files .modal-tab'));
  openModal('modal-files');
}

function switchFileTab(name, btn) {
  document.getElementById('file-tab-list').style.display = name === 'list' ? 'flex' : 'none';
  document.getElementById('file-tab-upload').style.display = name === 'upload' ? 'flex' : 'none';
  document.querySelectorAll('#modal-files .modal-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

let _fileCatFilter = 'all';

function renderFileCatFilters() {
  const cats = ['all', ...new Set(fileLibrary.map(f => f.category).filter(Boolean))];
  const el = document.getElementById('file-cat-filters');
  el.innerHTML = cats.map(c => `
    <button class="filter-btn ${c === _fileCatFilter ? 'active' : ''}" onclick="setFileCat('${c}',this)">
      ${c === 'all' ? 'Todos' : c}
    </button>`).join('');
}

function setFileCat(cat, btn) {
  _fileCatFilter = cat;
  document.querySelectorAll('#file-cat-filters .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderFilesTable();
}

function renderFilesTable(forPopup = false) {
  const data = _fileCatFilter === 'all' ? fileLibrary : fileLibrary.filter(f => f.category === _fileCatFilter);
  const tbody = document.getElementById(forPopup ? 'file-popup-list' : 'files-tbody');
  if (!tbody) return;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text3)">No hay archivos. Subí uno desde ⬆ Subir archivo.</td></tr>`;
    return;
  }

  const mimeIcon = (mime) => {
    if (mime.startsWith('image/')) return '🖼';
    if (mime === 'application/pdf') return '📄';
    if (mime.startsWith('video/')) return '🎬';
    if (mime.includes('word') || mime.includes('document')) return '📝';
    if (mime.includes('sheet') || mime.includes('excel')) return '📊';
    return '📎';
  };

  const fmtSize = (b) => b > 1024*1024 ? `${(b/1024/1024).toFixed(1)}MB` : `${Math.round(b/1024)}KB`;

  if (forPopup) {
    tbody.innerHTML = data.map(f => `
      <div class="qr-row" onclick="sendFileFromLibrary(${f.id},'${esc(f.name)}')">
        <span style="font-size:16px">${mimeIcon(f.mime_type)}</span>
        <span style="flex:1;min-width:0"><b>${esc(f.name)}</b> <span style="color:var(--text3);font-size:11px">${fmtSize(f.size)}</span></span>
        <span style="font-size:10px;color:var(--text3)">${f.category}</span>
      </div>`).join('');
  } else {
    tbody.innerHTML = data.map(f => `
      <tr>
        <td>${mimeIcon(f.mime_type)} ${esc(f.name)}<br><span style="font-size:10px;color:var(--text3)">${esc(f.original_name)}</span></td>
        <td style="font-size:11px;color:var(--text3)">${f.mime_type.split('/')[1]}</td>
        <td><span style="font-size:11px">${f.category}</span></td>
        <td style="font-size:11px">${fmtSize(f.size)}</td>
        <td style="font-size:11px">${f.use_count}</td>
        <td>
          <div style="display:flex;gap:4px">
            <a class="btn-icon-sm" href="/api/files/${f.id}/download" target="_blank" title="Ver/descargar">👁</a>
            <button class="btn-icon-sm btn-danger" onclick="deleteFile(${f.id})" title="Eliminar">🗑</button>
          </div>
        </td>
      </tr>`).join('');
  }
}

async function deleteFile(id) {
  if (!confirm('¿Eliminar este archivo de la biblioteca?')) return;
  const res = await apiFetch(`/files/${id}`, { method: 'DELETE' });
  if (res?.ok) {
    await loadFileLibrary();
    renderFilesTable();
    renderFileCatFilters();
    notify('✅ Archivo eliminado');
  } else {
    notify(res?.error || 'Error', 'error');
  }
}

let _selectedUploadFile = null;

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  _selectedUploadFile = file;
  document.getElementById('file-upload-name').textContent = `${file.name} (${(file.size/1024).toFixed(0)}KB)`;
  document.getElementById('fu-name').value = file.name.replace(/\.[^.]+$/, '');
  document.getElementById('file-drop-zone').style.borderColor = 'var(--wa)';
}

async function uploadFile() {
  if (!_selectedUploadFile) { notify('Seleccioná un archivo', 'warning'); return; }
  const name = document.getElementById('fu-name').value.trim();
  if (!name) { notify('El nombre es obligatorio', 'warning'); return; }

  const formData = new FormData();
  formData.append('file', _selectedUploadFile);
  formData.append('name', name);
  formData.append('description', document.getElementById('fu-description').value);
  formData.append('category', document.getElementById('fu-category').value);

  const res = await fetch('/api/files', {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });
  const data = await res.json();

  if (data?.ok) {
    notify(`✅ "${name}" subido correctamente`);
    _selectedUploadFile = null;
    document.getElementById('fu-name').value = '';
    document.getElementById('fu-description').value = '';
    document.getElementById('file-upload-name').textContent = 'PDF, imagen, documento — máx 20MB';
    document.getElementById('file-drop-zone').style.borderColor = 'var(--border2)';
    await loadFileLibrary();
    renderFilesTable();
    renderFileCatFilters();
    switchFileTab('list', document.querySelector('#modal-files .modal-tab'));
  } else {
    notify(data?.error || 'Error subiendo archivo', 'error');
  }
}

// ─── Popup de archivos en el compositor ───────────────────────

function toggleFilePopup() {
  filePopupOpen ? closeFilePopup() : openFilePopup();
}

function openFilePopup() {
  if (!S.activeJid) return;
  const popup = document.getElementById('file-popup');

  // Crear lista dentro del popup si no existe
  if (!document.getElementById('file-popup-list')) {
    popup.innerHTML = `
      <div style="padding:6px 10px;font-size:11px;font-weight:600;color:var(--text3);display:flex;justify-content:space-between;align-items:center">
        <span>ARCHIVOS DE BIBLIOTECA</span>
        <a href="#" onclick="openFileLibraryModal();return false" style="font-size:10px;color:var(--wa)">Gestionar ➜</a>
      </div>
      <div id="file-popup-list"></div>`;
  }

  renderFilesTable(true);

  if (!fileLibrary.length) {
    popup.style.display = 'block';
    filePopupOpen = true;
    return;
  }

  popup.style.display = 'block';
  filePopupOpen = true;
}

function closeFilePopup() {
  document.getElementById('file-popup').style.display = 'none';
  filePopupOpen = false;
}

async function sendFileFromLibrary(fileId, fileName) {
  if (!S.activeJid) return;
  closeFilePopup();

  const caption = prompt(`Texto acompañando "${fileName}" (opcional):`);
  if (caption === null) return; // canceló

  const res = await apiFetch('/send-file', {
    method: 'POST',
    body: JSON.stringify({ jid: S.activeJid, file_id: fileId, caption: caption || '' }),
  });

  if (res?.ok) {
    notify(`✅ "${fileName}" enviado`);
    appendMessage({ direction: 'out', content: caption || `[${fileName}]`, timestamp: Date.now() });
  } else {
    notify(res?.error || 'Error enviando archivo', 'error');
  }
}

let typingTimer = null;

async function sendMsg() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !S.activeJid) return;

  input.value = '';
  input.style.height = 'auto';
  closeQRPopup();

  // Optimistic UI
  appendMessage({ direction: 'out', content: text, timestamp: Date.now() });

  // Parar typing indicator
  socket.emit('typing:stop', { jid: S.activeJid });

  // Pasar el JID completo para que el backend sepa si es @lid, @s.whatsapp.net o @g.us
  const res = await apiFetch('/send', {
    method: 'POST',
    body: JSON.stringify({ jid: S.activeJid, message: text }),
  });

  if (res?.error) notify(res.error, 'error');
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
}

function handleInput(e) {
  const val = e.target.value;

  // Auto-resize
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';

  // Quick replies
  if (val.startsWith('/') || val.startsWith('/')) {
    showQRPopup(val.substring(1));
  } else {
    closeQRPopup();
  }

  // Typing indicator
  if (S.activeJid) {
    socket.emit('typing:start', { jid: S.activeJid });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      socket.emit('typing:stop', { jid: S.activeJid });
    }, 2000);
  }
}

function showRemoteTyping(text) {
  const el = document.getElementById('remote-typing');
  document.getElementById('typing-text').textContent = text;
  el.style.display = 'block';
  clearTimeout(S.typingTimers._remote);
  S.typingTimers._remote = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ═══════════════════════════════════════════════════════════════
// QUICK REPLIES
// ═══════════════════════════════════════════════════════════════

async function loadQuickReplies() {
  S.quickReplies = await apiFetch('/quick-replies') || [];
}

let qrPopupOpen = false;

function toggleQRPopup() {
  qrPopupOpen ? closeQRPopup() : showQRPopup('');
}

function showQRPopup(filter) {
  const popup = document.getElementById('qr-popup');
  const filtered = S.quickReplies.filter(q =>
    !filter ||
    (q.trigger_text || '').toLowerCase().includes(filter.toLowerCase()) ||
    q.name.toLowerCase().includes(filter.toLowerCase())
  );

  if (!filtered.length) { closeQRPopup(); return; }

  popup.style.display = 'block';
  popup.innerHTML = filtered.map(q => `
    <div class="qr-row" onclick="applyQR(${q.id})">
      <span class="qr-trigger">${esc(q.trigger_text || '/')}</span>
      <span class="qr-name">${esc(q.name)}</span>
      <span class="qr-preview">${esc(q.content.substring(0, 60))}</span>
    </div>`).join('');
  qrPopupOpen = true;
}

function closeQRPopup() {
  document.getElementById('qr-popup').style.display = 'none';
  qrPopupOpen = false;
}

function applyQR(id) {
  const q = S.quickReplies.find(r => r.id === id);
  if (!q) return;
  const conv = S.conversations.find(c => c.jid === S.activeJid);
  // Nombre: preferir nombre agendado real > push_name de WA > nada (no usar teléfono)
  const phone = conv?.jid?.split('@')[0] || '';
  const savedName = conv?.contact_saved_name && conv.contact_saved_name !== phone ? conv.contact_saved_name : null;
  const nombre = savedName || conv?.wa_push_name || conv?.contact_name !== phone ? conv?.contact_name : '';
  let text = q.content
    .replace(/\{\{nombre\}\}/gi, nombre || '')
    .replace(/\{\{empresa\}\}/gi, conv?.company || '')
    .replace(/\{\{extra\}\}/gi, '');
  const input = document.getElementById('msg-input');
  input.value = text;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  input.focus();
  closeQRPopup();
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGNS
// ═══════════════════════════════════════════════════════════════

async function loadCampaigns() {
  S.campaigns = await apiFetch('/campaigns') || [];
  renderCampaignsGrid();
}

function renderCampaignsGrid() {
  const el = document.getElementById('campaigns-grid');
  if (!S.campaigns.length) {
    el.innerHTML = '<div class="list-empty" style="grid-column:span 2">No hay campañas. Creá una para empezar.</div>';
    return;
  }
  el.innerHTML = S.campaigns.map(c => {
    const pct = c.total > 0 ? Math.round((c.sent / c.total) * 100) : 0;
    const canStart = c.status === 'draft' && c.total > 0;
    const isActive = c.status === 'running';
    const isDone = c.status === 'completed' || c.status === 'cancelled';
    return `
    <div class="camp-card">
      <div class="camp-card-top">
        <div>
          <div class="camp-card-name">${esc(c.name)}</div>
          <div class="camp-card-type">${c.type} · ${c.created_by_name || 'Sistema'}</div>
        </div>
        <span class="status-pill ${c.status}">${c.status}</span>
      </div>
      <div class="camp-template">${esc(c.template.substring(0, 120))}${c.template.length > 120 ? '...' : ''}</div>
      ${c.total > 0 ? `
        <div class="camp-progress"><div class="camp-progress-bar" style="width:${pct}%"></div></div>
        <div class="camp-stats">
          <span class="camp-stat">Total: <b>${c.total}</b></span>
          <span class="camp-stat sent">Enviados: <b>${c.sent}</b></span>
          <span class="camp-stat failed">Fallidos: <b>${c.failed}</b></span>
        </div>` : '<div style="font-size:12px;color:var(--text3)">Sin contactos cargados</div>'}
      <div class="camp-actions">
        ${canStart ? `<button class="btn-primary btn-sm" onclick="startCampaign(${c.id})">▶ Iniciar</button>` : ''}
        ${isActive ? `<button class="btn-danger btn-sm" onclick="cancelActiveCampaign()">⛔ Cancelar</button>` : ''}
        ${isDone ? `<button class="btn-secondary btn-sm" onclick="editCampaign(${c.id});setTimeout(()=>resetCampaign(),200)">↺ Reutilizar</button>` : ''}
        <button class="btn-secondary btn-sm" onclick="editCampaign(${c.id})" title="Ver y editar campaña">✏️ Editar</button>
        <button class="btn-secondary btn-sm" onclick="duplicateCampaign(${c.id})" title="Duplicar campaña">⧉</button>
        <button class="btn-danger btn-sm" onclick="deleteCampaignById(${c.id})" title="Eliminar campaña">🗑</button>
      </div>
    </div>`;
  }).join('');
}

// ─── Open modal ───────────────────────────────────────────────

function openCampaignModal() {
  document.getElementById('c-id').value = '';
  document.getElementById('c-name').value = '';
  document.getElementById('c-template').value = '';
  document.getElementById('c-contacts').value = '';
  document.getElementById('c-preview').style.display = 'none';
  document.getElementById('c-schedule').value = '';
  document.getElementById('c-dmin').value = '8';
  document.getElementById('c-dmax').value = '25';
  document.getElementById('c-type').value = 'general';
  document.getElementById('camp-modal-title').textContent = 'Nueva Campaña';
  document.getElementById('btn-save-camp').textContent = 'Crear campaña';
  document.getElementById('btn-delete-camp').style.display = 'none';
  document.getElementById('btn-reset-camp').style.display = 'none';
  document.getElementById('camp-contacts-tbody').innerHTML = '';
  document.getElementById('camp-contacts-count').textContent = '0';

  // Reset tab
  switchCampTab('info', document.querySelector('.modal-tab'));
  document.getElementById('camp-tab-contacts').style.display = 'none';

  openModal('modal-campaign');
}

async function editCampaign(id) {
  const c = S.campaigns.find(x => x.id === id);
  if (!c) return;

  document.getElementById('c-id').value = id;
  document.getElementById('c-name').value = c.name;
  document.getElementById('c-template').value = c.template;
  document.getElementById('c-type').value = c.type;
  document.getElementById('c-dmin').value = c.delay_min || 8;
  document.getElementById('c-dmax').value = c.delay_max || 25;
  document.getElementById('c-schedule').value = c.scheduled_at ? c.scheduled_at.substring(0,16) : '';
  document.getElementById('c-contacts').value = '';
  document.getElementById('c-preview').style.display = 'none';
  document.getElementById('camp-modal-title').textContent = `Editar: ${c.name}`;
  document.getElementById('btn-save-camp').textContent = 'Guardar cambios';
  document.getElementById('btn-delete-camp').style.display = c.status !== 'running' ? 'inline-flex' : 'none';
  document.getElementById('btn-reset-camp').style.display = (c.status === 'completed' || c.status === 'cancelled') ? 'inline-flex' : 'none';
  document.getElementById('camp-tab-contacts').style.display = '';

  switchCampTab('info', document.querySelector('.modal-tab'));
  openModal('modal-campaign');

  // Cargar contactos existentes
  await loadCampaignContactsList(id);
}

// ─── Tab switching ─────────────────────────────────────────────

function switchCampTab(name, btn) {
  document.getElementById('camp-tab-info').style.display = name === 'info' ? 'flex' : 'none';
  document.getElementById('camp-tab-contacts-body').style.display = name === 'contacts' ? 'flex' : 'none';
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

// ─── Contacts list inside modal ────────────────────────────────

async function loadCampaignContactsList(id) {
  const contacts = await apiFetch(`/campaigns/${id}/contacts`) || [];
  document.getElementById('camp-contacts-count').textContent = contacts.length;
  const tbody = document.getElementById('camp-contacts-tbody');
  if (!contacts.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text3)">Sin contactos</td></tr>';
    return;
  }
  tbody.innerHTML = contacts.map(c => {
    const statusIcon = c.status === 'sent' ? '✅' : c.status === 'failed' ? '❌' : '⏳';
    return `<tr>
      <td class="mono" style="font-size:11px">${c.phone}</td>
      <td>${esc(c.name||'—')}</td>
      <td>${esc(c.extra_field||'—')}</td>
      <td>${statusIcon} ${c.status}</td>
      <td><button class="btn-icon-sm" onclick="removeCampaignContact(${c.id})" title="Eliminar" ${c.status!=='pending'?'disabled':''}>🗑</button></td>
    </tr>`;
  }).join('');
}

async function removeCampaignContact(contactId) {
  const campId = document.getElementById('c-id').value;
  if (!campId) return;
  await apiFetch(`/campaigns/${campId}/contacts/${contactId}`, { method: 'DELETE' });
  await loadCampaignContactsList(campId);
  loadCampaigns();
}

async function addContactsToCampaign() {
  const campId = document.getElementById('c-id').value;
  if (!campId) { notify('Guardá la campaña primero', 'warning'); return; }

  const raw = document.getElementById('c-contacts').value.trim();
  if (!raw) { notify('Ingresá al menos un número', 'warning'); return; }

  const contacts = raw.split('\n').filter(l => l.trim()).map(line => {
    const [phone, name, extra] = line.split(',').map(s => s.trim());
    return { phone, name: name||'', extra: extra||'' };
  });

  const res = await apiFetch(`/campaigns/${campId}/contacts/add`, {
    method: 'POST',
    body: JSON.stringify({ contacts }),
  });

  if (res?.added !== undefined) {
    notify(`✅ ${res.added} contactos agregados · Total: ${res.total}`);
    document.getElementById('c-contacts').value = '';
    await loadCampaignContactsList(campId);
    loadCampaigns();
  } else {
    notify(res?.error || 'Error', 'error');
  }
}

// ─── Save (create or update) ───────────────────────────────────

async function saveCampaign() {
  const id = document.getElementById('c-id').value;
  const name = document.getElementById('c-name').value.trim();
  const template = document.getElementById('c-template').value.trim();
  if (!name || !template) { notify('Nombre y plantilla son obligatorios', 'error'); return; }

  const body = {
    name,
    type: document.getElementById('c-type').value,
    template,
    delay_min: parseInt(document.getElementById('c-dmin').value),
    delay_max: parseInt(document.getElementById('c-dmax').value),
    scheduled_at: document.getElementById('c-schedule').value || null,
  };

  if (id) {
    // Editar
    const res = await apiFetch(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    if (res?.ok) {
      // Si hay contactos en el textarea, agregarlos también
      const raw = document.getElementById('c-contacts').value.trim();
      if (raw) await addContactsToCampaign();
      notify('✅ Campaña actualizada');
      loadCampaigns();
    } else {
      notify(res?.error || 'Error actualizando', 'error');
    }
  } else {
    // Crear
    const raw = document.getElementById('c-contacts').value.trim();
    const contacts = raw ? raw.split('\n').filter(l => l.trim()).map(line => {
      const [phone, name2, extra] = line.split(',').map(s => s.trim());
      return { phone, name: name2||'', extra: extra||'' };
    }) : [];

    const res = await apiFetch('/campaigns', {
      method: 'POST',
      body: JSON.stringify({ ...body, contacts }),
    });

    if (res?.id) {
      document.getElementById('c-id').value = res.id;
      document.getElementById('camp-modal-title').textContent = `Editar: ${name}`;
      document.getElementById('btn-save-camp').textContent = 'Guardar cambios';
      document.getElementById('btn-delete-camp').style.display = 'inline-flex';
      document.getElementById('camp-tab-contacts').style.display = '';
      notify(`✅ Campaña "${name}" creada`);
      loadCampaigns();
      await loadCampaignContactsList(res.id);
      switchCampTab('contacts', document.querySelectorAll('.modal-tab')[1]);
    } else {
      notify(res?.error || 'Error creando campaña', 'error');
    }
  }
}

async function deleteCampaign() {
  const id = document.getElementById('c-id').value;
  const name = document.getElementById('c-name').value;
  if (!id) return;
  await deleteCampaignById(parseInt(id), name);
}

async function deleteCampaignById(id, name) {
  const c = S.campaigns.find(x => x.id === id);
  const label = name || c?.name || `#${id}`;
  if (!confirm(`¿Eliminar campaña "${label}"? Esta acción no se puede deshacer.`)) return;
  const res = await apiFetch(`/campaigns/${id}`, { method: 'DELETE' });
  if (res?.ok) {
    closeModal('modal-campaign');
    loadCampaigns();
    notify(`✅ Campaña eliminada`);
  } else {
    notify(res?.error || 'Error', 'error');
  }
}

async function duplicateCampaign(id) {
  const c = S.campaigns.find(x => x.id === id);
  if (!confirm(`¿Duplicar campaña "${c?.name}"?`)) return;
  const res = await apiFetch(`/campaigns/${id}/duplicate`, { method: 'POST' });
  if (res?.ok) {
    notify(`✅ Campaña duplicada como "${c?.name} (copia)"`);
    await loadCampaigns();
    // Abrir la copia para editarla
    if (res.id) editCampaign(res.id);
  } else {
    notify(res?.error || 'Error duplicando', 'error');
  }
}

async function resetCampaign() {
  const id = document.getElementById('c-id').value;
  if (!id) return;
  if (!confirm('¿Reiniciar campaña? Todos los contactos vuelven a "pendiente" para reenviar.')) return;
  const res = await apiFetch(`/campaigns/${id}/reset`, { method: 'POST' });
  if (res?.ok) {
    document.getElementById('btn-reset-camp').style.display = 'none';
    loadCampaigns();
    await loadCampaignContactsList(id);
    notify('✅ Campaña reiniciada — ya podés volver a iniciarla');
  } else {
    notify(res?.error || 'Error', 'error');
  }
}

function loadCampaignCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const lines = e.target.result.split('\n').filter(l => l.trim());
    const start = /nombre|phone|telefono/i.test(lines[0]) ? 1 : 0;
    document.getElementById('c-contacts').value = lines.slice(start).join('\n');
  };
  reader.readAsText(file);
}

function previewMsg() {
  const template = document.getElementById('c-template').value;
  const first = document.getElementById('c-contacts').value.trim().split('\n')[0];
  const sample = first || '549111234567,Usuario de Prueba,Extra';
  const [phone, name, extra] = sample.split(',').map(s => s.trim());
  const preview = template
    .replace(/\{\{nombre\}\}/gi, name || phone)
    .replace(/\{\{empresa\}\}/gi, '')
    .replace(/\{\{extra\}\}/gi, extra || '')
    .replace(/\{\{telefono\}\}/gi, phone);
  const el = document.getElementById('c-preview');
  el.textContent = preview;
  el.style.display = 'block';
}

async function startCampaign(id) {
  const res = await apiFetch(`/campaigns/${id}/start`, { method: 'POST' });
  if (res?.error) notify(res.error, 'error');
  else { S.activeCampaignId = id; loadCampaigns(); }
}

async function cancelActiveCampaign() {
  if (!S.activeCampaignId) return;
  await apiFetch(`/campaigns/${S.activeCampaignId}/cancel`, { method: 'POST' });
}

// legacy - replaced by editCampaign
async function viewCampaignContacts(id) { editCampaign(id); }
// legacy alias
async function createCampaign() { saveCampaign(); }



// ═══════════════════════════════════════════════════════════════
// CONTACTS
// ═══════════════════════════════════════════════════════════════

async function loadContacts() {
  S.contacts = await apiFetch('/contacts') || [];
  document.getElementById('contacts-count').textContent = `${S.contacts.length} contactos`;
  renderContactsTable();
}

function renderContactsTable() {
  const search = document.getElementById('contacts-search')?.value.toLowerCase() || '';
  let data = S.contacts;

  if (search) {
    data = data.filter(c =>
      (c.name || '').toLowerCase().includes(search) ||
      c.phone.includes(search) ||
      (c.company || '').toLowerCase().includes(search)
    );
  }

  if (S.contactsLabelFilter.length) {
    data = data.filter(c => {
      const ids = (c.labels || []).map(l => l.id);
      return S.contactsLabelFilter.some(f => ids.includes(f));
    });
  }

  const tbody = document.getElementById('contacts-tbody');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="list-empty" style="padding:40px">Sin contactos</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(c => {
    const labels = (c.labels || []).map(l =>
      `<span class="tl-pill" style="background:${l.color}20;color:${l.color};border:1px solid ${l.color}40">${esc(l.name)}</span>`
    ).join('');
    return `<tr>
      <td>${esc(c.name || '—')}</td>
      <td class="td-phone">${c.phone}</td>
      <td>${esc(c.company || '—')}</td>
      <td>${esc(c.extra || '—')}</td>
      <td><div class="td-labels">${labels}</div></td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="btn-icon-sm" onclick="sendDirectMessage('${c.phone}','${esc(c.name||c.phone)}')" title="Enviar mensaje">💬</button>
          <button class="btn-icon-sm" onclick="openContactModal(${c.id})" title="Editar">✏️</button>
          <button class="btn-icon-sm" onclick="deleteContact(${c.id})" title="Eliminar">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openContactModal(id) {
  const c = id ? S.contacts.find(x => x.id === id) : null;
  document.getElementById('contact-modal-title').textContent = c ? 'Editar contacto' : 'Agregar contacto';
  document.getElementById('ct-id').value = c?.id || '';
  document.getElementById('ct-phone').value = c?.phone || '';
  document.getElementById('ct-name').value = c?.name || '';
  document.getElementById('ct-company').value = c?.company || '';
  document.getElementById('ct-extra').value = c?.extra || '';
  document.getElementById('ct-notes').value = c?.notes || '';
  openModal('modal-contact');
}

async function saveContact() {
  const id = document.getElementById('ct-id').value;
  const body = {
    phone: document.getElementById('ct-phone').value.replace(/\D/g, ''),
    name: document.getElementById('ct-name').value,
    company: document.getElementById('ct-company').value,
    extra: document.getElementById('ct-extra').value,
    notes: document.getElementById('ct-notes').value,
  };
  if (!body.phone) { notify('El teléfono es obligatorio', 'error'); return; }
  if (id) await apiFetch(`/contacts/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  else await apiFetch('/contacts', { method: 'POST', body: JSON.stringify(body) });
  closeModal('modal-contact');
  await loadContacts();
  notify('✅ Contacto guardado');
}

async function deleteContact(id) {
  if (!confirm('¿Eliminar este contacto?')) return;
  await apiFetch(`/contacts/${id}`, { method: 'DELETE' });
  await loadContacts();
}

async function importCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/contacts/import', { method: 'POST', body: formData, credentials: 'include' });
  const data = await res.json();
  notify(`✅ Importados: ${data.imported} · Omitidos: ${data.skipped}`);
  await loadContacts();
  event.target.value = '';
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════

async function renderSettings() {
  const autoReply = await apiFetch('/auto-reply') || {};
  const isAdmin = S.me?.role === 'admin';

  document.getElementById('settings-grid').innerHTML = `
    <!-- WhatsApp -->
    <div class="settings-card">
      <h3>💬 WhatsApp</h3>
      <div id="wa-status-card" style="margin-bottom:12px;font-size:13px;color:var(--text2)">
        Hacé clic en el estado de conexión en la barra lateral para ver el QR.
      </div>
      ${isAdmin ? `<button class="btn-danger btn-sm" onclick="waLogout()">⚠️ Cerrar sesión WA</button>` : ''}
    </div>

    <!-- Quick Replies -->
    <div class="settings-card">
      <h3>⚡ Respuestas rápidas</h3>
      <div id="qr-list-settings"></div>
      <button class="btn-secondary btn-sm" style="margin-top:8px" onclick="openQRModal()">+ Agregar</button>
    </div>

    <!-- File Library -->
    <div class="settings-card">
      <h3>📎 Biblioteca de archivos</h3>
      <p style="font-size:12px;color:var(--text3);margin-bottom:12px">Archivos precargados para enviar desde los chats (PDF, imágenes, documentos).</p>
      <div id="files-settings-preview" style="margin-bottom:10px"></div>
      <button class="btn-primary btn-sm" onclick="openFileLibraryModal()">📁 Gestionar archivos</button>
    </div>

    <!-- Labels -->
    <div class="settings-card">
      <h3>🏷️ Etiquetas</h3>
      <div id="labels-list-settings"></div>
      <button class="btn-secondary btn-sm" style="margin-top:8px" onclick="openLabelModal()">+ Crear etiqueta</button>
    </div>

    <!-- Auto Reply -->
    <div class="settings-card full">
      <h3>🤖 Auto-respuesta fuera de horario</h3>
      <div style="display:grid;grid-template-columns:auto 1fr 1fr 1fr;gap:12px;align-items:end;margin-bottom:14px">
        <div class="field">
          <label>Estado</label>
          <button class="toggle ${autoReply.is_active ? 'on' : ''}" id="ar-toggle" onclick="this.classList.toggle('on')"></button>
        </div>
        <div class="field"><label>Hora inicio</label><input class="input" type="time" id="ar-start" value="${autoReply.schedule_start || '09:00'}"></div>
        <div class="field"><label>Hora fin</label><input class="input" type="time" id="ar-end" value="${autoReply.schedule_end || '18:00'}"></div>
        <div class="field"><label>Zona horaria</label>
          <select class="input" id="ar-timezone">
            ${[
              ['Europe/Madrid','España (Madrid)'],
              ['America/Argentina/Buenos_Aires','Argentina (Buenos Aires)'],
              ['America/Mexico_City','México (CDMX)'],
              ['America/Bogota','Colombia (Bogotá)'],
              ['America/Santiago','Chile (Santiago)'],
              ['America/Lima','Perú (Lima)'],
              ['America/New_York','USA Eastern'],
              ['America/Los_Angeles','USA Pacific'],
              ['UTC','UTC'],
            ].map(([v,l]) => `<option value="${v}" ${(autoReply.timezone || 'Europe/Madrid') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Días hábiles</label><input class="input" id="ar-days" value="${autoReply.working_days || '1,2,3,4,5'}" placeholder="1=Lun...7=Dom"></div>
      </div>
      <div class="field" style="margin-bottom:12px">
        <label>Mensaje inicial fuera de horario</label>
        <textarea class="input" id="ar-msg" rows="4">${esc(autoReply.greeting_message || '')}</textarea>
      </div>
      <div class="field" style="margin-bottom:16px">
        <label>Campos a recopilar (separados por coma)</label>
        <input class="input" id="ar-fields" value="${JSON.parse(autoReply.collect_fields || '["name","email","phone","reason"]').join(',')}">
        <p class="field-hint">Opciones: <code>name</code> <code>email</code> <code>phone</code> <code>reason</code></p>
      </div>
      <div style="background:var(--blue-light);border:1px solid #bfdbfe;border-radius:var(--radius);padding:12px;margin-bottom:14px">
        <p style="font-size:12px;color:#1e40af;font-weight:600;margin-bottom:4px">🔮 Integración IA futura</p>
        <p style="font-size:12px;color:#3b82f6">Endpoint listo: <code style="background:white;padding:1px 5px;border-radius:4px">POST /api/ai/respond</code> con <code style="background:white;padding:1px 5px;border-radius:4px">{ jid, response }</code></p>
      </div>
      <button class="btn-primary btn-sm" onclick="saveAutoReply()">💾 Guardar</button>
    </div>

    <!-- Users (solo admin) -->
    ${isAdmin ? `
    <div class="settings-card full">
      <h3>👥 Agentes del equipo</h3>
      <div id="users-list-settings"></div>
      <button class="btn-secondary btn-sm" style="margin-top:10px" onclick="openUserModal()">+ Agregar agente</button>
    </div>` : ''}

    <!-- Agente IA (solo admin) -->
    ${isAdmin ? `
    <div class="settings-card full" id="ai-config-card">
      <h3>🤖 Agente IA <span id="ai-status-pill" style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--surface2);color:var(--text3);font-weight:400;margin-left:8px">Cargando...</span></h3>
      <p style="font-size:12px;color:var(--text3);margin-bottom:14px">Respuestas automáticas inteligentes usando IA. Se activa fuera del horario laboral o cuando configurés.</p>
      <div id="ai-config-form">Cargando configuración...</div>
    </div>` : ''}

    <!-- Sistema (solo admin) -->
    ${isAdmin ? `
    <div class="settings-card full" id="system-admin-card">
      <h3>⚙️ Administración del sistema</h3>
      <p style="font-size:12px;color:var(--text3);margin-bottom:16px">Herramientas de mantenimiento. Todas las acciones requieren tu contraseña de acceso.</p>
      <div id="system-stats-box" style="margin-bottom:20px">Cargando estadísticas...</div>

      <hr style="border:none;border-top:1px solid var(--border);margin-bottom:20px">

      <h4 style="margin-bottom:4px">🔧 Reparar base de datos</h4>
      <p style="font-size:12px;color:var(--text3);margin-bottom:10px">Aplica migraciones faltantes, corrige índices y valores NULL. Seguro de ejecutar en cualquier momento.</p>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="min-width:180px">
          <label>Tu contraseña</label>
          <input class="input" type="password" id="sys-pwd-repair" placeholder="••••••••">
        </div>
        <button class="btn-secondary" onclick="systemRepairDB()">🔧 Reparar DB</button>
      </div>
      <div id="repair-result" style="margin-top:8px;font-size:12px"></div>

      <hr style="border:none;border-top:1px solid var(--border);margin:20px 0">

      <h4 style="margin-bottom:4px">📥 Recuperar mensajes</h4>
      <p style="font-size:12px;color:var(--text3);margin-bottom:10px">
        Si los chats muestran "Sin mensajes aún", usá estas opciones para recuperarlos.
      </p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
        <div class="field" style="min-width:180px">
          <label>Tu contraseña</label>
          <input class="input" type="password" id="sys-pwd-seed" placeholder="••••••••">
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button class="btn-secondary" onclick="systemSeedMessages()" title="Genera mensajes sintéticos desde el último mensaje de cada conversación">
            💾 Seed desde conversaciones
          </button>
          <button class="btn-secondary" onclick="systemMergeDuplicates()" title="Fusiona conversaciones duplicadas del mismo número (ej: con/sin 9 en Argentina)">
            🔀 Fusionar duplicados
          </button>
          <button class="btn-secondary" onclick="systemResyncHistory()" title="Pide a WhatsApp que reenvíe el historial de mensajes">
            🔄 Re-sincronizar historial WA
          </button>
        </div>
      </div>
      <div id="seed-result" style="font-size:12px;color:var(--text3)">
        El <b>Seed</b> crea un mensaje por chat usando el último mensaje guardado. El <b>Re-sync</b> le pide al teléfono que reenvíe el historial completo (puede tardar varios minutos).
      </div>

      <hr style="border:none;border-top:1px solid var(--border);margin:20px 0">

      <h4 style="margin-bottom:4px;color:var(--red)">🗑️ Resetear datos</h4>
      <p style="font-size:12px;color:var(--text3);margin-bottom:10px">Elimina mensajes, conversaciones o contactos. <b>Irreversible.</b> No afecta usuarios, configuración ni sesión de WhatsApp.</p>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="min-width:160px">
          <label>¿Qué eliminar?</label>
          <select class="input" id="sys-reset-scope">
            <option value="messages">Solo mensajes</option>
            <option value="conversations">Conversaciones (sin contactos)</option>
            <option value="contacts">Solo contactos</option>
            <option value="activity">Solo log de actividad</option>
            <option value="all">TODO (mensajes + convs + contactos + log)</option>
          </select>
        </div>
        <div class="field" style="min-width:180px">
          <label>Tu contraseña</label>
          <input class="input" type="password" id="sys-pwd-reset" placeholder="••••••••">
        </div>
        <button class="btn-danger" onclick="systemReset()">⚠️ Resetear</button>
      </div>
    </div>` : ''}
  `;

  renderQRListSettings();
  renderLabelsListSettings();
  if (isAdmin) {
    renderUsersListSettings();
    loadAIConfig();
    loadSystemStats();
  }
}

function renderQRListSettings() {
  const el = document.getElementById('qr-list-settings');
  if (!el) return;
  el.innerHTML = S.quickReplies.map(q => `
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">${esc(q.name)}</div>
        <div class="setting-item-sub">${esc(q.trigger_text || '')} · ${q.category}</div>
      </div>
      <button class="btn-icon-sm" onclick="openQRModal(${q.id})">✏️</button>
      <button class="btn-icon-sm" onclick="deleteQR(${q.id})">🗑</button>
    </div>`).join('');
}

function renderLabelsListSettings() {
  const el = document.getElementById('labels-list-settings');
  if (!el) return;
  el.innerHTML = S.labels.map(l => `
    <div class="setting-item">
      <div style="width:12px;height:12px;border-radius:50%;background:${l.color};flex-shrink:0"></div>
      <div class="setting-item-info">
        <div class="setting-item-name">${esc(l.name)}</div>
        ${l.description ? `<div class="setting-item-sub">${esc(l.description)}</div>` : ''}
      </div>
      <button class="btn-icon-sm" onclick="openLabelModal(${l.id})">✏️</button>
      <button class="btn-icon-sm" onclick="deleteLabel(${l.id})">🗑</button>
    </div>`).join('');
}

function renderUsersListSettings() {
  const el = document.getElementById('users-list-settings');
  if (!el) return;
  el.innerHTML = S.users.map(u => `
    <div class="setting-item">
      <div class="user-avatar" style="background:${u.color};width:28px;height:28px;font-size:11px">${u.display_name[0]}</div>
      <div class="setting-item-info">
        <div class="setting-item-name">${esc(u.display_name)} <span style="font-size:11px;color:var(--text3)">(${u.username})</span></div>
        <div class="setting-item-sub">${u.role} ${!u.is_active ? '· desactivado' : ''}</div>
      </div>
      <button class="btn-icon-sm" onclick="openUserModal(${u.id})">✏️</button>
    </div>`).join('');
}

// Quick Replies CRUD
function openQRModal(id) {
  const q = id ? S.quickReplies.find(r => r.id === id) : null;
  document.getElementById('qre-title').textContent = q ? 'Editar respuesta rápida' : 'Nueva respuesta rápida';
  document.getElementById('qre-id').value = q?.id || '';
  document.getElementById('qre-name').value = q?.name || '';
  document.getElementById('qre-trigger').value = q?.trigger_text || '';
  document.getElementById('qre-category').value = q?.category || 'general';
  document.getElementById('qre-content').value = q?.content || '';
  openModal('modal-qr-edit');
}

async function saveQR() {
  const id = document.getElementById('qre-id').value;
  const body = {
    name: document.getElementById('qre-name').value,
    trigger_text: document.getElementById('qre-trigger').value,
    category: document.getElementById('qre-category').value,
    content: document.getElementById('qre-content').value,
  };
  if (id) await apiFetch(`/quick-replies/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  else await apiFetch('/quick-replies', { method: 'POST', body: JSON.stringify(body) });
  closeModal('modal-qr-edit');
  await loadQuickReplies();
  renderQRListSettings();
  notify('✅ Respuesta rápida guardada');
}

async function deleteQR(id) {
  if (!confirm('¿Eliminar?')) return;
  await apiFetch(`/quick-replies/${id}`, { method: 'DELETE' });
  await loadQuickReplies();
  renderQRListSettings();
}

// Labels CRUD
function openLabelModal(id) {
  const l = id ? S.labels.find(x => x.id === id) : null;
  document.getElementById('lbl-title').textContent = l ? 'Editar etiqueta' : 'Nueva etiqueta';
  document.getElementById('lbl-id').value = l?.id || '';
  document.getElementById('lbl-name').value = l?.name || '';
  document.getElementById('lbl-color').value = l?.color || '#3b82f6';
  document.getElementById('lbl-desc').value = l?.description || '';
  openModal('modal-label');
}

async function saveLabel() {
  const id = document.getElementById('lbl-id').value;
  const body = {
    name: document.getElementById('lbl-name').value,
    color: document.getElementById('lbl-color').value,
    description: document.getElementById('lbl-desc').value,
  };
  if (!body.name) { notify('El nombre es obligatorio', 'error'); return; }
  if (id) await apiFetch(`/labels/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  else await apiFetch('/labels', { method: 'POST', body: JSON.stringify(body) });
  closeModal('modal-label');
  await loadLabels();
  renderLabelsListSettings();
  notify('✅ Etiqueta guardada');
}

async function deleteLabel(id) {
  if (!confirm('¿Eliminar esta etiqueta? Se quitará de todas las conversaciones.')) return;
  await apiFetch(`/labels/${id}`, { method: 'DELETE' });
  await loadLabels();
  renderLabelsListSettings();
}

// Auto Reply
async function saveAutoReply() {
  const fieldsRaw = document.getElementById('ar-fields').value;
  const fields = fieldsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const res = await apiFetch('/auto-reply', {
    method: 'PUT',
    body: JSON.stringify({
      is_active: document.getElementById('ar-toggle').classList.contains('on'),
      schedule_start: document.getElementById('ar-start').value,
      schedule_end: document.getElementById('ar-end').value,
      timezone: document.getElementById('ar-timezone').value,
      working_days: document.getElementById('ar-days').value,
      greeting_message: document.getElementById('ar-msg').value,
      collect_fields: fields,
    }),
  });
  if (res?.ok) notify('✅ Auto-respuesta guardada');
}

// Users CRUD
function openUserModal(id) {
  const u = id ? S.users.find(x => x.id === id) : null;
  document.getElementById('usr-title').textContent = u ? 'Editar agente' : 'Nuevo agente';
  document.getElementById('usr-id').value = u?.id || '';
  document.getElementById('usr-username').value = u?.username || '';
  document.getElementById('usr-display').value = u?.display_name || '';
  document.getElementById('usr-password').value = '';
  document.getElementById('usr-color').value = u?.color || '#6366f1';
  document.getElementById('usr-role').value = u?.role || 'agent';
  // is_active: null se trata como activo para usuarios existentes, 1 para nuevos
  document.getElementById('usr-active').value = (u && u.is_active === 0) ? '0' : '1';
  openModal('modal-user');
}

async function saveUser() {
  const id = document.getElementById('usr-id').value;
  const body = {
    username:     document.getElementById('usr-username').value,
    display_name: document.getElementById('usr-display').value,
    password:     document.getElementById('usr-password').value || undefined,
    color:        document.getElementById('usr-color').value,
    role:         document.getElementById('usr-role').value,
    is_active:    parseInt(document.getElementById('usr-active').value),
  };
  if (!id && !body.password) { notify('La contraseña es obligatoria para nuevos agentes', 'error'); return; }
  const res = id
    ? await apiFetch(`/users/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    : await apiFetch('/users', { method: 'POST', body: JSON.stringify(body) });
  if (res?.ok === false || res?.error) { notify(res?.error || 'Error guardando', 'error'); return; }
  closeModal('modal-user');
  await loadUsers();
  renderUsersListSettings();
  notify('✅ Agente guardado');
}

async function waLogout() {
  if (!confirm('¿Cerrar sesión de WhatsApp? Necesitarás escanear el QR de nuevo.')) return;
  await apiFetch('/wa/logout', { method: 'POST' });
  notify('Sesión de WhatsApp cerrada. Escaneá el QR para reconectar.', 'warning');
}

// ═══════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// Click outside to close
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// Escape to close
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    closeQRPopup();
  }
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════

function notify(text, type = 'info') {
  const el = document.getElementById('notifications');
  const n = document.createElement('div');
  n.className = `notif ${type === 'error' ? 'error' : type === 'warning' ? 'warning' : ''}`;
  n.textContent = text;
  el.appendChild(n);
  setTimeout(() => n.remove(), 4000);
}

// Banner de sincronización — se muestra mientras Baileys importa el historial
let _syncBannerTimeout = null;
function showSyncBanner() {
  let banner = document.getElementById('sync-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'sync-banner';
    banner.innerHTML = `
      <span class="sync-spinner"></span>
      <span>Sincronizando historial de WhatsApp... los mensajes aparecerán en breve</span>
      <button onclick="hideSyncBanner()" style="margin-left:auto;background:none;border:none;color:inherit;cursor:pointer;font-size:16px">✕</button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
  }
  banner.style.display = 'flex';
  // Auto-ocultar después de 3 minutos si no llegó el evento history:synced
  clearTimeout(_syncBannerTimeout);
  _syncBannerTimeout = setTimeout(() => hideSyncBanner(), 3 * 60 * 1000);
}
function hideSyncBanner() {
  const banner = document.getElementById('sync-banner');
  if (banner) banner.style.display = 'none';
  clearTimeout(_syncBannerTimeout);
}

function showDesktopNotif(title, body) {
  if (Notification.permission === 'granted') {
    new Notification(`WA CRM — ${title}`, { body: body.substring(0, 100) });
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  const now = new Date();
  if (isNaN(d)) return '';
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

async function doLogout() {
  await apiFetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ═══════════════════════════════════════════════════════════════
// AGENTE IA
// ═══════════════════════════════════════════════════════════════

async function loadAIConfig() {
  const cfg = await apiFetch('/ai-config') || {};
  const docs = await apiFetch('/ai-documents') || [];

  const pill = document.getElementById('ai-status-pill');
  if (pill) {
    pill.textContent = cfg.is_active ? '✅ Activo' : '⏸ Inactivo';
    pill.style.background = cfg.is_active ? 'var(--wa-light)' : 'var(--surface2)';
    pill.style.color = cfg.is_active ? 'var(--wa)' : 'var(--text3)';
  }

  const form = document.getElementById('ai-config-form');
  if (!form) return;

  const MODELS = {
    gemini:    ['gemini-1.5-flash (gratis)', 'gemini-1.5-pro', 'gemini-2.0-flash'],
    groq:      ['llama3-8b-8192 (gratis)', 'llama3-70b-8192 (gratis)', 'mixtral-8x7b-32768 (gratis)'],
    openai:    ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
  };
  const MODEL_VALUES = {
    gemini:    ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
    groq:      ['llama3-8b-8192', 'llama3-70b-8192', 'mixtral-8x7b-32768'],
    openai:    ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
  };

  const prov = cfg.provider || 'gemini';
  const modelOptions = (MODEL_VALUES[prov] || []).map((v, i) =>
    `<option value="${v}" ${cfg.model === v ? 'selected' : ''}>${MODELS[prov][i]}</option>`
  ).join('');

  const FREE_BADGE = '<span style="font-size:10px;background:#dcfce7;color:#16a34a;padding:1px 6px;border-radius:10px;margin-left:4px">GRATIS</span>';

  form.innerHTML = `
    <div style="background:var(--blue-light);border:1px solid #bfdbfe;border-radius:var(--radius);padding:10px 14px;margin-bottom:16px;font-size:12px;color:#1e40af">
      💡 <b>Gemini</b> y <b>Groq</b> tienen planes gratuitos generosos para empezar.
      Gemini: <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a> ·
      Groq: <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a>
    </div>

    <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:14px;align-items:end;margin-bottom:14px">
      <div class="field">
        <label>Estado</label>
        <button class="toggle ${cfg.is_active ? 'on' : ''}" id="ai-toggle" onclick="this.classList.toggle('on')"></button>
      </div>
      <div class="field">
        <label>Proveedor</label>
        <select class="input" id="ai-provider" onchange="updateAIModels(this.value)">
          <option value="gemini"    ${prov==='gemini'?'selected':''}>Google Gemini ${FREE_BADGE}</option>
          <option value="groq"      ${prov==='groq'?'selected':''}>Groq ${FREE_BADGE}</option>
          <option value="openai"    ${prov==='openai'?'selected':''}>OpenAI</option>
          <option value="anthropic" ${prov==='anthropic'?'selected':''}>Anthropic</option>
        </select>
      </div>
      <div class="field">
        <label>Modelo</label>
        <select class="input" id="ai-model">${modelOptions}</select>
      </div>
    </div>

    <div class="field" style="margin-bottom:12px">
      <label>API Key ${cfg.api_key_set ? '<span style="color:var(--wa);font-size:11px">✓ configurada</span>' : '<span style="color:var(--amber);font-size:11px">requerida</span>'}</label>
      <input class="input mono" id="ai-apikey" type="password" placeholder="${cfg.api_key_set ? 'Dejá vacío para mantener la actual' : 'Pegá tu API key aquí'}">
    </div>

    <div class="form-row-2" style="margin-bottom:12px">
      <div class="field">
        <label>Nombre de la empresa</label>
        <input class="input" id="ai-company" value="${esc(cfg.company_name || '')}">
      </div>
      <div class="field">
        <label>Activación</label>
        <select class="input" id="ai-only-outside">
          <option value="1" ${cfg.only_outside_hours !== 0 ? 'selected' : ''}>Solo fuera de horario</option>
          <option value="0" ${cfg.only_outside_hours === 0 ? 'selected' : ''}>Siempre activo</option>
        </select>
      </div>
    </div>

    <div class="form-row-2" style="margin-bottom:12px">
      <div class="field"><label>Hora inicio</label><input class="input" type="time" id="ai-h-start" value="${cfg.working_hours_start||'09:00'}"></div>
      <div class="field"><label>Hora fin</label><input class="input" type="time" id="ai-h-end" value="${cfg.working_hours_end||'18:00'}"></div>
    </div>

    <div class="field" style="margin-bottom:12px">
      <label>Contexto de la empresa</label>
      <textarea class="input" id="ai-context" rows="5" placeholder="Ej: Somos Turismo Patagonia. Ofrecemos excursiones a glaciares, trekking y pesca. Precios: excursión glaciar $150USD, trekking $80USD. Atendemos de lunes a sábado 8-18hs...">${esc(cfg.company_context || '')}</textarea>
      <p class="field-hint">Cuanto más detallado, mejor responderá. Podés completar con documentos abajo.</p>
    </div>

    <div class="field" style="margin-bottom:16px">
      <label>Instrucciones / Restricciones</label>
      <textarea class="input" id="ai-prompt" rows="2" placeholder="Ej: Nunca confirmes reservas directamente. Si preguntan por grupos +10, derivá al email...">${esc(cfg.system_prompt || '')}</textarea>
    </div>

    <div class="form-row-2" style="margin-bottom:16px">
      <div class="field"><label>Delay mín (seg)</label><input class="input" type="number" id="ai-delay-min" value="${cfg.response_delay_min||3}" min="1" max="30"></div>
      <div class="field"><label>Delay máx (seg)</label><input class="input" type="number" id="ai-delay-max" value="${cfg.response_delay_max||8}" min="2" max="60"></div>
    </div>

    <button class="btn-primary" onclick="saveAIConfig()" style="margin-bottom:16px">💾 Guardar configuración IA</button>

    <!-- PANEL DE TEST + MÉTRICAS (Agente v2) -->
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h4 style="margin:0;font-size:13px">🧪 Probar agente IA v2</h4>
        <button class="btn-secondary" onclick="loadAIMetrics()" style="font-size:11px;padding:4px 10px">📊 Ver métricas</button>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div class="field" style="flex:1;margin:0">
          <input class="input" id="ai-test-input" placeholder='Ej: "Hola, ¿cuánto cuesta el servicio grupal?"' style="width:100%">
        </div>
        <button class="btn-secondary" onclick="testAIAgent()" style="white-space:nowrap">▶ Probar</button>
        <button class="btn-secondary" onclick="invalidateAICache()" title="Forzar recarga del system prompt" style="white-space:nowrap;font-size:11px">🔄 Cache</button>
      </div>
      <div id="ai-test-result" style="margin-top:10px;display:none"></div>
    </div>
    <div id="ai-metrics-box" style="display:none;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:16px"></div>

    <hr style="border:none;border-top:1px solid var(--border);margin-bottom:20px">

    <h4 style="margin-bottom:4px">📄 Documentos de contexto</h4>
    <p style="font-size:12px;color:var(--text3);margin-bottom:14px">Subí PDFs o archivos de texto con información del negocio. La IA los usará como referencia.</p>

    <div id="ai-docs-list" style="margin-bottom:14px">${renderAIDocsList(docs)}</div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="flex:1;min-width:160px">
        <label>Nombre del documento</label>
        <input class="input" id="ai-doc-name" placeholder="Ej: Tarifario 2025">
      </div>
      <div class="field" style="flex:1;min-width:160px">
        <label>Archivo (PDF o .txt)</label>
        <input class="input" type="file" id="ai-doc-file" accept=".pdf,.txt,.md" style="padding:4px">
      </div>
      <button class="btn-secondary" onclick="uploadAIDocument()" style="white-space:nowrap">📤 Subir</button>
    </div>

    <div class="field" style="margin-top:12px">
      <label>O pegar texto directamente</label>
      <textarea class="input" id="ai-doc-text" rows="3" placeholder="Pegá aquí preguntas frecuentes, políticas, horarios, etc."></textarea>
      <button class="btn-secondary btn-sm" style="margin-top:6px" onclick="uploadAIDocumentText()">💾 Guardar texto</button>
    </div>
  `;
}

function renderAIDocsList(docs) {
  if (!docs.length) return '<p style="font-size:12px;color:var(--text3)">No hay documentos cargados aún.</p>';
  return docs.map(d => `
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">${esc(d.name)} <span style="font-size:10px;color:var(--text3)">${d.file_type?.toUpperCase()}</span></div>
        <div class="setting-item-sub">${Math.round((d.size||0)/1024)}KB · ${d.is_active ? '✅ activo' : '⏸ inactivo'}</div>
      </div>
      <button class="btn-icon-sm" onclick="toggleAIDoc(${d.id})" title="${d.is_active ? 'Desactivar' : 'Activar'}">${d.is_active ? '✅' : '⏸'}</button>
      <button class="btn-icon-sm" onclick="deleteAIDoc(${d.id})" title="Eliminar">🗑</button>
    </div>`).join('');
}

function updateAIModels(provider) {
  const MODEL_VALUES = {
    gemini:    ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
    groq:      ['llama3-8b-8192', 'llama3-70b-8192', 'mixtral-8x7b-32768'],
    openai:    ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
  };
  const MODELS = {
    gemini:    ['gemini-1.5-flash (gratis)', 'gemini-1.5-pro', 'gemini-2.0-flash'],
    groq:      ['llama3-8b-8192 (gratis)', 'llama3-70b-8192 (gratis)', 'mixtral-8x7b-32768 (gratis)'],
    openai:    ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'],
  };
  const sel = document.getElementById('ai-model');
  if (!sel) return;
  sel.innerHTML = (MODEL_VALUES[provider] || []).map((v, i) =>
    `<option value="${v}">${MODELS[provider][i]}</option>`
  ).join('');
}

// Mantener updateModelOptions como alias para compatibilidad
function updateModelOptions(provider) { updateAIModels(provider); }

async function uploadAIDocument() {
  const name = document.getElementById('ai-doc-name')?.value?.trim();
  const fileInput = document.getElementById('ai-doc-file');
  const file = fileInput?.files?.[0];
  if (!file) { notify('Seleccioná un archivo primero', 'error'); return; }
  const fd = new FormData();
  fd.append('name', name || file.name);
  fd.append('file', file);
  const res = await fetch('/api/ai-documents', { method: 'POST', body: fd });
  const data = await res.json();
  if (data.ok) { notify('✅ Documento cargado'); loadAIConfig(); }
  else notify(data.error || 'Error', 'error');
}

async function uploadAIDocumentText() {
  const name = document.getElementById('ai-doc-name')?.value?.trim();
  const text = document.getElementById('ai-doc-text')?.value?.trim();
  if (!name) { notify('Escribí un nombre para el documento', 'error'); return; }
  if (!text) { notify('El texto está vacío', 'error'); return; }
  const res = await apiFetch('/ai-documents', {
    method: 'POST',
    body: JSON.stringify({ name, text_content: text }),
  });
  if (res?.ok) { notify('✅ Texto guardado'); loadAIConfig(); }
  else notify(res?.error || 'Error', 'error');
}

async function toggleAIDoc(id) {
  await apiFetch(`/ai-documents/${id}/toggle`, { method: 'PUT', body: '{}' });
  loadAIConfig();
}

async function deleteAIDoc(id) {
  if (!confirm('¿Eliminar este documento?')) return;
  await apiFetch(`/ai-documents/${id}`, { method: 'DELETE' });
  loadAIConfig();
}

async function saveAIConfig() {
  const body = {
    is_active: document.getElementById('ai-toggle')?.classList.contains('on') ? 1 : 0,
    provider:  document.getElementById('ai-provider')?.value,
    model:     document.getElementById('ai-model')?.value,
    api_key:   document.getElementById('ai-apikey')?.value || null,
    company_name:    document.getElementById('ai-company')?.value,
    company_context: document.getElementById('ai-context')?.value,
    system_prompt:   document.getElementById('ai-prompt')?.value,
    only_outside_hours: parseInt(document.getElementById('ai-only-outside')?.value),
    working_hours_start: document.getElementById('ai-h-start')?.value,
    working_hours_end:   document.getElementById('ai-h-end')?.value,
    response_delay_min: parseInt(document.getElementById('ai-delay-min')?.value),
    response_delay_max: parseInt(document.getElementById('ai-delay-max')?.value),
    max_tokens: 400,
    temperature: 0.7,
  };

  const res = await apiFetch('/ai-config', { method: 'PUT', body: JSON.stringify(body) });
  if (res?.ok) {
    notify('✅ Configuración IA guardada');
    loadAIConfig(); // refrescar pill de estado
  } else {
    notify(res?.error || 'Error guardando', 'error');
  }
}

async function testAIAgent() {
  const input = document.getElementById('ai-test-input');
  const resultEl = document.getElementById('ai-test-result');
  const msg = input?.value?.trim();
  if (!msg) { notify('Escribí un mensaje de prueba', 'warning'); return; }

  resultEl.style.display = 'block';
  resultEl.innerHTML = `<div style="color:var(--text3);font-size:13px">⏳ Consultando a la IA v2...</div>`;

  const res = await apiFetch('/ai/test', { method: 'POST', body: JSON.stringify({ message: msg }) });

  if (res?.ok) {
    const tokenInfo = res.tokens_used
      ? `<span style="margin-left:8px;opacity:.7">${res.tokens_used} tokens usados · ~${res.prompt_tokens_est} prompt</span>`
      : '';
    resultEl.innerHTML = `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px">
        <div style="font-size:11px;color:#16a34a;margin-bottom:6px">
          ✅ ${res.provider} / ${res.model} — ${res.elapsed_ms}ms${tokenInfo}
        </div>
        <div style="font-size:13px;color:var(--text1);white-space:pre-wrap">${esc(res.response)}</div>
      </div>`;
  } else {
    resultEl.innerHTML = `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px">
        <div style="font-size:12px;color:#dc2626">❌ Error: ${esc(res?.error || 'Error desconocido')}</div>
      </div>`;
  }
}

async function loadAIMetrics() {
  const box = document.getElementById('ai-metrics-box');
  if (!box) return;
  box.style.display = 'block';
  box.innerHTML = '<div style="font-size:12px;color:var(--text3)">⏳ Cargando métricas...</div>';

  const res = await apiFetch('/ai/metrics');
  if (!res?.ok) { box.innerHTML = '<div style="color:#dc2626;font-size:12px">Error cargando métricas</div>'; return; }

  const m = res.metrics;
  const byJidRows = Object.entries(m.by_jid || {}).map(([jid, s]) =>
    `<tr>
      <td style="font-family:monospace;font-size:11px">${esc(jid)}</td>
      <td style="text-align:center">${s.calls}</td>
      <td style="text-align:center">${s.tokens.toLocaleString()}</td>
      <td style="text-align:center">${s.last_ms}ms</td>
      <td style="text-align:center;color:${s.errors>0?'#dc2626':'#16a34a'}">${s.errors}</td>
    </tr>`
  ).join('');

  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h4 style="margin:0;font-size:13px">📊 Métricas agente IA v2</h4>
      <button class="btn-secondary" onclick="document.getElementById('ai-metrics-box').style.display='none'" style="font-size:11px;padding:3px 8px">✕</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
      <div style="background:var(--surface1);border-radius:6px;padding:8px;text-align:center">
        <div style="font-size:18px;font-weight:700">${m.total_calls}</div>
        <div style="font-size:11px;color:var(--text3)">Llamadas totales</div>
      </div>
      <div style="background:var(--surface1);border-radius:6px;padding:8px;text-align:center">
        <div style="font-size:18px;font-weight:700">${(m.total_tokens_used||0).toLocaleString()}</div>
        <div style="font-size:11px;color:var(--text3)">Tokens usados</div>
      </div>
      <div style="background:var(--surface1);border-radius:6px;padding:8px;text-align:center">
        <div style="font-size:18px;font-weight:700">${m.active_queues}</div>
        <div style="font-size:11px;color:var(--text3)">Colas activas</div>
      </div>
      <div style="background:var(--surface1);border-radius:6px;padding:8px;text-align:center">
        <div style="font-size:18px;font-weight:700;color:${m.errors>0?'#dc2626':'#16a34a'}">${m.errors}</div>
        <div style="font-size:11px;color:var(--text3)">Errores</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text3);margin-bottom:8px">
      System prompt: ${m.prompt_cached ? `en cache (${m.prompt_cache_age_s}s), ~${m.prompt_tokens_est} tokens` : 'sin cache'}
    </div>
    ${byJidRows ? `
    <table style="width:100%;font-size:12px;border-collapse:collapse">
      <thead>
        <tr style="color:var(--text3);font-size:11px">
          <th style="text-align:left;padding:4px 0">JID</th>
          <th>Llamadas</th><th>Tokens</th><th>Último ms</th><th>Errores</th>
        </tr>
      </thead>
      <tbody>${byJidRows}</tbody>
    </table>` : '<div style="font-size:12px;color:var(--text3)">Sin actividad aún</div>'}
  `;
}

async function invalidateAICache() {
  const res = await apiFetch('/ai/invalidate-cache', { method: 'POST' });
  if (res?.ok) notify('Cache del system prompt invalidado — se reconstruirá en el próximo mensaje', 'success');
  else notify('Error: ' + (res?.error || 'desconocido'), 'error');
}

// ═══════════════════════════════════════════════════════════════
// SISTEMA / ADMINISTRACIÓN
// ═══════════════════════════════════════════════════════════════

async function loadSystemStats() {
  const el = document.getElementById('system-stats-box');
  if (!el) return;
  const s = await apiFetch('/system/stats');
  if (!s) { el.innerHTML = '<p style="color:var(--red);font-size:12px">Error cargando estadísticas</p>'; return; }
  const fmt = n => Number(n || 0).toLocaleString('es-AR');
  const fmtDate = t => t ? new Date(Number(t)).toLocaleString('es-AR') : '—';
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px">
      ${[
        ['💬', 'Conversaciones', fmt(s.conversations)],
        ['📨', 'Mensajes', fmt(s.messages)],
        ['👤', 'Contactos', fmt(s.contacts)],
        ['🧑‍💼', 'Usuarios activos', fmt(s.active_users)],
      ].map(([icon, label, val]) => `
        <div style="background:var(--surface2);border-radius:var(--radius);padding:10px;text-align:center">
          <div style="font-size:20px">${icon}</div>
          <div style="font-size:22px;font-weight:700;color:var(--text1)">${val}</div>
          <div style="font-size:11px;color:var(--text3)">${label}</div>
        </div>`).join('')}
    </div>
    <div style="font-size:11px;color:var(--text3)">
      Mensaje más antiguo: ${fmtDate(s.oldest_message)} · Más reciente: ${fmtDate(s.newest_message)}
    </div>`;
}

async function systemMergeDuplicates() {
  const pwd = document.getElementById('sys-pwd-seed')?.value;
  if (!pwd) { notify('Ingresá tu contraseña', 'error'); return; }
  const el = document.getElementById('seed-result');
  el.innerHTML = '<span style="color:var(--text3)">Buscando duplicados...</span>';
  const res = await apiFetch('/system/merge-duplicates', { method: 'POST', body: JSON.stringify({ password: pwd }) });
  if (res?.ok) {
    el.innerHTML = `<span style="color:var(--wa)">✅ ${res.message}</span>`;
    notify(`✅ ${res.message}`);
    await loadSystemStats();
    await loadConversations();
  } else {
    el.innerHTML = `<span style="color:var(--red)">${res?.error || 'Error'}</span>`;
    notify(res?.error || 'Error', 'error');
  }
}

async function systemSeedMessages() {
  const pwd = document.getElementById('sys-pwd-seed')?.value;
  if (!pwd) { notify('Ingresá tu contraseña', 'error'); return; }
  const el = document.getElementById('seed-result');
  el.innerHTML = '<span style="color:var(--text3)">Ejecutando seed...</span>';

  const res = await apiFetch('/system/seed-messages', { method: 'POST', body: JSON.stringify({ password: pwd }) });
  if (res?.ok) {
    el.innerHTML = `<span style="color:var(--wa)">✅ Seed completo: ${res.inserted} mensajes insertados (total en DB: ${res.after})</span>`;
    notify(`✅ ${res.inserted} mensajes recuperados`);
    document.getElementById('sys-pwd-seed').value = '';
    await loadSystemStats();
    // Recargar conversación abierta si hay una
    if (S.currentJid) openChat(S.currentJid);
  } else {
    el.innerHTML = `<span style="color:var(--red)">${res?.error || 'Error'}</span>`;
    notify(res?.error || 'Error', 'error');
  }
}

async function systemResyncHistory() {
  const pwd = document.getElementById('sys-pwd-seed')?.value;
  if (!pwd) { notify('Ingresá tu contraseña', 'error'); return; }
  const el = document.getElementById('seed-result');
  el.innerHTML = '<span style="color:var(--text3)">⏳ Solicitando re-sincronización a WhatsApp...</span>';

  const res = await apiFetch('/system/resync-history', { method: 'POST', body: JSON.stringify({ password: pwd }) });
  if (res?.ok) {
    el.innerHTML = `<span style="color:var(--wa)">✅ ${res.message || 'Re-sync solicitado — los mensajes aparecerán en los próximos minutos'}</span>`;
    notify('✅ Re-sync iniciado');
    document.getElementById('sys-pwd-seed').value = '';
    // Mostrar banner de sincronización para que el usuario sepa que está en proceso
    showSyncBanner();
  } else {
    el.innerHTML = `<span style="color:var(--red)">${res?.error || 'Error'}</span>`;
    notify(res?.error || 'Error', 'error');
  }
}

async function systemRepairDB() {
  const pwd = document.getElementById('sys-pwd-repair')?.value;
  if (!pwd) { notify('Ingresá tu contraseña', 'error'); return; }
  const el = document.getElementById('repair-result');
  el.textContent = 'Ejecutando...';
  const res = await apiFetch('/system/repair-db', { method: 'POST', body: JSON.stringify({ password: pwd }) });
  if (res?.ok) {
    const ok  = res.results.filter(r => r.ok).length;
    const err = res.results.filter(r => !r.ok).length;
    el.innerHTML = `<span style="color:var(--wa)">✅ ${ok} operaciones OK</span>${err ? ` <span style="color:var(--amber)">· ${err} omitidas (ya aplicadas)</span>` : ''}`;
    notify('✅ Reparación completada');
    document.getElementById('sys-pwd-repair').value = '';
    await loadSystemStats();
  } else {
    el.innerHTML = `<span style="color:var(--red)">${res?.error || 'Error'}</span>`;
    notify(res?.error || 'Error', 'error');
  }
}

async function systemReset() {
  const scope = document.getElementById('sys-reset-scope')?.value;
  const pwd   = document.getElementById('sys-pwd-reset')?.value;
  if (!pwd) { notify('Ingresá tu contraseña', 'error'); return; }

  const labels = {
    messages: 'todos los mensajes',
    conversations: 'todas las conversaciones',
    contacts: 'todos los contactos',
    activity: 'el log de actividad',
    all: 'TODOS LOS DATOS (mensajes, conversaciones, contactos y log)',
  };
  if (!confirm(`⚠️ ¿Confirmar eliminación de ${labels[scope]}?\n\nEsta acción es IRREVERSIBLE.`)) return;

  const res = await apiFetch('/system/reset', { method: 'POST', body: JSON.stringify({ password: pwd, scope }) });
  if (res?.ok) {
    const d = res.deleted;
    notify(`✅ Reset OK: ${Object.entries(d).map(([k,v]) => `${v} ${k}`).join(', ')}`);
    document.getElementById('sys-pwd-reset').value = '';
    await loadSystemStats();
  } else {
    notify(res?.error || 'Error', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

init();