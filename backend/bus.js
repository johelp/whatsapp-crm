/**
 * bus.js — Bus de eventos interno (evita requires circulares entre baileys e integraciones)
 * Eventos: 'event' → (name, data)   p.ej. 'message.received', 'connection.update'
 */
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(20);

function emitEvent(name, data) {
  try { bus.emit('event', name, data); } catch (e) { console.error('[bus]', e.message); }
}

module.exports = { bus, emitEvent };
