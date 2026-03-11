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

socket.on('wa:status', ({ status, phone }) => updateWAStatus(status, phone));
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
  // Recargar conversaciones
  await loadConversations();
  // Si es el chat activo, agregar mensaje
  if (S.activeJid === data.jid) {
    appendMessage({ direction: 'in', content: data.content, timestamp: data.timestamp, is_auto_reply: 0 });
    apiFetch(`/conversations/${encodeURIComponent(data.jid)}/read`, { method: 'POST' });
  } else {
    // Notificación
    showDesktopNotif(data.contact_name, data.content);
    notify(`💬 ${data.contact_name}: ${data.content.substring(0, 60)}`);
  }
});

socket.on('message:sent', (data) => {
  if (S.activeJid === data.jid) {
    // Ya fue agregado en sendMsg(), no duplicar
  }
  loadConversations();
});

socket.on('users:online', (users) => renderOnlineAgents(users));

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
  const chips = S.labels.map(l =>
    `<span class="lchip" data-id="${l.id}" style="color:${l.color};background:${l.color}18" onclick="toggleInboxLabel(${l.id},this)">${esc(l.name)}</span>`
  ).join('');
  document.getElementById('label-chips').innerHTML = chips;
  document.getElementById('contacts-label-chips').innerHTML = chips.replace(/toggleInboxLabel/g, 'toggleContactsLabel');
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
    const name = c.contact_name || c.contact_phone || c.jid.split('@')[0];
    const avatar = name[0]?.toUpperCase() || '?';
    const labels = (c.labels || []).map(l =>
      `<span class="label-pill" style="background:${l.color}" title="${esc(l.name)}"></span>`
    ).join('');
    const assignedChip = c.assigned_name
      ? `<span class="assigned-chip" style="background:${c.assigned_color}">${c.assigned_name[0]}</span>`
      : '';
    return `
    <div class="chat-item ${c.jid === S.activeJid ? 'active' : ''}" onclick="openChat('${c.jid}')">
      <div class="chat-avatar">${avatar}</div>
      <div class="chat-body">
        <div class="chat-name-row">
          <span class="chat-name">${esc(name)}</span>
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
  el.classList.add('active');
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
  const name = conv?.contact_name || conv?.contact_phone || jid.split('@')[0];
  const phone = jid.split('@')[0];

  // Header
  document.getElementById('ch-avatar').textContent = name[0]?.toUpperCase() || '?';
  document.getElementById('ch-name').textContent = name;
  document.getElementById('ch-phone').textContent = `+${phone}`;
  document.getElementById('ch-company').textContent = conv?.company ? `· ${conv.company}` : '';

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

function renderMessages(msgs) {
  const el = document.getElementById('messages-area');
  if (!msgs.length) { el.innerHTML = '<div class="msg-date-sep">Sin mensajes aún</div>'; return; }

  let lastDate = '';
  el.innerHTML = msgs.map(m => {
    const d = new Date(m.timestamp);
    const dateStr = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
    const sep = dateStr !== lastDate ? `<div class="msg-date-sep">${dateStr}</div>` : '';
    lastDate = dateStr;
    const agentTag = m.sent_by && m.sent_by_name
      ? `<span class="msg-agent" style="background:${m.sent_by_color || '#6366f1'}">${m.sent_by_name[0]}</span>`
      : '';
    const autoTag = m.is_auto_reply ? '<span class="msg-auto-tag">bot</span>' : '';
    return `${sep}
    <div class="msg-wrap ${m.direction} ${m.is_auto_reply ? 'auto' : ''}">
      <div class="msg-bubble">${esc(m.content)}</div>
      <div class="msg-meta">
        <span class="msg-time">${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
        ${agentTag}${autoTag}
      </div>
    </div>`;
  }).join('');

  el.scrollTop = el.scrollHeight;
}

function appendMessage(msg) {
  const el = document.getElementById('messages-area');
  const d = new Date(msg.timestamp);
  const wrap = document.createElement('div');
  wrap.className = `msg-wrap ${msg.direction}`;

  let agentTag = '';
  if (msg.direction === 'out' && S.me) {
    agentTag = `<span class="msg-agent" style="background:${S.me.color}">${S.me.display_name[0]}</span>`;
  }

  wrap.innerHTML = `
    <div class="msg-bubble">${esc(msg.content)}</div>
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
  const name = conv?.contact_name || '';

  // Si ya tiene nombre real (no es solo el número), confirmar
  if (name && name !== phone) {
    if (!confirm(`¿Guardar "${name}" (+${phone}) como contacto?`)) return;
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
    notify('✅ Contacto actualizado');
  } else {
    await apiFetch('/contacts', { method: 'POST', body: JSON.stringify(body) });
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

  const phone = S.activeJid.split('@')[0];
  const res = await apiFetch('/send', {
    method: 'POST',
    body: JSON.stringify({ phone, message: text }),
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
  let text = q.content
    .replace(/\{\{nombre\}\}/gi, conv?.contact_name || '')
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
        <button class="btn-secondary btn-sm" onclick="editCampaign(${c.id})">✏️ Editar</button>
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
  if (!confirm(`¿Eliminar campaña "${name}"? Esta acción no se puede deshacer.`)) return;
  const res = await apiFetch(`/campaigns/${id}`, { method: 'DELETE' });
  if (res?.ok) {
    closeModal('modal-campaign');
    loadCampaigns();
    notify(`✅ Campaña eliminada`);
  } else {
    notify(res?.error || 'Error', 'error');
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



function renderCampaignsGrid() {
  const el = document.getElementById('campaigns-grid');
  if (!S.campaigns.length) {
    el.innerHTML = '<div class="list-empty" style="grid-column:span 2">No hay campañas. Creá una para empezar.</div>';
    return;
  }
  el.innerHTML = S.campaigns.map(c => {
    const pct = c.total > 0 ? Math.round((c.sent / c.total) * 100) : 0;
    const canStart = c.status === 'draft' && c.total > 0;
    const isRunning = c.status === 'running';
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
        ${isRunning ? `<button class="btn-danger btn-sm" onclick="cancelActiveCampaign()">⛔ Cancelar</button>` : ''}
        <button class="btn-secondary btn-sm" onclick="viewCampaignContacts(${c.id})">📋 Ver contactos</button>
      </div>
    </div>`;
  }).join('');
}

function openCampaignModal() {
  document.getElementById('c-name').value = '';
  document.getElementById('c-template').value = '';
  document.getElementById('c-contacts').value = '';
  document.getElementById('c-preview').style.display = 'none';
  document.getElementById('c-schedule').value = '';
  openModal('modal-campaign');
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
  if (!first) return;
  const [phone, name, extra] = first.split(',').map(s => s.trim());
  const preview = template
    .replace(/\{\{nombre\}\}/gi, name || phone)
    .replace(/\{\{empresa\}\}/gi, '')
    .replace(/\{\{extra\}\}/gi, extra || '')
    .replace(/\{\{telefono\}\}/gi, phone);
  const el = document.getElementById('c-preview');
  el.textContent = preview;
  el.style.display = 'block';
}

async function createCampaign() {
  const name = document.getElementById('c-name').value.trim();
  const template = document.getElementById('c-template').value.trim();
  const raw = document.getElementById('c-contacts').value.trim();

  if (!name || !template) { notify('Nombre y plantilla son obligatorios', 'error'); return; }

  const contacts = raw ? raw.split('\n').filter(l => l.trim()).map(line => {
    const [phone, name2, extra] = line.split(',').map(s => s.trim());
    return { phone, name: name2 || '', extra: extra || '' };
  }).filter(c => c.phone?.replace(/\D/g, '').length >= 7) : [];

  const res = await apiFetch('/campaigns', {
    method: 'POST',
    body: JSON.stringify({
      name,
      type: document.getElementById('c-type').value,
      template,
      delay_min: parseInt(document.getElementById('c-dmin').value),
      delay_max: parseInt(document.getElementById('c-dmax').value),
      scheduled_at: document.getElementById('c-schedule').value || null,
      contacts,
    }),
  });

  if (res?.id) {
    closeModal('modal-campaign');
    loadCampaigns();
    notify(`✅ Campaña "${name}" creada con ${contacts.length} contactos`);
  } else {
    notify(res?.error || 'Error creando campaña', 'error');
  }
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

async function viewCampaignContacts(id) {
  const contacts = await apiFetch(`/campaigns/${id}/contacts`) || [];
  const camp = S.campaigns.find(c => c.id === id);
  const lines = contacts.map(c => {
    const icon = c.status === 'sent' ? '✅' : c.status === 'failed' ? '❌' : '⏳';
    return `${icon} ${c.name || c.phone} (${c.status})${c.error ? ' — ' + c.error : ''}`;
  }).join('\n');
  alert(`Campaña: ${camp?.name}\n\n${lines || 'Sin contactos'}`);
}

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
  `;

  renderQRListSettings();
  renderLabelsListSettings();
  if (isAdmin) renderUsersListSettings();
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
  openModal('modal-user');
}

async function saveUser() {
  const id = document.getElementById('usr-id').value;
  const body = {
    username: document.getElementById('usr-username').value,
    display_name: document.getElementById('usr-display').value,
    password: document.getElementById('usr-password').value || undefined,
    color: document.getElementById('usr-color').value,
    role: document.getElementById('usr-role').value,
  };
  if (!id && !body.password) { notify('La contraseña es obligatoria para nuevos agentes', 'error'); return; }
  if (id) await apiFetch(`/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  else await apiFetch('/users', { method: 'POST', body: JSON.stringify(body) });
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
// START
// ═══════════════════════════════════════════════════════════════

init();